import { describe, expect, test } from "bun:test";
import { Match, Template } from "aws-cdk-lib/assertions";
import { CdnBucket, checkTemplate, PrivateBucket, VercelOidcRole } from "../../src/cdk";
import { testProject } from "../support/project";

const blockAll = { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true };

describe("PrivateBucket", () => {
  test("is private, owner-enforced, encrypted, versioned, and TLS only", () => {
    const { stack } = testProject("dev");
    new PrivateBucket(stack, "Files", { corsOrigins: ["https://shop.example.com"] });
    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: blockAll,
      OwnershipControls: { Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }] },
      BucketEncryption: Match.objectLike({}),
      VersioningConfiguration: { Status: "Enabled" },
      CorsConfiguration: { CorsRules: [Match.objectLike({ AllowedOrigins: ["https://shop.example.com"], AllowedMethods: ["GET", "PUT", "HEAD"] })] },
    });
    template.hasResourceProperties("AWS::S3::BucketPolicy", { PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Effect: "Deny", Condition: { Bool: { "aws:SecureTransport": "false" } } })]) } });
    template.hasOutput("FilesBucketName", {});
  });

  test("refuses an id that cannot name an output", () => {
    const { stack } = testProject("dev");
    expect(() => new PrivateBucket(stack, "my-files")).toThrow(/letters and digits/);
  });
});

describe("CdnBucket", () => {
  test("serves a private bucket through CloudFront with Origin Access Control, per the storage standard", () => {
    const { stack } = testProject("prod");
    new CdnBucket(stack, "Photos");
    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::S3::Bucket", { PublicAccessBlockConfiguration: blockAll });
    template.resourceCountIs("AWS::CloudFront::OriginAccessControl", 1);
    template.resourceCountIs("AWS::CloudFront::CloudFrontOriginAccessIdentity", 0);
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        PriceClass: "PriceClass_100",
        DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: "redirect-to-https", AllowedMethods: ["GET", "HEAD"], Compress: true }),
      }),
    });
    template.hasResourceProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Effect: "Allow", Principal: { Service: "cloudfront.amazonaws.com" }, Action: "s3:GetObject", Condition: { StringEquals: { "AWS:SourceArn": Match.anyValue() } } }),
        ]),
      },
    });
    for (const output of ["PhotosBucketName", "PhotosDistributionId", "PhotosDistributionDomain", "PhotosUrl"]) template.hasOutput(output, {});
    expect(checkTemplate(template.toJSON(), { project: "demo", stage: "prod", "managed-by": "aws-kit" })).toEqual([]);
  });

  test("makes a DNS-validated certificate for its own domain", () => {
    const { stack } = testProject("dev");
    new CdnBucket(stack, "Photos", { domainNames: ["photos.example.com"] });
    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::CertificateManager::Certificate", { DomainName: "photos.example.com", ValidationMethod: "DNS" });
    template.hasResourceProperties("AWS::CloudFront::Distribution", { DistributionConfig: Match.objectLike({ Aliases: ["photos.example.com"] }) });
  });

  test("refuses a domain outside us-east-1, where CloudFront cannot read the certificate", () => {
    const { stack } = testProject("dev", "eu-west-1");
    expect(() => new CdnBucket(stack, "Photos", { domainNames: ["photos.example.com"] })).toThrow(/us-east-1/);
  });
});

describe("VercelOidcRole", () => {
  const trust = (stage: "dev" | "prod") => {
    const { stack } = testProject(stage);
    new VercelOidcRole(stack, "AppRole", { team: "acme", project: "shop" });
    const role = Object.values(Template.fromStack(stack).findResources("AWS::IAM::Role"))[0] as { Properties: { AssumeRolePolicyDocument: { Statement: Record<string, unknown>[] } } };
    return role.Properties.AssumeRolePolicyDocument.Statement[0] as { Condition: Record<string, Record<string, unknown>>; Principal: { Federated: unknown } };
  };

  test("prod trusts only the production environment of one Vercel project", () => {
    const statement = trust("prod");
    expect(statement.Condition.StringEquals).toEqual({ "oidc.vercel.com/acme:aud": "https://vercel.com/acme" });
    expect(statement.Condition.StringLike).toEqual({ "oidc.vercel.com/acme:sub": ["owner:acme:project:shop:environment:production"] });
    expect(JSON.stringify(statement.Principal.Federated)).toContain("oidc-provider/oidc.vercel.com/acme");
    expect(JSON.stringify(statement.Principal.Federated)).toContain("AWS::AccountId");
  });

  test("other stages trust preview and development", () => {
    expect(trust("dev").Condition.StringLike).toEqual({ "oidc.vercel.com/acme:sub": ["owner:acme:project:shop:environment:preview", "owner:acme:project:shop:environment:development"] });
  });
});
