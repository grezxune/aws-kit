import type { CommandDef } from "../cli/registry";
import { accountCreate, accountList, accountReady } from "./account";
import { bootstrap } from "./bootstrap";
import { configSet, configShow } from "./config";
import { doctor } from "./doctor";
import { exec } from "./exec";
import { listCommand } from "./list";
import { projectInit } from "./project-init";
import { destroyCommand } from "./stage-destroy";
import { deployCommand, statusCommand } from "./stage-deploy";
import { planCommand, synthCommand } from "./stage-plan";
import { whoami } from "./whoami";

/** Every command, in the order help lists them: setup, accounts, projects, then reads. */
export const COMMANDS = [
  doctor, whoami, configShow, configSet, bootstrap,
  accountList, accountCreate, accountReady, exec,
  projectInit, synthCommand, planCommand, deployCommand, statusCommand, destroyCommand,
  listCommand,
] as unknown as CommandDef[];
