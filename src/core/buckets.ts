import { DeleteObjectsCommand, ListObjectVersionsCommand, type ObjectIdentifier, S3Client } from "@aws-sdk/client-s3";
import type { Session } from "./credentials";
import { isAwsError, KitError } from "./errors";

/** Deletes every object version and delete marker, so CloudFormation can delete the bucket. Returns how many it removed. */
export async function emptyBucket(session: Session, bucket: string): Promise<number> {
  const s3 = new S3Client({ region: session.region, credentials: session.credentials });
  let removed = 0;
  let keyMarker: string | undefined;
  let versionMarker: string | undefined;
  try {
    do {
      const page = await s3.send(new ListObjectVersionsCommand({ Bucket: bucket, KeyMarker: keyMarker, VersionIdMarker: versionMarker }));
      const objects: ObjectIdentifier[] = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])].map((item) => ({ Key: item.Key ?? "", VersionId: item.VersionId }));
      for (let start = 0; start < objects.length; start += 1000) {
        const batch = objects.slice(start, start + 1000);
        const result = await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: batch, Quiet: true } }));
        if (result.Errors?.length) {
          throw new KitError("bucket_not_empty", `${result.Errors.length} objects in ${bucket} could not be deleted: ${result.Errors[0]?.Code} ${result.Errors[0]?.Message ?? ""}.`, "Object Lock or a bucket policy may protect them. Empty the bucket by hand, then destroy again.");
        }
        removed += batch.length;
      }
      keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
      versionMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
    } while (keyMarker);
  } catch (error) {
    if (isAwsError(error, "NoSuchBucket")) return removed;
    throw error;
  }
  return removed;
}
