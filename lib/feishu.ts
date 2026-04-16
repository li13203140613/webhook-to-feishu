import * as crypto from "crypto";

export function generateSign(timestamp: string, secret: string): string {
  const stringToSign = `${timestamp}\n${secret}`;
  const hmac = crypto.createHmac("sha256", stringToSign);
  hmac.update("");
  return hmac.digest("base64");
}

export async function postToFeishu(
  webhookUrl: string,
  secret: string,
  text: string
): Promise<{ ok: boolean; data: unknown }> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sign = generateSign(timestamp, secret);

  const payload = {
    timestamp,
    sign,
    msg_type: "text",
    content: { text },
  };

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => null);
  return { ok: res.ok, data };
}
