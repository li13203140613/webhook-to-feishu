import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  type BalanceAlertState,
  readBalanceAlertState,
  writeBalanceAlertState,
} from "../lib/balance-alert-state";
import { postToFeishu } from "../lib/feishu";

interface Threshold {
  level: number;
  emoji: string;
  label: string;
}

const THRESHOLDS: Threshold[] = [
  { level: 30, emoji: "⚠️", label: "余额低于 30" },
  { level: 20, emoji: "🔴", label: "余额低于 20" },
  { level: 10, emoji: "🚨", label: "余额低于 10" },
  { level: 0, emoji: "🆘", label: "余额已耗尽" },
];

const DEFAULT_BALANCE_PROVIDER = "apimart";
const DEFAULT_APIMART_API_URL = "https://api.apimart.ai/v1";
const DEFAULT_EVOLINK_API_URL = "https://api.evolink.ai/v1";

type BalanceProvider = "apimart" | "evolink";
type TriggerReason = "threshold_crossed" | "balance_exhausted";
type SuppressedReason =
  | "threshold_not_worse"
  | "durable_state_unavailable"
  | "state_write_failed"
  | "provider_unlimited";

interface EvolinkCredits {
  remaining_credits: number;
  used_credits: number;
}

interface EvolinkResponse {
  data: {
    user: EvolinkCredits;
    token?: {
      remaining_credits?: number;
      unlimited_credits?: boolean;
      used_credits?: number;
    };
  };
  success: boolean;
}

interface ApiMartResponse {
  success: boolean;
  message?: string;
  remain_balance?: number;
  used_balance?: number;
  unlimited_quota?: boolean;
}

interface BalanceSnapshot {
  provider: BalanceProvider;
  providerLabel: string;
  remainingBalance: number;
  usedBalance: number;
  unlimited: boolean;
  displayLines: string[];
}

interface BalanceFetchError {
  status: number;
  error: string;
  detail?: unknown;
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const feishuUrl = process.env.FEISHU_WEBHOOK_URL;
  const feishuSecret = process.env.FEISHU_WEBHOOK_SECRET;

  if (!feishuUrl || !feishuSecret) {
    res.status(500).json({ error: "Missing FEISHU_WEBHOOK_URL or FEISHU_WEBHOOK_SECRET" });
    return;
  }

  const provider = normalizeProvider(process.env.BALANCE_PROVIDER);
  if (!provider) {
    res.status(500).json({ error: "Invalid BALANCE_PROVIDER (expected apimart or evolink)" });
    return;
  }

  const fetchResult = await fetchBalanceSnapshot(provider);
  if (!fetchResult.ok) {
    res
      .status(fetchResult.error.status)
      .json({ error: fetchResult.error.error, detail: fetchResult.error.detail });
    return;
  }

  const snapshot = fetchResult.snapshot;
  const stateKey =
    process.env.BALANCE_ALERT_STATE_KEY ?? `${provider}:balance-alert-state`;

  const stateRead = await readBalanceAlertState(stateKey);
  const warningsFromRead = collectWarnings(stateRead.warning);

  // No durable state = no reliable dedupe. Fail closed to avoid duplicate spam.
  if (stateRead.backend !== "vercel_kv") {
    res.status(503).json({
      status: "alert_suppressed",
      suppressed_reason: "durable_state_unavailable" as SuppressedReason,
      provider,
      remaining_balance: snapshot.remainingBalance,
      used_balance: snapshot.usedBalance,
      state_backend: stateRead.backend,
      warnings: warningsFromRead,
    });
    return;
  }

  const previousState = stateRead.state;
  const previousThreshold = previousState?.threshold_level ?? null;

  if (snapshot.unlimited) {
    const stateWrite = await writeBalanceAlertState(
      stateKey,
      {
        remaining_credits: snapshot.remainingBalance,
        used_credits: snapshot.usedBalance,
        threshold_level: null,
        last_alert_at: previousState?.last_alert_at ?? null,
      },
      "vercel_kv"
    );

    res.status(200).json({
      status: "alert_suppressed",
      suppressed_reason: "provider_unlimited" as SuppressedReason,
      provider,
      remaining_balance: snapshot.remainingBalance,
      used_balance: snapshot.usedBalance,
      state_backend: stateWrite.backend,
      warnings: collectWarnings(stateRead.warning, stateWrite.warning),
    });
    return;
  }

  const currentThreshold = resolveCurrentThreshold(snapshot.remainingBalance);

