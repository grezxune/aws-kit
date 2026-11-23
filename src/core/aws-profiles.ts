import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { OrgAccount } from "./accounts";
import type { Config } from "./config";

const START = "# aws-kit: managed profiles start. aws-kit rewrites this block, so edits inside it are lost.";
const END = "# aws-kit: managed profiles end";

/** One `[header]` section of ~/.aws/config, such as `profile aws-kit-shop` or `sso-session aws-kit`. */
export interface Section {
  header: string;
  values: Record<string, string>;
}

export interface ProfileNames {
  admin: string;
  read: string;
}

export interface SsoSettings {
  startUrl: string;
  region: string;
}

export function awsConfigPath(): string {
  return process.env.AWS_CONFIG_FILE ?? join(homedir(), ".aws", "config");
}

/** `<profile>` and `<profile>-read` for the management account, `<profile>-<account>` and `<profile>-<account>-read` for the rest. */
export function profileNames(config: Config, account: Pick<OrgAccount, "name" | "management">): ProfileNames {
  const admin = account.management ? config.profile : `${config.profile}-${account.name}`;
  return { admin, read: `${admin}-read` };
}

/** The sso-session section every kit profile signs in through, so one `aws sso login` covers them all. */
export function ssoSessionSection(config: Config, sso: SsoSettings): Section {
  return { header: `sso-session ${config.profile}`, values: { sso_start_url: sso.startUrl, sso_region: sso.region, sso_registration_scopes: "sso:account:access" } };
}

/** The admin and the read-only profile for one account. */
export function accountSections(config: Config, account: Pick<OrgAccount, "id" | "name" | "management">): Section[] {
  const names = profileNames(config, account);
  const profile = (name: string, role: string): Section => ({
    header: `profile ${name}`,
    values: { sso_session: config.profile, sso_account_id: account.id, sso_role_name: role, region: config.region },
  });
  return [profile(names.admin, config.adminPermissionSet), profile(names.read, config.readPermissionSet)];
}

function parseSections(text: string): Map<string, Section> {
  const sections = new Map<string, Section>();
  let current: Section | undefined;
  for (const line of text.split("\n")) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line)?.[1]?.trim();
    if (header) {
      current = { header, values: {} };
      sections.set(header, current);
      continue;
    }
    const pair = /^\s*([^#;=\s][^=]*?)\s*=\s*(.*?)\s*$/.exec(line);
    if (current && pair?.[1]) current.values[pair[1]] = pair[2] ?? "";
  }
  return sections;
}

function render(section: Section): string {
  return [`[${section.header}]`, ...Object.entries(section.values).map(([key, value]) => `${key} = ${value}`)].join("\n");
}

const same = (a: Section | undefined, b: Section) => a !== undefined && JSON.stringify(a.values) === JSON.stringify(b.values);

export interface ProfilePlan {
  /** Sections added or changed. */
  written: string[];
  /** Sections already right. */
  unchanged: string[];
  /** Sections the person defined outside the managed block. The kit leaves those alone. */
  keptYours: string[];
  text: string;
}

/** Merges sections into the managed block of a config file's text. Sections already in the block and not passed stay. */
export function planProfiles(current: string, sections: Section[]): ProfilePlan {
  const start = current.indexOf(START);
  const end = start === -1 ? -1 : current.indexOf(END, start);
  const outside = start === -1 ? current : current.slice(0, start) + (end === -1 ? "" : current.slice(end + END.length));
  const block = start === -1 ? "" : current.slice(start + START.length, end === -1 ? undefined : end);
  const yours = parseSections(outside);
  const managed = parseSections(block);
  const plan: ProfilePlan = { written: [], unchanged: [], keptYours: [], text: current };
  for (const section of sections) {
    if (yours.has(section.header)) plan.keptYours.push(section.header);
    else if (same(managed.get(section.header), section)) plan.unchanged.push(section.header);
    else {
      plan.written.push(section.header);
      managed.set(section.header, section);
    }
  }
  if (!plan.written.length) return plan;
  const ordered = [...managed.values()].sort((a, b) => Number(b.header.startsWith("sso-session")) - Number(a.header.startsWith("sso-session")) || a.header.localeCompare(b.header));
  const head = outside.replace(/\s+$/, "");
  plan.text = `${head ? `${head}\n\n` : ""}${START}\n${ordered.map(render).join("\n\n")}\n${END}\n`;
  return plan;
}

export async function readAwsConfig(): Promise<string> {
  return readFile(awsConfigPath(), "utf8").catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? "" : Promise.reject(error)));
}

export async function writeAwsConfig(text: string): Promise<void> {
  await mkdir(dirname(awsConfigPath()), { recursive: true, mode: 0o700 });
  await writeFile(awsConfigPath(), text, { mode: 0o600 });
}
