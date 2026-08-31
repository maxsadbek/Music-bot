# 🎵 Musify - Instagram Reel Music Finder Telegram Bot

Musify is a production-ready Telegram Bot designed to identify music from Instagram Reels. Built with **Next.js (App Router)**, **TypeScript**, **grammY**, and **Zod**, optimized for deployment on **Vercel Serverless Functions**.

---

## 🌟 Features

- **Instagram Reel URL Validation**: Validates and normalizes Instagram Reel links (`/reel/`, `/reels/`, `/p/`).
- **Media Extraction Abstraction**: Swappable REST service layer for fetching downloadable audio/video links.
- **Song Recognition**: Integrated with **ACRCloud API** for track identification, returning artist, track, album, release date, and streaming links (Spotify).
- **Clean Telegram UX**: Interactive inline callback buttons, dynamic message updates (avoiding chat spam), custom status emojis (🎬 ⏳ ✅ 🔍 🎵 🎤 💿 😔 ❌).
- **Vercel Serverless Compatible**: Fully stateless webhooks designed to scale on Vercel without requiring a permanent VPS or local FFmpeg daemon.
- **Redis Caching Support**: Upstash Redis primary job storage with in-memory cache for speed optimizations.
- **Rate Limiting**: Integrated sliding-window rate limiter per user (max 5 requests per minute).

---

## 🛠 Tech Stack

- **Framework**: Next.js 15 (App Router)
- **Language**: TypeScript
- **Telegram Bot Engine**: grammY
- **Validation**: Zod
- **Music Recognition API**: ACRCloud API
- **Testing**: Vitest
- **Deployment**: Vercel

---

## 🔑 Required Environment Variables

Create a `.env.local` file in your root directory based on `.env.example`:

| Variable | Description | Required |
| :--- | :--- | :---: |
| `TELEGRAM_BOT_TOKEN` | Bot API token from [@BotFather](https://t.me/BotFather) | **Yes** |
| `TELEGRAM_WEBHOOK_SECRET` | Secret token to authenticate Telegram webhook calls | Optional |
| `ACRCLOUD_HOST` | ACRCloud Identify host (e.g. `identify-eu-west-1.acrcloud.com`) | **Yes** |
| `ACRCLOUD_ACCESS_KEY` | ACRCloud Access Key from console | **Yes** |
| `ACRCLOUD_ACCESS_SECRET` | ACRCloud Access Secret from console | **Yes** |
| `INSTAGRAM_API_URL` | HTTP endpoint URL for Instagram Reel downloader service | **Yes** |
| `INSTAGRAM_API_KEY` | API Key for Instagram downloader service (e.g., RapidAPI) | Optional / Service dependent |
| `UPSTASH_REDIS_REST_URL` | Upstash Redis REST URL for distributed jobs | Recommended |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis REST Token | Recommended |
| `DEBUG_INSTAGRAM_API` | Set to `true` to log raw API data when video URL extraction fails | Optional |

---

## ⚠️ Important Note on Vercel Plan Limits

> [!IMPORTANT]
> The webhook API route is configured with `export const maxDuration = 60;` to allow sufficient time for Instagram media retrieval (up to 12s) and ACRCloud music recognition (up to 20s).
>
> - **Vercel Hobby (Free)** plan caps serverless function execution at 10–15 seconds. If requests exceed 10s on Hobby, Vercel will time out the function.
> - **Vercel Pro** is recommended for production deployments to support `maxDuration` up to 60 seconds.

---

## 🚀 Third-Party Credentials Setup

### 1. Telegram Bot Token
1. Open Telegram and search for [@BotFather](https://t.me/BotFather).
2. Send `/newbot` and follow instructions to get your `TELEGRAM_BOT_TOKEN`.

### 2. ACRCloud Credentials
1. Register at [acrcloud.com](https://www.acrcloud.com/).
2. Create an Audio & Video Recognition project.
3. Copy `Host`, `Access Key`, and `Access Secret` into `ACRCLOUD_HOST`, `ACRCLOUD_ACCESS_KEY`, and `ACRCLOUD_ACCESS_SECRET`.

### 3. Instagram Media Downloader API
1. Subscribe to an Instagram Reel Downloader REST API (e.g. via RapidAPI, Cobalt API, or custom extractor endpoint).
2. Set `INSTAGRAM_API_URL` (e.g. `https://instagram-downloader-download-instagram-videos-stories1.p.rapidapi.com/get-info`) and `INSTAGRAM_API_KEY`.
3. The abstraction module at `lib/services/instagram.ts` handles response parsing automatically.

---

## 💻 Local Development & Unit Tests

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Run Unit Tests**:
   ```bash
   npm run test
   ```

3. **Set up `.env.local`**:
   ```bash
   cp .env.example .env.local
   # Fill in TELEGRAM_BOT_TOKEN, ACRCLOUD_HOST, ACRCLOUD_ACCESS_KEY, ACRCLOUD_ACCESS_SECRET, INSTAGRAM_API_URL, INSTAGRAM_API_KEY
   ```

4. **Start Next.js dev server**:
   ```bash
   npm run dev
   ```

5. **Expose local server (e.g. via ngrok)**:
   ```bash
   ngrok http 3000
   ```

6. **Set Webhook to local ngrok tunnel**:
   ```bash
   curl -X POST "https://api.telegram.org/bot<YOUR_TELEGRAM_BOT_TOKEN>/setWebhook" \
     -H "Content-Type: application/json" \
     -d '{"url": "https://<your-ngrok-domain>.ngrok-free.app/api/telegram/webhook"}'
   ```

---

## ☁️ Deploy to Vercel

1. Push your repository to GitHub / GitLab / Bitbucket.
2. Import project into [Vercel](https://vercel.com).
3. Add Environment Variables in Vercel project settings.
4. Click **Deploy**.
5. Once deployed, set your Telegram Webhook URL to your production Vercel domain:
   ```bash
   curl -X POST "https://api.telegram.org/bot<YOUR_TELEGRAM_BOT_TOKEN>/setWebhook" \
     -H "Content-Type: application/json" \
     -d '{
       "url": "https://<your-app>.vercel.app/api/telegram/webhook",
       "secret_token": "<YOUR_TELEGRAM_WEBHOOK_SECRET>"
     }'
   ```