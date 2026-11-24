import {
  AttachPolicyCommand,
  CreatePolicyCommand,
  DescribePolicyCommand,
  EnablePolicyTypeCommand,
  ListRootsCommand,
  type OrganizationsClient,
  paginateListPolicies,
  paginateListPoliciesForTarget,
  type Root,
  UpdatePolicyCommand,
} from "@aws-sdk/client-organizations";
import { isAwsError, KitError } from "./errors";
import type { Step } from "./steps";

export const GUARDRAIL_POLICY = "aws-kit-guardrails";
const SCP = "SERVICE_CONTROL_POLICY";

/**
 * The service control policy at the organization root. AWS applies it to every
 * member account, whoever signs in and whichever tool they use. It never
 * applies to the management account.
 */
export function guardrailDocument(memberRole: string) {
  return {
    Version: "2012-10-17",
    Statement: [
      { Sid: "StayInTheOrganization", Effect: "Deny", Action: "organizations:LeaveOrganization", Resource: "*" },
      { Sid: "NoMemberRootUser", Effect: "Deny", Action: "*", Resource: "*", Condition: { StringLike: { "aws:PrincipalArn": "arn:aws:iam::*:root" } } },
      {
        Sid: "ProtectTheAccessRole",
        Effect: "Deny",
        Action: [
          "iam:AttachRolePolicy", "iam:DeleteRole", "iam:DeleteRolePermissionsBoundary", "iam:DeleteRolePolicy", "iam:DetachRolePolicy",
          "iam:PutRolePermissionsBoundary", "iam:PutRolePolicy", "iam:UpdateAssumeRolePolicy", "iam:UpdateRole", "iam:UpdateRoleDescription",
        ],
        Resource: `arn:aws:iam::*:role/${memberRole}`,
      },
    ],
  };
}

export const GUARDRAIL_SUMMARY = `Member accounts cannot leave the organization, their root users can do nothing, and no one can change the role the kit signs in through.`;

const noOrg = (error: unknown) => isAwsError(error, "AWSOrganizationsNotInUseException");

async function orgRoot(orgs: OrganizationsClient): Promise<Root | null> {
  try {
    return (await orgs.send(new ListRootsCommand({}))).Roots?.[0] ?? null;
  } catch (error) {
    if (noOrg(error)) return null;
    throw error;
  }
}

async function findPolicy(orgs: OrganizationsClient): Promise<string | null> {
  try {
    for await (const page of paginateListPolicies({ client: orgs }, { Filter: SCP })) {
      const found = page.Policies?.find((policy) => policy.Name === GUARDRAIL_POLICY);
      if (found?.Id) return found.Id;
    }
    return null;
  } catch (error) {
    if (noOrg(error)) return null;
    throw error;
  }
}

const scpOn = (root: Root | null) => Boolean(root?.PolicyTypes?.some((type) => type.Type === SCP && type.Status === "ENABLED"));

/** Steps that turn on service control policies, create or update the kit's policy, and attach it to the organization root. */
export function guardrailSteps(orgs: OrganizationsClient, memberRole: string, options: { pollMs?: number } = {}): Step[] {
  const document = guardrailDocument(memberRole);
  const content = JSON.stringify(document);
  let policyId: string | null = null;
  return [
    {
      id: "scp-enabled",
      async check() {
        const root = await orgRoot(orgs);
        if (scpOn(root)) return { needed: false, detail: "Service control policies are on" };
        if (root?.PolicyTypes?.some((type) => type.Type === SCP && type.Status === "PENDING_ENABLE")) return { needed: true, manual: true, detail: "AWS is still turning on service control policies. Run this command again in a minute." };
        return { needed: true, detail: "Turn on service control policies for the organization." };
      },
      async apply() {
        const root = await orgRoot(orgs);
        await orgs.send(new EnablePolicyTypeCommand({ RootId: root?.Id, PolicyType: SCP }));
        // AWS turns the policy type on in the background. Attaching a policy before it finishes fails.
        for (let attempt = 0; attempt < 60; attempt++) {
          if (scpOn(await orgRoot(orgs))) return "Turned on service control policies";
          await Bun.sleep(options.pollMs ?? 2000);
        }
        throw new KitError("scp_pending", "AWS has not finished turning on service control policies.", "Run this command again in a few minutes.");
      },
    },
    {
      id: "guardrail-policy",
      async check() {
        policyId = await findPolicy(orgs);
        if (!policyId) return { needed: true, detail: `Create service control policy ${GUARDRAIL_POLICY}. ${GUARDRAIL_SUMMARY}` };
        const described = await orgs.send(new DescribePolicyCommand({ PolicyId: policyId }));
        const current = described.Policy?.Content ? JSON.stringify(JSON.parse(described.Policy.Content)) : "";
        return current === content ? { needed: false, detail: `${GUARDRAIL_POLICY} is current` } : { needed: true, detail: `Update ${GUARDRAIL_POLICY} to the kit's current rules. ${GUARDRAIL_SUMMARY}` };
      },
      async apply() {
        if (policyId) {
          await orgs.send(new UpdatePolicyCommand({ PolicyId: policyId, Content: content }));
          return `Updated ${GUARDRAIL_POLICY}`;
        }
        const created = await orgs.send(new CreatePolicyCommand({ Name: GUARDRAIL_POLICY, Type: SCP, Content: content, Description: "aws-kit guardrails for every member account", Tags: [{ Key: "managed-by", Value: "aws-kit" }] }));
        policyId = created.Policy?.PolicySummary?.Id ?? null;
        return `Created ${GUARDRAIL_POLICY}`;
      },
    },
    {
      id: "guardrail-attached",
      async check() {
        const root = await orgRoot(orgs);
        const id = policyId ?? (await findPolicy(orgs));
        if (root?.Id && id) {
          for await (const page of paginateListPoliciesForTarget({ client: orgs }, { TargetId: root.Id, Filter: SCP })) {
            if (page.Policies?.some((policy) => policy.Id === id)) return { needed: false, detail: `${GUARDRAIL_POLICY} is attached to the organization root` };
          }
        }
        return { needed: true, detail: `Attach ${GUARDRAIL_POLICY} to the organization root, so every member account gets it.` };
      },
      async apply() {
        const root = await orgRoot(orgs);
        const id = policyId ?? (await findPolicy(orgs));
        await orgs.send(new AttachPolicyCommand({ PolicyId: id ?? undefined, TargetId: root?.Id }));
        return `Attached ${GUARDRAIL_POLICY} to the organization root`;
      },
    },
  ];
}

/** True when the kit's policy is attached to the organization root and matches the kit's rules. For doctor. */
export async function guardrailsInPlace(orgs: OrganizationsClient, memberRole: string): Promise<boolean> {
  for (const step of guardrailSteps(orgs, memberRole)) if ((await step.check()).needed) return false;
  return true;
}
