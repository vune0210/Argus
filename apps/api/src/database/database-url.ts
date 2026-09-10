import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

let cachedUrl: string | undefined;

export async function resolveDatabaseUrl(): Promise<string> {
  if (cachedUrl) return cachedUrl;

  // Priority 1: DATABASE_URL (for local/test and explicit connection strings)
  if (process.env.DATABASE_URL) {
    cachedUrl = process.env.DATABASE_URL;
    return cachedUrl;
  }

  // Priority 2: DATABASE_SECRET_ARN (for AWS staging / production RDS-managed secret)
  const secretArn = process.env.DATABASE_SECRET_ARN;
  if (secretArn) {
    const region = process.env.AWS_REGION || "ap-southeast-1";
    const client = new SecretsManagerClient({ region });
    const response = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
    if (!response.SecretString) {
      throw new Error(`SecretString is empty in DATABASE_SECRET_ARN: ${secretArn}`);
    }
    const secret = JSON.parse(response.SecretString);
    const username = encodeURIComponent(secret.username ?? "argus_admin");
    const password = encodeURIComponent(secret.password ?? "");
    const host = secret.host ?? "localhost";
    const port = secret.port ?? 5432;
    const dbname = secret.dbname ?? "argus";
    const sslParam = secret.ssl !== false ? "?sslmode=require" : "";
    cachedUrl = `postgres://${username}:${password}@${host}:${port}/${dbname}${sslParam}`;
    return cachedUrl;
  }

  // Fallback default
  cachedUrl = "postgres://argus:argus@localhost:5432/argus";
  return cachedUrl;
}
