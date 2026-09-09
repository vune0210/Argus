import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import type {
  EscalationPolicy,
  EscalationStep,
  NotificationChannel,
} from "@argus/contracts";
import { DATABASE_POOL } from "../database/database.module";
import { OrganizationsService } from "../organizations/organizations.service";
import { DOMAIN_STREAM, RedisStreams } from "../pipeline/redis-streams";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

@Injectable()
export class NotificationsService {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(OrganizationsService) private readonly organizations: OrganizationsService,
    @Inject(RedisStreams) protected readonly streams: RedisStreams,
  ) {}

  private mapChannel(row: {
    id: string;
    organization_id: string;
    type: "SLACK" | "EMAIL";
    name: string;
    config: any;
    enabled: boolean;
    created_at: Date;
    updated_at: Date;
  }): NotificationChannel {
    const config: { secretArn?: string; recipient?: string } = {};
    if (row.type === "SLACK" && row.config?.secretArn) {
      config.secretArn = row.config.secretArn;
    }
    if (row.type === "EMAIL") {
      config.recipient = row.config?.recipient || row.config?.email;
    }
    return {
      id: row.id,
      organizationId: row.organization_id,
      type: row.type,
      name: row.name,
      config,
      enabled: row.enabled,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  async listChannels(organizationId: string, userId: string): Promise<{ items: NotificationChannel[] }> {
    await this.organizations.membership(organizationId, userId);
    const result = await this.pool.query(
      `SELECT * FROM notification_channels WHERE organization_id = $1 ORDER BY created_at ASC`,
      [organizationId],
    );
    return { items: result.rows.map((r) => this.mapChannel(r)) };
  }

  async getChannel(organizationId: string, userId: string, id: string): Promise<NotificationChannel> {
    await this.organizations.membership(organizationId, userId);
    const result = await this.pool.query(
      `SELECT * FROM notification_channels WHERE id = $1 AND organization_id = $2`,
      [id, organizationId],
    );
    if (!result.rowCount) {
      throw new NotFoundException({ code: "CHANNEL_NOT_FOUND", message: "Notification channel not found" });
    }
    return this.mapChannel(result.rows[0]!);
  }

  async createChannel(
    organizationId: string,
    userId: string,
    body: any,
  ): Promise<NotificationChannel> {
    await this.organizations.requireMonitorWrite(organizationId, userId);

    const type = body.type || body.kind;
    const name = body.name;
    const enabled = body.enabled ?? true;
    const secretArn = body.secretArn || body.config?.secretArn;
    const email = body.email || body.recipient || body.config?.recipient || body.config?.email;

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      throw new BadRequestException({ code: "INVALID_PAYLOAD", message: "Channel name is required" });
    }

    if (type !== "SLACK" && type !== "EMAIL") {
      throw new BadRequestException({ code: "INVALID_PAYLOAD", message: "Channel type must be SLACK or EMAIL" });
    }

    // Check for invalid extra fields
    const allowedKeys = new Set(["name", "type", "kind", "enabled", "secretArn", "email", "recipient", "config"]);
    for (const key of Object.keys(body)) {
      if (!allowedKeys.has(key)) {
        throw new BadRequestException({ code: "INVALID_PAYLOAD", message: `Unexpected property ${key}` });
      }
    }

    const config: Record<string, string> = {};
    if (type === "SLACK") {
      if (!secretArn || typeof secretArn !== "string" || !secretArn.startsWith("arn:aws:secretsmanager:")) {
        throw new BadRequestException({
          code: "INVALID_PAYLOAD",
          message: "Slack channel requires a valid AWS Secrets Manager ARN (arn:aws:secretsmanager:...)",
        });
      }
      if (email) {
        throw new BadRequestException({
          code: "INVALID_PAYLOAD",
          message: "Slack channel must not contain email or recipient",
        });
      }
      config.secretArn = secretArn.trim();
    } else {
      if (!email || typeof email !== "string" || !EMAIL_REGEX.test(email.trim())) {
        throw new BadRequestException({
          code: "INVALID_PAYLOAD",
          message: "Email channel requires a valid email address",
        });
      }
      if (secretArn) {
        throw new BadRequestException({
          code: "INVALID_PAYLOAD",
          message: "Email channel must not contain secretArn",
        });
      }
      config.recipient = email.trim();
      config.email = email.trim();
    }

    const result = await this.pool.query(
      `INSERT INTO notification_channels(organization_id, type, name, config, enabled)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [organizationId, type, name.trim(), config, enabled],
    );

    return this.mapChannel(result.rows[0]!);
  }

  async updateChannel(
    organizationId: string,
    userId: string,
    id: string,
    body: any,
  ): Promise<NotificationChannel> {
    await this.organizations.requireMonitorWrite(organizationId, userId);

    const existing = await this.pool.query(
      `SELECT * FROM notification_channels WHERE id = $1 AND organization_id = $2`,
      [id, organizationId],
    );
    if (!existing.rowCount) {
      throw new NotFoundException({ code: "CHANNEL_NOT_FOUND", message: "Notification channel not found" });
    }

    const current = existing.rows[0]!;
    const name = body.name !== undefined ? body.name : current.name;
    const enabled = body.enabled !== undefined ? body.enabled : current.enabled;
    const config = { ...current.config };

    if (current.type === "SLACK") {
      const secretArn = body.secretArn || body.config?.secretArn;
      if (secretArn !== undefined) {
        if (typeof secretArn !== "string" || !secretArn.startsWith("arn:aws:secretsmanager:")) {
          throw new BadRequestException({ code: "INVALID_PAYLOAD", message: "Invalid secretArn" });
        }
        config.secretArn = secretArn.trim();
      }
    } else {
      const email = body.email || body.recipient || body.config?.recipient || body.config?.email;
      if (email !== undefined) {
        if (typeof email !== "string" || !EMAIL_REGEX.test(email.trim())) {
          throw new BadRequestException({ code: "INVALID_PAYLOAD", message: "Invalid email" });
        }
        config.recipient = email.trim();
        config.email = email.trim();
      }
    }

    const result = await this.pool.query(
      `UPDATE notification_channels
       SET name = $3, config = $4, enabled = $5, updated_at = now()
       WHERE id = $1 AND organization_id = $2
       RETURNING *`,
      [id, organizationId, name, config, enabled],
    );

    return this.mapChannel(result.rows[0]!);
  }

  async deleteChannel(organizationId: string, userId: string, id: string): Promise<void> {
    await this.organizations.requireMonitorWrite(organizationId, userId);

    const existing = await this.pool.query(
      `SELECT id FROM notification_channels WHERE id = $1 AND organization_id = $2`,
      [id, organizationId],
    );
    if (!existing.rowCount) {
      throw new NotFoundException({ code: "CHANNEL_NOT_FOUND", message: "Notification channel not found" });
    }

    // Check if channel is used in escalation steps (either primary column or join table)
    const inUse = await this.pool.query(
      `SELECT 1 FROM escalation_policy_steps WHERE channel_id = $1 AND organization_id = $2
       UNION
       SELECT 1 FROM escalation_step_channels sc
       JOIN escalation_policy_steps s ON s.id = sc.step_id
       WHERE sc.channel_id = $1 AND s.organization_id = $2
       LIMIT 1`,
      [id, organizationId],
    );
    if (inUse.rowCount) {
      throw new ConflictException({
        code: "CHANNEL_IN_USE",
        message: "Cannot delete channel because it is in use by an active escalation policy step",
      });
    }

    await this.pool.query(
      `DELETE FROM notification_channels WHERE id = $1 AND organization_id = $2`,
      [id, organizationId],
    );
  }

  async getEscalationPolicy(organizationId: string, userId: string): Promise<EscalationPolicy> {
    await this.organizations.membership(organizationId, userId);

    const policyRes = await this.pool.query(
      `SELECT * FROM escalation_policies WHERE organization_id = $1`,
      [organizationId],
    );

    let policy = policyRes.rows[0];
    if (!policy) {
      // Ensure default policy row exists
      const created = await this.pool.query(
        `INSERT INTO escalation_policies(organization_id, name) VALUES($1, 'Default Policy')
         ON CONFLICT (organization_id) DO UPDATE SET updated_at = now()
         RETURNING *`,
        [organizationId],
      );
      policy = created.rows[0]!;
    }

    const stepsRes = await this.pool.query(
      `SELECT s.id, s.step_order, s.delay_seconds, s.channel_id,
              COALESCE(
                array_agg(sc.channel_id) FILTER (WHERE sc.channel_id IS NOT NULL),
                ARRAY[]::uuid[]
              ) AS step_channel_ids
       FROM escalation_policy_steps s
       LEFT JOIN escalation_step_channels sc ON sc.step_id = s.id
       WHERE s.policy_id = $1 AND s.organization_id = $2
       GROUP BY s.id, s.step_order, s.delay_seconds, s.channel_id
       ORDER BY s.step_order ASC`,
      [policy.id, organizationId],
    );

    return {
      id: policy.id,
      organizationId: policy.organization_id,
      name: policy.name,
      steps: stepsRes.rows.map((s) => {
        const rawList: string[] = Array.isArray(s.step_channel_ids) ? s.step_channel_ids : [];
        const channelIds = rawList.length > 0 ? rawList : s.channel_id ? [s.channel_id] : [];
        return {
          id: s.id,
          stepOrder: s.step_order,
          delaySeconds: s.delay_seconds,
          channelIds,
          channelId: channelIds[0] || s.channel_id,
        };
      }),
    };
  }

  async updateEscalationPolicy(
    organizationId: string,
    userId: string,
    body: any,
  ): Promise<EscalationPolicy> {
    await this.organizations.requireMonitorWrite(organizationId, userId);

    const stepsInput = body.steps;
    if (!Array.isArray(stepsInput) || stepsInput.length !== 3) {
      throw new BadRequestException({
        code: "INVALID_POLICY",
        message: "Escalation policy must have exactly 3 steps (PRIMARY, SECONDARY, TEAM)",
      });
    }

    const stepOrderNames = ["PRIMARY", "SECONDARY", "TEAM"];
    const normalizedSteps: Array<{
      stepOrder: number;
      name: string;
      delaySeconds: number;
      channelIds: string[];
    }> = [];

    // All channels across all steps to validate
    const allChannelIds = new Set<string>();

    for (let i = 0; i < 3; i++) {
      const step = stepsInput[i];
      const stepOrder = typeof step.stepOrder === "number" ? step.stepOrder : i;
      const stepName = step.name || stepOrderNames[stepOrder] || `STEP_${stepOrder}`;
      const delaySeconds =
        typeof step.delaySeconds === "number" ? step.delaySeconds : i === 0 ? 0 : i === 1 ? 300 : 600;

      // Accept channelIds: uuid[] or legacy channelId: uuid
      let channelIds: string[] = [];
      if (Array.isArray(step.channelIds)) {
        channelIds = step.channelIds.map((id: unknown) => String(id).trim());
      } else if (typeof step.channelId === "string" && step.channelId.trim().length > 0) {
        channelIds = [step.channelId.trim()];
      }

      if (channelIds.length === 0) {
        throw new BadRequestException({
          code: "INVALID_STEP",
          message: `Step ${i} requires at least one channel`,
        });
      }

      // Check for duplicate channels within the same step
      if (new Set(channelIds).size !== channelIds.length) {
        throw new BadRequestException({
          code: "INVALID_STEP",
          message: `Step ${i} contains duplicate channels`,
        });
      }

      for (const chId of channelIds) {
        allChannelIds.add(chId);
      }

      normalizedSteps.push({ stepOrder, name: stepName, delaySeconds, channelIds });
    }

    // Validate that all channels exist in this tenant and are enabled
    const channelsRes = await this.pool.query(
      `SELECT id, type, enabled FROM notification_channels WHERE organization_id = $1 AND id = ANY($2::uuid[])`,
      [organizationId, Array.from(allChannelIds)],
    );

    const channelMap = new Map<string, { type: "SLACK" | "EMAIL"; enabled: boolean }>();
    for (const r of channelsRes.rows) {
      channelMap.set(r.id, { type: r.type, enabled: r.enabled });
    }

    for (const chId of allChannelIds) {
      const found = channelMap.get(chId);
      if (!found) {
        throw new BadRequestException({
          code: "CHANNEL_NOT_FOUND",
          message: `Channel ${chId} not found in this organization`,
        });
      }
      if (!found.enabled) {
        throw new BadRequestException({
          code: "CHANNEL_DISABLED",
          message: `Channel ${chId} is disabled and cannot be added to an escalation policy`,
        });
      }
    }

    // Step 0 (Primary) must have at least one enabled Slack AND at least one enabled Email
    const primaryStep = normalizedSteps[0]!;
    const primaryTypes = new Set(primaryStep.channelIds.map((id) => channelMap.get(id)?.type));
    if (!primaryTypes.has("SLACK") || !primaryTypes.has("EMAIL")) {
      throw new BadRequestException({
        code: "INVALID_POLICY",
        message: "Primary escalation step must contain at least one enabled Slack channel and at least one enabled Email channel",
      });
    }

    // Secondary and Team must each have at least one channel (already verified length >= 1 and enabled)

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const name = body.name || "Default Policy";
      const policyRes = await client.query(
        `INSERT INTO escalation_policies(organization_id, name)
         VALUES ($1, $2)
         ON CONFLICT (organization_id) DO UPDATE SET name = EXCLUDED.name, updated_at = now()
         RETURNING id, organization_id, name`,
        [organizationId, name],
      );
      const policy = policyRes.rows[0]!;

      // Replace steps for this policy (cascades to escalation_step_channels)
      await client.query(
        `DELETE FROM escalation_policy_steps WHERE policy_id = $1 AND organization_id = $2`,
        [policy.id, organizationId],
      );

      const savedSteps: EscalationStep[] = [];
      for (const step of normalizedSteps) {
        // Keep step.channelIds[0] in channel_id column for legacy rollback/compat
        const stepRes = await client.query(
          `INSERT INTO escalation_policy_steps(organization_id, policy_id, step_order, name, delay_seconds, channel_id)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, step_order, delay_seconds, channel_id`,
          [organizationId, policy.id, step.stepOrder, step.name, step.delaySeconds, step.channelIds[0]],
        );
        const s = stepRes.rows[0]!;

        for (const chId of step.channelIds) {
          await client.query(
            `INSERT INTO escalation_step_channels(step_id, channel_id)
             VALUES ($1, $2)
             ON CONFLICT (step_id, channel_id) DO NOTHING`,
            [s.id, chId],
          );
        }

        savedSteps.push({
          id: s.id,
          stepOrder: s.step_order,
          delaySeconds: s.delay_seconds,
          channelIds: step.channelIds,
          channelId: step.channelIds[0],
        });
      }

      await client.query("COMMIT");
      return {
        id: policy.id,
        organizationId: policy.organization_id,
        name: policy.name,
        steps: savedSteps,
      };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async createIncidentDeliveries(
    client: PoolClient,
    organizationId: string,
    incidentId: string,
    now: Date,
  ): Promise<number> {
    const stepsRes = await client.query(
      `SELECT s.id AS step_id, s.step_order, s.delay_seconds,
              COALESCE(sc.channel_id, s.channel_id) AS channel_id,
              c.enabled
       FROM escalation_policies p
       JOIN escalation_policy_steps s ON s.policy_id = p.id AND s.organization_id = p.organization_id
       LEFT JOIN escalation_step_channels sc ON sc.step_id = s.id
       JOIN notification_channels c ON c.id = COALESCE(sc.channel_id, s.channel_id) AND c.organization_id = s.organization_id
       WHERE p.organization_id = $1 AND c.enabled = true
       ORDER BY s.step_order ASC, c.created_at ASC`,
      [organizationId],
    );

    if (!stepsRes.rowCount) {
      return 0;
    }

    let createdCount = 0;
    for (const step of stepsRes.rows) {
      const scheduledAt = new Date(now.getTime() + step.delay_seconds * 1000);
      const deliveryRes = await client.query(
        `INSERT INTO notification_deliveries(
           organization_id, incident_id, escalation_step_id, channel_id, event_kind, status, attempts, scheduled_at, next_attempt_at
         ) VALUES ($1, $2, $3, $4, 'INCIDENT_OPENED', 'PENDING', 0, $5, $5)
         ON CONFLICT (incident_id, escalation_step_id, channel_id) WHERE event_kind = 'INCIDENT_OPENED' DO NOTHING
         RETURNING id`,
        [organizationId, incidentId, step.step_id, step.channel_id, scheduledAt],
      );

      if (deliveryRes.rows[0]) {
        createdCount++;
        const deliveryId = deliveryRes.rows[0].id;
        const eventId = randomUUID();
        const envelope = {
          id: eventId,
          type: "notification.queued",
          version: 1,
          occurredAt: now.toISOString(),
          organizationId,
          correlationId: incidentId,
          payload: {
            deliveryId,
            incidentId,
            channelId: step.channel_id,
            scheduledAt: scheduledAt.toISOString(),
            eventKind: "INCIDENT_OPENED",
          },
        };
        await client.query(
          `INSERT INTO domain_events(id, organization_id, envelope) VALUES($1, $2, $3)`,
          [eventId, organizationId, envelope],
        );
        await client.query(
          `INSERT INTO outbox_events(organization_id, dedup_key, stream, payload) VALUES($1, $2, $3, $4)`,
          [organizationId, `delivery:${deliveryId}:queued`, DOMAIN_STREAM, envelope],
        );
      }
    }

    return createdCount;
  }

  async createRecoveryDeliveries(
    client: PoolClient,
    organizationId: string,
    incidentId: string,
    now: Date,
  ): Promise<number> {
    const primaryChannelsRes = await client.query(
      `SELECT s.id AS step_id,
              COALESCE(sc.channel_id, s.channel_id) AS channel_id,
              c.enabled
       FROM escalation_policies p
       JOIN escalation_policy_steps s ON s.policy_id = p.id AND s.organization_id = p.organization_id
       LEFT JOIN escalation_step_channels sc ON sc.step_id = s.id
       JOIN notification_channels c ON c.id = COALESCE(sc.channel_id, s.channel_id) AND c.organization_id = s.organization_id
       WHERE p.organization_id = $1 AND s.step_order = 0 AND c.enabled = true
       ORDER BY c.created_at ASC`,
      [organizationId],
    );

    if (!primaryChannelsRes.rowCount) {
      return 0;
    }

    let createdCount = 0;
    for (const row of primaryChannelsRes.rows) {
      const deliveryRes = await client.query(
        `INSERT INTO notification_deliveries(
           organization_id, incident_id, escalation_step_id, channel_id, event_kind, status, attempts, scheduled_at, next_attempt_at
         ) VALUES ($1, $2, $3, $4, 'INCIDENT_RESOLVED', 'PENDING', 0, $5, $5)
         ON CONFLICT (incident_id, channel_id) WHERE event_kind = 'INCIDENT_RESOLVED' DO NOTHING
         RETURNING id`,
        [organizationId, incidentId, row.step_id, row.channel_id, now],
      );

      if (deliveryRes.rows[0]) {
        createdCount++;
        const deliveryId = deliveryRes.rows[0].id;
        const eventId = randomUUID();
        const envelope = {
          id: eventId,
          type: "notification.queued",
          version: 1,
          occurredAt: now.toISOString(),
          organizationId,
          correlationId: incidentId,
          payload: {
            deliveryId,
            incidentId,
            channelId: row.channel_id,
            scheduledAt: now.toISOString(),
            eventKind: "INCIDENT_RESOLVED",
          },
        };
        await client.query(
          `INSERT INTO domain_events(id, organization_id, envelope) VALUES($1, $2, $3)`,
          [eventId, organizationId, envelope],
        );
        await client.query(
          `INSERT INTO outbox_events(organization_id, dedup_key, stream, payload) VALUES($1, $2, $3, $4)`,
          [organizationId, `delivery:${deliveryId}:queued`, DOMAIN_STREAM, envelope],
        );
      }
    }

    return createdCount;
  }
}
