import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MonitorConsole } from "./monitor-console";
vi.mock("../lib/events", () => ({ subscribeEvents: () => () => undefined }));

const mocks = vi.hoisted(() => ({
  bootstrap: vi.fn(),
  listMonitors: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  ApiError: class ApiError extends Error {
    status = 500;
    envelope = { code: "TEST", message: "test", traceId: "test" };
  },
  bootstrap: mocks.bootstrap,
  listMonitors: mocks.listMonitors,
  createMonitor: vi.fn(),
  updateMonitor: vi.fn(),
  deleteMonitor: vi.fn(),
}));

describe("MonitorConsole role behavior", () => {
  beforeEach(() => {
    mocks.bootstrap.mockResolvedValue({
      user: { id: "viewer", email: "viewer@example.test" },
      organization: { id: "22222222-2222-4222-8222-222222222222", name: "Viewer workspace", role: "VIEWER" },
    });
    mocks.listMonitors.mockResolvedValue({ items: [], nextCursor: null });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("does not render monitor mutation controls for viewers", async () => {
    render(<MonitorConsole />);
    await screen.findByText("0 monitors");
    expect(screen.queryByLabelText("Monitor name")).toBeNull();
    expect(screen.queryByRole("button", { name: "Create monitor" })).toBeNull();
  });
});
