"use client";

import type { BootstrapResponse, HttpMonitorConfig, Monitor } from "@argus/contracts";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { ApiError, bootstrap, createMonitor, deleteMonitor, listMonitors, updateMonitor } from "../lib/api";
import { subscribeEvents } from "../lib/events";

const regions = ["ap-southeast-1", "ap-northeast-1", "eu-central-1"];
export interface HttpMonitorPayload {
  name: string;
  intervalSeconds: number;
  regions: string[];
  config: HttpMonitorConfig;
  incidentPolicy?: {
    failureThreshold: number;
    recoveryThreshold: number;
  };
}

const emptyForm: HttpMonitorPayload = {
  name: "",
  intervalSeconds: 60,
  regions,
  config: {
    kind: "http",
    url: "https://example.com/health",
    method: "GET",
    timeoutMs: 5000,
    expectedStatus: 200,
    maxRedirects: 5,
    maxResponseBytes: 1_048_576,
  },
  incidentPolicy: {
    failureThreshold: 2,
    recoveryThreshold: 2,
  },
};

function message(error: unknown): string {
  if (error instanceof ApiError) {
    const details = Array.isArray(error.envelope.details) ? ` ${error.envelope.details.join(" · ")}` : "";
    return `${error.message}${details}`;
  }
  return error instanceof Error ? error.message : "Unexpected error";
}

