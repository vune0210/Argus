import { afterEach, describe, expect, it, vi } from "vitest";
import { subscribeEvents } from "./events";
import fixtures from "../../../packages/contracts/examples/week3-three-region.json";

afterEach(() => vi.unstubAllGlobals());
describe("SSE tenant replay and connection state", () => {
  it("parses chunk-split CRLF, ignores another tenant and reconnects with the accepted event ID", async () => {
    const own = fixtures.events[0]!;
    const foreign = { ...own, id: "foreign", organizationId: fixtures.organizations[1]!.id };
    const encoder = new TextEncoder();
    const source = new ReadableStream({ start(controller) {
      for (const event of [foreign, own]) {
        const frame = `id: ${event.id}\r\nevent: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`;
        // Every byte boundary includes the dangerous CR|LF split.
        for (const char of frame) controller.enqueue(encoder.encode(char));
      }
      controller.close();
    } });
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(source, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 403 }));
    vi.stubGlobal("fetch", fetcher);
    const events = vi.fn(); const state = vi.fn();
    const stop = subscribeEvents(own.organizationId, events, state);
    try {
      await vi.waitFor(() => expect(state).toHaveBeenCalledWith("unauthorized"), { timeout: 2000 });
      expect(events).toHaveBeenCalledExactlyOnceWith(own);
      expect(fetcher.mock.calls[1]![1].headers["Last-Event-ID"]).toBe(own.id);
      expect(state.mock.calls.map((call) => call[0])).toEqual(["connecting", "connected", "reconnecting", "unauthorized"]);
    } finally { stop(); }
  });
  it("aborts a pending connection without publishing into a disposed tenant", async () => {
    let finish!: (value: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
    const events = vi.fn(); const state = vi.fn();
    const stop = subscribeEvents(fixtures.organizations[0]!.id, events, state);
    stop(); finish(new Response(null, { status: 403 }));
    await Promise.resolve(); await Promise.resolve();
    expect(events).not.toHaveBeenCalled();
    expect(state.mock.calls.map((call) => call[0])).toEqual(["connecting"]);
  });
});
