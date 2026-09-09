import { BadRequestException } from "@nestjs/common";
import type {
  HttpMethod,
  HttpMonitorConfig,
  KeywordMonitorConfig,
  MatchMode,
  MonitorConfig,
  SslMonitorConfig,
  TcpMonitorConfig,
} from "@argus/contracts";

export interface IncidentPolicyInput {
  failureThreshold?: number;
  recoveryThreshold?: number;
}

export interface MonitorInput {
  name: string;
  intervalSeconds: number;
  regions: string[];
  config: MonitorConfig;
  incidentPolicy?: IncidentPolicyInput;
}

export interface MonitorUpdateInput extends MonitorInput {
  version: number;
}

const httpMethods = new Set<HttpMethod>(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const keywordMethods = new Set(["GET", "HEAD"]);
const topLevelKeys = new Set(["name", "intervalSeconds", "regions", "config", "incidentPolicy"]);
const updateKeys = new Set([...topLevelKeys, "version"]);

const httpConfigKeys = new Set(["kind", "url", "method", "timeoutMs", "expectedStatus", "maxRedirects", "maxResponseBytes"]);
const tcpConfigKeys = new Set(["kind", "host", "port", "timeoutMs"]);
const sslConfigKeys = new Set(["kind", "host", "port", "serverName", "timeoutMs", "warnBeforeDays"]);
const keywordConfigKeys = new Set(["kind", "url", "method", "expectedStatus", "keyword", "matchMode", "caseSensitive", "maxRedirects", "maxResponseBytes", "timeoutMs"]);

function fail(details: string[]): never {
  throw new BadRequestException({ code: "VALIDATION_FAILED", message: "Monitor payload is invalid", details });
}

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(["Body must be an object"]);
  return value as Record<string, unknown>;
}

function validateUrl(rawUrl: unknown, errors: string[]): URL | undefined {
  let url: URL | undefined;
  try {
    url = new URL(String(rawUrl));
  } catch {
    errors.push("config.url must be a valid URL");
  }
  if (url && !["http:", "https:"].includes(url.protocol)) errors.push("config.url must use http or https");
  if (url && (url.username || url.password)) errors.push("config.url must not contain embedded credentials");
  return url;
}

function validateHost(rawHost: unknown, errors: string[]): string {
  const host = typeof rawHost === "string" ? rawHost.trim() : "";
  if (!host || host.length > 255) errors.push("config.host must contain 1-255 characters");
  return host;
}

function validatePort(rawPort: unknown, errors: string[]): number {
  if (!Number.isInteger(rawPort) || (rawPort as number) < 1 || (rawPort as number) > 65535) {
    errors.push("config.port must be an integer between 1 and 65535");
  }
  return Number(rawPort);
}

function validateTimeout(rawTimeout: unknown, errors: string[]): number {
  if (!Number.isInteger(rawTimeout) || (rawTimeout as number) < 100 || (rawTimeout as number) > 30_000) {
    errors.push("config.timeoutMs must be between 100 and 30000");
  }
  return Number(rawTimeout);
}

