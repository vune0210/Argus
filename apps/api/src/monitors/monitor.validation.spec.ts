import { describe, expect, it } from "vitest";
import { validateMonitorCreate } from "./monitor.validation";

const valid = {
  name: "Public API",
  intervalSeconds: 60,
  regions: ["ap-southeast-1", "ap-northeast-1", "eu-central-1"],
  config: {
    kind: "http",
    url: "https://example.com/health",
    method: "GET",
    timeoutMs: 5000,
    expectedStatus: 200,
    maxRedirects: 5,
    maxResponseBytes: 1_048_576,
  },
};

describe("monitor validation", () => {
  it("normalizes a valid HTTP monitor", () => {
    const res = validateMonitorCreate(valid);
    expect(res.config.kind).toBe("http");
    if (res.config.kind === "http") {
      expect(res.config.url).toBe("https://example.com/health");
    }
  });

  it("rejects an interval below 60 seconds", () => {
    expect(() => validateMonitorCreate({ ...valid, intervalSeconds: 10 })).toThrow();
  });

  it("rejects non-HTTP protocols and unknown fields", () => {
    expect(() => validateMonitorCreate({ ...valid, unexpected: true, config: { ...valid.config, url: "file:///etc/passwd" } })).toThrow();
  });

  it("validates a valid TCP monitor", () => {
    const res = validateMonitorCreate({
      name: "TCP Port 8080",
      intervalSeconds: 60,
      regions: ["ap-southeast-1"],
      config: { kind: "tcp", host: "example.com", port: 8080, timeoutMs: 3000 },
    });
    expect(res.config.kind).toBe("tcp");
    if (res.config.kind === "tcp") {
      expect(res.config.port).toBe(8080);
    }
  });

  it("rejects invalid TCP port", () => {
    expect(() => validateMonitorCreate({
      name: "TCP Invalid",
      intervalSeconds: 60,
      regions: ["ap-southeast-1"],
      config: { kind: "tcp", host: "example.com", port: 70000, timeoutMs: 3000 },
    })).toThrow();
  });

  it("validates a valid SSL monitor", () => {
    const res = validateMonitorCreate({
      name: "SSL Cert Check",
      intervalSeconds: 120,
      regions: ["ap-southeast-1"],
      config: { kind: "ssl", host: "example.com", port: 443, warnBeforeDays: 30, timeoutMs: 5000 },
    });
    expect(res.config.kind).toBe("ssl");
    if (res.config.kind === "ssl") {
      expect(res.config.warnBeforeDays).toBe(30);
    }
  });

  it("validates a valid Keyword monitor", () => {
    const res = validateMonitorCreate({
      name: "Keyword Check",
      intervalSeconds: 60,
      regions: ["ap-southeast-1"],
      config: {
        kind: "keyword",
        url: "https://example.com",
        method: "GET",
        expectedStatus: 200,
        keyword: "healthy",
        matchMode: "contains",
        caseSensitive: true,
        maxRedirects: 3,
        maxResponseBytes: 100000,
        timeoutMs: 5000,
      },
    });
    expect(res.config.kind).toBe("keyword");
    if (res.config.kind === "keyword") {
      expect(res.config.keyword).toBe("healthy");
      expect(res.config.matchMode).toBe("contains");
    }
  });

  describe("incidentPolicy validation", () => {
    it("accepts valid failureThreshold and recoveryThreshold (1..5)", () => {
      const res = validateMonitorCreate({
        ...valid,
        incidentPolicy: { failureThreshold: 1, recoveryThreshold: 5 },
      });
      expect(res.incidentPolicy).toEqual({ failureThreshold: 1, recoveryThreshold: 5 });
    });

    it("accepts partial incidentPolicy", () => {
      const res = validateMonitorCreate({
        ...valid,
        incidentPolicy: { failureThreshold: 3 },
      });
      expect(res.incidentPolicy).toEqual({ failureThreshold: 3 });
    });

    it.each([0, 6, -1, 1.5, "2"])("rejects invalid failureThreshold %s", (val) => {
      expect(() => validateMonitorCreate({
        ...valid,
        incidentPolicy: { failureThreshold: val },
      })).toThrow();
    });

    it.each([0, 6, -1, 1.5, "2"])("rejects invalid recoveryThreshold %s", (val) => {
      expect(() => validateMonitorCreate({
        ...valid,
        incidentPolicy: { recoveryThreshold: val },
      })).toThrow();
    });

    it("rejects unknown fields in incidentPolicy", () => {
      expect(() => validateMonitorCreate({
        ...valid,
        incidentPolicy: { failureThreshold: 2, unknownKey: "bad" },
      })).toThrow();
    });

    it("rejects non-object incidentPolicy", () => {
      expect(() => validateMonitorCreate({
        ...valid,
        incidentPolicy: "not-an-object",
      })).toThrow();
    });
  });
});

