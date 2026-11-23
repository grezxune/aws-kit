import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { KitError } from "./errors";

export const PROJECT_FILE = "aws-kit.json";
export const PROD_STAGE = "prod";
/** The retention periods CloudWatch Logs accepts. */
export const LOG_RETENTION_DAYS = [1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653];
const SLUG = /^[a-z][a-z0-9-]{0,38}[a-z0-9]$/;
const STAGE = /^[a-z][a-z0-9-]{0,19}$/;

/**
 * A project's infra config, committed in its `infra/` folder. A stage names
 * the account it deploys to by account name, never by ID, so moving a stage to
 * another account is a one-word change.
 */
export const ProjectConfigSchema = z.object({
  project: z.string().regex(SLUG, "lowercase letters, digits, and hyphens"),
  region: z.string().min(1).default("us-east-1"),
  app: z.string().min(1).default("bun app.ts"),
  logRetentionDays: z
    .number()
    .int()
    .refine((days) => LOG_RETENTION_DAYS.includes(days), `one of ${[1, 3, 5, 7, 14, 30, 60, 90, 180, 365].join(", ")}, or another value CloudWatch Logs accepts`)
    .default(30),
  stages: z
    .record(z.string().regex(STAGE, "lowercase letters, digits, and hyphens"), z.object({ account: z.string().min(1), region: z.string().min(1).optional() }))
    .refine((stages) => Object.keys(stages).length > 0, "needs at least one stage"),
});

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export interface StageTarget {
  stage: string;
  stackName: string;
  account: string;
  region: string;
  prod: boolean;
}

export interface LoadedProject {
  dir: string;
  config: ProjectConfig;
}

export function stackNameOf(project: string, stage: string): string {
  return `${project}-${stage}`;
}

export function readProjectConfigSync(dir: string): ProjectConfig {
  const path = join(dir, PROJECT_FILE);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new KitError("no_project", `No ${PROJECT_FILE} in ${dir}.`, "Point --dir at a project's infra folder, or make one with aws-kit project init.");
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new KitError("project_invalid", `${path} is not valid JSON.`);
  }
  const parsed = ProjectConfigSchema.safeParse(json);
  if (!parsed.success) throw new KitError("project_invalid", `${path}: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export function loadProject(dir: string): LoadedProject {
  const absolute = resolve(dir);
  return { dir: absolute, config: readProjectConfigSync(absolute) };
}

export function stageTarget(config: ProjectConfig, stage: string): StageTarget {
  const found = config.stages[stage];
  if (!found) throw new KitError("unknown_stage", `${config.project} has no stage ${stage}.`, `Stages: ${Object.keys(config.stages).join(", ")}. Add one to ${PROJECT_FILE}.`);
  return { stage, stackName: stackNameOf(config.project, stage), account: found.account, region: found.region ?? config.region, prod: stage === PROD_STAGE };
}
