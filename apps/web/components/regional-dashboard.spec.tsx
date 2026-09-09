import React from "react";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MonitorSnapshot } from "@argus/contracts";
import fixtures from "../../../packages/contracts/examples/week3-three-region.json";
import { RegionalDashboard, RegionalSnapshotView } from "./regional-dashboard";
import { ApiError } from "../lib/api";

const mocks = vi.hoisted(() => ({ getMonitorSnapshot: vi.fn(), subscribeEvents: vi.fn() }));
vi.mock("../lib/api", () => ({ getMonitorSnapshot: mocks.getMonitorSnapshot, ApiError: class extends Error { constructor(public status: number) { super("API failed"); } } }));
vi.mock("../lib/events", () => ({ subscribeEvents: mocks.subscribeEvents }));
const snapshot = (name: keyof typeof fixtures.snapshots) => structuredClone(fixtures.snapshots[name]) as MonitorSnapshot;
describe("regional dashboard contract", () => {
  beforeEach(() => { mocks.subscribeEvents.mockReturnValue(vi.fn()); mocks.getMonitorSnapshot.mockResolvedValue(snapshot("healthy")); });
  afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });
  it("distinguishes missing results, missing heartbeat and check failures without inventing zero latency", () => {
    const value = snapshot("missing"); value.regions[0]!.outcome = "FAIL"; value.regions[0]!.latencyMs = 0;
    render(<RegionalSnapshotView snapshot={value} connection="reconnecting" />);
    const missing = within(screen.getByRole("article", { name: "Frankfurt live result" }));
    expect(missing.getByText("No result yet")).toBeTruthy();
    expect(missing.getByText("Heartbeat missing")).toBeTruthy();
    expect(missing.getByText("—")).toBeTruthy();
    expect(screen.getByText("Check failed")).toBeTruthy();
    expect(screen.getByText("0 ms")).toBeTruthy();
    expect(screen.getByText(/disconnected/)).toBeTruthy();
  });
  it.each(["empty", "healthy", "failure", "stale", "missing"] as const)("renders shared %s fixture", (name) => {
    render(<RegionalSnapshotView snapshot={snapshot(name)} connection="connected" />);
    expect(screen.getAllByRole("article")).toHaveLength(3);
  });
  it("refetches on result invalidation and successful reconnect", async () => {
    const value = snapshot("healthy");
    render(<RegionalDashboard organizationId={value.organizationId} monitorId={value.monitorId} />);
    await screen.findAllByText("Passing");
    mocks.getMonitorSnapshot.mockResolvedValue(snapshot("failure"));
    act(() => mocks.subscribeEvents.mock.calls[0]![1]({ type: "probe.result_received" }));
    await screen.findByText("Check failed");
    const count = mocks.getMonitorSnapshot.mock.calls.length;
    act(() => mocks.subscribeEvents.mock.calls[0]![2]("connected"));
    await vi.waitFor(() => expect(mocks.getMonitorSnapshot.mock.calls.length).toBeGreaterThan(count));
  });
  it("clears tenant data, closes the old stream and ignores old in-flight responses on organization switch", async () => {
    const value = snapshot("healthy");
    const { rerender } = render(<RegionalDashboard organizationId={value.organizationId} monitorId={value.monitorId} />);
    await screen.findAllByText("Passing");
    let finish!: (value: MonitorSnapshot) => void;
    mocks.getMonitorSnapshot.mockImplementation(() => new Promise<MonitorSnapshot>((resolve) => { finish = resolve; }));
    act(() => mocks.subscribeEvents.mock.calls[0]![1]({ type: "system.resync_required" }));
    const oldFinish = finish;
    rerender(<RegionalDashboard organizationId={fixtures.organizations[1]!.id} monitorId={value.monitorId} />);
    expect(screen.queryByText(/Current health/)).toBeNull();
    expect(mocks.subscribeEvents.mock.results[0]!.value).toHaveBeenCalledOnce();
    await act(async () => oldFinish(value));
    expect(screen.queryByText(/Current health/)).toBeNull();
  });
  it("clears data on stream authorization failure", async () => {
    const value = snapshot("healthy");
    render(<RegionalDashboard organizationId={value.organizationId} monitorId={value.monitorId} />);
    await screen.findAllByText("Passing");
    act(() => mocks.subscribeEvents.mock.calls[0]![2]("unauthorized"));
    expect(screen.queryByText(/Current health/)).toBeNull();
    expect(screen.getByText(/Access expired/)).toBeTruthy();
  });
  it.each([401, 403, 404])("clears data and stops requests immediately after HTTP %i", async (status) => {
    const value = snapshot("healthy");
    render(<RegionalDashboard organizationId={value.organizationId} monitorId={value.monitorId} />);
    await screen.findAllByText("Passing");
    mocks.getMonitorSnapshot.mockRejectedValue(new ApiError(status, { code: "DENIED", message: "Denied", traceId: "test" }));
    act(() => mocks.subscribeEvents.mock.calls[0]![1]({ type: "system.resync_required" }));
    await screen.findByText("Regional data unavailable.");
    expect(screen.queryByText(/Current health/)).toBeNull();
    expect(mocks.subscribeEvents.mock.results[0]!.value).toHaveBeenCalledOnce();
  });
  it("preserves the last snapshot on network failure and clears the warning after recovery", async () => {
    const value = snapshot("healthy");
    render(<RegionalDashboard organizationId={value.organizationId} monitorId={value.monitorId} />);
    await screen.findAllByText("Passing");
    mocks.getMonitorSnapshot.mockRejectedValueOnce(new TypeError("Network unavailable"));
    act(() => mocks.subscribeEvents.mock.calls[0]![1]({ type: "system.resync_required" }));
    await screen.findByRole("alert"); expect(screen.getAllByText("Passing")).toHaveLength(3);
    mocks.getMonitorSnapshot.mockResolvedValue(snapshot("failure"));
    act(() => mocks.subscribeEvents.mock.calls[0]![2]("connected"));
    await screen.findByText("Check failed"); expect(screen.queryByRole("alert")).toBeNull();
  });
  it("refreshes stale heartbeat without receiving an SSE event", async () => {
    const value = snapshot("healthy");
    render(<RegionalDashboard organizationId={value.organizationId} monitorId={value.monitorId} />);
    await screen.findAllByText("Alive");
    // Mount under fake time so the 15-second interval can be exercised deterministically.
    cleanup(); vi.useFakeTimers();
    render(<RegionalDashboard organizationId={value.organizationId} monitorId={value.monitorId} />);
    await act(async () => { await Promise.resolve(); });
    mocks.getMonitorSnapshot.mockResolvedValue(snapshot("stale"));
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(screen.getAllByText("Heartbeat missing")).toHaveLength(3);
    expect(screen.getAllByText("Passing")).toHaveLength(3);
  });
});
