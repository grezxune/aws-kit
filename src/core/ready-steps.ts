import { tmpdir } from "node:os";
import { BudgetsClient, CreateBudgetCommand, DescribeBudgetCommand, UpdateBudgetCommand } from "@aws-sdk/client-budgets";
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { CostExplorerClient, ListCostAllocationTagsCommand, UpdateCostAllocationTagsStatusCommand } from "@aws-sdk/client-cost-explorer";
import { CreateOpenIDConnectProviderCommand, IAMClient, ListOpenIDConnectProvidersCommand } from "@aws-sdk/client-iam";
import { GetPublicAccessBlockCommand, PutPublicAccessBlockCommand, S3ControlClient } from "@aws-sdk/client-s3-control";
import { publicBuckets } from "./public-buckets";
import { CreateTopicCommand, GetTopicAttributesCommand, ListSubscriptionsByTopicCommand, SNSClient, SubscribeCommand } from "@aws-sdk/client-sns";
import { runCdk } from "./cdk";
import type { Config } from "./config";
import { childEnv, type Session } from "./credentials";
import { isAwsError } from "./errors";
import type { Step } from "./steps";

import { ALERTS_TOPIC, BUDGET_NAME } from "./ready-steps-names";

export { ALERTS_TOPIC, BUDGET_NAME };
export const COST_TAGS = ["project", "stage"];
const ADMIN_POLICY = "arn:aws:iam::aws:policy/AdministratorAccess";
const KIT_TAGS = [{ Key: "managed-by", Value: "aws-kit" }];

export interface ReadyInput {
  /** A session in the account being made ready, in its default region. */
  session: Session;
  /** The kit's session in the management account, for org-wide billing settings. */
  management: Session;
  config: Config;
  regions: string[];
  vercelTeam?: string;
}

const inRegion = (session: Session, region: string): Session => ({ ...session, region });
const notFound = (error: unknown, ...names: string[]) => (isAwsError(error, ...names) ? null : Promise.reject(error));

export function cdkBootstrapStep(session: Session, region: string): Step {
  const cfn = new CloudFormationClient({ region, credentials: session.credentials });
  return {
    id: `cdk-bootstrap:${region}`,
    async check() {
      const found = await cfn.send(new DescribeStacksCommand({ StackName: "CDKToolkit" })).catch((error: unknown) => notFound(error, "ValidationError"));
      const stack = found?.Stacks?.[0];
      if (!stack) return { needed: true, detail: `Bootstrap CDK in ${region}.` };
      if (!/_COMPLETE$/.test(stack.StackStatus ?? "") || /ROLLBACK_COMPLETE|DELETE/.test(stack.StackStatus ?? "")) return { needed: true, detail: `CDKToolkit is ${stack.StackStatus}. Bootstrap again.` };
      const version = stack.Outputs?.find((output) => output.OutputKey === "BootstrapVersion")?.OutputValue;
      return { needed: false, detail: `CDKToolkit version ${version ?? "unknown"}` };
    },
    async apply() {
      const target = inRegion(session, region);
      await runCdk(["bootstrap", `aws://${session.accountId}/${region}`, "--cloudformation-execution-policies", ADMIN_POLICY, "--tags", "managed-by=aws-kit"], { cwd: tmpdir(), env: await childEnv(target) });
      return `Bootstrapped CDK in ${region}`;
    },
  };
}

function blockPublicAccessStep(session: Session): Step {
  const s3control = new S3ControlClient({ region: session.region, credentials: session.credentials });
  return {
    id: "s3-block-public-access",
    async check() {
      const found = await s3control.send(new GetPublicAccessBlockCommand({ AccountId: session.accountId })).catch((error: unknown) => notFound(error, "NoSuchPublicAccessBlockConfiguration"));
      const config = found?.PublicAccessBlockConfiguration;
      const on = config?.BlockPublicAcls && config.IgnorePublicAcls && config.BlockPublicPolicy && config.RestrictPublicBuckets;
      if (on) return { needed: false, detail: "All four settings on" };
      const open = await publicBuckets(session);
      if (open.length) {
        return { needed: true, manual: true, detail: `${open.length} bucket${open.length === 1 ? " is" : "s are"} public today (${open.join(", ")}). Account-wide Block Public Access would cut ${open.length === 1 ? "it" : "them"} off. Move ${open.length === 1 ? "it" : "them"} behind CloudFront, then run ready again.` };
      }
      return { needed: true, detail: "Turn on S3 Block Public Access for the whole account. No bucket is public today." };
    },
    async apply() {
      await s3control.send(new PutPublicAccessBlockCommand({ AccountId: session.accountId, PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true } }));
      return "Turned on account-wide S3 Block Public Access";
    },
  };
}

