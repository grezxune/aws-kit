import { CfnResource, type IAspect, Names, RemovalPolicy, Stack } from "aws-cdk-lib";
import { CfnAlarm } from "aws-cdk-lib/aws-cloudwatch";
import { CfnFunction } from "aws-cdk-lib/aws-lambda";
import { CfnLogGroup } from "aws-cdk-lib/aws-logs";
import { CfnQueue } from "aws-cdk-lib/aws-sqs";
import { Construct, type IConstruct } from "constructs";
import { classify } from "../core/resource-classes";
import type { ProjectStack } from "./project-stack";

/**
 * The rules every resource in a project stack gets, whatever its type.
 * Visiting the stack first adds the alarms and log groups, so the per-resource
 * rules below then reach those too.
 */
export class KitAspect implements IAspect {
  constructor(private readonly stack: ProjectStack) {}

  visit(node: IConstruct): void {
    if (node === this.stack) {
      addObservability(this.stack);
      return;
    }
    if (!(node instanceof CfnResource)) return;
    applyRemovalPolicy(node, this.stack.prod);
    if (node instanceof CfnLogGroup && node.retentionInDays === undefined) node.retentionInDays = this.stack.logRetentionDays;
  }
}

/** R8: outside prod everything is deleted with the stack. In prod, anything that may hold data is kept or snapshotted. */
export function applyRemovalPolicy(resource: CfnResource, prod: boolean): void {
  if (!prod) {
    resource.applyRemovalPolicy(RemovalPolicy.DESTROY);
    return;
  }
  const kind = classify(resource.cfnResourceType);
  if (kind.kind === "stateless") return;
  resource.applyRemovalPolicy(kind.snapshot ? RemovalPolicy.SNAPSHOT : RemovalPolicy.RETAIN);
}

/** R15: log retention for every function, alarms on function errors and throttles, and an alarm on every dead-letter queue. */
function addObservability(stack: ProjectStack): void {
  const all = stack.node.findAll();
  const functions = all.filter((node): node is CfnFunction => node instanceof CfnFunction);
  const queues = all.filter((node): node is CfnQueue => node instanceof CfnQueue);
  if (!functions.length && !queues.length) return;
  const alarms = (stack.node.tryFindChild("KitAlarms") as Construct | undefined) ?? new Construct(stack, "KitAlarms");
  const label = `${stack.project} ${stack.stage}`;

  for (const fn of functions) {
    const name = Names.uniqueId(fn);
    giveLogGroup(fn, stack.logRetentionDays);
    const metric = (id: string, metricName: string) =>
      new CfnAlarm(alarms, `${name}${id}`, {
        alarmDescription: `${label}: ${fn.node.path} ${metricName.toLowerCase()}`,
        namespace: "AWS/Lambda",
        metricName,
        dimensions: [{ name: "FunctionName", value: fn.ref }],
        statistic: "Sum",
        period: 300,
        evaluationPeriods: 1,
        threshold: 1,
        comparisonOperator: "GreaterThanOrEqualToThreshold",
        treatMissingData: "notBreaching",
        alarmActions: [stack.alertsTopicArn],
      });
    metric("Errors", "Errors");
    metric("Throttles", "Throttles");
  }

  const deadLetterTargets = new Set<string>();
  for (const queue of queues) {
    const policy = stack.resolve(queue.redrivePolicy) as { deadLetterTargetArn?: { "Fn::GetAtt"?: string[] } } | undefined;
    const target = policy?.deadLetterTargetArn?.["Fn::GetAtt"]?.[0];
    if (target) deadLetterTargets.add(target);
  }
  for (const queue of queues) {
    if (!deadLetterTargets.has(stack.resolve(queue.logicalId) as string)) continue;
    new CfnAlarm(alarms, `${Names.uniqueId(queue)}Messages`, {
      alarmDescription: `${label}: a message landed in dead-letter queue ${queue.node.path}`,
      namespace: "AWS/SQS",
      metricName: "ApproximateNumberOfMessagesVisible",
      dimensions: [{ name: "QueueName", value: queue.attrQueueName }],
      statistic: "Maximum",
      period: 300,
      evaluationPeriods: 1,
      threshold: 0,
      comparisonOperator: "GreaterThanThreshold",
      treatMissingData: "notBreaching",
      alarmActions: [stack.alertsTopicArn],
    });
  }
}

/** Points a function at a log group the stack owns, so its logs get a retention period instead of keeping forever. */
function giveLogGroup(fn: CfnFunction, days: number): void {
  const config = Stack.of(fn).resolve(fn.loggingConfig) as { logGroup?: unknown } | undefined;
  if (config?.logGroup) return;
  const scope = fn.node.scope ?? fn;
  const existing = scope.node.tryFindChild("KitLogGroup") as CfnLogGroup | undefined;
  const group = existing ?? new CfnLogGroup(scope, "KitLogGroup", { retentionInDays: days });
  fn.loggingConfig = { ...(config ?? {}), logGroup: group.ref };
}
