import { access, mkdir, writeFile } from "node:fs/promises";
import { CURRENTLY_RECOMMENDED_FLAGS } from "aws-cdk-lib/cx-api";
import { join, resolve } from "node:path";
import { z } from "zod";
import packageJson from "../../package.json" with { type: "json" };
import { defineCommand } from "../cli/registry";
import { PROJECT_FILE } from "../core/project";

const REPO = "github:grezxune/aws-kit";

export function scaffold(project: string, account: string, stages: string[]): Record<string, string> {
  const config = { project, region: "us-east-1", stages: Object.fromEntries(stages.map((stage) => [stage, { account }])) };
  return {
    [PROJECT_FILE]: `${JSON.stringify(config, null, 2)}\n`,
    "app.ts": [
      `import { projectApp } from "aws-kit/cdk";`,
      ``,
      `// One stack per stage, named ${project}-{stage}, in the account aws-kit.json names.`,
      `// Add any AWS resource with ordinary CDK constructs, or a recipe from aws-kit/cdk:`,
      `//   new CdnBucket(stack, "Assets");`,
      `// Deploy with: aws-kit plan --dir infra --stage <stage>, then aws-kit deploy with the plan ID.`,
      `export const { stack } = projectApp({ dir: import.meta.dir });`,
      ``,
    ].join("\n"),
    "package.json": `${JSON.stringify(
      {
        name: `${project}-infra`,
        private: true,
        type: "module",
        scripts: { typecheck: "tsc --noEmit" },
        dependencies: {
          "aws-cdk-lib": packageJson.devDependencies["aws-cdk-lib"],
          constructs: packageJson.devDependencies.constructs,
          "aws-kit": `${REPO}#v${packageJson.version}`,
        },
        devDependencies: { "@types/bun": packageJson.devDependencies["@types/bun"], typescript: packageJson.devDependencies.typescript },
      },
      null,
      2,
    )}\n`,
    // The CDK feature flags recommended today, written once so a later CDK upgrade cannot flip them under a deployed stack.
    "cdk.json": `${JSON.stringify({ context: CURRENTLY_RECOMMENDED_FLAGS }, null, 2)}\n`,
    "tsconfig.json": `${JSON.stringify({ compilerOptions: { target: "ES2023", module: "ESNext", moduleResolution: "bundler", strict: true, skipLibCheck: true, noEmit: true, types: ["bun"] }, include: ["**/*.ts"] }, null, 2)}\n`,
    ".gitignore": ".aws-kit/\ncdk.out/\nnode_modules/\n",
    "README.md": [
      `# ${project} infra`,
      ``,
      `AWS resources for ${project}, as a CDK app run by [aws-kit](https://github.com/grezxune/aws-kit).`,
      ``,
      `- \`aws-kit synth --dir infra --stage <stage>\` builds the stack and checks it, with no AWS calls.`,
      `- \`aws-kit plan --dir infra --stage <stage>\` shows what would change.`,
      `- \`aws-kit deploy --dir infra --stage <stage> --plan <id> --yes\` runs that plan.`,
      `- \`aws-kit status --dir infra --stage <stage>\` shows the stack's outputs.`,
      ``,
    ].join("\n"),
  };
}

export const projectInit = defineCommand({
  name: "project init",
  summary: "Add an infra folder to a project: aws-kit.json, a CDK app, and its package.json. Never overwrites a file.",
  mutates: true,
  options: z.object({
    dir: z.string().default("infra").describe("Folder to create, usually infra inside the project repo"),
    project: z.string().regex(/^[a-z][a-z0-9-]{0,38}[a-z0-9]$/).describe("Project name. Tags every resource and names each stack {project}-{stage}"),
    account: z.string().optional().describe("Account every stage starts in. Defaults to the project name"),
    stage: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,19}$/)).optional().describe("Stage names, repeatable. Defaults to dev and prod"),
    yes: z.boolean().default(false).describe("Write the files. Without it, only list them"),
  }),
  async run(options) {
    const dir = resolve(options.dir);
    const files = scaffold(options.project, options.account ?? options.project, options.stage?.length ? options.stage : ["dev", "prod"]);
    const exists = async (name: string) => access(join(dir, name)).then(() => true, () => false);
    const plan = await Promise.all(Object.keys(files).map(async (name) => ({ file: name, action: (await exists(name)) ? "skip, exists" : "create" })));
    if (!options.yes) return { applied: false, dir, files: plan, next: ["Rerun with --yes to write them."] };
    await mkdir(dir, { recursive: true });
    for (const entry of plan) if (entry.action === "create") await writeFile(join(dir, entry.file), files[entry.file] ?? "");
    return {
      applied: true,
      dir,
      files: plan,
      next: [`cd ${options.dir} && bun install`, `aws-kit synth --dir ${options.dir} --stage ${options.stage?.[0] ?? "dev"}`],
    };
  },
});
