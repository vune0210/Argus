"use client";

import type {
  BootstrapResponse,
  CreateStatusPageRequest,
  Monitor,
  StatusPage,
  StatusPageSummary,
  UpdateStatusPageRequest,
} from "@argus/contracts";
import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  bootstrap,
  createStatusPage,
  deleteStatusPage,
  getStatusPage,
  listMonitors,
  listStatusPages,
  updateStatusPage,
} from "../../lib/api";

interface ComponentFormItem {
  monitorId: string;
  publicName: string;
}

export default function StatusPagesAdminPage() {
  const [session, setSession] = useState<BootstrapResponse>();
  const [pages, setPages] = useState<StatusPageSummary[]>([]);
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState<string>();

  // Editor Modal / Card state
  const [isEditing, setIsEditing] = useState(false);
  const [editingPageId, setEditingPageId] = useState<string | null>(null);
  const [editingVersion, setEditingVersion] = useState<number>(1);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [published, setPublished] = useState(false);
  const [components, setComponents] = useState<ComponentFormItem[]>([]);
  const [saving, setSaving] = useState(false);

  const canWrite =
    session?.organization.role === "OWNER" || session?.organization.role === "ADMIN";

  const refresh = useCallback(async (orgId: string) => {
    try {
      const [pageData, monitorData] = await Promise.all([
        listStatusPages(orgId),
        listMonitors(orgId),
      ]);
      setPages(pageData.items);
      setMonitors(monitorData.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load status pages");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    bootstrap()
      .then((sess) => {
        if (!active) return;
        setSession(sess);
        return refresh(sess.organization.id);
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : "Bootstrap failed");
      });
    return () => {
      active = false;
    };
  }, [refresh]);

  const openCreate = () => {
    setEditingPageId(null);
    setEditingVersion(1);
    setName("");
    setSlug("");
    setDescription("");
    setPublished(false);
    setComponents(
      monitors.length > 0 ? [{ monitorId: monitors[0]!.id, publicName: monitors[0]!.name }] : [],
    );
    setError(undefined);
    setSuccess(undefined);
    setIsEditing(true);
  };

  const openEdit = async (pageSummary: StatusPageSummary) => {
    if (!session) return;
    setError(undefined);
    setSuccess(undefined);
    try {
      const detail: StatusPage = await getStatusPage(session.organization.id, pageSummary.id);
      setEditingPageId(detail.id);
      setEditingVersion(detail.version);
      setName(detail.name);
      setSlug(detail.slug);
      setDescription(detail.description ?? "");
      setPublished(detail.published);
      setComponents(
        detail.components.map((c) => ({
          monitorId: c.monitorId,
          publicName: c.publicName,
        })),
      );
      setIsEditing(true);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load status page details");
    }
  };

  const addComponent = () => {
    if (monitors.length === 0) return;
    const unusedMonitor = monitors.find((m) => !components.some((c) => c.monitorId === m.id));
    const targetMonitor = unusedMonitor ?? monitors[0]!;
    setComponents([...components, { monitorId: targetMonitor.id, publicName: targetMonitor.name }]);
  };

  const removeComponent = (index: number) => {
    setComponents(components.filter((_, i) => i !== index));
  };

  const moveComponent = (from: number, to: number) => {
    if (to < 0 || to >= components.length) return;
    const updated = [...components];
    const item = updated.splice(from, 1)[0]!;
    updated.splice(to, 0, item);
    setComponents(updated);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!session) return;

    if (published && components.length === 0) {
      setError("A published status page must contain at least one component.");
      return;
    }

    setSaving(true);
    setError(undefined);
    setSuccess(undefined);

    try {
      if (editingPageId) {
        const payload: UpdateStatusPageRequest = {
          version: editingVersion,
          name: name.trim(),
          slug: slug.trim().toLowerCase(),
          description: description.trim() || undefined,
          published,
          components: components.map((c) => ({
            monitorId: c.monitorId,
            publicName: c.publicName.trim(),
          })),
        };
        await updateStatusPage(session.organization.id, editingPageId, payload);
        setSuccess("Status page updated successfully.");
      } else {
        const payload: CreateStatusPageRequest = {
          name: name.trim(),
          slug: slug.trim().toLowerCase(),
          description: description.trim() || undefined,
          published,
          components: components.map((c) => ({
            monitorId: c.monitorId,
            publicName: c.publicName.trim(),
          })),
        };
        await createStatusPage(session.organization.id, payload);
        setSuccess("Status page created successfully.");
      }

      setIsEditing(false);
      await refresh(session.organization.id);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        if (err.envelope?.code === "STATUS_PAGE_SLUG_CONFLICT") {
          setError(`Slug "${slug}" is already in use. Please choose another unique slug.`);
        } else if (err.envelope?.code === "VERSION_CONFLICT") {
          setError("Version conflict: this status page was modified by another operation. Please refresh and try again.");
        } else {
          setError(err.envelope?.message || err.message);
        }
      } else {
        setError(err instanceof Error ? err.message : "Save failed");
      }
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string, pageName: string) => {
    if (!session) return;
    if (!window.confirm(`Delete "${pageName}"? This will soft delete the status page.`)) return;

    try {
      await deleteStatusPage(session.organization.id, id);
      setSuccess(`Status page "${pageName}" deleted.`);
      await refresh(session.organization.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    }
  };

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">A</span> ARGUS
        </div>
        <nav aria-label="Primary navigation">
          <a className="nav-item" href="/monitors">
            <span>◉</span> Monitors
          </a>
          <a className="nav-item" href="/incidents">
            <span>↗</span> Incidents
          </a>
          <a className="nav-item" href="/settings/notifications">
            <span>⚙</span> Notifications
          </a>
          <a className="nav-item active" href="/status-pages">
            <span>◎</span> Status pages
          </a>
        </nav>
        <div className="sidebar-foot">
          <div className="avatar">{session?.user.email.slice(0, 2).toUpperCase() ?? "AR"}</div>
          <div>
            <strong>{session?.user.email ?? "Loading…"}</strong>
            <small>{session?.organization.role ?? ""}</small>
          </div>
          <a className="logout" href="/api/auth/logout" aria-label="Sign out">
            ↪
          </a>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">{session?.organization.name ?? "Argus"}</p>
            <h1>Status Pages</h1>
          </div>
          {canWrite && !isEditing && (
            <button className="primary-button" onClick={openCreate}>
              + Create Status Page
            </button>
          )}
        </header>

        {error && (
          <div className="error-banner" role="alert">
            <strong>Notice</strong>
            <span>{error}</span>
            <button onClick={() => setError(undefined)} aria-label="Dismiss">
              ×
            </button>
          </div>
        )}

        {success && (
          <div
            className="error-banner"
            style={{ borderColor: "#a3e635", background: "#f7fee7", color: "#365314" }}
            role="status"
          >
            <strong>Success</strong>
            <span>{success}</span>
            <button onClick={() => setSuccess(undefined)} aria-label="Dismiss">
              ×
            </button>
          </div>
        )}

        {/* Editor Form */}
        {isEditing && (
          <form className="monitor-form" onSubmit={handleSave} style={{ marginBottom: "32px" }}>
            <div className="form-heading">
              <div>
                <p className="eyebrow">
                  {editingPageId ? `Editing v${editingVersion}` : "New Public Page"}
                </p>
                <h2>{editingPageId ? `Update ${name}` : "Create Status Page"}</h2>
              </div>
              <button
                type="button"
                className="text-button"
                onClick={() => setIsEditing(false)}
                disabled={saving}
              >
                Cancel
              </button>
            </div>

            <div className="form-grid">
              <label>
                Page Name
                <input
                  required
                  maxLength={120}
                  value={name}
                  placeholder="Argus Service Status"
                  onChange={(e) => setName(e.target.value)}
                />
              </label>

              <label>
                Public Slug (URL path)
                <input
                  required
                  pattern="^[a-z0-9]+(?:-[a-z0-9]+)*$"
                  minLength={3}
                  maxLength={63}
                  value={slug}
                  placeholder="argus-service"
                  onChange={(e) => setSlug(e.target.value.toLowerCase())}
                />
              </label>

              <label className="wide">
                Description (Optional)
                <input
                  value={description}
                  placeholder="Real-time availability and incident updates"
                  onChange={(e) => setDescription(e.target.value)}
                />
              </label>
            </div>

            <div style={{ marginTop: "16px" }}>
              <label style={{ display: "inline-flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  style={{ width: "auto", marginTop: 0 }}
                  checked={published}
                  onChange={(e) => setPublished(e.target.checked)}
                />
                <span style={{ fontSize: "13px", textTransform: "none", fontWeight: 600 }}>
                  Publish status page publicly
                </span>
              </label>
            </div>

            {/* Components list */}
            <fieldset style={{ marginTop: "24px" }}>
              <legend>Status Page Components ({components.length})</legend>
              <p style={{ color: "var(--muted)", fontSize: "12px", marginTop: "4px" }}>
                Each component links to a monitor. Order determines position on public page.
              </p>

              {components.map((comp, idx) => (
                <div
                  key={idx}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1.5fr 2fr auto auto auto",
                    gap: "10px",
                    alignItems: "center",
                    background: "white",
                    padding: "10px 14px",
                    border: "1px solid #ccd5cd",
                    borderRadius: "8px",
                    marginTop: "8px",
                  }}
                >
                  <div>
                    <label style={{ fontSize: "10px" }}>Monitor</label>
                    <select
                      value={comp.monitorId}
                      onChange={(e) => {
                        const next = [...components];
                        next[idx]!.monitorId = e.target.value;
                        setComponents(next);
                      }}
                    >
                      {monitors.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name} ({m.config.kind})
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label style={{ fontSize: "10px" }}>Public Display Name</label>
                    <input
                      required
                      maxLength={80}
                      value={comp.publicName}
                      onChange={(e) => {
                        const next = [...components];
                        next[idx]!.publicName = e.target.value;
                        setComponents(next);
                      }}
                    />
                  </div>

                  <button
                    type="button"
                    title="Move Up"
                    disabled={idx === 0}
                    onClick={() => moveComponent(idx, idx - 1)}
                    style={{ padding: "6px 10px", cursor: idx === 0 ? "not-allowed" : "pointer" }}
                  >
                    ▲
                  </button>

                  <button
                    type="button"
                    title="Move Down"
                    disabled={idx === components.length - 1}
                    onClick={() => moveComponent(idx, idx + 1)}
                    style={{
                      padding: "6px 10px",
                      cursor: idx === components.length - 1 ? "not-allowed" : "pointer",
                    }}
                  >
                    ▼
                  </button>

                  <button
                    type="button"
                    className="danger"
                    title="Remove"
                    onClick={() => removeComponent(idx)}
                    style={{ padding: "6px 10px", color: "var(--danger)" }}
                  >
                    ✕
                  </button>
                </div>
              ))}

              <button
                type="button"
                className="text-button"
                onClick={addComponent}
                style={{ marginTop: "12px", fontSize: "13px", fontWeight: 700 }}
              >
                + Add Component
              </button>
            </fieldset>

            <div style={{ marginTop: "24px", display: "flex", gap: "12px" }}>
              <button className="primary-button" type="submit" disabled={saving}>
                {saving ? "Saving…" : editingPageId ? "Save Changes" : "Create Page"}
              </button>
              <button
                type="button"
                className="text-button"
                onClick={() => setIsEditing(false)}
                disabled={saving}
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        {/* Status Pages List */}
        <section className="monitor-section">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Public Visibility</p>
              <h2>{pages.length} Status Pages</h2>
            </div>
            <span className="timestamp">15-second public cache</span>
          </div>

          {loading ? (
            <div className="skeleton-list">
              <div />
              <div />
              <div />
            </div>
          ) : pages.length === 0 ? (
            <div className="empty-state">
              <span>◎</span>
              <h3>No status pages yet</h3>
              <p>Create a status page to publicly broadcast service uptime and incident status.</p>
            </div>
          ) : (
            <div className="monitor-list">
              {pages.map((page) => (
                <article className="monitor-row" key={page.id}>
                  <div className="state-icon operational" style={{ background: page.published ? "#dcfce7" : "#f1f5f9", color: page.published ? "#15803d" : "#64748b" }}>
                    {page.published ? "✓" : "○"}
                  </div>
                  <div className="monitor-primary">
                    <strong>{page.name}</strong>
                    <code>
                      slug: /status/{page.slug} · {page.componentCount} components · v{page.version}
                    </code>
                  </div>
                  <span
                    className="status-badge"
                    style={{
                      background: page.published ? "#dcfce7" : "#f1f5f9",
                      color: page.published ? "#15803d" : "#64748b",
                    }}
                  >
                    {page.published ? "PUBLISHED" : "DRAFT"}
                  </span>
                  <div className="row-actions">
                    <a
                      href={`/status/${page.slug}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-button"
                      style={{ textDecoration: "none", fontSize: "12px" }}
                    >
                      View ↗
                    </a>
                    {canWrite && (
                      <>
                        <button onClick={() => openEdit(page)}>Edit</button>
                        <button className="danger" onClick={() => handleDelete(page.id, page.name)}>
                          Delete
                        </button>
                      </>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </section>
    </main>
  );
}
