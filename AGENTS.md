# aws-kit

A local CLI that agents run to create AWS accounts and provision any AWS resource for a project, plus the CDK library each project's infra app builds on. One developer runs it from a laptop, and agents in other repos call it.

## Stack
- Bun and TypeScript. The CLI runs from source: `src/cli/main.ts`.
- AWS SDK for JavaScript v3 for organization, account, and readiness work.
- AWS CDK v2: `aws-cdk-lib` for the library in `src/cdk`, and the `aws-cdk` CLI for synth, change sets, and bootstrap.
- zod for every input: flags, `aws-kit.json`, and the machine config.

## Project notes
- The PRD is `prds/aws-kit.md`. Reference its requirement IDs in commits.
- Identity: root runs `bootstrap`, which creates the organization, the guardrail policy, and the Identity Center permission sets, and writes the AWS profiles. AWS does not let root assume roles, so every other command signs in through Identity Center (`aws sso login --profile aws-kit`) with the admin permission set and assumes `OrganizationAccountAccessRole` in member accounts.
- Agents read by default: `exec` and each account's `-read` profile use the read-only permission set. Changes go through the kit's commands.
- Guardrails AWS enforces live in one service control policy, `src/core/guardrails.ts`. Change it there, and bootstrap updates the attached policy.
- The kit owns one managed block in `~/.aws/config` (`src/core/aws-profiles.ts`). It never edits a section the person wrote outside that block.
- The CLI contract: stdout is one JSON document, `{ ok: true, ... }` or `{ ok: false, error: { code, message, hint } }`. Progress and child process output go to stderr. `exec` is the one passthrough.
- A command that changes AWS or files sets `mutates` and only reports until it gets `--yes`.
- `plan` creates a CloudFormation change set and a plan record holding the template hash. `deploy` runs only that change set, and only while the code still synthesizes to that hash (R6).
- Project configs name accounts, never account IDs, so a stage moves by changing one word (R9).
- The kit stays service-agnostic. Rules every stack passes live in `src/core/checks.ts` (template) and `src/cdk/aspects.ts` (constructs). How a type behaves on destroy and move is a table row in `src/core/resource-classes.ts`. A recipe in `src/cdk/recipes` needs the pattern written by hand in two projects first.
- Machine config lives in `~/.config/aws-kit/config.json`, or the path in `AWS_KIT_CONFIG`, because it names emails and profiles.
- Tests mock AWS with `aws-sdk-client-mock` and point the SDK at throwaway profile files (`test/support/aws-env.ts`). The suite makes no AWS calls.
- `examples/storefront` is the S3 and CloudFront acceptance test. `bun test` synthesizes it through the CLI.

## Code
- Never use `@ts-nocheck`. Fix the types.
- Target 200 lines per file. Exceed it when splitting would hurt cohesion, and say why.
- Import everything explicitly.
- After every change, run `bun run check`: typecheck, lint, and tests.
- A new command is one `defineCommand` in `src/commands`, listed in `src/commands/index.ts`. Write its summary and flag descriptions for an agent reading `aws-kit help`.

## Security
- This repo is public. Keep secrets, keys, account IDs, emails, client and private project names, and machine-specific paths out of every file, examples and tests included. Real values come from the environment or the machine config.
- Pipe secret values from AWS straight to their destination, so they never reach stdout or a log.
- Deny by default: prod treats an unclassified resource type as stateful, and a stack missing its tags fails the checks.
- Validate untrusted input at every boundary: flags, `aws-kit.json`, the config file, and AWS responses that drive a decision.
- Log errors with enough context to debug and no secret values.
- Keep `bootstrap`, `account create`, `deploy`, and `destroy` out of agent allowlists, so each run prompts the person.

## Git
- Conventional Commits: `feat:`, `fix:`, `chore:`, `refactor:`.
- Branch as `feature/{name}`. Squash before merging.
- Update `CHANGELOG.md` for meaningful changes.
- Tag each release `vX.Y.Z`. Project infra apps pin the kit by tag.

## Docs
- PRDs: before building a feature, read its PRD in `prds/`. The template is in `prds/README.md`.
- Agent skill: `skill/SKILL.md` is what agents in other repos follow. Change it in the same commit as any change to the command flow.
- Writing: plain prose in docs, PR descriptions, and CLI messages. No em dashes, no puffery, no filler. Say what a thing does.
