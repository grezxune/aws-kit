import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { runCdk } from "./cdk";
import { type CfnTemplate, checkTemplate, type Violation } from "./checks";
import { KitError } from "./errors";
import type { LoadedProject, StageTarget } from "./project";
import { classify, type MoveLabel, moveLabelOf, type ResourceKind } from "./resource-classes";

export interface ResourceSummary {
  logicalId: string;
  type: string;
  kind: ResourceKind;
  deletionPolicy: string;
  move: MoveLabel;
}

export interface Synthesized {
  outDir: string;
  template: CfnTemplate;
  templateHash: string;
  tags: Record<string, string>;
  terminationProtection: boolean;
  resources: ResourceSummary[];
  violations: Violation[];
}

interface StackArtifact {
  type: string;
  displayName?: string;
  environment?: string;
  properties?: { templateFile?: string; tags?: Record<string, string>; terminationProtection?: boolean; stackName?: string };
}

export function outDirOf(project: LoadedProject, stage: string): string {
  return join(project.dir, ".aws-kit", "out", stage);
}

/** Runs the project's CDK app for one stage and reads back the stack it made. No AWS calls. */
export async function synth(project: LoadedProject, target: StageTarget): Promise<Synthesized> {
  const outDir = outDirOf(project, target.stage);
  await rm(outDir, { recursive: true, force: true });
  await runCdk(["synth", "--app", project.config.app, "--context", `stage=${target.stage}`, "--output", outDir, "--quiet"], { cwd: project.dir, env: process.env as Record<string, string> });
  const manifest = JSON.parse(await readFile(join(outDir, "manifest.json"), "utf8")) as { artifacts?: Record<string, StackArtifact> };
  const [, artifact] = Object.entries(manifest.artifacts ?? {}).find(([id, value]) => value.type === "aws:cloudformation:stack" && (value.properties?.stackName ?? id) === target.stackName) ?? [];
  if (!artifact?.properties?.templateFile) throw new KitError("stack_not_found", `The app made no stack named ${target.stackName}.`, "Build the stack with projectApp() from aws-kit/cdk, which names it {project}-{stage}.");
  const region = artifact.environment?.split("/").pop();
  if (region && region !== "unknown-region" && region !== target.region) {
    throw new KitError("region_mismatch", `The app put ${target.stackName} in ${region}, but aws-kit.json says ${target.region}.`, "Let projectApp() set the stack's region.");
  }
  const text = await readFile(join(outDir, artifact.properties.templateFile), "utf8");
  const template = JSON.parse(text) as CfnTemplate;
  const tags = artifact.properties.tags ?? {};
  return {
    outDir,
    template,
    templateHash: createHash("sha256").update(text).digest("hex"),
    tags,
    terminationProtection: artifact.properties.terminationProtection ?? false,
    resources: Object.entries(template.Resources ?? {}).map(([logicalId, resource]) => ({
      logicalId,
      type: resource.Type,
      kind: classify(resource.Type).kind,
      deletionPolicy: resource.DeletionPolicy ?? "Delete",
      move: moveLabelOf(resource.Type, resource.Properties),
    })),
    violations: checkTemplate(template, tags),
  };
}

/** Synth, then refuse to go on if any rule failed. */
export async function synthChecked(project: LoadedProject, target: StageTarget): Promise<Synthesized> {
  const result = await synth(project, target);
  if (result.violations.length) {
    throw new KitError("checks_failed", `${result.violations.length} rule${result.violations.length === 1 ? "" : "s"} failed for ${target.stackName}. Nothing was deployed.`, "Fix each violation in the project's CDK code, then run plan again.", result.violations);
  }
  return result;
}
