/**
 * Rules every synthesized stack must pass before anything deploys (R4, R9).
 * They read the CloudFormation template, so they catch escape hatches and raw
 * Cfn resources as well as constructs.
 */
export interface CfnResource {
  Type: string;
  Properties?: Record<string, unknown>;
  DeletionPolicy?: string;
}

export interface CfnTemplate {
  Resources?: Record<string, CfnResource>;
  Outputs?: Record<string, unknown>;
  [section: string]: unknown;
}

export interface Violation {
  rule: "account-id" | "fixed-global-name" | "cross-stack-reference" | "missing-tags" | "queue-without-dlq";
  path: string;
  message: string;
}

export const REQUIRED_TAGS = ["project", "stage", "managed-by"];
const ACCOUNT_ID = /(?<![A-Za-z0-9.])\d{12}(?![A-Za-z0-9.])/;
/** Types whose name is unique across all of AWS, so a fixed name blocks deploying the same code to a second account. */
const GLOBAL_NAMES: Record<string, string> = { "AWS::S3::Bucket": "BucketName", "AWS::S3Express::DirectoryBucket": "BucketName" };

function walk(value: unknown, path: string, visit: (value: unknown, path: string) => void): void {
  visit(value, path);
  if (Array.isArray(value)) value.forEach((item, index) => walk(item, `${path}[${index}]`, visit));
  else if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) walk(child, path ? `${path}.${key}` : key, visit);
}

export function checkTemplate(template: CfnTemplate, stackTags: Record<string, string> = {}): Violation[] {
  const violations: Violation[] = [];
  const missing = REQUIRED_TAGS.filter((tag) => !stackTags[tag]);
  if (missing.length) violations.push({ rule: "missing-tags", path: "stack", message: `The stack has no ${missing.join(", ")} tag. Build it with projectApp() from aws-kit/cdk.` });
  for (const [logicalId, resource] of Object.entries(template.Resources ?? {})) {
    const nameProperty = GLOBAL_NAMES[resource.Type];
    const name = nameProperty ? resource.Properties?.[nameProperty] : undefined;
    if (typeof name === "string") {
      violations.push({ rule: "fixed-global-name", path: `Resources.${logicalId}.Properties.${nameProperty}`, message: `${logicalId} sets ${nameProperty} to "${name}". Leave it out so CloudFormation names it, or the same code cannot deploy to another account.` });
    }
  }
  violations.push(...checkQueues(template));
  walk(template, "", (value, path) => {
    if (typeof value === "string" && ACCOUNT_ID.test(value) && !path.startsWith("Metadata")) {
      violations.push({ rule: "account-id", path, message: `A literal account ID at ${path}. Use Stack.of(this).account, which CloudFormation fills in.` });
    }
    if (value && typeof value === "object" && !Array.isArray(value) && "Fn::ImportValue" in value) {
      violations.push({ rule: "cross-stack-reference", path, message: `Fn::ImportValue at ${path} ties this stack to another stack. Pass the value in through config instead.` });
    }
  });
  return violations;
}

/** Every queue either has a dead-letter queue or is one (R15). */
function checkQueues(template: CfnTemplate): Violation[] {
  const queues = Object.entries(template.Resources ?? {}).filter(([, resource]) => resource.Type === "AWS::SQS::Queue");
  const targets = new Set<string>();
  for (const [, queue] of queues) {
    const target = (queue.Properties?.RedrivePolicy as { deadLetterTargetArn?: unknown } | undefined)?.deadLetterTargetArn;
    const getAtt = (target as { "Fn::GetAtt"?: unknown[] } | undefined)?.["Fn::GetAtt"];
    if (Array.isArray(getAtt) && typeof getAtt[0] === "string") targets.add(getAtt[0]);
  }
  return queues
    .filter(([logicalId, queue]) => !queue.Properties?.RedrivePolicy && !queue.Properties?.RedriveAllowPolicy && !targets.has(logicalId))
    .map(([logicalId]) => ({
      rule: "queue-without-dlq" as const,
      path: `Resources.${logicalId}`,
      message: `${logicalId} has no dead-letter queue, so a message that keeps failing is retried until it expires and then lost. Give it deadLetterQueue: { queue, maxReceiveCount }.`,
    }));
}
