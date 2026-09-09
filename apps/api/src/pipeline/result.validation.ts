import { BadRequestException } from "@nestjs/common";
import type { ProbeResult } from "@argus/contracts";

const allowedKeys = new Set([
  "schemaVersion",
  "executionId",
  "organizationId",
  "monitorId",
  "monitorVersion",
  "probeId",
  "region",
  "startedAt",
  "completedAt",
  "durationMs",
  "outcome",
  "errorCode",
  "errorMessage",
  "http",
  "tcp",
  "ssl",
  "keyword",
]);

const allowedErrorCodes = new Set([
  "DNS",
  "CONNECT",
  "TIMEOUT",
  "TLS",
  "ASSERTION",
  "RESPONSE_TOO_LARGE",
  "SSRF_BLOCKED",
  "INTERNAL",
  "CERT_EXPIRED",
  "CERT_WRONG_HOST",
  "KEYWORD_MISMATCH",
  "STATUS_CODE_MISMATCH",
]);

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateResult(value: unknown): ProbeResult {
  const invalid = (msg = "Result does not match ProbeResult schema") => {
    throw new BadRequestException({ code: "INVALID_RESULT", message: msg });
  };

  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const v = value as Record<string, unknown>;

  if (Object.keys(v).some((key) => !allowedKeys.has(key))) return invalid();
  if (v.schemaVersion !== "0.1" && v.schemaVersion !== "0.2") return invalid("Invalid schemaVersion");

  for (const key of ["executionId", "organizationId", "monitorId"]) {
    if (typeof v[key] !== "string" || !uuid.test(v[key])) return invalid(`Invalid ${key}`);
  }
  for (const key of ["probeId", "region"]) {
    if (typeof v[key] !== "string" || !v[key].length) return invalid(`Invalid ${key}`);
  }
  for (const key of ["startedAt", "completedAt"]) {
    if (typeof v[key] !== "string" || !/^\d{4}-\d\d-\d\dT/.test(v[key]) || !Number.isFinite(Date.parse(v[key]))) {
      return invalid(`Invalid ${key}`);
    }
  }

  if (
    !Number.isSafeInteger(v.monitorVersion) ||
    Number(v.monitorVersion) < 1 ||
    !Number.isSafeInteger(v.durationMs) ||
    Number(v.durationMs) < 0
  ) {
    return invalid();
  }
  if (Date.parse(String(v.completedAt)) < Date.parse(String(v.startedAt))) return invalid();
  if (v.outcome !== "PASS" && v.outcome !== "FAIL") return invalid();

  if (v.errorCode !== undefined && !allowedErrorCodes.has(String(v.errorCode))) return invalid("Invalid errorCode");
  if (v.errorMessage !== undefined && typeof v.errorMessage !== "string") return invalid();
  if (v.outcome === "FAIL" && (v.errorCode === undefined || v.errorMessage === undefined)) return invalid();

  if (v.http !== undefined) {
    if (!v.http || typeof v.http !== "object" || Array.isArray(v.http)) return invalid();
    const http = v.http as Record<string, unknown>;
    if (
      Object.keys(http).some((key) => !["statusCode", "responseBytes"].includes(key)) ||
      !Number.isInteger(http.statusCode) ||
      Number(http.statusCode) < 100 ||
      Number(http.statusCode) > 599 ||
      !Number.isSafeInteger(http.responseBytes) ||
      Number(http.responseBytes) < 0
    ) {
      return invalid();
    }
  }

  if (v.tcp !== undefined) {
    if (!v.tcp || typeof v.tcp !== "object" || Array.isArray(v.tcp)) return invalid();
    const tcp = v.tcp as Record<string, unknown>;
    if (Object.keys(tcp).some((key) => key !== "connected") || typeof tcp.connected !== "boolean") {
      return invalid();
    }
  }

  if (v.ssl !== undefined) {
    if (!v.ssl || typeof v.ssl !== "object" || Array.isArray(v.ssl)) return invalid();
    const ssl = v.ssl as Record<string, unknown>;
    if (
      Object.keys(ssl).some((key) => !["expiresAt", "daysRemaining"].includes(key)) ||
      typeof ssl.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(ssl.expiresAt)) ||
      !Number.isInteger(ssl.daysRemaining)
    ) {
      return invalid();
    }
  }

  if (v.keyword !== undefined) {
    if (!v.keyword || typeof v.keyword !== "object" || Array.isArray(v.keyword)) return invalid();
    const kw = v.keyword as Record<string, unknown>;
    if (
      Object.keys(kw).some((key) => !["statusCode", "responseBytes", "matched"].includes(key)) ||
      !Number.isInteger(kw.statusCode) ||
      Number(kw.statusCode) < 100 ||
      Number(kw.statusCode) > 599 ||
      !Number.isSafeInteger(kw.responseBytes) ||
      Number(kw.responseBytes) < 0 ||
      typeof kw.matched !== "boolean"
    ) {
      return invalid();
    }
  }

  return value as ProbeResult;
}
