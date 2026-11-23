import { IdentitystoreClient, paginateListUsers } from "@aws-sdk/client-identitystore";
import {
  AttachManagedPolicyToPermissionSetCommand,
  CreateAccountAssignmentCommand,
  CreatePermissionSetCommand,
  DescribeAccountAssignmentCreationStatusCommand,
  DescribePermissionSetCommand,
  ListInstancesCommand,
  paginateListAccountAssignments,
  paginateListManagedPoliciesInPermissionSet,
  paginateListPermissionSets,
  ProvisionPermissionSetCommand,
  SSOAdminClient,
} from "@aws-sdk/client-sso-admin";
import type { OrgAccount } from "./accounts";
import { accountSections, planProfiles, readAwsConfig, type Section, ssoSessionSection, writeAwsConfig } from "./aws-profiles";
import { type Config, ssoRegionOf } from "./config";
import type { Session } from "./credentials";
import { KitError } from "./errors";
import type { Step } from "./steps";

export const ADMIN_POLICY = "arn:aws:iam::aws:policy/AdministratorAccess";
export const READ_POLICY = "arn:aws:iam::aws:policy/ReadOnlyAccess";

export interface Instance {
  arn: string;
  identityStoreId: string;
  startUrl: string;
}

export type UserLookup = { user: { id: string; name: string } } | { problem: string };

type Account = Pick<OrgAccount, "id" | "name" | "management">;

/** IAM Identity Center for one command. It asks AWS once for the instance, the user, and each permission set, and remembers the answers. */
export class IdentityCenter {
  readonly admin: SSOAdminClient;
  readonly store: IdentitystoreClient;
  readonly region: string;
  private instance?: Instance | null;
  private user?: UserLookup;
  private readonly sets = new Map<string, string | null>();

  constructor(session: Session, readonly config: Config) {
    this.region = ssoRegionOf(config);
    this.admin = new SSOAdminClient({ region: this.region, credentials: session.credentials });
    this.store = new IdentitystoreClient({ region: this.region, credentials: session.credentials });
  }

  async getInstance(): Promise<Instance | null> {
    if (this.instance !== undefined) return this.instance;
    const { Instances: instances = [] } = await this.admin.send(new ListInstancesCommand({}));
    const found = instances.find((instance) => !instance.Status || instance.Status === "ACTIVE");
    this.instance = found?.InstanceArn && found.IdentityStoreId
      ? { arn: found.InstanceArn, identityStoreId: found.IdentityStoreId, startUrl: this.config.ssoStartUrl ?? `https://${found.IdentityStoreId}.awsapps.com/start` }
      : null;
    return this.instance;
  }

  async requireInstance(): Promise<Instance> {
    const instance = await this.getInstance();
    if (!instance) throw new KitError("identity_center_off", `IAM Identity Center is not turned on in ${this.region}.`, "Run aws-kit bootstrap as root and follow its steps.");
    return instance;
  }

  /** The configured ssoUser, or the only user in the identity store. */
  async getUser(): Promise<UserLookup> {
    if (this.user) return this.user;
    const instance = await this.requireInstance();
    const users: { id: string; name: string }[] = [];
    for await (const page of paginateListUsers({ client: this.store }, { IdentityStoreId: instance.identityStoreId })) {
      for (const user of page.Users ?? []) if (user.UserId && user.UserName) users.push({ id: user.UserId, name: user.UserName });
    }
    const wanted = this.config.ssoUser?.toLowerCase();
    const match = wanted ? users.find((user) => user.name.toLowerCase() === wanted) : users.length === 1 ? users[0] : undefined;
    if (match) this.user = { user: match };
    else if (wanted) this.user = { problem: `No Identity Center user named ${this.config.ssoUser}. Add it in the IAM Identity Center console under Users, or fix the setting: aws-kit config set ssoUser <name>.` };
    else if (users.length) this.user = { problem: `The identity store has ${users.length} users. Name yours: aws-kit config set ssoUser <name>.` };
    else this.user = { problem: "In the IAM Identity Center console, under Users, add yourself with your email, and choose to send the password setup email. Then run this command again." };
    return this.user;
  }

  async findPermissionSet(name: string): Promise<string | null> {
    if (this.sets.has(name)) return this.sets.get(name) ?? null;
    const instance = await this.requireInstance();
    let found: string | null = null;
    for await (const page of paginateListPermissionSets({ client: this.admin }, { InstanceArn: instance.arn })) {
      for (const arn of page.PermissionSets ?? []) {
        const described = await this.admin.send(new DescribePermissionSetCommand({ InstanceArn: instance.arn, PermissionSetArn: arn }));
        if (described.PermissionSet?.Name === name) found = arn;
      }
    }
    this.sets.set(name, found);
    return found;
  }

  remember(name: string, arn: string): void {
    this.sets.set(name, arn);
  }
}

const policyName = (arn: string) => arn.slice(arn.lastIndexOf("/") + 1);
const OFF = { needed: true, manual: true, detail: "Waits for IAM Identity Center to be turned on." };

