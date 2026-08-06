// Shared test harness: loads the REAL client script into jsdom against the REAL
// server on a unique per-process port. Provides a mutable layout rect (to fake
// phone/desktop viewports), a Path2D stub with true point-in-path sampling, a
// pointer-event dispatcher, and live world↔screen conversion read straight from
// the client's own view state (so tests can never drift from the client's math).
const { JSDOM } = require('jsdom');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function waitPort(port, t = 8000) {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    (function tryOnce() {
      const s = net.connect(port, '127.0.0.1');
      s.on('connect', () => { s.destroy(); res(); });
      s.on('error', () => { s.destroy(); if (Date.now() - t0 > t) rej(new Error('server not up')); else setTimeout(tryOnce, 120); });
    })();
  });
}

function startServer() {
  const port = 4400 + (process.pid % 500) + Math.floor(Math.random() * 40);
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stop = () => { try { srv.kill(); } catch (_) {} };
  process.on('exit', stop);
  return { srv, port, url: `http://127.0.0.1:${port}` };
}

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
      if (s[0] === 'M' || s[0] === 'L') pts.push([s[1], s[2]]);
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

// Launches jsdom + the real client. rect is MUTATED by callers to simulate
// rotation/resizes; call window.dispatchEvent(new window.Event('resize')) after.
function launch(url, rect, exposeExtra = '') {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const dom = new JSDOM(html, { url: url + '/', pretendToBeVisual: true, runScripts: 'outside-only' });
  const { window } = dom;
  const { document } = window;

  window.Element.prototype.getBoundingClientRect = function () { return { ...rect }; };
  window.Path2D = Path2DStub;
  window.HTMLCanvasElement.prototype.getContext = function () { this._ctx2d = this._ctx2d || makeCtx(); return this._ctx2d; };
  window.HTMLCanvasElement.prototype.toDataURL = function () { return 'data:image/jpeg;base64,AAAA'; };
  window.HTMLCanvasElement.prototype.setPointerCapture = function () {};
  window.HTMLCanvasElement.prototype.releasePointerCapture = function () {};
  class FakeImage {
    constructor() { this.width = 480; this.height = 480; }
    set src(v) { this._src = v; queueMicrotask(() => this.onload && this.onload()); }
    get src() { return this._src; }
  }
  window.Image = FakeImage;
  window.fetch = () => Promise.resolve({ ok: true, text: () => Promise.resolve('data:image/jpeg;base64,AAAA') });
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };

  const io = require('socket.io-client');
  window.io = (opts) => io(url, opts);

  const expose = ';window.__state=state;window.__tabs=tabs;window.__api={hit:hitPiece,tray:computeTrayLayout,w2s,s2w,fitView,clampPan,isPinch:()=>!!pinch,pointerCount:()=>pointers.size};'
    + exposeExtra;
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1] + expose;
  window.eval(script);

  const canvas = document.querySelector('#board');
  function pointer(type, x, y, id = 1, button = 0) {
    const e = new window.Event(type, { bubbles: true, cancelable: true });
    e.clientX = x; e.clientY = y; e.pointerId = id; e.button = button;
    canvas.dispatchEvent(e);
  }
  // Live world→screen read from the client's own view state — cannot drift.
  function w2s(x, y) { const st = window.__state; return { x: x * st.scale + st.offsetX, y: y * st.scale + st.offsetY }; }
  function s2w(x, y) { const st = window.__state; return { x: (x - st.offsetX) / st.scale, y: (y - st.offsetY) / st.scale }; }

  return { window, document, canvas, pointer, w2s, s2w, dom };
}

async function connectGhost(url) {
  const io = require('socket.io-client');
  const ghost = io(url, { transports: ['websocket'], reconnection: false });
  await new Promise((res, rej) => { ghost.on('connect', res); ghost.on('connect_error', rej); setTimeout(() => rej(new Error('ghost connect timeout')), 6000); });
  return ghost;
}

module.exports = { sleep, waitPort, startServer, launch, connectGhost };
