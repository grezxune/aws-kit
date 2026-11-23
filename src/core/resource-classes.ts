/**
 * How each resource type behaves when a stack is destroyed or moved to another
 * account. This is data, not per-service code: it drives prod protection (R8)
 * and the move labels on every plan (R9). A type missing here is "unknown",
 * and prod treats unknown as stateful.
 */
export type ResourceKind = "stateless" | "stateful" | "unknown";

export type MoveLabel = { method: "recreate" } | { method: "copy-data"; how: string } | { method: "cannot-move"; reason: string };

export interface ResourceClass {
  kind: ResourceKind;
  /** CloudFormation can leave a final snapshot when it deletes this type. */
  snapshot: boolean;
  move: MoveLabel;
}

const copy = (how: string): MoveLabel => ({ method: "copy-data", how });
const RDS_SNAPSHOT = copy("Share a snapshot encrypted with a customer-managed KMS key, then restore it in the new account");

const STATEFUL: Record<string, { snapshot?: boolean; move: MoveLabel }> = {
  "AWS::S3::Bucket": { move: copy("S3 Batch Replication, or aws s3 sync into the new bucket") },
  "AWS::S3Express::DirectoryBucket": { move: copy("aws s3 sync into the new bucket") },
  "AWS::DynamoDB::Table": { move: copy("Export the table to S3, then import it in the new account") },
  "AWS::DynamoDB::GlobalTable": { move: copy("Export the table to S3, then import it in the new account") },
  "AWS::RDS::DBInstance": { snapshot: true, move: RDS_SNAPSHOT },
  "AWS::RDS::DBCluster": { snapshot: true, move: RDS_SNAPSHOT },
  "AWS::Neptune::DBCluster": { snapshot: true, move: RDS_SNAPSHOT },
  "AWS::DocDB::DBCluster": { snapshot: true, move: RDS_SNAPSHOT },
  "AWS::Redshift::Cluster": { snapshot: true, move: copy("Share a snapshot with the new account, then restore it") },
  "AWS::ElastiCache::ReplicationGroup": { snapshot: true, move: copy("Export a backup to S3, then seed the new cluster from it") },
  "AWS::ElastiCache::CacheCluster": { snapshot: true, move: copy("Export a backup to S3, then seed the new cluster from it") },
  "AWS::ElastiCache::ServerlessCache": { move: copy("Export a snapshot to S3, then seed the new cache from it") },
  "AWS::EC2::Volume": { snapshot: true, move: copy("Share a snapshot with the new account, then create a volume from it") },
  "AWS::EFS::FileSystem": { move: copy("AWS DataSync into the new file system") },
  "AWS::OpenSearchService::Domain": { move: copy("Take a manual snapshot to S3, then restore it in the new domain") },
  "AWS::SecretsManager::Secret": { move: copy("Copy the secret value into the new secret") },
  "AWS::ECR::Repository": { move: copy("ECR cross-account replication, or pull and push the images") },
  "AWS::Backup::BackupVault": { move: copy("A cross-account copy job for each recovery point") },
  "AWS::KMS::Key": { move: { method: "cannot-move", reason: "A KMS key cannot leave its account. Data it encrypts must be re-encrypted under a key in the new account." } },
  "AWS::Cognito::UserPool": { move: { method: "cannot-move", reason: "Cognito cannot export user passwords. Users reset passwords, or a migration trigger moves them at sign-in." } },
};

/** Prefixes of types that hold no data a destroy would lose. */
const STATELESS_PREFIXES = [
  "AWS::IAM::", "AWS::Lambda::", "AWS::CloudFront::", "AWS::SNS::", "AWS::SQS::", "AWS::CloudWatch::", "AWS::Events::", "AWS::Scheduler::",
  "AWS::Pipes::", "AWS::ApiGateway::", "AWS::ApiGatewayV2::", "AWS::AppSync::", "AWS::StepFunctions::", "AWS::ECS::", "AWS::EC2::",
  "AWS::ElasticLoadBalancingV2::", "AWS::AutoScaling::", "AWS::ApplicationAutoScaling::", "AWS::Logs::", "AWS::S3::BucketPolicy",
  "AWS::S3::AccessPoint", "AWS::SSM::", "AWS::Route53::", "AWS::CertificateManager::", "AWS::WAFv2::", "AWS::CDK::", "AWS::CloudFormation::",
  "AWS::Kinesis::", "AWS::KinesisFirehose::", "AWS::Budgets::", "AWS::Cognito::UserPoolClient", "AWS::Cognito::UserPoolDomain", "AWS::KMS::Alias",
  "AWS::SecretsManager::SecretTargetAttachment", "AWS::SecretsManager::RotationSchedule", "AWS::RDS::DBSubnetGroup", "AWS::RDS::DBParameterGroup",
  "AWS::RDS::DBClusterParameterGroup", "AWS::ElastiCache::SubnetGroup", "AWS::ElastiCache::ParameterGroup", "AWS::Bedrock::", "AWS::BedrockAgentCore::",
  "Custom::",
];

export function classify(type: string): ResourceClass {
  const stateful = STATEFUL[type];
  if (stateful) return { kind: "stateful", snapshot: stateful.snapshot ?? false, move: stateful.move };
  if (STATELESS_PREFIXES.some((prefix) => type.startsWith(prefix))) return { kind: "stateless", snapshot: false, move: { method: "recreate" } };
  return { kind: "unknown", snapshot: false, move: copy("Unclassified type: check whether it holds data before moving") };
}

/** The move label for one resource, which can depend on its properties. */
export function moveLabelOf(type: string, properties: Record<string, unknown> = {}): MoveLabel {
  if (type === "AWS::CloudFront::Distribution") {
    const aliases = (properties.DistributionConfig as { Aliases?: unknown } | undefined)?.Aliases;
    if (Array.isArray(aliases) && aliases.length) return { method: "cannot-move", reason: "Its alternate domain names stay held by this distribution until it is deleted or they are removed from it." };
  }
  if (type === "AWS::Cognito::UserPoolDomain") return { method: "cannot-move", reason: "The domain prefix is unique across AWS and stays held until this domain is deleted." };
  return classify(type).move;
}
