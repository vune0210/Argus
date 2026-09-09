// Code generated from OpenAPI v0.2. DO NOT EDIT.
import type { ProbeJob, ProbeResult } from "./probe.gen";

export type ExecutionSummary = {
  id: string;
  organizationId: string;
  monitorId: string;
  monitorVersion: number;
  kind: "SCHEDULED" | "MANUAL" | "EVALUATION";
  status: "QUEUED" | "RUNNING" | "COMPLETED";
  scheduledAt: string;
  deadlineAt: string;
  completedAt: string | null;
  observation: "QUORUM_PASS" | "QUORUM_FAILURE" | "SINGLE_REGION_FAILURE" | "INSUFFICIENT_RESULTS" | null;
};

export type ExecutionTarget = {
  id: string;
  region: string;
  status: "QUEUED" | "LEASED" | "COMPLETED" | "EXPIRED" | "DEAD";
  attempts: number;
  result: ProbeResult | null;
};

export type ExecutionDetail = {
  id: string;
  organizationId: string;
  monitorId: string;
  monitorVersion: number;
  kind: "SCHEDULED" | "MANUAL" | "EVALUATION";
  status: "QUEUED" | "RUNNING" | "COMPLETED";
  scheduledAt: string;
  deadlineAt: string;
  completedAt: string | null;
  observation: "QUORUM_PASS" | "QUORUM_FAILURE" | "SINGLE_REGION_FAILURE" | "INSUFFICIENT_RESULTS" | null;
  targets: Array<ExecutionTarget>;
};

export type ExecutionPage = {
  items: Array<ExecutionSummary>;
};

export type ProbeLease = {
  leaseId: string;
  expiresAt: string;
  targetRegion: string;
  job: ProbeJob;
};

export type ResultReceipt = {
  receiptId: string;
  receivedAt: string;
  duplicate: boolean;
};

export type LeaseHeartbeat = {
  expiresAt: string;
};

export type Incident = {
  id: string;
  organizationId: string;
  monitorId: string;
  status: "OPEN" | "ACKNOWLEDGED" | "RESOLVED";
  openedAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
};

export type IncidentEvent = {
  id: string;
  executionId: string | null;
  type: "OPENED" | "ACKNOWLEDGED" | "RESOLVED";
  occurredAt: string;
  actor: string | null;
};

export type NotificationDelivery = {
  id: string;
  incidentId: string;
  escalationStepId?: string | null;
  channelId: string;
  eventKind: "INCIDENT_OPENED" | "INCIDENT_RESOLVED";
  status: "PENDING" | "SENDING" | "SENT" | "FAILED" | "CANCELED";
  attempts: number;
  scheduledAt: string;
  nextAttemptAt: string;
  lastAttemptedAt: string | null;
  lastError: string | null;
};

export type IncidentDetail = {
  id: string;
  organizationId: string;
  monitorId: string;
  status: "OPEN" | "ACKNOWLEDGED" | "RESOLVED";
  openedAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  events: Array<IncidentEvent>;
  deliveries: Array<NotificationDelivery>;
};

export type IncidentPage = {
  items: Array<Incident>;
};

export type RegionSnapshot = {
  region: string;
  executionId: string | null;
  executionSequence: string | null;
  outcome: "PASS" | "FAIL" | null;
  latencyMs: number | null;
  completedAt: string | null;
  receivedAt: string | null;
  freshness: "NO_DATA" | "FRESH" | "STALE";
  heartbeat: {
  status: "ALIVE" | "STALE" | "UNKNOWN";
  lastSeenAt: string | null;
};
};

export type MonitorSnapshot = {
  organizationId: string;
  monitorId: string;
  monitorVersion: number;
  healthState: "UNKNOWN" | "HEALTHY" | "DEGRADED" | "PENDING_DOWN" | "DOWN" | "PENDING_RECOVERY";
  observedAt: string;
  regions: Array<RegionSnapshot>;
};

