import { Stack, type StackProps } from "aws-cdk-lib";
import type { Construct } from "constructs";
import { PROD_STAGE } from "../core/project";
import { ALERTS_TOPIC } from "../core/ready-steps-names";

export interface ProjectStackProps extends StackProps {
  project: string;
  stage: string;
  logRetentionDays: number;
}

/**
 * The one stack for a project stage. Its account is left to CloudFormation, so
 * the same code deploys to any account (R9). Prod gets termination protection.
 */
export class ProjectStack extends Stack {
  readonly project: string;
  readonly stage: string;
  readonly prod: boolean;
  readonly logRetentionDays: number;

  constructor(scope: Construct, id: string, props: ProjectStackProps) {
    super(scope, id, { ...props, terminationProtection: props.stage === PROD_STAGE });
    this.project = props.project;
    this.stage = props.stage;
    this.prod = props.stage === PROD_STAGE;
    this.logRetentionDays = props.logRetentionDays;
  }

  /** The SNS topic aws-kit account ready makes in each account and region. Alarms send here. */
  get alertsTopicArn(): string {
    return this.formatArn({ service: "sns", resource: ALERTS_TOPIC });
  }

  static find(scope: Construct): ProjectStack | undefined {
    const stack = Stack.of(scope);
    return stack instanceof ProjectStack ? stack : undefined;
  }
}
