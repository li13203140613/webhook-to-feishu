import type { VercelRequest, VercelResponse } from "@vercel/node";
import * as crypto from "crypto";

interface IncomingWebhook {
  type: string;
  title: string;
  content: string;
  values?: unknown[];
  timestamp: number;
}

interface FeishuPayload {
  timestamp: string;
  sign: string;
  msg_type: string;
  content: { text: string };
}

function generateSign(timestamp: string, secret: string): string {
  const stringToSign = `${timestamp}\n${secret}`;
  const hmac = crypto.createHmac("sha256", stringToSign);
  hmac.update("");
  return hmac.digest("base64");
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

  const timestamp = String(Math.floor(Date.now() / 1000));
  const sign = generateSign(timestamp, feishuSecret);
  const text = formatMessage(body);

  const payload: FeishuPayload = {
    timestamp,
    sign,
    msg_type: "text",
    content: { text },
  };

  let feishuRes: Response;
  try {
    feishuRes = await fetch(feishuUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    res.status(502).json({ error: "Failed to reach Feishu webhook", detail: String(err) });
    return;
  }

  const feishuData = await feishuRes.json().catch(() => null);

  if (!feishuRes.ok) {
    res.status(502).json({ error: "Feishu returned an error", detail: feishuData });
    return;
  }

  res.status(200).json({ success: true, feishu: feishuData });
}
