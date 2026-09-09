export const healthStates = [
  "UNKNOWN",
  "HEALTHY",
  "DEGRADED",
  "PENDING_DOWN",
  "DOWN",
  "PENDING_RECOVERY",
] as const;

export type HealthState = (typeof healthStates)[number];

export type Observation = "QUORUM_PASS" | "SINGLE_REGION_FAILURE" | "QUORUM_FAILURE" | "INSUFFICIENT_RESULTS";

export const allowedTransitions: Readonly<Record<HealthState, readonly HealthState[]>> = {
  UNKNOWN: ["UNKNOWN", "HEALTHY", "DEGRADED", "PENDING_DOWN", "DOWN"],
  HEALTHY: ["HEALTHY", "DEGRADED", "PENDING_DOWN", "DOWN"],
  DEGRADED: ["HEALTHY", "DEGRADED", "PENDING_DOWN", "DOWN"],
  PENDING_DOWN: ["HEALTHY", "DEGRADED", "PENDING_DOWN", "DOWN"],
  DOWN: ["DOWN", "PENDING_RECOVERY", "HEALTHY"],
  PENDING_RECOVERY: ["HEALTHY", "DOWN", "PENDING_RECOVERY"],
};

export function canTransition(from: HealthState, to: HealthState): boolean {
  return allowedTransitions[from].includes(to);
}

export interface StateTransition {
  from: HealthState;
  to: HealthState;
  observation: Observation;
  occurredAt: string;
  reason: string;
}

/** Missing infrastructure is never an explicit monitor failure. */
export function aggregate(outcomes: readonly ("PASS" | "FAIL" | null)[]): Observation {
  if (!outcomes.length) throw new Error("At least one target is required");
  const failures = outcomes.filter((value) => value === "FAIL").length;
  if (failures >= Math.floor(outcomes.length / 2) + 1) return "QUORUM_FAILURE";
  if (outcomes.includes(null)) return "INSUFFICIENT_RESULTS";
  return failures ? "SINGLE_REGION_FAILURE" : "QUORUM_PASS";
}

export function nextHealth(
  state: HealthState,
  observation: Observation,
  failureThreshold = 2,
  recoveryThreshold = 2,
): HealthState {
  if (observation === "QUORUM_FAILURE") {
    if (state === "DOWN" || state === "PENDING_RECOVERY") return "DOWN";
    if (failureThreshold <= 1) return "DOWN";
    return state === "PENDING_DOWN" ? "DOWN" : "PENDING_DOWN";
  }
  if (observation === "QUORUM_PASS") {
    if (state === "DOWN") return recoveryThreshold <= 1 ? "HEALTHY" : "PENDING_RECOVERY";
    if (state === "PENDING_RECOVERY") return "HEALTHY";
    return "HEALTHY";
  }
  if (state === "UNKNOWN" && observation === "INSUFFICIENT_RESULTS") return "UNKNOWN";
  if (state === "DOWN" || state === "PENDING_RECOVERY") return "DOWN";
  return "DEGRADED";
}

export interface Evaluation {
  state: HealthState;
  observation: Observation;
  kind: "SCHEDULED" | "MANUAL" | "EVALUATION";
  sequence: number;
  lastSequence: number;
  currentVersion: number;
  executionVersion: number;
  flappingUntil: number | null;
  recentTransitions: readonly number[];
  consecutiveFailures?: number;
  consecutivePasses?: number;
  failureThreshold?: number;
  recoveryThreshold?: number;
}

