import { describe, expect, it } from "vitest";
import {
  calculateNextAttemptDelay,
  calculateUptime,
  canTransition,
  canTransitionIncident,
  healthStates,
  nextRetryDelaySeconds,
  toPublicComponentStatus,
} from "./index.js";

describe("health transition contract", () => {
  it("defines every planned state", () => {
    expect(healthStates).toEqual([
      "UNKNOWN",
      "HEALTHY",
      "DEGRADED",
      "PENDING_DOWN",
      "DOWN",
      "PENDING_RECOVERY",
    ]);
  });

  it("allows the pending failure and recovery paths", () => {
    expect(canTransition("HEALTHY", "PENDING_DOWN")).toBe(true);
    expect(canTransition("PENDING_DOWN", "DOWN")).toBe(true);
    expect(canTransition("DOWN", "PENDING_RECOVERY")).toBe(true);
    expect(canTransition("PENDING_RECOVERY", "HEALTHY")).toBe(true);
  });

  it("rejects impossible jumps", () => {
    expect(canTransition("HEALTHY", "PENDING_RECOVERY")).toBe(false);
  });
});

describe("incident lifecycle contract", () => {
  it("allows OPEN to ACKNOWLEDGED and RESOLVED", () => {
    expect(canTransitionIncident("OPEN", "ACKNOWLEDGED")).toBe(true);
    expect(canTransitionIncident("OPEN", "RESOLVED")).toBe(true);
    expect(canTransitionIncident("OPEN", "OPEN")).toBe(false);
  });

  it("allows ACKNOWLEDGED to RESOLVED", () => {
    expect(canTransitionIncident("ACKNOWLEDGED", "RESOLVED")).toBe(true);
    expect(canTransitionIncident("ACKNOWLEDGED", "OPEN")).toBe(false);
    expect(canTransitionIncident("ACKNOWLEDGED", "ACKNOWLEDGED")).toBe(false);
  });

  it("does not allow transitions out of RESOLVED", () => {
    expect(canTransitionIncident("RESOLVED", "OPEN")).toBe(false);
    expect(canTransitionIncident("RESOLVED", "ACKNOWLEDGED")).toBe(false);
    expect(canTransitionIncident("RESOLVED", "RESOLVED")).toBe(false);
  });
});

describe("public component status mapping", () => {
  it("maps HEALTHY to Operational", () => {
    expect(toPublicComponentStatus("HEALTHY")).toBe("Operational");
  });

  it("maps DOWN to Major outage", () => {
    expect(toPublicComponentStatus("DOWN")).toBe("Major outage");
  });

  it("maps UNKNOWN to Unknown", () => {
    expect(toPublicComponentStatus("UNKNOWN")).toBe("Unknown");
  });

  it("maps DEGRADED, PENDING_DOWN, PENDING_RECOVERY to Degraded", () => {
    expect(toPublicComponentStatus("DEGRADED")).toBe("Degraded");
    expect(toPublicComponentStatus("PENDING_DOWN")).toBe("Degraded");
    expect(toPublicComponentStatus("PENDING_RECOVERY")).toBe("Degraded");
  });
});

describe("uptime and coverage calculator", () => {
  it("handles empty samples", () => {
    const res = calculateUptime([]);
    expect(res.uptimePercentage).toBeNull();
    expect(res.coveragePercentage).toBe(0);
  });

  it("counts QUORUM_PASS and SINGLE_REGION_FAILURE as available, excludes INSUFFICIENT_RESULTS", () => {
    const res = calculateUptime([
      "QUORUM_PASS",
      "SINGLE_REGION_FAILURE",
      "QUORUM_FAILURE",
      "INSUFFICIENT_RESULTS",
    ]);
    expect(res.totalCount).toBe(4);
    expect(res.validCount).toBe(3);
    expect(res.availableCount).toBe(2);
    expect(res.unavailableCount).toBe(1);
    expect(res.coveragePercentage).toBe(75);
    expect(res.uptimePercentage).toBe(66.67);
  });
});

describe("notification retry delays", () => {
  it("returns configured delays for attempts 1 through 4", () => {
    expect(nextRetryDelaySeconds(1)).toBe(5);
    expect(nextRetryDelaySeconds(2)).toBe(30);
    expect(nextRetryDelaySeconds(3)).toBe(120);
    expect(nextRetryDelaySeconds(4)).toBe(300);
    expect(nextRetryDelaySeconds(5)).toBeNull();
  });

  it("calculates next attempt delay with Retry-After override up to 15m cap", () => {
    // Retry-After smaller than default backoff uses default
    expect(calculateNextAttemptDelay(1, 2)).toBe(5);
    // Retry-After larger than default uses Retry-After
    expect(calculateNextAttemptDelay(1, 45)).toBe(45);
    // Retry-After capped at 900s (15 minutes)
    expect(calculateNextAttemptDelay(2, 1200)).toBe(900);
    // Terminal attempt 5 returns null
    expect(calculateNextAttemptDelay(5, 60)).toBeNull();
  });
});

