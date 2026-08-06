// Reproduce the "finished but nothing happens" deadlock:
// 1. Drag the last piece: a throttled mid-drag position lands INSIDE the snap zone
//    -> server snaps it, emits finished:true (the dragging client ignores that echo)
// 2. Player releases the piece OUTSIDE the snap zone (overshoot/sloppy drop)
//    -> server has room.finished=true and now ignores every further movePiece
// 3. Player drags the piece back onto its slot -> server ignores it -> no win event ever.
const { spawn } = require('child_process');
const path = require('path');

const PORT = 4998;
const URL = `http://127.0.0.1:${PORT}`;

const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stdout.on('data', () => {});
srv.stderr.on('data', () => {});

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

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  await waitPort();
  const host = await connect();
  const states = [];
  host.on('state', s => states.push(s));
  const moves = [];
  host.on('pieceMove', m => moves.push(m));

  const room = await new Promise(res => host.emit('createRoom', r => res(r)));
  host.emit('setImage', { dataUrl: 'data:image/jpeg;base64,AAAA', w: 480, h: 480 });
  host.emit('setDifficulty', { n: 3 });
  await sleep(200);
  host.emit('startGame');
  await sleep(300);

  const state = states[states.length - 1];
  const n = 3, W = 1000, pw = W / n;
  const pieces = state.pieces;
  console.log('pieces:', pieces.length);

  // Place pieces 0..7 normally (their own slot coords)
  for (const p of pieces.slice(0, 8)) {
    host.emit('movePiece', { id: p.id, x: p.slot.c * pw, y: p.slot.r * pw, z: p.z });
    await sleep(25);
  }
  await sleep(150);
  console.log('placedCount after 8 pieces:', moves[moves.length - 1].placedCount);

  // Now the LAST piece: simulate a drag that passes over the slot mid-drag,
  // then is released OUTSIDE the snap zone. (drag:true = mid-drag throttle emit)
  const last = pieces[8];
  const slotX = last.slot.c * pw, slotY = last.slot.r * pw;
  host.emit('movePiece', { id: last.id, x: slotX + 10, y: slotY + 10, z: last.z, drag: true });
  await sleep(30);
  host.emit('movePiece', { id: last.id, x: slotX + pw * 0.6, y: slotY + pw * 0.6, z: last.z, drag: true });
  await sleep(150);

  const finEvents = moves.filter(m => m.finished);
  console.log('finished:true while piece mid-drag:', finEvents.length,
              '(must be 0 — never win-check mid-drag)');
  const lastMove = moves[moves.length - 1];
  console.log('placedCount after sloppy drop:', lastMove ? lastMove.placedCount : 'n/a',
              '(must be 8 — no premature finish)');

  // Player tries again: drags the piece back exactly onto its slot (final drop)
  const before = moves.length;
  host.emit('movePiece', { id: last.id, x: slotX, y: slotY, z: last.z + 5 });
  await sleep(200);
  const afterEvents = moves.slice(before);
  const reDropFin = afterEvents.some(m => m.finished && m.placedCount === 9);
  console.log('pieceMove events after re-drop onto slot:', afterEvents.length);
  console.log('RESULT:', reDropFin
    ? 'PASS — re-drop was processed and finished:true was delivered → client shows the win'
    : 'FAIL — win never delivered');

  host.close();
  srv.kill();
  process.exit(0);
}
main().catch(e => { console.error('TEST ERROR:', e.message); srv.kill(); process.exit(2); });
