# aws-kit

A CLI for agents that creates AWS accounts and deploys any AWS resource for a project. Each project keeps its AWS resources as a small CDK app in its own `infra/` folder. The kit runs that app for one stage at a time, checks it, shows the change, and deploys it into the account the stage names.

- Any AWS service CloudFormation supports works the same way. The kit holds rules that apply to every resource, not one module per service.
- Every resource is tagged with its project and stage. `aws-kit list` shows every stack in every account, with month-to-date cost.
- Nothing deploys without a plan. `plan` creates a CloudFormation change set, and `deploy` runs only that change set.
- Prod data survives a destroy. Outside prod, a destroy deletes everything.
- A stack names its account by name in `aws-kit.json`, so moving a stage to another account is a one-word change.

Every command prints one JSON document to stdout and progress to stderr. `aws-kit help` describes every command and flag as JSON. `skill/SKILL.md` is the guide agents follow. Copy or link the `skill/` folder into your agent's skills folder as `aws-kit`, such as `~/.claude/skills/aws-kit`, so agents in every repo find it.

## How sign-in works

The root user starts everything once, and then steps aside. You sign in every day as yourself through IAM Identity Center.

- `aws-kit bootstrap` runs as root. It creates the organization, the guardrail policy, and two Identity Center permission sets. It gives your Identity Center user both of them in the management account and writes your AWS profiles.
- One `aws sso login --profile aws-kit` signs you in to every account for up to 12 hours. No access key is stored on disk.
- Each account gets two profiles in `~/.aws/config`. `aws-kit-<account>` has `AwsKitAdmin`, and `aws-kit-<account>-read` has `AwsKitReadOnly`. The management account's profiles are `aws-kit` and `aws-kit-read`. Any AWS tool can use them by name.
- The kit's own commands use the admin profile for the management account. In member accounts they assume `OrganizationAccountAccessRole`, which AWS Organizations creates in every new account.
- `aws-kit exec` and the AWS MCP Server use the read-only profiles, so looking around cannot change anything.

AWS does not let the root user assume roles, so root cannot work inside member accounts at all.

## Guardrails

Bootstrap attaches one service control policy, `aws-kit-guardrails`, to the organization root. AWS enforces it in every member account, whoever signs in and whichever tool they use:

- No account can leave the organization.
- A member account's root user can do nothing.
- No one can change or delete `OrganizationAccountAccessRole`.

Service control policies never apply to the management account, so project stacks never deploy there.

## Setup, once

