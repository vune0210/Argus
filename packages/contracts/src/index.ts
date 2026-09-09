import type { MonitorConfig } from "./probe.gen";

export type {
  HttpMethod,
  HttpMonitorConfig,
  TcpMonitorConfig,
  SslMonitorConfig,
  KeywordMonitorConfig,
  MonitorConfig,
  TcpResult,
  SslResult,
  KeywordResult,
  MatchMode,
  ProbeErrorCode,
  ProbeJob,
  ProbeOutcome,
  ProbeResult,
} from "./probe.gen";

export const API_VERSION = "v1" as const;

export type Role = "OWNER" | "ADMIN" | "RESPONDER" | "VIEWER";
export type HealthState =
  | "UNKNOWN"
  | "HEALTHY"
  | "DEGRADED"
  | "PENDING_DOWN"
  | "DOWN"
  | "PENDING_RECOVERY";

export interface IncidentPolicy {
  failureThreshold?: number;
  recoveryThreshold?: number;
}

export interface CreateMonitorRequest {
  name: string;
  intervalSeconds: number;
  regions: string[];
  config: MonitorConfig;
  incidentPolicy?: IncidentPolicy;
}

export interface UpdateMonitorRequest extends CreateMonitorRequest {
  version: number;
}

export interface Monitor {
  id: string;
  organizationId: string;
  name: string;
  intervalSeconds: number;
  regions: string[];
  healthState: HealthState;
  version: number;
  config: MonitorConfig;
  incidentPolicy: {
    failureThreshold: number;
    recoveryThreshold: number;
  };
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
}

export interface EventEnvelope<T = unknown> {
  id: string;
  type: string;
  version: number;
  occurredAt: string;
  organizationId: string;
  correlationId: string;
  payload: T;
}

export interface ErrorEnvelope {
  code: string;
  message: string;
  details?: unknown;
  traceId: string;
}

export interface BootstrapResponse {
  user: { id: string; email: string };
  organization: { id: string; name: string; role: Role };
}

export type {
  ExecutionSummary,
  ExecutionTarget,
  ExecutionDetail,
  ExecutionPage,
  ProbeLease,
  ResultReceipt,
  LeaseHeartbeat,
  Incident,
  IncidentEvent,
  IncidentDetail,
  IncidentPage,
  NotificationDelivery,
  NotificationChannel,
  NotificationChannelPage,
  CreateNotificationChannelRequest,
  UpdateNotificationChannelRequest,
  EscalationStep,
  EscalationPolicy,
  UpdateEscalationPolicyRequest,
  StatusPageComponent,
  StatusPage,
  StatusPageSummary,
  StatusPageListPage,
  CreateStatusPageRequest,
  UpdateStatusPageRequest,
  AddStatusPageComponentRequest,
  PublicStatusUptimeWindow,
  PublicStatusComponent,
  PublicIncidentUpdate,
  PublicIncident,
  PublicStatusPage,
  EvaluateMonitorRequest,
  TimeSeriesPoint,
  MonitorTimeSeriesResponse,
} from "./api.gen";
export type ExecutionObservation = NonNullable<import("./api.gen").ExecutionSummary["observation"]>;
export type { RegionSnapshot, MonitorSnapshot } from "./api.gen";
