# 🎵 Musify - Instagram Reel Music Finder Telegram Bot

Musify is a production-ready Telegram Bot designed to identify music from Instagram Reels. Built with **Next.js (App Router)**, **TypeScript**, **grammY**, and **Zod**, optimized for deployment on **Vercel Serverless Functions**.

---

## 🌟 Features

- **Instagram Reel URL Validation**: Validates and normalizes Instagram Reel links (`/reel/`, `/reels/`, `/p/`).
- **Media Extraction Abstraction**: Swappable REST service layer for fetching downloadable audio/video links.
- **Song Recognition**: Integrated with **AudD API** for track identification, returning artist, track, album, release date, and direct streaming links (Spotify, Apple Music).
- **Clean Telegram UX**: Interactive inline callback buttons, dynamic message updates (avoiding chat spam), custom status emojis (🎬 ⏳ ✅ 🔍 🎵 🎤 💿 😔 ❌).
- **Vercel Serverless Compatible**: Fully stateless webhooks designed to scale on Vercel without requiring a permanent VPS or local FFmpeg daemon.
- **Redis Caching Support**: Optional Upstash / Redis job caching with in-memory fallback for local development.

---

## 🛠 Tech Stack

- **Framework**: Next.js 15 (App Router)
- **Language**: TypeScript
- **Telegram Bot Engine**: grammY
- **Validation**: Zod
- **Music Recognition API**: AudD API
- **Deployment**: Vercel

---

## 🔑 Required Environment Variables

Create a `.env.local` file in your root directory based on `.env.example`:

| Variable | Description | Required |
| :--- | :--- | :---: |
| `TELEGRAM_BOT_TOKEN` | Bot API token from [@BotFather](https://t.me/BotFather) | **Yes** |
| `TELEGRAM_WEBHOOK_SECRET` | Secret token to authenticate Telegram webhook calls | Optional |
| `AUDD_API_TOKEN` | API token from [AudD Music Recognition](https://audd.io/) | **Yes** |
| `INSTAGRAM_API_URL` | HTTP endpoint URL for Instagram Reel downloader service | **Yes** |
| `INSTAGRAM_API_KEY` | API Key for Instagram downloader service (e.g., RapidAPI) | Optional / Service dependent |
| `UPSTASH_REDIS_REST_URL` | Upstash Redis REST URL for distributed jobs | Optional |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis REST Token | Optional |

---

## 🚀 Third-Party Credentials Setup

### 1. Telegram Bot Token
1. Open Telegram and search for [@BotFather](https://t.me/BotFather).
2. Send `/newbot` and follow instructions to get your `TELEGRAM_BOT_TOKEN`.

### 2. AudD API Token
1. Register at [audd.io](https://audd.io/).
2. Copy your API token into `AUDD_API_TOKEN`.

### 3. Instagram Media Downloader API
1. Subscribe to an Instagram Reel Downloader REST API (e.g. via RapidAPI, Cobalt API, or custom extractor endpoint).
2. Set `INSTAGRAM_API_URL` (e.g. `https://instagram-downloader-download-instagram-videos-stories1.p.rapidapi.com/get-info`) and `INSTAGRAM_API_KEY`.
3. The abstraction module at `lib/services/instagram.ts` handles response parsing automatically.

---

## 💻 Local Development

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Set up `.env.local`**:
   ```bash
   cp .env.example .env.local
   # Fill in TELEGRAM_BOT_TOKEN, AUDD_API_TOKEN, INSTAGRAM_API_URL, INSTAGRAM_API_KEY
   ```

3. **Start Next.js dev server**:
   ```bash
   npm run dev
   ```

4. **Expose local server (e.g. via ngrok)**:
   ```bash
   ngrok http 3000
   ```

5. **Set Webhook to local ngrok tunnel**:
   ```bash
   curl -X POST "https://api.telegram.org/bot<YOUR_TELEGRAM_BOT_TOKEN>/setWebhook" \
     -H "Content-Type: application/json" \
     -d '{"url": "https://<your-ngrok-domain>.ngrok-free.app/api/telegram/webhook"}'
   ```

---

## ☁️ Deploy to Vercel

1. Push your repository to GitHub / GitLab / Bitbucket.
2. Import project into [Vercel](https://vercel.com).
3. Add Environment Variables in Vercel project settings:
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_WEBHOOK_SECRET` (optional)
   - `AUDD_API_TOKEN`
   - `INSTAGRAM_API_URL`
   - `INSTAGRAM_API_KEY`
   - `UPSTASH_REDIS_REST_URL` & `UPSTASH_REDIS_REST_TOKEN` (optional)
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

---

## 🤖 Bot Commands & User Flow

- `/start`: Displays welcome banner and instructions.
- `/help`: Displays step-by-step usage guide.
- `/about`: Displays bot information.

### User Journey:
1. User sends an Instagram Reel link (`https://www.instagram.com/reel/XXXXX/`).
2. Bot validates link and responds with `🎬 Reel received \n\n ⏳ Getting the video...`.
3. Upon video retrieval, bot updates message to `✅ Video found!` with inline button `[ 🎵 Musiqani topish ]`.
4. User clicks `[ 🎵 Musiqani topish ]`.
5. Bot updates message to `🔍 Musiqa aniqlanmoqda...` and queries AudD API.
6. Song identified -> Bot displays track details (`🎤 Artist`, `🎵 Track`, `💿 Album`) and streaming buttons (`[ 🎧 Spotify ]`, `[ 🍎 Apple Music ]`).
7. Song not identified -> Bot displays helpful reasons and `[ 🔄 Qayta urinib ko‘rish ]` button.

---

## 📜 Code Quality & Verification

Run strict TypeScript checks and ESLint build validation:

```bash
npm run type-check
npm run lint
npm run build
```