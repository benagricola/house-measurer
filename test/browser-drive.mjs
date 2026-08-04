// End-to-end drive of the real UI in headless Chrome via CDP (no deps;
// node >= 22 for the global WebSocket). Exercises the wall-first measuring
// flow (auto-chained walls, close room, per-room ceiling height), keypad,
// canvas taps, ghost disambiguation, flip, undo/redo, double-tap zoom,
// check measurements, the data sheet, items (drop/drag/lock, two-distance
// and wall placement), layers, 3D (cutaway occlusion AND measuring on the
// 3D survey pins) and JSON export/import; drops screenshots into $SHOTS.
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

async function tapPoint(name) {
  await settleFrame();
  const vp = await viewpos();
  await tapAtRaw(vp[name].x, vp[name].y);
}

// Viewport position of the left/right circle-intersection candidate for the
// current refs + typed distances (d1, d2 in metres).
const ghostVp = (d1, d2, side, in3d = false) => js(`(() => {
  const app = window.app, st = app.store, ui = app.ui;
  const P = st.solved.pos.get(ui.refs[0]), Q = st.solved.pos.get(ui.refs[1]);
  const d1 = ${d1}, d2 = ${d2};
  const dx = Q.x - P.x, dy = Q.y - P.y, d = Math.hypot(dx, dy);
  const ux = dx / d, uy = dy / d, a = (d1 * d1 - d2 * d2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, d1 * d1 - a * a));
  const bx = P.x + ux * a, by = P.y + uy * a;
  const g = ${side} >= 0
    ? { x: bx - uy * h, y: by + ux * h }
    : { x: bx + uy * h, y: by - ux * h };
  if (${in3d}) {
    const v = app.view3d;
    const r = document.getElementById('plan3d').getBoundingClientRect();
    const vec = new v.camera.position.constructor(g.x, 0.55, -g.y);
    vec.project(v.camera);
    return { x: Math.round(r.left + (vec.x + 1) / 2 * r.width), y: Math.round(r.top + (1 - vec.y) / 2 * r.height) };
  }
  const r = document.getElementById('plan').getBoundingClientRect();
  const s = app.plan.worldToScreen(g.x, g.y);
  return { x: Math.round(r.left + s.x), y: Math.round(r.top + s.y) };
})()`);

