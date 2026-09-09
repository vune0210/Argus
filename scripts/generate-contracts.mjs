import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = async (path) => JSON.parse(await readFile(resolve(repositoryRoot, path), "utf8"));
const quoteUnion = (values) => values.map((value) => JSON.stringify(value)).join(" | ");

export async function generatedContractOutputs() {
  const job = await readJson("packages/contracts/schemas/probe-job.schema.json");
  const result = await readJson("packages/contracts/schemas/probe-result.schema.json");
  const http = job.$defs.httpMonitorConfig;
  const keyword = job.$defs.keywordMonitorConfig;
  const schemaVersion = "0.2";

  const ts = `// Code generated from the Argus v${schemaVersion} JSON Schemas. DO NOT EDIT BY HAND.

export type HttpMethod = ${quoteUnion(http.properties.method.enum)};
export type MatchMode = ${quoteUnion(keyword.properties.matchMode.enum)};
export type ProbeOutcome = ${quoteUnion(result.properties.outcome.enum)};
export type ProbeErrorCode = ${quoteUnion(result.properties.errorCode.enum)};

export interface HttpMonitorConfig {
  kind: "http";
  url: string;
  method: HttpMethod;
  timeoutMs: number;
  expectedStatus: number;
  maxRedirects: number;
  maxResponseBytes: number;
}

export interface TcpMonitorConfig {
  kind: "tcp";
  host: string;
  port: number;
  timeoutMs: number;
}

export interface SslMonitorConfig {
  kind: "ssl";
  host: string;
  port: number;
  serverName?: string;
  timeoutMs: number;
  warnBeforeDays: number;
}

export interface KeywordMonitorConfig {
  kind: "keyword";
  url: string;
  method: "GET" | "HEAD";
  expectedStatus: number;
  keyword: string;
  matchMode: MatchMode;
  caseSensitive: boolean;
  maxRedirects: number;
  maxResponseBytes: number;
  timeoutMs: number;
}

export type MonitorConfig = HttpMonitorConfig | TcpMonitorConfig | SslMonitorConfig | KeywordMonitorConfig;

export interface ProbeJob {
  schemaVersion: "0.1" | "0.2";
  executionId: string;
  organizationId: string;
  monitorId: string;
  monitorVersion: number;
  scheduledAt: string;
  deadlineAt: string;
  config: MonitorConfig;
}

export interface TcpResult {
  connected: boolean;
}

export interface SslResult {
  expiresAt: string;
  daysRemaining: number;
}

export interface KeywordResult {
  statusCode: number;
  responseBytes: number;
  matched: boolean;
}

export interface ProbeResult {
  schemaVersion: "0.1" | "0.2";
  executionId: string;
  organizationId: string;
  monitorId: string;
  monitorVersion: number;
  probeId: string;
  region: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  outcome: ProbeOutcome;
  errorCode?: ProbeErrorCode;
  errorMessage?: string;
  http?: {
    statusCode: number;
    responseBytes: number;
  };
  tcp?: TcpResult;
  ssl?: SslResult;
  keyword?: KeywordResult;
}
`;

  const goErrorConstants = {
    DNS: "ErrorDNS",
    CONNECT: "ErrorConnect",
    TIMEOUT: "ErrorTimeout",
    TLS: "ErrorTLS",
    ASSERTION: "ErrorAssertion",
    RESPONSE_TOO_LARGE: "ErrorResponseTooLarge",
    SSRF_BLOCKED: "ErrorSSRFBlocked",
    INTERNAL: "ErrorInternal",
  };
  const longestGoErrorName = Math.max(...Object.values(goErrorConstants).map((name) => name.length));
  const goErrors = result.properties.errorCode.enum
    .map((value) => `\t${goErrorConstants[value].padEnd(longestGoErrorName)} = ${JSON.stringify(value)}`)
    .join("\n");

  const go = `// Code generated from the Argus v${schemaVersion} JSON Schemas. DO NOT EDIT BY HAND.
package contracts

import "time"

const SchemaVersion = ${JSON.stringify(schemaVersion)}

type HTTPMonitorConfig struct {
\tKind             string \`json:"kind"\`
\tURL              string \`json:"url"\`
\tMethod           string \`json:"method"\`
\tTimeoutMS        int    \`json:"timeoutMs"\`
\tExpectedStatus   int    \`json:"expectedStatus"\`
\tMaxRedirects     int    \`json:"maxRedirects"\`
\tMaxResponseBytes int64  \`json:"maxResponseBytes"\`
}

type TCPMonitorConfig struct {
\tKind      string \`json:"kind"\`
\tHost      string \`json:"host"\`
\tPort      int    \`json:"port"\`
\tTimeoutMS int    \`json:"timeoutMs"\`
}

type SSLMonitorConfig struct {
\tKind           string \`json:"kind"\`
\tHost           string \`json:"host"\`
\tPort           int    \`json:"port"\`
\tServerName     string \`json:"serverName,omitempty"\`
\tTimeoutMS      int    \`json:"timeoutMs"\`
\tWarnBeforeDays int    \`json:"warnBeforeDays"\`
}

type KeywordMonitorConfig struct {
\tKind             string \`json:"kind"\`
\tURL              string \`json:"url"\`
\tMethod           string \`json:"method"\`
\tExpectedStatus   int    \`json:"expectedStatus"\`
\tKeyword          string \`json:"keyword"\`
\tMatchMode        string \`json:"matchMode"\`
\tCaseSensitive    bool   \`json:"caseSensitive"\`
\tMaxRedirects     int    \`json:"maxRedirects"\`
\tMaxResponseBytes int64  \`json:"maxResponseBytes"\`
\tTimeoutMS        int    \`json:"timeoutMs"\`
}

type MonitorConfig struct {
\tKind             string \`json:"kind"\`
\tURL              string \`json:"url,omitempty"\`
\tMethod           string \`json:"method,omitempty"\`
\tTimeoutMS        int    \`json:"timeoutMs"\`
\tExpectedStatus   int    \`json:"expectedStatus,omitempty"\`
\tMaxRedirects     int    \`json:"maxRedirects,omitempty"\`
\tMaxResponseBytes int64  \`json:"maxResponseBytes,omitempty"\`
\tHost             string \`json:"host,omitempty"\`
\tPort             int    \`json:"port,omitempty"\`
\tServerName       string \`json:"serverName,omitempty"\`
\tWarnBeforeDays   int    \`json:"warnBeforeDays,omitempty"\`
\tKeyword          string \`json:"keyword,omitempty"\`
\tMatchMode        string \`json:"matchMode,omitempty"\`
\tCaseSensitive    bool   \`json:"caseSensitive,omitempty"\`
}

type ProbeJob struct {
\tSchemaVersion  string        \`json:"schemaVersion"\`
\tExecutionID    string        \`json:"executionId"\`
\tOrganizationID string        \`json:"organizationId"\`
\tMonitorID      string        \`json:"monitorId"\`
\tMonitorVersion int           \`json:"monitorVersion"\`
\tScheduledAt    time.Time     \`json:"scheduledAt"\`
\tDeadlineAt     time.Time     \`json:"deadlineAt"\`
\tConfig         MonitorConfig \`json:"config"\`
}

type HTTPResult struct {
\tStatusCode    int   \`json:"statusCode"\`
\tResponseBytes int64 \`json:"responseBytes"\`
}

type TCPResult struct {
\tConnected bool \`json:"connected"\`
}

type SSLResult struct {
\tExpiresAt     time.Time \`json:"expiresAt"\`
\tDaysRemaining int       \`json:"daysRemaining"\`
}

type KeywordResult struct {
\tStatusCode    int   \`json:"statusCode"\`
\tResponseBytes int64 \`json:"responseBytes"\`
\tMatched       bool  \`json:"matched"\`
}

type ProbeResult struct {
\tSchemaVersion  string         \`json:"schemaVersion"\`
\tExecutionID    string         \`json:"executionId"\`
\tOrganizationID string         \`json:"organizationId"\`
\tMonitorID      string         \`json:"monitorId"\`
\tMonitorVersion int            \`json:"monitorVersion"\`
\tProbeID        string         \`json:"probeId"\`
\tRegion         string         \`json:"region"\`
\tStartedAt      time.Time      \`json:"startedAt"\`
\tCompletedAt    time.Time      \`json:"completedAt"\`
\tDurationMS     int64          \`json:"durationMs"\`
\tOutcome        string         \`json:"outcome"\`
\tErrorCode      string         \`json:"errorCode,omitempty"\`
\tErrorMessage   string         \`json:"errorMessage,omitempty"\`
\tHTTP           *HTTPResult    \`json:"http,omitempty"\`
\tTCP            *TCPResult     \`json:"tcp,omitempty"\`
\tSSL            *SSLResult     \`json:"ssl,omitempty"\`
\tKeyword        *KeywordResult \`json:"keyword,omitempty"\`
}

const (
\tOutcomePass = ${JSON.stringify(result.properties.outcome.enum[0])}
\tOutcomeFail = ${JSON.stringify(result.properties.outcome.enum[1])}

${goErrors}
)
`;

  const api = await readJson("packages/contracts/openapi/argus-v0.2.json");
  const apiNames = [
    "ExecutionSummary",
    "ExecutionTarget",
    "ExecutionDetail",
    "ExecutionPage",
    "ProbeLease",
    "ResultReceipt",
    "LeaseHeartbeat",
    "Incident",
    "IncidentEvent",
    "NotificationDelivery",
    "IncidentDetail",
    "IncidentPage",
    "RegionSnapshot",
    "MonitorSnapshot",
    "NotificationChannel",
    "NotificationChannelPage",
    "CreateNotificationChannelRequest",
    "UpdateNotificationChannelRequest",
    "EscalationStep",
    "EscalationPolicy",
    "UpdateEscalationPolicyRequest",
    "StatusPageComponent",
    "StatusPage",
    "StatusPageSummary",
    "StatusPageListPage",
    "CreateStatusPageRequest",
    "UpdateStatusPageRequest",
    "AddStatusPageComponentRequest",
    "PublicStatusUptimeWindow",
    "PublicStatusComponent",
    "PublicIncidentUpdate",
    "PublicIncident",
    "PublicStatusPage",
    "IncidentPolicy",
    "EvaluateMonitorRequest",
    "TimeSeriesPoint",
    "MonitorTimeSeriesResponse",
  ];

  function tsType(schema) {
    if (!schema) return "unknown";
    if (schema.$ref) return schema.$ref.split("/").at(-1);
    if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
    if (schema.anyOf) return schema.anyOf.map(tsType).join(" | ");
    if (schema.oneOf) return schema.oneOf.map(tsType).join(" | ");
    if (Array.isArray(schema.type)) return schema.type.map((type) => tsType({ ...schema, type })).join(" | ");
    if (schema.type === "array") return `Array<${tsType(schema.items)}>`;
    if (schema.type === "object") {
      if (schema.properties) {
        return `{\n${Object.entries(schema.properties).map(([key, value]) => {
          const propName = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
          return `  ${propName}${schema.required?.includes(key) ? "" : "?"}: ${tsType(value)};`;
        }).join("\n")}\n}`;
      }
      if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        return `Record<string, ${tsType(schema.additionalProperties)}>`;
      }
      return "Record<string, unknown>";
    }
    return { integer: "number", number: "number", boolean: "boolean", string: "string", null: "null" }[schema.type] ?? "unknown";
  }

  const apiTS = '// Code generated from OpenAPI v0.2. DO NOT EDIT.\nimport type { ProbeJob, ProbeResult } from "./probe.gen";\n\n'
    + apiNames.map((name) => `export type ${name} = ${tsType(api.components.schemas[name])};`).join("\n\n") + "\n";
  const leaseSchema = await readJson("packages/contracts/schemas/probe-lease.schema.json");
  if (JSON.stringify(leaseSchema.required) !== JSON.stringify(api.components.schemas.ProbeLease.required)) throw new Error("ProbeLease schema drift");
  const goTypes = { leaseId: "string", expiresAt: "time.Time", targetRegion: "string", job: "ProbeJob", receiptId: "string", receivedAt: "time.Time", duplicate: "bool" };
  const goNames = { leaseId: "LeaseID", expiresAt: "ExpiresAt", targetRegion: "TargetRegion", job: "Job", receiptId: "ReceiptID", receivedAt: "ReceivedAt", duplicate: "Duplicate" };
  const apiGo = '// Code generated from OpenAPI v0.2. DO NOT EDIT.\npackage contracts\n\nimport "time"\n\n'
    + ["ProbeLease", "ResultReceipt"].map((name) => {
      const fields = Object.keys(api.components.schemas[name].properties);
      const width = Math.max(...fields.map((field) => goNames[field].length));
      const typeWidth = Math.max(...fields.map((field) => goTypes[field].length));
      return `type ${name} struct {\n${fields.map((field) => `\t${goNames[field].padEnd(width)} ${goTypes[field].padEnd(typeWidth)} \`json:"${field}"\``).join("\n")}\n}`;
    }).join("\n\n") + "\n";

  return new Map([
    ["packages/contracts/src/probe.gen.ts", ts],
    ["packages/contracts/src/api.gen.ts", apiTS],
    ["agents/probe/internal/contracts/pipeline.gen.go", apiGo],
    ["agents/probe/internal/contracts/models.gen.go", go],
  ]);
}

export async function checkGeneratedContracts() {
  const outputs = await generatedContractOutputs();
  for (const [path, expected] of outputs) {
    const actual = await readFile(resolve(repositoryRoot, path), "utf8");
    if (actual.replaceAll("\r\n", "\n") !== expected) {
      throw new Error(`${path} is stale; run pnpm contracts:generate`);
    }
  }
}

async function main() {
  const outputs = await generatedContractOutputs();
  if (process.argv.includes("--check")) return checkGeneratedContracts();
  await Promise.all([...outputs].map(([path, contents]) => writeFile(resolve(repositoryRoot, path), contents, "utf8")));
  console.log(`Generated ${outputs.size} contract model files.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
