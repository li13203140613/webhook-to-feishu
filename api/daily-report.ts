import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  fetchDailyReport,
  getTodayShanghai,
  parseReport,
  type ParsedReport,
} from "../lib/builderpulse";
import {
  createDocument,
  findDocumentByTitleInFolder,
  getTenantAccessToken,
  markdownToBlocks,
  writeBlocksToDocument,
} from "../lib/feishu-doc";
import {
  readDailyReportSentState,
  writeDailyReportSentState,
} from "../lib/daily-report-state";

const DEFAULT_DAILY_REPORT_STATE_KEY_PREFIX = "builderpulse:daily-report:sent";

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
  const dailyFolderToken = normalizeFolderToken(
    process.env.FEISHU_DAILY_FOLDER_TOKEN
  );

  if (!appId || !appSecret || !dailyWebhookUrl) {
    res.status(500).json({
      error:
        "Missing required env vars: FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_DAILY_WEBHOOK_URL",
    });
    return;
  }

  // 1. Determine today's date in Asia/Shanghai timezone
  const date = getTodayShanghai();
  const docTitle = `📰 BuilderPulse 日报 — ${date}`;
  const stateKeyPrefix =
    process.env.DAILY_REPORT_STATE_KEY_PREFIX ?? DEFAULT_DAILY_REPORT_STATE_KEY_PREFIX;
  const stateKey = `${stateKeyPrefix}:${date}`;

  const stateRead = await readDailyReportSentState(stateKey);
  if (stateRead.state) {
    res.status(200).json({
      status: "already_sent",
      date,
      document_id: stateRead.state.document_id,
      document_url: stateRead.state.document_url,
      sent_at: stateRead.state.sent_at,
      dedupe_backend: stateRead.backend,
      warnings: collectWarnings(stateRead.warning),
    });
    return;
  }

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
  const readableMarkdown = buildReadableMarkdown(markdown, report, date);

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

  // 5. Skip retries once today's document already exists in the target folder.
  if (dailyFolderToken) {
    try {
      const existing = await findDocumentByTitleInFolder(
        token,
        dailyFolderToken,
        docTitle
      );

      if (existing) {
        const stateWrite = await writeDailyReportSentState(
          stateKey,
          {
            date,
            sent_at: new Date().toISOString(),
            document_id: existing.documentId,
            document_url: existing.url,
          },
          stateRead.backend
        );
        res.status(200).json({
          status: "already_sent",
          date,
          document_id: existing.documentId,
          document_url: existing.url,
          dedupe_backend: stateWrite.backend,
          warnings: collectWarnings(stateRead.warning, stateWrite.warning),
        });
        return;
      }
    } catch (err) {
      console.warn("Skipping duplicate check after Feishu folder lookup failed:", err);
    }
  }

  // 6. Create the Feishu document
  let documentId: string;
  let documentUrl: string;
  try {
    const doc = await createDocument(token, docTitle, dailyFolderToken);
    documentId = doc.documentId;
    documentUrl = doc.url;
  } catch (err) {
    res
      .status(502)
      .json({ error: "Failed to create Feishu document", detail: String(err) });
    return;
  }

  // 7. Write content blocks to the document
  const blocks = markdownToBlocks(readableMarkdown);
  try {
    await writeBlocksToDocument(token, documentId, blocks);
  } catch (err) {
    res
      .status(502)
      .json({ error: "Failed to write document blocks", detail: String(err) });
    return;
  }

  // 8. Send notification to the Feishu group webhook
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

  const stateWrite = await writeDailyReportSentState(
    stateKey,
    {
      date,
      sent_at: new Date().toISOString(),
      document_id: documentId,
      document_url: documentUrl,
    },
    stateRead.backend
  );

  res.status(200).json({
    status: "ok",
    date,
    document_id: documentId,
    document_url: documentUrl,
    blocks_written: blocks.length,
    dedupe_backend: stateWrite.backend,
    warnings: collectWarnings(stateRead.warning, stateWrite.warning),
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildReadableMarkdown(
  markdown: string,
  report: ParsedReport,
  date: string
) {
  const introLines = [
    "## 简记",
    `- 日期：${date}`,
    `- 主题：${report.title}`,
  ];

  if (report.signals.length > 0) {
    introLines.push("- 今日重点：");
    for (const signal of report.signals) {
      introLines.push(`- ${signal}`);
    }
  }

  return `${introLines.join("\n")}\n\n---\n\n${markdown}`;
}

function normalizeFolderToken(folderToken?: string): string | undefined {
  if (!folderToken) {
    return undefined;
  }

  return folderToken.startsWith("fld") ? folderToken : undefined;
}

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

function collectWarnings(...warnings: Array<string | undefined>): string[] | undefined {
  const values = warnings
    .filter((w): w is string => Boolean(w))
    .map((w) => w.trim())
    .filter((w) => w.length > 0);

  if (values.length === 0) {
    return undefined;
  }

  return Array.from(new Set(values));
}
