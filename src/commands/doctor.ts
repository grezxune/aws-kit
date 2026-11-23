import { access } from "node:fs/promises";
import { z } from "zod";
import { defineCommand } from "../cli/registry";
import { describeOrg } from "../core/accounts";
import { cdkVersion } from "../core/cdk";
import { configPath } from "../core/config";
import { capture } from "../core/proc";
import { operatorSession, orgClient } from "../core/sessions";

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
  summary: "Check the tools, settings, sign-in, and organization this kit needs, with a fix for each problem.",
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

    try {
      const session = await operatorSession(ctx);
      const { identity } = session;
      checks.push({ id: "sign-in", status: "pass", detail: `${session.profile} is ${identity.arn}` });
      if (identity.kind === "root") checks.push({ id: "root", status: "warn", detail: "The everyday profile signs in as root. Root cannot reach member accounts.", fix: "Run aws-kit bootstrap, then aws login --profile <operatorProfile> as the operator user." });
      if (identity.longLivedKey) checks.push({ id: "long-lived-key", status: "warn", detail: "The profile uses an access key that never expires.", fix: `Sign in with aws login --profile ${session.profile} instead, then delete the key in IAM.` });
      const org = await describeOrg(orgClient(session));
      if (!org) checks.push({ id: "organization", status: "warn", detail: "This account is not in an organization yet.", fix: "aws-kit bootstrap --yes, with the root profile signed in." });
      else if (org.managementAccountId !== identity.accountId) checks.push({ id: "organization", status: "fail", detail: `The profile is in member account ${identity.accountId}. The kit runs from the management account ${org.managementAccountId}.` });
      else if (org.featureSet !== "ALL") checks.push({ id: "organization", status: "warn", detail: `Organization ${org.id} has only consolidated billing.`, fix: "Enable all features in the AWS Organizations console." });
      else checks.push({ id: "organization", status: "pass", detail: `Organization ${org.id}, management account ${org.managementAccountId}` });
    } catch (error) {
      const hint = (error as { hint?: string }).hint;
      checks.push({ id: "sign-in", status: "fail", detail: (error as Error).message, ...(hint ? { fix: hint } : {}) });
    }
    return { healthy: !checks.some((check) => check.status === "fail"), checks };
  },
});
