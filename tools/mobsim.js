// MOBILE-client simulation: loads the REAL client into jsdom with a phone-sized
// portrait viewport (bottom tray strip) and hammers the exact bugs that broke
// pieces movement & table behaviour on mobile browsers:
//   1. tray tiles all fit INSIDE the strip (old code spilled pieces out of it)
//   2. grabbing a tray tile does not teleport the piece (old "fold" mapping bug)
//   3. tile → slot drag places the piece; strip drop tucks it back into the tray
//   4. pinch zoom: no table jump — the world point under the fingers stays put;
//      zoom clamps are relative to the fit scale (old floor was above phone fit)
//   5. second finger mid-drag cancels the drag cleanly (old: phantom drops)
//   6. URL-bar resize preserves the view (old: reset pan/zoom on every resize)
//   7. rotation flips tray mode and re-fits
//   8. pan is clamped — the table can't be flung into the void; double-tap resets
//   9. piece drops are clamped — pieces can't be lost off the table
//  10. full solve via tray drags shows the win modal
const { sleep, waitPort, startServer, launch } = require('./harness');

const { srv, port, url } = startServer();
const stop = code => { try { srv.kill(); } catch (_) {} process.exit(code); };

const RECT = { left: 0, top: 0, width: 390, height: 720, right: 390, bottom: 720 };
let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? '  ✔' : '  ✘ FAIL'} ${name}${extra ? '  [' + extra + ']' : ''}`);
  if (!cond) failures++;
}

async function main() {
  await waitPort(port);
  const H = launch(url, RECT);
  const { window, document, pointer, w2s, s2w } = H;
  const $ = sel => document.querySelector(sel);
  const state = () => window.__state;
  const DIFF = Math.max(3, Math.min(6, parseInt(process.env.MOB_DIFF || '3')));
  const n0 = DIFF, pw = 1000 / n0, TOTAL = n0 * n0;

  // --- create a room through the REAL UI, start at chosen difficulty ---
  console.log(`scenario: ${n0}x${n0} (${TOTAL} pieces), viewport ${RECT.width}x${RECT.height}`);
  $('#hostName').value = 'MobileTester';
  $('#createBtn').click();
  for (let i = 0; i < 60 && $('#roomCode').textContent === 'ABCDE'; i++) await sleep(100);
  [...document.querySelectorAll('#diffPick2 .opt')].find(o => o.dataset.n === String(n0)).click();
  // host uploads a photo (lobby now asks for an upload after create)
  window.__api.socket.emit('setImage', { dataUrl: 'data:image/jpeg;base64,AAAA', w: 480, h: 480 });
  await sleep(150);
  for (let i = 0; i < 60 && $('#startBtn').disabled; i++) await sleep(100);
  $('#startBtn').click();
  await sleep(1500);

  check('game started', $('#gameWrap').classList.contains('active'));
  check('portrait → vertical tray mode', state().trayVertical === true);
  check('tray strip height set', state().trayH >= ({3:180,4:220,5:260,6:300})[n0], `trayH=${state().trayH}`);
  check('pieces present', state().pieces.length === TOTAL);

  // --- 1. tray tiles stay inside the strip ---
  let tray = window.__api.tray();
  check(`all ${TOTAL} loose pieces offered as tray tiles`, tray.size === TOTAL, `tiles=${tray.size}`);
  let tilesInside = true;
  for (const [id, t] of tray) {
    const inside = t.x >= 0 && t.x + pw * t.s <= 1000 &&
                   t.y >= 1000 && t.y + pw * t.s <= 1000 + state().trayH;
    if (!inside) { tilesInside = false; console.log('    tile outside strip:', id, JSON.stringify(t)); }
  }
  check('every tray tile fully inside the strip', tilesInside);

  // drag helper operating in SCREEN px
  async function dragScreen(sx, sy, tx, ty, id = 3, steps = 8) {
    pointer('pointerdown', sx, sy, id);
    await sleep(25);
    for (let i = 1; i <= steps; i++) {
      pointer('pointermove', sx + (tx - sx) * i / steps, sy + (ty - sy) * i / steps, id);
      await sleep(12);
    }
    pointer('pointerup', tx, ty, id);
    await sleep(120);
  }

  // --- 2+3. grab top tile: no teleport on grab; drag to slot places it ---
  tray = window.__api.tray();
  const [firstId, firstTile] = [...tray.entries()][0];
  const tileCenterWorld = { x: firstTile.x + pw * firstTile.s / 2, y: firstTile.y + pw * firstTile.s / 2 };
  const grabScreen = w2s(tileCenterWorld.x, tileCenterWorld.y);
  pointer('pointerdown', grabScreen.x, grabScreen.y, 3);
  await sleep(30);
  check('grab starts a drag', state().dragging && state().dragging.id === firstId);
  // tiny move — then the piece CENTER must sit right under the finger
  pointer('pointermove', grabScreen.x + 34, grabScreen.y - 46, 3);
  await sleep(30);
  const pNow = state().pieces.find(p => p.id === firstId);
  const centerScreen = w2s(pNow.x + pw / 2, pNow.y + pw / 2);
  const jumpDist = Math.hypot(centerScreen.x - (grabScreen.x + 34), centerScreen.y - (grabScreen.y - 46));
  check('piece follows the finger (no teleport on tray grab)', jumpDist < 3, `off by ${jumpDist.toFixed(1)}px`);
  // finish the drag onto its own slot
  const slot = state().pieces.find(p => p.id === firstId).slot;
  const slotCenter = w2s(slot.c * pw + pw / 2, slot.r * pw + pw / 2);
  for (let i = 2; i <= 8; i++) {
    pointer('pointermove', grabScreen.x + 34 + (slotCenter.x - grabScreen.x - 34) * i / 8,
                          grabScreen.y - 46 + (slotCenter.y - grabScreen.y + 46) * i / 8, 3);
    await sleep(12);
  }
  pointer('pointerup', slotCenter.x, slotCenter.y, 3);
  await sleep(250);
  check('tile→slot drag places the piece', state().pieces.find(p => p.id === firstId).placed === true);
  check('progress updated', $('#progress').textContent.startsWith('1/'));

  // --- 4. pinch zoom: anchored, clamped ---
  const midA = { x: 160, y: 260 }, midB = { x: 240, y: 260 };
  pointer('pointerdown', midA.x, midA.y, 11);
  await sleep(15);
  pointer('pointerdown', midB.x, midB.y, 12);
  await sleep(20);
  check('second finger starts pinch', window.__api.isPinch() === true);
  const scaleBefore = state().scale;
  const anchorWorld = s2w((midA.x + midB.x) / 2, (midA.y + midB.y) / 2);
  pointer('pointermove', midA.x - 34, midA.y, 11);
  pointer('pointermove', midB.x + 34, midB.y, 12);
  await sleep(40);
  const scaleAfter = state().scale;
  const midNow = { x: (midA.x - 34 + midB.x + 34) / 2, y: 260 };
  const anchorNow = s2w(midNow.x, midNow.y);
  const anchorErr = Math.hypot(anchorNow.x - anchorWorld.x, anchorNow.y - anchorWorld.y);
  check('pinch zooms in', scaleAfter > scaleBefore * 1.2, `x${(scaleAfter / scaleBefore).toFixed(2)}`);
  check('pinch does not make the table jump', anchorErr < 2, `anchor drift ${anchorErr.toFixed(2)} world units`);
  // pinch way out (fingers nearly together) → clamped at the fit-relative floor
  pointer('pointermove', 192, 260, 11);
  pointer('pointermove', 208, 260, 12);
  await sleep(40);
  const expectedMin = state().minScale;
  console.log(`  · pinch-out reached scale ${state().scale.toFixed(3)} (floor ${expectedMin.toFixed(3)}, fit ${state().fitScale.toFixed(3)})`);
  check('zoom-out clamps at fit-relative floor', Math.abs(state().scale - expectedMin) < 0.01 && expectedMin > 0.05 && expectedMin < state().fitScale);
  pointer('pointerup', 192, 260, 11);
  pointer('pointerup', 208, 260, 12);
  await sleep(60);
  check('pinch ends cleanly', !window.__api.isPinch() && state().dragging === null && window.__api.pointerCount() === 0);

  // --- 5. second finger mid-drag cancels the drag, piece reverts ---
  tray = window.__api.tray();
  const [cId, cTile] = [...tray.entries()][0];
  const cBefore = state().pieces.find(p => p.id === cId);
  const cStart = { x: cBefore.x, y: cBefore.y, placed: cBefore.placed };
  const cGrab = w2s(cTile.x + pw * cTile.s / 2, cTile.y + pw * cTile.s / 2);
  pointer('pointerdown', cGrab.x, cGrab.y, 21);
  await sleep(25);
  pointer('pointermove', cGrab.x + 60, cGrab.y - 80, 21);   // dragging away
  await sleep(25);
  check('drag in progress', state().dragging && state().dragging.id === cId);
  pointer('pointerdown', 200, 300, 22);                      // second finger!
  await sleep(40);
  const cAfter = state().pieces.find(p => p.id === cId);
  check('second finger cancels the drag', state().dragging === null);
  check('cancelled piece reverted to its tray spot',
        Math.abs(cAfter.x - cStart.x) < 2 && Math.abs(cAfter.y - cStart.y) < 2 && cAfter.placed === cStart.placed,
        `(${cAfter.x.toFixed(0)},${cAfter.y.toFixed(0)}) vs (${cStart.x.toFixed(0)},${cStart.y.toFixed(0)})`);
  pointer('pointerup', 200, 300, 22);
  pointer('pointerup', cGrab.x + 60, cGrab.y - 80, 21);
  await sleep(40);
  check('all fingers released', window.__api.pointerCount() === 0);

  // --- 6. URL-bar resize preserves pan/zoom (no reset) ---
  const sPre = state().scale, oxPre = state().offsetX;
  RECT.height = 620; RECT.bottom = 620;
  window.dispatchEvent(new window.Event('resize'));
  await sleep(120);
  check('URL-bar resize keeps the zoom', Math.abs(state().scale - sPre) < 1e-9,
        `scale ${sPre.toFixed(3)} → ${state().scale.toFixed(3)}`);
  check('URL-bar resize keeps proportional offsets', Math.abs(state().offsetX - oxPre * (RECT.width / 390)) < 30);
  RECT.height = 720; RECT.bottom = 720;
  window.dispatchEvent(new window.Event('resize'));
  await sleep(120);

  // --- 7. rotation flips tray mode ---
  RECT.width = 800; RECT.height = 390; RECT.right = 800; RECT.bottom = 390;
  window.dispatchEvent(new window.Event('resize'));
  await sleep(150);
  check('landscape → side tray mode', state().trayVertical === false);
  RECT.width = 390; RECT.height = 720; RECT.right = 390; RECT.bottom = 720;
  window.dispatchEvent(new window.Event('resize'));
  await sleep(150);
  check('back to portrait → bottom tray', state().trayVertical === true);

  // --- 8a. pan clamp: the table cannot be flung into the void ---
  window.__api.fitView();
  await sleep(60);
  // Find a screen point that hits NOTHING (guaranteed empty table)
  function findEmptySpot() {
    // Board gaps first, then the void (which is all that may be visible after
    // an extreme pan fling)
    for (let gy = 60; gy < 2400; gy += 70) {
      for (let gx = 60; gx < 2400; gx += 70) {
        const s = w2s(gx, gy);
        if (s.x < 8 || s.x > RECT.width - 8 || s.y < 8 || s.y > RECT.height - 8) continue;
        if (!window.__api.hit(s.x, s.y)) return s;
      }
    }
    return null;
  }
  const emptyScr = findEmptySpot();
  check('found an empty spot on the table', !!emptyScr);
  await dragScreen(emptyScr.x, emptyScr.y, emptyScr.x - 5000, emptyScr.y - 5000, 31, 4);
  const wW = 1380 * state().scale, wH = (1000 + state().trayH) * state().scale;
  check('pan clamped horizontally', state().offsetX <= 390 - 60 + 0.5 && state().offsetX >= 60 - wW - 0.5,
        `offsetX=${state().offsetX.toFixed(0)}`);
  check('pan clamped vertically', state().offsetY <= 720 - 60 + 0.5 && state().offsetY >= 60 - wH - 0.5,
        `offsetY=${state().offsetY.toFixed(0)}`);

  // --- 8b. double-tap on empty table resets the view ---
  const sFit = state().fitScale;
  const tapSpot = findEmptySpot();
  pointer('pointerdown', tapSpot.x, tapSpot.y, 33); await sleep(40);
  pointer('pointerup', tapSpot.x, tapSpot.y, 33); await sleep(60);
  pointer('pointerdown', tapSpot.x, tapSpot.y, 33); await sleep(40);
  pointer('pointerup', tapSpot.x, tapSpot.y, 33); await sleep(120);
  check('double-tap resets view', Math.abs(state().scale - sFit) < 1e-9, `scale=${state().scale.toFixed(3)} vs fit ${sFit.toFixed(3)}`);

  // --- 9. drops clamp: pieces cannot be lost off the table ---
  tray = window.__api.tray();
  const [lId, lTile] = [...tray.entries()][0];
  const lGrab = w2s(lTile.x + pw * lTile.s / 2, lTile.y + pw * lTile.s / 2);
  await dragScreen(lGrab.x, lGrab.y, -800, -900, 41, 6); // fling far off-screen
  const lost = state().pieces.find(p => p.id === lId);
  check('dropped piece clamped on the table',
        lost.x >= -pw * 0.45 - 0.5 && lost.y >= -pw * 0.45 - 0.5 && lost.x <= 1000 + 380 && lost.y <= 1000,
        `(${lost.x.toFixed(0)},${lost.y.toFixed(0)})`);

  // --- 3b. dropping back over the strip tucks the piece into the tray ---
  const putBack = state().pieces.find(p => p.id === lId);
  const pbFrom = w2s(putBack.x + pw / 2, putBack.y + pw / 2);
  const stripMid = w2s(500, 1000 + state().trayH / 2);
  await dragScreen(pbFrom.x, pbFrom.y, stripMid.x, stripMid.y, 42, 8);
  const back = state().pieces.find(p => p.id === lId);
  check('strip drop returns piece to the tray', back.x >= 1000 && !back.placed, `x=${back.x.toFixed(0)}`);
  check('piece shows up as a tray tile again', window.__api.tray().has(lId));

  // --- 10. solve the whole puzzle through the tray ---
  window.__api.fitView();
  await sleep(100);
  let guard = 0, stagnant = 0, lastPlaced = -1;
  while (guard++ < TOTAL + 20 && stagnant < 6) {
    const unplaced = state().pieces.filter(p => !p.placed);
    if (!unplaced.length) break;
    const tm = window.__api.tray();
    let target = unplaced.find(p => tm.has(p.id));
    let fromScr;
    if (target) {
      const t = tm.get(target.id);
      fromScr = w2s(t.x + pw * t.s / 2, t.y + pw * t.s / 2);
    } else {
      target = unplaced[0];
      fromScr = w2s(target.x + pw / 2, target.y + pw / 2);
    }
    const sc = w2s(target.slot.c * pw + pw / 2, target.slot.r * pw + pw / 2);
    await dragScreen(fromScr.x, fromScr.y, sc.x, sc.y, 50 + guard, 8);
    const placedNow = state().pieces.filter(p => p.placed).length;
    const ok = state().pieces.find(p => p.id === target.id).placed;
    console.log(`  · placed ${target.id}: ${ok}  (${placedNow}/${TOTAL})`);
    if (placedNow === lastPlaced) stagnant++; else { stagnant = 0; lastPlaced = placedNow; }
    if (!ok) { window.__api.fitView(); await sleep(60); } // recover view and retry
  }
  await sleep(600);
  check('puzzle solvable end-to-end on mobile layout', state().pieces.every(p => p.placed));
  check('win modal shown', $('#winModal').classList.contains('show'));
  check(`final counter ${TOTAL}/${TOTAL}`, $('#progress').textContent === `${TOTAL}/${TOTAL}`);

  console.log(failures ? `\n${failures} MOBILE CHECK(S) FAILED ✘` : '\nALL MOBILE CHECKS PASS ✔');
  stop(failures ? 1 : 0);
}

main().catch(e => { console.error('HARNESS ERROR:', e); stop(2); });
setTimeout(() => { console.error('HARNESS TIMEOUT'); stop(2); }, 120000);
