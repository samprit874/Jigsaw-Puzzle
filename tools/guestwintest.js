// Guest-side win popup check: the guest sees the "host is setting up" note
// (no host buttons), can close with ✕, and gets swept into the next session
// when the host starts a new game with another photo.
const { sleep, waitPort, startServer, launch, connectGhost } = require('./harness');

const { srv, port, url } = startServer();
const stop = code => { try { srv.kill(); } catch (_) {} process.exit(code); };

const RECT = { left: 0, top: 0, width: 390, height: 720, right: 390, bottom: 720 };
let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '  ✔' : '  ✘ FAIL'} ${name}${extra ? '  [' + extra + ']' : ''}`);
  if (!cond) failures++;
};

async function main() {
  await waitPort(port);
  const H = launch(url, RECT);
  const { window, document } = H;
  const $ = sel => document.querySelector(sel);
  const state = () => window.__state;
  // The DOM client plays the GUEST here; a raw socket plays the host.
  const hostSock = await connectGhost(url);

  const room = await new Promise(res => hostSock.emit('createRoom', r => res(r)));
  const code = room.code;
  console.log('room code:', code);

  // DOM client joins through the REAL join UI
  $('#joinName').value = 'GuestG';
  $('#joinCode').value = code;
  $('#joinBtn').click();
  for (let i = 0; i < 60 && !state().inRoom; i++) await sleep(100);
  check('guest joined the room', state().inRoom === true);

  hostSock.emit('setImage', { dataUrl: 'data:image/jpeg;base64,AAAA', w: 480, h: 480 });
  hostSock.emit('setDifficulty', { n: 3 });
  await sleep(150);
  hostSock.emit('startGame');
  await sleep(1500);

  check('guest sees the game', $('#gameWrap').classList.contains('active'));
  check('guest is NOT host', state().isHost === false);

  // Host solves the whole puzzle via socket
  const n = 3, pw = 1000 / n;
  const pieces = state().pieces;
  const order = [...pieces].sort(() => Math.random() - 0.5);
  for (const p of order) {
    hostSock.emit('movePiece', { id: p.id, x: p.slot.c * pw, y: p.slot.r * pw, z: p.z });
    await sleep(30);
  }
  await sleep(600);

  check('guest sees the win modal', $('#winModal').classList.contains('show'));
  check('guest does NOT see the host start buttons', $('#playAgainBtn').style.display === 'none' && $('#newPhotoBtn').style.display === 'none');
  check('guest sees the host-setup wait note', !$('#winGuestWait').classList.contains('hidden'));

  $('#winClose').click();
  await sleep(100);
  check('guest can close with the cross', !$('#winModal').classList.contains('show'));

  // Guest sends a chat message after closing — should still work (still in room)
  window.__api.socket.emit('chat', { text: 'gg everyone!' });
  await sleep(300);
  const chatHas = [...document.querySelectorAll('#chatBox .msg')].some(m => m.textContent.includes('gg everyone!'));
  check('guest can still chat after closing the popup', chatHas);

  // Host starts a new session with ANOTHER photo; guest should be swept along
  hostSock.emit('newGameWithImage', { dataUrl: 'data:image/jpeg;base64,CCCC', w: 800, h: 600 });
  await sleep(700);
  check('guest swept into the new session', state().started === true && !state().finished);
  check('guest pieces are loose again', state().pieces.every(p => !p.placed));
  check('guest popup stays hidden', !$('#winModal').classList.contains('show'));
  check('guest board re-fit to the new aspect', Math.abs(state().boardH - 750) < 1, `boardH=${state().boardH}`);

  console.log(failures ? `\n${failures} GUEST CHECK(S) FAILED ✘` : '\nALL GUEST CHECKS PASS ✔');
  hostSock.close();
  stop(failures ? 1 : 0);
}

main().catch(e => { console.error('HARNESS ERROR:', e); stop(2); });
setTimeout(() => { console.error('HARNESS TIMEOUT'); stop(2); }, 60000);
