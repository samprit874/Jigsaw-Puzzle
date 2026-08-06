// Full client-in-browser simulation: loads the REAL client script into jsdom,
// connects to the REAL server, and plays the game with simulated pointer drags.
// Verifies: (1) pieces snap on drop, (2) the win modal + award stats appear when
// the puzzle is completed, (3) the mid-drag overshoot deadlock is gone.
const { JSDOM } = require('jsdom');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PORT = 4997;
const URL = `http://127.0.0.1:${PORT}`;

const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stdout.on('data', () => {});
srv.stderr.on('data', () => {});

const sleep = ms => new Promise(r => setTimeout(r, ms));
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

// ---------- jsdom setup ----------
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

const dom = new JSDOM(html, {
  url: URL + '/',
  pretendToBeVisual: true,
  runScripts: 'outside-only',
});
const { window } = dom;
const { document } = window;

// ---- deterministic layout: canvas area 1200x800 ----
const RECT = { left: 0, top: 0, width: 1200, height: 800, right: 1200, bottom: 800 };
window.Element.prototype.getBoundingClientRect = function () { return { ...RECT }; };

// ---- Path2D stub with real point-in-path sampling ----
class Path2DStub {
  constructor() { this.segs = []; }
  moveTo(x, y) { this.segs.push(['M', x, y]); }
  lineTo(x, y) { this.segs.push(['L', x, y]); }
  bezierCurveTo(c1x, c1y, c2x, c2y, x, y) { this.segs.push(['C', c1x, c1y, c2x, c2y, x, y]); }
  closePath() { this.segs.push(['Z']); }
  _polygon() {
    const pts = [];
    for (const s of this.segs) {
      if (s[0] === 'M') { pts.push([s[1], s[2]]); }
      else if (s[0] === 'L') { pts.push([s[1], s[2]]); }
      else if (s[0] === 'C') {
        const [p0x, p0y] = pts[pts.length - 1];
        const [c1x, c1y, c2x, c2y, p1x, p1y] = s.slice(1);
        for (let i = 1; i <= 24; i++) {
          const t = i / 24, u = 1 - t;
          pts.push([u*u*u*p0x + 3*u*u*t*c1x + 3*u*t*t*c2x + t*t*t*p1x,
                    u*u*u*p0y + 3*u*u*t*c1y + 3*u*t*t*c2y + t*t*t*p1y]);
        }
      }
    }
    return pts;
  }
  isPointInPath(x, y) {
    const poly = this._polygon();
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
}
window.Path2D = Path2DStub;

// ---- 2D context stub: everything no-ops, toDataURL returns a fake jpeg ----
function makeCtx() {
  const gradient = { addColorStop() {} };
  return new Proxy({}, {
    get(t, k) {
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => gradient;
      if (k === 'toDataURL') return () => 'data:image/jpeg;base64,AAAA';
      if (k === 'measureText') return () => ({ width: 10 });
      if (k === 'canvas') return {};
      if (k === 'isPointInPath') return (p, x, y) => (p && p.isPointInPath) ? p.isPointInPath(x, y) : false;
      return () => {};
    },
    set() { return true; },
  });
}
window.HTMLCanvasElement.prototype.getContext = function () { this._ctx2d = makeCtx(); return this._ctx2d; };
window.HTMLCanvasElement.prototype.toDataURL = function () { return 'data:image/jpeg;base64,AAAA'; };
window.HTMLCanvasElement.prototype.setPointerCapture = function () {};
window.HTMLCanvasElement.prototype.releasePointerCapture = function () {};

// ---- Image stub: fires onload immediately with a fixed size ----
class FakeImage {
  constructor() { this.width = 480; this.height = 480; }
  set src(v) { this._src = v; queueMicrotask(() => this.onload && this.onload()); }
  get src() { return this._src; }
}
window.Image = FakeImage;

// ---- fetch stub (guest image path) ----
window.fetch = () => Promise.resolve({ ok: true, text: () => Promise.resolve('data:image/jpeg;base64,AAAA') });
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };

