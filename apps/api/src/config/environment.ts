export type AuthMode = "mock" | "cognito";

export interface Environment {
  nodeEnv: string;
  authMode: AuthMode;
  port: number;
  databaseUrl: string;
  corsOrigin: string;
  awsRegion: string;
  cognitoUserPoolId?: string;
  cognitoClientId?: string;
}

let cached: Environment | undefined;

export function readEnvironment(source: NodeJS.ProcessEnv = process.env): Environment {
  if (source === process.env && cached) return cached;

  const nodeEnv = source.NODE_ENV ?? "development";
  const authMode = (source.AUTH_MODE ?? "mock") as AuthMode;
  if (!(["mock", "cognito"] as string[]).includes(authMode)) {
    throw new Error(`Unsupported AUTH_MODE: ${authMode}`);
  }
  if (authMode === "mock" && !["development", "test"].includes(nodeEnv)) {
    throw new Error("AUTH_MODE=mock is forbidden outside development and test");
  }
  if (authMode === "cognito" && (!source.COGNITO_USER_POOL_ID || !source.COGNITO_CLIENT_ID)) {
    throw new Error("Cognito auth requires COGNITO_USER_POOL_ID and COGNITO_CLIENT_ID");
  }

  const value: Environment = {
    nodeEnv,
    authMode,
    port: Number(source.API_PORT ?? 4000),
    databaseUrl: source.DATABASE_URL ?? "postgres://argus:argus@localhost:5432/argus",
    corsOrigin: source.CORS_ORIGIN ?? "http://localhost:3000",
    awsRegion: source.AWS_REGION ?? "ap-southeast-1",
    cognitoUserPoolId: source.COGNITO_USER_POOL_ID,
    cognitoClientId: source.COGNITO_CLIENT_ID,
  };

  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) {
    throw new Error("API_PORT must be a valid TCP port");
  }
  if (source === process.env) cached = value;
  return value;
}
