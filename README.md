# aws-kit

A CLI for agents that creates AWS accounts and deploys any AWS resource for a project. Each project keeps its AWS resources as a small CDK app in its own `infra/` folder. The kit runs that app for one stage at a time, checks it, shows the change, and deploys it into the account the stage names.

- Any AWS service CloudFormation supports works the same way. The kit holds rules that apply to every resource, not one module per service.
- Every resource is tagged with its project and stage. `aws-kit list` shows every stack in every account, with month-to-date cost.
- Nothing deploys without a plan. `plan` creates a CloudFormation change set, and `deploy` runs only that change set.
- Prod data survives a destroy. Outside prod, a destroy deletes everything.
- A stack names its account by name in `aws-kit.json`, so moving a stage to another account is a one-word change.

Every command prints one JSON document to stdout and progress to stderr. `aws-kit help` describes every command and flag as JSON. `skill/SKILL.md` is the guide agents follow. Copy or link the `skill/` folder into your agent's skills folder as `aws-kit`, such as `~/.claude/skills/aws-kit`, so agents in every repo find it.

## How sign-in works

The root user starts everything once, and then steps aside.

AWS lets the root user create an organization, but not assume roles, so root cannot work inside the accounts the organization creates. `aws-kit bootstrap` runs as root once. It creates the organization and an operator IAM user with administrator access. Every other command signs in as the operator with `aws login`, which keeps short-lived credentials and no access key on disk. In each member account the operator assumes `OrganizationAccountAccessRole`, the role AWS Organizations creates there.

## Setup, once

1. Install AWS CLI 2.32 or later. `aws login` first shipped in 2.32. The macOS package is at https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html.
2. Install the kit with [Bun](https://bun.sh):
   ```bash
   bun add -g github:grezxune/aws-kit#v0.1.0
   ```
3. Save your settings. Each AWS account needs its own email, and plus addressing gives one inbox many addresses:
   ```bash
   aws-kit config set alertEmail you@example.com
   aws-kit config set accountEmail 'you+aws-{name}@example.com'
   ```
4. Sign in as root in the browser: `aws login --profile aws-kit-root`.
5. Run `aws-kit bootstrap`, read what it reports, then run `aws-kit bootstrap --yes`.
6. In the AWS console, signed in as root:
   - Under IAM, Users, `aws-kit-operator`, enable console access with a password from your password manager, and add a passkey or MFA device.
   - Under Account, turn on IAM user and role access to Billing information. `aws-kit list --cost` needs it.
7. Sign in as the operator: `aws login --profile aws-kit`. Then sign root out with `aws logout --profile aws-kit-root`, and delete any root access key.
8. Run `aws-kit doctor`. Every check should pass.
9. Make a shared account for projects without their own:
   ```bash
   aws-kit account create --name shared --yes
   aws-kit account ready --account shared --yes
   ```

`aws login` sessions last up to 12 hours. When a command reports `not_signed_in`, run `aws login --profile aws-kit` again.

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

`aws-kit account ready` gives each account CDK bootstrap, account-wide S3 Block Public Access, a monthly budget emailing at 50, 80, and 100 percent, the alerts topic with your email subscribed, and active `project` and `stage` cost allocation tags. It turns on Block Public Access only when no bucket in the account is public today. In the management account the budget covers the whole organization.

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
