import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

export interface SendNotificationParams {
  deliveryId: string;
  incidentId: string;
  channelId: string;
  eventKind?: "INCIDENT_OPENED" | "INCIDENT_RESOLVED";
  type: "SLACK" | "EMAIL";
  config: {
    secretArn?: string;
    recipient?: string;
    email?: string;
  };
  payload: {
    monitorName: string;
    incidentStatus: string;
    openedAt: string;
    regionsSummary: string;
    dashboardUrl: string;
    eventKind?: "INCIDENT_OPENED" | "INCIDENT_RESOLVED";
  };
}

export interface SendNotificationResult {
  success: boolean;
  error?: "RATE_LIMITED" | "PROVIDER_5XX" | "TIMEOUT" | "CONFIGURATION_ERROR";
  retryAfterSeconds?: number;
  response?: Record<string, unknown>;
}

export interface NotificationProvider {
  send(params: SendNotificationParams): Promise<SendNotificationResult>;
}

export class MockNotificationProvider implements NotificationProvider {
  constructor(private readonly sinkUrl: string = process.env.MOCK_NOTIFICATION_SINK_URL || "http://127.0.0.1:4002") {}

  async send(params: SendNotificationParams): Promise<SendNotificationResult> {
    const endpoint = params.type === "SLACK" ? "/slack" : "/email";
    const url = `${this.sinkUrl.replace(/\/+$/, "")}${endpoint}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deliveryId: params.deliveryId,
          channelId: params.channelId,
          incidentId: params.incidentId,
          eventKind: params.eventKind ?? "INCIDENT_OPENED",
          payload: params.payload,
        }),
        signal: controller.signal,
      });

      if (res.status === 429) {
        const retryHeader = res.headers.get("Retry-After");
        const retryAfter = retryHeader ? Number.parseInt(retryHeader, 10) : undefined;
        return {
          success: false,
          error: "RATE_LIMITED",
          retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : undefined,
        };
      }

      if (res.status >= 500) {
        return {
          success: false,
          error: "PROVIDER_5XX",
        };
      }

      if (!res.ok) {
        return {
          success: false,
          error: "CONFIGURATION_ERROR",
        };
      }

      const data = await res.json().catch(() => ({}));
      return {
        success: true,
        response: data,
      };
    } catch (err: any) {
      if (err.name === "AbortError") {
        return { success: false, error: "TIMEOUT" };
      }
      return { success: false, error: "PROVIDER_5XX" };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class AwsNotificationProvider implements NotificationProvider {
  private secretsClient: SecretsManagerClient;
  private sesClient: SESv2Client;
  private fromEmail: string;

  constructor() {
    const region = process.env.AWS_REGION || "us-east-1";
    this.secretsClient = new SecretsManagerClient({ region });
    this.sesClient = new SESv2Client({ region });
    this.fromEmail = process.env.ARGUS_NOTIFICATION_FROM_EMAIL || "alerts@argus.monitoring";
  }

  async send(params: SendNotificationParams): Promise<SendNotificationResult> {
    if (params.type === "SLACK") {
      return this.sendSlack(params);
    }
    return this.sendEmail(params);
  }

  private async sendSlack(params: SendNotificationParams): Promise<SendNotificationResult> {
    const secretArn = params.config.secretArn;
    if (!secretArn) {
      return { success: false, error: "CONFIGURATION_ERROR" };
    }

    let webhookUrl: string;
    try {
      const val = await this.secretsClient.send(new GetSecretValueCommand({ SecretId: secretArn }));
      webhookUrl = val.SecretString || "";
      if (!webhookUrl) {
        return { success: false, error: "CONFIGURATION_ERROR" };
      }
    } catch (err: any) {
      if (err.name === "ThrottlingException") {
        return { success: false, error: "RATE_LIMITED" };
      }
      return { success: false, error: "CONFIGURATION_ERROR" };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const isResolved = params.eventKind === "INCIDENT_RESOLVED" || params.payload.incidentStatus === "RESOLVED";
    const statusText = isResolved ? "RESOLVED" : params.payload.incidentStatus || "DOWN";
    const headerText = isResolved
      ? `[Argus Resolved] Monitor "${params.payload.monitorName}" is RESOLVED`
      : `[Argus Alert] Monitor "${params.payload.monitorName}" is ${statusText}`;
    const detailText = isResolved
      ? `*Argus Incident Resolved: ${params.payload.monitorName}*\nStatus: *RESOLVED*\nIncident ID: ${params.incidentId}\nRegions: ${params.payload.regionsSummary}`
      : `*Argus Alert: ${params.payload.monitorName}*\nStatus: *${statusText}*\nOpened at: ${params.payload.openedAt}\nRegions affected: ${params.payload.regionsSummary}`;

    try {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: headerText,
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: detailText,
              },
            },
            {
              type: "actions",
              elements: [
                {
                  type: "button",
                  text: { type: "plain_text", text: "View Incident" },
                  url: params.payload.dashboardUrl,
                },
              ],
            },
          ],
        }),
        signal: controller.signal,
      });

      if (res.status === 429) {
        const retryHeader = res.headers.get("Retry-After");
        const retryAfter = retryHeader ? Number.parseInt(retryHeader, 10) : undefined;
        return { success: false, error: "RATE_LIMITED", retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : undefined };
      }
      if (res.status >= 500) {
        return { success: false, error: "PROVIDER_5XX" };
      }
      if (!res.ok) {
        return { success: false, error: "CONFIGURATION_ERROR" };
      }
      return { success: true, response: { status: res.status } };
    } catch (err: any) {
      if (err.name === "AbortError") return { success: false, error: "TIMEOUT" };
      return { success: false, error: "PROVIDER_5XX" };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async sendEmail(params: SendNotificationParams): Promise<SendNotificationResult> {
    const recipient = params.config.recipient || params.config.email;
    if (!recipient) {
      return { success: false, error: "CONFIGURATION_ERROR" };
    }

    const isResolved = params.eventKind === "INCIDENT_RESOLVED" || params.payload.incidentStatus === "RESOLVED";
    const statusText = isResolved ? "RESOLVED" : params.payload.incidentStatus || "DOWN";
    const subject = isResolved
      ? `[Argus] Incident Resolved: ${params.payload.monitorName} is RESOLVED`
      : `[Argus] Incident Alert: ${params.payload.monitorName} is ${statusText}`;
    const bodyText = isResolved
      ? `Monitor: ${params.payload.monitorName}\nStatus: RESOLVED\nIncident ID: ${params.incidentId}\nRegions: ${params.payload.regionsSummary}\nDashboard: ${params.payload.dashboardUrl}`
      : `Monitor: ${params.payload.monitorName}\nStatus: ${statusText}\nOpened At: ${params.payload.openedAt}\nRegions: ${params.payload.regionsSummary}\nDashboard: ${params.payload.dashboardUrl}`;

    try {
      const command = new SendEmailCommand({
        FromEmailAddress: this.fromEmail,
        Destination: {
          ToAddresses: [recipient],
        },
        Content: {
          Simple: {
            Subject: {
              Data: subject,
            },
            Body: {
              Text: {
                Data: bodyText,
              },
            },
          },
        },
      });

      const response = await this.sesClient.send(command);
      return { success: true, response: { messageId: response.MessageId } };
    } catch (err: any) {
      if (err.name === "TooManyRequestsException" || err.name === "LimitExceededException") {
        return { success: false, error: "RATE_LIMITED" };
      }
      if (err.name === "MailFromDomainNotVerifiedException" || err.name === "AccountSuspendedException") {
        return { success: false, error: "CONFIGURATION_ERROR" };
      }
      return { success: false, error: "PROVIDER_5XX" };
    }
  }
}

export function createNotificationProvider(): NotificationProvider {
  const mode = process.env.NOTIFICATION_MODE || "mock";
  if (process.env.NODE_ENV === "production" && mode === "mock") {
    throw new Error("Mock notification mode is not permitted in production environment");
  }
  if (mode === "aws") {
    return new AwsNotificationProvider();
  }
  return new MockNotificationProvider();
}
