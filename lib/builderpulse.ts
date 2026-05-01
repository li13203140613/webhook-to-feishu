/**
 * BuilderPulse daily report fetcher and markdown parser.
 */

export interface ParsedReport {
  title: string;
  /** Up to three signal lines extracted from the top blockquotes. */
  signals: string[];
  rawMarkdown: string;
}

/** Returns today's date in Asia/Shanghai timezone as YYYY-MM-DD. */
export function getTodayShanghai(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/**
 * Fetches the Chinese daily report markdown for the given date.
 * Returns null if the report does not exist yet (404).
 * Throws on other HTTP errors.
 */
export async function fetchDailyReport(date: string): Promise<string | null> {
  const year = date.slice(0, 4);
  const url = `https://raw.githubusercontent.com/BuilderPulse/BuilderPulse/refs/heads/main/zh/${year}/${date}.md`;
  const res = await fetch(url);

  if (res.status === 404) {
    return null;
  }

  if (!res.ok) {
    throw new Error(`GitHub fetch failed: HTTP ${res.status} for ${url}`);
  }

  return res.text();
}

/**
 * Parses the raw markdown to extract the title and up to three leading
 * blockquote signals (lines that start with "> " and contain a digit).
 */
export function parseReport(markdown: string): ParsedReport {
  let title = "";
  const signals: string[] = [];
  let inTopSignals = false;

  for (const raw of markdown.split("\n")) {
    const line = raw.trimEnd();

    if (!title && line.startsWith("# ")) {
      title = line.slice(2).trim();
      continue;
    }

    if (line.startsWith("## ")) {
      inTopSignals = line.includes("Top 3") || line.includes("今日 Top 3");
      continue;
    }

    if (signals.length < 3 && line.startsWith("> ")) {
      const content = line.slice(2).trim();
      if (/\d/.test(content)) {
        signals.push(content);
      }
      continue;
    }

    if (inTopSignals && signals.length < 3) {
      const numbered = line.match(/^\d+\.\s+(.+)$/);
      if (numbered) {
        signals.push(numbered[1].trim());
        continue;
      }
    }
  }

  return {
    title: title || "BuilderPulse 日报",
    signals,
    rawMarkdown: markdown,
  };
}
