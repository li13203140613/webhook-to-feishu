import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  type BalanceAlertState,
  readBalanceAlertState,
  writeBalanceAlertState,
} from "../lib/balance-alert-state";
import { postToFeishu } from "../lib/feishu";
import { consumeNotificationThrottle } from "../lib/notification-throttle";

interface Threshold {
  level: number;
  emoji: string;
  label: string;
}

const THRESHOLDS: Threshold[] = [
  { level: 3000, emoji: "⚠️", label: "余额低于 30 元" },
  { level: 2000, emoji: "🔴", label: "余额低于 20 元" },
  { level: 1000, emoji: "🚨", label: "余额低于 10 元" },
  { level: 0, emoji: "🆘", label: "余额已耗尽" },
];

const DEFAULT_ALERT_STATE_KEY = "evolink:balance-alert-state";
const DEFAULT_SHARED_THROTTLE_KEY = "outbound:feishu:notification";
const DEFAULT_SHARED_INTERVAL_MINUTES = 60;

type TriggerReason = "threshold_crossed" | "balance_exhausted";
type SuppressedReason = "threshold_not_worse" | "shared_rate_limit";

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
  const stateKey = process.env.BALANCE_ALERT_STATE_KEY ?? DEFAULT_ALERT_STATE_KEY;
  const sharedThrottleKey =
    process.env.ALERT_FORWARD_THROTTLE_KEY ?? DEFAULT_SHARED_THROTTLE_KEY;
  const sharedIntervalMinutes = parsePositiveInt(
    process.env.ALERT_FORWARD_INTERVAL_MINUTES,
    DEFAULT_SHARED_INTERVAL_MINUTES
  );

  const stateRead = await readBalanceAlertState(stateKey);
  const previousState = stateRead.state;
  const previousThreshold = previousState?.threshold_level ?? null;
  const currentThreshold = resolveCurrentThreshold(remaining_credits);

  if (!currentThreshold) {
    const healthyState: BalanceAlertState = {
      remaining_credits,
      used_credits,
      threshold_level: null,
      last_alert_at: previousState?.last_alert_at ?? null,
    };
    const stateWrite = await writeBalanceAlertState(
      stateKey,
      healthyState,
      stateRead.backend
    );

    res.status(200).json({
      status: "ok",
      remaining_credits,
      used_credits,
      state_backend: stateWrite.backend,
      warnings: collectWarnings(stateRead.warning, stateWrite.warning),
    });
    return;
  }

  if (!isWorseThreshold(previousThreshold, currentThreshold.level)) {
    const stateWithoutAlert: BalanceAlertState = {
      remaining_credits,
      used_credits,
      threshold_level: previousThreshold,
      last_alert_at: previousState?.last_alert_at ?? null,
    };
    const stateWrite = await writeBalanceAlertState(
      stateKey,
      stateWithoutAlert,
      stateRead.backend
    );

    res.status(200).json({
      status: "alert_suppressed",
      suppressed_reason: "threshold_not_worse" as SuppressedReason,
      remaining_credits,
      used_credits,
      current_threshold: currentThreshold.level,
      threshold_label: currentThreshold.label,
      state_backend: stateWrite.backend,
      warnings: collectWarnings(stateRead.warning, stateWrite.warning),
    });
    return;
  }

  const isZeroBalance = currentThreshold.level === 0;
  let throttle:
    | Awaited<ReturnType<typeof consumeNotificationThrottle>>
    | null = null;

  if (!isZeroBalance) {
    throttle = await consumeNotificationThrottle(
      sharedThrottleKey,
      sharedIntervalMinutes
    );

    if (!throttle.allowed) {
      res.status(200).json({
        status: "alert_suppressed",
        suppressed_reason: "shared_rate_limit" as SuppressedReason,
        remaining_credits,
        used_credits,
        current_threshold: currentThreshold.level,
        threshold_label: currentThreshold.label,
        interval_minutes: throttle.interval_minutes,
        last_sent_at: throttle.last_sent_at,
        next_send_at: throttle.next_allowed_at,
        throttle_backend: throttle.backend,
        warning: throttle.warning,
      });
      return;
    }
  }

  const triggerReason: TriggerReason = isZeroBalance
    ? "balance_exhausted"
    : "threshold_crossed";
  const estimatedUsd = (remaining_credits / 100).toFixed(1);
  const text =
    `${currentThreshold.emoji} Evolink ${currentThreshold.label}\n\n` +
    `账户余额: ${remaining_credits} 积分（约 $${estimatedUsd}）\n` +
    `已用额度: ${used_credits} 积分\n` +
    `触发原因: ${
      triggerReason === "balance_exhausted" ? "余额归零立即提醒" : "关键阈值下穿"
    }\n\n` +
    "请及时充值！";

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

  const stateAfterAlert: BalanceAlertState = {
    remaining_credits,
    used_credits,
    threshold_level: currentThreshold.level,
    last_alert_at: new Date().toISOString(),
  };
  const stateWrite = await writeBalanceAlertState(
    stateKey,
    stateAfterAlert,
    stateRead.backend
  );

  res.status(200).json({
    status: "alert_sent",
    trigger_reason: triggerReason,
    remaining_credits,
    used_credits,
    threshold_level: currentThreshold.level,
    threshold_label: currentThreshold.label,
    shared_throttle_bypass: isZeroBalance,
    interval_minutes: throttle?.interval_minutes ?? sharedIntervalMinutes,
    throttle_backend: throttle?.backend,
    warning: throttle?.warning,
    state_backend: stateWrite.backend,
    warnings: collectWarnings(stateRead.warning, stateWrite.warning),
    feishu: result.data,
  });
}

function resolveCurrentThreshold(remainingCredits: number): Threshold | null {
  const matched = THRESHOLDS.filter((t) => remainingCredits <= t.level);
  if (matched.length === 0) {
    return null;
  }

  return matched.reduce((a, b) => (a.level < b.level ? a : b));
}

function isWorseThreshold(
  previousLevel: number | null,
  currentLevel: number
): boolean {
  if (previousLevel === null) {
    return true;
  }

  return currentLevel < previousLevel;
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
