import { z } from "zod";
import { defineCommand } from "../cli/registry";
import { childEnv } from "../core/credentials";
import { KitError } from "../core/errors";
import { stream } from "../core/proc";
import { accountSession } from "../core/sessions";

export const exec = defineCommand({
  name: "exec",
  summary: "Run any command with short-lived credentials for one account, such as the AWS CLI. Prints the command's own output and exits with its code.",
  positionals: "-- <command> [args...]",
  passthrough: true,
  options: z.object({
    account: z.string().min(1).describe("Account name, 12-digit ID, or management"),
    region: z.string().optional().describe("Region. Defaults to the region setting"),
  }),
  async run(options, ctx) {
    const [command, ...args] = ctx.positionals;
    if (!command) throw new KitError("bad_args", "Pass the command after --.", "aws-kit exec --account shop -- aws s3 ls");
    const { session, account } = await accountSession(ctx, options.account, options.region ?? ctx.config.region);
    const env = await childEnv(session, { AWS_KIT_ACCOUNT: account.name, AWS_KIT_ACCOUNT_ID: account.id });
    return { exitCode: await stream(command, args, { env, inheritStdout: true }) };
  },
});
