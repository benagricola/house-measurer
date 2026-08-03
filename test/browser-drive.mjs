// End-to-end drive of the real UI in headless Chrome via CDP (no deps;
// node >= 22 for the global WebSocket). Exercises keypad, canvas taps,
// ghost disambiguation, flip, undo/redo, walls, check measurements, the
// log sheet, items (drop/drag/lock, two-distance and wall placement),
// layers, the 3D view and JSON export/import; drops screenshots into
// $SHOTS (default cwd).
//
// Usage:
//   python3 -m http.server 8017            # from the repo root
//   google-chrome --headless=new --remote-debugging-port=9333 \
//     --user-data-dir=/tmp/hm-profile --window-size=412,915 about:blank &
//   SHOTS=/tmp/hm-shots node test/browser-drive.mjs
//
// NOTE: clears the app's localStorage in that Chrome profile.
//
// Timing model: headless Chrome composites lazily and the app's canvas is
// resized by a ResizeObserver one frame after any panel/mode change. So all
// screen coordinates MUST be computed after settleFrame(), never before.
import { writeFileSync } from 'node:fs';

const CDP = 'http://127.0.0.1:9333';
const APP = 'http://127.0.0.1:8017/';
const SHOTS = process.env.SHOTS || '.';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`${CDP}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error('no CDP target');
}

const ws = new WebSocket(await connect());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let msgId = 0;
const pending = new Map();
const problems = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id != null) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) p.rej(new Error(m.error.message));
    else p.res(m.result);
  } else if (m.method === 'Runtime.exceptionThrown') {
    problems.push('EXCEPTION: ' + JSON.stringify(m.params.exceptionDetails).slice(0, 500));
  } else if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
    problems.push(`CONSOLE ${m.params.type}: ` + m.params.args.map((a) => a.value ?? a.description).join(' ').slice(0, 300));
  } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
    problems.push(`LOG error: ${m.params.entry.text}`.slice(0, 300));
  }
};
function send(method, params = {}) {
  return new Promise((res, rej) => {
    const id = ++msgId;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function js(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result.value;
}

// Force a compositor frame so pending layout/resize lands and input
// hit-testing is current. MUST run before computing any screen coordinate.
async function settleFrame() {
  await send('Page.captureScreenshot', { format: 'jpeg', quality: 10 });
  await sleep(60);
}

async function shot(name) {
  await sleep(200);
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${SHOTS}/${name}.png`, Buffer.from(r.data, 'base64'));
  console.log('shot', name);
}

// Raw input at already-fresh coordinates (call settleFrame first).
async function tapAtRaw(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await sleep(40);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await sleep(90);
  const stuck = await js('window.app.plan.pointers.size');
  if (stuck) problems.push(`ASSERT: stuck pointer after tap (${stuck})`);
}

async function dragRaw(x1, y1, x2, y2) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', clickCount: 1 });
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', button: 'left',
      x: x1 + ((x2 - x1) * i) / steps, y: y1 + ((y2 - y1) * i) / steps,
    });
    await sleep(25);
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', clickCount: 1 });
  await sleep(120);
  const stuck = await js('window.app.plan.pointers.size');
  if (stuck) problems.push(`ASSERT: stuck pointer after drag (${stuck})`);
}

const key = (k) => js(`document.querySelector('[data-key="${k}"]').click()`);
const keys = async (s) => { for (const k of s) { await key(k); await sleep(25); } };
const click = (sel) => js(`document.querySelector('${sel}').click()`);

function assert(cond, label) {
  if (cond) console.log('ok  ', label);
  else { console.log('FAIL', label); problems.push('ASSERT: ' + label); }
}
process.on('uncaughtException', (e) => {
  console.log('CRASH:', e.message);
  if (problems.length) console.log(`PROBLEMS SO FAR (${problems.length}):\n` + problems.join('\n'));
  process.exit(1);
});
const near = (a, b, eps = 1e-3) => Math.abs(a - b) < eps;
const state = () => js('JSON.stringify(window.app.store.state)').then(JSON.parse);

// Fresh viewport coords of every named point (call after settleFrame).
const viewpos = () => js(`(() => {
  const r = document.getElementById('plan').getBoundingClientRect();
  const out = {};
  for (const pt of window.app.store.state.points) {
    const p = window.app.store.solved.pos.get(pt.id);
    if (!p) continue;
    const s = window.app.plan.worldToScreen(p.x, p.y);
    out[pt.name] = { x: Math.round(r.left + s.x), y: Math.round(r.top + s.y) };
  }
  return out;
})()`);

