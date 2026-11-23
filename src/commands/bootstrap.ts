import { CreateOrganizationCommand } from "@aws-sdk/client-organizations";
import { z } from "zod";
import { log } from "../cli/output";
import { defineCommand } from "../cli/registry";
import { describeOrg, type Org } from "../core/accounts";
import { profileSession } from "../core/credentials";
import { KitError } from "../core/errors";
import { guardrailSteps } from "../core/guardrails";
import { accessStep, ADMIN_POLICY, IdentityCenter, permissionSetStep, profilesStep, READ_POLICY } from "../core/identity-center";
import { orgClient } from "../core/sessions";
import { runSteps, type Step, summarize } from "../core/steps";

export const KIT_TAG = { Key: "managed-by", Value: "aws-kit" };

export const bootstrap = defineCommand({
  name: "bootstrap",
  summary: "Run as root: create the organization, the guardrail policy, and the Identity Center permission sets, give you access to the management account, and write your AWS profiles. Rerun after each console step it reports.",
  mutates: true,
  options: z.object({
    yes: z.boolean().default(false).describe("Make the changes. Without it, only report them"),
    profile: z.string().optional().describe("Profile signed in as root. Defaults to the rootProfile setting"),
  }),
  async run(options, ctx) {
    const { config } = ctx;
    const profile = options.profile ?? config.rootProfile;
    const session = await profileSession(profile, config.region);
    const orgs = orgClient(session);
    const idc = new IdentityCenter(session, config);
    const management = { id: session.accountId, name: "management", management: true };
    let org: Org | null = null;

    const steps: Step[] = [
      {
        id: "organization",
        async check() {
          org = await describeOrg(orgs);
          if (!org) return { needed: true, detail: `Create an organization with ${session.accountId} as its management account.` };
          if (org.managementAccountId !== session.accountId) throw new KitError("not_management_account", `${session.accountId} is a member of organization ${org.id}. Run bootstrap in its management account, ${org.managementAccountId}.`);
          if (org.featureSet !== "ALL") return { needed: true, manual: true, detail: "Enable all features in the AWS Organizations console. Account creation and guardrails need them." };
          return { needed: false, detail: `Organization ${org.id}` };
        },
        async apply() {
          const created = await orgs.send(new CreateOrganizationCommand({ FeatureSet: "ALL" }));
          return `Created organization ${created.Organization?.Id}`;
        },
      },
      ...guardrailSteps(orgs, config.memberRole),
      {
        id: "identity-center",
        async check() {
          const instance = await idc.getInstance();
          if (instance) return { needed: false, detail: `Identity Center in ${idc.region}, sign-in at ${instance.startUrl}` };
          return {
            needed: true,
            manual: true,
            detail: `Turn on IAM Identity Center: open the IAM Identity Center console in ${idc.region} and choose Enable, for the organization. AWS allows this only in the console. If you turned it on in another region, set it with aws-kit config set ssoRegion <region>.`,
          };
        },
      },
      {
        id: "identity-center-user",
        async check() {
          if (!(await idc.getInstance())) return { needed: true, manual: true, detail: "Waits for IAM Identity Center to be turned on." };
          const lookup = await idc.getUser();
          return "user" in lookup ? { needed: false, detail: `You sign in as ${lookup.user.name}` } : { needed: true, manual: true, detail: lookup.problem };
        },
      },
      permissionSetStep(idc, config.adminPermissionSet, ADMIN_POLICY),
      permissionSetStep(idc, config.readPermissionSet, READ_POLICY),
      accessStep(idc, management, config.adminPermissionSet, { setMadeEarlier: true }),
      accessStep(idc, management, config.readPermissionSet, { setMadeEarlier: true }),
      profilesStep(idc, async () => [management]),
    ];

    const results = await runSteps(steps, { apply: options.yes, log });
    const summary = summarize(results);
    return {
      applied: options.yes,
      rootSession: session.identity.kind === "root",
      account: session.accountId,
      steps: results,
      ...summary,
      next: summary.pending.length
        ? ["Do each manual step above, then run aws-kit bootstrap again. Steps that would change something need --yes."]
        : [
            "Root only, once: in the AWS console, Account, turn on IAM user and role access to Billing information. Costs in aws-kit list need it.",
            `Sign in through Identity Center: aws sso login --profile ${config.profile}. The first sign-in asks you to register an MFA device.`,
            "Check with: aws-kit doctor",
            `Sign root out: aws logout --profile ${profile}. Delete any root access key in the console, under Security credentials.`,
          ],
    };
  },
});
