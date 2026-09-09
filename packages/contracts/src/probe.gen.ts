// Code generated from the Argus v0.2 JSON Schemas. DO NOT EDIT BY HAND.

export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
export type MatchMode = "CONTAINS" | "NOT_CONTAINS";
export type ProbeOutcome = "PASS" | "FAIL";
export type ProbeErrorCode = "DNS" | "CONNECT" | "TIMEOUT" | "TLS" | "ASSERTION" | "RESPONSE_TOO_LARGE" | "SSRF_BLOCKED" | "INTERNAL";

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
