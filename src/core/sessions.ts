import { OrganizationsClient } from "@aws-sdk/client-organizations";
import { describeOrg, findAccount, listAccounts, type Org, type OrgAccount } from "./accounts";
import type { Config } from "./config";
import { assumedSession, profileSession, type Session } from "./credentials";
import { KitError } from "./errors";

/** What every command gets: the machine config and the profile flag, if one was passed. */
export interface KitContext {
  config: Config;
  profile?: string;
}

/** Organizations is a global service served from us-east-1. */
export const ORG_REGION = "us-east-1";

export function orgClient(session: Session): OrganizationsClient {
  return new OrganizationsClient({ region: ORG_REGION, credentials: session.credentials });
}

/** The operator's session in the management account. */
export async function operatorSession(ctx: KitContext, region = ctx.config.region): Promise<Session> {
  return profileSession(ctx.profile ?? ctx.config.operatorProfile, region);
}

export interface OrgView {
  operator: Session;
  org: Org;
  accounts: OrgAccount[];
}

export async function orgView(ctx: KitContext): Promise<OrgView> {
  const operator = await operatorSession(ctx);
  const client = orgClient(operator);
  const org = await describeOrg(client);
  if (!org) throw new KitError("no_organization", `Account ${operator.accountId} is not in an AWS organization.`, "Run aws-kit bootstrap with the root profile first.");
  if (org.managementAccountId !== operator.accountId) {
    throw new KitError("not_management_account", `Profile ${operator.profile} signs in to ${operator.accountId}, not the management account ${org.managementAccountId}.`, "Use a profile for the management account.");
  }
  return { operator, org, accounts: await listAccounts(client, org) };
}

/** A session in the account a name, an ID, or `management` refers to. */
export async function sessionFor(view: OrgView, ref: string, region: string, config: Config): Promise<{ session: Session; account: OrgAccount }> {
  const account = findAccount(view.accounts, ref);
  if (account.status !== "ACTIVE") throw new KitError("account_inactive", `Account ${account.name} is ${account.status}.`);
  if (account.management) return { session: { ...view.operator, region }, account };
  return { session: assumedSession(view.operator, account.id, config.memberRole, region), account };
}

export async function accountSession(ctx: KitContext, ref: string, region = ctx.config.region): Promise<{ session: Session; account: OrgAccount; view: OrgView }> {
  const view = await orgView(ctx);
  return { ...(await sessionFor(view, ref, region, ctx.config)), view };
}
