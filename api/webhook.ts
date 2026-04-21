import type { VercelRequest, VercelResponse } from "@vercel/node";
import { postToFeishu } from "../lib/feishu";
import { consumeNotificationThrottle } from "../lib/notification-throttle";

const DEFAULT_FORWARD_INTERVAL_MINUTES = 30;
const DEFAULT_FORWARD_THROTTLE_KEY = "outbound:feishu:notification";

interface IncomingWebhook {
  type: string;
  title: string;
  content: string;
  values?: unknown[];
  timestamp: number;
}

function formatMessage(body: IncomingWebhook): string {
  const lines: string[] = [body.title, body.content];

  if (Array.isArray(body.values) && body.values.length > 0) {
    lines.push("");
    for (const item of body.values) {
      lines.push(`• ${String(item)}`);
    }
  }

  return lines.join("\n");
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  if (req.method === "GET") {
    res.status(200).json({ status: "ok", message: "Webhook proxy is running" });
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const feishuUrl = process.env.FEISHU_WEBHOOK_URL;
  const feishuSecret = process.env.FEISHU_WEBHOOK_SECRET;

  if (!feishuUrl || !feishuSecret) {
    res.status(500).json({ error: "Missing FEISHU_WEBHOOK_URL or FEISHU_WEBHOOK_SECRET" });
    return;
  }

  let body: IncomingWebhook;
  try {
    body = req.body as IncomingWebhook;
    if (!body || typeof body.title !== "string" || typeof body.content !== "string") {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }
  } catch {
    res.status(400).json({ error: "Failed to parse request body" });
    return;
  }

  const text = formatMessage(body);
  const throttleKey =
    process.env.ALERT_FORWARD_THROTTLE_KEY ?? DEFAULT_FORWARD_THROTTLE_KEY;
  const intervalMinutes = parsePositiveInt(
    process.env.ALERT_FORWARD_INTERVAL_MINUTES,
    DEFAULT_FORWARD_INTERVAL_MINUTES
  );
  const throttle = await consumeNotificationThrottle(throttleKey, intervalMinutes);

  if (!throttle.allowed) {
    res.status(200).json({
      success: true,
      status: "suppressed_by_rate_limit",
      reason: "within_min_interval",
      interval_minutes: throttle.interval_minutes,
      last_sent_at: throttle.last_sent_at,
      next_send_at: throttle.next_allowed_at,
      throttle_backend: throttle.backend,
      warning: throttle.warning,
    });
    return;
  }

  let result: { ok: boolean; data: unknown };
  try {
    result = await postToFeishu(feishuUrl, feishuSecret, text);
  } catch (err) {
    res.status(502).json({ error: "Failed to reach Feishu webhook", detail: String(err) });
    return;
  }

  if (!result.ok) {
    res.status(502).json({ error: "Feishu returned an error", detail: result.data });
    return;
  }

  res.status(200).json({
    success: true,
    status: "forwarded",
    interval_minutes: throttle.interval_minutes,
    last_sent_at: throttle.last_sent_at,
    throttle_backend: throttle.backend,
    warning: throttle.warning,
    feishu: result.data,
  });
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}
