import type { BootstrapResponse, CreateMonitorRequest, ErrorEnvelope, Monitor } from "@argus/contracts";

export type MonitorPayload = CreateMonitorRequest;

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly envelope: ErrorEnvelope) {
    super(envelope.message);
  }
}

async function request<T>(path: string, options: RequestInit = {}, organizationId?: string): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body) headers.set("content-type", "application/json");
  if (organizationId) headers.set("x-argus-organization-id", organizationId);
  const response = await fetch(`/api/backend${path}`, { ...options, headers, cache: "no-store" });
  if (!response.ok) {
    const envelope = await response.json().catch(() => ({ code: `HTTP_${response.status}`, message: "Request failed", traceId: "unknown" })) as ErrorEnvelope;
    throw new ApiError(response.status, envelope);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const bootstrap = () => request<BootstrapResponse>("/api/v1/auth/bootstrap", { method: "POST" });
export const listMonitors = (organizationId: string) => request<{ items: Monitor[]; nextCursor: null }>("/api/v1/monitors", {}, organizationId);
export const createMonitor = (organizationId: string, value: MonitorPayload) => request<Monitor>("/api/v1/monitors", { method: "POST", body: JSON.stringify(value) }, organizationId);
export const updateMonitor = (organizationId: string, monitor: Monitor, value: MonitorPayload) => request<Monitor>(
  `/api/v1/monitors/${monitor.id}`,
  { method: "PATCH", body: JSON.stringify({ ...value, version: monitor.version }) },
  organizationId,
);
export const deleteMonitor = (organizationId: string, id: string) => request<void>(`/api/v1/monitors/${id}`, { method: "DELETE" }, organizationId);

export const getMonitor = (org: string, id: string) => request<Monitor>(`/api/v1/monitors/${id}`, {}, org);
export const getMonitorSnapshot = (org: string, id: string) => request<import("@argus/contracts").MonitorSnapshot>(`/api/v1/monitors/${id}/snapshot`, {}, org);
export const runMonitor = (org: string, id: string) => request<import("@argus/contracts").ExecutionSummary>(`/api/v1/monitors/${id}/run`, { method: "POST" }, org);
export const evaluateMonitor = (org: string, id: string, monitorVersion: number, idempotencyKey?: string) =>
  request<import("@argus/contracts").ExecutionSummary>(
    `/api/v1/monitors/${id}/evaluate`,
    {
      method: "POST",
      headers: {
        "idempotency-key": idempotencyKey ?? (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : "00000000-0000-0000-0000-000000000000"),
      },
      body: JSON.stringify({ monitorVersion }),
    },
    org,
  );
export const getMonitorTimeseries = (org: string, id: string, window: "1h" | "6h" | "24h" = "24h") =>
  request<import("@argus/contracts").MonitorTimeSeriesResponse>(`/api/v1/monitors/${id}/timeseries?window=${window}`, {}, org);
export const listExecutions = (org: string, id: string) => request<{ items: import("@argus/contracts").ExecutionSummary[] }>(`/api/v1/monitors/${id}/executions`, {}, org);
export const getExecution = (org: string, id: string) => request<import("@argus/contracts").ExecutionDetail>(`/api/v1/executions/${id}`, {}, org);
export const listIncidents = (org: string) => request<{ items: import("@argus/contracts").Incident[] }>("/api/v1/incidents", {}, org);
export const getIncident = (org: string, id: string) => request<import("@argus/contracts").IncidentDetail>(`/api/v1/incidents/${id}`, {}, org);
export const ackIncident = (org: string, id: string) => request<import("@argus/contracts").IncidentDetail>(`/api/v1/incidents/${id}/ack`, { method: "POST" }, org);
export const resolveIncident = (org: string, id: string) => request<import("@argus/contracts").IncidentDetail>(`/api/v1/incidents/${id}/resolve`, { method: "POST" }, org);

export const listNotificationChannels = (org: string) =>
  request<{ items: import("@argus/contracts").NotificationChannel[] }>("/api/v1/notification-channels", {}, org);
export const getNotificationChannel = (org: string, id: string) =>
  request<import("@argus/contracts").NotificationChannel>(`/api/v1/notification-channels/${id}`, {}, org);
export const createNotificationChannel = (org: string, value: import("@argus/contracts").CreateNotificationChannelRequest) =>
  request<import("@argus/contracts").NotificationChannel>("/api/v1/notification-channels", { method: "POST", body: JSON.stringify(value) }, org);
export const updateNotificationChannel = (org: string, id: string, value: import("@argus/contracts").UpdateNotificationChannelRequest) =>
  request<import("@argus/contracts").NotificationChannel>(`/api/v1/notification-channels/${id}`, { method: "PUT", body: JSON.stringify(value) }, org);
export const deleteNotificationChannel = (org: string, id: string) =>
  request<void>(`/api/v1/notification-channels/${id}`, { method: "DELETE" }, org);

export const getEscalationPolicy = (org: string) =>
  request<import("@argus/contracts").EscalationPolicy>("/api/v1/escalation-policy", {}, org);
export const updateEscalationPolicy = (org: string, value: import("@argus/contracts").UpdateEscalationPolicyRequest) =>
  request<import("@argus/contracts").EscalationPolicy>("/api/v1/escalation-policy", { method: "PUT", body: JSON.stringify(value) }, org);

export const listStatusPages = (org: string) =>
  request<{ items: import("@argus/contracts").StatusPageSummary[] }>("/api/v1/status-pages", {}, org);
export const getStatusPage = (org: string, id: string) =>
  request<import("@argus/contracts").StatusPage>(`/api/v1/status-pages/${id}`, {}, org);
export const createStatusPage = (org: string, value: import("@argus/contracts").CreateStatusPageRequest) =>
  request<import("@argus/contracts").StatusPage>("/api/v1/status-pages", { method: "POST", body: JSON.stringify(value) }, org);
export const updateStatusPage = (org: string, id: string, value: import("@argus/contracts").UpdateStatusPageRequest) =>
  request<import("@argus/contracts").StatusPage>(`/api/v1/status-pages/${id}`, { method: "PUT", body: JSON.stringify(value) }, org);
export const deleteStatusPage = (org: string, id: string) =>
  request<void>(`/api/v1/status-pages/${id}`, { method: "DELETE" }, org);
export const addStatusPageComponent = (org: string, statusPageId: string, value: import("@argus/contracts").AddStatusPageComponentRequest) =>
  request<import("@argus/contracts").StatusPageComponent>(`/api/v1/status-pages/${statusPageId}/components`, { method: "POST", body: JSON.stringify(value) }, org);
export const deleteStatusPageComponent = (org: string, statusPageId: string, componentId: string) =>
  request<void>(`/api/v1/status-pages/${statusPageId}/components/${componentId}`, { method: "DELETE" }, org);

export const getPublicStatusPage = async (slug: string): Promise<import("@argus/contracts").PublicStatusPage> => {
  const res = await fetch(`/api/public/v1/status-pages/${encodeURIComponent(slug)}`, { cache: "no-store" });
  if (!res.ok) {
    const error = (await res.json().catch(() => ({
      code: `HTTP_${res.status}`,
      message: "Failed to load status page",
      traceId: "unknown",
    }))) as import("@argus/contracts").ErrorEnvelope;
    throw new ApiError(res.status, error);
  }
  return res.json();
};

