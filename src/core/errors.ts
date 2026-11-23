/** An expected failure. The CLI prints its code, message, and hint as JSON and exits 1. */
export class KitError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "KitError";
  }
}

/** The AWS SDK error name, or undefined for anything that is not an SDK error. */
export function awsErrorName(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "name" in error ? String((error as { name: unknown }).name) : undefined;
}

export function isAwsError(error: unknown, ...names: string[]): boolean {
  const name = awsErrorName(error);
  return name !== undefined && names.includes(name);
}
