import { describe, expect, it } from "vitest";
import { validateResult } from "./result.validation";
import { digestToken, probeKey } from "./probe-auth";

const result = { schemaVersion: "0.1", executionId: "11111111-1111-4111-8111-111111111111", organizationId: "22222222-2222-4222-8222-222222222222",
  monitorId: "33333333-3333-4333-8333-333333333333", monitorVersion: 1, probeId: "p", region: "test", startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:00:01Z", durationMs: 1000, outcome: "PASS" };
describe("probe input boundaries", () => {
  it("accepts v0.1", () => expect(validateResult(result)).toEqual(result));
  it.each([{ outcome: "FAIL" }, { monitorVersion: 0 }, { organizationId: "invalid" }, { durationMs: -1 },
    { completedAt: "2025-01-01T00:00:00Z" }, { unexpected: true }, { http: { statusCode: 200, responseBytes: -1 } }])("rejects %j", (changes) => {
    expect(() => validateResult({ ...result, ...changes })).toThrow();
  });
  it("requires production HMAC and rejects development seeds", () => {
    expect(() => probeKey({ NODE_ENV: "production" })).toThrow();
    expect(() => probeKey({ NODE_ENV: "staging", PROBE_TOKEN_HMAC_KEY: "x".repeat(32), SEED_DEV_PROBES: "true" })).toThrow();
    expect(digestToken("token", "a")).not.toBe(digestToken("token", "b"));
  });
});
