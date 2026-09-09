import { Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { calculateNextAttemptDelay } from "@argus/domain";
import { DATABASE_POOL } from "../database/database.module";
import { DOMAIN_STREAM, RedisStreams } from "../pipeline/redis-streams";
import {
  createNotificationProvider,
  type NotificationProvider,
  type SendNotificationParams,
} from "./notifications.provider";

interface ClaimedDeliveryRow {
  id: string;
  organization_id: string;
  incident_id: string;
  escalation_step_id: string;
  channel_id: string;
  event_kind: "INCIDENT_OPENED" | "INCIDENT_RESOLVED";
  status: string;
  attempts: number;
  channel_type: "SLACK" | "EMAIL";
  channel_config: any;
  channel_enabled: boolean;
  monitor_name: string;
  monitor_regions: string[];
  incident_status: string;
  incident_opened_at: Date;
}

@Injectable()
export class NotificationsWorker {
  private provider: NotificationProvider;

  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(RedisStreams) protected readonly streams: RedisStreams,
  ) {
    this.provider = createNotificationProvider();
  }

  // Exposed for testing
  setProvider(provider: NotificationProvider) {
    this.provider = provider;
  }

  async process(): Promise<number> {
    const client = await this.pool.connect();
    let claimed: ClaimedDeliveryRow | null = null;
    try {
      await client.query("BEGIN");
      const res = await client.query<ClaimedDeliveryRow>(
        `SELECT d.id, d.organization_id, d.incident_id, d.escalation_step_id, d.channel_id,
                d.event_kind, d.status, d.attempts, c.type AS channel_type, c.config AS channel_config,
                c.enabled AS channel_enabled, m.name AS monitor_name, m.regions AS monitor_regions,
                i.status AS incident_status, i.opened_at AS incident_opened_at
         FROM notification_deliveries d
         JOIN notification_channels c ON c.id = d.channel_id AND c.organization_id = d.organization_id
         JOIN incidents i ON i.id = d.incident_id AND i.organization_id = d.organization_id
         JOIN monitors m ON m.id = i.monitor_id AND m.organization_id = i.organization_id
         WHERE d.status = 'PENDING' AND d.next_attempt_at <= clock_timestamp()
         ORDER BY d.next_attempt_at ASC, d.scheduled_at ASC
         LIMIT 1
         FOR UPDATE OF d SKIP LOCKED`,
      );

      if (!res.rowCount) {
        await client.query("COMMIT");
        return 0;
      }

      claimed = res.rows[0]!;
      await client.query(
        `UPDATE notification_deliveries
         SET status = 'SENDING', attempts = attempts + 1,
             locked_until = clock_timestamp() + interval '30 seconds',
             last_attempted_at = clock_timestamp()
         WHERE id = $1`,
        [claimed.id],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    if (!claimed) return 0;

    // Post-commit: check if incident is still OPEN for INCIDENT_OPENED
    const currentIncident = await this.pool.query(
      `SELECT status FROM incidents WHERE id = $1`,
      [claimed.incident_id],
    );
    const incidentStatus = currentIncident.rows[0]?.status;
    const eventKind = claimed.event_kind || "INCIDENT_OPENED";

    if (eventKind === "INCIDENT_OPENED" && incidentStatus !== "OPEN") {
      // Incident acknowledged or resolved: cancel alert delivery
      await this.pool.query(
        `UPDATE notification_deliveries
         SET status = 'CANCELED', locked_until = NULL
         WHERE id = $1`,
        [claimed.id],
      );
      await this.emitEvent(claimed.organization_id, "notification.canceled", claimed.incident_id, {
        deliveryId: claimed.id,
        incidentId: claimed.incident_id,
        reason: `incident_${String(incidentStatus).toLowerCase()}`,
        eventKind,
      });
      return 1;
    }

    if (!claimed.channel_enabled) {
      await this.pool.query(
        `UPDATE notification_deliveries
         SET status = 'CANCELED', locked_until = NULL, last_error = 'CHANNEL_DISABLED'
         WHERE id = $1`,
        [claimed.id],
      );
      await this.emitEvent(claimed.organization_id, "notification.canceled", claimed.incident_id, {
        deliveryId: claimed.id,
        incidentId: claimed.incident_id,
        reason: "channel_disabled",
        eventKind,
      });
      return 1;
    }

    // Call provider outside database transaction
    const params: SendNotificationParams = {
      deliveryId: claimed.id,
      incidentId: claimed.incident_id,
      channelId: claimed.channel_id,
      eventKind,
      type: claimed.channel_type,
      config: claimed.channel_config,
      payload: {
        monitorName: claimed.monitor_name,
        incidentStatus: eventKind === "INCIDENT_RESOLVED" ? "RESOLVED" : claimed.incident_status,
        openedAt: claimed.incident_opened_at.toISOString(),
        regionsSummary: (claimed.monitor_regions || []).join(", "),
        dashboardUrl: `/incidents/${claimed.incident_id}`,
        eventKind,
      },
    };

    const result = await this.provider.send(params);

    if (result.success) {
      await this.pool.query(
        `UPDATE notification_deliveries
         SET status = 'SENT', sent_at = clock_timestamp(), locked_until = NULL,
             provider_response = $2, last_error = NULL
         WHERE id = $1`,
        [claimed.id, JSON.stringify(result.response || {})],
      );
      await this.emitEvent(claimed.organization_id, "notification.sent", claimed.incident_id, {
        deliveryId: claimed.id,
        incidentId: claimed.incident_id,
        channelId: claimed.channel_id,
        eventKind: claimed.event_kind,
      });
      return 1;
    }

    // Failure path
    const attempt = claimed.attempts + 1;
    const safeError = result.error || "PROVIDER_5XX";
    const nextDelay = calculateNextAttemptDelay(attempt, result.retryAfterSeconds);

    if (attempt >= 5 || nextDelay === null) {
      await this.pool.query(
        `UPDATE notification_deliveries
         SET status = 'FAILED', locked_until = NULL, last_error = $2
         WHERE id = $1`,
        [claimed.id, safeError],
      );
      await this.emitEvent(claimed.organization_id, "notification.failed", claimed.incident_id, {
        deliveryId: claimed.id,
        incidentId: claimed.incident_id,
        channelId: claimed.channel_id,
        attempts: attempt,
        error: safeError,
        terminal: true,
        eventKind: claimed.event_kind,
      });
    } else {
      await this.pool.query(
        `UPDATE notification_deliveries
         SET status = 'PENDING', next_attempt_at = clock_timestamp() + ($2 || ' seconds')::interval,
             locked_until = NULL, last_error = $3
         WHERE id = $1`,
        [claimed.id, nextDelay, safeError],
      );
      await this.emitEvent(claimed.organization_id, "notification.failed", claimed.incident_id, {
        deliveryId: claimed.id,
        incidentId: claimed.incident_id,
        channelId: claimed.channel_id,
        attempts: attempt,
        error: safeError,
        nextAttemptInSeconds: nextDelay,
        terminal: false,
        eventKind: claimed.event_kind,
      });
    }

    return 1;
  }

  async recover(): Promise<number> {
    const res = await this.pool.query(
      `UPDATE notification_deliveries
       SET status = 'PENDING', locked_until = NULL
       WHERE status = 'SENDING' AND locked_until < clock_timestamp()
       RETURNING id`,
    );
    return res.rowCount || 0;
  }

  private async emitEvent(
    organizationId: string,
    type: string,
    incidentId: string,
    payload: unknown,
  ): Promise<void> {
    const eventId = randomUUID();
    const envelope = {
      id: eventId,
      type,
      version: 1,
      occurredAt: new Date().toISOString(),
      organizationId,
      correlationId: incidentId,
      payload,
    };
    await this.pool.query(
      `INSERT INTO domain_events(id, organization_id, envelope) VALUES($1, $2, $3)`,
      [eventId, organizationId, envelope],
    );
    await this.pool.query(
      `INSERT INTO outbox_events(organization_id, dedup_key, stream, payload) VALUES($1, $2, $3, $4)`,
      [organizationId, `event:${eventId}`, DOMAIN_STREAM, envelope],
    );
  }
}
