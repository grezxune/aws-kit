import { z } from "zod";
import { defineCommand } from "../cli/registry";
import { configPath, ConfigSchema, readRawConfig, setConfigValue } from "../core/config";
import { KitError } from "../core/errors";

export const configShow = defineCommand({
  name: "config show",
  summary: "Show this machine's settings, with defaults filled in, and where they are stored.",
  options: z.object({}),
  async run(_options, ctx) {
    const settings = z.toJSONSchema(ConfigSchema, { io: "input" }) as { properties: Record<string, { description?: string }> };
    return {
      path: configPath(),
      config: ctx.config,
      setInFile: Object.keys(await readRawConfig()),
      settings: Object.fromEntries(Object.entries(settings.properties).map(([key, value]) => [key, value.description ?? ""])),
    };
  },
});

export const configSet = defineCommand({
  name: "config set",
  summary: "Save one setting. Lists take commas: aws-kit config set regions us-east-1,us-west-2.",
  positionals: "<key> <value>",
  options: z.object({}),
  async run(_options, ctx) {
    const [key, value] = ctx.positionals;
    if (!key || value === undefined) throw new KitError("bad_args", "Pass a key and a value.", "aws-kit config set alertEmail you@example.com");
    return { path: configPath(), config: await setConfigValue(key, value) };
  },
});
