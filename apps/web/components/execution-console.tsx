"use client";

import type { BootstrapResponse, ExecutionDetail, ExecutionSummary, Incident, IncidentDetail, Monitor } from "@argus/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { ackIncident, ApiError, bootstrap, evaluateMonitor, getExecution, getIncident, getMonitor, listExecutions, listIncidents, resolveIncident, runMonitor } from "../lib/api";
import { subscribeEvents } from "../lib/events";
import { RegionalDashboard } from "./regional-dashboard";
import { TimeSeriesChart } from "./timeseries-chart";

export function maskRecipient(value?: string | null): string {
  if (!value) return "—";
  if (value.includes("@")) {
    const parts = value.split("@");
    const user = parts[0] ?? "";
    const domain = parts[1] ?? "";
    if (user.length <= 2) return `${user[0] ?? ""}***@${domain}`;
    return `${user[0] ?? ""}***${user[user.length - 1] ?? ""}@${domain}`;
  }
  if (value.startsWith("arn:")) {
    const parts = value.split(":");
    return `arn:...:${parts[parts.length - 1] ?? ""}`;
  }
  return "***";
}

export function ExecutionConsole({ monitorId, incidentId }: { monitorId?: string; incidentId?: string }) {
  const [session, setSession] = useState<BootstrapResponse>();
  const [monitor, setMonitor] = useState<Monitor>();
  const [executions, setExecutions] = useState<ExecutionSummary[]>([]);
  const [detail, setDetail] = useState<ExecutionDetail>();
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [incidentDetail, setIncidentDetail] = useState<IncidentDetail>();
  const [error, setError] = useState<string>();
  const [running, setRunning] = useState(false);
  const [confirmingEvaluate, setConfirmingEvaluate] = useState(false);
  const [mutating, setMutating] = useState(false);
  const selected = useRef<string | undefined>(undefined);
  const generation = useRef(0);
  const stopEvents = useRef<(() => void) | undefined>(undefined);
  const denied = useRef(false);
  const reportError = useCallback((caught: unknown) => {
    if (caught instanceof ApiError && [401, 403, 404].includes(caught.status)) {
      denied.current = true; generation.current++; selected.current = undefined; stopEvents.current?.();
      setSession(undefined); setMonitor(undefined); setExecutions([]); setDetail(undefined);
      setIncidents([]); setIncidentDetail(undefined);
      setError("Access to this organization or resource is no longer available.");
    } else setError(caught instanceof Error ? caught.message : "Request failed");
  }, []);
  const refresh = useCallback(async (org: string) => {
    if (denied.current) return;
    const current = ++generation.current;
    const [incidentPage, nextMonitor, executionPage, nextIncident] = await Promise.all([
      listIncidents(org), monitorId ? getMonitor(org, monitorId) : undefined,
      monitorId ? listExecutions(org, monitorId) : undefined, incidentId ? getIncident(org, incidentId) : undefined,
    ]);
    if (current !== generation.current) return;
    setIncidents(incidentPage.items.filter((item) => !monitorId || item.monitorId === monitorId));
    setMonitor(nextMonitor); setExecutions(executionPage?.items ?? []); setIncidentDetail(nextIncident);
    const id = selected.current ?? executionPage?.items[0]?.id;
    if (id) {
      const value = await getExecution(org, id);
      if (current === generation.current) setDetail(value);
    }
  }, [monitorId, incidentId]);
  useEffect(() => {
    denied.current = false;
    let active = true;
    let stop: (() => void) | undefined;
    void (async () => {
      try {
        const value = await bootstrap();
        if (!active) return;
        setSession(value);
        await refresh(value.organization.id);
        if (!active) return;
        stop = subscribeEvents(value.organization.id, (event) => {
          if ([
            "probe.result_received", "execution.completed", "monitor.health_changed",
            "incident.opened", "incident.acknowledged", "incident.resolved",
            "notification.queued", "notification.sent", "notification.failed", "notification.canceled",
            "system.resync_required",
          ].includes(event.type)) {
            void refresh(value.organization.id).catch((caught) => active && reportError(caught));
          }
        }, (state) => {
          if (active && state === "unauthorized") reportError(new ApiError(403, { code: "ACCESS_REVOKED", message: "Access revoked", traceId: "stream" }));
        });
        stopEvents.current = stop;
      } catch (caught) {
        if (caught instanceof ApiError && caught.status === 401) window.location.assign("/login");
        else if (active) reportError(caught);
      }
    })();
    return () => { active = false; generation.current++; stop?.(); };
  }, [refresh, reportError]);
  useEffect(() => {
    if (!session || !executions.some((execution) => execution.status !== "COMPLETED")) return;
    const timer = setTimeout(() => { void refresh(session.organization.id).catch(reportError); }, 2000);
    return () => clearTimeout(timer);
  }, [session, executions, refresh, reportError]);
  async function run() {
    if (!session || !monitorId) return;
    setRunning(true); setError(undefined);
    try { const execution = await runMonitor(session.organization.id, monitorId); selected.current = execution.id; await refresh(session.organization.id); }
    catch (caught) { reportError(caught); }
    finally { setRunning(false); }
  }
  async function evaluate() {
    if (!session || !monitorId || !monitor) return;
    setRunning(true); setError(undefined); setConfirmingEvaluate(false);
    try {
      const execution = await evaluateMonitor(session.organization.id, monitorId, monitor.version);
      selected.current = execution.id;
      await refresh(session.organization.id);
    } catch (caught) { reportError(caught); }
    finally { setRunning(false); }
  }
  async function select(id: string) {
    if (!session) return;
    selected.current = id;
    try { const value = await getExecution(session.organization.id, id); if (selected.current === id) setDetail(value); }
    catch (caught) { reportError(caught); }
  }
  async function handleAck() {
    if (!session || !incidentDetail) return;
    setMutating(true); setError(undefined);
    try {
      const updated = await ackIncident(session.organization.id, incidentDetail.id);
      // Immediately cancel pending alert deliveries in local state
      setIncidentDetail({
        ...updated,
        deliveries: (updated.deliveries ?? incidentDetail.deliveries ?? []).map((d) =>
          d.status === "PENDING" && d.eventKind !== "INCIDENT_RESOLVED" ? { ...d, status: "CANCELED" as const } : d,
        ),
      });
      await refresh(session.organization.id);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) {
        await refresh(session.organization.id);
      } else reportError(caught);
    } finally { setMutating(false); }
  }
  async function handleResolve() {
    if (!session || !incidentDetail) return;
    setMutating(true); setError(undefined);
    try {
      const updated = await resolveIncident(session.organization.id, incidentDetail.id);
      // Immediately cancel pending alert deliveries in local state
      setIncidentDetail({
        ...updated,
        deliveries: (updated.deliveries ?? incidentDetail.deliveries ?? []).map((d) =>
          d.status === "PENDING" && d.eventKind !== "INCIDENT_RESOLVED" ? { ...d, status: "CANCELED" as const } : d,
        ),
      });
      await refresh(session.organization.id);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) {
        await refresh(session.organization.id);
      } else reportError(caught);
    } finally { setMutating(false); }
  }
  return <main className="pipeline-shell">
    <nav aria-label="Primary navigation">
      <a href="/monitors">Monitors</a>
      <a href="/incidents">Incidents</a>
      <a href="/settings/notifications">Notification settings</a>
      <a href="/api/auth/logout">Sign out</a>
    </nav>
    <header className="section-heading"><div><p className="eyebrow">{session?.organization.name ?? "Argus"}</p>
      <h1>{monitor?.name ?? (monitorId ? "Loading monitor…" : incidentId ? "Incident detail" : "Incidents")}</h1>
      {monitor && <><span className={`status-badge state-${monitor.healthState.toLowerCase()}`}>{monitor.healthState}</span><p><code>{"url" in monitor.config ? monitor.config.url : `${monitor.config.host}:${monitor.config.port}`}</code></p></>}
    </div>{monitorId && session && session.organization.role !== "VIEWER" && (
      <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
        <button className="primary-button" style={{ background: "white", color: "var(--ink, #101816)", border: "1px solid var(--line, #ccd5cd)" }} disabled={running} onClick={() => void run()}>{running ? "Queuing…" : "Run now"}</button>
        <button className="primary-button" disabled={running} onClick={() => setConfirmingEvaluate(true)}>{running ? "Evaluating…" : "Evaluate now"}</button>
      </div>
    )}</header>
    {error && <p role="alert" className="error-banner">{error}</p>}
    {confirmingEvaluate && (
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-eval-title"
        style={{
          margin: "16px 0",
          padding: "16px 20px",
          borderRadius: "12px",
          border: "1px solid #d97706",
          background: "#fffbeb",
          boxShadow: "0 4px 12px rgba(0,0,0,0.06)",
        }}
      >
        <h3 id="confirm-eval-title" style={{ margin: "0 0 8px", fontSize: 16, color: "#92400e" }}>
          Confirm Authoritative Health Evaluation
        </h3>
        <p style={{ margin: "0 0 16px", fontSize: 13, color: "#78350f" }}>
          <strong>Evaluate now</strong> performs an authoritative health check across target regions. Unlike diagnostic &ldquo;Run now&rdquo;, this check directly updates monitor health and can open or resolve incidents.
        </p>
        <div style={{ display: "flex", gap: "10px" }}>
          <button
            className="primary-button"
            style={{ background: "#d97706" }}
            disabled={running}
            onClick={() => void evaluate()}
          >
            {running ? "Evaluating…" : "Confirm & Evaluate"}
          </button>
          <button
            type="button"
            className="text-button"
            onClick={() => setConfirmingEvaluate(false)}
          >
            Cancel
          </button>
        </div>
      </div>
    )}
    {monitorId && session && <RegionalDashboard organizationId={session.organization.id} monitorId={monitorId} />}
    {monitorId && session && <TimeSeriesChart organizationId={session.organization.id} monitorId={monitorId} />}
    {monitorId && <><p className="muted">Run now performs a diagnostic check. Evaluate now performs an authoritative check that updates monitor health and manages incidents.</p>
      <section aria-labelledby="timeline-title"><h2 id="timeline-title">Execution timeline</h2>
        {!executions.length ? <p>No executions yet.</p> : <div className="table-scroll"><table><thead><tr><th>Scheduled</th><th>Trigger</th><th>Status</th><th>Observation</th></tr></thead>
          <tbody>{executions.map((item) => <tr key={item.id} aria-selected={detail?.id === item.id}><td><button className="text-button" onClick={() => void select(item.id)}>{new Date(item.scheduledAt).toLocaleString()}</button></td><td>{item.kind === "MANUAL" ? "Diagnostic" : item.kind === "EVALUATION" ? "Evaluation" : "Scheduled"}</td><td>{item.status}</td><td>{item.observation ?? "Awaiting results"}</td></tr>)}</tbody></table></div>}
      </section>
      {detail && <section aria-labelledby="regions-title" aria-live="polite"><h2 id="regions-title">Region results</h2><div className="region-results">{detail.targets.map((target) => <article key={target.id} className="region-card"><h3>{target.region}</h3><span className="status-badge">{target.result?.outcome ?? target.status}</span>
        {target.result ? <dl><dt>Duration</dt><dd>{target.result.durationMs} ms</dd><dt>HTTP status</dt><dd>{target.result.http?.statusCode ?? "—"}</dd>{target.result.errorCode && <><dt>Error</dt><dd>{target.result.errorCode}</dd></>}</dl> : <p>{["EXPIRED", "DEAD"].includes(target.status) ? "No result received" : "Awaiting probe"}</p>}
      </article>)}</div></section>}</>}
    <section aria-labelledby="incidents-title"><h2 id="incidents-title">{monitorId ? "Monitor incidents" : "Incident history"}</h2>
      {incidentDetail && <article className="incident-detail-card" data-testid="incident-detail-card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h3>Incident #{incidentDetail.id.slice(0, 8)}</h3>
          <span className={`status-badge state-${incidentDetail.status.toLowerCase()}`}>{incidentDetail.status}</span>
        </div>
        <dl>
          <dt>Opened</dt><dd>{new Date(incidentDetail.openedAt).toLocaleString()}</dd>
          <dt>Acknowledged</dt><dd>{incidentDetail.acknowledgedAt ? `${new Date(incidentDetail.acknowledgedAt).toLocaleString()}${incidentDetail.acknowledgedBy ? ` by ${incidentDetail.acknowledgedBy}` : ""}` : "—"}</dd>
          <dt>Resolved</dt><dd>{incidentDetail.resolvedAt ? `${new Date(incidentDetail.resolvedAt).toLocaleString()}${incidentDetail.resolvedBy ? ` by ${incidentDetail.resolvedBy}` : ""}` : "—"}</dd>
        </dl>
        {session && session.organization.role !== "VIEWER" && <div className="incident-actions">
          {incidentDetail.status === "OPEN" && <button className="primary-button" disabled={mutating} onClick={() => void handleAck()}>Acknowledge</button>}
          {incidentDetail.status !== "RESOLVED" && <button className="secondary-button" disabled={mutating} onClick={() => void handleResolve()}>Resolve</button>}
        </div>}
        <h4>Escalation deliveries</h4>
        {!incidentDetail.deliveries?.length ? (
          <p className="muted">No escalation deliveries configured for this incident.</p>
        ) : (
          <div className="table-scroll">
            <table data-testid="deliveries-table">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Type</th>
                  <th>Status</th>
                  <th>Scheduled</th>
                  <th>Attempts</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {incidentDetail.deliveries.map((delivery, index) => {
                  const isRecovery = delivery.eventKind === "INCIDENT_RESOLVED";
                  const stepLabel = isRecovery
                    ? "Recovery"
                    : index === 0 ? "Primary" : index === 1 ? "Secondary" : index === 2 ? "Team" : `Step ${index + 1}`;
                  const typeLabel = isRecovery ? "Recovery" : "Alert";
                  return (
                    <tr key={delivery.id} data-testid={`delivery-row-${delivery.id}`}>
                      <td><strong>{stepLabel}</strong></td>
                      <td><span className={`status-badge event-${typeLabel.toLowerCase()}`}>{typeLabel}</span></td>
                      <td>
                        <span className={`status-badge state-${delivery.status.toLowerCase()}`}>
                          {delivery.status}
                        </span>
                      </td>
                      <td>{new Date(delivery.scheduledAt).toLocaleTimeString()}</td>
                      <td>{delivery.attempts}</td>
                      <td>{delivery.lastError ? <code>{delivery.lastError}</code> : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <h4>Incident events</h4>
        <ol>{incidentDetail.events.map((event) => <li key={event.id}><strong>{event.type}</strong> · {new Date(event.occurredAt).toLocaleString()}{event.actor ? ` by ${event.actor}` : ""}</li>)}</ol>
      </article>}
      {!incidents.length ? <p>No incidents.</p> : <ul className="incident-list">{incidents.map((item) => <li key={item.id}>
        <a href={`/incidents/${item.id}`}>
          <span className={`status-badge state-${item.status.toLowerCase()}`}>{item.status}</span> · {new Date(item.openedAt).toLocaleString()}
        </a>
        <a href={`/monitors/${item.monitorId}`}>View monitor</a>
        {item.acknowledgedAt && <span>Acked {new Date(item.acknowledgedAt).toLocaleString()}{item.acknowledgedBy ? ` (${item.acknowledgedBy})` : ""}</span>}
        {item.resolvedAt && <span>Resolved {new Date(item.resolvedAt).toLocaleString()}{item.resolvedBy ? ` (${item.resolvedBy})` : ""}</span>}
      </li>)}</ul>}
    </section>
  </main>;
}
