import type { VercelRequest, VercelResponse } from "@vercel/node";
import { postToFeishu } from "../lib/feishu";

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

  res.status(200).json({ success: true, feishu: result.data });
}
