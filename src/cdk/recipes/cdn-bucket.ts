import { CfnOutput, Stack, Token } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { assertOutputId, type PrivateBucketProps, privateBucketProps } from "./private-bucket";

export interface CdnBucketProps extends PrivateBucketProps {
  /**
   * Your own domain names, such as photos.example.com. The stack makes an ACM
   * certificate validated by DNS: the first deploy waits until the validation
   * CNAME exists at your DNS host. CloudFront needs the stack in us-east-1.
   */
  domainNames?: string[];
  /** Default PRICE_CLASS_100: North America and Europe edges, the cheapest. */
  priceClass?: cloudfront.PriceClass;
  /** Default CACHING_OPTIMIZED, which suits files whose key changes when their bytes do. */
  cachePolicy?: cloudfront.ICachePolicy;
}

/**
 * A private bucket served through CloudFront, per the storage standard: Origin
 * Access Control, a bucket policy that admits only this distribution, HTTPS
 * only, GET and HEAD only, compressed. Outputs `{id}BucketName`,
 * `{id}DistributionId`, `{id}DistributionDomain`, and `{id}Url`.
 */
export class CdnBucket extends Construct {
  readonly bucket: s3.Bucket;
  readonly distribution: cloudfront.Distribution;
  readonly certificate?: acm.Certificate;
  /** The https:// address files are served from. */
  readonly url: string;

  constructor(scope: Construct, id: string, props: CdnBucketProps = {}) {
    assertOutputId(id);
    super(scope, id);
    this.bucket = new s3.Bucket(this, "Bucket", privateBucketProps(props, false));
    const names = props.domainNames ?? [];
    if (names.length) {
      const region = Stack.of(this).region;
      if (Token.isUnresolved(region) || region !== "us-east-1") throw new Error(`${id}: CloudFront takes certificates only from us-east-1. Put this stage in us-east-1 or leave domainNames out.`);
      this.certificate = new acm.Certificate(this, "Certificate", { domainName: names[0] ?? "", subjectAlternativeNames: names.slice(1), validation: acm.CertificateValidation.fromDns() });
    }
    this.distribution = new cloudfront.Distribution(this, "Distribution", {
      comment: `${Stack.of(this).stackName} ${id}`,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
        compress: true,
        cachePolicy: props.cachePolicy ?? cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      priceClass: props.priceClass ?? cloudfront.PriceClass.PRICE_CLASS_100,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      ...(this.certificate ? { domainNames: names, certificate: this.certificate, minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021 } : {}),
    });
    this.url = `https://${names[0] ?? this.distribution.distributionDomainName}`;
    new CfnOutput(this, "BucketName", { key: `${id}BucketName`, value: this.bucket.bucketName });
    new CfnOutput(this, "DistributionId", { key: `${id}DistributionId`, value: this.distribution.distributionId });
    new CfnOutput(this, "DistributionDomain", { key: `${id}DistributionDomain`, value: this.distribution.distributionDomainName });
    new CfnOutput(this, "Url", { key: `${id}Url`, value: this.url });
  }
}
