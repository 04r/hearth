# 🪵 Hearth — Listen Together

Real-time synchronized music listening rooms using SoundCloud.

## Setup

```bash
npm install
node server.js
```

Open http://localhost:3000 in your browser.

## Share with friends

**Local network (same WiFi):**
- Find your local IP: run `ipconfig` (Windows) or `ifconfig` (Mac/Linux)
- Friends on the same network open: `http://YOUR-IP:3000`

**Over the internet (free options):**

### Option A — ngrok (easiest)
1. Install: https://ngrok.com/download
2. Run: `ngrok http 3000`
3. Share the `https://xxxx.ngrok.io` URL

### Option B — Railway (free hosting, permanent URL)
1. Push to GitHub
2. Go to https://railway.app → New Project → Deploy from GitHub
3. Set start command: `node server.js`
4. Done — Railway gives you a public URL automatically

### Option C — Render.com
1. Push to GitHub
2. New Web Service → connect repo
3. Build: `npm install` | Start: `node server.js`

## How it works

- Create a room → share the link
- Everyone in the room hears the same track at the same time
- Anyone can add songs to the queue (SoundCloud URLs or search)
- Playback is synced via WebSocket — server is authoritative
- If someone disconnects and reconnects, they resync to the current position
- Rooms auto-clean after 10 minutes empty

## Stack
- **Backend:** Node.js, Express, ws (WebSocket)
- **Frontend:** Vanilla JS, SoundCloud Widget API
- **Sync:** WebSocket, server-side playback clock
