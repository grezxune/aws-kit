import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { IdentitystoreClient, ListUsersCommand } from "@aws-sdk/client-identitystore";
import { DescribeOrganizationCommand, DescribePolicyCommand, ListPoliciesCommand, ListPoliciesForTargetCommand, ListRootsCommand, OrganizationsClient } from "@aws-sdk/client-organizations";
import { DescribePermissionSetCommand, ListAccountAssignmentsCommand, ListInstancesCommand, ListPermissionSetsCommand, SSOAdminClient } from "@aws-sdk/client-sso-admin";
import { ConfigSchema } from "../../src/core/config";
import { permissionSetOf, type Session, signInError } from "../../src/core/credentials";
import type { KitError } from "../../src/core/errors";
import { GUARDRAIL_POLICY, guardrailDocument, guardrailSteps } from "../../src/core/guardrails";
import { accessStep, IdentityCenter } from "../../src/core/identity-center";
import { readSessionFor } from "../../src/core/sessions";
import { mockClient } from "aws-sdk-client-mock";
import { fakeAwsEnv } from "../support/aws-env";

const sso = mockClient(SSOAdminClient);
const store = mockClient(IdentitystoreClient);
const orgs = mockClient(OrganizationsClient);
const user = (UserId: string, UserName: string) => ({ UserId, UserName, IdentityStoreId: "d-1", UserArn: `arn:aws:identitystore::111111111111:user/${UserId}`, Revision: "1" });
afterEach(() => [sso, store, orgs].forEach((mock) => mock.reset()));

const session: Session = { accountId: "111111111111", region: "us-east-1", credentials: async () => ({ accessKeyId: "a", secretAccessKey: "b" }), identity: { accountId: "111111111111", arn: "x", kind: "role", longLivedKey: false } };
const shop = { id: "222222222222", name: "shop", management: false };
const instanceOn = () => sso.on(ListInstancesCommand).resolves({ Instances: [{ InstanceArn: "arn:aws:sso:::instance/ssoins-1", IdentityStoreId: "d-1", Status: "ACTIVE" }] });

describe("accessStep", () => {
  test("in account ready, a missing permission set points at bootstrap", async () => {
    instanceOn();
    store.on(ListUsersCommand).resolves({ Users: [user("u-1", "me")] });
    sso.on(ListPermissionSetsCommand).resolves({ PermissionSets: [] });
    const check = await accessStep(new IdentityCenter(session, ConfigSchema.parse({})), shop, "AwsKitAdmin", { setMadeEarlier: false }).check();
    expect(check).toMatchObject({ needed: true, manual: true });
    expect(check.detail).toContain("bootstrap");
  });

  test("with two users and no ssoUser setting, asks which one is yours", async () => {
    instanceOn();
    store.on(ListUsersCommand).resolves({ Users: [user("u-1", "me"), user("u-2", "you")] });
    const check = await accessStep(new IdentityCenter(session, ConfigSchema.parse({})), shop, "AwsKitAdmin", { setMadeEarlier: false }).check();
    expect(check).toMatchObject({ needed: true, manual: true });
    expect(check.detail).toContain("ssoUser");
  });

  test("finds the user named in ssoUser and sees an existing assignment", async () => {
    instanceOn();
    store.on(ListUsersCommand).resolves({ Users: [user("u-1", "Me@Example.com"), user("u-2", "you")] });
    sso.on(ListPermissionSetsCommand).resolves({ PermissionSets: ["arn:ps-admin"] });
    sso.on(DescribePermissionSetCommand).resolves({ PermissionSet: { Name: "AwsKitAdmin" } });
    sso.on(ListAccountAssignmentsCommand).resolves({ AccountAssignments: [{ PrincipalType: "USER", PrincipalId: "u-1" }] });
    const config = ConfigSchema.parse({ ssoUser: "me@example.com" });
    const check = await accessStep(new IdentityCenter(session, config), shop, "AwsKitAdmin", { setMadeEarlier: false }).check();
    expect(check).toEqual({ needed: false, detail: "Me@Example.com has AwsKitAdmin in shop" });
  });
});

describe("guardrails", () => {
  test("the policy denies leaving, member root, and changes to the access role", () => {
    const document = guardrailDocument("OrganizationAccountAccessRole");
    expect(document.Statement.map((statement) => statement.Sid)).toEqual(["StayInTheOrganization", "NoMemberRootUser", "ProtectTheAccessRole"]);
    expect(document.Statement.every((statement) => statement.Effect === "Deny")).toBe(true);
    expect(document.Statement[2]?.Resource).toBe("arn:aws:iam::*:role/OrganizationAccountAccessRole");
    expect(JSON.stringify(document).length).toBeLessThan(5120);
  });

  test("an attached policy with older content is reported for update", async () => {
    orgs.on(DescribeOrganizationCommand).resolves({ Organization: { Id: "o-1" } });
    orgs.on(ListRootsCommand).resolves({ Roots: [{ Id: "r-1", PolicyTypes: [{ Type: "SERVICE_CONTROL_POLICY", Status: "ENABLED" }] }] });
    orgs.on(ListPoliciesCommand).resolves({ Policies: [{ Id: "p-1", Name: GUARDRAIL_POLICY }] });
    orgs.on(DescribePolicyCommand).resolves({ Policy: { Content: JSON.stringify({ Version: "2012-10-17", Statement: [] }) } });
    orgs.on(ListPoliciesForTargetCommand).resolves({ Policies: [{ Id: "p-1" }] });
    const checks = await Promise.all(guardrailSteps(new OrganizationsClient({ region: "us-east-1" }), "OrganizationAccountAccessRole").map((step) => step.check()));
    expect(checks.map((check) => check.needed)).toEqual([false, true, false]);
    expect(checks[1]?.detail).toContain("Update");
  });
});

describe("read-only sessions", () => {
  let env: ReturnType<typeof fakeAwsEnv>;
  beforeAll(() => (env = fakeAwsEnv(["aws-kit"])));
  afterAll(() => env.restore());

  test("a missing -read profile says which command writes it", async () => {
    const view = { management: session, org: { id: "o-1", managementAccountId: "111111111111", featureSet: "ALL" }, accounts: [{ ...shop, email: "x@example.com", status: "ACTIVE" }] };
    const failure = await readSessionFor(view, "shop", "us-east-1", ConfigSchema.parse({})).catch((error: KitError) => error);
    expect((failure as KitError).code).toBe("not_signed_in");
    expect((failure as KitError).message).toContain("aws-kit-shop-read");
    expect((failure as KitError).hint).toContain("aws-kit account ready --account shop --yes");
  });

  test("permissionSetOf reads the permission set from an Identity Center role ARN", () => {
    expect(permissionSetOf("arn:aws:sts::111111111111:assumed-role/AWSReservedSSO_AwsKitAdmin_0123456789abcdef/me")).toBe("AwsKitAdmin");
    expect(permissionSetOf("arn:aws:iam::111111111111:user/someone")).toBeUndefined();
  });
});

test("a wrapped no-access error from Identity Center reads as no_access, and an expired session as not_signed_in", async () => {
  const wrapped = Object.assign(new Error("ForbiddenException: No access"), { name: "CredentialsProviderError" });
  expect((await signInError(wrapped, "aws-kit-shop"))?.code).toBe("no_access");
  const expired = Object.assign(new Error("The SSO session associated with this profile has expired."), { name: "CredentialsProviderError" });
  expect((await signInError(expired, "aws-kit-shop"))?.code).toBe("not_signed_in");
  expect(await signInError(new Error("boom"), "aws-kit-shop")).toBeUndefined();
});
