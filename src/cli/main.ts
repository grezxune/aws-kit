#!/usr/bin/env bun
import packageJson from "../../package.json" with { type: "json" };
import { COMMANDS } from "../commands";
import { ConfigSchema, loadConfig } from "../core/config";
import { KitError } from "../core/errors";
import { describeCommand, parseCommandArgs } from "./args";
import { printError, printResult } from "./output";
import type { CommandDef } from "./registry";

const USAGE = [
  "aws-kit <command> [flags]. Every command prints one JSON document to stdout; progress goes to stderr.",
  "Commands that change AWS or files report what they would do unless --yes is passed.",
  "Deploys need a plan: aws-kit plan, show it to the person, then aws-kit deploy --plan <id> --yes.",
];

/** The command whose words start argv, longest name first, so `account create` wins over a command named `account`. */
export function matchCommand(argv: string[]): { def: CommandDef; rest: string[] } | null {
  const sorted = [...COMMANDS].sort((a, b) => b.name.split(" ").length - a.name.split(" ").length);
  for (const def of sorted) {
    const words = def.name.split(" ");
    if (words.every((word, index) => argv[index] === word)) return { def, rest: argv.slice(words.length) };
  }
  return null;
}

function help(topic: string[]): Record<string, unknown> {
  if (topic.length) {
    const found = matchCommand(topic);
    if (!found) throw new KitError("unknown_command", `No command ${topic.join(" ")}.`, "aws-kit help lists them.");
    return { command: describeCommand(found.def) };
  }
  return { usage: USAGE, version: packageJson.version, globalFlags: [{ flag: "--profile", description: "AWS profile to use instead of the profile setting" }], commands: COMMANDS.map(describeCommand) };
}

export async function main(argv: string[]): Promise<number> {
  try {
    const [first, ...rest] = argv;
    if (!first || first === "help" || first === "--help" || first === "-h") {
      printResult(help(rest));
      return 0;
    }
    if (first === "--version") {
      printResult({ version: packageJson.version });
      return 0;
    }
    const found = matchCommand(argv);
    if (!found) throw new KitError("unknown_command", `No command ${argv.filter((word) => !word.startsWith("-")).slice(0, 2).join(" ")}.`, "aws-kit help lists them.");
    const { options, global, positionals } = parseCommandArgs(found.def, found.rest);
    // The config commands must run even when the settings file is broken, so it can be fixed.
    const config = await loadConfig().catch((error: unknown) => (found.def.name.startsWith("config ") ? ConfigSchema.parse({}) : Promise.reject(error)));
    const result = await found.def.run(options, { config, profile: global.profile, positionals });
    if (found.def.passthrough) return typeof result.exitCode === "number" ? result.exitCode : 0;
    printResult(result);
    return 0;
  } catch (error) {
    printError(error);
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main(Bun.argv.slice(2));
