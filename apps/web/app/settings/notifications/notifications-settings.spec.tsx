import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import NotificationSettingsPage from "./page";
import { ApiError } from "../../../lib/api";

const mocks = vi.hoisted(() => ({
  bootstrap: vi.fn(),
  listNotificationChannels: vi.fn(),
  createNotificationChannel: vi.fn(),
  updateNotificationChannel: vi.fn(),
  deleteNotificationChannel: vi.fn(),
  getEscalationPolicy: vi.fn(),
  updateEscalationPolicy: vi.fn(),
}));

vi.mock("../../../lib/api", () => ({
  ...mocks,
  ApiError: class extends Error {
    constructor(public status: number, public envelope: { code: string; message: string; traceId: string }) {
      super(envelope.message);
    }
  },
}));

describe("NotificationSettingsPage", () => {
  const mockChannels = [
    {
      id: "chan-1",
      organizationId: "org-1",
      type: "SLACK",
      name: "Dev Slack",
      config: { secretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:slack-webhook-abc" },
      enabled: true,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    },
    {
      id: "chan-2",
      organizationId: "org-1",
      type: "EMAIL",
      name: "Ops Email",
      config: { recipient: "operations@example.com" },
      enabled: true,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    },
  ];

  const mockPolicy = {
    id: "pol-1",
    organizationId: "org-1",
    name: "Default escalation",
    steps: [
      { id: "s-1", stepOrder: 0, delaySeconds: 0, channelId: "chan-1" },
      { id: "s-2", stepOrder: 1, delaySeconds: 300, channelId: "chan-2" },
      { id: "s-3", stepOrder: 2, delaySeconds: 600, channelId: "chan-2" },
    ],
  };

  beforeEach(() => {
    mocks.bootstrap.mockResolvedValue({
      user: { id: "user-1", email: "admin@example.com" },
      organization: { id: "org-1", name: "Acme Corp", role: "ADMIN" },
    });
    mocks.listNotificationChannels.mockResolvedValue({ items: mockChannels });
    mocks.getEscalationPolicy.mockResolvedValue(mockPolicy);
    mocks.createNotificationChannel.mockResolvedValue({});
    mocks.updateNotificationChannel.mockResolvedValue({});
    mocks.deleteNotificationChannel.mockResolvedValue(undefined);
    mocks.updateEscalationPolicy.mockResolvedValue(mockPolicy);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders channels and escalation policy with destination masking for ADMIN", async () => {
    render(<NotificationSettingsPage />);

    await screen.findByTestId("channels-table");
    expect(screen.getByTestId("channel-row-chan-1")).toBeTruthy();
    expect(screen.getByTestId("channel-row-chan-2")).toBeTruthy();

    // Verify destination masking
    expect(screen.getByText("arn:aws:secretsmanager:...:slack-webhook-abc")).toBeTruthy();
    expect(screen.getByText("o***s@example.com")).toBeTruthy();

    // Admin should see creation form and save policy button
    expect(screen.getByTestId("create-channel-form")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save escalation policy" })).toBeTruthy();
  });

  it("restricts mutations for VIEWER role", async () => {
    mocks.bootstrap.mockResolvedValue({
      user: { id: "user-2", email: "viewer@example.com" },
      organization: { id: "org-1", name: "Acme Corp", role: "VIEWER" },
    });

    render(<NotificationSettingsPage />);

    await screen.findByTestId("channels-table");
    // Viewer should NOT see creation form or save button or delete button
    expect(screen.queryByTestId("create-channel-form")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save escalation policy" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("validates that Slack requires AWS Secrets Manager ARN and Email requires valid format", async () => {
    render(<NotificationSettingsPage />);
    await screen.findByTestId("create-channel-form");

    // Try creating Slack with invalid ARN (e.g. webhook URL)
    fireEvent.change(screen.getByLabelText("Channel name"), { target: { value: "Invalid Slack" } });
    fireEvent.change(screen.getByLabelText("AWS Secrets Manager ARN (contains webhook secret)"), {
      target: { value: "https://hooks.slack.com/services/xxx" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add channel" }));

    await screen.findByText("Slack channel requires a valid AWS Secrets Manager ARN");
    expect(mocks.createNotificationChannel).not.toHaveBeenCalled();

    // Switch to Email
    fireEvent.change(screen.getByLabelText("Channel type"), { target: { value: "EMAIL" } });
    fireEvent.change(screen.getByLabelText("Recipient email address"), { target: { value: "not-an-email" } });
    fireEvent.click(screen.getByRole("button", { name: "Add channel" }));

    await screen.findByText("A valid email address is required");
    expect(mocks.createNotificationChannel).not.toHaveBeenCalled();
  });

  it("shows 409 conflict alert when attempting to delete channel in use", async () => {
    mocks.deleteNotificationChannel.mockRejectedValue(
      new ApiError(409, {
        code: "CHANNEL_IN_USE",
        message: "Cannot delete channel because it is in use",
        traceId: "test",
      }),
    );
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<NotificationSettingsPage />);
    await screen.findByTestId("channels-table");

    const deleteButtons = screen.getAllByRole("button", { name: "Delete" });
    fireEvent.click(deleteButtons[0]!);

    await screen.findByText(/Cannot delete channel "Dev Slack" because it is currently in use/);
  });
});
