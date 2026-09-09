"use client";

import type { PublicStatusPage } from "@argus/contracts";
import { use, useEffect, useState } from "react";
import { getPublicStatusPage } from "../../../lib/api";

export default function PublicStatusRoute({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const resolvedParams = use(params);
  const slug = resolvedParams.slug;

  const [page, setPage] = useState<PublicStatusPage>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [refreshWarning, setRefreshWarning] = useState(false);

  useEffect(() => {
    let active = true;

    const fetchStatus = async (isInitial = false) => {
      try {
        const data = await getPublicStatusPage(slug);
        if (!active) return;
        setPage(data);
        setError(undefined);
        setRefreshWarning(false);
      } catch (err: unknown) {
        if (!active) return;
        if (isInitial) {
          setError(err instanceof Error ? err.message : "Status page not found or unavailable.");
        } else {
          // On refresh error, preserve previous data and show warning banner
          setRefreshWarning(true);
        }
      } finally {
        if (active && isInitial) setLoading(false);
      }
    };

    fetchStatus(true);

    // Poll every 15 seconds
    const interval = setInterval(() => {
      fetchStatus(false);
    }, 15000);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [slug]);

  if (loading) {
    return (
      <div style={{ maxWidth: "880px", margin: "60px auto", padding: "0 24px", fontFamily: "sans-serif" }}>
        <p style={{ color: "#64748b" }}>Loading system status…</p>
      </div>
    );
  }

  if (error || !page) {
    return (
      <div style={{ maxWidth: "880px", margin: "80px auto", padding: "0 24px", textAlign: "center" }}>
        <div style={{ fontSize: "42px", marginBottom: "16px" }}>🔍</div>
        <h1 style={{ fontSize: "28px", marginBottom: "12px", color: "var(--ink)" }}>Status Page Not Found</h1>
        <p style={{ color: "var(--muted)", fontSize: "15px" }}>
          {error || "The requested status page does not exist or is not published."}
        </p>
      </div>
    );
  }

  const overallConfig = {
    OPERATIONAL: {
      bg: "#ecfdf5",
      border: "#6ee7b7",
      color: "#065f46",
      icon: "✓",
      title: "All Systems Operational",
    },
    DEGRADED: {
      bg: "#fefce8",
      border: "#fde047",
      color: "#854d0e",
      icon: "⚠",
      title: "Active Service Degradation",
    },
    MAJOR_OUTAGE: {
      bg: "#fef2f2",
      border: "#fca5a5",
      color: "#991b1b",
      icon: "✕",
      title: "Major Service Outage",
    },
    UNKNOWN: {
      bg: "#f8fafc",
      border: "#cbd5e1",
      color: "#334155",
      icon: "○",
      title: "System Status Unknown",
    },
  }[page.overallStatus];

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "OPERATIONAL":
        return <span style={{ padding: "4px 8px", borderRadius: "6px", fontSize: "11px", fontWeight: 700, background: "#dcfce7", color: "#166534" }}>Operational</span>;
      case "DEGRADED":
        return <span style={{ padding: "4px 8px", borderRadius: "6px", fontSize: "11px", fontWeight: 700, background: "#fef9c3", color: "#854d0e" }}>Degraded</span>;
      case "MAJOR_OUTAGE":
        return <span style={{ padding: "4px 8px", borderRadius: "6px", fontSize: "11px", fontWeight: 700, background: "#fee2e2", color: "#991b1b" }}>Major Outage</span>;
      default:
        return <span style={{ padding: "4px 8px", borderRadius: "6px", fontSize: "11px", fontWeight: 700, background: "#f1f5f9", color: "#475569" }}>Unknown</span>;
    }
  };

  const formatUptime = (val: number | null) => {
    if (val === null || val === undefined) return "Insufficient data";
    return `${val.toFixed(2)}%`;
  };

  return (
    <div style={{ minHeight: "100vh", background: "#f8fafc", color: "#0f172a", padding: "48px 24px 96px" }}>
      <div style={{ maxWidth: "860px", margin: "0 auto" }}>
        {/* Header */}
        <header style={{ marginBottom: "32px", display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "8px" }}>
              <span style={{ display: "inline-grid", placeItems: "center", width: "32px", height: "32px", borderRadius: "8px", background: "var(--acid, #dfff45)", color: "#101816", fontWeight: 800, fontSize: "16px" }}>
                A
              </span>
              <span style={{ fontSize: "13px", fontWeight: 800, letterSpacing: "0.15em", color: "#64748b" }}>
                ARGUS STATUS
              </span>
            </div>
            <h1 style={{ fontSize: "32px", fontWeight: 800, letterSpacing: "-0.03em", margin: 0, color: "#0f172a" }}>
              {page.name}
            </h1>
            {page.description && (
              <p style={{ color: "#64748b", margin: "8px 0 0", fontSize: "15px" }}>{page.description}</p>
            )}
          </div>
          <span style={{ fontSize: "12px", color: "#94a3b8" }}>
            Refreshes every 15s
          </span>
        </header>

        {/* Warning banner if refresh failed */}
        {refreshWarning && (
          <div style={{ background: "#fffbeb", border: "1px solid #fde68a", color: "#92400e", padding: "10px 16px", borderRadius: "10px", fontSize: "13px", marginBottom: "20px" }}>
            ⚠ Unable to update live status. Displaying cached data.
          </div>
        )}

        {/* Overall Status Banner */}
        <section
          style={{
            background: overallConfig.bg,
            border: `1.5px solid ${overallConfig.border}`,
            color: overallConfig.color,
            padding: "24px 28px",
            borderRadius: "16px",
            marginBottom: "36px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
            <span style={{ fontSize: "28px" }}>{overallConfig.icon}</span>
            <div>
              <h2 style={{ fontSize: "22px", fontWeight: 800, margin: 0 }}>{overallConfig.title}</h2>
              <p style={{ margin: "4px 0 0", fontSize: "13px", opacity: 0.85 }}>
                Updated {new Date(page.updatedAt).toLocaleTimeString()}
              </p>
            </div>
          </div>
        </section>

        {/* Components Section */}
        <section style={{ background: "white", borderRadius: "16px", border: "1px solid #e2e8f0", padding: "28px", marginBottom: "36px", boxShadow: "0 4px 20px rgba(0,0,0,0.03)" }}>
          <h2 style={{ fontSize: "18px", fontWeight: 800, margin: "0 0 20px", letterSpacing: "-0.02em" }}>
            Service Components
          </h2>

          {page.components.length === 0 ? (
            <p style={{ color: "#94a3b8", fontSize: "14px" }}>No monitored components configured.</p>
          ) : (
            <div style={{ display: "grid", gap: "16px" }}>
              {page.components.map((comp) => (
                <div
                  key={comp.name}
                  style={{
                    padding: "18px 20px",
                    border: "1px solid #f1f5f9",
                    borderRadius: "12px",
                    background: "#f8fafc",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
                    <strong style={{ fontSize: "15px", color: "#1e293b" }}>{comp.name}</strong>
                    {getStatusBadge(comp.status)}
                  </div>

                  {/* Uptime metrics */}
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "12px", fontSize: "12px" }}>
                    <div style={{ background: "white", padding: "10px 12px", borderRadius: "8px", border: "1px solid #e2e8f0" }}>
                      <span style={{ color: "#64748b", display: "block", marginBottom: "4px" }}>Last 24 Hours</span>
                      <strong style={{ fontSize: "14px", color: "#0f172a" }}>{formatUptime(comp.uptime.last24Hours)}</strong>
                      <span style={{ color: "#94a3b8", display: "block", fontSize: "11px", marginTop: "2px" }}>
                        Coverage: {comp.coverage.last24Hours.toFixed(1)}%
                      </span>
                    </div>

                    <div style={{ background: "white", padding: "10px 12px", borderRadius: "8px", border: "1px solid #e2e8f0" }}>
                      <span style={{ color: "#64748b", display: "block", marginBottom: "4px" }}>Last 7 Days</span>
                      <strong style={{ fontSize: "14px", color: "#0f172a" }}>{formatUptime(comp.uptime.last7Days)}</strong>
                      <span style={{ color: "#94a3b8", display: "block", fontSize: "11px", marginTop: "2px" }}>
                        Coverage: {comp.coverage.last7Days.toFixed(1)}%
                      </span>
                    </div>

                    <div style={{ background: "white", padding: "10px 12px", borderRadius: "8px", border: "1px solid #e2e8f0" }}>
                      <span style={{ color: "#64748b", display: "block", marginBottom: "4px" }}>Last 30 Days</span>
                      <strong style={{ fontSize: "14px", color: "#0f172a" }}>{formatUptime(comp.uptime.last30Days)}</strong>
                      <span style={{ color: "#94a3b8", display: "block", fontSize: "11px", marginTop: "2px" }}>
                        Coverage: {comp.coverage.last30Days.toFixed(1)}%
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Incidents Section */}
        <section style={{ background: "white", borderRadius: "16px", border: "1px solid #e2e8f0", padding: "28px", boxShadow: "0 4px 20px rgba(0,0,0,0.03)" }}>
          <h2 style={{ fontSize: "18px", fontWeight: 800, margin: "0 0 20px", letterSpacing: "-0.02em" }}>
            Incident History
          </h2>

          {page.incidents.length === 0 ? (
            <p style={{ color: "#64748b", fontSize: "14px", margin: 0 }}>
              No incidents reported in the past 30 days.
            </p>
          ) : (
            <div style={{ display: "grid", gap: "16px" }}>
              {page.incidents.map((inc, i) => (
                <div
                  key={i}
                  style={{
                    padding: "16px 18px",
                    borderLeft: `4px solid ${inc.status === "RESOLVED" ? "#22c55e" : "#ef4444"}`,
                    background: "#f8fafc",
                    borderRadius: "0 10px 10px 0",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <strong style={{ fontSize: "14px", color: "#1e293b" }}>{inc.componentName}</strong>
                    <span
                      style={{
                        padding: "2px 8px",
                        borderRadius: "4px",
                        fontSize: "11px",
                        fontWeight: 700,
                        background: inc.status === "RESOLVED" ? "#dcfce7" : "#fee2e2",
                        color: inc.status === "RESOLVED" ? "#15803d" : "#b91c1c",
                      }}
                    >
                      {inc.status}
                    </span>
                  </div>
                  <div style={{ fontSize: "12px", color: "#64748b", marginTop: "6px" }}>
                    Opened: {new Date(inc.openedAt).toLocaleString()}
                    {inc.resolvedAt && ` · Resolved: ${new Date(inc.resolvedAt).toLocaleString()}`}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
