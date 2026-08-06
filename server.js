// 🧩 Jigsaw Together - Real-time multiplayer server
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 8 * 1024 * 1024, // 8 MB for photo uploads
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/img/:code', (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room || !room.image) return res.status(404).send('no image');
  res.set('Content-Type', 'text/plain');
  res.send(room.image.dataUrl);
});

// Room state
/** rooms[code] = {
 *   code, hostId, difficulty, image: null | { dataUrl, w, h },
 *   players: { [socketId]: { id, name, color, emoji, ready } },
 *   pieces: [ { id, x, y, rotation, z, placed, slot, lastMover } ],
 *   started: false, finished: false, startedAt: null, hints: 0, shuffled: false,
 *   chat: []
 * }
 */
const rooms = new Map();

const COLORS = [
  { name: 'Pink',   hex: '#ff6b9d', emoji: '💖' },
  { name: 'Purple', hex: '#c084fc', emoji: '💜' },
  { name: 'Blue',   hex: '#60a5fa', emoji: '💙' },
  { name: 'Green',  hex: '#34d399', emoji: '💚' },
  { name: 'Orange', hex: '#fb923c', emoji: '🧡' },
  { name: 'Yellow', hex: '#facc15', emoji: '💛' },
];
const NAMES = ['Puzzler', 'Solver', 'PieceMaster', 'JigsawJedi', 'SnapKing', 'EdgeFinder', 'CornerQueen', 'Buddy'];

function genCode() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

function roomState(r) {
  return {
    code: r.code,
    hostId: r.hostId,
    difficulty: r.difficulty,
    hasImage: !!r.image,
    players: Object.values(r.players).map(p => ({
      id: p.id, name: p.name, color: p.color, emoji: p.emoji, ready: p.ready,
      piecesPlaced: r.pieces.filter(pc => pc.placed && pc.lastMover === p.id).length,
    })),
    pieces: r.pieces.map(p => ({ id: p.id, x: p.x, y: p.y, rotation: p.rotation, z: p.z, placed: p.placed, slot: p.slot, lastMover: p.lastMover })),
    started: r.started,
    finished: r.finished,
    startedAt: r.startedAt,
    hints: r.hints,
    totalPieces: r.difficulty * r.difficulty,
    placedCount: r.pieces.filter(p => p.placed).length,
    chat: r.chat.slice(-30),
  };
}

