import { z } from "zod";
import { log } from "../cli/output";
import { defineCommand } from "../cli/registry";
import { runCdk } from "../core/cdk";
import { childEnv } from "../core/credentials";
import { KitError } from "../core/errors";
import { deletePlan, loadPlan } from "../core/plans";
import { stageContext } from "../core/stage-context";
import { describeChangeSet, describeStack, envNameOf, outputsOf, setTerminationProtection } from "../core/stacks";
import { synthChecked } from "../core/synth";
import { StageOptions } from "./stage-plan";

const envOf = (outputs: Record<string, string>) => Object.fromEntries(Object.entries(outputs).map(([key, value]) => [envNameOf(key), value]));

export const deployCommand = defineCommand({
  name: "deploy",
  summary: "Run a plan's change set. Refuses when the code no longer builds the template the plan showed, or the plan is over 12 hours old.",
  mutates: true,
  options: z.object({
    ...StageOptions,
    plan: z.string().min(1).describe("Plan ID from aws-kit plan"),
    yes: z.boolean().default(false).describe("Deploy. Without it, only check that the plan can still run"),
  }),
  async run(options, ctx) {
    const stage = await stageContext(ctx, options.dir, options.stage);
    const { project, target, account, cfn } = stage;
    const record = await loadPlan(project, options.plan);
    if (record.stage !== target.stage) throw new KitError("plan_mismatch", `Plan ${record.id} is for stage ${record.stage}, not ${target.stage}.`);
    if (record.accountId !== account.id || record.region !== target.region) throw new KitError("plan_mismatch", `Plan ${record.id} targets ${record.accountName} in ${record.region}. The stage now points elsewhere.`, "Run aws-kit plan again.");
    const synthesized = await synthChecked(project, target);
    if (synthesized.templateHash !== record.templateHash) throw new KitError("plan_stale", `The code changed after plan ${record.id}, so it no longer builds the template that was reviewed.`, "Run aws-kit plan again and review the new diff.");
    const view = await describeChangeSet(cfn, target.stackName, record.changeSetName);
    if (!view || view.status !== "CREATE_COMPLETE" || view.executionStatus !== "AVAILABLE") {
      throw new KitError("plan_unusable", `Change set ${record.changeSetName} is ${view ? `${view.status}/${view.executionStatus}` : "gone"}.`, "The stack changed after the plan. Run aws-kit plan again.");
    }
    if (!options.yes) return { applied: false, plan: record.id, stack: target.stackName, changes: view.changes, next: ["Rerun with --yes to deploy."] };
    log(`Deploying ${target.stackName} to ${account.name} (${account.id}), ${target.region}.`);
    await runCdk(["deploy", target.stackName, "--app", synthesized.outDir, "--method", "execute-change-set", "--change-set-name", record.changeSetName, "--require-approval", "never", "--progress", "events"], { cwd: project.dir, env: await childEnv(stage.session) });
    if (record.terminationProtection) await setTerminationProtection(cfn, target.stackName, true);
    const stack = await describeStack(cfn, target.stackName);
    await deletePlan(project, record.id);
    const outputs = outputsOf(stack);
    return { applied: true, stack: target.stackName, status: stack?.StackStatus, terminationProtection: stack?.EnableTerminationProtection ?? false, outputs, env: envOf(outputs) };
  },
});

export const statusCommand = defineCommand({
  name: "status",
  summary: "Show a stage's stack status and outputs, with each output also named as an env var.",
  options: z.object(StageOptions),
  async run(options, ctx) {
    const { target, account, cfn } = await stageContext(ctx, options.dir, options.stage);
    const stack = await describeStack(cfn, target.stackName);
    const base = { stack: target.stackName, account: { name: account.name, id: account.id }, region: target.region };
    if (!stack) return { ...base, deployed: false };
    const outputs = outputsOf(stack);
    return {
      ...base,
      deployed: stack.StackStatus !== "REVIEW_IN_PROGRESS",
      status: stack.StackStatus,
      updatedAt: (stack.LastUpdatedTime ?? stack.CreationTime)?.toISOString(),
      terminationProtection: stack.EnableTerminationProtection ?? false,
      outputs,
      env: envOf(outputs),
    };
  },
});
