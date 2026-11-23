import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { fromIni, fromTemporaryCredentials } from "@aws-sdk/credential-providers";
import { loadSharedConfigFiles } from "@smithy/shared-ini-file-loader";
import type { AwsCredentialIdentityProvider } from "@smithy/types";
import { awsErrorName, KitError } from "./errors";

export interface Identity {
  accountId: string;
  arn: string;
  kind: "root" | "user" | "role" | "other";
  /** An access key that never expires (AKIA...), as opposed to temporary credentials (ASIA...). */
  longLivedKey: boolean;
}

/** Credentials for one AWS account and region. */
export interface Session {
  accountId: string;
  region: string;
  credentials: AwsCredentialIdentityProvider;
  identity: Identity;
  /** Set when the credentials come straight from a profile, so child processes can use the profile and refresh on their own. */
  profile?: string;
}

export function identityKind(arn: string): Identity["kind"] {
  if (/^arn:aws[\w-]*:iam::\d{12}:root$/.test(arn)) return "root";
  if (/:user\//.test(arn)) return "user";
  if (/:assumed-role\//.test(arn)) return "role";
  return "other";
}

const SIGN_IN_ERRORS = ["CredentialsProviderError", "TokenProviderError", "ExpiredToken", "ExpiredTokenException", "InvalidClientTokenId", "TokenRefreshRequired", "UnauthorizedException"];

/** The permission set behind an Identity Center role session, from an ARN like .../AWSReservedSSO_AwsKitAdmin_0123abcd/me. */
export function permissionSetOf(arn: string): string | undefined {
  return /:assumed-role\/AWSReservedSSO_(.+)_[0-9a-f]+\//.exec(arn)?.[1];
}

/** True when ~/.aws/config or ~/.aws/credentials defines the profile. */
export async function profileExists(profile: string): Promise<boolean> {
  const { configFile, credentialsFile } = await loadSharedConfigFiles();
  return profile in configFile || profile in credentialsFile;
}

/** The command that signs a profile in: `aws sso login` for Identity Center profiles, `aws login` for the rest. */
export async function signInCommand(profile: string): Promise<string> {
  const { configFile } = await loadSharedConfigFiles();
  const data = configFile[profile] ?? {};
  return data.sso_session || data.sso_start_url ? `aws sso login --profile ${profile}` : `aws login --profile ${profile}`;
}

/**
 * A session from a named profile. Any kind the AWS CLI writes works: `aws login`, SSO, a role, or an access key.
 * It reads only the profile, never the EC2 metadata endpoint, which would make a missing profile hang for minutes.
 */
export async function profileSession(profile: string, region: string, missingHint = `Sign in to create it: aws login --profile ${profile}`): Promise<Session> {
  if (!(await profileExists(profile))) throw new KitError("not_signed_in", `No AWS profile named ${profile}.`, missingHint);
  const credentials = fromIni({ profile });
  try {
    const resolved = await credentials();
    const me = await new STSClient({ region, credentials }).send(new GetCallerIdentityCommand({}));
    const arn = me.Arn ?? "";
    return {
      accountId: me.Account ?? "",
      region,
      credentials,
      profile,
      identity: { accountId: me.Account ?? "", arn, kind: identityKind(arn), longLivedKey: resolved.accessKeyId.startsWith("AKIA") },
    };
  } catch (error) {
    throw (await signInError(error, profile)) ?? error;
  }
}

/** Turns a credential failure into the kit error that says what to do, or undefined for anything else. */
export async function signInError(error: unknown, profile: string): Promise<KitError | undefined> {
  const name = awsErrorName(error);
  const message = error instanceof Error ? error.message : String(error);
  // The SSO provider wraps GetRoleCredentials failures, so a missing assignment shows up only in the message.
  if (name === "ForbiddenException" || /ForbiddenException|No access/i.test(message)) {
    return new KitError("no_access", `Profile ${profile} names an account or permission set your Identity Center user has not been given.`, "Give it access with aws-kit account ready --account <name> --yes, or aws-kit bootstrap --yes for the management account.");
  }
  if (name && SIGN_IN_ERRORS.includes(name)) return new KitError("not_signed_in", `Profile ${profile} has no working credentials: ${message}`, `Run: ${await signInCommand(profile)}`);
  return undefined;
}

/** A session in a member account, through the role AWS Organizations puts in every account it creates. */
export function assumedSession(base: Session, accountId: string, roleName: string, region: string): Session {
  if (base.identity.kind === "root") {
    throw new KitError(
      "root_cannot_assume",
      "AWS does not let the root user assume roles, so root credentials cannot reach member accounts.",
      "Run aws-kit bootstrap as root once, then sign in through Identity Center: aws sso login --profile aws-kit.",
    );
  }
  const roleArn = `arn:aws:iam::${accountId}:role/${roleName}`;
  const credentials = fromTemporaryCredentials({
    masterCredentials: base.credentials,
    params: { RoleArn: roleArn, RoleSessionName: "aws-kit", DurationSeconds: 3600 },
    clientConfig: { region },
  });
  return { accountId, region, credentials, identity: { accountId, arn: roleArn, kind: "role", longLivedKey: false } };
}

const CREDENTIAL_ENV = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE", "AWS_DEFAULT_PROFILE"];

/** Environment for a child process (cdk, the AWS CLI, a script) that acts in this session's account. */
export async function childEnv(session: Session, extra: Record<string, string> = {}): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !CREDENTIAL_ENV.includes(key)) env[key] = value;
  env.AWS_REGION = session.region;
  env.AWS_DEFAULT_REGION = session.region;
  if (session.profile) {
    env.AWS_PROFILE = session.profile;
  } else {
    const resolved = await session.credentials();
    env.AWS_ACCESS_KEY_ID = resolved.accessKeyId;
    env.AWS_SECRET_ACCESS_KEY = resolved.secretAccessKey;
    if (resolved.sessionToken) env.AWS_SESSION_TOKEN = resolved.sessionToken;
  }
  return { ...env, ...extra };
}