/** Clock is supplied by the caller; no framework or storage dependencies. */
export function reduceHealth(input: Evaluation, now: number) {
  const applied = (input.kind === "SCHEDULED" || input.kind === "EVALUATION")
    && input.sequence > input.lastSequence
    && input.currentVersion === input.executionVersion;

  const failureThreshold = Math.max(1, Math.min(5, input.failureThreshold ?? 2));
  const recoveryThreshold = Math.max(1, Math.min(5, input.recoveryThreshold ?? 2));

  let consecutiveFailures = input.consecutiveFailures ?? (input.state === "PENDING_DOWN" ? 1 : 0);
  let consecutivePasses = input.consecutivePasses ?? (input.state === "PENDING_RECOVERY" ? 1 : 0);

  if (applied) {
    if (input.observation === "QUORUM_FAILURE") {
      consecutiveFailures += 1;
      consecutivePasses = 0;
    } else if (input.observation === "QUORUM_PASS") {
      consecutivePasses += 1;
      consecutiveFailures = 0;
    } else {
      consecutiveFailures = 0;
      consecutivePasses = 0;
    }
  }

  let nextState: HealthState = input.state;
  if (applied) {
    if (input.observation === "QUORUM_FAILURE") {
      if (input.state === "DOWN") {
        nextState = "DOWN";
      } else if (consecutiveFailures >= failureThreshold) {
        nextState = "DOWN";
      } else {
        nextState = "PENDING_DOWN";
      }
    } else if (input.observation === "QUORUM_PASS") {
      if (input.state === "DOWN" || input.state === "PENDING_RECOVERY") {
        if (consecutivePasses >= recoveryThreshold) {
          nextState = "HEALTHY";
        } else {
          nextState = "PENDING_RECOVERY";
        }
      } else {
        nextState = "HEALTHY";
      }
    } else if (input.state === "UNKNOWN" && input.observation === "INSUFFICIENT_RESULTS") {
      nextState = "UNKNOWN";
    } else if (input.state === "DOWN" || input.state === "PENDING_RECOVERY") {
      nextState = "DOWN";
    } else {
      nextState = "DEGRADED";
    }
  }

  const state = applied ? nextState : input.state;
  const changed = state !== input.state;
  const recent = input.recentTransitions.filter((time) => time >= now - 600_000 && time <= now);
  const flappingUntil = applied && changed && recent.length + 1 >= 4
    ? Math.max(input.flappingUntil ?? 0, now + 900_000) : input.flappingUntil;

  return {
    applied,
    state,
    changed,
    flappingUntil,
    consecutiveFailures: applied ? consecutiveFailures : (input.consecutiveFailures ?? 0),
    consecutivePasses: applied ? consecutivePasses : (input.consecutivePasses ?? 0),
    openIncident: applied && state === "DOWN" && (flappingUntil ?? 0) <= now,
    resolveIncident: applied && (input.state === "PENDING_RECOVERY" || input.state === "DOWN") && state === "HEALTHY",
  };
}

export const incidentStatuses = ["OPEN", "ACKNOWLEDGED", "RESOLVED"] as const;
export type IncidentStatus = (typeof incidentStatuses)[number];

export function canTransitionIncident(from: IncidentStatus, to: IncidentStatus): boolean {
  if (from === "OPEN") return to === "ACKNOWLEDGED" || to === "RESOLVED";
  if (from === "ACKNOWLEDGED") return to === "RESOLVED";
  return false;
}

export const publicComponentStatuses = ["Operational", "Degraded", "Major outage", "Unknown"] as const;
export type PublicComponentStatus = (typeof publicComponentStatuses)[number];

export function toPublicComponentStatus(health: HealthState): PublicComponentStatus {
  if (health === "HEALTHY") return "Operational";
  if (health === "DOWN") return "Major outage";
  if (health === "UNKNOWN") return "Unknown";
  return "Degraded";
}

export interface UptimeCalculationResult {
  uptimePercentage: number | null;
  coveragePercentage: number;
  availableCount: number;
  unavailableCount: number;
  validCount: number;
  totalCount: number;
}

export function calculateUptime(observations: readonly Observation[]): UptimeCalculationResult {
  const totalCount = observations.length;
  if (totalCount === 0) {
    return {
      uptimePercentage: null,
      coveragePercentage: 0,
      availableCount: 0,
      unavailableCount: 0,
      validCount: 0,
      totalCount: 0,
    };
  }
  const valid = observations.filter((obs) => obs !== "INSUFFICIENT_RESULTS");
  const validCount = valid.length;
  const availableCount = valid.filter((obs) => obs === "QUORUM_PASS" || obs === "SINGLE_REGION_FAILURE").length;
  const unavailableCount = valid.filter((obs) => obs === "QUORUM_FAILURE").length;
  const coveragePercentage = Number(((validCount / totalCount) * 100).toFixed(2));
  const uptimePercentage = validCount === 0 ? null : Number(((availableCount / validCount) * 100).toFixed(2));
  return {
    uptimePercentage,
    coveragePercentage,
    availableCount,
    unavailableCount,
    validCount,
    totalCount,
  };
}

export const deliveryStatuses = ["PENDING", "SENDING", "SENT", "FAILED", "CANCELED"] as const;
export type DeliveryStatus = (typeof deliveryStatuses)[number];

export const RETRY_DELAYS_SECONDS = [5, 30, 120, 300] as const;

export function nextRetryDelaySeconds(currentAttempt: number): number | null {
  if (currentAttempt < 1 || currentAttempt >= 5) return null;
  return RETRY_DELAYS_SECONDS[currentAttempt - 1] ?? null;
}

export const notificationEvents = [
  "notification.queued",
  "notification.sent",
  "notification.failed",
  "notification.canceled",
] as const;
export type NotificationEvent = (typeof notificationEvents)[number];

export function calculateNextAttemptDelay(currentAttempt: number, retryAfterSeconds?: number): number | null {
  const defaultDelay = nextRetryDelaySeconds(currentAttempt);
  if (defaultDelay === null) return null;
  if (retryAfterSeconds !== undefined && retryAfterSeconds > 0) {
    return Math.min(Math.max(retryAfterSeconds, defaultDelay), 900);
  }
  return defaultDelay;
}

