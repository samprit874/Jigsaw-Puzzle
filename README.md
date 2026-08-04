# 🧩 Jigsaw Together

**Real-time multiplayer jigsaw puzzle — piece memories together with your favorite people 💞**

Upload a photo, share a link with your GF / bestie / friend, and solve the puzzle together in real time from separate phones or laptops.

![made with love](https://img.shields.io/badge/made%20with-%F0%9F%92%96-pink)
![node](https://img.shields.io/badge/node-%3E%3D16-brightgreen)
![socket.io](https://img.shields.io/badge/socket.io-realtime-purple)

## ✨ Features

- 🎟️ **Room codes** — create a room, share a 5-letter link, anyone can join (up to 6 players)
- 🧩 **Real jigsaw pieces** — tabs & knobs that interlock (not just square tiles!)
- 📸 **Upload any photo** (selfies, memories, trip photos) or pick a built-in sample
- 🎯 **4 difficulties**: 3×3 Easy · 4×4 Medium · 5×5 Hard · 6×6 Expert
- ⚡ **Real-time sync** — every drag is broadcast live over WebSockets
- 🧲 **Snap to place** — pieces lock in when dropped near the right spot
- 🔍 **Pan & zoom** — scroll wheel on desktop, pinch-zoom on mobile
- 💬 **Built-in chat** — tease/help each other mid-game
- 👑 **Host controls** — shuffle loose pieces, get a hint, peek at the reference
- 🎨 **Player colors** — pick your color, pieces glow to show who touched them last
- 📊 Live timer, progress bar, per-player piece counts
- 🎉 Confetti celebration when you finish together
- 📱 Fully responsive for phones & tablets

## 🚀 Quick Start

```bash
# Install dependencies
npm install

# Run the server
npm start
```

Then open http://localhost:3000 in your browser.

### How to play together
1. One person taps **✨ Create Room**, uploads a photo, picks difficulty
2. Share the invite link (or room code) with your friend
3. Friend opens the link, enters their name, hits **🚪 Join**
4. Host taps **🧩 Let's Play!** and you're solving together in real time

## ☁️ Deploy (free options)

The app is a standard Node + Express + Socket.IO server. It works out of the box on:

- **Glitch** — upload the folder and click Run
- **Render** — new Web Service, build `npm install`, start `npm start`
- **Railway** / **Fly.io** / **Heroku** — standard Node deploys
- **Replit** — paste the files and run `node server.js`

Remember: for others to play with you over the internet, it needs to be on a public URL (not just localhost).

## 🛠 Tech Stack

- **Backend:** Node.js + Express + Socket.IO (real-time WebSocket sync)
- **Frontend:** Vanilla JS, HTML5 Canvas (piece rendering), CSS3
- No build step, no framework — just `npm install && npm start`

## 📁 Project Structure

```
jigsaw-app/
├── server.js          # Express + Socket.IO multiplayer server
├── package.json
└── public/
    └── index.html     # Full game client (lobby + canvas game + chat)
```

## 💖 Made for sharing moments with people you love

> *"Piece together your memories with your loved one"*

## License
MIT — do whatever, just send good vibes 💞