1. Install AWS CLI 2.32 or later. Root signs in with `aws login`, which first shipped in 2.32. The macOS package is at https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html.
2. Install the kit with [Bun](https://bun.sh):
   ```bash
   bun add -g github:grezxune/aws-kit#v0.2.0
   ```
3. Save your settings. Each AWS account needs its own email, and plus addressing gives one inbox many addresses:
   ```bash
   aws-kit config set alertEmail you@example.com
   aws-kit config set accountEmail 'you+aws-{name}@example.com'
   ```
4. Sign in as root in the browser: `aws login --profile aws-kit-root`.
5. Run `aws-kit bootstrap`, read what it reports, then run `aws-kit bootstrap --yes`. It creates the organization and the guardrails, then stops at two console steps:
   - Open the IAM Identity Center console in `us-east-1` and choose Enable.
   - Under Users, add yourself with your email, and choose to send the password setup email. Accept the invite and set a password.
6. Run `aws-kit bootstrap --yes` again. It creates the permission sets, gives you access, and writes your profiles.
7. In the AWS console, still as root, under Account, turn on IAM user and role access to Billing information. `aws-kit list --cost` needs it.
8. Sign in as yourself: `aws sso login --profile aws-kit`. It opens your sign-in portal, the `awsapps.com/start` URL bootstrap prints. Sign in there with your Identity Center username. The usual AWS console sign-in page is for root and IAM users, and it cannot sign you in. The first sign-in sets your password and registers an MFA device. The command waits about 10 minutes, so if it times out first, run it again. Then sign root out with `aws logout --profile aws-kit-root`, and delete any root access key.
9. Run `aws-kit doctor`. Every check should pass.
10. Make a shared account for projects without their own:
    ```bash
    aws-kit account create --name shared --yes
    aws-kit account ready --account shared --yes
    ```

When a command reports `not_signed_in`, run `aws sso login --profile aws-kit` again. On a new machine, set the kit up again from step 2, run `aws configure sso --profile aws-kit` with your sign-in URL, then `aws-kit profiles --yes`.

## With AWS's Agent Toolkit

AWS's Agent Toolkit installs service skills and the AWS MCP Server for coding agents. Both are good sources of current AWS knowledge. The kit stays the one way to change AWS:

- Keep the service skills, such as `aws-cdk`, `aws-iam`, and `aws-storage`, for reference.
- Remove `launch-with-aws` and `signing-in-to-aws`. They deploy and sign in outside the kit: `aws agent-toolkit remove-skill`.
- Start the AWS MCP Server with read-only profiles. The first one is the default, and an agent can switch to the others per call: `--profile aws-kit-read aws-kit-shared-read`. The proxy reads the list at startup, so restart the agent after adding an account.

## Using it in a project

```bash
aws-kit project init --dir infra --project demo --yes   # aws-kit.json, app.ts, package.json
cd infra && bun install && cd ..
aws-kit synth --dir infra --stage dev                   # build and check, no AWS calls
aws-kit plan --dir infra --stage dev                    # create a change set and show it
aws-kit deploy --dir infra --stage dev --plan <id> --yes
aws-kit status --dir infra --stage dev                  # outputs, also named as env vars
aws-kit destroy --dir infra --stage dev                 # report, then --yes
```

`infra/app.ts` is ordinary CDK:

```ts
import { CdnBucket, PrivateBucket, projectApp, VercelOidcRole } from "aws-kit/cdk";

const { stack } = projectApp({ dir: import.meta.dir });
const files = new PrivateBucket(stack, "Files", { corsOrigins: ["https://app.example.com"] });
const photos = new CdnBucket(stack, "Photos");
const app = new VercelOidcRole(stack, "AppRole", { team: "my-team", project: "my-app" });
files.bucket.grantReadWrite(app.role, "uploads/*");
```

`examples/storefront` is a full example: a files bucket, a catalog bucket behind CloudFront, a backup bucket with Object Lock, and one keyless role per Vercel app.

## What every stack gets

| Rule | Where |
|---|---|
| `project`, `stage`, and `managed-by` tags on the stack and every resource | `projectApp` |
| Prod: termination protection, and every resource that may hold data kept or snapshotted on delete. An unclassified type counts as data. | `src/cdk/aspects.ts`, `src/core/resource-classes.ts` |
| Other stages: everything deleted with the stack, and buckets emptied first by `destroy` | same |
| Log groups get 30-day retention. Functions get their own log group, and alarms on errors and throttles. Dead-letter queues get an alarm. Alarms send to the account's `aws-kit-alerts` topic. | `src/cdk/aspects.ts` |
| No literal account ID, no fixed bucket name, no reference to another stack, every queue has a dead-letter queue. A violation stops `plan`. | `src/core/checks.ts` |

`aws-kit account ready` gives each account CDK bootstrap, account-wide S3 Block Public Access, a monthly budget emailing at 50, 80, and 100 percent, the alerts topic with your email subscribed, and active `project` and `stage` cost allocation tags. It also gives your Identity Center user both permission sets in the account and writes its two profiles. It turns on Block Public Access only when no bucket in the account is public today. In the management account the budget covers the whole organization.

## Not built yet

These PRD requirements are open. Each is listed in `prds/aws-kit.md`.

- Monthly cost estimates in `plan` (R6). Plans list each added resource type instead.
- Writing stack outputs into Vercel env vars, and removing them on destroy (R5, R7). `deploy` and `status` print them as env var names.
- Moving a stage to another account (R10), adopting scratch or hand-made resources (R11, R14), and the account-wide prod delete guard (R12).
- A GitHub Actions OIDC role, for jobs such as database backups.

## Development

```bash
bun install
bun run check   # typecheck, lint, and tests. The tests make no AWS calls.
```

To run the CLI from a checkout instead of the installed copy, link it: `ln -sf "$PWD/src/cli/main.ts" ~/.bun/bin/aws-kit`.

Settings live in `~/.config/aws-kit/config.json`, or the path in `AWS_KIT_CONFIG`. `aws-kit config show` lists them.

## License

MIT. See [LICENSE](LICENSE).
