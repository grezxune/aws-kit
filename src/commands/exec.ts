import { z } from "zod";
import { defineCommand } from "../cli/registry";
import { childEnv } from "../core/credentials";
import { KitError } from "../core/errors";
import { stream } from "../core/proc";
import { orgView, readSessionFor, sessionFor } from "../core/sessions";

export const exec = defineCommand({
  name: "exec",
  summary: "Run any command, such as the AWS CLI, with short-lived credentials for one account. They are read-only unless --write is passed. Prints the command's own output and exits with its code.",
  positionals: "-- <command> [args...]",
  passthrough: true,
  options: z.object({
    account: z.string().min(1).describe("Account name, 12-digit ID, or management"),
    region: z.string().optional().describe("Region. Defaults to the region setting"),
    write: z.boolean().default(false).describe("Use admin credentials instead of read-only ones. Only after the person says yes, and tag what you create with project=<name> and stage=scratch"),
  }),
  async run(options, ctx) {
    const [command, ...args] = ctx.positionals;
    if (!command) throw new KitError("bad_args", "Pass the command after --.", "aws-kit exec --account shop -- aws s3 ls");
    const view = await orgView(ctx);
    const region = options.region ?? ctx.config.region;
    const { session, account } = options.write ? await sessionFor(view, options.account, region, ctx.config) : await readSessionFor(view, options.account, region, ctx.config);
    const env = await childEnv(session, { AWS_KIT_ACCOUNT: account.name, AWS_KIT_ACCOUNT_ID: account.id, AWS_KIT_ACCESS: options.write ? "write" : "read" });
    return { exitCode: await stream(command, args, { env, inheritStdout: true }) };
  },
});
