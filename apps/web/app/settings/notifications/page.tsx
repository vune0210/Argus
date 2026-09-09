"use client";

import type {
  BootstrapResponse,
  CreateNotificationChannelRequest,
  EscalationPolicy,
  NotificationChannel,
} from "@argus/contracts";
import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  bootstrap,
  createNotificationChannel,
  deleteNotificationChannel,
  getEscalationPolicy,
  listNotificationChannels,
  updateEscalationPolicy,
  updateNotificationChannel,
} from "../../../lib/api";

function maskValue(value?: string | null): string {
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
    return `arn:aws:secretsmanager:...:${parts[parts.length - 1] ?? ""}`;
  }
  return "***";
}

export default function NotificationSettingsPage() {
  const [session, setSession] = useState<BootstrapResponse>();
  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  const [policy, setPolicy] = useState<EscalationPolicy>();
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState<string>();
  const [loading, setLoading] = useState(true);

  // New channel form state
  const [newType, setNewType] = useState<"SLACK" | "EMAIL">("SLACK");
  const [newName, setNewName] = useState("");
  const [newSecretArn, setNewSecretArn] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newEnabled, setNewEnabled] = useState(true);
  const [creating, setCreating] = useState(false);

  // Policy step selections: step 0 (PRIMARY), step 1 (SECONDARY), step 2 (TEAM)
  const [primaryChannelId, setPrimaryChannelId] = useState("");
  const [secondaryChannelId, setSecondaryChannelId] = useState("");
  const [teamChannelId, setTeamChannelId] = useState("");
  const [savingPolicy, setSavingPolicy] = useState(false);

  const canEdit =
    session?.organization.role === "OWNER" ||
    session?.organization.role === "ADMIN";

  const refreshData = useCallback(async (orgId: string) => {
    try {
      const [channelsRes, policyRes] = await Promise.all([
        listNotificationChannels(orgId),
        getEscalationPolicy(orgId),
      ]);
      setChannels(channelsRes.items);
      setPolicy(policyRes);

      // Pre-fill steps
      if (policyRes.steps && policyRes.steps.length >= 3) {
        setPrimaryChannelId(policyRes.steps[0]?.channelId || "");
        setSecondaryChannelId(policyRes.steps[1]?.channelId || "");
        setTeamChannelId(policyRes.steps[2]?.channelId || "");
      }
    } catch (caught) {
      if (caught instanceof ApiError) {
        setError(caught.envelope.message);
      } else {
        setError("Failed to load notification settings");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const userSession = await bootstrap();
        setSession(userSession);
        await refreshData(userSession.organization.id);
      } catch (caught) {
        if (caught instanceof ApiError && caught.status === 401) {
          window.location.assign("/login");
        } else {
          setError("Failed to load session");
          setLoading(false);
        }
      }
    })();
  }, [refreshData]);

  async function handleCreateChannel(e: React.FormEvent) {
    e.preventDefault();
    if (!session || !canEdit) return;
    setError(undefined);
    setSuccess(undefined);

    // Validation
    if (!newName.trim()) {
      setError("Channel name is required");
      return;
    }

    if (newType === "SLACK") {
      if (!newSecretArn.startsWith("arn:aws:secretsmanager:")) {
        setError("Slack channel requires a valid AWS Secrets Manager ARN");
        return;
      }
    } else if (newType === "EMAIL") {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
        setError("A valid email address is required");
        return;
      }
    }

    setCreating(true);
    try {
      const payload: CreateNotificationChannelRequest = {
        name: newName.trim(),
        type: newType,
        enabled: newEnabled,
        config:
          newType === "SLACK"
            ? { secretArn: newSecretArn.trim() }
            : { recipient: newEmail.trim() },
      };

      await createNotificationChannel(session.organization.id, payload);
      setSuccess(`Channel "${newName}" created successfully`);
      setNewName("");
      setNewSecretArn("");
      setNewEmail("");
      setNewEnabled(true);
      await refreshData(session.organization.id);
    } catch (caught) {
      if (caught instanceof ApiError) {
        setError(caught.envelope.message);
      } else {
        setError("Failed to create notification channel");
      }
    } finally {
      setCreating(false);
    }
  }

  async function handleToggleChannel(channel: NotificationChannel) {
    if (!session || !canEdit) return;
    setError(undefined);
    try {
      await updateNotificationChannel(session.organization.id, channel.id, {
        enabled: !channel.enabled,
      });
      await refreshData(session.organization.id);
    } catch (caught) {
      if (caught instanceof ApiError) {
        setError(caught.envelope.message);
      } else {
        setError("Failed to update channel");
      }
    }
  }

  async function handleDeleteChannel(id: string, name: string) {
    if (!session || !canEdit) return;
    if (!window.confirm(`Are you sure you want to delete channel "${name}"?`)) {
      return;
    }
    setError(undefined);
    try {
      await deleteNotificationChannel(session.organization.id, id);
      setSuccess(`Channel "${name}" deleted`);
      await refreshData(session.organization.id);
    } catch (caught) {
      if (caught instanceof ApiError) {
        if (caught.envelope.code === "CHANNEL_IN_USE" || caught.status === 409) {
          setError(
            `Cannot delete channel "${name}" because it is currently in use by an escalation policy step. You can disable it instead.`,
          );
        } else {
          setError(caught.envelope.message);
        }
      } else {
        setError("Failed to delete channel");
      }
    }
  }

  async function handleSavePolicy(e: React.FormEvent) {
    e.preventDefault();
    if (!session || !canEdit) return;
    setError(undefined);
    setSuccess(undefined);

    if (!primaryChannelId || !secondaryChannelId || !teamChannelId) {
      setError("All 3 escalation steps must have an assigned channel.");
      return;
    }

    setSavingPolicy(true);
    try {
      await updateEscalationPolicy(session.organization.id, {
        name: policy?.name || "Default escalation",
        steps: [
          {
            stepOrder: 0,
            delaySeconds: 0,
            channelId: primaryChannelId,
          },
          {
            stepOrder: 1,
            delaySeconds: 300,
            channelId: secondaryChannelId,
          },
          {
            stepOrder: 2,
            delaySeconds: 600,
            channelId: teamChannelId,
          },
        ],
      });
      setSuccess("Escalation policy saved successfully");
      await refreshData(session.organization.id);
    } catch (caught) {
      if (caught instanceof ApiError) {
        setError(caught.envelope.message);
      } else {
        setError("Failed to update escalation policy");
      }
    } finally {
      setSavingPolicy(false);
    }
  }

  const enabledChannels = channels.filter((c) => c.enabled);

  return (
    <main className="pipeline-shell">
      <nav aria-label="Primary navigation">
        <a href="/monitors">Monitors</a>
        <a href="/incidents">Incidents</a>
        <a href="/settings/notifications" style={{ fontWeight: "bold" }}>
          Notification settings
        </a>
        <a href="/api/auth/logout">Sign out</a>
      </nav>

      <header className="section-heading">
        <div>
          <p className="eyebrow">{session?.organization.name ?? "Argus"}</p>
          <h1>Notification settings & Escalation</h1>
        </div>
      </header>

      {error && (
        <p role="alert" className="error-banner" data-testid="error-banner">
          {error}
        </p>
      )}
      {success && (
        <p
          role="status"
          style={{
            color: "#16a34a",
            background: "#dcfce7",
            padding: "12px",
            borderRadius: "8px",
            marginBottom: "16px",
          }}
        >
          {success}
        </p>
      )}

      {loading ? (
        <p>Loading notification settings…</p>
      ) : (
        <>
          {/* Notification Channels Section */}
          <section aria-labelledby="channels-heading">
            <h2 id="channels-heading">Notification channels</h2>
            <p className="muted">
              Configure delivery targets for incident escalations. Webhook secrets must be
              referenced via AWS Secrets Manager ARN.
            </p>

            {canEdit && (
              <article
                className="channel-list-card"
                data-testid="create-channel-form"
              >
                <h3>Add notification channel</h3>
                <form noValidate onSubmit={(e) => void handleCreateChannel(e)}>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr",
                      gap: "16px",
                      marginBottom: "16px",
                    }}
                  >
                    <div>
                      <label htmlFor="channel-type" style={{ display: "block", marginBottom: "4px" }}>
                        Channel type
                      </label>
                      <select
                        id="channel-type"
                        value={newType}
                        onChange={(e) => setNewType(e.target.value as "SLACK" | "EMAIL")}
                        style={{ width: "100%", padding: "8px" }}
                      >
                        <option value="SLACK">Slack</option>
                        <option value="EMAIL">Email</option>
                      </select>
                    </div>
                    <div>
                      <label htmlFor="channel-name" style={{ display: "block", marginBottom: "4px" }}>
                        Channel name
                      </label>
                      <input
                        id="channel-name"
                        type="text"
                        placeholder="e.g. Primary Slack / Ops Email"
                        value={newName}
                        onChange={(e) => setNewName(e.target.value)}
                        required
                        style={{ width: "100%", padding: "8px" }}
                      />
                    </div>
                  </div>

                  {newType === "SLACK" ? (
                    <div style={{ marginBottom: "16px" }}>
                      <label htmlFor="slack-arn" style={{ display: "block", marginBottom: "4px" }}>
                        AWS Secrets Manager ARN (contains webhook secret)
                      </label>
                      <input
                        id="slack-arn"
                        type="text"
                        placeholder="arn:aws:secretsmanager:REGION:ACCOUNT:secret:NAME"
                        value={newSecretArn}
                        onChange={(e) => setNewSecretArn(e.target.value)}
                        required
                        style={{ width: "100%", padding: "8px" }}
                      />
                      <small className="muted">
                        No raw webhook URLs are accepted. Store webhook in Secrets Manager.
                      </small>
                    </div>
                  ) : (
                    <div style={{ marginBottom: "16px" }}>
                      <label htmlFor="email-recipient" style={{ display: "block", marginBottom: "4px" }}>
                        Recipient email address
                      </label>
                      <input
                        id="email-recipient"
                        type="email"
                        placeholder="ops@example.com"
                        value={newEmail}
                        onChange={(e) => setNewEmail(e.target.value)}
                        required
                        style={{ width: "100%", padding: "8px" }}
                      />
                    </div>
                  )}

                  <div style={{ marginBottom: "16px", display: "flex", alignItems: "center", gap: "8px" }}>
                    <input
                      id="channel-enabled"
                      type="checkbox"
                      checked={newEnabled}
                      onChange={(e) => setNewEnabled(e.target.checked)}
                    />
                    <label htmlFor="channel-enabled">Enabled for escalations</label>
                  </div>

                  <button
                    type="submit"
                    className="primary-button"
                    disabled={creating}
                  >
                    {creating ? "Creating…" : "Add channel"}
                  </button>
                </form>
              </article>
            )}

            <div className="table-scroll">
              <table data-testid="channels-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Type</th>
                    <th>Destination (Masked)</th>
                    <th>Status</th>
                    {canEdit && <th>Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {!channels.length ? (
                    <tr>
                      <td colSpan={canEdit ? 5 : 4}>No notification channels configured yet.</td>
                    </tr>
                  ) : (
                    channels.map((channel) => (
                      <tr key={channel.id} data-testid={`channel-row-${channel.id}`}>
                        <td><strong>{channel.name}</strong></td>
                        <td>
                          <span
                            className={`channel-badge ${
                              channel.type === "SLACK"
                                ? "channel-badge-slack"
                                : "channel-badge-email"
                            }`}
                          >
                            {channel.type}
                          </span>
                        </td>
                        <td>
                          <code>
                            {maskValue(channel.config.secretArn || channel.config.recipient)}
                          </code>
                        </td>
                        <td>
                          <span
                            className={`status-badge ${
                              channel.enabled ? "state-healthy" : "state-down"
                            }`}
                          >
                            {channel.enabled ? "Enabled" : "Disabled"}
                          </span>
                        </td>
                        {canEdit && (
                          <td>
                            <div style={{ display: "flex", gap: "8px" }}>
                              <button
                                type="button"
                                className="text-button"
                                onClick={() => void handleToggleChannel(channel)}
                              >
                                {channel.enabled ? "Disable" : "Enable"}
                              </button>
                              <button
                                type="button"
                                className="text-button"
                                style={{ color: "#ef4444" }}
                                onClick={() => void handleDeleteChannel(channel.id, channel.name)}
                              >
                                Delete
                              </button>
                            </div>
                          </td>
                        )}
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {/* Escalation Policy Section */}
          <section aria-labelledby="policy-heading" style={{ marginTop: "40px" }}>
            <h2 id="policy-heading">Escalation policy (3-step)</h2>
            <p className="muted">
              Define the multi-tier escalation chain for new incidents. Deliveries trigger at 0s, 5m, and 10m unless acknowledged.
            </p>

            <form onSubmit={(e) => void handleSavePolicy(e)}>
              <div className="channel-list-card">
                <div className="policy-step-row">
                  <div><strong>1. PRIMARY</strong></div>
                  <div><code>Immediately (0s)</code></div>
                  <div>
                    {canEdit ? (
                      <select
                        aria-label="Primary step channel"
                        value={primaryChannelId}
                        onChange={(e) => setPrimaryChannelId(e.target.value)}
                        style={{ width: "100%", padding: "8px" }}
                        required
                      >
                        <option value="">Select enabled channel…</option>
                        {enabledChannels.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name} ({c.type})
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span>
                        {channels.find((c) => c.id === primaryChannelId)?.name ?? "None configured"}
                      </span>
                    )}
                  </div>
                </div>

                <div className="policy-step-row">
                  <div><strong>2. SECONDARY</strong></div>
                  <div><code>After 5 minutes (300s)</code></div>
                  <div>
                    {canEdit ? (
                      <select
                        aria-label="Secondary step channel"
                        value={secondaryChannelId}
                        onChange={(e) => setSecondaryChannelId(e.target.value)}
                        style={{ width: "100%", padding: "8px" }}
                        required
                      >
                        <option value="">Select enabled channel…</option>
                        {enabledChannels.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name} ({c.type})
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span>
                        {channels.find((c) => c.id === secondaryChannelId)?.name ?? "None configured"}
                      </span>
                    )}
                  </div>
                </div>

                <div className="policy-step-row" style={{ borderBottom: "none" }}>
                  <div><strong>3. TEAM</strong></div>
                  <div><code>After 10 minutes (600s)</code></div>
                  <div>
                    {canEdit ? (
                      <select
                        aria-label="Team step channel"
                        value={teamChannelId}
                        onChange={(e) => setTeamChannelId(e.target.value)}
                        style={{ width: "100%", padding: "8px" }}
                        required
                      >
                        <option value="">Select enabled channel…</option>
                        {enabledChannels.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name} ({c.type})
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span>
                        {channels.find((c) => c.id === teamChannelId)?.name ?? "None configured"}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {canEdit && (
                <button
                  type="submit"
                  className="primary-button"
                  disabled={savingPolicy || enabledChannels.length === 0}
                >
                  {savingPolicy ? "Saving policy…" : "Save escalation policy"}
                </button>
              )}
            </form>
          </section>
        </>
      )}
    </main>
  );
}
