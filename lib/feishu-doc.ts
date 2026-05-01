/**
 * Feishu document API helpers.
 * Covers: tenant_access_token, document creation, and block-level content writing.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TenantTokenResponse {
  code: number;
  msg: string;
  tenant_access_token: string;
  expire: number;
}

interface CreateDocResponse {
  code: number;
  msg: string;
  data: {
    document: {
      document_id: string;
      revision_id: number;
      title: string;
    };
  };
}

interface ListFilesResponse {
  code: number;
  msg: string;
  data?: {
    files?: Array<{
      name: string;
      token: string;
      type?: string;
      url?: string;
    }>;
    has_more?: boolean;
    next_page_token?: string;
  };
}

interface BlockApiResponse {
  code: number;
  msg: string;
}

type BlockType = 2 | 3 | 4 | 5 | 12;

interface TextElementStyle {
  bold?: boolean;
  italic?: boolean;
  codeInline?: boolean;
  link?: {
    url: string;
  };
}

interface TextRun {
  content: string;
  text_element_style?: TextElementStyle;
}

interface TextElement {
  text_run: TextRun;
}

interface BlockContent {
  elements: TextElement[];
  style: Record<string, unknown>;
}

export interface FeishuBlock {
  block_type: BlockType;
  text?: BlockContent;
  heading1?: BlockContent;
  heading2?: BlockContent;
  heading3?: BlockContent;
  bullet?: BlockContent;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/** Obtains a short-lived tenant_access_token via app credentials. */
export async function getTenantAccessToken(
  appId: string,
  appSecret: string
): Promise<string> {
  const res = await fetch(
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    }
  );

  if (!res.ok) {
    throw new Error(`Feishu auth request failed: HTTP ${res.status}`);
  }

  const data = (await res.json()) as TenantTokenResponse;
  if (data.code !== 0) {
    throw new Error(`Feishu auth error (code ${data.code}): ${data.msg}`);
  }

  return data.tenant_access_token;
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

/**
 * Creates a new Feishu docx document.
 * Returns the document_id and a shareable URL.
 */
export async function createDocument(
  token: string,
  title: string,
  folderToken?: string
): Promise<{ documentId: string; url: string }> {
  const body: Record<string, string> = { title };
  if (folderToken) body.folder_token = folderToken;

  const res = await fetch(
    "https://open.feishu.cn/open-apis/docx/v1/documents",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    const detail = await res.text().catch(() => null);
    throw new Error(`Create document failed: HTTP ${res.status} — ${detail}`);
  }

  const data = (await res.json()) as CreateDocResponse;
  if (data.code !== 0) {
    throw new Error(
      `Create document error (code ${data.code}): ${data.msg}`
    );
  }

  const { document_id } = data.data.document;
  return {
    documentId: document_id,
    url: `https://feishu.cn/docx/${document_id}`,
  };
}

/**
 * Finds an existing document with the exact title inside a Feishu Drive folder.
 * Returns the first matching document if found, otherwise null.
 */
export async function findDocumentByTitleInFolder(
  token: string,
  folderToken: string,
  title: string
): Promise<{ documentId: string; url: string } | null> {
  let pageToken: string | undefined;

  while (true) {
    const params = new URLSearchParams({
      folder_token: folderToken,
      page_size: "200",
    });

    if (pageToken) {
      params.set("page_token", pageToken);
    }

    const res = await fetch(
      `https://open.feishu.cn/open-apis/drive/v1/files?${params.toString()}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );

    if (!res.ok) {
      const detail = await res.text().catch(() => null);
      throw new Error(`List files failed: HTTP ${res.status} — ${detail}`);
    }

    const data = (await res.json()) as ListFilesResponse;
    if (data.code !== 0) {
      throw new Error(`List files error (code ${data.code}): ${data.msg}`);
    }

    const files = data.data?.files ?? [];
    const existing = files.find(
      (file) =>
        file.name === title &&
        (file.type === "docx" || file.url?.includes("/docx/"))
    );

    if (existing) {
      return {
        documentId: existing.token,
        url: existing.url ?? `https://feishu.cn/docx/${existing.token}`,
      };
    }

    if (!data.data?.has_more || !data.data.next_page_token) {
      return null;
    }

    pageToken = data.data.next_page_token;
  }
}

// ---------------------------------------------------------------------------
// Block writing
// ---------------------------------------------------------------------------

/**
 * Appends blocks to the document body in chunks of CHUNK_SIZE.
 * The root page block shares its ID with the document_id.
 */
export async function writeBlocksToDocument(
  token: string,
  documentId: string,
  blocks: FeishuBlock[]
): Promise<void> {
  const CHUNK_SIZE = 50;
  let insertIndex = 0;

  for (let i = 0; i < blocks.length; i += CHUNK_SIZE) {
    const chunk = blocks.slice(i, i + CHUNK_SIZE);

    const res = await fetch(
      `https://open.feishu.cn/open-apis/docx/v1/documents/${documentId}/blocks/${documentId}/children`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ children: chunk, index: insertIndex }),
      }
    );

    if (!res.ok) {
      const detail = await res.text().catch(() => null);
      throw new Error(`Write blocks failed: HTTP ${res.status} — ${detail}`);
    }

    const data = (await res.json()) as BlockApiResponse;
    if (data.code !== 0) {
      throw new Error(`Write blocks error (code ${data.code}): ${data.msg}`);
    }

    insertIndex += chunk.length;
  }
}

