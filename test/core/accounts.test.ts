import { afterEach, describe, expect, test } from "bun:test";
import { CreateAccountCommand, DescribeCreateAccountStatusCommand, DescribeOrganizationCommand, OrganizationsClient } from "@aws-sdk/client-organizations";
import { mockClient } from "aws-sdk-client-mock";
import { accountEmailFor, createAccount, describeOrg, findAccount, type OrgAccount } from "../../src/core/accounts";
import { KitError } from "../../src/core/errors";

const orgs = mockClient(OrganizationsClient);
afterEach(() => orgs.reset());

const ACCOUNTS: OrgAccount[] = [
  { id: "111111111111", name: "main", email: "a@example.com", status: "ACTIVE", management: true },
  { id: "222222222222", name: "shop", email: "b@example.com", status: "ACTIVE", management: false },
];

describe("findAccount", () => {
  test("finds by name, by ID, and as management", () => {
    expect(findAccount(ACCOUNTS, "shop").id).toBe("222222222222");
    expect(findAccount(ACCOUNTS, "222222222222").name).toBe("shop");
    expect(findAccount(ACCOUNTS, "management").name).toBe("main");
  });

  test("throws a coded error with a hint for an unknown name", () => {
    try {
      findAccount(ACCOUNTS, "nope");
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(KitError);
      expect((error as KitError).code).toBe("account_not_found");
      expect((error as KitError).hint).toContain("account list");
    }
  });
});

test("accountEmailFor fills the template and requires one", () => {
  expect(accountEmailFor("me+aws-{name}@example.com", "shop")).toBe("me+aws-shop@example.com");
  expect(() => accountEmailFor(undefined, "shop")).toThrow(KitError);
});

test("describeOrg returns null for an account with no organization", async () => {
  orgs.on(DescribeOrganizationCommand).rejects(Object.assign(new Error("not in use"), { name: "AWSOrganizationsNotInUseException" }));
  expect(await describeOrg(new OrganizationsClient({ region: "us-east-1" }))).toBeNull();
});

describe("createAccount", () => {
  const input = { name: "shop", email: "me+aws-shop@example.com", roleName: "OrganizationAccountAccessRole", tags: { "managed-by": "aws-kit" } };

  test("waits until AWS reports the account ready", async () => {
    orgs.on(CreateAccountCommand).resolves({ CreateAccountStatus: { Id: "car-1", State: "IN_PROGRESS" } });
    orgs.on(DescribeCreateAccountStatusCommand).resolvesOnce({ CreateAccountStatus: { State: "IN_PROGRESS" } }).resolves({ CreateAccountStatus: { State: "SUCCEEDED", AccountId: "333333333333" } });
    const states: string[] = [];
    const id = await createAccount(new OrganizationsClient({ region: "us-east-1" }), input, { intervalMs: 1, onProgress: (state) => states.push(state) });
    expect(id).toBe("333333333333");
    expect(states).toEqual(["IN_PROGRESS", "SUCCEEDED"]);
    expect(orgs.commandCalls(CreateAccountCommand)[0]?.args[0].input).toMatchObject({ AccountName: "shop", RoleName: "OrganizationAccountAccessRole", IamUserAccessToBilling: "ALLOW" });
  });

  test("explains a failure AWS reports", async () => {
    orgs.on(CreateAccountCommand).resolves({ CreateAccountStatus: { Id: "car-1" } });
    orgs.on(DescribeCreateAccountStatusCommand).resolves({ CreateAccountStatus: { State: "FAILED", FailureReason: "EMAIL_ALREADY_EXISTS" } });
    const failure = await createAccount(new OrganizationsClient({ region: "us-east-1" }), input, { intervalMs: 1 }).catch((error: KitError) => error);
    expect((failure as KitError).code).toBe("account_create_failed");
    expect((failure as KitError).hint).toContain("--email");
  });
});
