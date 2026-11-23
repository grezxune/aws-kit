import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IdentitystoreClient, ListUsersCommand } from "@aws-sdk/client-identitystore";
import {
  AttachPolicyCommand,
  CreateAccountCommand,
  CreateOrganizationCommand,
  CreatePolicyCommand,
  DescribeCreateAccountStatusCommand,
  DescribeOrganizationCommand,
  EnablePolicyTypeCommand,
  ListAccountsCommand,
  ListPoliciesCommand,
  ListPoliciesForTargetCommand,
  ListRootsCommand,
  OrganizationsClient,
} from "@aws-sdk/client-organizations";
import {
  AttachManagedPolicyToPermissionSetCommand,
  CreateAccountAssignmentCommand,
  CreatePermissionSetCommand,
  DescribeAccountAssignmentCreationStatusCommand,
  ListAccountAssignmentsCommand,
  ListInstancesCommand,
  ListPermissionSetsCommand,
  SSOAdminClient,
} from "@aws-sdk/client-sso-admin";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { mockClient } from "aws-sdk-client-mock";
import { accountCreate } from "../../src/commands/account";
import { bootstrap } from "../../src/commands/bootstrap";
import { ConfigSchema } from "../../src/core/config";
import { assumedSession } from "../../src/core/credentials";
import type { KitError } from "../../src/core/errors";
import { guardrailDocument } from "../../src/core/guardrails";
import { fakeAwsEnv } from "../support/aws-env";

const sts = mockClient(STSClient);
const orgs = mockClient(OrganizationsClient);
const sso = mockClient(SSOAdminClient);
const store = mockClient(IdentitystoreClient);
let env: ReturnType<typeof fakeAwsEnv>;
const notInUse = () => Object.assign(new Error("no org"), { name: "AWSOrganizationsNotInUseException" });
const config = ConfigSchema.parse({ accountEmail: "me+aws-{name}@example.com" });

beforeAll(() => (env = fakeAwsEnv(["aws-kit-root", "aws-kit"])));
afterAll(() => env.restore());
const user = (UserId: string, UserName: string) => ({ UserId, UserName, IdentityStoreId: "d-1234567890", UserArn: `arn:aws:identitystore::111111111111:user/${UserId}`, Revision: "1" });
afterEach(() => {
  [sts, orgs, sso, store].forEach((mock) => mock.reset());
  writeFileSync(join(env.dir, "config"), "");
});