export type NotificationChannel = {
  id: string;
  organizationId: string;
  type: "SLACK" | "EMAIL";
  name: string;
  config: {
  secretArn?: string;
  recipient?: string;
};
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type NotificationChannelPage = {
  items: Array<NotificationChannel>;
};

export type CreateNotificationChannelRequest = {
  type: "SLACK" | "EMAIL";
  name: string;
  config: {
  secretArn?: string;
  recipient?: string;
};
  enabled?: boolean;
};

export type UpdateNotificationChannelRequest = {
  name?: string;
  config?: {
  secretArn?: string;
  recipient?: string;
};
  enabled?: boolean;
};

export type EscalationStep = {
  id: string;
  stepOrder: number;
  delaySeconds: number;
  channelIds: Array<string>;
  channelId?: string;
};

export type EscalationPolicy = {
  id: string;
  organizationId: string;
  name: string;
  steps: Array<EscalationStep>;
};

export type UpdateEscalationPolicyRequest = {
  name?: string;
  steps: Array<{
  stepOrder: number;
  delaySeconds: number;
  channelIds?: Array<string>;
  channelId?: string;
}>;
};

export type StatusPageComponent = {
  id: string;
  statusPageId: string;
  monitorId: string;
  publicName: string;
  position: number;
  displayOrder?: number;
};

export type StatusPage = {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  description?: string | null;
  published: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  components: Array<StatusPageComponent>;
};

export type StatusPageSummary = {
  id: string;
  name: string;
  slug: string;
  published: boolean;
  version: number;
  componentCount: number;
};

export type StatusPageListPage = {
  items: Array<StatusPageSummary>;
};

export type CreateStatusPageRequest = {
  name: string;
  slug: string;
  description?: string;
  published?: boolean;
  components?: Array<AddStatusPageComponentRequest>;
};

export type UpdateStatusPageRequest = {
  version: number;
  name?: string;
  slug?: string;
  description?: string;
  published?: boolean;
  components?: Array<AddStatusPageComponentRequest>;
};

export type AddStatusPageComponentRequest = {
  monitorId: string;
  publicName: string;
  displayOrder?: number;
};

export type PublicStatusUptimeWindow = {
  percentage: number | null;
  coverage: number;
};

export type PublicStatusComponent = {
  name: string;
  status: "OPERATIONAL" | "DEGRADED" | "MAJOR_OUTAGE" | "UNKNOWN";
  uptime: {
  last24Hours: number | null;
  last7Days: number | null;
  last30Days: number | null;
};
  coverage: {
  last24Hours: number;
  last7Days: number;
  last30Days: number;
};
};

export type PublicIncidentUpdate = {
  id: string;
  type: "OPENED" | "ACKNOWLEDGED" | "RESOLVED";
  occurredAt: string;
};

export type PublicIncident = {
  componentName: string;
  status: "OPEN" | "ACKNOWLEDGED" | "RESOLVED";
  openedAt: string;
  resolvedAt: string | null;
};

export type PublicStatusPage = {
  name: string;
  slug: string;
  description?: string | null;
  overallStatus: "OPERATIONAL" | "DEGRADED" | "MAJOR_OUTAGE" | "UNKNOWN";
  updatedAt: string;
  components: Array<PublicStatusComponent>;
  incidents: Array<PublicIncident>;
};

export type IncidentPolicy = {
  failureThreshold: number;
  recoveryThreshold: number;
};

export type EvaluateMonitorRequest = {
  monitorVersion: number;
};

export type TimeSeriesPoint = {
  executionId: string;
  time: string;
  kind: "SCHEDULED" | "MANUAL" | "EVALUATION";
  outcome: "PASS" | "FAIL" | null;
  latencyMs: number | null;
};

export type MonitorTimeSeriesResponse = {
  monitorId: string;
  from: string;
  to: string;
  truncated: boolean;
  series: Record<string, Array<TimeSeriesPoint>>;
};
