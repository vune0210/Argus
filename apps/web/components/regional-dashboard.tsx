"use client";

import type { MonitorSnapshot } from "@argus/contracts";
import { useEffect, useState } from "react";
import { ApiError, getMonitorSnapshot } from "../lib/api";
import { subscribeEvents, type StreamState } from "../lib/events";

const labels: Record<string, string> = { "ap-southeast-1": "Singapore", "ap-northeast-1": "Tokyo", "eu-central-1": "Frankfurt" };
const formatTime = (value: string | null) => value ? new Date(value).toLocaleString() : "Not received";

export function RegionalSnapshotView({ snapshot, connection, error }: { snapshot?: MonitorSnapshot; connection: StreamState; error?: string }) {
  return <section aria-labelledby="regional-dashboard-title" aria-live="polite">
    <h2 id="regional-dashboard-title">Live regional overview</h2>
    <p role="status">{connection === "connected" ? "Live updates connected" : connection === "unauthorized" ? "Access expired. Sign in again." : connection === "reconnecting" ? "Live updates disconnected. Reconnecting…" : "Connecting live updates…"}</p>
    {error && <p role="alert">{error}{snapshot && " Displayed data may be outdated."}</p>}
    {!snapshot ? <p>{error ? "Regional data unavailable." : "Loading regional results…"}</p> : <>
      <p>Current health: {snapshot.healthState} · Updated {formatTime(snapshot.observedAt)}</p>
      <div className="region-results">{snapshot.regions.map((region) => <article key={region.region} className="region-card" aria-label={`${labels[region.region] ?? region.region} live result`}>
        <h3>{labels[region.region] ?? region.region}</h3><p className="muted">{region.region}</p>
        <dl>
          <dt>Target check</dt><dd>{region.outcome === null ? "No result yet" : region.outcome === "PASS" ? "Passing" : "Check failed"}</dd>
          <dt>Latency</dt><dd>{region.latencyMs === null ? "—" : `${region.latencyMs} ms`}</dd>
          <dt>Last result</dt><dd>{formatTime(region.receivedAt)}</dd>
          <dt>Data freshness</dt><dd>{region.freshness === "NO_DATA" ? "No data" : region.freshness === "STALE" ? "Stale result" : "Fresh"}</dd>
          <dt>Probe heartbeat</dt><dd>{region.heartbeat.status === "UNKNOWN" ? "Not observed" : region.heartbeat.status === "STALE" ? "Heartbeat missing" : "Alive"}</dd>
          <dt>Last heartbeat</dt><dd>{formatTime(region.heartbeat.lastSeenAt)}</dd>
        </dl>
      </article>)}</div>
    </>}
  </section>;
}

/** The key remounts tenant-bound state immediately when organization/monitor changes. */
export function RegionalDashboard({ organizationId, monitorId }: { organizationId: string; monitorId: string }) {
  return <ConnectedDashboard key={`${organizationId}:${monitorId}`} organizationId={organizationId} monitorId={monitorId} />;
}

function ConnectedDashboard({ organizationId, monitorId }: { organizationId: string; monitorId: string }) {
  const [snapshot, setSnapshot] = useState<MonitorSnapshot>();
  const [connection, setConnection] = useState<StreamState>("connecting");
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    let inFlight = false;
    let pending = false;
    let stop = () => {};
    let timer: ReturnType<typeof setInterval> | undefined;
    const revoke = () => {
      active = false; stop(); clearInterval(timer); setSnapshot(undefined); setConnection("unauthorized");
      setError("Access to this organization or monitor is no longer available.");
    };
    // Coalesce invalidations so a burst cannot starve snapshot rendering or race responses.
    const refresh = async () => {
      if (!active) return;
      if (inFlight) { pending = true; return; }
      inFlight = true;
      do {
        pending = false;
        try {
          const next = await getMonitorSnapshot(organizationId, monitorId);
          if (next.organizationId !== organizationId || next.monitorId !== monitorId) throw new Error("Snapshot scope mismatch");
          if (active) { setSnapshot(next); setError(undefined); }
        } catch (caught) {
          if (active && caught instanceof ApiError && [401, 403, 404].includes(caught.status)) revoke();
          else if (active) setError("Unable to refresh regional results.");
        }
      } while (active && pending);
      inFlight = false;
    };
    void refresh();
    stop = subscribeEvents(organizationId, (event) => {
      if (["probe.result_received", "execution.completed", "monitor.health_changed", "system.resync_required"].includes(event.type)) void refresh();
    }, (state) => {
      if (!active) return;
      setConnection(state);
      if (state === "connected") void refresh();
      if (state === "unauthorized") revoke();
    });
    // Heartbeats can become stale without any execution or domain event.
    if (active) timer = setInterval(() => void refresh(), 15_000);
    else stop();
    return () => { active = false; clearInterval(timer); stop(); };
  }, [organizationId, monitorId]);
  return <RegionalSnapshotView snapshot={snapshot} connection={connection} error={error} />;
}