describe("bootstrap", () => {
  const asRoot = () => sts.on(GetCallerIdentityCommand).resolves({ Account: "111111111111", Arn: "arn:aws:iam::111111111111:root" });
  const steps = (result: Record<string, unknown>) => (result.steps as { id: string; action: string }[]).map((step) => `${step.id}:${step.action}`);

  test("from a standalone account, reports what it would create and the console steps, and changes nothing", async () => {
    asRoot();
    orgs.on(DescribeOrganizationCommand).rejects(notInUse());
    orgs.on(ListRootsCommand).rejects(notInUse());
    orgs.on(ListPoliciesCommand).rejects(notInUse());
    sso.on(ListInstancesCommand).resolves({ Instances: [] });
    const result = await bootstrap.run({ yes: false }, { config, positionals: [] });
    expect(result.rootSession).toBe(true);
    expect(steps(result)).toEqual([
      "organization:would-change",
      "scp-enabled:would-change",
      "guardrail-policy:would-change",
      "guardrail-attached:would-change",
      "identity-center:manual",
      "identity-center-user:manual",
      "permission-set:AwsKitAdmin:manual",
      "permission-set:AwsKitReadOnly:manual",
      "access:AwsKitAdmin:manual",
      "access:AwsKitReadOnly:manual",
      "aws-profiles:manual",
    ]);
    expect(orgs.commandCalls(CreateOrganizationCommand)).toHaveLength(0);
    expect(orgs.commandCalls(CreatePolicyCommand)).toHaveLength(0);
    expect(readFileSync(join(env.dir, "config"), "utf8")).toBe("");
  });

  test("with --yes and Identity Center on, sets up guardrails, permission sets, access, and profiles", async () => {
    asRoot();
    orgs.on(DescribeOrganizationCommand).resolves({ Organization: { Id: "o-abc", MasterAccountId: "111111111111", FeatureSet: "ALL" } });
    orgs.on(ListRootsCommand)
      .resolvesOnce({ Roots: [{ Id: "r-1", PolicyTypes: [] }] })
      .resolves({ Roots: [{ Id: "r-1", PolicyTypes: [{ Type: "SERVICE_CONTROL_POLICY", Status: "ENABLED" }] }] });
    orgs.on(ListPoliciesCommand).resolves({ Policies: [] });
    orgs.on(CreatePolicyCommand).resolves({ Policy: { PolicySummary: { Id: "p-1" } } });
    orgs.on(ListPoliciesForTargetCommand).resolves({ Policies: [] });
    sso.on(ListInstancesCommand).resolves({ Instances: [{ InstanceArn: "arn:aws:sso:::instance/ssoins-1", IdentityStoreId: "d-1234567890", Status: "ACTIVE" }] });
    sso.on(ListPermissionSetsCommand).resolves({ PermissionSets: [] });
    sso.on(CreatePermissionSetCommand).callsFake((input: { Name: string }) => ({ PermissionSet: { PermissionSetArn: `arn:aws:sso:::permissionSet/ssoins-1/${input.Name}` } }));
    sso.on(ListAccountAssignmentsCommand).resolves({ AccountAssignments: [] });
    sso.on(CreateAccountAssignmentCommand).resolves({ AccountAssignmentCreationStatus: { RequestId: "req-1" } });
    sso.on(DescribeAccountAssignmentCreationStatusCommand).resolves({ AccountAssignmentCreationStatus: { Status: "SUCCEEDED" } });
    store.on(ListUsersCommand).resolves({ Users: [user("u-1", "me")] });

    const result = await bootstrap.run({ yes: true }, { config, positionals: [] });
    expect(result.failed).toEqual([]);
    expect(result.pending).toEqual([]);
    expect(orgs.commandCalls(EnablePolicyTypeCommand)[0]?.args[0].input).toEqual({ RootId: "r-1", PolicyType: "SERVICE_CONTROL_POLICY" });
    expect(JSON.parse(orgs.commandCalls(CreatePolicyCommand)[0]?.args[0].input.Content ?? "")).toEqual(guardrailDocument("OrganizationAccountAccessRole"));
    expect(orgs.commandCalls(AttachPolicyCommand)[0]?.args[0].input).toEqual({ PolicyId: "p-1", TargetId: "r-1" });
    expect(sso.commandCalls(CreatePermissionSetCommand).map((call) => call.args[0].input.Name)).toEqual(["AwsKitAdmin", "AwsKitReadOnly"]);
    expect(sso.commandCalls(AttachManagedPolicyToPermissionSetCommand).map((call) => call.args[0].input.ManagedPolicyArn)).toEqual(["arn:aws:iam::aws:policy/AdministratorAccess", "arn:aws:iam::aws:policy/ReadOnlyAccess"]);
    expect(sso.commandCalls(CreateAccountAssignmentCommand).map((call) => call.args[0].input)).toEqual([
      expect.objectContaining({ TargetId: "111111111111", PrincipalId: "u-1", PermissionSetArn: "arn:aws:sso:::permissionSet/ssoins-1/AwsKitAdmin" }),
      expect.objectContaining({ TargetId: "111111111111", PrincipalId: "u-1", PermissionSetArn: "arn:aws:sso:::permissionSet/ssoins-1/AwsKitReadOnly" }),
    ]);
    const written = readFileSync(join(env.dir, "config"), "utf8");
    expect(written).toContain("[sso-session aws-kit]\nsso_start_url = https://d-1234567890.awsapps.com/start");
    expect(written).toContain("[profile aws-kit]\nsso_session = aws-kit\nsso_account_id = 111111111111\nsso_role_name = AwsKitAdmin");
    expect(written).toContain("[profile aws-kit-read]\nsso_session = aws-kit\nsso_account_id = 111111111111\nsso_role_name = AwsKitReadOnly");
    expect((result.next as string[]).join(" ")).toContain("aws sso login --profile aws-kit");
  });
});