// ---- io: connect to the real server ----
const io = require('socket.io-client');
window.io = (opts) => io(URL, opts);

// ---- run the REAL client script ----
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1] + ';window.__state=state;window.__tabs=tabs;';
window.eval(script);

const $ = sel => document.querySelector(sel);

// Replicate fitView math so we can convert world <-> screen
const BOARD_W = 1000, BOARD_H = 1000, TRAY_W = 380;
function view() {
  const scale = Math.min(1200 / (BOARD_W + TRAY_W), 800 / BOARD_H) * 0.94;
  return {
    scale,
    offsetX: (1200 - (BOARD_W + TRAY_W) * scale) / 2,
    offsetY: (800 - BOARD_H * scale) / 2,
  };
}
function w2s(x, y) { const v = view(); return { x: x * v.scale + v.offsetX, y: y * v.scale + v.offsetY }; }

// ---- pointer event dispatcher (jsdom has no PointerEvent) ----
function pointer(el, type, x, y, id = 1) {
  const e = new window.Event(type, { bubbles: true, cancelable: true });
  e.clientX = x; e.clientY = y; e.pointerId = id; e.button = 0; e.preventDefault = () => {};
  el.dispatchEvent(e);
}

const canvas = $('#board');

// Drag from world (wx,wy) to world (tx,ty).
async function drag(wx, wy, tx, ty) {
  const s = w2s(wx, wy), t = w2s(tx, ty);
  pointer(canvas, 'pointerdown', s.x, s.y);
  await sleep(25);
  const steps = 6;
  for (let i = 1; i <= steps; i++) {
    const px = s.x + (t.x - s.x) * i / steps, py = s.y + (t.y - s.y) * i / steps;
    pointer(canvas, 'pointermove', px, py);
    await sleep(10);
  }
  pointer(canvas, 'pointerup', t.x, t.y);
  await sleep(150);
}

