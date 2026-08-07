// CONNECTION-UI test: the reconnect messaging can never get stuck on screen.
// Regression: every connect/disconnect used to re-arm the toast's hide timer,
// so a flapping socket (drop every ~1.5s — flaky wifi, proxy killing idle
// websockets) pinned the "Back online — reconnecting…" toast up forever.
// Now: a status pill mirrors the real socket state (no hide timer to re-arm)
// and the "Back online" toast fires only after a real (>2.5s) outage.
//  Scenario A: flapping (transport killed every 1.5s) — no stuck toast, no
//              "Back online" noise for micro-flaps, pill hidden once stable.
//  Scenario B: a real 5s outage — pill shows while offline, exactly one
//              "Back online" toast afterwards, and it hides on its own.
const { sleep, waitPort, startServer, launch } = require('./harness');

const { srv, port, url } = startServer();
const stop = code => { try { srv.kill(); } catch (_) {} process.exit(code); };
const RECT = { left: 0, top: 0, width: 1280, height: 800, right: 1280, bottom: 800 };
let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '  ✔' : '  ✘ FAIL'} ${name}${extra ? '  [' + extra + ']' : ''}`);
  if (!cond) failures++;
};

async function main() {
  await waitPort(port);
  const { window, document } = launch(url, RECT);
  const toast = document.querySelector('#toast');
  const pill = document.querySelector('#connPill');
  const sock = window.__api.socket;
  const toastOn = () => toast.classList.contains('show');
  const pillOn = () => pill.classList.contains('show');

  for (let i = 0; i < 60 && !sock.connected; i++) await sleep(100);
  let backOnlineShown = 0;
  // count how often the toast text is SET to a back-online message
  Object.defineProperty(toast, 'textContent', {
    set(v) { if (/Back online/.test(v)) backOnlineShown++; this._t = v; },
    get() { return this._t || ''; },
  });

  console.log('scenario A: flapping ~9s (drop every 1.5s), then 6s stable');
  for (let k = 0; k < 6; k++) {
    await sleep(1500);
    try { sock.io.engine.transport.ws.close(4000, 'flap'); } catch (_) {}
  }
  await sleep(1500); // let the last reconnect land

  // after stability returns, everything must be quiet within ~1s
  await sleep(1000);
  check('toast hidden after flapping stops', !toastOn(), `text="${toast.textContent}"`);
  check('pill hidden once connected', !pillOn());
  await sleep(3500);
  check('toast STAYS hidden (no re-armed timer)', !toastOn(), `text="${toast.textContent}"`);
  check('no "Back online" toast during micro-flaps', backOnlineShown === 0, `shown=${backOnlineShown}x`);

  console.log('scenario B: real 5s outage');
  sock.io.reconnection(false);
  try { sock.io.engine.transport.ws.close(4000, 'outage'); } catch (_) {}
  await sleep(2000);
  check('pill visible while offline', pillOn());
  await sleep(3000); // total ~5s offline
  sock.io.reconnection(true);
  sock.connect();
  for (let i = 0; i < 60 && !sock.connected; i++) await sleep(100);
  check('pill hides when the socket returns', !pillOn());
  check('exactly one "Back online" toast after real outage', backOnlineShown === 1, `shown=${backOnlineShown}x`);
  check('back-online toast visible right after reconnect', toastOn());
  await sleep(2600);
  check('back-online toast hides on its own', !toastOn(), `text="${toast.textContent}"`);

  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
  stop(failures ? 1 : 0);
}
main().catch(e => { console.error(e); stop(1); });