await send('Runtime.enable');
await send('Page.enable');
await send('Log.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url: APP });
for (let i = 0; i < 40 && !(await js('!!window.app').catch(() => false)); i++) await sleep(200);
assert(await js('!!window.app'), 'app booted');
await js('localStorage.clear(); location.reload();');
await sleep(800);
for (let i = 0; i < 40 && !(await js('!!window.app').catch(() => false)); i++) await sleep(200);

await shot('01-empty');

// --- anchors start the wall run --------------------------------------------
await keys(['3', '4', '2']);
await shot('02-anchor-typing');
await key('ok');
let st = await state();
assert(st.points.length === 2, 'anchors created');
assert(near(st.measurements[0].d, 3.42), 'A-B = 3.42 m');
assert(st.walls.length === 1 && st.walls[0].pts.length === 2, 'anchors started the wall run');

// C measured in perimeter order (refs kept as A, B): 4.27 m and 2.50 m.
await keys(['4', '2', '7']);
await key('ok');
await keys(['2', '5', '0']);
await shot('03-candidates');
await key('ok');
st = await state();
assert(st.points.length === 3, 'C committed');
let posC = await js('[...window.app.store.solved.pos][2][1]');
assert(near(posC.x, 3.4620, 2e-3) && near(posC.y, 2.4996, 2e-3), `C at expected spot (${posC.x.toFixed(4)}, ${posC.y.toFixed(4)})`);
assert(st.walls[0].pts.length === 3, 'C auto-chained into the wall run');

await key('flip');
posC = await js('[...window.app.store.solved.pos][2][1]');
assert(posC.y < 0, 'flip moves C to the other side');
await key('flip');

// D from A and C: 3.00 m and 2.81 m; commit by tapping the primary ghost.
await tapPoint('B'); // refs [A,B] -> drop B
await tapPoint('C'); // refs [A,C]
let refs = await js('window.app.ui.refs.map(id => window.app.store.point(id).name)');
assert(refs.join(',') === 'A,C', `taps select refs A,C (${refs})`);
await keys(['3', '0', '0']);
await key('ok');
await keys(['2', '8', '1']);
await settleFrame();
const lg = await ghostVp(3.0, 2.81, +1);
await tapAtRaw(lg.x, lg.y);
st = await state();
assert(st.points.length === 4, 'D committed by tapping ghost');
assert(st.points[3]?.fix?.side === 1, 'ghost tap kept the left side');
const posD = await js('[...window.app.store.solved.pos][3][1]');
assert(near(posD.x, 0.684, 3e-3) && near(posD.y, 2.921, 3e-3), `D at expected spot (${posD.x.toFixed(3)}, ${posD.y.toFixed(3)})`);
assert(st.walls[0].pts.length === 4 && !st.walls[0].closed, 'run is A-B-C-D, still open');

await click('#undo');
assert((await state()).points.length === 3, 'undo removes D');
assert((await state()).walls[0].pts.length === 3, 'undo also removes its wall link');
await click('#redo');
st = await state();
assert(st.points.length === 4 && st.walls[0].pts.length === 4, 'redo restores D and the link');

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

// --- close the room, set its ceiling ---------------------------------------
assert(await js(`document.getElementById('close-room').style.display`) !== 'none', 'close-room button offered');
await click('#close-room');
assert(await js('window.app.ui.flow?.kind') === 'room-height', 'closing asks for the ceiling height');
await keys(['2', '5', '0']);
await key('ok');
st = await state();
assert(st.walls[0].closed, 'room closed');
assert(near(st.walls[0].height, 2.5), 'ceiling height stored on the room');
await shot('04-room-closed');

// Step back re-opens; close-room again re-closes (height kept).
await click('#modebar [data-mode="wall"]');
await settleFrame();
await click('#wall-back');
st = await state();
assert(!st.walls[0].closed, 'step back re-opens the loop');
await click('#close-room');
await key('ok'); // keep existing height
st = await state();
assert(st.walls[0].closed && near(st.walls[0].height, 2.5), 're-closed, height kept');

// --- check measurement + residuals + data sheet -----------------------------
await click('#modebar [data-mode="measure"]');
await js('window.app.ui.refs = []; window.app.render();');
await tapPoint('A');
await tapPoint('D');
refs = await js('window.app.ui.refs.map(id => window.app.store.point(id).name)');
assert(refs.join(',') === 'A,D', `refs A,D for check (${refs})`);
// True |A-D| = 3.00 m; record 3.02 -> 2 cm disagreement.
await keys(['3', '0', '2']);
await click('#check-btn');
st = await state();
assert(st.measurements.length === 6, 'check measurement recorded (6 total)');
const pres = await js('[...window.app.store.solved.pres.values()].map(v => v * 100)');
assert(pres.some((v) => v > 0.2), `residuals appeared after bad check (max ${Math.max(...pres).toFixed(2)} cm)`);
await shot('05-residuals');

// The descriptive impossible-circles message.
await keys(['5', '0']);
await key('ok');
await keys(['5', '0']);
const statusText = await js(`(document.querySelector('[data-key="ok"]').click(), document.getElementById('status').textContent)`);
assert(/Too short|overshoots/.test(statusText) && /cm|m /.test(statusText), `gap error explains itself (${statusText.slice(0, 60)}...)`);
await keys(['del', 'del']); // clear field 1
await js(`window.app.ui.fields = ['','']; window.app.ui.active = 0; window.app.render();`);

await click('#log-btn');
await shot('06-data');
const logText = await js(`document.getElementById('log-list').innerText`);
assert(logText.includes('A to D'), 'data sheet lists the check measurement');
assert(/ceiling 250 cm/.test(logText), 'data sheet shows the room ceiling');
assert(/cm/.test(logText), 'data sheet shows residuals');

// Edit the check measurement to the true 3.00 -> residuals shrink.
await js(`[...document.querySelectorAll('#log-list [data-act="edit"]')].at(-1).click()`);
await keys(['3', '0', '0']);
await key('ok');
st = await state();
assert(near(st.measurements.at(-1).d, 3.0), 'measurement edited via data sheet + keypad');

// --- items ------------------------------------------------------------------
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
  `drag moved fridge by the drag delta (got ${(iv2.wx - iv.wx).toFixed(3)}, ${(iv2.wy - iv.wy).toFixed(3)})`);

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

// Worktop by two distances to its corner, from A and B.
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
await js('window.app.ui.refs = []; window.app.render();');
await tapPoint('A');
await tapPoint('B');
refs = await js('window.app.ui.refs.map(id => window.app.store.point(id).name)');
assert(refs.join(',') === 'A,B', `corner refs A,B (${refs})`);
await keys(['1', '0', '0']);
await key('ok');
await keys(['2', '5', '0']);
await key('ok'); // corner 1 committed (left side default)
assert(await js('window.app.ui.flow?.kind') === 'item-c2', 'corner-2 flow');
// Corner 2 straight from an existing point: tap B with nothing typed.
await tapPoint('B');
assert(await js('window.app.ui.flow?.kind') === 'item-side', 'tapped point accepted as corner 2');
await shot('07-item-side-choice');
await key('flip');
await key('ok');
st = await state();
const wt = st.items.find((i) => i.name === 'worktop');
assert(!!wt, 'worktop committed');
const expW = await js(`(() => {
  const st = window.app.store;
  const A = st.solved.pos.get(st.state.points[0].id), B = st.solved.pos.get(st.state.points[1].id);
  const d = 3.42, d1 = 1.0, d2 = 2.5;
  const a = (d1*d1 - d2*d2 + d*d) / (2*d);
  const h = Math.sqrt(d1*d1 - a*a);
  return Math.hypot(B.x - (A.x + a), h);
})()`);
assert(wt && near(wt.w, expW, 1e-3), `worktop width spans corner1 to B (${wt.w.toFixed(3)} vs ${expW.toFixed(3)})`);

