import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { KitError } from "./errors";

/** Settings for this machine. They live outside every repo, because they name a person's email and AWS profiles. */
export const ConfigSchema = z.object({
  profile: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/, "lowercase letters, digits, and hyphens")
    .default("aws-kit")
    .describe("Identity Center profile for the management account, with the admin permission set. Each other account gets <profile>-<account>, and every account gets a -read profile too"),
  rootProfile: z.string().min(1).default("aws-kit-root").describe("AWS profile signed in as the root user, used only by bootstrap"),
  memberRole: z.string().min(1).default("OrganizationAccountAccessRole").describe("Role the kit assumes in member accounts"),
  region: z.string().min(1).default("us-east-1").describe("Default region for stacks and account setup"),
  ssoRegion: z.string().min(1).optional().describe("Region where IAM Identity Center is turned on. Defaults to region"),
  ssoStartUrl: z.url().optional().describe("Identity Center sign-in URL. Defaults to the one AWS assigned, https://<identity store ID>.awsapps.com/start"),
  ssoUser: z.string().min(1).optional().describe("Your Identity Center user name. Needed only when the identity store has more than one user"),
  adminPermissionSet: z.string().min(1).default("AwsKitAdmin").describe("Permission set with AdministratorAccess. The kit's own commands use it"),
  readPermissionSet: z.string().min(1).default("AwsKitReadOnly").describe("Permission set with ReadOnlyAccess. exec and the AWS MCP Server use it"),
  regions: z.array(z.string().min(1)).optional().describe("Regions that list and ready cover. Defaults to region alone"),
  alertEmail: z.email().optional().describe("Address for budget and alarm email"),
  accountEmail: z
    .string()
    .regex(/\{name\}/, "must contain {name}")
    .optional()
    .describe("Email template for new accounts, such as owner+aws-{name}@example.com"),
  budgetUsd: z.number().positive().default(100).describe("Monthly budget per account, in US dollars"),
});

export type Config = z.infer<typeof ConfigSchema>;
export type ConfigKey = keyof Config;

export function configPath(): string {
  return process.env.AWS_KIT_CONFIG ?? join(homedir(), ".config", "aws-kit", "config.json");
}

export async function readRawConfig(): Promise<Record<string, unknown>> {
  const text = await readFile(configPath(), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "{}";
    throw error;
  });
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new KitError("config_invalid", `${configPath()} is not valid JSON.`);
  }
}

export async function loadConfig(): Promise<Config> {
  const parsed = ConfigSchema.safeParse(await readRawConfig());
  if (!parsed.success) throw new KitError("config_invalid", `${configPath()}: ${z.prettifyError(parsed.error)}`, "Fix it with aws-kit config set <key> <value>.");
  return parsed.data;
}

/** Turns the text of `config set` into the value the schema expects, then saves. */
export async function setConfigValue(key: string, text: string): Promise<Config> {
  const shape = ConfigSchema.shape as Record<string, z.ZodType>;
  if (!(key in shape)) throw new KitError("config_unknown_key", `No setting named ${key}.`, `Settings: ${Object.keys(shape).join(", ")}.`);
  const raw = await readRawConfig();
  const value = key === "budgetUsd" ? Number(text) : key === "regions" ? text.split(",").map((part) => part.trim()).filter(Boolean) : text;
  const next = { ...raw, [key]: value };
  const parsed = ConfigSchema.safeParse(next);
  if (!parsed.success) throw new KitError("config_invalid_value", z.prettifyError(parsed.error));
  await mkdir(dirname(configPath()), { recursive: true });
  await writeFile(configPath(), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return parsed.data;
}

export function regionsOf(config: Config): string[] {
  return config.regions?.length ? config.regions : [config.region];
}

export function ssoRegionOf(config: Config): string {
  return config.ssoRegion ?? config.region;
}
