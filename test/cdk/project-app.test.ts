import { describe, expect, test } from "bun:test";
import { CfnResource, Duration } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { testProject } from "../support/project";

describe("projectApp", () => {
  test("names the stack {project}-{stage} and tags the stack and its resources", () => {
    const { stack } = testProject("dev");
    new s3.Bucket(stack, "Files");
    expect(stack.stackName).toBe("demo-dev");
    expect(stack.tags.tagValues()).toEqual({ project: "demo", stage: "dev", "managed-by": "aws-kit" });
    Template.fromStack(stack).hasResourceProperties("AWS::S3::Bucket", {
      Tags: Match.arrayWith([{ Key: "managed-by", Value: "aws-kit" }, { Key: "project", Value: "demo" }, { Key: "stage", Value: "dev" }]),
    });
  });

  test("leaves the account to CloudFormation so the stack can move", () => {
    const { stack } = testProject("dev");
    expect(stack.resolve(stack.account)).toEqual({ Ref: "AWS::AccountId" });
    expect(stack.region).toBe("us-east-1");
  });

  test("outside prod, deletes everything with the stack", () => {
    const { stack } = testProject("dev");
    new s3.Bucket(stack, "Files");
    expect(stack.terminationProtection).toBe(false);
    Template.fromStack(stack).hasResource("AWS::S3::Bucket", { DeletionPolicy: "Delete", UpdateReplacePolicy: "Delete" });
  });

  test("in prod, keeps data, snapshots what can be, and treats unknown types as data", () => {
    const { stack } = testProject("prod");
    new s3.Bucket(stack, "Files", { removalPolicy: undefined });
    new rds.CfnDBCluster(stack, "Db", { engine: "aurora-postgresql" });
    new CfnResource(stack, "Mystery", { type: "AWS::Glue::Database", properties: { CatalogId: stack.account, DatabaseInput: { Name: "demo" } } });
    new sqs.Queue(stack, "Dead");
    expect(stack.terminationProtection).toBe(true);
    const template = Template.fromStack(stack);
    template.hasResource("AWS::S3::Bucket", { DeletionPolicy: "Retain" });
    template.hasResource("AWS::RDS::DBCluster", { DeletionPolicy: "Snapshot" });
    template.hasResource("AWS::Glue::Database", { DeletionPolicy: "Retain" });
    template.hasResource("AWS::SQS::Queue", { DeletionPolicy: "Delete" });
  });

  test("gives each function a log group with retention and alarms on errors and throttles", () => {
    const { stack } = testProject("dev");
    new lambda.Function(stack, "Worker", { runtime: lambda.Runtime.NODEJS_22_X, handler: "index.handler", code: lambda.Code.fromInline("exports.handler = async () => {}") });
    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::Logs::LogGroup", { RetentionInDays: 30 });
    template.hasResourceProperties("AWS::Lambda::Function", { LoggingConfig: { LogGroup: { Ref: Match.stringLikeRegexp("KitLogGroup") } } });
    template.resourcePropertiesCountIs("AWS::CloudWatch::Alarm", { Namespace: "AWS/Lambda", MetricName: Match.anyValue() }, 2);
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      MetricName: "Errors",
      AlarmDescription: Match.stringLikeRegexp("^demo dev: "),
      AlarmActions: [{ "Fn::Join": ["", Match.arrayWith([":sns:us-east-1:", { Ref: "AWS::AccountId" }, ":aws-kit-alerts"])] }],
    });
  });

  test("alarms when a message lands in a dead-letter queue", () => {
    const { stack } = testProject("dev");
    const dead = new sqs.Queue(stack, "Dead");
    new sqs.Queue(stack, "Work", { deadLetterQueue: { queue: dead, maxReceiveCount: 3 }, visibilityTimeout: Duration.seconds(30) });
    Template.fromStack(stack).resourcePropertiesCountIs("AWS::CloudWatch::Alarm", { Namespace: "AWS/SQS", MetricName: "ApproximateNumberOfMessagesVisible" }, 1);
  });

  test("refuses a stage aws-kit.json does not list", () => {
    expect(() => testProject("staging" as "dev")).toThrow(/no stage staging/);
  });
});
