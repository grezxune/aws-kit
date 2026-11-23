import { describe, expect, test } from "bun:test";
import { type CfnTemplate, checkTemplate } from "../../src/core/checks";

const TAGS = { project: "demo", stage: "dev", "managed-by": "aws-kit" };

describe("checkTemplate", () => {
  test("passes a clean template", () => {
    const template: CfnTemplate = { Resources: { Bucket: { Type: "AWS::S3::Bucket", Properties: { Tags: [] } } } };
    expect(checkTemplate(template, TAGS)).toEqual([]);
  });

  test("flags a literal account ID and names where it is", () => {
    const template: CfnTemplate = { Resources: { Role: { Type: "AWS::IAM::Role", Properties: { ManagedPolicyArns: ["arn:aws:iam::123456789012:policy/x"] } } } };
    const [violation] = checkTemplate(template, TAGS);
    expect(violation?.rule).toBe("account-id");
    expect(violation?.path).toBe("Resources.Role.Properties.ManagedPolicyArns[0]");
  });

  test("ignores twelve digits inside an asset hash", () => {
    const template: CfnTemplate = { Resources: { Fn: { Type: "AWS::Lambda::Function", Properties: { Code: { S3Key: "ab123456789012cd34ef.zip" } } } } };
    expect(checkTemplate(template, TAGS)).toEqual([]);
  });

  test("flags a fixed bucket name but not a generated one", () => {
    const fixed: CfnTemplate = { Resources: { Bucket: { Type: "AWS::S3::Bucket", Properties: { BucketName: "my-bucket" } } } };
    const generated: CfnTemplate = { Resources: { Bucket: { Type: "AWS::S3::Bucket", Properties: { BucketName: { "Fn::Sub": "x-${AWS::AccountId}" } } } } };
    expect(checkTemplate(fixed, TAGS).map((violation) => violation.rule)).toEqual(["fixed-global-name"]);
    expect(checkTemplate(generated, TAGS)).toEqual([]);
  });

  test("flags a reference to another stack", () => {
    const template: CfnTemplate = { Resources: { Topic: { Type: "AWS::SNS::Topic", Properties: { KmsMasterKeyId: { "Fn::ImportValue": "other-stack-key" } } } } };
    expect(checkTemplate(template, TAGS).map((violation) => violation.rule)).toEqual(["cross-stack-reference"]);
  });

  test("flags missing stack tags", () => {
    expect(checkTemplate({ Resources: {} }, { project: "demo" })[0]?.message).toContain("stage, managed-by");
  });

  test("requires every queue to have a dead-letter queue or be one", () => {
    const template: CfnTemplate = {
      Resources: {
        Work: { Type: "AWS::SQS::Queue", Properties: { RedrivePolicy: { deadLetterTargetArn: { "Fn::GetAtt": ["Dead", "Arn"] }, maxReceiveCount: 3 } } },
        Dead: { Type: "AWS::SQS::Queue", Properties: {} },
        Lonely: { Type: "AWS::SQS::Queue", Properties: {} },
      },
    };
    const violations = checkTemplate(template, TAGS);
    expect(violations.map((violation) => violation.path)).toEqual(["Resources.Lonely"]);
  });
});
