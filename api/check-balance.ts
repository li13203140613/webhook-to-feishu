import type { VercelRequest, VercelResponse } from "@vercel/node";
import { postToFeishu } from "../lib/feishu";

const THRESHOLDS = [
  { level: 5000, emoji: "⚠️", label: "余额预警" },
  { level: 2000, emoji: "🔴", label: "余额严重不足" },
  { level: 1000, emoji: "🚨", label: "余额即将耗尽" },
];

interface EvolinkCredits {
  remaining_credits: number;
  used_credits: number;
}

interface EvolinkResponse {
  data: {
    user: EvolinkCredits;
    token: {
      remaining_credits: number;
      unlimited_credits: boolean;
      used_credits: number;
    };
  };
  success: boolean;
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const evolinkApiKey = process.env.EVOLINK_API_KEY;
  const evolinkBaseUrl = process.env.EVOLINK_API_URL ?? "https://api.evolink.ai/v1";
  const evolinkApiUrl = `${evolinkBaseUrl.replace(/\/+$/, "")}/credits`;
  const feishuUrl = process.env.FEISHU_WEBHOOK_URL;
  const feishuSecret = process.env.FEISHU_WEBHOOK_SECRET;

  if (!evolinkApiKey) {
    res.status(500).json({ error: "Missing EVOLINK_API_KEY" });
    return;
  }
  if (!feishuUrl || !feishuSecret) {
    res.status(500).json({ error: "Missing FEISHU_WEBHOOK_URL or FEISHU_WEBHOOK_SECRET" });
    return;
  }

  let evolinkData: EvolinkResponse;
  try {
    const evolinkRes = await fetch(evolinkApiUrl, {
      headers: { Authorization: `Bearer ${evolinkApiKey}` },
    });
    if (!evolinkRes.ok) {
      const detail = await evolinkRes.text().catch(() => null);
      res.status(502).json({ error: "Evolink API returned an error", detail });
      return;
    }
    evolinkData = (await evolinkRes.json()) as EvolinkResponse;
  } catch (err) {
    res.status(502).json({ error: "Failed to reach Evolink API", detail: String(err) });
    return;
  }

  const { remaining_credits, used_credits } = evolinkData.data.user;

  const matched = THRESHOLDS.filter((t) => remaining_credits < t.level);
  if (matched.length === 0) {
    res.status(200).json({ status: "ok", remaining_credits, used_credits });
    return;
  }

  // Most urgent = the one with the lowest level threshold
  const urgent = matched.reduce((a, b) => (a.level < b.level ? a : b));
  const estimatedUsd = (remaining_credits / 100).toFixed(1);
  const text =
    `${urgent.emoji} Evolink ${urgent.label}\n\n` +
    `账户余额: ${remaining_credits} 积分（约 $${estimatedUsd}）\n` +
    `已用额度: ${used_credits} 积分\n\n` +
    `请及时充值！`;

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
    status: "alert_sent",
    remaining_credits,
    used_credits,
    feishu: result.data,
  });
}
