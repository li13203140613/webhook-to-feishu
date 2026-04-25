# webhook-to-feishu

A Vercel serverless function that receives upstream webhooks and forwards them to a Feishu (Lark) bot in the correct format.

## How it works

1. Upstream service POSTs a webhook to `/api/webhook`
2. The function formats the payload into a readable text message
3. It generates a Feishu signature and POSTs to the Feishu bot webhook URL

For `New API` Bark notifications, use `/api/bark` instead. It accepts a Bark-style
GET request and forwards the message to Feishu.

## Upstream webhook format

```json
{
  "type": "quota_exceed",
  "title": "额度预警通知",
  "content": "当前用量已超过阈值",
  "values": ["用户A: 120%", "用户B: 95%"],
  "timestamp": 1739950503
}
```

## Feishu bot format (sent by this proxy)

```json
{
  "timestamp": "1739950503",
  "sign": "<hmac-sha256-base64>",
  "msg_type": "text",
  "content": {
    "text": "额度预警通知\n当前用量已超过阈值\n\n• 用户A: 120%\n• 用户B: 95%"
  }
}
```

## Setup

### 1. Clone and install

```bash
git clone <repo>
cd webhook-to-feishu
npm install
```

### 2. Configure environment variables

Copy `.env.example` to `.env.local` and fill in your values:

```bash
cp .env.example .env.local
```

| Variable | Description |
|---|---|
| `FEISHU_WEBHOOK_URL` | Feishu bot webhook URL from the bot configuration page |
| `FEISHU_WEBHOOK_SECRET` | Feishu bot signing secret (加签密钥) |
| `BARK_PROXY_TOKEN` | Optional shared token for `/api/bark` requests |
| `ALERT_FORWARD_INTERVAL_MINUTES` | *(Optional)* Shared minimum reminder interval (minutes) for `/api/webhook`, `/api/bark`, and `/api/check-balance`. Defaults to `60` |
| `ALERT_FORWARD_THROTTLE_KEY` | *(Optional)* Shared throttle key for `/api/webhook`, `/api/bark`, and `/api/check-balance`. Defaults to `outbound:feishu:notification` |
| `EVOLINK_API_KEY` | Evolink API key for balance checks |
| `EVOLINK_API_URL` | *(Optional)* Evolink API base URL. Defaults to `https://api.evolink.ai/v1` |
| `BALANCE_ALERT_STATE_KEY` | *(Optional)* KV key used to store balance alert state. Defaults to `evolink:balance-alert-state` |
| `KV_REST_API_URL` | *(Optional but recommended)* Vercel KV REST URL. Enables cross-instance dedupe/throttling |
| `KV_REST_API_TOKEN` | *(Optional but recommended)* Vercel KV REST token |
| `DAILY_REPORT_STATE_KEY_PREFIX` | *(Optional)* Daily report dedupe state prefix. Defaults to `builderpulse:daily-report:sent` |

### 3. Deploy to Vercel

```bash
npx vercel deploy
```

Set the environment variables in the Vercel dashboard under **Settings → Environment Variables**.

### 4. Point upstream service

Set the upstream webhook URL to:

```
https://<your-vercel-domain>/api/webhook
```

### 5. Point `New API` Bark URL

In `New API -> 通知配置 -> Bark通知`, fill:

```
https://<your-vercel-domain>/api/bark?token=YOUR_RANDOM_TOKEN&title={{title}}&content={{content}}
```

Notes:

- `New API` will replace `{{title}}` and `{{content}}` automatically.
- `BARK_PROXY_TOKEN` is optional, but recommended so the proxy cannot be abused.
- If you do not want to use Bark mode, you can still use `Webhook通知` and point it to
  `https://<your-vercel-domain>/api/webhook`.

## Local development

```bash
npx vercel dev
```

## Signature algorithm

Per Feishu documentation:

```
timestamp  = current unix seconds (string)
data       = timestamp + "\n" + secret
sign       = Base64(HMAC-SHA256(data, key=""))
```

## Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/api/webhook` | Health check — returns `{"status":"ok"}` |
| POST | `/api/webhook` | Receive upstream webhook and forward to Feishu |
| GET / POST | `/api/bark` | Accept Bark-style payloads and forward to Feishu |
| GET | `/api/check-balance` | Check Evolink credit balance; sends Feishu alert if below threshold |
| GET | `/api/daily-report` | Fetch BuilderPulse daily report, write to Feishu doc, notify group |

## Upstream forward throttling

`/api/webhook`, `/api/bark`, and `/api/check-balance` now share one throttle window.

- If upstream triggers repeatedly within 60 minutes (default), only the first one is forwarded.
- Later triggers within the same window return `{"status":"suppressed_by_rate_limit",...}` and are not sent to Feishu.
- To make throttling consistent across serverless instances, configure `KV_REST_API_URL` and `KV_REST_API_TOKEN`.

## Balance check

`GET /api/check-balance` calls the Evolink API and checks `user.remaining_credits`.

- Alert thresholds:
  - `<= 3000` → `余额低于 30 元`
  - `<= 2000` → `余额低于 20 元`
  - `<= 1000` → `余额低于 10 元`
  - `<= 0` → `余额已耗尽`（立即提醒，不受共享限流限制）
- When balance is healthy (not below any threshold), returns `{"status":"ok",...}` and sends no Feishu message.
- When balance is below threshold:
  - Sends only when crossing into a worse threshold than the last sent threshold.
  - If the shared hourly throttle window is occupied, returns `{"status":"alert_suppressed","suppressed_reason":"shared_rate_limit"}`.

Triggered automatically every hour via Vercel Cron.

## Daily BuilderPulse report

`GET /api/daily-report` runs the full pipeline:

1. Determines today's date in `Asia/Shanghai` timezone
2. Fetches `https://raw.githubusercontent.com/BuilderPulse/BuilderPulse/refs/heads/main/zh/{year}/{date}.md`
3. Returns `{"status":"no_report"}` if the file is not published yet (HTTP 404)
4. Parses the markdown — extracts title and up to three signal blockquotes
5. Creates a new Feishu document titled `📰 BuilderPulse 日报 — {date}`
6. Writes the full report as structured content blocks (headings, paragraphs, bullets)
7. Posts a rich-text notification to the configured group webhook with the signals summary and a link to the document

Triggered automatically at **02:00 UTC and 04:00 UTC**
(10:00 AM and 12:00 PM Beijing) via Vercel Cron.
After one successful send for the day, later retries return `{"status":"already_sent"}`.

### Additional env vars required

| Variable | Description |
|---|---|
| `FEISHU_APP_ID` | Feishu app ID (for document API) |
| `FEISHU_APP_SECRET` | Feishu app secret |
| `FEISHU_DAILY_WEBHOOK_URL` | Group webhook URL for the daily notification (no signature required) |
| `FEISHU_DAILY_FOLDER_TOKEN` | Feishu Drive folder token for storing daily docs and deduplicating retries |
| `DAILY_REPORT_STATE_KEY_PREFIX` | Dedupe state key prefix (KV-backed when configured) |

When `FEISHU_DAILY_FOLDER_TOKEN` is configured, the function will:

1. Create the daily doc inside that folder
2. Check whether today's doc title already exists before sending
3. Return `{"status":"already_sent"}` on later retries to avoid duplicate notifications

The Feishu app needs the `docx:document` (create/write documents) permission granted in the Feishu Developer Console, and it must be able to access the target Drive folder used for daily reports.
