import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExecutionConsole } from "./execution-console";
import { ApiError } from "../lib/api";

const mocks = vi.hoisted(() => ({
  bootstrap: vi.fn(),
  getMonitor: vi.fn(),
  getMonitorSnapshot: vi.fn(),
  listExecutions: vi.fn(),
  getExecution: vi.fn(),
  listIncidents: vi.fn(),
  getIncident: vi.fn(),
  ackIncident: vi.fn(),
  resolveIncident: vi.fn(),
  runMonitor: vi.fn(),
  evaluateMonitor: vi.fn(),
  getMonitorTimeseries: vi.fn(),
  subscribe: vi.fn(),
}));
vi.mock("../lib/api", () => ({ ...mocks, ApiError: class extends Error { constructor(public status: number) { super("API failed"); } } }));
vi.mock("../lib/events", () => ({ subscribeEvents: mocks.subscribe }));
describe("execution experience", () => {
  beforeEach(() => {
    mocks.bootstrap.mockResolvedValue({ user: { id: "user" }, organization: { id: "org", name: "Workspace", role: "RESPONDER" } });
    mocks.getMonitor.mockResolvedValue({ id: "monitor", name: "API", version: 1, healthState: "HEALTHY", config: { url: "https://example.com" } });
    mocks.getMonitorSnapshot.mockResolvedValue({ organizationId: "org", monitorId: "monitor", healthState: "HEALTHY", observedAt: "2026-01-01T00:00:00Z", regions: [] });
    mocks.listExecutions.mockResolvedValue({ items: [{ id: "execution", kind: "SCHEDULED", status: "COMPLETED", scheduledAt: "2026-01-01T00:00:00Z", observation: "INSUFFICIENT_RESULTS" }] });
    mocks.getExecution.mockResolvedValue({ id: "execution", targets: [{ id: "target", region: "eu-central-1", status: "EXPIRED", result: null }] });
    mocks.listIncidents.mockResolvedValue({ items: [] });
    mocks.runMonitor.mockResolvedValue({ id: "diagnostic" });
    mocks.evaluateMonitor.mockResolvedValue({ id: "evaluation-exec" });
    mocks.getMonitorTimeseries.mockResolvedValue({
      monitorId: "monitor",
      from: "2026-01-01T00:00:00Z",
      to: "2026-01-02T00:00:00Z",
      truncated: false,
      series: {
        "ap-southeast-1": [
          { executionId: "exec-1", time: "2026-01-01T12:00:00Z", kind: "SCHEDULED", outcome: "PASS", latencyMs: 42 },
        ],
      },
    });
    mocks.subscribe.mockReturnValue(vi.fn());
  });
  afterEach(() => { cleanup(); vi.clearAllMocks(); });
  it("shows missing-region diagnostics and allows responders to run", async () => {
    render(<ExecutionConsole monitorId="monitor" />);
    await screen.findByText("No result received");
    expect(screen.getByText("INSUFFICIENT_RESULTS")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Run now" }));
    await vi.waitFor(() => expect(mocks.runMonitor).toHaveBeenCalledWith("org", "monitor"));
  });
  it("hides diagnostic mutations for viewers and refetches on resync", async () => {
    mocks.bootstrap.mockResolvedValue({ user: {}, organization: { id: "org", role: "VIEWER" } });
    render(<ExecutionConsole monitorId="monitor" />);
    await vi.waitFor(() => expect(mocks.subscribe).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Run now" })).toBeNull();
    const before = mocks.getMonitor.mock.calls.length;
    for (const call of mocks.subscribe.mock.calls) call[1]({ type: "system.resync_required" });
    await vi.waitFor(() => expect(mocks.getMonitor.mock.calls.length).toBeGreaterThan(before));
  });
  it("removes monitor and execution data after permission is revoked", async () => {
    render(<ExecutionConsole monitorId="monitor" />);
    await screen.findByText("No result received");
    mocks.getMonitor.mockRejectedValue(new ApiError(403, { code: "DENIED", message: "Denied", traceId: "test" }));
    for (const call of mocks.subscribe.mock.calls) call[1]({ type: "system.resync_required" });
    await screen.findByText("Access to this organization or resource is no longer available.");
    expect(screen.queryByText("https://example.com")).toBeNull();
    expect(screen.queryByText("No result received")).toBeNull();
    expect(screen.queryByRole("button", { name: "Run now" })).toBeNull();
  });
  it("renders incident deliveries timeline and cancels pending steps on ACK", async () => {
    const mockIncident = {
      id: "inc-12345678",
      organizationId: "org",
      monitorId: "monitor",
      status: "OPEN",
      openedAt: "2026-01-01T00:00:00Z",
      acknowledgedAt: null,
      acknowledgedBy: null,
      resolvedAt: null,
      resolvedBy: null,
      events: [{ id: "ev-1", type: "OPENED", occurredAt: "2026-01-01T00:00:00Z", actor: null }],
      deliveries: [
        {
          id: "del-1",
          incidentId: "inc-12345678",
          escalationStepId: "step-1",
          channelId: "chan-1",
          status: "SENT",
          attempts: 1,
          scheduledAt: "2026-01-01T00:00:00Z",
          nextAttemptAt: "2026-01-01T00:00:00Z",
          lastAttemptedAt: "2026-01-01T00:00:02Z",
          lastError: null,
        },
        {
          id: "del-2",
          incidentId: "inc-12345678",
          escalationStepId: "step-2",
          channelId: "chan-2",
          status: "PENDING",
          attempts: 0,
          scheduledAt: "2026-01-01T00:05:00Z",
          nextAttemptAt: "2026-01-01T00:05:00Z",
          lastAttemptedAt: null,
          lastError: null,
        },
        {
          id: "del-3",
          incidentId: "inc-12345678",
          escalationStepId: "step-3",
          channelId: "chan-3",
          status: "PENDING",
          attempts: 0,
          scheduledAt: "2026-01-01T00:10:00Z",
          nextAttemptAt: "2026-01-01T00:10:00Z",
          lastAttemptedAt: null,
          lastError: null,
        },
      ],
    };

    const ackIncidentMock = vi.fn().mockResolvedValue({
      ...mockIncident,
      status: "ACKNOWLEDGED",
      acknowledgedAt: "2026-01-01T00:01:00Z",
      acknowledgedBy: "user",
      deliveries: [
        { ...mockIncident.deliveries[0] },
        { ...mockIncident.deliveries[1], status: "CANCELED" },
        { ...mockIncident.deliveries[2], status: "CANCELED" },
      ],
    });

    const getIncidentMock = vi.fn()
      .mockResolvedValueOnce(mockIncident)
      .mockResolvedValue({
        ...mockIncident,
        status: "ACKNOWLEDGED",
        acknowledgedAt: "2026-01-01T00:01:00Z",
        acknowledgedBy: "user",
        deliveries: [
          { ...mockIncident.deliveries[0] },
          { ...mockIncident.deliveries[1], status: "CANCELED" },
          { ...mockIncident.deliveries[2], status: "CANCELED" },
        ],
      });
    const { getIncident, ackIncident } = await import("../lib/api");
    vi.mocked(getIncident).mockImplementation(getIncidentMock);
    vi.mocked(ackIncident).mockImplementation(ackIncidentMock);

    render(<ExecutionConsole incidentId="inc-12345678" />);

    // Check delivery timeline table rendered
    await screen.findByTestId("deliveries-table");
    expect(screen.getByText("Primary")).toBeTruthy();
    expect(screen.getByText("Secondary")).toBeTruthy();
    expect(screen.getByText("Team")).toBeTruthy();
    expect(screen.getByText("SENT")).toBeTruthy();

    // Click Acknowledge
    const ackButton = screen.getByRole("button", { name: "Acknowledge" });
    fireEvent.click(ackButton);

    await vi.waitFor(() => expect(ackIncidentMock).toHaveBeenCalledWith("org", "inc-12345678"));
    // Verify pending deliveries transitioned to CANCELED
    await screen.findAllByText("CANCELED");
  });
  it("refetches incident when notification event arrives over SSE", async () => {
    const mockIncident = {
      id: "inc-12345678",
      organizationId: "org",
      monitorId: "monitor",
      status: "OPEN",
      openedAt: "2026-01-01T00:00:00Z",
      acknowledgedAt: null,
      acknowledgedBy: null,
      resolvedAt: null,
      resolvedBy: null,
      events: [],
      deliveries: [],
    };

    const getIncidentMock = vi.fn().mockResolvedValue(mockIncident);
    const { getIncident } = await import("../lib/api");
    vi.mocked(getIncident).mockImplementation(getIncidentMock);

    render(<ExecutionConsole incidentId="inc-12345678" />);
    await vi.waitFor(() => expect(mocks.subscribe).toHaveBeenCalled());

    const initialCalls = getIncidentMock.mock.calls.length;
    // Dispatch SSE notification.sent
    for (const call of mocks.subscribe.mock.calls) {
      call[1]({ type: "notification.sent", payload: { deliveryId: "del-1" } });
    }

    await vi.waitFor(() => expect(getIncidentMock.mock.calls.length).toBeGreaterThan(initialCalls));
  });
  it("prompts confirmation modal for Evaluate now and invokes evaluateMonitor when confirmed", async () => {
    render(<ExecutionConsole monitorId="monitor" />);
    await screen.findByText("No result received");
    const evalButton = screen.getByRole("button", { name: "Evaluate now" });
    expect(evalButton).toBeTruthy();

    // Click Evaluate now to show confirmation
    fireEvent.click(evalButton);
    expect(screen.getByText("Confirm Authoritative Health Evaluation")).toBeTruthy();

    // Click Confirm & Evaluate
    const confirmButton = screen.getByRole("button", { name: "Confirm & Evaluate" });
    fireEvent.click(confirmButton);

    await vi.waitFor(() => expect(mocks.evaluateMonitor).toHaveBeenCalledWith("org", "monitor", 1));
  });
  it("cancels Evaluate now modal without invoking evaluateMonitor", async () => {
    render(<ExecutionConsole monitorId="monitor" />);
    await screen.findByText("No result received");

    fireEvent.click(screen.getByRole("button", { name: "Evaluate now" }));
    expect(screen.getByText("Confirm Authoritative Health Evaluation")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Confirm Authoritative Health Evaluation")).toBeNull();
    expect(mocks.evaluateMonitor).not.toHaveBeenCalled();
  });
  it("renders TimeSeriesChart and toggles accessible fallback data table", async () => {
    render(<ExecutionConsole monitorId="monitor" />);
    await screen.findByText("Latency History by Region");

    // Toggle table
    const toggleBtn = screen.getByRole("button", { name: "Show data table" });
    fireEvent.click(toggleBtn);
    expect(screen.getByText("Hide data table")).toBeTruthy();
    expect(screen.getByRole("table", { name: "Latency time-series points" })).toBeTruthy();
  });
});

