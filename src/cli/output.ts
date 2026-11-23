import { KitError } from "../core/errors";

/** Progress for people and agents watching. Stdout stays one JSON document. */
export function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

export function printResult(result: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
}

export function errorResult(error: unknown): { ok: false; error: { code: string; message: string; hint?: string; details?: unknown } } {
  if (error instanceof KitError) {
    return { ok: false, error: { code: error.code, message: error.message, ...(error.hint ? { hint: error.hint } : {}), ...(error.details !== undefined ? { details: error.details } : {}) } };
  }
  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, error: { code: name === "Error" ? "unexpected" : `aws:${name}`, message } };
}

export function printError(error: unknown): void {
  process.stdout.write(`${JSON.stringify(errorResult(error), null, 2)}\n`);
}
