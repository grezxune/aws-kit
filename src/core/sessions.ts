import { OrganizationsClient } from "@aws-sdk/client-organizations";
import { describeOrg, findAccount, listAccounts, type Org, type OrgAccount } from "./accounts";
import { profileNames } from "./aws-profiles";
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

/** The kit's session: the admin permission set in the management account, through Identity Center. */
export async function kitSession(ctx: KitContext, region = ctx.config.region): Promise<Session> {
  const profile = ctx.profile ?? ctx.config.profile;
  return profileSession(profile, region, `Bootstrap writes it: run aws-kit bootstrap --yes as root. On another machine, set it up with: aws configure sso --profile ${profile}`);
}

export interface OrgView {
  management: Session;
  org: Org;
  accounts: OrgAccount[];
}

export async function orgView(ctx: KitContext): Promise<OrgView> {
  const management = await kitSession(ctx);
  const client = orgClient(management);
  const org = await describeOrg(client);
  if (!org) throw new KitError("no_organization", `Account ${management.accountId} is not in an AWS organization.`, "Run aws-kit bootstrap with the root profile first.");
  if (org.managementAccountId !== management.accountId) {
    throw new KitError("not_management_account", `Profile ${management.profile} signs in to ${management.accountId}, not the management account ${org.managementAccountId}.`, "Use a profile for the management account.");
  }
  return { management, org, accounts: await listAccounts(client, org) };
}

function activeAccount(view: OrgView, ref: string): OrgAccount {
  const account = findAccount(view.accounts, ref);
  if (account.status !== "ACTIVE") throw new KitError("account_inactive", `Account ${account.name} is ${account.status}.`);
  return account;
}

/** An admin session in the account a name, an ID, or `management` refers to. Member accounts go through the organization's access role. */
export async function sessionFor(view: OrgView, ref: string, region: string, config: Config): Promise<{ session: Session; account: OrgAccount }> {
  const account = activeAccount(view, ref);
  if (account.management) return { session: { ...view.management, region }, account };
  return { session: assumedSession(view.management, account.id, config.memberRole, region), account };
}

/** A read-only session in an account, through its `-read` Identity Center profile. AWS denies every change made with it. */
export async function readSessionFor(view: OrgView, ref: string, region: string, config: Config): Promise<{ session: Session; account: OrgAccount }> {
  const account = activeAccount(view, ref);
  const profile = profileNames(config, account).read;
  const hint = account.management
    ? "Write it with: aws-kit profiles --yes"
    : `Write it with: aws-kit profiles --yes. If the account was never made ready: aws-kit account ready --account ${account.name} --yes`;
  return { session: await profileSession(profile, region, hint), account };
}

export async function accountSession(ctx: KitContext, ref: string, region = ctx.config.region): Promise<{ session: Session; account: OrgAccount; view: OrgView }> {
  const view = await orgView(ctx);
  return { ...(await sessionFor(view, ref, region, ctx.config)), view };
}
