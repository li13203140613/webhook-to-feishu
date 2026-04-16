# webhook-to-feishu

A Vercel serverless function that receives upstream webhooks and forwards them to a Feishu (Lark) bot in the correct format.

## How it works

1. Upstream service POSTs a webhook to `/api/webhook`
2. The function formats the payload into a readable text message
3. It generates a Feishu signature and POSTs to the Feishu bot webhook URL

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
