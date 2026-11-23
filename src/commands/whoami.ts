import { z } from "zod";
import { defineCommand } from "../cli/registry";
import { operatorSession } from "../core/sessions";

export const whoami = defineCommand({
  name: "whoami",
  summary: "Show who the operator profile signs in as: account, ARN, and whether it is root or a long-lived key.",
  options: z.object({}),
  async run(_options, ctx) {
    const session = await operatorSession(ctx);
    return { profile: session.profile, ...session.identity };
  },
});
