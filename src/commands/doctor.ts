import { access } from "node:fs/promises";
import { loadSharedConfigFiles } from "@smithy/shared-ini-file-loader";
import { z } from "zod";
import { defineCommand } from "../cli/registry";
import { describeOrg } from "../core/accounts";
import { cdkVersion } from "../core/cdk";
import { configPath } from "../core/config";
import { permissionSetOf } from "../core/credentials";
import { GUARDRAIL_POLICY, guardrailsInPlace } from "../core/guardrails";
import { capture } from "../core/proc";
import { kitSession, orgClient } from "../core/sessions";

interface Check {
  id: string;
  status: "pass" | "warn" | "fail";
  detail: string;
  fix?: string;
}

const LOGIN_MIN = [2, 32, 0];

export function versionAtLeast(version: string, minimum: number[]): boolean {
  const parts = version.split(".").map(Number);
  for (let index = 0; index < minimum.length; index++) {
    const have = parts[index] ?? 0;
    const want = minimum[index] ?? 0;
    if (have !== want) return have > want;
  }
  return true;
}

export const doctor = defineCommand({
  name: "doctor",
  summary: "Check the tools, settings, sign-in, organization, and guardrails this kit needs, with a fix for each problem.",
  options: z.object({}),
  async run(_options, ctx) {
    const checks: Check[] = [];
    const aws = await capture("aws", ["--version"]);
    const awsVersion = /aws-cli\/(\d+\.\d+\.\d+)/.exec(aws.stdout + aws.stderr)?.[1];
    if (!awsVersion) checks.push({ id: "aws-cli", status: "warn", detail: "The AWS CLI is not installed.", fix: "Install AWS CLI v2: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html" });
    else if (!versionAtLeast(awsVersion, LOGIN_MIN)) checks.push({ id: "aws-cli", status: "warn", detail: `AWS CLI ${awsVersion} has no aws login command, which needs 2.32.0.`, fix: "Install the latest AWS CLI v2 package: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html" });
    else checks.push({ id: "aws-cli", status: "pass", detail: `AWS CLI ${awsVersion}` });

    const node = await capture("node", ["--version"]);
    checks.push(node.code === 0 ? { id: "node", status: "pass", detail: `Node ${node.stdout.trim()}` } : { id: "node", status: "fail", detail: "Node is not installed. The CDK CLI runs on Node.", fix: "Install Node 22 or later." });
    checks.push({ id: "cdk", status: "pass", detail: `CDK CLI ${await cdkVersion()}` });

    const hasConfig = await access(configPath()).then(() => true, () => false);
    checks.push(hasConfig ? { id: "config", status: "pass", detail: configPath() } : { id: "config", status: "warn", detail: `No settings file at ${configPath()}. Defaults apply.`, fix: "aws-kit config set alertEmail you@example.com" });
    if (!ctx.config.alertEmail) checks.push({ id: "alert-email", status: "warn", detail: "No alert address, so account ready cannot set up budget or alarm email.", fix: "aws-kit config set alertEmail you@example.com" });
    if (!ctx.config.accountEmail) checks.push({ id: "account-email", status: "warn", detail: "No email template, so account create needs --email every time.", fix: "aws-kit config set accountEmail 'you+aws-{name}@example.com'" });

    const { credentialsFile } = await loadSharedConfigFiles();
    const storedKeys = Object.entries(credentialsFile).filter(([, values]) => values.aws_access_key_id?.startsWith("AKIA")).map(([name]) => name);
    if (storedKeys.length) checks.push({ id: "stored-keys", status: "warn", detail: `~/.aws/credentials holds an access key that never expires, in ${storedKeys.join(", ")}.`, fix: "Check when each key was last used in IAM, delete it there, then remove it from the file." });

    try {
      const session = await kitSession(ctx);
      const { identity } = session;
      const permissionSet = permissionSetOf(identity.arn);
      checks.push({ id: "sign-in", status: "pass", detail: `${session.profile} is ${identity.arn}` });
      if (identity.kind === "root") checks.push({ id: "root", status: "warn", detail: "The kit's profile signs in as root. Root cannot reach member accounts.", fix: `Run aws-kit bootstrap --yes as root, then aws sso login --profile ${ctx.config.profile}.` });
      else if (permissionSet !== ctx.config.adminPermissionSet) checks.push({ id: "identity-center", status: "warn", detail: `The kit's profile is not the ${ctx.config.adminPermissionSet} permission set through Identity Center.`, fix: `Run aws-kit bootstrap --yes as root, then aws sso login --profile ${ctx.config.profile}.` });
      if (identity.longLivedKey) checks.push({ id: "long-lived-key", status: "warn", detail: "The kit's profile uses an access key that never expires.", fix: `Run aws-kit bootstrap --yes as root, then aws sso login --profile ${ctx.config.profile}.` });
      const orgs = orgClient(session);
      const org = await describeOrg(orgs);
      if (!org) checks.push({ id: "organization", status: "warn", detail: "This account is not in an organization yet.", fix: "aws-kit bootstrap --yes, with the root profile signed in." });
      else if (org.managementAccountId !== identity.accountId) checks.push({ id: "organization", status: "fail", detail: `The profile is in member account ${identity.accountId}. The kit runs from the management account ${org.managementAccountId}.` });
      else if (org.featureSet !== "ALL") checks.push({ id: "organization", status: "warn", detail: `Organization ${org.id} has only consolidated billing.`, fix: "Enable all features in the AWS Organizations console." });
      else {
        checks.push({ id: "organization", status: "pass", detail: `Organization ${org.id}, management account ${org.managementAccountId}` });
        const guarded = await guardrailsInPlace(orgs, ctx.config.memberRole);
        checks.push(guarded ? { id: "guardrails", status: "pass", detail: `${GUARDRAIL_POLICY} is attached to the organization root` } : { id: "guardrails", status: "warn", detail: `${GUARDRAIL_POLICY} is missing, out of date, or not attached.`, fix: "aws-kit bootstrap --yes, with the root profile signed in." });
      }
    } catch (error) {
      const hint = (error as { hint?: string }).hint;
      checks.push({ id: "sign-in", status: "fail", detail: (error as Error).message, ...(hint ? { fix: hint } : {}) });
    }
    return { healthy: !checks.some((check) => check.status === "fail"), checks };
  },
});
