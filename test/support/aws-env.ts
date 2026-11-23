import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Points the AWS SDK and the kit at throwaway files with one static-key
 * profile per name, so command tests run without touching real credentials.
 */
export function fakeAwsEnv(profiles: string[]): { dir: string; restore: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "aws-kit-test-"));
  const credentials = profiles.map((name) => `[${name}]\naws_access_key_id = ASIATESTKEY${name.toUpperCase().replace(/[^A-Z]/g, "")}\naws_secret_access_key = secret\naws_session_token = token\n`).join("\n");
  writeFileSync(join(dir, "credentials"), credentials);
  writeFileSync(join(dir, "config"), "");
  writeFileSync(join(dir, "kit.json"), "{}");
  const saved = { ...process.env };
  process.env.AWS_SHARED_CREDENTIALS_FILE = join(dir, "credentials");
  process.env.AWS_CONFIG_FILE = join(dir, "config");
  process.env.AWS_KIT_CONFIG = join(dir, "kit.json");
  delete process.env.AWS_PROFILE;
  delete process.env.AWS_ACCESS_KEY_ID;
  delete process.env.AWS_SECRET_ACCESS_KEY;
  return {
    dir,
    restore() {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    },
  };
}