export function MonitorConsole() {
  const [session, setSession] = useState<BootstrapResponse>();
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [form, setForm] = useState<HttpMonitorPayload>(emptyForm);
  const [editing, setEditing] = useState<Monitor>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const canWrite = useMemo(() => ["OWNER", "ADMIN"].includes(session?.organization.role ?? ""), [session]);

  const refresh = useCallback(async (organizationId: string) => {
    const page = await listMonitors(organizationId);
    setMonitors(page.items);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const current = await bootstrap();
        setSession(current);
        await refresh(current.organization.id);
      } catch (caught) {
        if (caught instanceof ApiError && caught.status === 401) window.location.assign("/login");
        else setError(message(caught));
      } finally {
        setLoading(false);
      }
    })();
  }, [refresh]);

  useEffect(() => {
    if (!session) return;
    return subscribeEvents(session.organization.id, () => {
      void refresh(session.organization.id).catch((caught) => setError(message(caught)));
    });
  }, [session, refresh]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!session) return;
    setSaving(true);
    setError(undefined);
    try {
      if (editing) await updateMonitor(session.organization.id, editing, form);
      else await createMonitor(session.organization.id, form);
      setForm(emptyForm);
      setEditing(undefined);
      await refresh(session.organization.id);
    } catch (caught) {
      setError(message(caught));
    } finally {
      setSaving(false);
    }
  }

  function beginEdit(monitor: Monitor) {
    setEditing(monitor);
    const httpConfig: HttpMonitorConfig = monitor.config.kind === "http"
      ? monitor.config
      : {
          kind: "http",
          url: "url" in monitor.config ? monitor.config.url : `http://${monitor.config.host}:${monitor.config.port}`,
          method: "method" in monitor.config ? monitor.config.method : "GET",
          timeoutMs: monitor.config.timeoutMs,
          expectedStatus: "expectedStatus" in monitor.config ? monitor.config.expectedStatus : 200,
          maxRedirects: "maxRedirects" in monitor.config ? monitor.config.maxRedirects : 5,
          maxResponseBytes: "maxResponseBytes" in monitor.config ? monitor.config.maxResponseBytes : 1_048_576,
        };
    setForm({
      name: monitor.name,
      intervalSeconds: monitor.intervalSeconds,
      regions: monitor.regions,
      config: httpConfig,
      incidentPolicy: monitor.incidentPolicy ?? { failureThreshold: 2, recoveryThreshold: 2 },
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function remove(monitor: Monitor) {
    if (!session || !window.confirm(`Delete ${monitor.name}? This cannot be undone.`)) return;
    try {
      await deleteMonitor(session.organization.id, monitor.id);
      await refresh(session.organization.id);
    } catch (caught) {
      setError(message(caught));
    }
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">A</span> ARGUS</div>
        <nav aria-label="Primary navigation">
          <a className="nav-item active" href="/monitors"><span>◉</span> Monitors</a>
          <a className="nav-item" href="/incidents"><span>↗</span> Incidents</a>
          <a className="nav-item" href="/settings/notifications"><span>⚙</span> Notifications</a>
          <span className="nav-item disabled"><span>◎</span> Status pages <em>W4</em></span>
        </nav>
        <div className="sidebar-foot">
          <div className="avatar">{session?.user.email.slice(0, 2).toUpperCase() ?? "AR"}</div>
          <div><strong>{session?.user.email ?? "Loading…"}</strong><small>{session?.organization.role ?? ""}</small></div>
          <a className="logout" href="/api/auth/logout" aria-label="Sign out">↪</a>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div><p className="eyebrow">{session?.organization.name ?? "Argus"}</p><h1>Service monitors</h1></div>
          <div className="region-health"><span className="live-dot" /> Control plane ready</div>
        </header>

        {error && <div className="error-banner" role="alert"><strong>Request failed</strong><span>{error}</span><button onClick={() => setError(undefined)} aria-label="Dismiss">×</button></div>}

        {canWrite && (
          <form className="monitor-form" onSubmit={save}>
            <div className="form-heading">
              <div><p className="eyebrow">{editing ? `Editing v${editing.version}` : "New HTTP check"}</p><h2>{editing ? editing.name : "Watch a public endpoint"}</h2></div>
              {editing && <button type="button" className="text-button" onClick={() => { setEditing(undefined); setForm(emptyForm); }}>Cancel</button>}
            </div>
            <div className="form-grid">
              <label>Monitor name<input required maxLength={120} value={form.name} placeholder="Production API" onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
              <label className="wide">Endpoint URL<input required type="url" value={form.config.url} onChange={(event) => setForm({ ...form, config: { ...form.config, url: event.target.value } })} /></label>
              <label>Method<select value={form.config.method} onChange={(event) => setForm({ ...form, config: { ...form.config, method: event.target.value as HttpMonitorConfig["method"] } })}>{["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].map((method) => <option key={method}>{method}</option>)}</select></label>
              <label>Expected status<input required type="number" min={100} max={599} value={form.config.expectedStatus} onChange={(event) => setForm({ ...form, config: { ...form.config, expectedStatus: Number(event.target.value) } })} /></label>
              <label>Interval (seconds)<input required type="number" min={60} value={form.intervalSeconds} onChange={(event) => setForm({ ...form, intervalSeconds: Number(event.target.value) })} /></label>
              <label>Timeout (ms)<input required type="number" min={100} max={30000} value={form.config.timeoutMs} onChange={(event) => setForm({ ...form, config: { ...form.config, timeoutMs: Number(event.target.value) } })} /></label>
              <label>Failure threshold (1–5)<input required type="number" min={1} max={5} value={form.incidentPolicy?.failureThreshold ?? 2} onChange={(event) => setForm({ ...form, incidentPolicy: { failureThreshold: Number(event.target.value), recoveryThreshold: form.incidentPolicy?.recoveryThreshold ?? 2 } })} /></label>
              <label>Recovery threshold (1–5)<input required type="number" min={1} max={5} value={form.incidentPolicy?.recoveryThreshold ?? 2} onChange={(event) => setForm({ ...form, incidentPolicy: { failureThreshold: form.incidentPolicy?.failureThreshold ?? 2, recoveryThreshold: Number(event.target.value) } })} /></label>
            </div>
            <fieldset><legend>Probe regions</legend><div className="region-options">{regions.map((region) => <label key={region}><input type="checkbox" checked={form.regions.includes(region)} onChange={(event) => setForm({ ...form, regions: event.target.checked ? [...form.regions, region] : form.regions.filter((item: string) => item !== region) })} /><span>{region}</span></label>)}</div></fieldset>
            <button className="primary-button" disabled={saving || form.regions.length === 0}>{saving ? "Saving…" : editing ? "Save new version" : "Create monitor"}</button>
          </form>
        )}

        <section className="monitor-section">
          <div className="section-heading"><div><p className="eyebrow">Fleet</p><h2>{monitors.length} monitors</h2></div><span className="timestamp">Minimum interval · 60 sec</span></div>
          {loading ? <div className="skeleton-list"><div /><div /><div /></div> : monitors.length === 0 ? (
            <div className="empty-state"><span>⌁</span><h3>No signal yet</h3><p>Create an HTTP monitor to start scheduled checks across your selected regions.</p></div>
          ) : (
            <div className="monitor-list">{monitors.map((monitor) => (
              <article className="monitor-row" key={monitor.id}>
                <div className="state-icon unknown">?</div>
                <div className="monitor-primary"><a href={`/monitors/${monitor.id}`}><strong>{monitor.name}</strong></a><code>{"url" in monitor.config ? `${monitor.config.method} ${monitor.config.url}` : `${monitor.config.kind.toUpperCase()} ${monitor.config.host}:${monitor.config.port}`}</code></div>
                <div className="monitor-meta"><span>{monitor.intervalSeconds}s</span><span>{monitor.regions.length} regions</span><span>v{monitor.version}</span></div>
                <span className="status-badge">{monitor.healthState}</span>
                {canWrite && <div className="row-actions"><button onClick={() => beginEdit(monitor)}>Edit</button><button className="danger" onClick={() => void remove(monitor)}>Delete</button></div>}
              </article>
            ))}</div>
          )}
        </section>
      </section>
    </main>
  );
}
