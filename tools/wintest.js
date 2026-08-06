// End-to-end test of the win flow: simulate a host + guest placing every piece.
// Spawns the real server on a test port and drives it over socket.io.
const { spawn } = require('child_process');
const path = require('path');

const PORT = 4999;
const URL = `http://127.0.0.1:${PORT}`;

const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
srv.stdout.on('data', d => logs += d);
srv.stderr.on('data', d => logs += d);

function waitPort(t = 5000) {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    (function tryOnce() {
      const net = require('net');
      const s = net.connect(PORT, '127.0.0.1');
      s.on('connect', () => { s.destroy(); res(); });
      s.on('error', () => { s.destroy(); if (Date.now() - t0 > t) rej(new Error('server not up')); else setTimeout(tryOnce, 120); });
    })();
  });
}

const io = require('socket.io-client');
function connect() {
  return new Promise((res, rej) => {
    const c = io(URL, { transports: ['websocket'], reconnection: false, timeout: 3000 });
    c.on('connect', () => res(c));
    c.on('connect_error', rej);
  });
}
const once = (c, ev, timeout = 5000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`timeout waiting for ${ev}`)), timeout);
  c.once(ev, (...a) => { clearTimeout(t); res(a); });
});

async function main() {
  await waitPort();
  const host = await connect();
  const guest = await connect();

  // host creates room (server acks)
  const room = await new Promise(res => host.emit('createRoom', r => res(r)));
  const code = room.code;
  console.log('room code:', code);

  // Collect every state snapshot the host receives
  const states = [];
  host.on('state', s => states.push(s));

  // host sets image + difficulty
  host.emit('setImage', { dataUrl: 'data:image/jpeg;base64,AAAA', w: 480, h: 480 });
  host.emit('setDifficulty', { n: 3 });

  // guest joins first (as in real usage), then host starts
  const guestJoin = await new Promise(res => guest.emit('joinRoom', { code, name: 'Guest' }, r => res(r)));
  console.log('guest join ok:', guestJoin.ok);
  host.emit('startGame');
  await new Promise(r => setTimeout(r, 400));

  // Get piece slots from the latest state snapshot
  const stateEv = states[states.length - 1];
  const pieces = stateEv.pieces;
  const n = 3, W = 1000, pw = W / n;
  console.log('pieces:', pieces.length, 'started:', stateEv.started);

  // Watch for pieceMove events
  let lastFinished = false;
  let placedCounts = [];
  const moveEvents = [];
  const watcher = ev => {
    moveEvents.push(ev);
    placedCounts.push(ev.placedCount);
    if (ev.finished) lastFinished = true;
  };
  host.on('pieceMove', watcher);
  guest.on('pieceMove', watcher);

  // Place all pieces (as host), in a shuffled order
  const order = [...pieces].sort(() => Math.random() - 0.5);
  for (const p of order) {
    host.emit('movePiece', { id: p.id, x: p.slot.c * pw, y: p.slot.r * pw, z: p.z });
    await new Promise(r => setTimeout(r, 30));
  }
  await new Promise(r => setTimeout(r, 300));

  console.log('pieceMove events received by host:', moveEvents.length);
  console.log('placedCounts:', [...new Set(placedCounts)].join(','));
  console.log('lastFinished (host view):', lastFinished);
  console.log('RESULT:', lastFinished ? 'PASS — finished=true was emitted' : 'FAIL — finished never became true');
  const fin = moveEvents.find(e => e.finished);
  console.log('finished event: placedCount=' + (fin && fin.placedCount), 'finished=' + (fin && fin.finished));

  host.close(); guest.close();
  srv.kill();
  process.exit(lastFinished ? 0 : 1);
}

main().catch(e => { console.error('TEST ERROR:', e.message); console.error(logs.slice(-2000)); srv.kill(); process.exit(2); });
