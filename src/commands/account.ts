import { z } from "zod";
import { log } from "../cli/output";
import { defineCommand } from "../cli/registry";
import { ACCOUNT_NAME, accountEmailFor, createAccount } from "../core/accounts";
import { regionsOf } from "../core/config";
import { KitError } from "../core/errors";
import { readySteps } from "../core/ready-steps";
import { orgClient, orgView, sessionFor } from "../core/sessions";
import { runSteps, summarize } from "../core/steps";

export const accountList = defineCommand({
  name: "account list",
  summary: "List every account in the organization, with the management account first.",
  options: z.object({}),
  async run(_options, ctx) {
    const view = await orgView(ctx);
    return { organization: view.org, accounts: view.accounts };
  },
});

export const accountCreate = defineCommand({
  name: "account create",
  summary: "Create a member account in the organization. Safe to rerun: an account with the name already there is returned as is.",
  mutates: true,
  options: z.object({
    name: z.string().regex(ACCOUNT_NAME, "lowercase letters, digits, and hyphens, starting with a letter").describe("Account name, such as a project name. Commands and project configs refer to the account by it"),
    email: z.email().optional().describe("Email for the account's root user. Defaults to the accountEmail template"),
    yes: z.boolean().default(false).describe("Create it. Without it, only report what would be created"),
  }),
  async run(options, ctx) {
    const view = await orgView(ctx);
    const existing = view.accounts.find((account) => account.name === options.name);
    if (existing) return { applied: false, changed: false, account: existing, next: [`aws-kit account ready --account ${existing.name} --yes`] };
    const email = options.email ?? accountEmailFor(ctx.config.accountEmail, options.name);
    if (view.accounts.some((account) => account.email.toLowerCase() === email.toLowerCase())) {
      throw new KitError("email_in_use", `${email} already belongs to an account in the organization.`, "Pass a different --email.");
    }
    const plan = { name: options.name, email, role: ctx.config.memberRole };
    if (!options.yes) return { applied: false, changed: false, wouldCreate: plan, next: [`Rerun with --yes to create it. AWS emails ${email}, and closing an account takes 90 days to finish.`] };
    log(`Creating account ${options.name} (${email}). This takes one to five minutes.`);
    const id = await createAccount(orgClient(view.operator), { name: options.name, email, roleName: ctx.config.memberRole, tags: { "managed-by": "aws-kit" } }, { onProgress: (state) => log(`  ${state}`) });
    return { applied: true, changed: true, account: { id, name: options.name, email }, next: [`aws-kit account ready --account ${options.name} --yes`] };
  },
});

export const accountReady = defineCommand({
  name: "account ready",
  summary: "Make an account ready for project stacks: CDK bootstrap, S3 Block Public Access, a monthly budget, an alerts topic, and billing tags. Safe to rerun.",
  mutates: true,
  options: z.object({
    account: z.string().min(1).describe("Account name, 12-digit ID, or management"),
    vercelTeam: z.string().regex(/^[a-z0-9-]+$/).optional().describe("Vercel team slug. Registers its OIDC issuer so Vercel deployments can assume roles in this account without keys"),
    yes: z.boolean().default(false).describe("Make the changes. Without it, only report them"),
  }),
  async run(options, ctx) {
    const view = await orgView(ctx);
    const { session, account } = await sessionFor(view, options.account, ctx.config.region, ctx.config);
    const steps = readySteps({ session, operator: view.operator, config: ctx.config, regions: regionsOf(ctx.config), vercelTeam: options.vercelTeam });
    const results = await runSteps(steps, { apply: options.yes, log });
    return { applied: options.yes, account, steps: results, ...summarize(results) };
  },
});
