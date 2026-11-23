import { z } from "zod";
import { log } from "../cli/output";
import { defineCommand } from "../cli/registry";
import { runCdk } from "../core/cdk";
import { childEnv } from "../core/credentials";
import { KitError } from "../core/errors";
import { loadProject, stageTarget } from "../core/project";
import { newPlanId, savePlan } from "../core/plans";
import { assertAccountReady, stageContext } from "../core/stage-context";
import { assertStackSettled, deleteChangeSet, describeChangeSet, describeStack, type PlannedChange } from "../core/stacks";
import { synth, synthChecked } from "../core/synth";

export const StageOptions = {
  dir: z.string().default(".").describe("The project's infra folder, holding aws-kit.json"),
  stage: z.string().min(1).describe("Stage name from aws-kit.json, such as dev or prod"),
};

export const synthCommand = defineCommand({
  name: "synth",
  summary: "Build a stage's stack and run the kit's rules on it, with no AWS calls. Lists each resource with its prod deletion policy and how it would move accounts.",
  options: z.object(StageOptions),
  async run(options) {
    const project = loadProject(options.dir);
    const target = stageTarget(project.config, options.stage);
    const result = await synth(project, target);
    return { stack: target.stackName, account: target.account, region: target.region, passed: result.violations.length === 0, violations: result.violations, resources: result.resources, templateHash: result.templateHash };
  },
});

export function planWarnings(changes: PlannedChange[], prod: boolean): string[] {
  const warnings: string[] = [];
  for (const change of changes) {
    if (!change.stateful) continue;
    const fate = prod ? "The prod policy keeps it or leaves a snapshot." : "Its data is deleted.";
    if (change.action === "Remove") warnings.push(`${change.logicalId} (${change.type}) will be removed. ${fate}`);
    else if (change.replacement === "True") warnings.push(`${change.logicalId} (${change.type}) will be replaced by a new resource. ${fate}`);
    else if (change.replacement === "Conditional") warnings.push(`${change.logicalId} (${change.type}) may be replaced, depending on values known only at deploy time.`);
  }
  return warnings;
}

export const planCommand = defineCommand({
  name: "plan",
  summary: "Build a stage, run the rules, and create a CloudFormation change set without running it. Shows every add, change, and removal. Deploy runs only this plan.",
  options: z.object(StageOptions),
  async run(options, ctx) {
    const stage = await stageContext(ctx, options.dir, options.stage);
    const { project, target, account, cfn } = stage;
    const synthesized = await synthChecked(project, target);
    await assertAccountReady(stage);
    assertStackSettled(await describeStack(cfn, target.stackName));
    const id = newPlanId();
    const changeSetName = `aws-kit-${id}`;
    log(`Preparing change set ${changeSetName} for ${target.stackName} in ${account.name} (${account.id}), ${target.region}.`);
    await runCdk(["deploy", target.stackName, "--app", synthesized.outDir, "--method", "prepare-change-set", "--change-set-name", changeSetName, "--require-approval", "never", "--progress", "events"], { cwd: project.dir, env: await childEnv(stage.session) });
    const view = await describeChangeSet(cfn, target.stackName, changeSetName, synthesized.template);
    const base = { stack: target.stackName, account: { name: account.name, id: account.id }, region: target.region, prod: target.prod };
    if (!view || (view.status === "FAILED" && /didn't contain changes|No updates/i.test(view.statusReason ?? ""))) {
      await deleteChangeSet(cfn, target.stackName, changeSetName);
      return { ...base, plan: null, noChanges: true, changes: [] };
    }
    if (view.status !== "CREATE_COMPLETE") throw new KitError("change_set_failed", `The change set is ${view.status}: ${view.statusReason ?? "no reason given"}.`);
    await savePlan(project, {
      id, project: project.config.project, stage: target.stage, stackName: target.stackName, accountName: account.name, accountId: account.id,
      region: target.region, changeSetName, templateHash: synthesized.templateHash, prod: target.prod,
      terminationProtection: synthesized.terminationProtection, createdAt: new Date().toISOString(),
    });
    const count = (test: (change: PlannedChange) => boolean) => view.changes.filter(test).length;
    return {
      ...base,
      plan: id,
      summary: {
        add: count((change) => change.action === "Add"),
        modify: count((change) => change.action === "Modify"),
        remove: count((change) => change.action === "Remove"),
        replace: count((change) => change.replacement === "True"),
      },
      changes: view.changes,
      warnings: [...(target.prod ? ["This is the prod stage."] : []), ...planWarnings(view.changes, target.prod)],
      costEstimate: "Not estimated by the kit. Check AWS pricing for each added type.",
      next: [`Show this plan to the person and get a yes, then: aws-kit deploy --dir ${options.dir} --stage ${target.stage} --plan ${id} --yes`],
    };
  },
});
