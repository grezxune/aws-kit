import { expect, test } from "bun:test";
import { GetBucketAclCommand, GetBucketPolicyStatusCommand, ListBucketsCommand, S3Client } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
import type { Session } from "../../src/core/credentials";
import { publicBuckets } from "../../src/core/public-buckets";

test("finds buckets made public by policy or by ACL", async () => {
  const s3 = mockClient(S3Client);
  s3.on(ListBucketsCommand).resolves({ Buckets: [{ Name: "by-policy" }, { Name: "by-acl" }, { Name: "private" }] });
  // aws-sdk-client-mock lets the later, more specific matcher win.
  s3.on(GetBucketPolicyStatusCommand).rejects(Object.assign(new Error("none"), { name: "NoSuchBucketPolicy" }));
  s3.on(GetBucketPolicyStatusCommand, { Bucket: "by-policy" }).resolves({ PolicyStatus: { IsPublic: true } });
  s3.on(GetBucketAclCommand).resolves({ Grants: [] });
  s3.on(GetBucketAclCommand, { Bucket: "by-acl" }).resolves({ Grants: [{ Grantee: { Type: "Group", URI: "http://acs.amazonaws.com/groups/global/AllUsers" }, Permission: "READ" }] });
  const session = { region: "us-east-1", credentials: async () => ({ accessKeyId: "a", secretAccessKey: "b" }) } as unknown as Session;
  expect(await publicBuckets(session)).toEqual(["by-policy", "by-acl"]);
  s3.restore();
});
