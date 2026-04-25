export type AlertStateBackend = "vercel_kv" | "memory";

export interface BalanceAlertState {
  remaining_credits: number;
  used_credits: number;
  threshold_level: number | null;
  last_alert_at: string | null;
}

export interface ReadAlertStateResult {
  state: BalanceAlertState | null;
  backend: AlertStateBackend;
  warning?: string;
}

export interface WriteAlertStateResult {
  backend: AlertStateBackend;
  warning?: string;
}

interface KvConfig {
  url: string;
  token: string;
}

const inMemoryState = new Map<string, BalanceAlertState>();

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

function parseState(value: unknown): BalanceAlertState | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<BalanceAlertState>;
  const isNullableNumber =
    typeof candidate.threshold_level === "number" ||
    candidate.threshold_level === null;
  const isNullableString =
    typeof candidate.last_alert_at === "string" || candidate.last_alert_at === null;

  if (
    typeof candidate.remaining_credits !== "number" ||
    typeof candidate.used_credits !== "number" ||
    !isNullableNumber ||
    !isNullableString
  ) {
    return null;
  }

  return {
    remaining_credits: candidate.remaining_credits,
    used_credits: candidate.used_credits,
    threshold_level: candidate.threshold_level ?? null,
    last_alert_at: candidate.last_alert_at ?? null,
  };
}

async function readFromKv(config: KvConfig, key: string): Promise<BalanceAlertState | null> {
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

  let parsed: unknown;
  try {
    parsed = JSON.parse(data.result);
  } catch {
    return null;
  }

  return parseState(parsed);
}

async function writeToKv(
  config: KvConfig,
  key: string,
  state: BalanceAlertState
): Promise<void> {
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

export async function readBalanceAlertState(
  stateKey: string
): Promise<ReadAlertStateResult> {
  const config = getKvConfig();

  if (!config) {
    return {
      state: inMemoryState.get(stateKey) ?? null,
      backend: "memory",
      warning:
        "KV_REST_API_URL / KV_REST_API_TOKEN not configured, using in-memory fallback",
    };
  }

  try {
    return {
      state: await readFromKv(config, stateKey),
      backend: "vercel_kv",
    };
  } catch (err) {
    return {
      state: inMemoryState.get(stateKey) ?? null,
      backend: "memory",
      warning: `KV unavailable, using in-memory fallback: ${String(err)}`,
    };
  }
}

export async function writeBalanceAlertState(
  stateKey: string,
  state: BalanceAlertState,
  preferredBackend: AlertStateBackend
): Promise<WriteAlertStateResult> {
  if (preferredBackend === "memory") {
    inMemoryState.set(stateKey, state);
    return { backend: "memory" };
  }

  const config = getKvConfig();
  if (!config) {
    inMemoryState.set(stateKey, state);
    return {
      backend: "memory",
      warning:
        "KV_REST_API_URL / KV_REST_API_TOKEN not configured while writing, switched to in-memory fallback",
    };
  }

  try {
    await writeToKv(config, stateKey, state);
    return { backend: "vercel_kv" };
  } catch (err) {
    inMemoryState.set(stateKey, state);
    return {
      backend: "memory",
      warning: `KV write failed, switched to in-memory fallback: ${String(err)}`,
    };
  }
}
