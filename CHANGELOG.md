# Changelog

## 0.2.0 - 2026-11-23

- Sign-in moves to IAM Identity Center. `bootstrap` creates the `AwsKitAdmin` and `AwsKitReadOnly` permission sets, gives you both in the management account, and writes your AWS profiles. It no longer creates the operator IAM user. One `aws sso login --profile aws-kit` covers every account.
- `bootstrap` attaches the `aws-kit-guardrails` service control policy to the organization root. Member accounts cannot leave the organization, their root users can do nothing, and no one can change `OrganizationAccountAccessRole`.
- `account ready` gives you both permission sets in the account and writes `aws-kit-<account>` and `aws-kit-<account>-read` to `~/.aws/config`. The new `profiles` command writes them for every account.
- `exec` is read-only unless `--write` is passed.
- `doctor` checks the permission set behind the kit's profile, the guardrails, and access keys stored in `~/.aws/credentials`.
- Settings: `operatorProfile` and `operatorUser` are gone. New settings: `profile`, `ssoRegion`, `ssoStartUrl`, `ssoUser`, `adminPermissionSet`, and `readPermissionSet`.
- New account names cannot be `management`, `read`, or `root`, because profile names use them.
- When `bootstrap` finishes, its sign-in steps name your portal URL and username, and say to retry `aws sso login` if the first sign-in outlasts it.

## 0.1.0 - 2026-11-23

- First release. A Bun CLI for agents: `bootstrap` turns a root sign-in into an organization and an operator user, `account create` and `account ready` make and prepare member accounts, and `exec` runs any command with short-lived credentials for one account.
- Project stacks: `project init`, `synth`, `plan`, `deploy`, `status`, and `destroy`. Deploy runs only the change set a plan created, while the code still builds the same template.
- `list` shows every project stack across accounts and regions, resources tagged with a project that sit in no stack, and month-to-date cost.
- `aws-kit/cdk`: `projectApp` with tags, prod protection, log retention, and alarms on every stack, plus `PrivateBucket`, `CdnBucket`, and `VercelOidcRole`.
- `examples/storefront`: a shop's S3 and CloudFront setup, synthesized by the tests.
- Public under the MIT license. New project infra apps install the kit from GitHub over HTTPS.
