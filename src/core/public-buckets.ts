import { GetBucketAclCommand, GetBucketPolicyStatusCommand, ListBucketsCommand, S3Client } from "@aws-sdk/client-s3";
import type { Session } from "./credentials";
import { isAwsError } from "./errors";

const ALL_USERS = /acs\.amazonaws\.com\/groups\/global\/(AllUsers|AuthenticatedUsers)$/;

/** Buckets that anyone can read today, through a public bucket policy or a public ACL. */
export async function publicBuckets(session: Session): Promise<string[]> {
  const s3 = new S3Client({ region: session.region, credentials: session.credentials, followRegionRedirects: true });
  const listed = await s3.send(new ListBucketsCommand({}));
  const open: string[] = [];
  for (const bucket of listed.Buckets ?? []) {
    const name = bucket.Name;
    if (!name) continue;
    const status = await s3.send(new GetBucketPolicyStatusCommand({ Bucket: name })).catch((error: unknown) => (isAwsError(error, "NoSuchBucketPolicy") ? null : Promise.reject(error)));
    const acl = await s3.send(new GetBucketAclCommand({ Bucket: name })).catch(() => null);
    const aclPublic = acl?.Grants?.some((grant) => ALL_USERS.test(grant.Grantee?.URI ?? "")) ?? false;
    if (status?.PolicyStatus?.IsPublic || aclPublic) open.push(name);
  }
  return open;
}
