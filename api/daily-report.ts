import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  fetchDailyReport,
  getTodayShanghai,
  parseReport,
  type ParsedReport,
} from "../lib/builderpulse";
import {
  createDocument,
  getTenantAccessToken,
  markdownToBlocks,
  writeBlocksToDocument,
} from "../lib/feishu-doc";

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  const dailyWebhookUrl = process.env.FEISHU_DAILY_WEBHOOK_URL;

  if (!appId || !appSecret || !dailyWebhookUrl) {
    res.status(500).json({
      error:
        "Missing required env vars: FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_DAILY_WEBHOOK_URL",
    });
    return;
  }

  // 1. Determine today's date in Asia/Shanghai timezone
  const date = getTodayShanghai();

  // 2. Fetch report from GitHub
  let markdown: string | null;
  try {
    markdown = await fetchDailyReport(date);
  } catch (err) {
    res
      .status(502)
      .json({ error: "Failed to fetch report from GitHub", detail: String(err) });
    return;
  }

  if (markdown === null) {
    res.status(200).json({ status: "no_report", date });
    return;
  }

  // 3. Parse markdown for title + signals
  const report = parseReport(markdown);

  // 4. Get Feishu tenant access token
  let token: string;
  try {
    token = await getTenantAccessToken(appId, appSecret);
  } catch (err) {
    res
      .status(502)
      .json({ error: "Failed to get Feishu tenant token", detail: String(err) });
    return;
  }

  // 5. Create the Feishu document
  const docTitle = `📰 BuilderPulse 日报 — ${date}`;
  let documentId: string;
  let documentUrl: string;
  try {
    const doc = await createDocument(token, docTitle);
    documentId = doc.documentId;
    documentUrl = doc.url;
  } catch (err) {
    res
      .status(502)
      .json({ error: "Failed to create Feishu document", detail: String(err) });
    return;
  }

  // 6. Write content blocks to the document
  const blocks = markdownToBlocks(markdown);
  try {
    await writeBlocksToDocument(token, documentId, blocks);
  } catch (err) {
    res
      .status(502)
      .json({ error: "Failed to write document blocks", detail: String(err) });
    return;
  }

  // 7. Send notification to the Feishu group webhook
  try {
    const notif = buildNotification(report, date, documentUrl);
    const webhookRes = await fetch(dailyWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(notif),
    });

    if (!webhookRes.ok) {
      const detail = await webhookRes.text().catch(() => null);
      res.status(502).json({ error: "Feishu webhook returned an error", detail });
      return;
    }
  } catch (err) {
    res
      .status(502)
      .json({ error: "Failed to reach Feishu webhook", detail: String(err) });
    return;
  }

  res.status(200).json({
    status: "ok",
    date,
    document_id: documentId,
    document_url: documentUrl,
    blocks_written: blocks.length,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildNotification(
  report: ParsedReport,
  date: string,
  docUrl: string
) {
  const signalLines =
    report.signals.length > 0
      ? report.signals.map((s) => [{ tag: "text", text: `• ${s}` }])
      : [[{ tag: "text", text: "（暂无信号摘要）" }]];

  return {
    msg_type: "post",
    content: {
      post: {
        zh_cn: {
          title: `📰 ${report.title}`,
          content: [
            [{ tag: "text", text: `📅 日期：${date}` }],
            [{ tag: "text", text: " " }],
            [{ tag: "text", text: "📊 今日信号：" }],
            ...signalLines,
            [{ tag: "text", text: " " }],
            [{ tag: "a", text: "📖 查看完整日报 →", href: docUrl }],
          ],
        },
      },
    },
  };
}
