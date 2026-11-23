import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { KitError } from "./errors";
import type { LoadedProject } from "./project";

/** What plan saw and showed. Deploy runs only this, and only while the code still synthesizes to the same template (R6). */
export const PlanRecordSchema = z.object({
  id: z.string(),
  project: z.string(),
  stage: z.string(),
  stackName: z.string(),
  accountName: z.string(),
  accountId: z.string(),
  region: z.string(),
  changeSetName: z.string(),
  templateHash: z.string(),
  prod: z.boolean(),
  terminationProtection: z.boolean(),
  createdAt: z.string(),
});

export type PlanRecord = z.infer<typeof PlanRecordSchema>;

/** A plan older than this is refused, so a deploy never runs a diff nobody looked at today. */
export const PLAN_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export function newPlanId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return `p${stamp}${randomBytes(2).toString("hex")}`;
}

const planPath = (project: LoadedProject, id: string) => join(project.dir, ".aws-kit", "plans", `${id}.json`);

export async function savePlan(project: LoadedProject, record: PlanRecord): Promise<void> {
  await mkdir(join(project.dir, ".aws-kit", "plans"), { recursive: true });
  await writeFile(planPath(project, record.id), `${JSON.stringify(record, null, 2)}\n`);
}

export async function loadPlan(project: LoadedProject, id: string, now = Date.now()): Promise<PlanRecord> {
  if (!/^p\d{14}[0-9a-f]{4}$/.test(id)) throw new KitError("bad_plan", `${id} is not a plan ID.`);
  const text = await readFile(planPath(project, id), "utf8").catch(() => {
    throw new KitError("plan_not_found", `No plan ${id} in ${project.dir}.`, "Run aws-kit plan first.");
  });
  const record = PlanRecordSchema.parse(JSON.parse(text));
  if (now - Date.parse(record.createdAt) > PLAN_MAX_AGE_MS) throw new KitError("plan_expired", `Plan ${id} is more than 12 hours old.`, "Run aws-kit plan again and review the new diff.");
  return record;
}

export async function deletePlan(project: LoadedProject, id: string): Promise<void> {
  await rm(planPath(project, id), { force: true });
}
