export type ThrottleBackend = "vercel_kv" | "memory";

interface KvConfig {
  url: string;
  token: string;
}

interface ThrottleState {
  last_sent_at: string;
}

export interface ThrottleDecision {
  allowed: boolean;
  backend: ThrottleBackend;
  interval_minutes: number;
  last_sent_at: string | null;
  next_allowed_at: string | null;
  warning?: string;
}

const inMemoryThrottle = new Map<string, ThrottleState>();

function getKvConfig(): KvConfig | null {
  const url = process.env.KV_REST_API_URL?.trim();
  const token = process.env.KV_REST_API_TOKEN?.trim();

  if (!url || !token) {
    return null;
  }

  return {
    url: url.replace(/\/+$/, ""),
    token,
  };
}

function parseThrottleState(value: unknown): ThrottleState | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<ThrottleState>;
  if (typeof candidate.last_sent_at !== "string" || candidate.last_sent_at.trim() === "") {
    return null;
  }

  return { last_sent_at: candidate.last_sent_at };
}

async function readFromKv(config: KvConfig, key: string): Promise<ThrottleState | null> {
  const res = await fetch(`${config.url}/get/${encodeURIComponent(key)}`, {
    headers: {
      Authorization: `Bearer ${config.token}`,
    },
  });

  if (!res.ok) {
    throw new Error(`KV get failed: HTTP ${res.status}`);
  }

  const data = (await res.json()) as {
    result?: string | null;
    error?: string;
  };

  if (data.error) {
    throw new Error(`KV get failed: ${data.error}`);
  }
  if (!data.result) {
    return null;
  }

  try {
    return parseThrottleState(JSON.parse(data.result));
  } catch {
    return null;
  }
}

async function writeToKv(config: KvConfig, key: string, state: ThrottleState): Promise<void> {
  const encodedValue = encodeURIComponent(JSON.stringify(state));
  const res = await fetch(`${config.url}/set/${encodeURIComponent(key)}/${encodedValue}`, {
    headers: {
      Authorization: `Bearer ${config.token}`,
    },
  });

  if (!res.ok) {
    throw new Error(`KV set failed: HTTP ${res.status}`);
  }

  const data = (await res.json()) as { error?: string };
  if (data.error) {
    throw new Error(`KV set failed: ${data.error}`);
  }
}

async function readState(
  key: string
): Promise<{ state: ThrottleState | null; backend: ThrottleBackend; warning?: string }> {
  const config = getKvConfig();
  if (!config) {
    return {
      state: inMemoryThrottle.get(key) ?? null,
      backend: "memory",
      warning: "KV not configured, using in-memory throttle fallback",
    };
  }

  try {
    return {
      state: await readFromKv(config, key),
      backend: "vercel_kv",
    };
  } catch (err) {
    return {
      state: inMemoryThrottle.get(key) ?? null,
      backend: "memory",
      warning: `KV unavailable, using in-memory throttle fallback: ${String(err)}`,
    };
  }
}

async function writeState(
  key: string,
  state: ThrottleState,
  preferredBackend: ThrottleBackend
): Promise<{ backend: ThrottleBackend; warning?: string }> {
  if (preferredBackend === "memory") {
    inMemoryThrottle.set(key, state);
    return { backend: "memory" };
  }

  const config = getKvConfig();
  if (!config) {
    inMemoryThrottle.set(key, state);
    return {
      backend: "memory",
      warning: "KV not configured during write, switched to in-memory fallback",
    };
  }

  try {
    await writeToKv(config, key, state);
    return { backend: "vercel_kv" };
  } catch (err) {
    inMemoryThrottle.set(key, state);
    return {
      backend: "memory",
      warning: `KV write failed, switched to in-memory fallback: ${String(err)}`,
    };
  }
}

export async function consumeNotificationThrottle(
  key: string,
  intervalMinutes: number
): Promise<ThrottleDecision> {
  const safeIntervalMinutes = Number.isFinite(intervalMinutes) && intervalMinutes > 0
    ? Math.floor(intervalMinutes)
    : 30;
  const intervalMs = safeIntervalMinutes * 60_000;
  const nowMs = Date.now();

  const read = await readState(key);
  const lastSentAt = read.state?.last_sent_at ?? null;
  const lastSentAtMs = lastSentAt ? Date.parse(lastSentAt) : NaN;

  if (!lastSentAt || Number.isNaN(lastSentAtMs) || nowMs - lastSentAtMs >= intervalMs) {
    const nextState: ThrottleState = { last_sent_at: new Date(nowMs).toISOString() };
    const write = await writeState(key, nextState, read.backend);
    return {
      allowed: true,
      backend: write.backend,
      interval_minutes: safeIntervalMinutes,
      last_sent_at: nextState.last_sent_at,
      next_allowed_at: null,
      warning: combineWarnings(read.warning, write.warning),
    };
  }

  return {
    allowed: false,
    backend: read.backend,
    interval_minutes: safeIntervalMinutes,
    last_sent_at: lastSentAt,
    next_allowed_at: new Date(lastSentAtMs + intervalMs).toISOString(),
    warning: read.warning,
  };
}

function combineWarnings(...warnings: Array<string | undefined>): string | undefined {
  const merged = warnings
    .filter((w): w is string => Boolean(w))
    .map((w) => w.trim())
    .filter((w) => w.length > 0);

  if (merged.length === 0) {
    return undefined;
  }

  return Array.from(new Set(merged)).join(" | ");
}
