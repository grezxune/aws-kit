import { App, Aspects, Tags } from "aws-cdk-lib";
import { KitError } from "../core/errors";
import { type ProjectConfig, readProjectConfigSync, stageTarget } from "../core/project";
import { KitAspect } from "./aspects";
import { ProjectStack } from "./project-stack";

export interface ProjectAppOptions {
  /** Folder holding aws-kit.json. Defaults to the working directory, which is where aws-kit runs the app. */
  dir?: string;
  /** Stage to build. Defaults to the `stage` context value aws-kit passes. */
  stage?: string;
  app?: App;
}

export interface ProjectApp {
  app: App;
  stack: ProjectStack;
  config: ProjectConfig;
  stage: string;
  prod: boolean;
}

/**
 * The entry point of every project's infra app. Builds the one stack for the
 * stage aws-kit asked for, tagged with project, stage, and managed-by, with the
 * kit's prod protection, log retention, and alarms applied to every resource.
 */
export function projectApp(options: ProjectAppOptions = {}): ProjectApp {
  const config = readProjectConfigSync(options.dir ?? process.cwd());
  const app = options.app ?? new App();
  const stage = options.stage ?? (app.node.tryGetContext("stage") as string | undefined);
  if (!stage) throw new KitError("no_stage", "No stage given.", `aws-kit passes --context stage=<name>. Stages: ${Object.keys(config.stages).join(", ")}.`);
  const target = stageTarget(config, stage);
  const tags = { project: config.project, stage, "managed-by": "aws-kit" };
  // Stack tags go in props as well as through Tags.of: with the explicitStackTags flag on, Tags.of reaches only resources.
  const stack = new ProjectStack(app, target.stackName, {
    stackName: target.stackName,
    tags,
    env: { region: target.region },
    project: config.project,
    stage,
    logRetentionDays: config.logRetentionDays,
    description: `${config.project} ${stage}, managed by aws-kit`,
  });
  for (const [key, value] of Object.entries(tags)) Tags.of(stack).add(key, value);
  Aspects.of(stack).add(new KitAspect(stack));
  return { app, stack, config, stage, prod: stack.prod };
}
