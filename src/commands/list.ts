import { CloudFormationClient, paginateDescribeStacks } from "@aws-sdk/client-cloudformation";
import { CostExplorerClient, GetCostAndUsageCommand, type GroupDefinition } from "@aws-sdk/client-cost-explorer";
import { paginateGetResources, ResourceGroupsTaggingAPIClient } from "@aws-sdk/client-resource-groups-tagging-api";
import { z } from "zod";
import { log } from "../cli/output";
import { defineCommand } from "../cli/registry";
import type { OrgAccount } from "../core/accounts";
import { regionsOf } from "../core/config";
import type { Session } from "../core/credentials";
import { orgView, sessionFor } from "../core/sessions";
import { listStackResources } from "../core/stacks";

interface StackRow {
  project: string;
  stage: string;
  account: string;
  accountId: string;
  region: string;
  stack: string;
  status: string;
  resourceTypes: Record<string, number>;
  costUsd?: number;
}

async function scanRegion(session: Session, account: OrgAccount, region: string) {
  const cfn = new CloudFormationClient({ region, credentials: session.credentials });
  const stacks: StackRow[] = [];
  for await (const page of paginateDescribeStacks({ client: cfn }, {})) {
    for (const stack of page.Stacks ?? []) {
      const tags = Object.fromEntries((stack.Tags ?? []).map((tag) => [tag.Key, tag.Value]));
      if (tags["managed-by"] !== "aws-kit" || !tags.project || !stack.StackName) continue;
      const resourceTypes: Record<string, number> = {};
      for (const resource of await listStackResources(cfn, stack.StackName)) resourceTypes[resource.ResourceType ?? ""] = (resourceTypes[resource.ResourceType ?? ""] ?? 0) + 1;
      stacks.push({ project: tags.project, stage: tags.stage ?? "", account: account.name, accountId: account.id, region, stack: stack.StackName, status: stack.StackStatus ?? "", resourceTypes });
    }
  }
  const tagging = new ResourceGroupsTaggingAPIClient({ region, credentials: session.credentials });
  const untracked: { account: string; region: string; arn: string; project: string; stage?: string }[] = [];
  for await (const page of paginateGetResources({ client: tagging }, { TagFilters: [{ Key: "project" }] })) {
    for (const item of page.ResourceTagMappingList ?? []) {
      const tags = Object.fromEntries((item.Tags ?? []).map((tag) => [tag.Key, tag.Value]));
      if (tags["aws:cloudformation:stack-name"]) continue;
      untracked.push({ account: account.name, region, arn: item.ResourceARN ?? "", project: tags.project ?? "", ...(tags.stage ? { stage: tags.stage } : {}) });
    }
  }
  return { stacks, untracked };
}

function monthToDate(now = new Date()): { Start: string; End: string } {
  const day = (date: Date) => date.toISOString().slice(0, 10);
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return { Start: day(start), End: day(end) };
}

async function costs(operator: Session) {
  const ce = new CostExplorerClient({ region: "us-east-1", credentials: operator.credentials });
  const query = async (GroupBy: GroupDefinition[]) => {
    const result = await ce.send(new GetCostAndUsageCommand({ TimePeriod: monthToDate(), Granularity: "MONTHLY", Metrics: ["UnblendedCost"], GroupBy }));
    return (result.ResultsByTime?.[0]?.Groups ?? []).map((group) => ({ keys: group.Keys ?? [], usd: Number(group.Metrics?.UnblendedCost?.Amount ?? 0) }));
  };
  const byAccount = await query([{ Type: "DIMENSION", Key: "LINKED_ACCOUNT" }]);
  const byTag = await query([{ Type: "TAG", Key: "project" }, { Type: "TAG", Key: "stage" }]);
  const value = (key: string) => key.slice(key.indexOf("$") + 1);
  return {
    byAccount: Object.fromEntries(byAccount.map((group) => [group.keys[0] ?? "", round(group.usd)])),
    byProjectStage: byTag.map((group) => ({ project: value(group.keys[0] ?? ""), stage: value(group.keys[1] ?? ""), usd: round(group.usd) })),
  };
}

const round = (usd: number) => Math.round(usd * 100) / 100;

export const listCommand = defineCommand({
  name: "list",
  summary: "List every project stack in every account and region, plus resources tagged with a project that sit in no stack. --cost adds month-to-date cost.",
  options: z.object({ cost: z.boolean().default(false).describe("Add month-to-date cost from Cost Explorer. Each run costs about $0.02") }),
  async run(options, ctx) {
    const view = await orgView(ctx);
    const regions = regionsOf(ctx.config);
    const stacks: StackRow[] = [];
    const untracked: Awaited<ReturnType<typeof scanRegion>>["untracked"] = [];
    const errors: { account: string; region?: string; message: string }[] = [];
    await Promise.all(
      view.accounts.filter((account) => account.status === "ACTIVE").map(async (account) => {
        for (const region of regions) {
          try {
            const { session } = await sessionFor(view, account.id, region, ctx.config);
            const found = await scanRegion(session, account, region);
            stacks.push(...found.stacks);
            untracked.push(...found.untracked);
          } catch (error) {
            log(`${account.name} ${region}: ${(error as Error).message}`);
            errors.push({ account: account.name, region, message: (error as Error).message });
          }
        }
      }),
    );
    stacks.sort((a, b) => a.project.localeCompare(b.project) || a.stage.localeCompare(b.stage));
    let cost: Awaited<ReturnType<typeof costs>> | undefined;
    if (options.cost) {
      try {
        cost = await costs(view.operator);
        for (const row of stacks) row.costUsd = cost.byProjectStage.find((group) => group.project === row.project && group.stage === row.stage)?.usd ?? 0;
      } catch (error) {
        errors.push({ account: "management", message: `Cost Explorer: ${(error as Error).message}` });
      }
    }
    return { stacks, untracked, ...(cost ? { cost } : {}), errors };
  },
});