// Wall-mounted window on the west wall (D-A), offset 40 cm from A.
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
await tapAtRaw(Math.round(vpw.D.x * 0.25 + vpw.A.x * 0.75), Math.round(vpw.D.y * 0.25 + vpw.A.y * 0.75));
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
const visLabels = await js(`[...document.querySelectorAll('#log-list [data-act="vis"]')].map(b => b.className)`);
assert(visLabels.every((c) => /vis-on|vis-off/.test(c)), 'visibility chips use explicit on/off styling');
await click('#log-close');
await click('#modebar [data-mode="item"]');
await click('#item-new');
await js(`document.getElementById('if-name').value = 'island'; document.getElementById('if-w').value = 120; document.getElementById('if-d').value = 90; document.getElementById('if-h').value = 90;`);
await click('#if-place-drop');
st = await state();
assert(st.items.at(-1).layer === st.activeLayer, 'island on proposal layer');
const rectCountBefore = await js('window.app.plan.content.rects.length');
await click('#log-btn');
await js(`[...document.querySelectorAll('#log-list [data-act="vis"]')].at(1).click()`);
await click('#log-close');
const rectCountAfter = await js('window.app.plan.content.rects.length');
assert(rectCountAfter === rectCountBefore - 1, `hiding layer hides its items (${rectCountBefore} -> ${rectCountAfter})`);
await js(`document.getElementById('log-btn').click()`);
await js(`[...document.querySelectorAll('#log-list [data-act="vis"]')].at(1).click()`);
await click('#log-close');

// --- 3D: cutaway + measuring on the survey pins -----------------------------
await click('#view3d-btn');
await sleep(600);
assert(await js('window.app.ui.view') === '3d', '3D view active');
const nMeshes = await js('window.app.view3d.group.children.length');
assert(nMeshes >= 9, `3D scene has walls+floor+items (${nMeshes} meshes)`);
assert(await js('window.app.view3d.vizGroup.children.length') >= 8, 'survey pins rendered in 3D');

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

const occ2 = await js(`(() => {
  const v = window.app.view3d;
  const t = v.controls.target;
  v.camera.position.set(t.x - 7, 4, t.z);
  v.controls.update();
  v.updateOcclusion(); v.requestRender();
  return { win: v.mountRecs.map(m => m.faded), fadedKeys: [...v.fadedKeys] };
})()`);
assert(occ2.win.length === 1 && occ2.win[0] === true, 'window fades with its wall');

// Measure in 3D: pick refs by tapping pins, commit a point on a ghost.
await js('window.app.view3d.refit(); window.app.render();');
await sleep(300);
await js('window.app.ui.refs = []; window.app.render();');
await settleFrame();
const pin3d = (name) => js(`(() => {
  const v = window.app.view3d;
  const r = document.getElementById('plan3d').getBoundingClientRect();
  const pt = window.app.store.state.points.find(p => p.name === '${name}');
  const p = window.app.store.solved.pos.get(pt.id);
  const vec = new v.camera.position.constructor(p.x, 0.3, -p.y);
  vec.project(v.camera);
  return { x: Math.round(r.left + (vec.x + 1) / 2 * r.width), y: Math.round(r.top + (1 - vec.y) / 2 * r.height) };
})()`);
let pv3 = await pin3d('A');
await tapAtRaw(pv3.x, pv3.y);
pv3 = await pin3d('B');
await tapAtRaw(pv3.x, pv3.y);
refs = await js('window.app.ui.refs.map(id => window.app.store.point(id).name)');
assert(refs.join(',') === 'A,B', `3D pin taps select refs (${refs})`);
await keys(['2', '0', '0']);
await key('ok');
await keys(['2', '2', '0']);
assert(await js('window.app.view3d.tapTargets.filter(t => t.ghostSide != null).length') === 2, '3D candidate ghosts tappable');
await shot('09-3d-measuring');
await settleFrame();
const g3 = await ghostVp(2.0, 2.2, +1, true);
await tapAtRaw(g3.x, g3.y);
st = await state();
assert(st.points.length === 5, 'point committed from inside 3D');
await click('#undo');
assert((await state()).points.length === 4, 'undo removes the 3D-placed point');
await shot('09-3d');
await click('#view3d-btn');
assert(await js('window.app.ui.view') === 'plan', 'back to plan');

