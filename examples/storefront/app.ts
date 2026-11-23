import { Duration } from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import { CdnBucket, PrivateBucket, projectApp, VercelOidcRole } from "aws-kit/cdk";

/**
 * Storage for a shop with a storefront site and an admin site, both on Vercel.
 * It is the acceptance test for S3 and CloudFront: `aws-kit synth` on it must pass.
 */
const { stack, prod } = projectApp({ dir: import.meta.dir });

// Vercel team slug. Each role below trusts one project in this team.
const VERCEL_TEAM = "my-team";
const SITES = prod
  ? ["https://example.com", "https://admin.example.com"]
  : ["https://shop-web.vercel.app", "http://localhost:3000", "http://localhost:3001"];

// One private bucket for every app's files, one folder per use.
// Versioned, so a removed or overwritten original can be restored. Browsers PUT to it through presigned URLs.
const files = new PrivateBucket(stack, "Files", { versioned: true, noncurrentVersionDays: 90, corsOrigins: SITES, corsMethods: [s3.HttpMethods.PUT] });

// Public product photos: a private bucket only CloudFront can read, through Origin Access Control.
// Copies are named by hash and cached for a year, so the bucket needs no versioning.
const catalog = new CdnBucket(stack, "Catalog", { versioned: false });

// Database backups: Object Lock keeps each one for 30 days even from a stolen key, and a year later it expires.
const backups = new s3.Bucket(stack, "Backups", {
  blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
  objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
  encryption: s3.BucketEncryption.S3_MANAGED,
  enforceSSL: true,
  versioned: true,
  objectLockEnabled: true,
  objectLockDefaultRetention: prod ? s3.ObjectLockRetention.compliance(Duration.days(30)) : s3.ObjectLockRetention.governance(Duration.days(1)),
  lifecycleRules: [{ id: "expire-backups", expiration: Duration.days(365), noncurrentVersionExpiration: Duration.days(1) }],
});

// One keyless role per Vercel app, each granted only its folders.
const web = new VercelOidcRole(stack, "WebRole", { team: VERCEL_TEAM, project: "shop-web" });
files.bucket.grantReadWrite(web.role, "customers/*");
files.bucket.grantRead(web.role, "orders/attachments/*");

const admin = new VercelOidcRole(stack, "AdminRole", { team: VERCEL_TEAM, project: "shop-admin" });
files.bucket.grantReadWrite(admin.role, "orders/*");
files.bucket.grantRead(admin.role, "customers/*");
catalog.bucket.grantReadWrite(admin.role);

export { backups };
