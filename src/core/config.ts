import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { KitError } from "./errors";

/** Settings for this machine. They live outside every repo, because they name a person's email and AWS profiles. */
export const ConfigSchema = z.object({
  operatorProfile: z.string().min(1).default("aws-kit").describe("AWS profile for everyday work, signed in as the operator user"),
  rootProfile: z.string().min(1).default("aws-kit-root").describe("AWS profile signed in as the root user, used only by bootstrap"),
  operatorUser: z.string().min(1).default("aws-kit-operator").describe("IAM user bootstrap creates in the management account"),
  memberRole: z.string().min(1).default("OrganizationAccountAccessRole").describe("Role the operator assumes in member accounts"),
  region: z.string().min(1).default("us-east-1").describe("Default region for stacks and account setup"),
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