// --- export / import --------------------------------------------------------
const exported = await js('window.app.exportString()');
assert(JSON.parse(exported).state.items.length === (await state()).items.length, 'export contains items');
await js(`window.app.store.clearAll()`);
assert((await state()).points.length === 0, 'cleared');
await js(`window.app.importFromText(${JSON.stringify('X')})`);
assert((await state()).points.length === 0, 'broken import rejected');
await js(`window.app.importFromText(${JSON.stringify(exported)})`);
st = await state();
assert(st.points.length === 4 && st.items.length === 4, 'import restored everything');
assert(near(st.walls[0].height, 2.5), 'per-room ceiling survives export/import');

// --- persistence across reload ---------------------------------------------
await send('Page.navigate', { url: APP });
await sleep(1000);
st = await state();
assert(st.points.length === 4 && st.items.length === 4 && st.walls.length === 1, 'full state survives reload');
await shot('10-after-reload');

// --- floors + stairs --------------------------------------------------------
// Add an upstairs, anchor it by stacking two ground-floor points, measure a
// room up there, and put a staircase on the ground floor.
await click('#modebar [data-mode="measure"]');
await click('#log-btn');
await js(`document.getElementById('new-floor-name').value = 'upstairs'; document.getElementById('new-floor-off').value = 290;`);
await js(`[...document.querySelectorAll('#log-list [data-act="addf"]')].at(0).click()`);
st = await state();
assert(st.floors.length === 2 && st.activeFloor === st.floors[1].id, 'upstairs added and active');
assert(near(st.floors[1].elevation, 2.9), 'elevation from floor-to-floor offset');

await js('window.app.ui.refs = []; window.app.render();');
await tapPoint('A'); // ghosted ground-floor point
await tapPoint('B');
assert(await js(`document.getElementById('stack-btn').style.display`) !== 'none', 'stack button offered for off-floor refs');
await click('#stack-btn');
st = await state();
assert(st.points.length === 6, 'two stacked twins created');
const twins = st.points.slice(-2);
assert(twins.every((p) => p.floor === st.activeFloor && p.fix?.stack != null), 'twins live upstairs, stacked');
const twinGap = await js(`(() => {
  const s = window.app.store, pts = s.state.points;
  const p = (i) => s.solved.pos.get(pts[i].id);
  return Math.hypot(p(0).x - p(4).x, p(0).y - p(4).y) + Math.hypot(p(1).x - p(5).x, p(1).y - p(5).y);
})()`);
assert(twinGap < 1e-9, 'stacked twins share their owner plan coordinates');
refs = await js('window.app.ui.refs.map(id => window.app.store.point(id).name)');
assert(refs.join(',') === `${twins[0].name},${twins[1].name}`, `refs swapped to the twins (${refs})`);

await keys(['4', '2', '7']);
await key('ok');
await keys(['2', '5', '0']);
await key('ok');
st = await state();
assert(st.points.length === 7 && st.points.at(-1).floor === st.activeFloor, 'upstairs point committed');
assert(st.walls.at(-1).floor === st.activeFloor && st.walls.at(-1).pts.length === 3, 'upstairs auto-wall run E-F-G');
await click('#close-room');
await key('ok');
st = await state();
assert(st.walls.length === 2 && st.walls.at(-1).closed, 'upstairs room closed');

await click('#floor-btn');
assert((await state()).activeFloor === 'f0', 'floor button cycles back to ground');
await click('#modebar [data-mode="item"]');
await click('#item-new');
await js(`
  document.getElementById('if-name').value = 'stairs';
  document.getElementById('if-category').value = 'stairs';
  document.getElementById('if-w').value = 270;
  document.getElementById('if-d').value = 85;
  document.getElementById('if-h').value = 290;
`);
await click('#if-place-drop');
st = await state();
assert(st.items.at(-1).category === 'stairs' && st.items.at(-1).floor === 'f0', 'staircase dropped on ground floor');

await click('#view3d-btn');
await sleep(700);
assert(await js('window.app.view3d.wallRecs.some(w => w.mesh.position.y > 2.5)'), '3D: upstairs walls at elevation');
const stairKids = await js(`(() => {
  const g = [...window.app.view3d.group.children].filter(o => o.isGroup).map(o => o.children.length);
  return Math.max(...g, 0);
})()`);
assert(stairKids >= 14, `3D: staircase rendered as steps (${stairKids})`);
await shot('13-two-floors');
await click('#view3d-btn');

await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await sleep(400);
await shot('11-desktop');
await js('window.app.toggle3D()');
await sleep(600);
await shot('12-desktop-3d');

console.log(problems.length ? `\nPROBLEMS (${problems.length}):\n` + problems.join('\n') : '\nNO PROBLEMS');
ws.close();
process.exit(problems.length ? 1 : 0);
