"use client";

import type { MonitorTimeSeriesResponse, TimeSeriesPoint } from "@argus/contracts";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, getMonitorTimeseries } from "../lib/api";
import { subscribeEvents } from "../lib/events";

const REGION_NAMES: Record<string, string> = {
  "ap-southeast-1": "Singapore",
  "ap-northeast-1": "Tokyo",
  "eu-central-1": "Frankfurt",
};

const REGION_COLORS: Record<string, string> = {
  "ap-southeast-1": "#0b7568",
  "ap-northeast-1": "#6366f1",
  "eu-central-1": "#d97706",
};

const DEFAULT_COLORS = ["#0284c7", "#ec4899", "#8b5cf6", "#14b8a6"];

function getRegionColor(region: string, index: number): string {
  return REGION_COLORS[region] ?? DEFAULT_COLORS[index % DEFAULT_COLORS.length] ?? "#64748b";
}

interface HoveredPoint {
  point: TimeSeriesPoint;
  region: string;
  x: number;
  y: number;
}

export function TimeSeriesChart({
  organizationId,
  monitorId,
}: {
  organizationId: string;
  monitorId: string;
}) {
  const [windowRange, setWindowRange] = useState<"1h" | "6h" | "24h">("24h");
  const [data, setData] = useState<MonitorTimeSeriesResponse>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [hovered, setHovered] = useState<HoveredPoint | null>(null);
  const [showTable, setShowTable] = useState(false);
  const generation = useRef(0);

  const fetchTimeseries = useCallback(async () => {
    const current = ++generation.current;
    try {
      const response = await getMonitorTimeseries(organizationId, monitorId, windowRange);
      if (current === generation.current) {
        setData(response);
        setError(undefined);
      }
    } catch (caught) {
      if (current === generation.current) {
        setError(caught instanceof ApiError ? caught.envelope.message : "Failed to load time series");
      }
    } finally {
      if (current === generation.current) {
        setLoading(false);
      }
    }
  }, [organizationId, monitorId, windowRange]);

  useEffect(() => {
    setLoading(true);
    void fetchTimeseries();
  }, [fetchTimeseries]);

  useEffect(() => {
    const stop = subscribeEvents(
      organizationId,
      (event) => {
        if (
          ["probe.result_received", "execution.completed", "monitor.health_changed", "system.resync_required"].includes(
            event.type,
          )
        ) {
          void fetchTimeseries();
        }
      },
      () => {},
    );
    return () => {
      stop();
    };
  }, [organizationId, fetchTimeseries]);

  // Dimensions
  const svgWidth = 800;
  const svgHeight = 260;
  const padding = { top: 20, right: 30, bottom: 40, left: 60 };
  const chartWidth = svgWidth - padding.left - padding.right;
  const chartHeight = svgHeight - padding.top - padding.bottom;

  const { timeRange, maxLatency, regions, pointsByRegion } = useMemo(() => {
    if (!data) {
      return {
        timeRange: { from: Date.now() - 86400000, to: Date.now() },
        maxLatency: 100,
        regions: [],
        pointsByRegion: {},
      };
    }

    const from = new Date(data.from).getTime();
    const to = new Date(data.to).getTime();
    const regList = Object.keys(data.series).sort();
    let highest = 50;

    for (const reg of regList) {
      const pts = data.series[reg] ?? [];
      for (const p of pts) {
        if (p.latencyMs !== null && p.latencyMs > highest) {
          highest = p.latencyMs;
        }
      }
    }

    // Add 15% headroom and round to nice multiple
    const ceiling = Math.ceil((highest * 1.15) / 50) * 50;

    return {
      timeRange: { from, to: Math.max(to, from + 1000) },
      maxLatency: Math.max(ceiling, 50),
      regions: regList,
      pointsByRegion: data.series,
    };
  }, [data]);

  const getTimeX = (isoTime: string) => {
    const t = new Date(isoTime).getTime();
    const ratio = Math.max(0, Math.min(1, (t - timeRange.from) / (timeRange.to - timeRange.from)));
    return padding.left + ratio * chartWidth;
  };

  const getLatencyY = (latencyMs: number | null) => {
    if (latencyMs === null) {
      return padding.top + chartHeight; // Bottom line
    }
    const ratio = Math.max(0, Math.min(1, latencyMs / maxLatency));
    return padding.top + (1 - ratio) * chartHeight;
  };

  // Generate ticks
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((frac) => ({
    val: Math.round(maxLatency * frac),
    y: padding.top + (1 - frac) * chartHeight,
  }));

  const xTicks = useMemo(() => {
    const count = 5;
    const ticks: { label: string; x: number }[] = [];
    const span = timeRange.to - timeRange.from;
    for (let i = 0; i <= count; i++) {
      const t = timeRange.from + (span * i) / count;
      const d = new Date(t);
      const label =
        windowRange === "1h"
          ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
          : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      ticks.push({
        label,
        x: padding.left + (i / count) * chartWidth,
      });
    }
    return ticks;
  }, [timeRange, windowRange, chartWidth, padding.left]);

  // Flatten points for the accessible table
  const allPoints = useMemo(() => {
    if (!data) return [];
    const flat: Array<{ region: string; point: TimeSeriesPoint }> = [];
    for (const [region, pts] of Object.entries(data.series)) {
      for (const p of pts) {
        flat.push({ region, point: p });
      }
    }
    flat.sort((a, b) => new Date(b.point.time).getTime() - new Date(a.point.time).getTime());
    return flat;
  }, [data]);

  return (
    <section className="timeseries-section" aria-labelledby="timeseries-heading" data-testid="timeseries-chart-section">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div>
          <h2 id="timeseries-heading" style={{ fontSize: 18, margin: 0 }}>
            Latency History by Region
          </h2>
          {data?.truncated && (
            <p style={{ margin: "4px 0 0", color: "#d97706", fontSize: 12 }} role="status">
              ⚠ Maximum point threshold reached (15,000 points). Older data points were truncated.
            </p>
          )}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <div role="group" aria-label="Time window selection" style={{ display: "flex", gap: 4 }}>
            {(["1h", "6h", "24h"] as const).map((w) => (
              <button
                key={w}
                type="button"
                className={`window-button ${windowRange === w ? "active" : ""}`}
                style={{
                  padding: "4px 10px",
                  fontSize: 12,
                  borderRadius: 6,
                  border: "1px solid #ccd5cd",
                  background: windowRange === w ? "var(--teal, #0b7568)" : "white",
                  color: windowRange === w ? "white" : "inherit",
                  cursor: "pointer",
                  fontWeight: windowRange === w ? 600 : 400,
                }}
                onClick={() => setWindowRange(w)}
                aria-pressed={windowRange === w}
              >
                {w}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="text-button"
            style={{ fontSize: 12, marginLeft: 8 }}
            onClick={() => setShowTable(!showTable)}
            aria-expanded={showTable}
            aria-controls="timeseries-accessible-table"
          >
            {showTable ? "Hide data table" : "Show data table"}
          </button>
        </div>
      </div>

      {loading && !data && <p className="muted">Loading latency chart…</p>}
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}

      {/* Region Legend */}
      <div
        role="region"
        aria-label="Chart legend"
        style={{ display: "flex", gap: 16, marginBottom: 8, flexWrap: "wrap", fontSize: 12 }}
      >
        {regions.map((reg, idx) => {
          const color = getRegionColor(reg, idx);
          const name = REGION_NAMES[reg] ?? reg;
          return (
            <span key={reg} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <span
                style={{
                  display: "inline-block",
                  width: 12,
                  height: 12,
                  borderRadius: "50%",
                  backgroundColor: color,
                }}
              />
              <strong>{name}</strong> <span className="muted">({reg})</span>
            </span>
          );
        })}
        <span style={{ marginLeft: "auto", display: "inline-flex", gap: 12, color: "var(--muted, #64748b)" }}>
          <span>● PASS (Green)</span>
          <span>✖ FAIL (Red)</span>
          <span>○ Missing (Gray)</span>
        </span>
      </div>

      {/* SVG Chart */}
      <div style={{ position: "relative", width: "100%", overflowX: "auto" }}>
        <svg
          viewBox={`0 0 ${svgWidth} ${svgHeight}`}
          width="100%"
          style={{ maxHeight: 300, display: "block", background: "var(--panel, #fbfcf8)", borderRadius: 12, border: "1px solid var(--line, #dce3db)" }}
          role="img"
          aria-label="Interactive latency time-series chart showing response times across regions"
        >
          {/* Y Axis Gridlines and Labels */}
          {yTicks.map(({ val, y }) => (
            <g key={val}>
              <line
                x1={padding.left}
                y1={y}
                x2={svgWidth - padding.right}
                y2={y}
                stroke="#e2e8f0"
                strokeDasharray={val === 0 ? undefined : "3 3"}
              />
              <text
                x={padding.left - 8}
                y={y + 4}
                textAnchor="end"
                fontSize={10}
                fill="#64748b"
                fontFamily="system-ui, sans-serif"
              >
                {val} ms
              </text>
            </g>
          ))}

          {/* X Axis Labels */}
          {xTicks.map(({ label, x }, i) => (
            <text
              key={i}
              x={x}
              y={svgHeight - 12}
              textAnchor="middle"
              fontSize={10}
              fill="#64748b"
              fontFamily="system-ui, sans-serif"
            >
              {label}
            </text>
          ))}

          {/* Axis border */}
          <line
            x1={padding.left}
            y1={padding.top}
            x2={padding.left}
            y2={svgHeight - padding.bottom}
            stroke="#94a3b8"
          />
          <line
            x1={padding.left}
            y1={svgHeight - padding.bottom}
            x2={svgWidth - padding.right}
            y2={svgHeight - padding.bottom}
            stroke="#94a3b8"
          />

          {/* Lines & Data Points by Region */}
          {regions.map((reg, regIdx) => {
            const pts = pointsByRegion[reg] ?? [];
            const color = getRegionColor(reg, regIdx);

            // Filter points with valid latency for line path
            const validPoints = pts.filter((p) => p.latencyMs !== null);
            validPoints.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());

            let pathD = "";
            validPoints.forEach((p, i) => {
              const x = getTimeX(p.time);
              const y = getLatencyY(p.latencyMs);
              if (i === 0) pathD += `M ${x} ${y}`;
              else pathD += ` L ${x} ${y}`;
            });

            return (
              <g key={reg} aria-label={`Series for ${REGION_NAMES[reg] ?? reg}`}>
                {pathD && <path d={pathD} fill="none" stroke={color} strokeWidth={2} opacity={0.85} />}

                {/* Markers */}
                {pts.map((p) => {
                  const x = getTimeX(p.time);
                  const y = getLatencyY(p.latencyMs);
                  const isPass = p.outcome === "PASS";
                  const isFail = p.outcome === "FAIL";
                  const isMissing = p.outcome === null;

                  return (
                    <g
                      key={p.executionId + reg}
                      tabIndex={0}
                      role="graphics-symbol"
                      aria-label={`${REGION_NAMES[reg] ?? reg}: ${p.outcome ?? "MISSING"} (${p.latencyMs !== null ? `${p.latencyMs}ms` : "no latency"}) at ${new Date(p.time).toLocaleTimeString()}`}
                      style={{ cursor: "pointer", outline: "none" }}
                      onMouseEnter={() => setHovered({ point: p, region: reg, x, y })}
                      onMouseLeave={() => setHovered(null)}
                      onFocus={() => setHovered({ point: p, region: reg, x, y })}
                      onBlur={() => setHovered(null)}
                    >
                      {isPass && (
                        <circle
                          cx={x}
                          cy={y}
                          r={4}
                          fill="#16a34a"
                          stroke={color}
                          strokeWidth={1.5}
                        />
                      )}
                      {isFail && (
                        <g transform={`translate(${x}, ${y})`}>
                          <line x1={-4} y1={-4} x2={4} y2={4} stroke="#dc2626" strokeWidth={2} />
                          <line x1={-4} y1={4} x2={4} y2={-4} stroke="#dc2626" strokeWidth={2} />
                        </g>
                      )}
                      {isMissing && (
                        <circle
                          cx={x}
                          cy={y}
                          r={3.5}
                          fill="none"
                          stroke="#94a3b8"
                          strokeWidth={1.5}
                          strokeDasharray="2 2"
                        />
                      )}
                    </g>
                  );
                })}
              </g>
            );
          })}
        </svg>

        {/* Tooltip */}
        {hovered && (
          <div
            role="tooltip"
            style={{
              position: "absolute",
              left: `${(hovered.x / svgWidth) * 100}%`,
              top: `${Math.max(10, hovered.y - 85)}px`,
              transform: "translate(-50%, 0)",
              backgroundColor: "#1e293b",
              color: "#f8fafc",
              padding: "6px 10px",
              borderRadius: 6,
              fontSize: 11,
              pointerEvents: "none",
              boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
              zIndex: 10,
              whiteSpace: "nowrap",
            }}
          >
            <div>
              <strong>{REGION_NAMES[hovered.region] ?? hovered.region}</strong> ({hovered.region})
            </div>
            <div>Time: {new Date(hovered.point.time).toLocaleTimeString()}</div>
            <div>
              Latency:{" "}
              {hovered.point.latencyMs !== null ? `${hovered.point.latencyMs} ms` : "—"}
            </div>
            <div>
              Outcome:{" "}
              <span
                style={{
                  color:
                    hovered.point.outcome === "PASS"
                      ? "#4ade80"
                      : hovered.point.outcome === "FAIL"
                      ? "#f87171"
                      : "#94a3b8",
                }}
              >
                {hovered.point.outcome ?? "MISSING"}
              </span>{" "}
              ({hovered.point.kind})
            </div>
          </div>
        )}
      </div>

      {/* Accessible fallback data table */}
      {showTable && (
        <div id="timeseries-accessible-table" className="table-scroll" style={{ marginTop: 16 }}>
          <table aria-label="Latency time-series points" style={{ width: "100%", fontSize: 12 }}>
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Region</th>
                <th scope="col">Kind</th>
                <th scope="col">Outcome</th>
                <th scope="col">Latency</th>
                <th scope="col">Execution ID</th>
              </tr>
            </thead>
            <tbody>
              {allPoints.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ textAlign: "center", padding: 12 }}>
                    No points available in this time window.
                  </td>
                </tr>
              ) : (
                allPoints.slice(0, 100).map(({ region, point }) => (
                  <tr key={point.executionId + region}>
                    <td>{new Date(point.time).toLocaleString()}</td>
                    <td>{REGION_NAMES[region] ?? region}</td>
                    <td>{point.kind}</td>
                    <td>
                      <span
                        className={`status-badge state-${(point.outcome ?? "unknown").toLowerCase()}`}
                      >
                        {point.outcome ?? "MISSING"}
                      </span>
                    </td>
                    <td>{point.latencyMs !== null ? `${point.latencyMs} ms` : "—"}</td>
                    <td>
                      <code>{point.executionId.slice(0, 8)}</code>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          {allPoints.length > 100 && (
            <p className="muted" style={{ fontSize: 11, marginTop: 4 }}>
              Showing the most recent 100 points of {allPoints.length}.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
