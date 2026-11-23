import { CfnOutput, Duration, Stack } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import { ProjectStack } from "../project-stack";
import { assertOutputId } from "./private-bucket";

export type VercelEnvironment = "production" | "preview" | "development";

export interface VercelOidcRoleProps {
  /** Vercel team slug. Run aws-kit account ready --vercel-team <slug> once per account first. */
  team: string;
  /** Vercel project name. */
  project: string;
  /** Which Vercel environments may assume the role. Default production for the prod stage, preview and development otherwise. */
  environments?: VercelEnvironment[];
}

/**
 * A role a Vercel project assumes through Vercel's OIDC tokens, so the app
 * reaches AWS with no access key. Grant it what the app needs, such as
 * `bucket.grantReadWrite(role.role, "uploads/*")`. Outputs `{id}RoleArn`, which
 * the app passes to @vercel/functions/oidc's awsCredentialsProvider.
 */
export class VercelOidcRole extends Construct {
  readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: VercelOidcRoleProps) {
    assertOutputId(id);
    super(scope, id);
    const stack = Stack.of(this);
    const host = `oidc.vercel.com/${props.team}`;
    const prod = ProjectStack.find(this)?.prod ?? false;
    const environments = props.environments ?? (prod ? ["production"] : ["preview", "development"]);
    const provider = `arn:${stack.partition}:iam::${stack.account}:oidc-provider/${host}`;
    this.role = new iam.Role(this, "Role", {
      description: `Vercel ${props.team}/${props.project} (${environments.join(", ")})`,
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(provider, {
        StringEquals: { [`${host}:aud`]: `https://vercel.com/${props.team}` },
        StringLike: { [`${host}:sub`]: environments.map((environment) => `owner:${props.team}:project:${props.project}:environment:${environment}`) },
      }),
    });
    new CfnOutput(this, "RoleArn", { key: `${id}RoleArn`, value: this.role.roleArn });
  }
}
