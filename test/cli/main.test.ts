import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import packageJson from "../../package.json" with { type: "json" };
import { matchCommand } from "../../src/cli/main";
import { versionAtLeast } from "../../src/commands/doctor";
import { scaffold } from "../../src/commands/project-init";
import { loadPlan, newPlanId, PLAN_MAX_AGE_MS, savePlan } from "../../src/core/plans";
import { envNameOf } from "../../src/core/stacks";

const ROOT = join(import.meta.dir, "..", "..");

async function cli(...args: string[]): Promise<{ code: number; json: Record<string, unknown>; stderr: string }> {
  const env = { ...process.env, AWS_KIT_CONFIG: join(mkdtempSync(join(tmpdir(), "aws-kit-cli-")), "kit.json") };
  const child = Bun.spawn(["bun", join(ROOT, "src/cli/main.ts"), ...args], { cwd: ROOT, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, json: JSON.parse(stdout) as Record<string, unknown>, stderr };
}

describe("the CLI contract", () => {
  test("help lists every command with its flags, as JSON", async () => {
    const { code, json } = await cli("help");
    expect(code).toBe(0);
    const names = (json.commands as { name: string; mutates: boolean }[]).map((command) => command.name);
    expect(names).toEqual(expect.arrayContaining(["bootstrap", "account create", "account ready", "exec", "plan", "deploy", "destroy", "list"]));
    const deploy = (json.commands as { name: string; mutates: boolean; options: { flag: string; required: boolean }[] }[]).find((command) => command.name === "deploy");
    expect(deploy?.mutates).toBe(true);
    expect(deploy?.options).toContainEqual(expect.objectContaining({ flag: "--plan", required: true }));
  });

  test("an unknown command fails with a code, a hint, and exit 1", async () => {
    const { code, json } = await cli("launch", "rockets");
    expect(code).toBe(1);
    expect(json).toMatchObject({ ok: false, error: { code: "unknown_command" } });
  });

  test("an unknown flag fails as bad_args", async () => {
    const { json } = await cli("account", "list", "--everything");
    expect(json).toMatchObject({ ok: false, error: { code: "bad_args" } });
  });

  test("project init lists files, writes them with --yes, and never overwrites", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "aws-kit-init-")), "infra");
    const preview = await cli("project", "init", "--dir", dir, "--project", "demo");
    expect(preview.json.applied).toBe(false);
    const written = await cli("project", "init", "--dir", dir, "--project", "demo", "--stage", "prod", "--yes");
    expect(written.json.applied).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "aws-kit.json"), "utf8"))).toEqual({ project: "demo", region: "us-east-1", stages: { prod: { account: "demo" } } });
    const again = await cli("project", "init", "--dir", dir, "--project", "demo", "--yes");
    expect((again.json.files as { action: string }[]).every((file) => file.action === "skip, exists")).toBe(true);
  });

  test(
    "synth builds the storefront example and it passes every rule",
    async () => {
      const { code, json } = await cli("synth", "--dir", "examples/storefront", "--stage", "prod");
      expect(code).toBe(0);
      expect(json.passed).toBe(true);
      const types = (json.resources as { type: string }[]).map((resource) => resource.type);
      expect(types).toEqual(expect.arrayContaining(["AWS::S3::Bucket", "AWS::CloudFront::Distribution", "AWS::CloudFront::OriginAccessControl", "AWS::IAM::Role"]));
    },
    { timeout: 120_000 },
  );
});

describe("helpers", () => {
  test("matchCommand prefers the longest name", () => {
    expect(matchCommand(["account", "create", "--name", "x"])?.def.name).toBe("account create");
    expect(matchCommand(["account"])).toBeNull();
  });

  test("versionAtLeast compares each part as a number", () => {
    expect(versionAtLeast("2.32.0", [2, 32, 0])).toBe(true);
    expect(versionAtLeast("2.100.1", [2, 32, 0])).toBe(true);
    expect(versionAtLeast("2.17.42", [2, 32, 0])).toBe(false);
  });

  test("envNameOf turns output keys into env var names", () => {
    expect(envNameOf("CatalogBucketName")).toBe("CATALOG_BUCKET_NAME");
    expect(envNameOf("ShopRoleArn")).toBe("SHOP_ROLE_ARN");
    expect(envNameOf("PhotosUrl")).toBe("PHOTOS_URL");
  });

  test("project init pins the kit to this version over SSH", () => {
    const files = scaffold("demo", "demo", ["dev"]);
    expect(JSON.parse(files["package.json"] ?? "{}").dependencies["aws-kit"]).toBe(`github:grezxune/aws-kit#v${packageJson.version}`);
    expect(files[".gitignore"]).toContain(".aws-kit/");
  });

  test("a plan older than 12 hours is refused", async () => {
    const project = { dir: mkdtempSync(join(tmpdir(), "aws-kit-plan-")), config: { project: "demo", region: "us-east-1", app: "bun app.ts", logRetentionDays: 30, stages: { dev: { account: "x" } } } };
    const id = newPlanId(new Date("2026-11-22T10:00:00Z"));
    expect(id).toMatch(/^p20261122100000[0-9a-f]{4}$/);
    await savePlan(project, { id, project: "demo", stage: "dev", stackName: "demo-dev", accountName: "x", accountId: "1", region: "us-east-1", changeSetName: `aws-kit-${id}`, templateHash: "h", prod: false, terminationProtection: false, createdAt: "2026-11-22T10:00:00.000Z" });
    const created = Date.parse("2026-11-22T10:00:00Z");
    expect((await loadPlan(project, id, created + 60_000)).templateHash).toBe("h");
    expect(loadPlan(project, id, created + PLAN_MAX_AGE_MS + 1)).rejects.toMatchObject({ code: "plan_expired" });
  });
});
