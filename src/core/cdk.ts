import { dirname, join } from "node:path";
import { KitError } from "./errors";
import { capture, stream } from "./proc";

/** The CDK CLI this kit ships with, so every project deploys with the same version. */
export function cdkBin(): string {
  return join(dirname(Bun.resolveSync("aws-cdk/package.json", import.meta.dir)), "bin", "cdk");
}

export async function cdkVersion(): Promise<string> {
  const result = await capture("node", [cdkBin(), "--version"]);
  return result.stdout.trim().split(" ")[0] ?? "";
}

/** Runs the CDK CLI. Its output goes to stderr. Throws when it fails. */
export async function runCdk(args: string[], options: { cwd: string; env: Record<string, string> }): Promise<void> {
  const env = { ...options.env, CDK_DISABLE_VERSION_CHECK: "true", CDK_DISABLE_CLI_TELEMETRY: "true" };
  const code = await stream("node", [cdkBin(), ...args, "--no-notices", "--ci"], { cwd: options.cwd, env });
  if (code !== 0) throw new KitError("cdk_failed", `cdk ${args[0]} exited with code ${code}.`, "The CDK output above, on stderr, says why.");
}
