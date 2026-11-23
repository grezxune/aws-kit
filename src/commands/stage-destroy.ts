import { GetResourcesCommand, ResourceGroupsTaggingAPIClient } from "@aws-sdk/client-resource-groups-tagging-api";
import { z } from "zod";
import { log } from "../cli/output";
import { defineCommand } from "../cli/registry";
import { emptyBucket } from "../core/buckets";
import { KitError } from "../core/errors";
import { stageContext } from "../core/stage-context";
import { deleteStackAndWait, deployedTemplate, describeStack, listStackResources, setTerminationProtection } from "../core/stacks";
import { StageOptions } from "./stage-plan";

export const destroyCommand = defineCommand({
  name: "destroy",
  summary: "Delete a stage's stack. Without --yes, lists what would be deleted, kept, and snapshotted. Prod also needs --confirm with the project name.",
  mutates: true,
  options: z.object({
    ...StageOptions,
    yes: z.boolean().default(false).describe("Delete. Without it, only report what would happen"),
    confirm: z.string().optional().describe("The project name, typed back. Required for the prod stage"),
  }),
  async run(options, ctx) {
    const stage = await stageContext(ctx, options.dir, options.stage);
    const { project, target, account, cfn, session } = stage;
    const name = project.config.project;
    const stack = await describeStack(cfn, target.stackName);
    if (!stack) return { applied: false, changed: false, stack: target.stackName, detail: "Nothing is deployed for this stage." };
    const template = await deployedTemplate(cfn, target.stackName);
    const resources = (await listStackResources(cfn, target.stackName)).map((resource) => ({
      logicalId: resource.LogicalResourceId ?? "",
      type: resource.ResourceType ?? "",
      physicalId: resource.PhysicalResourceId ?? "",
      policy: template.Resources?.[resource.LogicalResourceId ?? ""]?.DeletionPolicy ?? "Delete",
    }));
    const deleted = resources.filter((resource) => resource.policy === "Delete");
    const kept = resources.filter((resource) => resource.policy.startsWith("Retain"));
    const snapshotted = resources.filter((resource) => resource.policy === "Snapshot");
    const buckets = deleted.filter((resource) => resource.type === "AWS::S3::Bucket" && resource.physicalId).map((resource) => resource.physicalId);
    const report = { stack: target.stackName, account: { name: account.name, id: account.id }, region: target.region, prod: target.prod, deleted, kept, snapshotted, bucketsToEmpty: buckets };
    if (!options.yes) return { applied: false, ...report, next: [`Show this to the person and get a yes, then rerun with --yes${target.prod ? ` --confirm ${name}` : ""}.`] };
    if (target.prod && options.confirm !== name) throw new KitError("confirm_required", "Destroying prod needs the project name typed back.", `Rerun with --confirm ${name}, after the person types it.`);

    for (const bucket of buckets) log(`Emptied ${bucket}: ${await emptyBucket(session, bucket)} objects.`);
    if (stack.EnableTerminationProtection) await setTerminationProtection(cfn, target.stackName, false);
    log(`Deleting ${target.stackName}.`);
    const status = await deleteStackAndWait(cfn, stack, log);
    if (status !== "DELETE_COMPLETE") throw new KitError("destroy_failed", `${target.stackName} is ${status}.`, "The events above, on stderr, name the resource that failed. Fix it, then destroy again.");

    const tagging = new ResourceGroupsTaggingAPIClient({ region: target.region, credentials: session.credentials });
    const tagged = await tagging.send(new GetResourcesCommand({ TagFilters: [{ Key: "project", Values: [name] }, { Key: "stage", Values: [target.stage] }] }));
    const keptIds = new Set([...kept, ...snapshotted].map((resource) => resource.physicalId));
    const remaining = (tagged.ResourceTagMappingList ?? []).map((item) => item.ResourceARN ?? "").filter(Boolean);
    return {
      applied: true,
      changed: true,
      ...report,
      leftovers: remaining.filter((arn) => ![...keptIds].some((id) => id && arn.includes(id))),
      keptByPolicy: remaining.filter((arn) => [...keptIds].some((id) => id && arn.includes(id))),
      notes: ["The tagging API can lag a few minutes behind a delete. Run aws-kit list later to confirm nothing is left."],
    };
  },
});
