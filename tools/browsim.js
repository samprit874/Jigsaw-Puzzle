// Desktop-client simulation: loads the REAL client into jsdom (1200x800,
// landscape = side tray), connects to the REAL server, and plays the game with
// simulated pointer drags. Verifies: (1) pieces snap on drop, (2) the win modal
// + award stats + confetti appear when the puzzle is completed, (3) the mid-drag
// overshoot deadlock is gone.
//
// All world↔screen conversion reads the client's LIVE view state — the old
// harness replicated fitView() with a stale fudge factor, so its pointer
// positions missed pieces, every miss became a pan, and the view drifted until
// the whole run failed.
const { sleep, waitPort, startServer, launch, connectGhost } = require('./harness');

const { srv, port, url } = startServer();
const stop = code => { try { srv.kill(); } catch (_) {} process.exit(code); };

async function main() {
  await waitPort(port);

  // Desktop landscape viewport
  const H = launch(url, { left: 0, top: 0, width: 1200, height: 800, right: 1200, bottom: 800 });
  const { window, document, canvas, pointer, w2s } = H;
  const $ = sel => document.querySelector(sel);

  const ghost = await connectGhost(url);
  const pos = new Map();   // id -> {x,y,z,placed}
  const slots = new Map(); // id -> {r,c}
  ghost.on('pieceMove', m => pos.set(m.id, { x: m.x, y: m.y, z: m.z, placed: m.placed }));
  ghost.on('state', st => {
    if (st.pieces) {
      st.pieces.forEach(p => pos.set(p.id, { x: p.x, y: p.y, z: p.z, placed: p.placed }));
      if (st.pieces.length) st.pieces.forEach(p => slots.set(p.id, p.slot));
    }
  });

  // host: create room through the REAL UI
  $('#hostName').value = 'Tester';
  $('#createBtn').click();
  for (let i = 0; i < 60 && $('#roomCode').textContent === 'ABCDE'; i++) await sleep(100);
  const code = $('#roomCode').textContent;
  console.log('room code:', code);

  let joinRes = null;
  for (let i = 0; i < 3 && !(joinRes && joinRes.ok); i++) {
    joinRes = await new Promise(res => { ghost.emit('joinRoom', { code, name: 'Ghost' }, res); setTimeout(() => res({ timeout: true }), 3000); });
    if (!(joinRes && joinRes.ok)) await sleep(400);
  }
  console.log('ghost join:', joinRes && joinRes.ok ? 'ok' : JSON.stringify(joinRes));
  await sleep(200);

  // host sets 3x3, uploads a photo (lobby now asks for an upload after create)
  [...document.querySelectorAll('#diffPick2 .opt')].find(o => o.dataset.n === '3').click();
  window.__api.socket.emit('setImage', { dataUrl: 'data:image/jpeg;base64,AAAA', w: 480, h: 480 });
  await sleep(150);
  for (let i = 0; i < 60 && $('#startBtn').disabled; i++) await sleep(100);
  $('#startBtn').click();
  await sleep(1500);

  console.log('game started:', $('#gameWrap').classList.contains('active'));
  if (!slots.size || !pos.size) { console.log('FAIL: no pieces tracked'); stop(2); }
  const n = 3, pw = 1000 / n;
  const slotXY = id => { const s = slots.get(id); return { x: s.c * pw, y: s.r * pw }; };

  // Drag from world (wx,wy) to world (tx,ty) using the live view mapping
  async function drag(wx, wy, tx, ty) {
    const s = w2s(wx, wy), t = w2s(tx, ty);
    pointer('pointerdown', s.x, s.y);
    await sleep(25);
    const steps = 6;
    for (let i = 1; i <= steps; i++) {
      pointer('pointermove', s.x + (t.x - s.x) * i / steps, s.y + (t.y - s.y) * i / steps);
      await sleep(10);
    }
    pointer('pointerup', t.x, t.y);
    await sleep(150);
  }

  // ---- adaptive play: grab the TOPMOST unplaced piece, drag to its own slot ----
  let guard = 0;
  while (guard++ < 50) {
    const unplaced = [...pos.entries()].filter(([, p]) => !p.placed).sort((a, b) => b[1].z - a[1].z);
    if (!unplaced.length) break;
    const [id, p] = unplaced[0];
    const sxy = slotXY(id);
    await drag(p.x + pw / 2, p.y + pw / 2, sxy.x + pw / 2, sxy.y + pw / 2);
    console.log(`placed: ${[...pos.values()].filter(q => q.placed).length}/${pos.size}`);
    if ([...pos.values()].every(q => q.placed)) break;
  }
  await sleep(300);
  console.log('progress bar:', $('#progress').textContent);
  if (![...pos.values()].every(q => q.placed)) { console.log('FAIL: puzzle not completed'); stop(2); }
  console.log('win modal after completing:', $('#winModal').classList.contains('show'));

  // ---- deadlock replay: take one piece off, then do the sloppy final drop ----
  const [offId] = [...pos.entries()].find(([, q]) => q.placed);
  const offSlot = slotXY(offId);
  await drag(offSlot.x + pw / 2, offSlot.y + pw / 2, 1200, 300);
  await sleep(200);
  console.log('after removing one piece — progress:', $('#progress').textContent,
              '| win modal hidden:', !$('#winModal').classList.contains('show'));

  // sloppy final drop: mid-drag over slot center, release outside the snap zone
  const [lastId, lastP] = [...pos.entries()].find(([, q]) => !q.placed);
  const lastSlot = slotXY(lastId);
  const s = w2s(lastP.x + pw / 2, lastP.y + pw / 2);
  const t = w2s(lastSlot.x + pw / 2, lastSlot.y + pw / 2);
  pointer('pointerdown', s.x, s.y);
  await sleep(25);
  pointer('pointermove', t.x, t.y);   // passes over slot center mid-drag
  await sleep(40);
  const out = w2s(lastSlot.x + pw * 1.1, lastSlot.y + pw * 1.1);
  pointer('pointermove', out.x, out.y);
  await sleep(10);
  pointer('pointerup', out.x, out.y); // release outside snap zone
  await sleep(400);
  console.log('after sloppy drop — progress:', $('#progress').textContent,
              '| win modal (must be hidden):', $('#winModal').classList.contains('show'));

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

  const pass = winShown && progressAfter === '9/9' && statsHtml.includes('Tester') && confettiCount > 0;
  console.log(pass ? '\nALL CLIENT TESTS PASS ✔' : '\nCLIENT TEST FAILURE ✘');
  ghost.close();
  stop(pass ? 0 : 1);
}

main().catch(e => { console.error('HARNESS ERROR:', e); stop(2); });
setTimeout(() => { console.error('HARNESS TIMEOUT'); stop(2); }, 90000);
