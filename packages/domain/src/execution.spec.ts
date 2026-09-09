import { describe, expect, it } from "vitest";
import { aggregate, healthStates, nextHealth, reduceHealth, type Evaluation, type HealthState, type Observation } from "./index.js";

const observations: Observation[] = ["QUORUM_PASS", "SINGLE_REGION_FAILURE", "QUORUM_FAILURE", "INSUFFICIENT_RESULTS"];
const table: Record<HealthState, HealthState[]> = {
  UNKNOWN: ["HEALTHY", "DEGRADED", "PENDING_DOWN", "UNKNOWN"],
  HEALTHY: ["HEALTHY", "DEGRADED", "PENDING_DOWN", "DEGRADED"],
  DEGRADED: ["HEALTHY", "DEGRADED", "PENDING_DOWN", "DEGRADED"],
  PENDING_DOWN: ["HEALTHY", "DEGRADED", "DOWN", "DEGRADED"],
  DOWN: ["PENDING_RECOVERY", "DOWN", "DOWN", "DOWN"],
  PENDING_RECOVERY: ["HEALTHY", "DOWN", "DOWN", "DOWN"],
};
describe("execution aggregation and health", () => {
  for (const state of healthStates) for (const [i, observation] of observations.entries()) {
    it(`${state} + ${observation}`, () => expect(nextHealth(state, observation)).toBe(table[state][i]));
  }
  it.each([
    [["PASS", "PASS", "PASS"], "QUORUM_PASS"],
    [["FAIL", "PASS", "PASS"], "SINGLE_REGION_FAILURE"],
    [["FAIL", "FAIL", null], "QUORUM_FAILURE"],
    [["PASS", "PASS", null], "INSUFFICIENT_RESULTS"],
    [["FAIL", null, null], "INSUFFICIENT_RESULTS"],
    [[null], "INSUFFICIENT_RESULTS"],
    [["FAIL", "PASS"], "SINGLE_REGION_FAILURE"],
  ] as const)("aggregates %j", (values, expected) => expect(aggregate(values)).toBe(expected));
  const base: Evaluation = { state: "PENDING_DOWN", observation: "QUORUM_FAILURE", kind: "SCHEDULED", sequence: 3,
    lastSequence: 2, currentVersion: 1, executionVersion: 1, flappingUntil: null, recentTransitions: [] };
  it.each([{ kind: "MANUAL" as const }, { sequence: 2 }, { sequence: 1 }, { executionVersion: 2 }])("ignores diagnostic, duplicate, old execution %j", (change) => {
    expect(reduceHealth({ ...base, ...change }, 1_000_000)).toMatchObject({ applied: false, state: "PENDING_DOWN", openIncident: false });
  });
  it("suppresses a fourth transition and allows opening after expiry", () => {
    const result = reduceHealth({ ...base, recentTransitions: [500_000, 600_000, 900_000] }, 1_000_000);
    expect(result).toMatchObject({ state: "DOWN", openIncident: false, flappingUntil: 1_900_000 });
    expect(reduceHealth({ ...base, state: "DOWN", flappingUntil: result.flappingUntil }, 1_900_001).openIncident).toBe(true);
  });
  it("requires two clean passes to resolve", () => {
    expect(reduceHealth({ ...base, state: "DOWN", observation: "QUORUM_PASS" }, 0).resolveIncident).toBe(false);
    expect(reduceHealth({ ...base, state: "PENDING_RECOVERY", observation: "QUORUM_PASS" }, 0).resolveIncident).toBe(true);
  });

  describe("incident policy thresholds (1..5) and EVALUATION kind", () => {
    it("EVALUATION applies health update and opens incident like SCHEDULED", () => {
      const res = reduceHealth({ ...base, kind: "EVALUATION" }, 1_000_000);
      expect(res.applied).toBe(true);
      expect(res.state).toBe("DOWN");
      expect(res.openIncident).toBe(true);
    });

    it("MANUAL is always diagnostic and never changes health or opens incident", () => {
      const res = reduceHealth({ ...base, kind: "MANUAL" }, 1_000_000);
      expect(res.applied).toBe(false);
      expect(res.state).toBe("PENDING_DOWN");
      expect(res.openIncident).toBe(false);
    });

    it("threshold 1/1 triggers immediate DOWN and immediate resolve", () => {
      // 1 failure from HEALTHY -> immediate DOWN and open incident
      const fail = reduceHealth({
        ...base,
        state: "HEALTHY",
        observation: "QUORUM_FAILURE",
        consecutiveFailures: 0,
        failureThreshold: 1,
        recoveryThreshold: 1,
      }, 1_000_000);
      expect(fail.state).toBe("DOWN");
      expect(fail.openIncident).toBe(true);
      expect(fail.consecutiveFailures).toBe(1);

      // 1 pass from DOWN -> immediate HEALTHY and resolve incident
      const pass = reduceHealth({
        ...base,
        state: "DOWN",
        observation: "QUORUM_PASS",
        consecutivePasses: 0,
        failureThreshold: 1,
        recoveryThreshold: 1,
      }, 1_000_000);
      expect(pass.state).toBe("HEALTHY");
      expect(pass.resolveIncident).toBe(true);
      expect(pass.consecutivePasses).toBe(1);
    });

    it("threshold 3/3 requires 3 failures to DOWN and 3 passes to HEALTHY", () => {
      // 1st failure
      const f1 = reduceHealth({
        ...base,
        state: "HEALTHY",
        observation: "QUORUM_FAILURE",
        consecutiveFailures: 0,
        failureThreshold: 3,
        recoveryThreshold: 3,
      }, 1_000_000);
      expect(f1.state).toBe("PENDING_DOWN");
      expect(f1.openIncident).toBe(false);
      expect(f1.consecutiveFailures).toBe(1);

      // 2nd failure
      const f2 = reduceHealth({
        ...base,
        state: "PENDING_DOWN",
        observation: "QUORUM_FAILURE",
        consecutiveFailures: 1,
        failureThreshold: 3,
        recoveryThreshold: 3,
      }, 1_000_000);
      expect(f2.state).toBe("PENDING_DOWN");
      expect(f2.openIncident).toBe(false);
      expect(f2.consecutiveFailures).toBe(2);

      // 3rd failure -> DOWN
      const f3 = reduceHealth({
        ...base,
        state: "PENDING_DOWN",
        observation: "QUORUM_FAILURE",
        consecutiveFailures: 2,
        failureThreshold: 3,
        recoveryThreshold: 3,
      }, 1_000_000);
      expect(f3.state).toBe("DOWN");
      expect(f3.openIncident).toBe(true);
      expect(f3.consecutiveFailures).toBe(3);

      // 1st pass from DOWN
      const p1 = reduceHealth({
        ...base,
        state: "DOWN",
        observation: "QUORUM_PASS",
        consecutivePasses: 0,
        failureThreshold: 3,
        recoveryThreshold: 3,
      }, 1_000_000);
      expect(p1.state).toBe("PENDING_RECOVERY");
      expect(p1.resolveIncident).toBe(false);
      expect(p1.consecutivePasses).toBe(1);

      // 2nd pass
      const p2 = reduceHealth({
        ...base,
        state: "PENDING_RECOVERY",
        observation: "QUORUM_PASS",
        consecutivePasses: 1,
        failureThreshold: 3,
        recoveryThreshold: 3,
      }, 1_000_000);
      expect(p2.state).toBe("PENDING_RECOVERY");
      expect(p2.resolveIncident).toBe(false);
      expect(p2.consecutivePasses).toBe(2);

      // 3rd pass -> HEALTHY
      const p3 = reduceHealth({
        ...base,
        state: "PENDING_RECOVERY",
        observation: "QUORUM_PASS",
        consecutivePasses: 2,
        failureThreshold: 3,
        recoveryThreshold: 3,
      }, 1_000_000);
      expect(p3.state).toBe("HEALTHY");
      expect(p3.resolveIncident).toBe(true);
      expect(p3.consecutivePasses).toBe(3);
    });

    it("resets opposing counters when outcome changes", () => {
      // Pass resets failure counter
      const pass = reduceHealth({
        ...base,
        state: "HEALTHY",
        observation: "QUORUM_PASS",
        consecutiveFailures: 2,
        consecutivePasses: 0,
      }, 1_000_000);
      expect(pass.consecutiveFailures).toBe(0);
      expect(pass.consecutivePasses).toBe(1);

      // Failure resets pass counter
      const fail = reduceHealth({
        ...base,
        state: "DOWN",
        observation: "QUORUM_FAILURE",
        consecutiveFailures: 0,
        consecutivePasses: 2,
      }, 1_000_000);
      expect(fail.consecutivePasses).toBe(0);
      expect(fail.consecutiveFailures).toBe(1);
    });
  });
});

