/**
 * An idempotent piece of setup. `check` only reads. `apply` makes the change
 * and is called only when check says it is needed and the caller passed --yes.
 * A manual step is something a person has to do, such as clicking a link AWS
 * emailed; the runner reports it and never applies it.
 */
export interface Step {
  id: string;
  check(): Promise<StepCheck>;
  apply?(): Promise<string | undefined>;
}

export interface StepCheck {
  needed: boolean;
  detail: string;
  manual?: boolean;
}

export type StepAction = "none" | "would-change" | "changed" | "manual" | "failed";

export interface StepResult {
  id: string;
  action: StepAction;
  detail: string;
}

export async function runSteps(steps: Step[], options: { apply: boolean; log?: (line: string) => void }): Promise<StepResult[]> {
  const results: StepResult[] = [];
  for (const step of steps) {
    const result = await runStep(step, options.apply);
    options.log?.(`${step.id}: ${result.action}${result.detail ? `, ${result.detail}` : ""}`);
    results.push(result);
    if (result.action === "failed") break;
  }
  return results;
}

async function runStep(step: Step, apply: boolean): Promise<StepResult> {
  try {
    const check = await step.check();
    if (!check.needed) return { id: step.id, action: "none", detail: check.detail };
    if (check.manual || !step.apply) return { id: step.id, action: "manual", detail: check.detail };
    if (!apply) return { id: step.id, action: "would-change", detail: check.detail };
    const detail = await step.apply();
    return { id: step.id, action: "changed", detail: detail ?? check.detail };
  } catch (error) {
    return { id: step.id, action: "failed", detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
}

export function summarize(results: StepResult[]): { changed: boolean; pending: string[]; failed: string[] } {
  return {
    changed: results.some((result) => result.action === "changed"),
    pending: results.filter((result) => result.action === "would-change" || result.action === "manual").map((result) => result.id),
    failed: results.filter((result) => result.action === "failed").map((result) => result.id),
  };
}
