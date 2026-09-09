import { Injectable, OnApplicationShutdown } from "@nestjs/common";
import { createClient } from "redis";

export const GROUP = "argus-probes-v1";
export const jobStream = (region: string) => `argus:v1:probe-jobs:${region}`;
export const DOMAIN_STREAM = "argus:v1:domain-events";
export interface StreamEntry { id: string; payload: string }

@Injectable()
export class RedisStreams implements OnApplicationShutdown {
  private readonly client = createClient({ url: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
    disableOfflineQueue: true, socket: { connectTimeout: 2000, reconnectStrategy: (retries: number) => Math.min(100 * (retries + 1), 2000) } });
  private readonly reclaimCursors = new Map<string, string>();
  private connecting?: Promise<unknown>;
  constructor() { this.client.on("error", () => { /* Report availability via worker metrics; never log connection credentials. */ }); }
  async command(args: string[]): Promise<unknown> {
    if (!this.client.isOpen) this.connecting ??= this.client.connect().finally(() => { this.connecting = undefined; });
    // Don't let Redis outage prevent the independent scheduler/finalizer loops.
    if (this.connecting) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([this.connecting, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Redis unavailable")), 2200); })]); }
      finally { clearTimeout(timer); }
    }
    return this.client.sendCommand(args);
  }
  async ensureGroup(stream: string): Promise<void> {
    try { await this.command(["XGROUP", "CREATE", stream, GROUP, "0", "MKSTREAM"]); }
    catch (error) { if (!(error instanceof Error) || !error.message.includes("BUSYGROUP")) throw error; }
  }
  async publish(stream: string, payload: unknown): Promise<string> {
    return await this.command(["XADD", stream, "*", "payload", JSON.stringify(payload)]) as string;
  }
  async take(region: string, consumer: string): Promise<StreamEntry | null> {
    const stream = jobStream(region);
    await this.ensureGroup(stream);
    const claimed = await this.command(["XAUTOCLAIM", stream, GROUP, consumer, "45000", this.reclaimCursors.get(region) ?? "0-0", "COUNT", "1"]) as [string, [string, string[]][]];
    this.reclaimCursors.set(region, claimed[0]);
    let entry: [string, string[]] | undefined = claimed[1]?.[0];
    if (!entry) {
      const read = await this.command(["XREADGROUP", "GROUP", GROUP, consumer, "COUNT", "1", "STREAMS", stream, ">"]) as [string, [string, string[]][]][] | null;
      entry = read?.[0]?.[1]?.[0];
    }
    if (!entry) return null;
    const index = entry[1].indexOf("payload");
    return { id: entry[0], payload: index >= 0 ? entry[1][index + 1]! : "" };
  }
  async ack(region: string, id: string): Promise<void> { await this.command(["XACK", jobStream(region), GROUP, id]); }
  async onApplicationShutdown(): Promise<void> { if (this.client.isOpen) this.client.destroy(); }
}
