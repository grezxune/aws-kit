import { describe, expect, test } from "bun:test";
import { classify, moveLabelOf } from "../../src/core/resource-classes";

describe("classify", () => {
  test("knows stateful types and which leave snapshots", () => {
    expect(classify("AWS::RDS::DBCluster")).toMatchObject({ kind: "stateful", snapshot: true });
    expect(classify("AWS::S3::Bucket")).toMatchObject({ kind: "stateful", snapshot: false, move: { method: "copy-data" } });
  });

  test("treats a bucket policy as stateless even though buckets are stateful", () => {
    expect(classify("AWS::S3::BucketPolicy").kind).toBe("stateless");
  });

  test("returns unknown for types it has never seen", () => {
    expect(classify("AWS::Timestream::Table").kind).toBe("unknown");
  });

  test("labels resources that cannot move as-is", () => {
    expect(moveLabelOf("AWS::KMS::Key").method).toBe("cannot-move");
    expect(moveLabelOf("AWS::CloudFront::Distribution", { DistributionConfig: { Aliases: ["photos.example.com"] } }).method).toBe("cannot-move");
    expect(moveLabelOf("AWS::CloudFront::Distribution", { DistributionConfig: {} }).method).toBe("recreate");
  });
});
