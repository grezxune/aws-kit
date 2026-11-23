import { AttachUserPolicyCommand, CreateUserCommand, GetLoginProfileCommand, GetUserCommand, IAMClient, ListAttachedUserPoliciesCommand, ListMFADevicesCommand } from "@aws-sdk/client-iam";
import { CreateOrganizationCommand } from "@aws-sdk/client-organizations";
import { z } from "zod";
import { log } from "../cli/output";
import { defineCommand } from "../cli/registry";
import { describeOrg, type Org } from "../core/accounts";
import { profileSession } from "../core/credentials";
import { isAwsError, KitError } from "../core/errors";
import { orgClient } from "../core/sessions";
import { runSteps, type Step, summarize } from "../core/steps";

const ADMIN_POLICY = "arn:aws:iam::aws:policy/AdministratorAccess";
export const KIT_TAG = { Key: "managed-by", Value: "aws-kit" };

export const bootstrap = defineCommand({
  name: "bootstrap",
  summary: "Run once as root: create the organization and the operator user that every other command signs in as.",
  mutates: true,
  options: z.object({
    yes: z.boolean().default(false).describe("Make the changes. Without it, only report them"),
    profile: z.string().optional().describe("Profile signed in as root. Defaults to the rootProfile setting"),
  }),
  async run(options, ctx) {
    const profile = options.profile ?? ctx.config.rootProfile;
    const session = await profileSession(profile, ctx.config.region);
    const orgs = orgClient(session);
    const iam = new IAMClient({ region: ctx.config.region, credentials: session.credentials });
    const user = ctx.config.operatorUser;
    let org: Org | null = null;

    const steps: Step[] = [
      {
        id: "organization",
        async check() {
          org = await describeOrg(orgs);
          if (!org) return { needed: true, detail: `Create an organization with ${session.accountId} as its management account.` };
          if (org.managementAccountId !== session.accountId) throw new KitError("not_management_account", `${session.accountId} is a member of organization ${org.id}. Run bootstrap in its management account, ${org.managementAccountId}.`);
          if (org.featureSet !== "ALL") return { needed: true, manual: true, detail: "Enable all features in the AWS Organizations console. Account creation needs them." };
          return { needed: false, detail: `Organization ${org.id}` };
        },
        async apply() {
          const created = await orgs.send(new CreateOrganizationCommand({ FeatureSet: "ALL" }));
          return `Created organization ${created.Organization?.Id}`;
        },
      },
      {
        id: "operator-user",
        async check() {
          const found = await iam.send(new GetUserCommand({ UserName: user })).catch((error: unknown) => (isAwsError(error, "NoSuchEntityException", "NoSuchEntity") ? null : Promise.reject(error)));
          return found ? { needed: false, detail: found.User?.Arn ?? user } : { needed: true, detail: `Create IAM user ${user}.` };
        },
        async apply() {
          const created = await iam.send(new CreateUserCommand({ UserName: user, Tags: [KIT_TAG] }));
          return `Created ${created.User?.Arn}`;
        },
      },
      {
        id: "operator-admin",
        async check() {
          const attached = await iam.send(new ListAttachedUserPoliciesCommand({ UserName: user })).catch((error: unknown) => (isAwsError(error, "NoSuchEntityException", "NoSuchEntity") ? null : Promise.reject(error)));
          const has = attached?.AttachedPolicies?.some((policy) => policy.PolicyArn === ADMIN_POLICY);
          return has ? { needed: false, detail: "AdministratorAccess attached" } : { needed: true, detail: `Attach AdministratorAccess to ${user}.` };
        },
        async apply() {
          await iam.send(new AttachUserPolicyCommand({ UserName: user, PolicyArn: ADMIN_POLICY }));
          return "Attached AdministratorAccess";
        },
      },
      {
        id: "operator-console-sign-in",
        async check() {
          const profileFound = await iam.send(new GetLoginProfileCommand({ UserName: user })).then(() => true, () => false);
          if (!profileFound) return { needed: true, manual: true, detail: `In the IAM console, open user ${user}, Security credentials, and enable console access with a password from your password manager.` };
          const mfa = await iam.send(new ListMFADevicesCommand({ UserName: user })).catch(() => null);
          if (!mfa?.MFADevices?.length) return { needed: true, manual: true, detail: `In the IAM console, add a passkey or MFA device to ${user}.` };
          return { needed: false, detail: "Console sign-in and MFA are on" };
        },
      },
    ];

    const results = await runSteps(steps, { apply: options.yes, log });
    const summary = summarize(results);
    return {
      applied: options.yes,
      rootSession: session.identity.kind === "root",
      account: session.accountId,
      steps: results,
      ...summary,
      next: [
        "Root only, once: in the AWS console, Account, turn on IAM user and role access to Billing information. Costs in aws-kit list need it.",
        `Install AWS CLI 2.32 or later, then sign in as ${user}: aws login --profile ${ctx.config.operatorProfile}`,
        "Check with: aws-kit doctor",
        `Sign root out: aws logout --profile ${profile}. Delete any root access key in the console, Security credentials.`,
      ],
    };
  },
});