  if (!currentThreshold) {
    const healthyState: BalanceAlertState = {
      remaining_credits: snapshot.remainingBalance,
      used_credits: snapshot.usedBalance,
      threshold_level: null,
      last_alert_at: previousState?.last_alert_at ?? null,
    };
    const stateWrite = await writeBalanceAlertState(
      stateKey,
      healthyState,
      "vercel_kv"
    );
    const warnings = collectWarnings(stateRead.warning, stateWrite.warning);

    if (stateWrite.backend !== "vercel_kv") {
      res.status(503).json({
        status: "alert_suppressed",
        suppressed_reason: "state_write_failed" as SuppressedReason,
        provider,
        remaining_balance: snapshot.remainingBalance,
        used_balance: snapshot.usedBalance,
        state_backend: stateWrite.backend,
        warnings,
      });
      return;
    }

    res.status(200).json({
      status: "ok",
      provider,
      remaining_balance: snapshot.remainingBalance,
      used_balance: snapshot.usedBalance,
      state_backend: stateWrite.backend,
      warnings,
    });
    return;
  }

  if (!isWorseThreshold(previousThreshold, currentThreshold.level)) {
    res.status(200).json({
      status: "alert_suppressed",
      suppressed_reason: "threshold_not_worse" as SuppressedReason,
      provider,
      remaining_balance: snapshot.remainingBalance,
      used_balance: snapshot.usedBalance,
      current_threshold: currentThreshold.level,
      threshold_label: currentThreshold.label,
      state_backend: stateRead.backend,
      warnings: warningsFromRead,
    });
    return;
  }

  const triggerReason: TriggerReason =
    currentThreshold.level === 0 ? "balance_exhausted" : "threshold_crossed";
  const nextState: BalanceAlertState = {
    remaining_credits: snapshot.remainingBalance,
    used_credits: snapshot.usedBalance,
    threshold_level: currentThreshold.level,
    last_alert_at: new Date().toISOString(),
  };

  // Write state before sending to guarantee at-most-once per threshold level.
  const stateWrite = await writeBalanceAlertState(stateKey, nextState, "vercel_kv");
  const warnings = collectWarnings(stateRead.warning, stateWrite.warning);

  if (stateWrite.backend !== "vercel_kv") {
    res.status(503).json({
      status: "alert_suppressed",
      suppressed_reason: "state_write_failed" as SuppressedReason,
      provider,
      remaining_balance: snapshot.remainingBalance,
      used_balance: snapshot.usedBalance,
      current_threshold: currentThreshold.level,
      threshold_label: currentThreshold.label,
      state_backend: stateWrite.backend,
      warnings,
    });
    return;
  }

  const text =
    `${currentThreshold.emoji} ${snapshot.providerLabel} ${currentThreshold.label}\n\n` +
    `${snapshot.displayLines.join("\n")}\n` +
    `触发原因: ${
      triggerReason === "balance_exhausted" ? "余额归零立即提醒" : "关键阈值下穿"
    }\n\n` +
    "请及时充值！";

  let result: { ok: boolean; data: unknown };
  try {
    result = await postToFeishu(feishuUrl, feishuSecret, text);
  } catch (err) {
    await rollbackState(stateKey, previousState, snapshot);
    res.status(502).json({ error: "Failed to reach Feishu webhook", detail: String(err) });
    return;
  }

  if (!result.ok) {
    await rollbackState(stateKey, previousState, snapshot);
    res.status(502).json({ error: "Feishu returned an error", detail: result.data });
    return;
  }

  res.status(200).json({
    status: "alert_sent",
    provider,
    trigger_reason: triggerReason,
    remaining_balance: snapshot.remainingBalance,
    used_balance: snapshot.usedBalance,
    threshold_level: currentThreshold.level,
    threshold_label: currentThreshold.label,
    state_backend: stateWrite.backend,
    warnings,
    feishu: result.data,
  });
}

async function fetchBalanceSnapshot(
  provider: BalanceProvider
): Promise<{ ok: true; snapshot: BalanceSnapshot } | { ok: false; error: BalanceFetchError }> {
  if (provider === "apimart") {
    return fetchApiMartBalance();
  }

  return fetchEvolinkBalance();
}

async function fetchApiMartBalance(): Promise<
  { ok: true; snapshot: BalanceSnapshot } | { ok: false; error: BalanceFetchError }
