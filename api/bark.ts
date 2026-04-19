import type { VercelRequest, VercelResponse } from "@vercel/node";
import { postToFeishu } from "../lib/feishu";

interface BarkForwardPayload {
  title: string;
  subtitle?: string;
  content: string;
  values?: unknown[];
  url?: string;
  group?: string;
}

function getString(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return getString(value[0]);
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function getValues(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const values = value
      .map((item) => getString(item))
      .filter((item): item is string => Boolean(item));
    return values.length > 0 ? values : undefined;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") {
      return undefined;
    }

    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return getValues(parsed);
      }
    } catch {
      // Treat non-JSON strings as a single value.
    }

    return [trimmed];
  }

  return undefined;
}

function buildMessage(payload: BarkForwardPayload): string {
  const lines: string[] = [payload.title];

  if (payload.subtitle) {
    lines.push(payload.subtitle);
  }

  lines.push(payload.content);

  if (payload.values && payload.values.length > 0) {
    lines.push("");
    for (const item of payload.values) {
      lines.push(`• ${String(item)}`);
    }
  }

  if (payload.group) {
    lines.push("", `Group: ${payload.group}`);
  }

  if (payload.url) {
    lines.push("", `URL: ${payload.url}`);
  }

  return lines.join("\n");
}

function getAuthToken(req: VercelRequest): string | undefined {
  return (
    getString(req.query.token) ||
    getString(req.body?.token) ||
    getString(req.headers["x-bark-token"]) ||
    getString(req.headers.authorization)?.replace(/^Bearer\s+/i, "").trim()
  );
}

function parsePayload(req: VercelRequest): BarkForwardPayload | null {
  const source = req.method === "GET" ? req.query : req.body;

  const title = getString(source?.title);
  const content =
    getString(source?.content) ||
    getString(source?.body) ||
    getString(source?.message);

  if (!title || !content) {
    return null;
  }

  return {
    title,
    subtitle: getString(source?.subtitle),
    content,
    values: getValues(source?.values) || getValues(source?.value),
    url: getString(source?.url),
    group: getString(source?.group),
  };
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  if (req.method === "GET" && !getString(req.query.title) && !getString(req.query.content)) {
    res.status(200).json({
      status: "ok",
      message: "Bark proxy is running",
      example:
        "/api/bark?token=YOUR_TOKEN&title=额度预警通知&content=当前余额低于阈值",
    });
    return;
  }

  if (req.method !== "GET" && req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const feishuUrl = process.env.FEISHU_WEBHOOK_URL;
  const feishuSecret = process.env.FEISHU_WEBHOOK_SECRET;
  const barkProxyToken = process.env.BARK_PROXY_TOKEN;

  if (!feishuUrl || !feishuSecret) {
    res
      .status(500)
      .json({ error: "Missing FEISHU_WEBHOOK_URL or FEISHU_WEBHOOK_SECRET" });
    return;
  }

  if (barkProxyToken && getAuthToken(req) !== barkProxyToken) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const payload = parsePayload(req);
  if (!payload) {
    res.status(400).json({
      error:
        "Invalid request. Expected title plus content/body/message in query or JSON body.",
    });
    return;
  }

  const text = buildMessage(payload);

  let result: { ok: boolean; data: unknown };
  try {
    result = await postToFeishu(feishuUrl, feishuSecret, text);
  } catch (err) {
    res
      .status(502)
      .json({ error: "Failed to reach Feishu webhook", detail: String(err) });
    return;
  }

  if (!result.ok) {
    res.status(502).json({ error: "Feishu returned an error", detail: result.data });
    return;
  }

  res.status(200).json({
    success: true,
    forwarded: {
      title: payload.title,
      subtitle: payload.subtitle || null,
      group: payload.group || null,
      url: payload.url || null,
      valuesCount: payload.values?.length || 0,
    },
    feishu: result.data,
  });
}