/** A permission set with one AWS managed policy and 12-hour sessions. */
export function permissionSetStep(idc: IdentityCenter, name: string, policyArn: string): Step {
  let arn: string | null = null;
  return {
    id: `permission-set:${name}`,
    async check() {
      const instance = await idc.getInstance();
      if (!instance) return OFF;
      arn = await idc.findPermissionSet(name);
      if (!arn) return { needed: true, detail: `Create permission set ${name} with ${policyName(policyArn)} and 12-hour sessions.` };
      const policies: string[] = [];
      for await (const page of paginateListManagedPoliciesInPermissionSet({ client: idc.admin }, { InstanceArn: instance.arn, PermissionSetArn: arn })) {
        for (const policy of page.AttachedManagedPolicies ?? []) if (policy.Arn) policies.push(policy.Arn);
      }
      return policies.includes(policyArn) ? { needed: false, detail: `${name} has ${policyName(policyArn)}` } : { needed: true, detail: `Attach ${policyName(policyArn)} to ${name}.` };
    },
    async apply() {
      const instance = await idc.requireInstance();
      if (!arn) {
        const created = await idc.admin.send(new CreatePermissionSetCommand({ InstanceArn: instance.arn, Name: name, Description: `aws-kit: ${policyName(policyArn)}`, SessionDuration: "PT12H", Tags: [{ Key: "managed-by", Value: "aws-kit" }] }));
        arn = created.PermissionSet?.PermissionSetArn ?? null;
        if (!arn) throw new KitError("permission_set_failed", `AWS did not return an ARN for permission set ${name}.`);
        idc.remember(name, arn);
        await idc.admin.send(new AttachManagedPolicyToPermissionSetCommand({ InstanceArn: instance.arn, PermissionSetArn: arn, ManagedPolicyArn: policyArn }));
        return `Created ${name} with ${policyName(policyArn)}`;
      }
      await idc.admin.send(new AttachManagedPolicyToPermissionSetCommand({ InstanceArn: instance.arn, PermissionSetArn: arn, ManagedPolicyArn: policyArn }));
      await idc.admin.send(new ProvisionPermissionSetCommand({ InstanceArn: instance.arn, PermissionSetArn: arn, TargetType: "ALL_PROVISIONED_ACCOUNTS" }));
      return `Attached ${policyName(policyArn)} to ${name}`;
    },
  };
}

/** Gives the person's Identity Center user one permission set in one account. */
export function accessStep(idc: IdentityCenter, account: Account, setName: string, options: { setMadeEarlier: boolean; pollMs?: number }): Step {
  return {
    id: `access:${setName}`,
    async check() {
      const instance = await idc.getInstance();
      if (!instance) return OFF;
      const lookup = await idc.getUser();
      if ("problem" in lookup) return { needed: true, manual: true, detail: lookup.problem };
      const setArn = await idc.findPermissionSet(setName);
      if (!setArn) {
        return options.setMadeEarlier
          ? { needed: true, detail: `Give ${lookup.user.name} ${setName} in ${account.name}.` }
          : { needed: true, manual: true, detail: `Permission set ${setName} does not exist. Run aws-kit bootstrap --yes as root first.` };
      }
      for await (const page of paginateListAccountAssignments({ client: idc.admin }, { InstanceArn: instance.arn, AccountId: account.id, PermissionSetArn: setArn })) {
        if (page.AccountAssignments?.some((item) => item.PrincipalType === "USER" && item.PrincipalId === lookup.user.id)) return { needed: false, detail: `${lookup.user.name} has ${setName} in ${account.name}` };
      }
      return { needed: true, detail: `Give ${lookup.user.name} ${setName} in ${account.name}.` };
    },
    async apply() {
      const instance = await idc.requireInstance();
      const lookup = await idc.getUser();
      const setArn = await idc.findPermissionSet(setName);
      if ("problem" in lookup || !setArn) throw new KitError("access_failed", `Cannot give access to ${setName} yet.`);
      const started = await idc.admin.send(new CreateAccountAssignmentCommand({ InstanceArn: instance.arn, TargetId: account.id, TargetType: "AWS_ACCOUNT", PermissionSetArn: setArn, PrincipalType: "USER", PrincipalId: lookup.user.id }));
      const requestId = started.AccountAssignmentCreationStatus?.RequestId;
      for (let attempt = 0; requestId && attempt < 60; attempt++) {
        const { AccountAssignmentCreationStatus: status } = await idc.admin.send(new DescribeAccountAssignmentCreationStatusCommand({ InstanceArn: instance.arn, AccountAssignmentCreationRequestId: requestId }));
        if (status?.Status === "SUCCEEDED") return `Gave ${lookup.user.name} ${setName} in ${account.name}`;
        if (status?.Status === "FAILED") throw new KitError("access_failed", `AWS could not give ${setName} in ${account.name}: ${status.FailureReason ?? "no reason given"}.`);
        await Bun.sleep(options.pollMs ?? 2000);
      }
      return `Asked AWS to give ${lookup.user.name} ${setName} in ${account.name}. It can take a minute to apply.`;
    },
  };
}

/** Writes the sso-session and the accounts' profiles into the managed block of ~/.aws/config. */
export function profilesStep(idc: IdentityCenter, accounts: () => Promise<Account[]>): Step {
  let text = "";
  return {
    id: "aws-profiles",
    async check() {
      const instance = await idc.getInstance();
      if (!instance) return OFF;
      const sections: Section[] = [ssoSessionSection(idc.config, { startUrl: instance.startUrl, region: idc.region }), ...(await accounts()).flatMap((account) => accountSections(idc.config, account))];
      const plan = planProfiles(await readAwsConfig(), sections);
      text = plan.text;
      const yours = plan.keptYours.length ? ` Left your own ${plan.keptYours.join(", ")} as it is.` : "";
      if (!plan.written.length) return { needed: false, detail: `Profiles are current.${yours}` };
      return { needed: true, detail: `Write ${plan.written.map((header) => header.replace(/^profile /, "")).join(", ")} to ~/.aws/config.${yours}` };
    },
    async apply() {
      await writeAwsConfig(text);
      return undefined;
    },
  };
}
