import type { z } from "zod";
import type { KitContext } from "../core/sessions";

export interface CommandContext extends KitContext {
  /** Words that are not flags, and everything after `--`. */
  positionals: string[];
}

export interface CommandDef<S extends z.ZodObject = z.ZodObject> {
  /** One or two words, such as `account create`. */
  name: string;
  summary: string;
  /** Changes AWS or files. Without --yes the command only reports what it would do. */
  mutates?: boolean;
  /** What the positional words mean, for help. */
  positionals?: string;
  /** The command writes its own output instead of one JSON document (exec). */
  passthrough?: boolean;
  options: S;
  run(options: z.infer<S>, ctx: CommandContext): Promise<Record<string, unknown>>;
}

export function defineCommand<S extends z.ZodObject>(def: CommandDef<S>): CommandDef<S> {
  return def;
}