function budgetStep(session: Session, config: Config): Step {
  const budgets = new BudgetsClient({ region: "us-east-1", credentials: session.credentials });
  const limit = { Amount: String(config.budgetUsd), Unit: "USD" };
  let exists = false;
  return {
    id: "budget",
    async check() {
      if (!config.alertEmail) return { needed: true, manual: true, detail: "Set an alert address first: aws-kit config set alertEmail you@example.com" };
      const found = await budgets.send(new DescribeBudgetCommand({ AccountId: session.accountId, BudgetName: BUDGET_NAME })).catch((error: unknown) => notFound(error, "NotFoundException"));
      exists = Boolean(found?.Budget);
      if (!exists) return { needed: true, detail: `Create a $${config.budgetUsd} monthly budget emailing ${config.alertEmail} at 50, 80, and 100 percent.` };
      const amount = Number(found?.Budget?.BudgetLimit?.Amount);
      return amount === config.budgetUsd ? { needed: false, detail: `$${amount} a month` } : { needed: true, detail: `Change the budget from $${amount} to $${config.budgetUsd}.` };
    },
    async apply() {
      const budget = { BudgetName: BUDGET_NAME, BudgetType: "COST" as const, TimeUnit: "MONTHLY" as const, BudgetLimit: limit };
      if (exists) {
        await budgets.send(new UpdateBudgetCommand({ AccountId: session.accountId, NewBudget: budget }));
        return `Set the budget to $${config.budgetUsd}`;
      }
      const subscribers = [{ SubscriptionType: "EMAIL" as const, Address: config.alertEmail ?? "" }];
      const notice = (threshold: number, type: "ACTUAL" | "FORECASTED") => ({
        Notification: { NotificationType: type, ComparisonOperator: "GREATER_THAN" as const, Threshold: threshold, ThresholdType: "PERCENTAGE" as const },
        Subscribers: subscribers,
      });
      await budgets.send(new CreateBudgetCommand({ AccountId: session.accountId, Budget: budget, NotificationsWithSubscribers: [notice(50, "ACTUAL"), notice(80, "ACTUAL"), notice(100, "ACTUAL"), notice(100, "FORECASTED")] }));
      return `Created a $${config.budgetUsd} monthly budget`;
    },
  };
}

function alertsSteps(session: Session, region: string, config: Config): Step[] {
  const sns = new SNSClient({ region, credentials: session.credentials });
  const topicArn = `arn:aws:sns:${region}:${session.accountId}:${ALERTS_TOPIC}`;
  const topicExists = () =>
    sns.send(new GetTopicAttributesCommand({ TopicArn: topicArn })).then(
      () => true,
      (error: unknown) => (isAwsError(error, "NotFoundException", "NotFound") ? false : Promise.reject(error)),
    );
  return [
    {
      id: `alerts-topic:${region}`,
      async check() {
        return (await topicExists()) ? { needed: false, detail: topicArn } : { needed: true, detail: `Create SNS topic ${ALERTS_TOPIC}, where stack alarms send.` };
      },
      async apply() {
        await sns.send(new CreateTopicCommand({ Name: ALERTS_TOPIC, Tags: KIT_TAGS }));
        return `Created ${topicArn}`;
      },
    },
    {
      id: `alerts-email:${region}`,
      async check() {
        if (!config.alertEmail) return { needed: true, manual: true, detail: "Set an alert address first: aws-kit config set alertEmail you@example.com" };
        if (!(await topicExists())) return { needed: true, detail: `Subscribe ${config.alertEmail} to the alerts topic.` };
        const subscriptions = await sns.send(new ListSubscriptionsByTopicCommand({ TopicArn: topicArn }));
        const mine = subscriptions.Subscriptions?.find((subscription) => subscription.Protocol === "email" && subscription.Endpoint === config.alertEmail);
        if (!mine) return { needed: true, detail: `Subscribe ${config.alertEmail} to the alerts topic.` };
        if (mine.SubscriptionArn === "PendingConfirmation") return { needed: true, manual: true, detail: `Click the confirmation link AWS emailed to ${config.alertEmail}.` };
        return { needed: false, detail: `${config.alertEmail} confirmed` };
      },
      async apply() {
        await sns.send(new SubscribeCommand({ TopicArn: topicArn, Protocol: "email", Endpoint: config.alertEmail }));
        return `AWS emailed a confirmation link to ${config.alertEmail}. Alarms reach it once the link is clicked.`;
      },
    },
  ];
}