// Settle, then tap a named point where it is NOW.
async function tapPoint(name) {
  await settleFrame();
  const vp = await viewpos();
  await tapAtRaw(vp[name].x, vp[name].y);
}

await send('Runtime.enable');
await send('Page.enable');
await send('Log.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true }); // always test the current files
await send('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url: APP });
for (let i = 0; i < 40 && !(await js('!!window.app').catch(() => false)); i++) await sleep(200);
assert(await js('!!window.app'), 'app booted');
await js('localStorage.clear(); location.reload();');
await sleep(800);
for (let i = 0; i < 40 && !(await js('!!window.app').catch(() => false)); i++) await sleep(200);

await shot('01-empty');

// --- M1: anchors + two chained points --------------------------------------
await keys(['3', '4', '2']);
await shot('02-anchor-typing');
await key('ok');
let st = await state();
assert(st.points.length === 2, 'anchors created');
assert(near(st.measurements[0].d, 3.42), 'A-B = 3.42 m');

await keys(['3', '0', '0']);
await key('ok');
await keys(['4', '0', '0']);
await shot('03-candidates');
await key('ok');
st = await state();
assert(st.points.length === 3, 'C committed');
let posC = await js('[...window.app.store.solved.pos][2][1]');
assert(near(posC.x, 0.68661) && near(posC.y, 2.92108), `C at expected spot (${posC.x.toFixed(4)}, ${posC.y.toFixed(4)})`);

await key('flip');
posC = await js('[...window.app.store.solved.pos][2][1]');
assert(near(posC.y, -2.92108), 'flip moves C to the other side');
await key('flip');

await tapPoint('A'); // refs were [A,B]; drop A
await tapPoint('C'); // refs [B,C]
let refs = await js('window.app.ui.refs.map(id => window.app.store.point(id).name)');
assert(refs.join(',') === 'B,C', `taps select refs B,C (${refs})`);

await keys(['2', '5', '0']);
await key('ok');
await keys(['2', '8', '0']);
// Tap the non-default (right side) ghost.
await settleFrame();
const rg = await js(`(() => {
  const app = window.app, st = app.store, ui = app.ui;
  const P = st.solved.pos.get(ui.refs[0]), Q = st.solved.pos.get(ui.refs[1]);
  const d1 = 2.5, d2 = 2.8;
  const dx = Q.x - P.x, dy = Q.y - P.y, d = Math.hypot(dx, dy);
  const ux = dx / d, uy = dy / d, a = (d1 * d1 - d2 * d2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, d1 * d1 - a * a));
  const right = { x: P.x + ux * a + uy * h, y: P.y + uy * a - ux * h };
  const r = document.getElementById('plan').getBoundingClientRect();
  const s = app.plan.worldToScreen(right.x, right.y);
  return { x: Math.round(r.left + s.x), y: Math.round(r.top + s.y) };
})()`);
await tapAtRaw(rg.x, rg.y);
st = await state();
assert(st.points.length === 4, 'D committed by tapping ghost');
assert(st.points[3]?.fix?.side === -1, 'ghost tap chose the right-hand side');

await click('#undo');
assert((await state()).points.length === 3, 'undo removes D');
await click('#redo');
assert((await state()).points.length === 4, 'redo restores D');

// One-handed zoom: double-tap on empty canvas zooms in about the tap.
await settleFrame();
const vh0 = await js('window.app.plan.viewH');
const corner = await js(`(() => {
  const r = document.getElementById('plan').getBoundingClientRect();
  return { x: Math.round(r.left + 36), y: Math.round(r.top + 36) };
})()`);
await tapAtRaw(corner.x, corner.y);
await tapAtRaw(corner.x, corner.y);
const vh1 = await js('window.app.plan.viewH');
assert(vh1 < vh0 * 0.7, `double-tap zooms in (${vh0.toFixed(2)} -> ${vh1.toFixed(2)})`);
await click('#fit');

// --- M2: walls --------------------------------------------------------------
// Entering wall mode grows the canvas (keypad hides); refit at the new
// aspect so every point is actually on screen before tapping.
await click('#modebar [data-mode="wall"]');
await settleFrame();
await click('#fit');
for (const n of ['A', 'C', 'D', 'B', 'A']) await tapPoint(n);
st = await state();
assert(st.walls.length === 1 && st.walls[0]?.closed, 'wall drawn A-C-D-B and closed');
assert(st.walls[0]?.pts.length === 4, 'closed loop has 4 points');
await shot('04-walls-closed');

// Step back then re-close.
await click('#wall-back');
st = await state();
assert(!st.walls[0].closed, 'step back un-closes');
await js('window.app.ui.activeWallId = window.app.store.state.walls[0].id');
await tapPoint('A');
assert((await state()).walls[0].closed, 're-closed');

// --- M2: check measurement + residuals + log --------------------------------
await click('#modebar [data-mode="measure"]');
await js('window.app.ui.refs = []; window.app.render();');
await tapPoint('A');
await tapPoint('D');
refs = await js('window.app.ui.refs.map(id => window.app.store.point(id).name)');
assert(refs.join(',') === 'A,D', `refs A,D for check (${refs})`);
// True |A-D| ~ 4.264 m; record 4.28 -> ~1.6 cm disagreement.
await keys(['4', '2', '8']);
await click('#check-btn');
st = await state();
assert(st.measurements.length === 6, 'check measurement recorded (6 total)');
const pres = await js('[...window.app.store.solved.pres.values()].map(v => v * 100)');
assert(pres.some((v) => v > 0.2), `residuals appeared after bad check (max ${Math.max(...pres).toFixed(2)} cm)`);
await shot('05-residuals');

await click('#log-btn');
await shot('06-log');
const logText = await js(`document.getElementById('log-list').innerText`);
assert(logText.includes('A to D'), 'log lists the check measurement');
assert(/cm/.test(logText), 'log shows residuals');

// Edit the check measurement down to 4.26 -> residuals shrink.
await js(`[...document.querySelectorAll('#log-list [data-act="edit"]')].at(-1).click()`);
await keys(['4', '2', '6']);
await key('ok');
st = await state();
assert(near(st.measurements.at(-1).d, 4.26), 'measurement edited via log + keypad');

// --- M3: items --------------------------------------------------------------
// Drop a fridge freehand, drag it, rotate it, lock it.
await click('#modebar [data-mode="item"]');
await click('#item-new');
await js(`
  document.getElementById('if-name').value = 'fridge';
  document.getElementById('if-category').value = 'appliance';
  document.getElementById('if-w').value = 70;
  document.getElementById('if-d').value = 70;
  document.getElementById('if-h').value = 180;
  document.getElementById('if-z0').value = 0;
`);
await click('#if-place-drop');
st = await state();
assert(st.items.length === 1 && st.items[0].name === 'fridge', 'fridge dropped');
assert(await js('window.app.ui.mode') === 'move', 'drop lands in move mode');

const itemVp = (name) => js(`(() => {
  const it = window.app.store.state.items.find(i => i.name === '${name}');
  const r = document.getElementById('plan').getBoundingClientRect();
  const s = window.app.plan.worldToScreen(it.x, it.y);
  return { x: Math.round(r.left + s.x), y: Math.round(r.top + s.y), wx: it.x, wy: it.y, rot: it.rot,
           wpp: window.app.plan.worldPerPx };
})()`);

await settleFrame();
let iv = await itemVp('fridge');
await dragRaw(iv.x, iv.y, iv.x + 70, iv.y - 40);
let iv2 = await itemVp('fridge');
const [edx, edy] = [70 * iv.wpp, 40 * iv.wpp];
assert(near(iv2.wx - iv.wx, edx, edx * 0.15) && near(iv2.wy - iv.wy, edy, edy * 0.15),
  `drag moved fridge by the drag delta (got ${(iv2.wx - iv.wx).toFixed(3)}, ${(iv2.wy - iv.wy).toFixed(3)}; want ${edx.toFixed(3)}, ${edy.toFixed(3)})`);

await key('flip');
iv = await itemVp('fridge');
assert(near(iv.rot, Math.PI / 2, 1e-6), 'flip rotates selected item 90 degrees');

await click('#sel-lock');
st = await state();
assert(st.items[0].locked, 'item locked');
await settleFrame();
iv = await itemVp('fridge');
await dragRaw(iv.x, iv.y, iv.x + 60, iv.y);
iv2 = await itemVp('fridge');
assert(near(iv2.wx, iv.wx, 1e-9), 'locked item does not move (drag pans instead)');
await click('#fit');

// Place a worktop by two distances to its corner, from A and B.
await click('#modebar [data-mode="item"]');
await click('#item-new');
await js(`
  document.getElementById('if-name').value = 'worktop';
  document.getElementById('if-category').value = 'worktop';
  document.getElementById('if-w').value = 180;
  document.getElementById('if-d').value = 62;
  document.getElementById('if-h').value = 90;
`);
await click('#if-place-measure');
assert(await js('window.app.ui.flow?.kind') === 'item-c1', 'corner-1 flow started');
await js('window.app.ui.refs = []; window.app.render();'); // drop stale refs
await tapPoint('A');
await tapPoint('B');
refs = await js('window.app.ui.refs.map(id => window.app.store.point(id).name)');
assert(refs.join(',') === 'A,B', `corner refs A,B (${refs})`);
await keys(['1', '0', '0']);
await key('ok');
await keys(['2', '5', '0']);
await key('ok'); // corner 1 committed (left side default)
assert(await js('window.app.ui.flow?.kind') === 'item-c2', 'corner-2 flow');
await key('ok'); // no distances -> keep width, axis aligned -> side choice
assert(await js('window.app.ui.flow?.kind') === 'item-side', 'side choice');
await shot('07-item-side-choice');
await key('flip'); // put it on the other side
await key('ok');
st = await state();
const wt = st.items.find((i) => i.name === 'worktop');
assert(!!wt, 'worktop committed');
assert(wt && near(wt.w, 1.8, 1e-6) && near(wt.rot, 0, 1e-6), 'worktop axis-aligned with kept width');

// Wall-mounted window: tap wall A-C, offset 40 cm from A.
await click('#modebar [data-mode="item"]');
await click('#item-new');
await js(`
  document.getElementById('if-name').value = 'window';
  document.getElementById('if-category').value = 'window';
  document.getElementById('if-w').value = 100;
  document.getElementById('if-d').value = 15;
  document.getElementById('if-h').value = 110;
  document.getElementById('if-z0').value = 90;
`);
await click('#if-place-wall');
await settleFrame();
const vpw = await viewpos();
// One third along wall A-C from A: t ~ 0.33 so the near end is unambiguous.
await tapAtRaw(Math.round(vpw.A.x * 0.67 + vpw.C.x * 0.33), Math.round(vpw.A.y * 0.67 + vpw.C.y * 0.33));
assert(await js('window.app.ui.flow?.kind') === 'item-walloffset', 'wall tapped, offset flow');
await keys(['4', '0']);
await key('ok');
st = await state();
const win = st.items.find((i) => i.name === 'window');
assert(!!win && win.mount && win.z0 === 0.9, 'window mounted on wall at 90 cm');
if (win) {
  const dA = Math.hypot(win.x - 0, win.y - 0);
  assert(near(dA, 0.4 + 0.5, 0.02), `window centre ~90 cm along wall from A (${dA.toFixed(3)} m)`);
}
await shot('08-items-plan');

// Layers: proposal layer, item on it, hide it.
await click('#log-btn');
await js(`document.getElementById('new-layer-name').value = 'plan B'`);
await js(`[...document.querySelectorAll('#log-list [data-act="add"]')].at(0).click()`);
st = await state();
assert(st.layers.length === 2 && st.activeLayer !== 'current', 'proposal layer added and active');
await click('#log-close');
await click('#modebar [data-mode="item"]');
await click('#item-new');
await js(`document.getElementById('if-name').value = 'island'; document.getElementById('if-w').value = 120; document.getElementById('if-d').value = 90; document.getElementById('if-h').value = 90;`);
await click('#if-place-drop');
st = await state();
assert(st.items.at(-1).layer === st.activeLayer, 'island on proposal layer');
const rectCountBefore = await js('window.app.plan.content.rects.length');
await click('#log-btn');
await js(`[...document.querySelectorAll('#log-list [data-act="vis"]')].at(1).click()`); // hide proposal
await click('#log-close');
const rectCountAfter = await js('window.app.plan.content.rects.length');
assert(rectCountAfter === rectCountBefore - 1, `hiding layer hides its items (${rectCountBefore} -> ${rectCountAfter})`);
await js(`document.getElementById('log-btn').click()`);
await js(`[...document.querySelectorAll('#log-list [data-act="vis"]')].at(1).click()`); // show again
await click('#log-close');

// --- M4: 3D ----------------------------------------------------------------
await click('#view3d-btn');
await sleep(600);
assert(await js('window.app.ui.view') === '3d', '3D view active');
assert(await js('!!window.app.view3d'), 'View3D created');
const nMeshes = await js('window.app.view3d.group.children.length');
assert(nMeshes >= 9, `3D scene has walls+floor+items (${nMeshes} meshes)`);

// Dollhouse cutaway: camera-side walls fade, far walls stay solid.
const occ0 = await js(`(() => {
  const v = window.app.view3d;
  return { walls: v.wallRecs.map(w => ({ key: w.key, mid: w.mid, faded: w.mesh.material === v.wallFaded })),
           cam: { x: v.camera.position.x, y: -v.camera.position.z } };
})()`);
const wdist = (w) => Math.hypot(w.mid.x - occ0.cam.x, w.mid.y - occ0.cam.y);
const sorted = [...occ0.walls].sort((a, b) => wdist(a) - wdist(b));
assert(occ0.walls.filter((w) => w.faded).length === 2, `two camera-side walls faded (${occ0.walls.filter((w) => w.faded).length})`);
assert(sorted[0].faded, 'nearest wall to camera is faded');
assert(!sorted.at(-1).faded, 'farthest wall stays solid');

// Orbit to the far (north) side: the fades swap.
const occ1 = await js(`(() => {
  const v = window.app.view3d;
  const t = v.controls.target;
  v.camera.position.set(t.x + 0.5, 5, t.z - 7);
  v.controls.update();
  v.updateOcclusion(); v.requestRender();
  return v.wallRecs.map(w => ({ mid: w.mid, faded: w.mesh.material === v.wallFaded }));
})()`);
const north = occ1.reduce((a, b) => (a.mid.y > b.mid.y ? a : b));
const south = occ1.reduce((a, b) => (a.mid.y < b.mid.y ? a : b));
assert(north.faded && !south.faded, 'orbiting to the far side swaps which walls fade');

// From the west the window's wall faces the camera: the window fades too.
const occ2 = await js(`(() => {
  const v = window.app.view3d;
  const t = v.controls.target;
  v.camera.position.set(t.x - 7, 4, t.z);
  v.controls.update();
  v.updateOcclusion(); v.requestRender();
  return { win: v.mountRecs.map(m => m.faded), fadedKeys: [...v.fadedKeys] };
})()`);
assert(occ2.win.length === 1 && occ2.win[0] === true, 'window fades with its wall');

// Back to the default pose for the screenshot.
await js('window.app.view3d.refit(); window.app.render();');
await sleep(300);
await shot('09-3d');
await click('#view3d-btn');
assert(await js('window.app.ui.view') === 'plan', 'back to plan');

// --- M4: export / import ----------------------------------------------------
const exported = await js('window.app.exportString()');
assert(JSON.parse(exported).state.items.length === (await state()).items.length, 'export contains items');
await js(`window.app.store.clearAll()`);
assert((await state()).points.length === 0, 'cleared');
await js(`window.app.importFromText(${JSON.stringify('X')})`); // broken input
assert((await state()).points.length === 0, 'broken import rejected');
await js(`window.app.importFromText(${JSON.stringify(exported)})`);
st = await state();
assert(st.points.length === 4 && st.items.length === 4, 'import restored everything');

// --- persistence across reload ---------------------------------------------
await send('Page.navigate', { url: APP });
await sleep(1000);
st = await state();
assert(st.points.length === 4 && st.items.length === 4 && st.walls.length === 1, 'full state survives reload');
await shot('10-after-reload');

// Desktop layout.
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await sleep(400);
await shot('11-desktop');
await js('window.app.toggle3D()');
await sleep(600);
await shot('12-desktop-3d');

console.log(problems.length ? `\nPROBLEMS (${problems.length}):\n` + problems.join('\n') : '\nNO PROBLEMS');
ws.close();
process.exit(problems.length ? 1 : 0);
