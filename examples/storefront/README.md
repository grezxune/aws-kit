# Storefront example

Storage for a shop with a storefront site and an admin site on Vercel, written as a project infra app: one private files bucket with a folder per use, a product photo bucket served only through CloudFront, a backup bucket with Object Lock, and a role per Vercel app limited to its folders.

```bash
aws-kit synth --dir examples/storefront --stage prod
```

Before a real deploy:

- Set `VERCEL_TEAM` and the Vercel project names in `app.ts`.
- Run `aws-kit account create --name shop --yes` and `aws-kit account ready --account shop --vercel-team <team> --yes`.
- The apps take credentials from `awsCredentialsProvider({ roleArn })` in `@vercel/functions/oidc`, with the role ARN from the stack outputs. They need no access key.
- A backup job that runs in GitHub Actions needs a GitHub OIDC role, which the kit does not make yet.
- A custom photo domain goes in `domainNames` on the catalog bucket. The certificate validates through DNS.
