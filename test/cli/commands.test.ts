import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { AttachUserPolicyCommand, CreateUserCommand, GetLoginProfileCommand, GetUserCommand, IAMClient, ListAttachedUserPoliciesCommand } from "@aws-sdk/client-iam";
import { CreateAccountCommand, CreateOrganizationCommand, DescribeCreateAccountStatusCommand, DescribeOrganizationCommand, ListAccountsCommand, OrganizationsClient } from "@aws-sdk/client-organizations";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { mockClient } from "aws-sdk-client-mock";
import { accountCreate } from "../../src/commands/account";
import { bootstrap } from "../../src/commands/bootstrap";
import { ConfigSchema } from "../../src/core/config";
import { assumedSession } from "../../src/core/credentials";
import type { KitError } from "../../src/core/errors";
import { fakeAwsEnv } from "../support/aws-env";

const sts = mockClient(STSClient);
const orgs = mockClient(OrganizationsClient);
const iam = mockClient(IAMClient);
let env: ReturnType<typeof fakeAwsEnv>;
const noSuchEntity = () => Object.assign(new Error("not found"), { name: "NoSuchEntityException" });
const config = ConfigSchema.parse({ accountEmail: "me+aws-{name}@example.com" });

beforeAll(() => (env = fakeAwsEnv(["aws-kit-root", "aws-kit"])));
afterAll(() => env.restore());
afterEach(() => [sts, orgs, iam].forEach((mock) => mock.reset()));

describe("bootstrap", () => {
  const asRoot = () => sts.on(GetCallerIdentityCommand).resolves({ Account: "111111111111", Arn: "arn:aws:iam::111111111111:root" });

  test("reports the organization and operator user it would create, and changes nothing", async () => {
    asRoot();
    orgs.on(DescribeOrganizationCommand).rejects(Object.assign(new Error("no org"), { name: "AWSOrganizationsNotInUseException" }));
    iam.on(GetUserCommand).rejects(noSuchEntity());
    iam.on(ListAttachedUserPoliciesCommand).rejects(noSuchEntity());
    iam.on(GetLoginProfileCommand).rejects(noSuchEntity());
    const result = await bootstrap.run({ yes: false }, { config, positionals: [] });
    expect(result.rootSession).toBe(true);
    expect((result.steps as { id: string; action: string }[]).map((step) => `${step.id}:${step.action}`)).toEqual([
      "organization:would-change",
      "operator-user:would-change",
      "operator-admin:would-change",
      "operator-console-sign-in:manual",
    ]);
    expect(orgs.commandCalls(CreateOrganizationCommand)).toHaveLength(0);
    expect(iam.commandCalls(CreateUserCommand)).toHaveLength(0);
  });

  test("with --yes creates them", async () => {
    asRoot();
    orgs.on(DescribeOrganizationCommand).rejects(Object.assign(new Error("no org"), { name: "AWSOrganizationsNotInUseException" }));
    orgs.on(CreateOrganizationCommand).resolves({ Organization: { Id: "o-abc" } });
    iam.on(GetUserCommand).rejects(noSuchEntity());
    iam.on(CreateUserCommand).resolves({ User: { Arn: "arn:aws:iam::111111111111:user/aws-kit-operator", UserName: "aws-kit-operator", UserId: "x", Path: "/", CreateDate: new Date() } });
    iam.on(ListAttachedUserPoliciesCommand).resolves({ AttachedPolicies: [] });
    iam.on(GetLoginProfileCommand).rejects(noSuchEntity());
    const result = await bootstrap.run({ yes: true }, { config, positionals: [] });
    expect(result.changed).toBe(true);
    expect(orgs.commandCalls(CreateOrganizationCommand)[0]?.args[0].input).toEqual({ FeatureSet: "ALL" });
    expect(iam.commandCalls(AttachUserPolicyCommand)[0]?.args[0].input.PolicyArn).toBe("arn:aws:iam::aws:policy/AdministratorAccess");
  });
});

describe("account create", () => {
  const asOperator = () => {
    sts.on(GetCallerIdentityCommand).resolves({ Account: "111111111111", Arn: "arn:aws:iam::111111111111:user/aws-kit-operator" });
    orgs.on(DescribeOrganizationCommand).resolves({ Organization: { Id: "o-abc", MasterAccountId: "111111111111", FeatureSet: "ALL" } });
    orgs.on(ListAccountsCommand).resolves({ Accounts: [{ Id: "111111111111", Name: "main", Email: "me@example.com", State: "ACTIVE" }] });
  };

  test("without --yes only describes the account", async () => {
    asOperator();
    const result = await accountCreate.run({ name: "shop", yes: false }, { config, positionals: [] });
    expect(result.wouldCreate).toEqual({ name: "shop", email: "me+aws-shop@example.com", role: "OrganizationAccountAccessRole" });
    expect(orgs.commandCalls(CreateAccountCommand)).toHaveLength(0);
  });

  test("returns an existing account instead of making a second", async () => {
    asOperator();
    orgs.on(ListAccountsCommand).resolves({ Accounts: [{ Id: "222222222222", Name: "shop", Email: "x@example.com", State: "ACTIVE" }] });
    const result = await accountCreate.run({ name: "shop", yes: true }, { config, positionals: [] });
    expect(result.changed).toBe(false);
    expect(orgs.commandCalls(CreateAccountCommand)).toHaveLength(0);
  });

  test("with --yes creates it", async () => {
    asOperator();
    orgs.on(CreateAccountCommand).resolves({ CreateAccountStatus: { Id: "car-1" } });
    orgs.on(DescribeCreateAccountStatusCommand).resolves({ CreateAccountStatus: { State: "SUCCEEDED", AccountId: "222222222222" } });
    const result = await accountCreate.run({ name: "shop", yes: true }, { config, positionals: [] });
    expect(result.account).toEqual({ id: "222222222222", name: "shop", email: "me+aws-shop@example.com" });
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
