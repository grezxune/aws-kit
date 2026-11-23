import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "aws-cdk-lib";
import { projectApp } from "../../src/cdk";

/** A project folder with an aws-kit.json, and the stack projectApp builds from it. */
export function testProject(stage: "dev" | "prod", region = "us-east-1") {
  const dir = mkdtempSync(join(tmpdir(), "aws-kit-project-"));
  writeFileSync(join(dir, "aws-kit.json"), JSON.stringify({ project: "demo", region, stages: { dev: { account: "shared" }, prod: { account: "demo" } } }));
  return projectApp({ dir, stage, app: new App() });
}
