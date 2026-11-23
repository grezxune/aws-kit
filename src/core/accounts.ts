import {
  CreateAccountCommand,
  DescribeCreateAccountStatusCommand,
  DescribeOrganizationCommand,
  type OrganizationsClient,
  paginateListAccounts,
} from "@aws-sdk/client-organizations";
import { isAwsError, KitError } from "./errors";

export interface Org {
  id: string;
  managementAccountId: string;
  featureSet: string;
}

export interface OrgAccount {
  id: string;
  name: string;
  email: string;
  status: string;
  management: boolean;
}

/** Lowercase words and hyphens. The name is how every command and every project config refers to an account. */
export const ACCOUNT_NAME = /^[a-z][a-z0-9-]{0,48}[a-z0-9]$/;

export async function describeOrg(client: OrganizationsClient): Promise<Org | null> {
  try {
    const { Organization: org } = await client.send(new DescribeOrganizationCommand({}));
    return { id: org?.Id ?? "", managementAccountId: org?.MasterAccountId ?? "", featureSet: org?.FeatureSet ?? "" };
  } catch (error) {
    if (isAwsError(error, "AWSOrganizationsNotInUseException")) return null;
    throw error;
  }
}

export async function listAccounts(client: OrganizationsClient, org: Org): Promise<OrgAccount[]> {
  const accounts: OrgAccount[] = [];
  for await (const page of paginateListAccounts({ client }, {})) {
    for (const account of page.Accounts ?? []) {
      accounts.push({
        id: account.Id ?? "",
        name: account.Name ?? "",
        email: account.Email ?? "",
        status: account.State ?? account.Status ?? "",
        management: account.Id === org.managementAccountId,
      });
    }
  }
  return accounts.sort((a, b) => Number(b.management) - Number(a.management) || a.name.localeCompare(b.name));
}

/** Finds an account by name, by 12-digit ID, or as `management`. */
export function findAccount(accounts: OrgAccount[], ref: string): OrgAccount {
  const found = ref === "management" ? accounts.find((account) => account.management) : accounts.find((account) => account.id === ref || account.name === ref);
  if (!found) throw new KitError("account_not_found", `No account named ${ref} in the organization.`, "List them with aws-kit account list, or make one with aws-kit account create.");
  return found;
}

export function accountEmailFor(template: string | undefined, name: string): string {
  if (!template) throw new KitError("config_missing", "No email template for new accounts.", "Set one: aws-kit config set accountEmail 'you+aws-{name}@example.com'. Each AWS account needs its own address; plus addressing gives one inbox many addresses.");
  return template.replaceAll("{name}", name);
}

export interface CreateAccountInput {
  name: string;
  email: string;
  roleName: string;
  tags: Record<string, string>;
}

export interface PollOptions {
  intervalMs?: number;
  timeoutMs?: number;
  onProgress?: (state: string) => void;
}

/** Creates a member account and waits until AWS reports it ready. Returns its ID. */
export async function createAccount(client: OrganizationsClient, input: CreateAccountInput, poll: PollOptions = {}): Promise<string> {
  const { intervalMs = 5000, timeoutMs = 15 * 60 * 1000, onProgress } = poll;
  const started = await client.send(
    new CreateAccountCommand({
      AccountName: input.name,
      Email: input.email,
      RoleName: input.roleName,
      IamUserAccessToBilling: "ALLOW",
      Tags: Object.entries(input.tags).map(([Key, Value]) => ({ Key, Value })),
    }),
  );
  const requestId = started.CreateAccountStatus?.Id;
  if (!requestId) throw new KitError("account_create_failed", "AWS did not return a request ID for the new account.");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { CreateAccountStatus: status } = await client.send(new DescribeCreateAccountStatusCommand({ CreateAccountRequestId: requestId }));
    onProgress?.(status?.State ?? "UNKNOWN");
    if (status?.State === "SUCCEEDED" && status.AccountId) return status.AccountId;
    if (status?.State === "FAILED") throw new KitError("account_create_failed", `AWS could not create the account: ${status.FailureReason ?? "no reason given"}.`, failureHint(status.FailureReason));
    await Bun.sleep(intervalMs);
  }
  throw new KitError("account_create_timeout", `The account was still being created after ${Math.round(timeoutMs / 60000)} minutes.`, `Check later with aws-kit account list. Request ID: ${requestId}.`);
}

function failureHint(reason: string | undefined): string | undefined {
  if (reason === "EMAIL_ALREADY_EXISTS") return "Every AWS account needs its own email address. Pass a different --email.";
  if (reason === "ACCOUNT_LIMIT_EXCEEDED") return "The organization is at its account quota. Ask for more in Service Quotas, under AWS Organizations.";
  return undefined;
}
