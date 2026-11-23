import { CfnOutput, Duration } from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

export interface PrivateBucketProps {
  /** Keep old versions, so a deleted or overwritten file can be restored. Default true. */
  versioned?: boolean;
  /** Days an old version is kept before it expires. Default 90. */
  noncurrentVersionDays?: number;
  /** Browser origins that may PUT through a presigned URL and GET directly, such as https://shop.example.com. */
  corsOrigins?: string[];
  /** Methods those origins may use. Default GET, PUT, and HEAD. */
  corsMethods?: s3.HttpMethods[];
  /** More lifecycle rules, such as expiring a temporary uploads prefix. */
  lifecycleRules?: s3.LifecycleRule[];
}

const OUTPUT_ID = /^[A-Za-z][A-Za-z0-9]*$/;

export function assertOutputId(id: string): void {
  if (!OUTPUT_ID.test(id)) throw new Error(`Construct id "${id}" names stack outputs, so it must be letters and digits, starting with a letter.`);
}

/** The bucket settings the storage standard requires: private, owner-enforced, encrypted, TLS only. */
export function privateBucketProps(props: PrivateBucketProps, versionedDefault: boolean): s3.BucketProps {
  const versioned = props.versioned ?? versionedDefault;
  return {
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
    encryption: s3.BucketEncryption.S3_MANAGED,
    enforceSSL: true,
    versioned,
    cors: props.corsOrigins?.length
      ? [{ allowedOrigins: props.corsOrigins, allowedMethods: props.corsMethods ?? [s3.HttpMethods.GET, s3.HttpMethods.PUT, s3.HttpMethods.HEAD], allowedHeaders: ["*"], exposedHeaders: ["ETag"], maxAge: 3000 }]
      : undefined,
    lifecycleRules: [
      { id: "abort-incomplete-uploads", abortIncompleteMultipartUploadAfter: Duration.days(7) },
      ...(versioned ? [{ id: "expire-old-versions", noncurrentVersionExpiration: Duration.days(props.noncurrentVersionDays ?? 90) }] : []),
      ...(props.lifecycleRules ?? []),
    ],
  };
}

/**
 * A private bucket for an app's files, read and written through presigned
 * URLs or a role. Nothing in it is public. Outputs `{id}BucketName`.
 */
export class PrivateBucket extends Construct {
  readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: PrivateBucketProps = {}) {
    assertOutputId(id);
    super(scope, id);
    this.bucket = new s3.Bucket(this, "Bucket", privateBucketProps(props, true));
    new CfnOutput(this, "BucketName", { key: `${id}BucketName`, value: this.bucket.bucketName });
  }
}
