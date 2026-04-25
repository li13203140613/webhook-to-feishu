export type DailyReportStateBackend = "vercel_kv" | "memory";

export interface DailyReportSentState {
  date: string;
  sent_at: string;
  document_id: string | null;
  document_url: string | null;
}

export interface ReadDailyReportStateResult {
  state: DailyReportSentState | null;
  backend: DailyReportStateBackend;
  warning?: string;
}

export interface WriteDailyReportStateResult {
  backend: DailyReportStateBackend;
  warning?: string;
}

interface KvConfig {
  url: string;
  token: string;
}

const inMemoryState = new Map<string, DailyReportSentState>();

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

function parseState(value: unknown): DailyReportSentState | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<DailyReportSentState>;
  const validDocId =
    typeof candidate.document_id === "string" || candidate.document_id === null;
  const validDocUrl =
    typeof candidate.document_url === "string" || candidate.document_url === null;

  if (
    typeof candidate.date !== "string" ||
    candidate.date.trim() === "" ||
    typeof candidate.sent_at !== "string" ||
    candidate.sent_at.trim() === "" ||
    !validDocId ||
    !validDocUrl
  ) {
    return null;
  }

  return {
    date: candidate.date,
    sent_at: candidate.sent_at,
    document_id: candidate.document_id ?? null,
    document_url: candidate.document_url ?? null,
  };
}

async function readFromKv(
  config: KvConfig,
  key: string
): Promise<DailyReportSentState | null> {
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
    return parseState(JSON.parse(data.result));
  } catch {
    return null;
  }
}

async function writeToKv(
  config: KvConfig,
  key: string,
  state: DailyReportSentState
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

export async function readDailyReportSentState(
  key: string
): Promise<ReadDailyReportStateResult> {
  const config = getKvConfig();
  if (!config) {
    return {
      state: inMemoryState.get(key) ?? null,
      backend: "memory",
      warning: "KV not configured, using in-memory daily report dedupe fallback",
    };
  }

  try {
    return {
      state: await readFromKv(config, key),
      backend: "vercel_kv",
    };
  } catch (err) {
    return {
      state: inMemoryState.get(key) ?? null,
      backend: "memory",
      warning: `KV unavailable, using in-memory daily report dedupe fallback: ${String(err)}`,
    };
  }
}

export async function writeDailyReportSentState(
  key: string,
  state: DailyReportSentState,
  preferredBackend: DailyReportStateBackend
): Promise<WriteDailyReportStateResult> {
  if (preferredBackend === "memory") {
    inMemoryState.set(key, state);
    return { backend: "memory" };
  }

  const config = getKvConfig();
  if (!config) {
    inMemoryState.set(key, state);
    return {
      backend: "memory",
      warning: "KV not configured during write, switched to in-memory fallback",
    };
  }

  try {
    await writeToKv(config, key, state);
    return { backend: "vercel_kv" };
  } catch (err) {
    inMemoryState.set(key, state);
    return {
      backend: "memory",
      warning: `KV write failed, switched to in-memory fallback: ${String(err)}`,
    };
  }
}