// ---------------------------------------------------------------------------
// Markdown → Feishu blocks conversion
// ---------------------------------------------------------------------------

const SECTION_EMOJI: Record<string, string> = {
  发现机会: "🔍",
  技术选型: "⚙️",
  竞争情报: "🏁",
  趋势判断: "📈",
  行动触发: "🚀",
};

function addSectionEmoji(heading: string): string {
  for (const [keyword, emoji] of Object.entries(SECTION_EMOJI)) {
    if (heading.includes(keyword) && !heading.startsWith(emoji)) {
      return `${emoji} ${heading}`;
    }
  }
  return heading;
}

/** Converts inline markdown to styled Feishu text elements. */
function toElements(text: string): TextElement[] {
  const elements: TextElement[] = [];
  const tokenRe =
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*]+)\*\*|`([^`]+)`|\*([^*]+)\*/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenRe.exec(text)) !== null) {
    if (match.index > lastIndex) {
      elements.push({
        text_run: { content: text.slice(lastIndex, match.index) },
      });
    }

    if (match[1] && match[2]) {
      elements.push({
        text_run: {
          content: match[1],
          text_element_style: {
            link: { url: match[2] },
          },
        },
      });
    } else if (match[3]) {
      elements.push({
        text_run: {
          content: match[3],
          text_element_style: { bold: true },
        },
      });
    } else if (match[4]) {
      elements.push({
        text_run: {
          content: match[4],
          text_element_style: { codeInline: true },
        },
      });
    } else if (match[5]) {
      elements.push({
        text_run: {
          content: match[5],
          text_element_style: { italic: true },
        },
      });
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    elements.push({ text_run: { content: text.slice(lastIndex) } });
  }

  return elements.length > 0
    ? elements
    : [{ text_run: { content: text } }];
}

function block(type: BlockType, elements: TextElement[]): FeishuBlock {
  const fieldMap: Record<BlockType, keyof FeishuBlock> = {
    2: "text",
    3: "heading1",
    4: "heading2",
    5: "heading3",
    12: "bullet",
  };
  const field = fieldMap[type];
  return { block_type: type, [field]: { elements, style: {} } } as FeishuBlock;
}

/**
 * Converts BuilderPulse markdown to an array of Feishu content blocks.
 *
 * Mapping:
 *   `# …`     → heading1 (block_type 3)
 *   `## …`    → heading2 (block_type 4)  + section emoji prefix
 *   `### …`   → heading3 (block_type 5)  + section emoji prefix
 *   `> …`     → text paragraph with 🎯 prefix (takeaway / signal)
 *   `- …`     → bullet (block_type 12)
 *   `---`     → skipped
 *   (empty)   → skipped
 *   other     → text paragraph (block_type 2)
 */
export function markdownToBlocks(markdown: string): FeishuBlock[] {
  const blocks: FeishuBlock[] = [];

  for (const raw of markdown.split("\n")) {
    const line = raw.trimEnd();

    if (line.startsWith("# ")) {
      blocks.push(block(3, toElements(line.slice(2).trim())));
    } else if (line.startsWith("## ")) {
      blocks.push(block(4, toElements(addSectionEmoji(line.slice(3).trim()))));
    } else if (line.startsWith("### ")) {
      blocks.push(block(5, toElements(addSectionEmoji(line.slice(4).trim()))));
    } else if (/^\d+\.\s+/.test(line)) {
      blocks.push(block(12, toElements(line.replace(/^\d+\.\s+/, "").trim())));
    } else if (line.startsWith("> ")) {
      const content = line.slice(2).trim();
      const display = content.startsWith("🎯") ? content : `🎯 ${content}`;
      blocks.push(block(2, toElements(display)));
    } else if (line.startsWith("**🔍 信号**：")) {
      blocks.push(block(5, toElements("🔍 信号")));
      blocks.push(block(2, toElements(line.replace("**🔍 信号**：", "").trim())));
    } else if (line.startsWith("**关键判断**：")) {
      blocks.push(block(5, toElements("✅ 关键判断")));
      blocks.push(block(2, toElements(line.replace("**关键判断**：", "").trim())));
    } else if (line.startsWith("**反向视角**：")) {
      blocks.push(block(5, toElements("⚠️ 反向视角")));
      blocks.push(block(2, toElements(line.replace("**反向视角**：", "").trim())));
    } else if (line.startsWith("- ") || line.startsWith("* ")) {
      blocks.push(block(12, toElements(line.slice(2).trim())));
    } else if (line === "" || line === "---") {
      // skip empty lines and horizontal rules
    } else {
      blocks.push(block(2, toElements(line)));
    }
  }

  return blocks;
}
