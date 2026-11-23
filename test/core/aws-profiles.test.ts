import { describe, expect, test } from "bun:test";
import { accountSections, planProfiles, profileNames, ssoSessionSection } from "../../src/core/aws-profiles";
import { ConfigSchema } from "../../src/core/config";

const config = ConfigSchema.parse({});
const sso = ssoSessionSection(config, { startUrl: "https://d-1.awsapps.com/start", region: "us-east-1" });
const management = { id: "111111111111", name: "main", management: true };
const shop = { id: "222222222222", name: "shop", management: false };

test("profile names: the bare prefix for management, the account name for the rest, and -read for read-only", () => {
  expect(profileNames(config, management)).toEqual({ admin: "aws-kit", read: "aws-kit-read" });
  expect(profileNames(config, shop)).toEqual({ admin: "aws-kit-shop", read: "aws-kit-shop-read" });
});

describe("planProfiles", () => {
  test("adds a managed block after the person's own sections, with the sso-session first", () => {
    const mine = "[default]\nregion = us-west-2\n";
    const plan = planProfiles(mine, [...accountSections(config, shop), sso]);
    expect(plan.written).toEqual(["profile aws-kit-shop", "profile aws-kit-shop-read", "sso-session aws-kit"]);
    expect(plan.text.startsWith("[default]\nregion = us-west-2\n\n# aws-kit: managed profiles start")).toBe(true);
    expect(plan.text.indexOf("[sso-session aws-kit]")).toBeLessThan(plan.text.indexOf("[profile aws-kit-shop]"));
    expect(plan.text).toContain("[profile aws-kit-shop-read]\nsso_session = aws-kit\nsso_account_id = 222222222222\nsso_role_name = AwsKitReadOnly\nregion = us-east-1");
  });

  test("keeps accounts already in the block and changes nothing when everything is current", () => {
    const first = planProfiles("", [sso, ...accountSections(config, management)]).text;
    const second = planProfiles(first, [sso, ...accountSections(config, shop)]);
    expect(second.unchanged).toEqual(["sso-session aws-kit"]);
    expect(second.text).toContain("[profile aws-kit]\n");
    expect(second.text).toContain("[profile aws-kit-shop]\n");
    const third = planProfiles(second.text, [sso, ...accountSections(config, management), ...accountSections(config, shop)]);
    expect(third.written).toEqual([]);
    expect(third.text).toBe(second.text);
  });

  test("leaves a profile the person defined outside the block alone", () => {
    const mine = "[profile aws-kit]\nsso_session = mine\nsso_account_id = 111111111111\nsso_role_name = Admin\n";
    const plan = planProfiles(mine, [sso, ...accountSections(config, management)]);
    expect(plan.keptYours).toEqual(["profile aws-kit"]);
    expect(plan.text.match(/\[profile aws-kit\]/g)).toHaveLength(1);
    expect(plan.text.startsWith(mine)).toBe(true);
  });

  test("updates a profile whose account or role changed", () => {
    const first = planProfiles("", [sso, ...accountSections(config, shop)]).text;
    const moved = planProfiles(first, accountSections(config, { ...shop, id: "333333333333" }));
    expect(moved.written).toEqual(["profile aws-kit-shop", "profile aws-kit-shop-read"]);
    expect(moved.text).not.toContain("222222222222");
  });
});
