import {
  type CloudFormationClient,
  DeleteChangeSetCommand,
  DeleteStackCommand,
  DescribeChangeSetCommand,
  type DescribeChangeSetCommandOutput,
  DescribeStackEventsCommand,
  DescribeStacksCommand,
  GetTemplateCommand,
  paginateListStackResources,
  type Stack,
  type StackResourceSummary,
  UpdateTerminationProtectionCommand,
} from "@aws-sdk/client-cloudformation";
import { isAwsError, KitError } from "./errors";
import type { CfnTemplate } from "./checks";
import { classify, moveLabelOf, type MoveLabel } from "./resource-classes";

export async function describeStack(cfn: CloudFormationClient, stackName: string): Promise<Stack | null> {
  try {
    const found = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
    return found.Stacks?.[0] ?? null;
  } catch (error) {
    if (isAwsError(error, "ValidationError") && /does not exist/.test((error as Error).message)) return null;
    throw error;
  }
}

/** Refuses to plan or deploy over a stack that is mid-change or stuck. */
export function assertStackSettled(stack: Stack | null): void {
  const status = stack?.StackStatus ?? "";
  if (/_IN_PROGRESS$/.test(status) && status !== "REVIEW_IN_PROGRESS") throw new KitError("stack_busy", `${stack?.StackName} is ${status}.`, "Wait for it to finish, then run the command again.");
  if (status === "ROLLBACK_COMPLETE" || status === "ROLLBACK_FAILED" || status === "DELETE_FAILED") {
    throw new KitError("stack_stuck", `${stack?.StackName} is ${status} and cannot be updated.`, "Destroy the stage with aws-kit destroy, then plan again.");
  }
}

export interface PlannedChange {
  action: string;
  logicalId: string;
  type: string;
  replacement?: string;
  physicalId?: string;
  stateful: boolean;
  move?: MoveLabel;
}

export interface ChangeSetView {
  status: string;
  executionStatus: string;
  statusReason?: string;
  changes: PlannedChange[];
}

/** Reads a change set, all pages. Null when it does not exist, which is how CDK leaves a change set with no changes. */
export async function describeChangeSet(cfn: CloudFormationClient, stackName: string, changeSetName: string, template?: CfnTemplate): Promise<ChangeSetView | null> {
  const changes: PlannedChange[] = [];
  let next: string | undefined;
  let first: DescribeChangeSetCommandOutput | undefined;
  do {
    let page: DescribeChangeSetCommandOutput;
    try {
      page = await cfn.send(new DescribeChangeSetCommand({ StackName: stackName, ChangeSetName: changeSetName, NextToken: next }));
    } catch (error) {
      if (isAwsError(error, "ChangeSetNotFoundException", "ChangeSetNotFound", "ValidationError")) return null;
      throw error;
    }
    first ??= page;
    for (const change of page.Changes ?? []) {
      const resource = change.ResourceChange;
      if (!resource?.LogicalResourceId || !resource.ResourceType) continue;
      const kind = classify(resource.ResourceType).kind;
      changes.push({
        action: resource.Action ?? "Unknown",
        logicalId: resource.LogicalResourceId,
        type: resource.ResourceType,
        ...(resource.Replacement ? { replacement: resource.Replacement } : {}),
        ...(resource.PhysicalResourceId ? { physicalId: resource.PhysicalResourceId } : {}),
        stateful: kind !== "stateless",
        ...(resource.Action === "Add" ? { move: moveLabelOf(resource.ResourceType, template?.Resources?.[resource.LogicalResourceId]?.Properties) } : {}),
      });
    }
    next = page.NextToken;
  } while (next);
  return { status: first?.Status ?? "", executionStatus: first?.ExecutionStatus ?? "", ...(first?.StatusReason ? { statusReason: first.StatusReason } : {}), changes };
}

export async function deleteChangeSet(cfn: CloudFormationClient, stackName: string, changeSetName: string): Promise<void> {
  await cfn.send(new DeleteChangeSetCommand({ StackName: stackName, ChangeSetName: changeSetName })).catch(() => undefined);
}

export async function listStackResources(cfn: CloudFormationClient, stackName: string): Promise<StackResourceSummary[]> {
  const resources: StackResourceSummary[] = [];
  for await (const page of paginateListStackResources({ client: cfn }, { StackName: stackName })) resources.push(...(page.StackResourceSummaries ?? []));
  return resources;
}

export async function deployedTemplate(cfn: CloudFormationClient, stackName: string): Promise<CfnTemplate> {
  const found = await cfn.send(new GetTemplateCommand({ StackName: stackName, TemplateStage: "Original" }));
  return JSON.parse(found.TemplateBody ?? "{}") as CfnTemplate;
}

export async function setTerminationProtection(cfn: CloudFormationClient, stackName: string, enabled: boolean): Promise<void> {
  await cfn.send(new UpdateTerminationProtectionCommand({ StackName: stackName, EnableTerminationProtection: enabled }));
}

export function outputsOf(stack: Stack | null): Record<string, string> {
  return Object.fromEntries((stack?.Outputs ?? []).filter((output) => output.OutputKey).map((output) => [output.OutputKey ?? "", output.OutputValue ?? ""]));
}

/** `CatalogBucketName` becomes `CATALOG_BUCKET_NAME`, a starting point for an env var name. */
export function envNameOf(outputKey: string): string {
  return outputKey.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/([A-Z])([A-Z][a-z])/g, "$1_$2").toUpperCase();
}

/** Deletes a stack and waits, logging each resource event. Returns the final status. */
export async function deleteStackAndWait(cfn: CloudFormationClient, stack: Stack, log: (line: string) => void, timeoutMs = 60 * 60 * 1000): Promise<string> {
  const stackId = stack.StackId ?? stack.StackName ?? "";
  const started = new Date();
  await cfn.send(new DeleteStackCommand({ StackName: stackId }));
  const seen = new Set<string>();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await Bun.sleep(5000);
    const events = await cfn.send(new DescribeStackEventsCommand({ StackName: stackId })).catch(() => null);
    for (const event of [...(events?.StackEvents ?? [])].reverse()) {
      if (!event.EventId || seen.has(event.EventId) || (event.Timestamp && event.Timestamp < started)) continue;
      seen.add(event.EventId);
      log(`  ${event.LogicalResourceId} ${event.ResourceStatus}${event.ResourceStatusReason ? `: ${event.ResourceStatusReason}` : ""}`);
    }
    const current = (await cfn.send(new DescribeStacksCommand({ StackName: stackId }))).Stacks?.[0]?.StackStatus ?? "";
    if (current === "DELETE_COMPLETE" || current === "DELETE_FAILED") return current;
  }
  throw new KitError("destroy_timeout", `${stack.StackName} was still deleting after an hour.`);
}
