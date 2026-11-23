import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import type { OrgAccount } from "./accounts";
import type { Session } from "./credentials";
import { KitError } from "./errors";
import { loadProject, type LoadedProject, stageTarget, type StageTarget } from "./project";
import { accountSession, type KitContext } from "./sessions";
import { describeStack } from "./stacks";

export interface StageContext {
  project: LoadedProject;
  target: StageTarget;
  session: Session;
  account: OrgAccount;
  cfn: CloudFormationClient;
}

/** The project, the stage, and a session in the account and region that stage deploys to. */
export async function stageContext(ctx: KitContext, dir: string, stage: string): Promise<StageContext> {
  const project = loadProject(dir);
  const target = stageTarget(project.config, stage);
  const { session, account } = await accountSession(ctx, target.account, target.region);
  return { project, target, session, account, cfn: new CloudFormationClient({ region: target.region, credentials: session.credentials }) };
}

export async function assertAccountReady(stage: StageContext): Promise<void> {
  if (!(await describeStack(stage.cfn, "CDKToolkit"))) {
    throw new KitError("account_not_ready", `Account ${stage.account.name} has no CDK bootstrap in ${stage.target.region}.`, `aws-kit account ready --account ${stage.account.name} --yes`);
  }
}
