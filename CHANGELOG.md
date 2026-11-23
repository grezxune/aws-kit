# Changelog

## Unreleased

## 0.1.0 - 2026-11-23

- First release. A Bun CLI for agents: `bootstrap` turns a root sign-in into an organization and an operator user, `account create` and `account ready` make and prepare member accounts, and `exec` runs any command with short-lived credentials for one account.
- Project stacks: `project init`, `synth`, `plan`, `deploy`, `status`, and `destroy`. Deploy runs only the change set a plan created, while the code still builds the same template.
- `list` shows every project stack across accounts and regions, resources tagged with a project that sit in no stack, and month-to-date cost.
- `aws-kit/cdk`: `projectApp` with tags, prod protection, log retention, and alarms on every stack, plus `PrivateBucket`, `CdnBucket`, and `VercelOidcRole`.
- `examples/storefront`: a shop's S3 and CloudFront setup, synthesized by the tests.
- Public under the MIT license. New project infra apps install the kit from GitHub over HTTPS.
