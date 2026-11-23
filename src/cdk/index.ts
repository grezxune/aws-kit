/** The CDK side of aws-kit. A project's infra app imports from `aws-kit/cdk`. */
export { KitAspect, applyRemovalPolicy } from "./aspects";
export { projectApp, type ProjectApp, type ProjectAppOptions } from "./project-app";
export { ProjectStack, type ProjectStackProps } from "./project-stack";
export { CdnBucket, type CdnBucketProps } from "./recipes/cdn-bucket";
export { PrivateBucket, type PrivateBucketProps } from "./recipes/private-bucket";
export { VercelOidcRole, type VercelEnvironment, type VercelOidcRoleProps } from "./recipes/vercel-oidc-role";
export { classify, moveLabelOf, type MoveLabel, type ResourceClass } from "../core/resource-classes";
export { checkTemplate, type Violation } from "../core/checks";
