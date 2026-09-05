# Lesoooo Web Service

A Node.js web service that serves the site and sends moderated submissions to Telegram.

## Run locally

1. Install Node.js 18 or newer.
2. Set the Telegram variables in the shell:

```powershell
$env:BOT_TOKEN = "your-bot-token"
$env:CHAT_ID = "your-chat-id"
npm start
```

Open `http://localhost:3000`.

## Deploy on Render

1. Push this folder to a GitHub repository.
2. In Render, create a **Web Service** from that repository, or use the included `render.yaml`.
3. Set `BOT_TOKEN` and `CHAT_ID` as Render environment variables.
4. Use the Node runtime and the start command `npm start`.

Render will use `/health` for health checks. The service listens on Render's assigned `PORT`.

Never commit bot tokens or chat IDs to GitHub.