export function vercelOidcStep(session: Session, team: string): Step {
  const iam = new IAMClient({ region: session.region, credentials: session.credentials });
  const host = `oidc.vercel.com/${team}`;
  return {
    id: "vercel-oidc",
    async check() {
      const providers = await iam.send(new ListOpenIDConnectProvidersCommand({}));
      const found = providers.OpenIDConnectProviderList?.some((provider) => provider.Arn?.endsWith(`:oidc-provider/${host}`));
      return found ? { needed: false, detail: `${host} registered` } : { needed: true, detail: `Register Vercel team ${team} as an OIDC identity provider, so its deployments get AWS roles without keys.` };
    },
    async apply() {
      const created = await iam.send(new CreateOpenIDConnectProviderCommand({ Url: `https://${host}`, ClientIDList: [`https://vercel.com/${team}`], Tags: KIT_TAGS }));
      return `Created ${created.OpenIDConnectProviderArn}`;
    },
  };
}

function costTagsStep(management: Session): Step {
  const ce = new CostExplorerClient({ region: "us-east-1", credentials: management.credentials });
  let inactive: string[] = [];
  return {
    id: "cost-allocation-tags",
    async check() {
      const listed = await ce.send(new ListCostAllocationTagsCommand({ TagKeys: COST_TAGS, Type: "UserDefined" })).catch((error: unknown) => {
        if (isAwsError(error, "AccessDeniedException")) return null;
        throw error;
      });
      if (!listed) return { needed: true, manual: true, detail: "The kit's session cannot read billing. As root, turn on IAM user and role access to Billing information in the console, under Account." };
      const tags = listed.CostAllocationTags ?? [];
      const missing = COST_TAGS.filter((key) => !tags.some((tag) => tag.TagKey === key));
      inactive = tags.filter((tag) => tag.Status !== "Active").map((tag) => tag.TagKey ?? "");
      if (inactive.length) return { needed: true, detail: `Activate cost allocation tags: ${inactive.join(", ")}.` };
      if (missing.length) return { needed: true, manual: true, detail: `AWS lists a tag key only after billing data has a resource tagged with it, up to a day after the first deploy. Run account ready again then to activate: ${missing.join(", ")}.` };
      return { needed: false, detail: "project and stage are active" };
    },
    async apply() {
      await ce.send(new UpdateCostAllocationTagsStatusCommand({ CostAllocationTagsStatus: inactive.map((TagKey) => ({ TagKey, Status: "Active" as const })) }));
      return `Activated ${inactive.join(", ")}`;
    },
  };
}

export function readySteps(input: ReadyInput): Step[] {
  const { session, management, config, regions, vercelTeam } = input;
  return [
    ...regions.map((region) => cdkBootstrapStep(session, region)),
    blockPublicAccessStep(session),
    budgetStep(session, config),
    ...regions.flatMap((region) => alertsSteps(session, region, config)),
    ...(vercelTeam ? [vercelOidcStep(session, vercelTeam)] : []),
    costTagsStep(management),
  ];
}
