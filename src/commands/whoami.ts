import { z } from "zod";
import { defineCommand } from "../cli/registry";
import { permissionSetOf } from "../core/credentials";
import { kitSession } from "../core/sessions";

export const whoami = defineCommand({
  name: "whoami",
  summary: "Show who the kit's profile signs in as: account, ARN, permission set, and whether it is root or a long-lived key.",
  options: z.object({}),
  async run(_options, ctx) {
    const session = await kitSession(ctx);
    return { profile: session.profile, ...session.identity, permissionSet: permissionSetOf(session.identity.arn) ?? null };
  },
});
