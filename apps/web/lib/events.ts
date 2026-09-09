import type { EventEnvelope } from "@argus/contracts";

/** Fetch-based SSE supports the tenant header and Last-Event-ID on reconnect. */
export type StreamState = "connecting" | "connected" | "reconnecting" | "unauthorized";
export function subscribeEvents(organizationId: string, onEvent: (event: EventEnvelope) => void, onState?: (state: StreamState) => void): () => void {
  const controller = new AbortController();
  let lastId = "";
  const wait = (ms: number) => new Promise<void>((resolve) => {
    const finish = () => { clearTimeout(timer); controller.signal.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, ms);
    controller.signal.addEventListener("abort", finish, { once: true });
  });
  void (async () => {
    let attempt = 0;
    onState?.("connecting");
    while (!controller.signal.aborted) {
      try {
        const response = await fetch(`/api/backend/api/v1/organizations/${organizationId}/events`, {
          headers: { "x-argus-organization-id": organizationId, ...(lastId ? { "Last-Event-ID": lastId } : {}) },
          signal: controller.signal, cache: "no-store",
        });
        if (controller.signal.aborted) return;
        if (response.status === 401 || response.status === 403 || response.status === 404) { onState?.("unauthorized"); return; }
        if (!response.ok || !response.body) throw new Error("Event stream unavailable");
        onState?.("connected");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          while (!controller.signal.aborted) {
            const { done, value } = await reader.read();
            if (controller.signal.aborted) return;
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            if (buffer.length > 1_048_576) throw new Error("Event frame too large");
            let boundary: RegExpExecArray | null;
            while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
              const frame = buffer.slice(0, boundary.index); buffer = buffer.slice(boundary.index + boundary[0].length);
              const lines = frame.split(/\r?\n/);
              const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
              if (!data) continue;
              const event = JSON.parse(data) as EventEnvelope;
              if (event.organizationId !== organizationId) continue;
              onEvent(event);
              const id = lines.find((line) => line.startsWith("id:"))?.slice(3).trim();
              if (id) lastId = id;
              if (event.type === "system.resync_required") lastId = "";
              attempt = 0;
            }
          }
        } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      } catch { if (controller.signal.aborted) return; }
      if (controller.signal.aborted) return;
      onState?.("reconnecting");
      await wait(Math.min(30_000, 500 * 2 ** Math.min(attempt++, 6)) + Math.random() * 250);
    }
  })();
  return () => controller.abort();
}
