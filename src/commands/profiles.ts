import { z } from "zod";
import { log } from "../cli/output";
import { defineCommand } from "../cli/registry";
import { profileNames } from "../core/aws-profiles";
import { IdentityCenter, profilesStep } from "../core/identity-center";
import { orgView } from "../core/sessions";
import { runSteps, summarize } from "../core/steps";

export const profilesCommand = defineCommand({
  name: "profiles",
  summary: "Write an admin and a read-only AWS profile for every active account into ~/.aws/config, such as on a new machine. Account ready writes them for one account.",
  mutates: true,
  options: z.object({
    yes: z.boolean().default(false).describe("Write the file. Without it, only report what would change"),
  }),
  async run(options, ctx) {
    const view = await orgView(ctx);
    const accounts = view.accounts.filter((account) => account.status === "ACTIVE");
    const idc = new IdentityCenter(view.management, ctx.config);
    const results = await runSteps([profilesStep(idc, async () => accounts)], { apply: options.yes, log });
    return {
      applied: options.yes,
      profiles: accounts.map((account) => ({ account: account.name, id: account.id, ...profileNames(ctx.config, account) })),
      steps: results,
      ...summarize(results),
      notes: ["A profile works once your Identity Center user has that permission set in the account. aws-kit account ready gives it."],
    };
  },
});