async function main() {
  await waitPort();

  const ghost = io(URL, { transports: ['websocket'], reconnection: false });
  await new Promise((res, rej) => { ghost.on('connect', res); ghost.on('connect_error', rej); });

  // Live tracker: positions via pieceMove, slots via the started state snapshot
  const pos = new Map();     // id -> {x,y,z,placed}
  const slots = new Map();   // id -> {r,c}
  ghost.on('pieceMove', m => pos.set(m.id, { x: m.x, y: m.y, z: m.z, placed: m.placed }));
  ghost.on('state', st => {
    if (st.pieces) {
      st.pieces.forEach(p => pos.set(p.id, { x: p.x, y: p.y, z: p.z, placed: p.placed }));
      if (st.pieces.length) st.pieces.forEach(p => slots.set(p.id, p.slot));
    }
  });

  // host: create room
  $('#hostName').value = 'Tester';
  $('#createBtn').click();
  for (let i = 0; i < 50 && $('#roomCode').textContent === 'ABCDE'; i++) await sleep(100);
  const code = $('#roomCode').textContent;
  console.log('room code:', code);

  const joinRes = await new Promise(res => { ghost.emit('joinRoom', { code, name: 'Ghost' }, res); setTimeout(() => res({ timeout: true }), 4000); });
  console.log('ghost join:', joinRes.ok ? 'ok' : JSON.stringify(joinRes));
  await sleep(200);

  // host sets 3x3 and starts
  const diffOpts = document.querySelectorAll('#diffPick2 .opt');
  [...diffOpts].find(o => o.dataset.n === '3').click();
  await sleep(150);
  for (let i = 0; i < 50 && $('#startBtn').disabled; i++) await sleep(100);
  $('#startBtn').click();
  await sleep(1500);

  console.log('game started:', $('#gameWrap').classList.contains('active'));
  if (!slots.size || !pos.size) { console.log('FAIL: no pieces tracked'); process.exit(2); }
  const n = 3, pw = BOARD_W / n;
  const slotXY = id => { const s = slots.get(id); return { x: s.c * pw, y: s.r * pw }; };

  // ---- adaptive play: always grab the TOPMOST unplaced piece (guaranteed hit
  // at its center), drag it to its own slot; refresh positions each round ----
  let guard = 0;
  while (guard++ < 50) {
    const unplaced = [...pos.entries()].filter(([, p]) => !p.placed).sort((a, b) => b[1].z - a[1].z);
    if (!unplaced.length) break;
    const [id, p] = unplaced[0];
    const sxy = slotXY(id);
    await drag(p.x + pw / 2, p.y + pw / 2, sxy.x + pw / 2, sxy.y + pw / 2);
    const placedNow = [...pos.values()].filter(q => q.placed).length;
    console.log(`placed: ${placedNow}/${pos.size}`);
    if (placedNow === pos.size) break;
  }
  await sleep(300);
  console.log('progress bar:', $('#progress').textContent);

  if (![...pos.values()].every(q => q.placed)) { console.log('FAIL: puzzle not completed'); process.exit(2); }
  console.log('win modal after completing:', $('#winModal').classList.contains('show'));

  // ---- deadlock replay: take one piece off, then do the sloppy final drop ----
  const [offId, offP] = [...pos.entries()].find(([, q]) => q.placed);
  const offSlot = slotXY(offId);
  await drag(offSlot.x + pw / 2, offSlot.y + pw / 2, 1200, 300); // drag it back to tray
  await sleep(200);
  console.log('after removing one piece — progress:', $('#progress').textContent);

  // sloppy final drop: mid-drag over slot center, release outside the snap zone
  const [lastId, lastP] = [...pos.entries()].find(([, q]) => !q.placed);
  const lastSlot = slotXY(lastId);
  const s = w2s(lastP.x + pw / 2, lastP.y + pw / 2);
  const t = w2s(lastSlot.x + pw / 2, lastSlot.y + pw / 2);
  pointer(canvas, 'pointerdown', s.x, s.y);
  await sleep(25);
  pointer(canvas, 'pointermove', t.x, t.y);               // passes over slot center
  await sleep(40);
  // release OUTSIDE the snap zone: pointer world = slot + 0.6*pw + pw/2 (center
  // offset) so the piece's top-left ends up 0.6*pw away from the slot origin
  const out = w2s(lastSlot.x + pw * 1.1, lastSlot.y + pw * 1.1);
  pointer(canvas, 'pointermove', out.x, out.y);
  await sleep(10);
  pointer(canvas, 'pointerup', out.x, out.y);
  await sleep(400);
  console.log('after sloppy drop — progress:', $('#progress').textContent,
              '| win modal:', $('#winModal').classList.contains('show'));

  // proper final drop
  const [fId, fP] = [...pos.entries()].find(([, q]) => !q.placed);
  const fSlot = slotXY(fId);
  await drag(fP.x + pw / 2, fP.y + pw / 2, fSlot.x + pw / 2, fSlot.y + pw / 2);
  await sleep(600);

  const winShown = $('#winModal').classList.contains('show');
  const progressAfter = $('#progress').textContent;
  const statsHtml = $('#winStats').innerHTML;
  const confettiCount = [...document.body.children].filter(c => c.style && /z-index:\s*200/.test(c.style.cssText)).length;
  console.log('FINAL progress:', progressAfter);
  console.log('win modal shown:', winShown);
  console.log('win stats contain "Tester":', statsHtml.includes('Tester'));
  console.log('confetti pieces spawned:', confettiCount);
  console.log('trophy in modal:', !!$('#winModal .trophy'));

  const pass = winShown && progressAfter === '9/9' && statsHtml.includes('Tester') && confettiCount > 0;
  console.log(pass ? '\nALL CLIENT TESTS PASS ✔' : '\nCLIENT TEST FAILURE ✘');

  ghost.close();
  srv.kill();
  process.exit(pass ? 0 : 1);
}

main().catch(e => { console.error('HARNESS ERROR:', e); srv.kill(); process.exit(2); });
setTimeout(() => { console.error('HARNESS TIMEOUT'); srv.kill(); process.exit(2); }, 90000);