function validate(value: unknown, updating: boolean): MonitorInput | MonitorUpdateInput {
  const body = objectValue(value);
  const errors: string[] = [];
  const allowedKeys = updating ? updateKeys : topLevelKeys;
  for (const key of Object.keys(body)) if (!allowedKeys.has(key)) errors.push(`Unknown field: ${key}`);

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 120) errors.push("name must contain 1-120 characters");
  const intervalSeconds = body.intervalSeconds;
  if (!Number.isInteger(intervalSeconds) || (intervalSeconds as number) < 60) {
    errors.push("intervalSeconds must be an integer of at least 60");
  }
  const regions = Array.isArray(body.regions) ? [...new Set(body.regions)] : [];
  if (!regions.length || regions.length > 10 || regions.some((region) => typeof region !== "string" || !/^[a-z0-9-]{2,32}$/.test(region))) {
    errors.push("regions must contain 1-10 unique region identifiers");
  }

  const rawConfig = objectValue(body.config);
  const kind = rawConfig.kind;

  let validatedConfig: MonitorConfig;

  if (kind === "http") {
    for (const key of Object.keys(rawConfig)) if (!httpConfigKeys.has(key)) errors.push(`Unknown config field: ${key}`);
    const url = validateUrl(rawConfig.url, errors);
    const method = rawConfig.method as HttpMethod;
    if (!httpMethods.has(method)) errors.push("config.method is not supported");
    const timeoutMs = validateTimeout(rawConfig.timeoutMs, errors);
    if (!Number.isInteger(rawConfig.expectedStatus) || (rawConfig.expectedStatus as number) < 100 || (rawConfig.expectedStatus as number) > 599) {
      errors.push("config.expectedStatus must be between 100 and 599");
    }
    if (!Number.isInteger(rawConfig.maxRedirects) || (rawConfig.maxRedirects as number) < 0 || (rawConfig.maxRedirects as number) > 10) {
      errors.push("config.maxRedirects must be between 0 and 10");
    }
    if (!Number.isInteger(rawConfig.maxResponseBytes) || (rawConfig.maxResponseBytes as number) < 1 || (rawConfig.maxResponseBytes as number) > 1_048_576) {
      errors.push("config.maxResponseBytes must be between 1 and 1048576");
    }

    validatedConfig = {
      kind: "http",
      url: url ? url.toString() : "",
      method,
      timeoutMs,
      expectedStatus: Number(rawConfig.expectedStatus),
      maxRedirects: Number(rawConfig.maxRedirects),
      maxResponseBytes: Number(rawConfig.maxResponseBytes),
    };
  } else if (kind === "tcp") {
    for (const key of Object.keys(rawConfig)) if (!tcpConfigKeys.has(key)) errors.push(`Unknown config field: ${key}`);
    const host = validateHost(rawConfig.host, errors);
    const port = validatePort(rawConfig.port, errors);
    const timeoutMs = validateTimeout(rawConfig.timeoutMs, errors);

    validatedConfig = {
      kind: "tcp",
      host,
      port,
      timeoutMs,
    };
  } else if (kind === "ssl") {
    for (const key of Object.keys(rawConfig)) if (!sslConfigKeys.has(key)) errors.push(`Unknown config field: ${key}`);
    const host = validateHost(rawConfig.host, errors);
    const port = validatePort(rawConfig.port, errors);
    const timeoutMs = validateTimeout(rawConfig.timeoutMs, errors);
    let serverName: string | undefined;
    if (rawConfig.serverName !== undefined) {
      if (typeof rawConfig.serverName !== "string" || rawConfig.serverName.length > 255) {
        errors.push("config.serverName must be a string up to 255 characters");
      } else {
        serverName = rawConfig.serverName.trim();
      }
    }
    if (!Number.isInteger(rawConfig.warnBeforeDays) || (rawConfig.warnBeforeDays as number) < 1 || (rawConfig.warnBeforeDays as number) > 365) {
      errors.push("config.warnBeforeDays must be an integer between 1 and 365");
    }

    validatedConfig = {
      kind: "ssl",
      host,
      port,
      ...(serverName ? { serverName } : {}),
      timeoutMs,
      warnBeforeDays: Number(rawConfig.warnBeforeDays),
    };
  } else if (kind === "keyword") {
    for (const key of Object.keys(rawConfig)) if (!keywordConfigKeys.has(key)) errors.push(`Unknown config field: ${key}`);
    const url = validateUrl(rawConfig.url, errors);
    const method = String(rawConfig.method);
    if (!keywordMethods.has(method)) errors.push("config.method must be GET or HEAD for keyword monitor");
    if (!Number.isInteger(rawConfig.expectedStatus) || (rawConfig.expectedStatus as number) < 100 || (rawConfig.expectedStatus as number) > 599) {
      errors.push("config.expectedStatus must be between 100 and 599");
    }
    const keyword = typeof rawConfig.keyword === "string" ? rawConfig.keyword : "";
    if (!keyword || keyword.length > 500) errors.push("config.keyword must contain 1-500 characters");
    const matchMode = rawConfig.matchMode as MatchMode;
    if (!["contains", "not_contains"].includes(matchMode)) errors.push("config.matchMode must be 'contains' or 'not_contains'");
    const caseSensitive = typeof rawConfig.caseSensitive === "boolean" ? rawConfig.caseSensitive : false;
    if (!Number.isInteger(rawConfig.maxRedirects) || (rawConfig.maxRedirects as number) < 0 || (rawConfig.maxRedirects as number) > 10) {
      errors.push("config.maxRedirects must be between 0 and 10");
    }
    if (!Number.isInteger(rawConfig.maxResponseBytes) || (rawConfig.maxResponseBytes as number) < 1 || (rawConfig.maxResponseBytes as number) > 1_048_576) {
      errors.push("config.maxResponseBytes must be between 1 and 1048576");
    }
    const timeoutMs = validateTimeout(rawConfig.timeoutMs, errors);

    validatedConfig = {
      kind: "keyword",
      url: url ? url.toString() : "",
      method: method as "GET" | "HEAD",
      expectedStatus: Number(rawConfig.expectedStatus),
      keyword,
      matchMode,
      caseSensitive,
      maxRedirects: Number(rawConfig.maxRedirects),
      maxResponseBytes: Number(rawConfig.maxResponseBytes),
      timeoutMs,
    };
  } else {
    errors.push("config.kind must be one of: http, tcp, ssl, keyword");
    validatedConfig = rawConfig as any;
  }

  let validatedPolicy: IncidentPolicyInput | undefined;
  if (body.incidentPolicy !== undefined) {
    if (typeof body.incidentPolicy !== "object" || body.incidentPolicy === null || Array.isArray(body.incidentPolicy)) {
      errors.push("incidentPolicy must be an object");
    } else {
      const rawPolicy = body.incidentPolicy as Record<string, unknown>;
      for (const key of Object.keys(rawPolicy)) {
        if (!["failureThreshold", "recoveryThreshold"].includes(key)) {
          errors.push(`Unknown incidentPolicy field: ${key}`);
        }
      }
      if (rawPolicy.failureThreshold !== undefined) {
        if (!Number.isInteger(rawPolicy.failureThreshold) || (rawPolicy.failureThreshold as number) < 1 || (rawPolicy.failureThreshold as number) > 5) {
          errors.push("incidentPolicy.failureThreshold must be an integer between 1 and 5");
        }
      }
      if (rawPolicy.recoveryThreshold !== undefined) {
        if (!Number.isInteger(rawPolicy.recoveryThreshold) || (rawPolicy.recoveryThreshold as number) < 1 || (rawPolicy.recoveryThreshold as number) > 5) {
          errors.push("incidentPolicy.recoveryThreshold must be an integer between 1 and 5");
        }
      }
      validatedPolicy = {
        ...(rawPolicy.failureThreshold !== undefined ? { failureThreshold: Number(rawPolicy.failureThreshold) } : {}),
        ...(rawPolicy.recoveryThreshold !== undefined ? { recoveryThreshold: Number(rawPolicy.recoveryThreshold) } : {}),
      };
    }
  }

  const version = body.version;
  if (updating && (!Number.isInteger(version) || (version as number) < 1)) errors.push("version must be a positive integer");
  if (errors.length) fail(errors);

  const monitor: MonitorInput = {
    name,
    intervalSeconds: intervalSeconds as number,
    regions: regions as string[],
    config: validatedConfig,
    ...(validatedPolicy ? { incidentPolicy: validatedPolicy } : {}),
  };
  return updating ? { ...monitor, version: version as number } : monitor;
}

export const validateMonitorCreate = (value: unknown): MonitorInput => validate(value, false) as MonitorInput;
export const validateMonitorUpdate = (value: unknown): MonitorUpdateInput => validate(value, true) as MonitorUpdateInput;