function broadcastState(room) {
  io.to(room.code).emit('state', roomState(room));
}

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('createRoom', (cb) => {
    let code;
    do { code = genCode(); } while (rooms.has(code));
    const color = COLORS[0];
    const room = {
      code, hostId: socket.id,
      difficulty: 3,
      image: null,
      players: {},
      pieces: [],
      started: false, finished: false, startedAt: null, hints: 0, shuffled: false,
      chat: [],
    };
    room.players[socket.id] = {
      id: socket.id,
      name: 'Host ' + NAMES[Math.floor(Math.random() * NAMES.length)],
      color: color.hex, emoji: color.emoji, ready: true,
    };
    rooms.set(code, room);
    socket.join(code);
    currentRoom = code;
    cb && cb({ ok: true, code, selfId: socket.id });
    broadcastState(room);
    console.log(`[create] ${socket.id} -> ${code}`);
  });

  socket.on('joinRoom', ({ code, name }, cb) => {
    code = (code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return cb && cb({ ok: false, error: 'Room not found. Check the code!' });
    if (room.started) return cb && cb({ ok: false, error: 'Game already started. Ask host to restart.' });
    if (Object.keys(room.players).length >= 6) return cb && cb({ ok: false, error: 'Room is full (max 6).' });

    const used = new Set(Object.values(room.players).map(p => p.color));
    const color = COLORS.find(c => !used.has(c.hex)) || COLORS[Math.floor(Math.random() * COLORS.length)];
    const finalName = (name && name.trim().slice(0, 16)) || ('Guest ' + NAMES[Math.floor(Math.random() * NAMES.length)]);

    room.players[socket.id] = {
      id: socket.id, name: finalName, color: color.hex, emoji: color.emoji, ready: true,
    };
    socket.join(code);
    currentRoom = code;
    cb && cb({ ok: true, code, selfId: socket.id });
    room.chat.push({ system: true, text: `💫 ${finalName} joined the puzzle!`, t: Date.now() });
    broadcastState(room);
    console.log(`[join] ${socket.id} -> ${code} (${finalName})`);
  });

  socket.on('updateName', ({ name }) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room?.players[socket.id]) return;
    room.players[socket.id].name = (name || '').trim().slice(0, 16) || 'Buddy';
    broadcastState(room);
  });

  socket.on('updateColor', ({ hex }) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room?.players[socket.id]) return;
    const color = COLORS.find(c => c.hex === hex) || COLORS[0];
    room.players[socket.id].color = color.hex;
    room.players[socket.id].emoji = color.emoji;
    broadcastState(room);
  });

  socket.on('setDifficulty', ({ n }) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    if (room.hostId !== socket.id) return;
    if (room.started) return;
    n = Math.max(3, Math.min(6, parseInt(n) || 3));
    room.difficulty = n;
    broadcastState(room);
  });

  socket.on('setImage', ({ dataUrl, w, h }) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    if (room.hostId !== socket.id) return;
    if (room.started) return;
    // Truncate if too large
    if (dataUrl.length > 7 * 1024 * 1024) {
      socket.emit('error', 'Image too large (max ~6MB). Try a smaller photo.');
      return;
    }
    room.image = { dataUrl, w, h };
    broadcastState(room);
  });

  socket.on('startGame', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    if (room.hostId !== socket.id) return;
    if (!room.image) { socket.emit('error', 'Upload a photo first!'); return; }
    if (room.started) return;

    const n = room.difficulty;
    room.pieces = [];
    const W = 1000, H = 1000; // logical board area
    const pieceW = W / n, pieceH = H / n;

    // Scatter in a "tray" region (right side) — server only stores logical coords;
    // client maps to actual pixels.
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const id = r * n + c;
        // Tray area: logical coords beyond W..W+400, y random
        const tx = W + 40 + Math.random() * 300;
        const ty = 40 + Math.random() * (H - pieceH - 80);
        room.pieces.push({
          id,
          x: tx, y: ty,
          rotation: 0,
          z: id,
          placed: false,
          slot: { r, c },
          lastMover: null,
        });
      }
    }
    room.started = true;
    room.finished = false;
    room.startedAt = Date.now();
    room.hints = 0;
    room.chat.push({ system: true, text: '🧩 Puzzle started! Work together 💞', t: Date.now() });
    broadcastState(room);
  });

  socket.on('movePiece', ({ id, x, y, z, drag }) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room?.started) return;
    const p = room.pieces.find(pp => pp.id === id);
    if (!p) return;
    // Snap check: if within threshold of slot position, snap
    const n = room.difficulty;
    const W = 1000, H = 1000;
    const pieceW = W / n, pieceH = H / n;
    const slotX = p.slot.c * pieceW;
    const slotY = p.slot.r * pieceH;
    const inSlot = Math.abs(x - slotX) < pieceW * 0.35 && Math.abs(y - slotY) < pieceH * 0.35;

    if (drag) {
      // Transient drag update: move the piece but NEVER snap / place / win-check
      // mid-drag. A piece passing over its slot while still being dragged would
      // otherwise "complete" the puzzle (and lock the game) while the dragging
      // client is still holding it.
      p.x = x; p.y = y; p.z = z;
      if (p.placed && !inSlot) p.placed = false; // piece was lifted off its slot
    } else {
      // Final drop (client pointer-up)
      p.x = inSlot ? slotX : x;
      p.y = inSlot ? slotY : y;
      p.z = z;
      if (inSlot) {
        if (!p.placed) {
          p.placed = true;
          p.lastMover = socket.id;
          room.chat.push({
            system: true,
            text: `${room.players[socket.id]?.emoji || '🧩'} ${room.players[socket.id]?.name || 'Someone'} placed piece #${id + 1}!`,
            t: Date.now(),
          });
        }
      } else {
        p.placed = false;
      }
    }

    // Win check — only on final drops, so the celebration can never fire (or get
    // stuck) while a piece is still in someone's hand.
    if (!drag) {
      const allPlaced = room.pieces.every(pp => pp.placed);
      if (allPlaced && !room.finished) {
        room.finished = true;
        room.chat.push({ system: true, text: '🎉 You did it together! 💖💕💖', t: Date.now() });
      } else if (!allPlaced && room.finished) {
        // A placed piece was moved off after the win — resume the game
        room.finished = false;
      }
    }

    // Broadcast move (lighter than full state for 60fps)
    io.to(currentRoom).emit('pieceMove', {
      id, x: p.x, y: p.y, z: p.z, placed: p.placed, lastMover: p.lastMover,
      finished: room.finished,
      placedCount: room.pieces.filter(pp => pp.placed).length,
    });
  });

  socket.on('shuffle', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room?.started || room.finished) return;
    if (room.hostId !== socket.id) return;
    const n = room.difficulty;
    const W = 1000;
    for (const p of room.pieces) {
      if (p.placed) continue;
      p.x = W + 40 + Math.random() * 300;
      p.y = 40 + Math.random() * 900;
      p.z = (p.z || 0) + 1;
    }
    broadcastState(room);
  });

  socket.on('hint', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room?.started || room.finished) return;
    if (room.hostId !== socket.id) return;
    room.hints++;
    io.to(currentRoom).emit('hint', { n: room.hints });
  });

  socket.on('viewPhoto', ({ on }) => {
    if (!currentRoom) return;
    io.to(currentRoom).emit('viewPhoto', { on: !!on, by: socket.id, name: rooms.get(currentRoom)?.players[socket.id]?.name || 'Someone' });
  });

  socket.on('chat', ({ text }) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const me = room.players[socket.id];
    if (!me) return;
    const t = (text || '').trim().slice(0, 200);
    if (!t) return;
    const msg = { name: me.name, color: me.color, emoji: me.emoji, text: t, t: Date.now() };
    room.chat.push(msg);
    if (room.chat.length > 50) room.chat.shift();
    io.to(currentRoom).emit('chatMsg', msg);
  });

  socket.on('restart', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    if (room.hostId !== socket.id) return;
    room.pieces = [];
    room.started = false;
    room.finished = false;
    room.startedAt = null;
    room.hints = 0;
    room.chat.push({ system: true, text: '🔄 Back to lobby — set up a new puzzle!', t: Date.now() });
    broadcastState(room);
  });

  socket.on('disconnect', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const me = room.players[socket.id];
    delete room.players[socket.id];
    if (me) {
      room.chat.push({ system: true, text: `👋 ${me.name} left.`, t: Date.now() });
    }
    if (Object.keys(room.players).length === 0) {
      rooms.delete(currentRoom);
      console.log(`[cleanup] room ${currentRoom} removed`);
    } else {
      // If host left, migrate host
      if (room.hostId === socket.id) {
        room.hostId = Object.keys(room.players)[0];
        room.chat.push({ system: true, text: `👑 ${room.players[room.hostId].name} is now the host.`, t: Date.now() });
      }
      if (room.started && !room.finished) {
        // keep game going
      }
      broadcastState(room);
    }
    currentRoom = null;
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🧩 Jigsaw Together running on http://0.0.0.0:${PORT}`);
});