> {
  const apiKey = process.env.APIMART_API_KEY;
  if (!apiKey) {
    return { ok: false, error: { status: 500, error: "Missing APIMART_API_KEY" } };
  }

  const baseUrl = process.env.APIMART_API_URL ?? DEFAULT_APIMART_API_URL;
  const url = `${baseUrl.replace(/\/+$/, "")}/user/balance`;

  let res: globalThis.Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch (err) {
    return {
      ok: false,
      error: { status: 502, error: "Failed to reach APIMart API", detail: String(err) },
    };
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => null);
    return {
      ok: false,
      error: { status: 502, error: "APIMart API returned an error", detail },
    };
  }

  const data = (await res.json()) as ApiMartResponse;
  if (!data.success) {
    return {
      ok: false,
      error: {
        status: 502,
        error: "APIMart balance query failed",
        detail: data.message ?? data,
      },
    };
  }

  const remain = toFiniteNumber(data.remain_balance);
  const used = toFiniteNumber(data.used_balance);
  if (remain === null || used === null) {
    return {
      ok: false,
      error: { status: 502, error: "APIMart balance response is invalid", detail: data },
    };
  }

  const unlimited = Boolean(data.unlimited_quota) || remain < 0;

  return {
    ok: true,
    snapshot: {
      provider: "apimart",
      providerLabel: "APIMart",
      remainingBalance: remain,
      usedBalance: used,
      unlimited,
      displayLines: [
        `账户余额: ${formatNumber(remain)}`,
        `已用额度: ${formatNumber(used)}`,
        "余额单位以 APIMart 平台配置为准",
      ],
    },
  };
}

async function fetchEvolinkBalance(): Promise<
  { ok: true; snapshot: BalanceSnapshot } | { ok: false; error: BalanceFetchError }
> {
  const evolinkApiKey = process.env.EVOLINK_API_KEY;
  if (!evolinkApiKey) {
    return { ok: false, error: { status: 500, error: "Missing EVOLINK_API_KEY" } };
  }

  const baseUrl = process.env.EVOLINK_API_URL ?? DEFAULT_EVOLINK_API_URL;
  const url = `${baseUrl.replace(/\/+$/, "")}/credits`;

  let res: globalThis.Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${evolinkApiKey}` },
    });
  } catch (err) {
    return {
      ok: false,
      error: { status: 502, error: "Failed to reach Evolink API", detail: String(err) },
    };
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => null);
    return {
      ok: false,
      error: { status: 502, error: "Evolink API returned an error", detail },
    };
  }

  const data = (await res.json()) as EvolinkResponse;
  const remainingCredits = toFiniteNumber(data.data?.user?.remaining_credits);
  const usedCredits = toFiniteNumber(data.data?.user?.used_credits);

  if (remainingCredits === null || usedCredits === null) {
    return {
      ok: false,
      error: { status: 502, error: "Evolink balance response is invalid", detail: data },
    };
  }

  const remainingUsd = remainingCredits / 100;
  const usedUsd = usedCredits / 100;
  // Evolink 的 token.unlimited_credits 在部分账号上不稳定，
  // 这里不据此抑制阈值告警，避免漏发 30/20/10/0 提醒。
  const unlimited = false;

  return {
    ok: true,
    snapshot: {
      provider: "evolink",
      providerLabel: "Evolink",
      remainingBalance: remainingUsd,
      usedBalance: usedUsd,
      unlimited,
      displayLines: [
        `账户余额: ${formatNumber(remainingCredits)} 积分（约 $${formatNumber(remainingUsd)}）`,
        `已用额度: ${formatNumber(usedCredits)} 积分（约 $${formatNumber(usedUsd)}）`,
      ],
    },
  };
}

function resolveCurrentThreshold(remainingBalance: number): Threshold | null {
  const matched = THRESHOLDS.filter((t) => remainingBalance <= t.level);
  if (matched.length === 0) {
    return null;
  }

  return matched.reduce((a, b) => (a.level < b.level ? a : b));
}

function isWorseThreshold(previousLevel: number | null, currentLevel: number): boolean {
  if (previousLevel === null) {
    return true;
  }

  return currentLevel < previousLevel;
}

async function rollbackState(
  stateKey: string,
  previousState: BalanceAlertState | null,
  snapshot: BalanceSnapshot
): Promise<void> {
  const rollback: BalanceAlertState = previousState ?? {
    remaining_credits: snapshot.remainingBalance,
    used_credits: snapshot.usedBalance,
    threshold_level: null,
    last_alert_at: null,
  };

  await writeBalanceAlertState(stateKey, rollback, "vercel_kv").catch(() => undefined);
}

function normalizeProvider(value: string | undefined): BalanceProvider | null {
  const provider = (value ?? DEFAULT_BALANCE_PROVIDER).trim().toLowerCase();
  if (provider === "apimart" || provider === "evolink") {
    return provider;
  }

  return null;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number") {
    return null;
  }

  if (!Number.isFinite(value)) {
    return null;
  }

  return value;
}

function formatNumber(value: number): string {
  const rounded = Math.round((value + Number.EPSILON) * 10000) / 10000;
  if (Number.isInteger(rounded)) {
    return String(rounded);
  }

  return String(rounded);
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