describe("account create", () => {
  const asKit = () => {
    sts.on(GetCallerIdentityCommand).resolves({ Account: "111111111111", Arn: "arn:aws:sts::111111111111:assumed-role/AWSReservedSSO_AwsKitAdmin_0123456789abcdef/me" });
    orgs.on(DescribeOrganizationCommand).resolves({ Organization: { Id: "o-abc", MasterAccountId: "111111111111", FeatureSet: "ALL" } });
    orgs.on(ListAccountsCommand).resolves({ Accounts: [{ Id: "111111111111", Name: "main", Email: "me@example.com", State: "ACTIVE" }] });
  };

  test("without --yes only describes the account", async () => {
    asKit();
    const result = await accountCreate.run({ name: "shop", yes: false }, { config, positionals: [] });
    expect(result.wouldCreate).toEqual({ name: "shop", email: "me+aws-shop@example.com", role: "OrganizationAccountAccessRole" });
    expect(orgs.commandCalls(CreateAccountCommand)).toHaveLength(0);
  });

  test("returns an existing account instead of making a second", async () => {
    asKit();
    orgs.on(ListAccountsCommand).resolves({ Accounts: [{ Id: "222222222222", Name: "shop", Email: "x@example.com", State: "ACTIVE" }] });
    const result = await accountCreate.run({ name: "shop", yes: true }, { config, positionals: [] });
    expect(result.changed).toBe(false);
    expect(orgs.commandCalls(CreateAccountCommand)).toHaveLength(0);
  });

  test("with --yes creates it", async () => {
    asKit();
    orgs.on(CreateAccountCommand).resolves({ CreateAccountStatus: { Id: "car-1" } });
    orgs.on(DescribeCreateAccountStatusCommand).resolves({ CreateAccountStatus: { State: "SUCCEEDED", AccountId: "222222222222" } });
    const result = await accountCreate.run({ name: "shop", yes: true }, { config, positionals: [] });
    expect(result.account).toEqual({ id: "222222222222", name: "shop", email: "me+aws-shop@example.com" });
  });

  test("refuses names that profile names already use", () => {
    expect(accountCreate.options.safeParse({ name: "read" }).success).toBe(false);
    expect(accountCreate.options.safeParse({ name: "root" }).success).toBe(false);
    expect(accountCreate.options.safeParse({ name: "shop" }).success).toBe(true);
  });

  test("refuses a profile outside the management account", async () => {
    sts.on(GetCallerIdentityCommand).resolves({ Account: "999999999999", Arn: "arn:aws:iam::999999999999:user/someone" });
    orgs.on(DescribeOrganizationCommand).resolves({ Organization: { Id: "o-abc", MasterAccountId: "111111111111", FeatureSet: "ALL" } });
    const failure = await accountCreate.run({ name: "shop", yes: false }, { config, positionals: [] }).catch((error: KitError) => error);
    expect((failure as KitError).code).toBe("not_management_account");
  });
});

test("root cannot assume roles into member accounts", () => {
  const root = { accountId: "1", region: "us-east-1", credentials: async () => ({ accessKeyId: "a", secretAccessKey: "b" }), identity: { accountId: "1", arn: "arn:aws:iam::111111111111:root", kind: "root" as const, longLivedKey: false } };
  expect(() => assumedSession(root, "222222222222", "OrganizationAccountAccessRole", "us-east-1")).toThrow(/root user assume roles/);
});
