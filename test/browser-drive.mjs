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

// --- coach + reference-first anchors ---------------------------------------
assert(await js(`!document.getElementById('coach').hidden`), 'coach shows on a fresh survey');
assert(/baseline/i.test(await js(`document.getElementById('coach-text').textContent`)), 'first tip explains the baseline');
await keys(['3', '4', '2']);
await shot('02-anchor-typing');
await key('ok');
let st = await state();
assert(st.points.length === 2, 'anchors created');
assert(near(st.measurements[0].d, 3.42), 'A-B = 3.42 m');
assert(st.walls.length === 0, 'reference-first default: anchors start no wall run');
assert(/reference/i.test(await js(`document.getElementById('coach-text').textContent`)), 'coach advances to reference points');
await click('#coach-hide');
assert(await js(`document.getElementById('coach').hidden`), 'hide tips dismisses the coach');
assert(await js(`localStorage.getItem('house-measurer.coach')`) === 'done', 'dismissal persists');
// Wall-first path for the rest of the suite: turn walling on - the run
// gets seeded with the anchor pair.
assert(await js(`document.getElementById('pause-btn').textContent`) === 'walling: off', 'walling reads off by default');
await click('#modebar [data-mode="wall"]');
await settleFrame();
assert(await js(`document.getElementById('pause-btn').style.display`) !== 'none', 'walling toggle lives in walls mode');
await click('#pause-btn');
await click('#modebar [data-mode="measure"]');
st = await state();
assert(st.walls.length === 1 && st.walls[0].pts.length === 2, 'walling on seeds the run with A and B');
assert(await js(`localStorage.getItem('house-measurer.walling')`) === 'on', 'walling choice persists');

// C measured in perimeter order (refs kept as A, B): 4.27 m and 2.50 m.
// Entry is one box at a time now: OK advances, del on empty steps back.
await settleFrame();
assert(await js(`[...document.querySelectorAll('.field')].filter(f => f.style.display !== 'none').length`) === 1, 'a single input field shows');
assert(/1 of 2/.test(await js(`document.querySelector('#field0 label').textContent`)), 'first distance labelled 1 of 2');
await keys(['4', '2', '7']);
await key('ok');
assert(await js('window.app.ui.active') === 1, 'OK advances to the second distance');
assert(/2 of 2/.test(await js(`document.querySelector('#field1 label').textContent`)), 'second distance labelled 2 of 2');
assert(await js(`document.getElementById('field0').style.display`) === 'none', 'first box hidden while entering the second');
await key('del');
assert(await js('window.app.ui.active') === 0 && await js('window.app.ui.fields[0]') === '427', 'del on the empty second box steps back with the value intact');
await key('ok');
await keys(['2', '5', '0']);
await shot('03-candidates');
await key('ok');
st = await state();
assert(st.points.length === 3, 'C committed');
let posC = await js('[...window.app.store.solved.pos][2][1]');
assert(near(posC.x, 3.4620, 2e-3) && near(posC.y, 2.4996, 2e-3), `C at expected spot (${posC.x.toFixed(4)}, ${posC.y.toFixed(4)})`);
assert(st.walls[0].pts.length === 3, 'C auto-chained into the wall run');

await settleFrame();
assert(await js(`document.querySelector('[data-key="flip"]').style.display`) === 'none', 'keypad swap key hidden outside flows');
assert(await js(`document.getElementById('flip-btn').style.display`) !== 'none', 'flip button offered after a commit');
assert(await js(`document.getElementById('flip-btn').textContent`) === 'flip C', 'flip button names its target');
await click('#flip-btn');
posC = await js('[...window.app.store.solved.pos][2][1]');
assert(posC.y < 0, 'flip moves C to the other side');
await click('#flip-btn');

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

// Flip a mis-sided point AFTER later points were measured from it: select
// just C, flip (C mirrors, D re-solves), flip again (branch mirrors too).
await tapPoint('A'); // refs [A,C] -> [C]
refs = await js('window.app.ui.refs.map(id => window.app.store.point(id).name)');
assert(refs.join(',') === 'C', `single selection for the late flip (${refs})`);
assert(await js(`document.getElementById('flip-btn').textContent`) === 'flip C', 'flip button targets the selected point');
await click('#flip-btn');
let posCf = await js('[...window.app.store.solved.pos][2][1]');
let posDf = await js('[...window.app.store.solved.pos][3][1]');
assert(near(posCf.y, -2.4996, 2e-3), 'late flip mirrors C across the baseline');
assert(Math.abs(posDf.y - 2.921) > 0.2, 'D re-solved from the moved C');
assert(/press flip again/.test(await js(`document.getElementById('status').textContent`)), 'status offers mirroring the branch');
await click('#flip-btn');
posDf = await js('[...window.app.store.solved.pos][3][1]');
assert(near(posDf.x, 0.684, 3e-3) && near(posDf.y, -2.921, 3e-3), 'second flip lands D at the exact reflection');
await click('#undo');
await click('#undo');
posCf = await js('[...window.app.store.solved.pos][2][1]');
posDf = await js('[...window.app.store.solved.pos][3][1]');
assert(near(posCf.y, 2.4996, 2e-3) && near(posDf.y, 2.921, 3e-3), 'two undos restore both sides');
await js(`(() => { const app = window.app, pts = app.store.state.points; app.ui.refs = [pts[0].id, pts[2].id]; app.render(); })()`);

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

// Detail toggle: interior angles appear at every corner of the room.
await click('#show-work');
await settleFrame();
const angTexts = await js(`[...document.querySelectorAll('#overlay .lbl.ang')].map(l => l.textContent)`);
assert(angTexts.length === 4, `detail shows 4 corner angles (${angTexts.length})`);
assert(angTexts.some((t) => /^9[01]/.test(t)), `corner near B reads ~91 deg (${angTexts.join(' ')})`);
const angSum = angTexts.map((t) => parseInt(t)).reduce((a, b) => a + b, 0);
assert(Math.abs(angSum - 360) <= 2, `quad angles sum to ~360 (${angSum})`);
await click('#show-work');
await settleFrame();
assert(await js(`document.querySelectorAll('#overlay .lbl.ang').length`) === 0, 'detail off hides angles');

// Tap mid-wall A-B: edit thickness (55, stone) and height (both ends).
await settleFrame();
let vpt = await viewpos();
await tapAtRaw(Math.round((vpt.A.x + vpt.B.x) / 2), Math.round((vpt.A.y + vpt.B.y) / 2));
assert(await js('window.app.ui.flow?.kind') === 'wall-edit', 'wall tap opens the wall editor');
assert(await js('window.app.ui.flow?.zone') === 'mid', 'mid tap targets the whole top edge');
await keys(['5', '5']);
await key('ok'); // to the height field
await keys(['1', '2', '0']);
await key('ok');
st = await state();
assert(near(st.walls[0].thick?.['1:2'] ?? 0, 0.55), 'segment thickness stored (55 cm)');
assert(near(st.walls[0].segH?.['1:2']?.[0] ?? 0, 1.2) && near(st.walls[0].segH['1:2'][1], 1.2), 'uniform height stored');

// Tap near the A end: raise just that end (a sloped top edge).
await settleFrame();
vpt = await viewpos();
await tapAtRaw(Math.round(vpt.A.x * 0.8 + vpt.B.x * 0.2), Math.round(vpt.A.y * 0.8 + vpt.B.y * 0.2));
assert(await js('window.app.ui.flow?.zone') === 'a', 'end tap targets that end');
await key('ok'); // keep thickness
await keys(['2', '4', '0']);
await key('ok');
st = await state();
assert(near(st.walls[0].segH['1:2'][0], 2.4) && near(st.walls[0].segH['1:2'][1], 1.2), 'sloped top edge stored (240/120)');
await click('#undo'); // back to uniform 120 for later shots
assert(near((await state()).walls[0].segH['1:2'][0], 1.2), 'undo restores the slope edit');

// Unwall: a reference-only point leaves the outline but keeps existing.
await click('#modebar [data-mode="measure"]');
await js('window.app.ui.refs = []; window.app.render();');
await tapPoint('D');
assert(await js(`document.getElementById('unwall-btn').style.display`) !== 'none', 'unwall offered for a wall point');
await click('#unwall-btn');
st = await state();
assert(st.walls[0].pts.length === 3 && st.walls[0].closed, 'unwall reroutes the closed loop past the point');
assert(st.points.length === 4, 'the point itself survives');
await click('#undo');
assert((await state()).walls[0].pts.length === 4, 'undo restores the outline');

// --- check measurement + residuals + data sheet -----------------------------
await js('window.app.ui.refs = []; window.app.render();');
await tapPoint('A');
await tapPoint('D');
refs = await js('window.app.ui.refs.map(id => window.app.store.point(id).name)');
assert(refs.join(',') === 'A,D', `refs A,D selected (${refs})`);
// A and D are already tied by D's fix distance, so the button offers to
// change that value rather than to add a rival one for the same pair.
assert(await js(`document.getElementById('check-btn').textContent`) === 'edit', 'button reads edit for an already-measured pair');
// B and D have no direct measurement: a genuine redundant check.
// True |B-D| = 4.00 m; record 4.02 -> 2 cm disagreement.
await js('window.app.ui.refs = []; window.app.render();');
await tapPoint('B');
await tapPoint('D');
assert(await js(`document.getElementById('check-btn').textContent`) === 'record', 'button reads record for an unmeasured pair');
await keys(['4', '0', '2']);
await click('#check-btn');
assert(await js(`document.getElementById('check-btn').textContent`) === 'edit', 'button switches to edit once the pair is measured');
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
assert(logText.includes('B to D'), 'data sheet lists the check measurement');
assert(!/laser/i.test(logText), 'laser section moved out of the data sheet');
assert(/between/i.test(logText) && /measured/i.test(logText) && /error/i.test(logText), 'measurements table has column headings');
assert(/note \(what it is\)/i.test(logText), 'data sheet has a points section with notes');
{
  const noted = await js(`(() => {
    const inp = document.querySelectorAll('#log-list input[data-act="note"]')[2];
    inp.value = 'chimney corner';
    inp.dispatchEvent(new Event('change'));
    return window.app.store.state.points[2].note;
  })()`);
  assert(noted === 'chimney corner', `note saved from the data sheet (${noted})`);
  await js(`window.app.store.undo()`);
}
assert(await js(`!!document.getElementById('laser-btn')`), 'laser button present in header');
assert(await js(`document.getElementById('shoot-btn').style.display`) === 'none', 'shoot hidden without a triggerable meter');
// The data card is centred, not a bottom sheet running off-screen.
{
  const card = await js(`(() => {
    const r = document.getElementById('log-card').getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, ih: window.innerHeight };
  })()`);
  assert(card.top > 0 && card.bottom < card.ih, `data card fully on screen (${Math.round(card.top)}..${Math.round(card.bottom)} of ${card.ih})`);
}
assert(/ceiling 250 cm/.test(logText), 'data sheet shows the room ceiling');
assert(/cm/.test(logText), 'data sheet shows residuals');

// Edit the check measurement to the true 4.00 -> residuals shrink.
await js(`[...document.querySelectorAll('#log-list [data-act="edit"]')].at(-1).click()`);
await keys(['4', '0', '0']);
await key('ok');
st = await state();
assert(near(st.measurements.at(-1).d, 4.0), 'measurement edited via data sheet + keypad');

// Deleting a load-bearing measurement requires an explicit second press.
await click('#log-btn');
await js(`[...document.querySelectorAll('#log-list [data-act="del"]')].at(1).click()`);
st = await state();
assert(st.measurements.length === 6, 'fix measurement held back on first press');
const delWarn = await js(`document.getElementById('status').textContent`);
assert(/fixes C/.test(delWarn) && /unsolved/.test(delWarn), `deletion warning names the cascade (${delWarn.slice(0, 50)}...)`);
await js(`[...document.querySelectorAll('#log-list [data-act="del"]')].at(1).click()`);
st = await state();
assert(st.measurements.length === 5, 'second press deletes it');
await click('#undo');
assert((await state()).measurements.length === 6, 'undo restores the fix measurement');

// Break a fix distance: the point must NOT vanish - it shows as a red
// ghost with the reason, the status names it, and data explains it.
await js(`[...document.querySelectorAll('#log-list [data-act="edit"]')].at(1).click()`);
await keys(['9', '0', '0']); // A-C = 9 m: impossible against A-B = 3.42
await key('ok');
st = await state();
assert(!(await js(`[...window.app.store.solved.pos.keys()]`)).includes(st.points[2].id), 'C unsolved after the bad edit');
await settleFrame();
{
  const lbls = await js(`[...document.querySelectorAll('#overlay .lbl')].map(l => l.textContent)`);
  assert(lbls.some((t) => t === 'C?'), 'unsolved C still drawn as a ghost');
  assert(lbls.some((t) => /unsolved: circles miss by/.test(t)), `ghost carries the reason (${lbls.filter(t => /unsolved/.test(t))})`);
}
await js(`window.app.ui.message = null; window.app.ui.refs = []; window.app.render();`);
{
  const stat = await js(`document.getElementById('status').textContent`);
  assert(/cannot be placed/.test(stat) && /C/.test(stat), `status names the unsolved points (${stat.slice(0, 60)})`);
}
// The survey check spells out the diagnosis and the recovery steps.
assert(await js(`!document.getElementById('health-pill').hidden`), 'health pill appears for a broken survey');
assert(/err/.test(await js(`document.getElementById('health-pill').className`)), 'health pill red for an unsolved point');
await click('#health-pill');
{
  const doc = await js(`document.getElementById('doctor-list').innerText`);
  assert(/cannot be placed/.test(doc) && /circles miss/.test(doc), 'doctor names the unsolved point and reason');
  assert(/waiting on a broken point/.test(doc), 'downstream points grouped as waiting');
  assert(/Re-measure/.test(doc), 'doctor gives concrete recovery steps');
}
await click('#doctor-close');
assert(await js(`document.getElementById('doctor-sheet').hidden`), 'doctor closes');

await click('#log-btn');
{
  const logTxt = await js(`document.getElementById('log-list').innerText`);
  assert(/unsolved points/i.test(logTxt) && /circles miss/.test(logTxt), 'data sheet lists unsolved points with the reason');
  assert(/unsolved/.test(logTxt), 'broken measurements flagged');
}
// Repair the distance; everything solves and the warnings clear.
await js(`[...document.querySelectorAll('#log-list [data-act="edit"]')].at(1).click()`);
await keys(['4', '2', '7']);
await key('ok');
assert((await js(`[...window.app.store.solved.pos.keys()]`)).length === (await state()).points.length, 'repairing the distance re-solves every point');
await settleFrame();
assert(await js(`[...document.querySelectorAll('#overlay .lbl')].every(l => !/unsolved/.test(l.textContent))`), 'ghost and reason cleared');
assert(await js(`document.getElementById('health-pill').hidden`), 'health pill clears after the repair');
// A clean survey still opens the doctor on demand, via the data sheet.
await click('#log-btn');
await js(`[...document.querySelectorAll('#log-list [data-act="doctor"]')].at(0).click()`);
assert(await js(`!document.getElementById('doctor-sheet').hidden`), 'survey check opens from the data sheet');
assert(/No problems found/.test(await js(`document.getElementById('doctor-list').innerText`)), 'clean survey reports no problems');
await click('#doctor-close');

// A short drawn edge with no direct tie gets flagged (the slanted-stub
// lesson: 9 cm between points fixed by metres-long shots).
const ptsBeforeStub = (await state()).points.length;
await js(`(() => {
  const st = window.app.store, pts = st.state.points;
  const p = st.addPoint(pts[0].id, pts[1].id, 2.0, 2.6, 1, {});
  const q = st.addPoint(pts[0].id, pts[1].id, 2.08, 2.55, 1, {});
  st.addWallPoint(null, p);
  st.addWallPoint(st.state.walls.at(-1).id, q);
  window.app.render();
})()`);
assert(await js(`!document.getElementById('health-pill').hidden`), 'short unmeasured edge raises the pill');
await click('#health-pill');
assert(/short edge/.test(await js(`document.getElementById('doctor-list').innerText`)), 'doctor prescribes a direct tie for the short edge');
await click('#doctor-close');
for (let i = 0; i < 4; i++) await click('#undo');
assert((await state()).points.length === ptsBeforeStub, 'stub scenario unwound');
await click('#log-btn');
await click('#log-close');
// The transient unsolve pruned points from the refs; re-select the B-D
// check pair for the next tests.
await js(`(() => {
  const app = window.app, pts = app.store.state.points;
  app.ui.refs = [pts[1].id, pts[3].id];
  app.render();
})()`);
const bdId = (await state()).measurements.at(-1).id;
const bdVal = () => state().then((s) => s.measurements.find((m) => m.id === bdId).d);

// A wildly-off value is challenged before it can poison the survey. The
// pair is already measured, so this guards an edit - and insisting
// CHANGES that measurement rather than adding a rival one for the pair.
await keys(['6', '0', '0']); // 6 m against the true 4.00 m
await click('#check-btn');
assert(near(await bdVal(), 4.0), 'off-by-2m edit held back on first press');
let chkStatus = await js(`document.getElementById('status').textContent`);
assert(/again to keep/.test(chkStatus) && /apart/.test(chkStatus), `guard explains itself (${chkStatus.slice(0, 60)}...)`);
assert(/press edit again/i.test(chkStatus), 'guard names the button by its current label');
await click('#check-btn'); // insist
st = await state();
assert(st.measurements.length === 6, 'insisting updates in place, never duplicates the pair');
assert(near(await bdVal(), 6.0), 'the existing B-D measurement now holds the new value');
chkStatus = await js(`document.getElementById('status').textContent`);
assert(/updated/.test(chkStatus), 'message says updated');
await click('#undo');
assert(near(await bdVal(), 4.0), 'undo restores the previous value');

// Pressing with nothing typed opens a one-field flow; OK saves. On a
// measured pair that is an edit in place, never a duplicate.
assert(await js(`document.getElementById('check-btn').textContent`) === 'edit', 'measured pair offers edit');
await click('#check-btn');
assert(await js(`window.app.ui.flow?.kind`) === 'record', 'empty press starts the one-distance flow');
assert(await js(`document.querySelector('#field0 label').textContent`) === 'B to D', 'flow asks for the single distance, no 1-of-2');
assert(await js(`[...document.querySelectorAll('.field')].filter(f => f.style.display !== 'none').length`) === 1, 'one field in the flow');
assert(/Editing/.test(await js(`document.getElementById('status').textContent`)), 'flow prompt says editing and shows the current value');
await keys(['4', '0', '5']);
await key('ok');
st = await state();
assert(await js(`window.app.ui.flow`) === null, 'OK saves and ends the flow');
assert(st.measurements.length === 6, 'existing pair updated in place, not duplicated');
assert(near(await bdVal(), 4.05), 'the flow wrote the new value onto the same measurement');
await click('#undo');
assert(near(await bdVal(), 4.0), 'flow edit undoes');
// Free the pair so the record path gets exercised through the flow too.
await js(`window.app.store.deleteMeasurement(${bdId})`);
assert((await state()).measurements.length === 5, 'check measurement removed');
assert(await js(`document.getElementById('check-btn').textContent`) === 'record', 'freed pair reads record again');
await click('#check-btn');
assert(/type the measured distance/.test(await js(`document.getElementById('status').textContent`)), 'fresh pair prompt asks to record');
await keys(['4', '0', '0']);
await key('ok');
st = await state();
assert(st.measurements.length === 6 && near(st.measurements.at(-1).d, 4.0), 'freed pair gains a fresh check');
await click('#undo');
await click('#undo');
assert((await state()).measurements.length === 6, 'both steps undo back to the recorded check');
await js(`(() => {
  const app = window.app, pts = app.store.state.points;
  app.ui.refs = [pts[0].id, pts[3].id]; app.render();
})()`);

// --- point details on demand ------------------------------------------------
// Per-point numbers live in a sheet, not scattered over the plan.
await js(`window.app.ui.refs = []; window.app.render();`);
await tapPoint('D');
await settleFrame();
assert(await js(`document.getElementById('pt-info').style.display`) !== 'none', 'details offered for a single selected point');
assert(await js(`document.getElementById('pt-info').textContent`) === 'D details', 'details button names the point');
await click('#pt-info');
assert(await js(`!document.getElementById('point-sheet').hidden`), 'details sheet opens');
await shot('17-point-details');
{
  const info = await js(`document.getElementById('point-list').innerText`);
  assert(/Fixed from A and C/.test(info), `sheet says which references fixed D (${info.slice(0, 60).replace(/\n/g, ' ')})`);
  assert(/degrees/.test(info) && /Residual/.test(info), 'sheet reports the crossing angle and the residual');
  assert(/to A/.test(info) && /to C/.test(info) && /to B/.test(info), 'sheet lists every distance to D, check measurements included');
  assert(/flip, unwall and delete/.test(info), 'sheet points at where the actions live');
  assert(!/Best way to improve/.test(info), 'nothing to suggest while every other point is already tied to D');
}
// Add an untied point and the suggestion appears, naming it - a pair that
// is already measured (D to B) is never proposed, since re-shooting it
// adds no new constraint.
await click('#point-close');
const tmpName = await js(`(() => {
  const st = window.app.store, pts = st.state.points;
  const id = st.addPoint(pts[0].id, pts[1].id, 1.6, 2.2, 1, {});
  window.app.ui.refs = [pts[3].id];
  window.app.render();
  return st.point(id).name;
})()`);
await click('#pt-info');
{
  const info = await js(`document.getElementById('point-list').innerText`);
  assert(/Best way to improve it/.test(info), 'an untied neighbour becomes the suggested next shot');
  assert(info.includes(`Shoot D to ${tmpName}`), `the suggestion names the untied point (expected ${tmpName})`);
  assert(!/Shoot D to B/.test(info), 'a pair that is already measured is never suggested');
  await js(`[...document.querySelectorAll('#point-list .row button')].at(-1).click()`);
  assert((await js(`window.app.ui.refs.length`)) === 2, 'the suggestion selects the pair to measure');
}
await click('#undo');
await js(`(() => {
  const app = window.app;
  app.ui.refs = [app.store.state.points[3].id];
  app.render();
})()`);
await click('#pt-info');
// A distance row edits that measurement directly.
await js(`document.querySelector('#point-list [data-act="edit"]').click()`);
assert(await js(`window.app.ui.flow?.kind`) === 'edit-meas', 'a distance row edits that measurement');
assert(await js(`document.getElementById('point-sheet').hidden`), 'the sheet gets out of the way for the keypad');
await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
assert(await js(`window.app.ui.flow`) === null, 'Escape cancels the edit');
// Every point is reachable from the data sheet - including one that will
// not solve, which cannot be tapped on the plan at all.
await click('#log-btn');
await js(`document.querySelectorAll('#log-list [data-act="info"]')[0].click()`);
assert(await js(`!document.getElementById('point-sheet').hidden`), 'details reachable from the data sheet');
assert(/Anchor point/.test(await js(`document.getElementById('point-list').innerText`)), 'A reads as an anchor, not a fix');
await click('#point-close');
assert(await js(`document.getElementById('point-sheet').hidden`), 'details sheet closes');

// --- detail mode: the circles, and never an empty overlay -------------------
await js(`window.app.ui.refs = []; window.app.render();`);
await tapPoint('D');
await click('#show-work');
await settleFrame();
assert(await js(`window.app.plan.content.circles.length`) >= 3, 'detail draws a circle for every distance to the point, checks included');
assert(await js(`[...document.querySelectorAll('#overlay .lbl.ray')].some(l => /^[ABC] /.test(l.textContent))`), 'each ray label names its far end');
// Residual badges carry their point's name once detail is on - at 9 cm
// spacing a bare number belongs to nobody. Nudge the check measurement
// to make sure there is a residual to badge, then undo it.
await js(`window.app.store.updateMeasurement(window.app.store.state.measurements.at(-1).id, 4.06)`);
await settleFrame();
assert(await js(`[...document.querySelectorAll('#overlay .lbl.res')].some(l => /^[A-Z]+ [0-9]/.test(l.textContent))`), 'residual badges name their point in detail mode');
await click('#undo');
await settleFrame();
// Tapping another point switches what detail explains.
await tapPoint('C');
await settleFrame();
{
  const far = await js(`[...document.querySelectorAll('#overlay .lbl.ray')].map(l => l.textContent.slice(0, 1))`);
  assert(far.includes('D'), `detail follows the point just tapped (ray ends ${far.join(',')})`);
}
// Nothing selected, nothing placed and nothing picked (what a reload
// looks like): detail used to draw nothing at all here.
await js(`(() => {
  const ui = window.app.ui;
  ui.refs = []; ui.lastId = null; ui.detailPick = null;
  window.app.render();
})()`);
await settleFrame();
assert(await js(`window.app.plan.content.circles.length`) > 0, 'detail falls back to the newest point instead of drawing nothing');
{
  const overlaps = await js(`(() => {
    const ls = [...document.querySelectorAll('#overlay .lbl')].filter(l => l.style.display !== 'none');
    let n = 0;
    for (let i = 0; i < ls.length; i++) for (let j = i + 1; j < ls.length; j++) {
      const a = ls[i].getBoundingClientRect(), b = ls[j].getBoundingClientRect();
      if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) n++;
    }
    return n;
  })()`);
  assert(overlaps === 0, `no two labels sit on top of each other (${overlaps} overlapping pairs)`);
}
await shot('15-detail');
await click('#show-work');

// --- tapping a wall: what you tap is the band you see -----------------------
await js(`window.app.ui.refs = []; window.app.render();`);
await settleFrame();
const band = await js(`(() => {
  const segs = window.app.plan.content.segments.filter(s => s.style === 'wall');
  const s = segs.reduce((m, x) => (!m || x.t > m.t ? x : m), null);
  return { x: (s.x1 + s.x2) / 2, y: (s.y1 + s.y2) / 2, t: s.t };
})()`);
// Zoom until the band's offset from the line of marks is well outside
// finger slop: the case that made a thick wall untappable.
await js(`window.app.plan.setView(${band.x}, ${band.y}, 1.2)`);
await settleFrame();
const slopM = await js(`14 * window.app.plan.worldPerPx`);
assert(band.t / 2 > slopM * 2, `the drawn band sits far outside the old tolerance (${(band.t / 2 * 100).toFixed(1)} cm vs ${(slopM * 100).toFixed(1)} cm)`);
const bandPt = await js(`(() => {
  const r = document.getElementById('plan').getBoundingClientRect();
  const s = window.app.plan.worldToScreen(${band.x}, ${band.y});
  return { x: Math.round(r.left + s.x), y: Math.round(r.top + s.y) };
})()`);
await tapAtRaw(bandPt.x, bandPt.y);
assert(await js(`window.app.ui.flow?.kind`) === 'wall-edit', 'tapping the drawn band opens the wall editor in measure mode');
assert(await js(`window.app.plan.content.segments.some(s => s.style === 'wallActive')`), 'the segment being edited lights up');
await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
assert(await js(`window.app.ui.flow`) === null, 'Escape leaves the wall as it was');
// Mid-entry the same tap must not throw the typed value away.
await keys(['1', '2', '3']);
await settleFrame();
await tapAtRaw(bandPt.x, bandPt.y);
assert(await js(`window.app.ui.flow`) === null && await js(`window.app.ui.fields[0]`) === '123', 'a wall tap while a distance is half-typed is ignored');
await js(`window.app.ui.fields = ['','']; window.app.render();`);
await click('#fit');

// --- fold the panel away to see the plan ------------------------------------
await settleFrame();
const tallBefore = await js(`document.getElementById('canvas-wrap').clientHeight`);
await click('#panel-fold');
await settleFrame();
assert(await js(`document.getElementById('keypad').style.display`) === 'none', 'fold hides the keypad');
assert(await js(`document.getElementById('fields').style.display`) === 'none', 'fold hides the input box');
assert(await js(`document.getElementById('modebar').style.display`) !== 'none', 'mode buttons stay while folded');
assert(await js(`document.getElementById('refbar').style.display`) !== 'none', 'reference slots stay while folded');
assert(/show keypad/.test(await js(`document.getElementById('panel-fold').textContent`)), 'the handle offers to bring it back');
const tallAfter = await js(`document.getElementById('canvas-wrap').clientHeight`);
assert(tallAfter > tallBefore + 150, `the plan takes the space (${tallBefore} -> ${tallAfter} px)`);
await shot('16-folded');
// A reading that landed in a hidden field would be a trap.
await js(`window.app.laser.cb.onMeasurement(1.5)`);
assert(await js(`window.app.ui.panelHidden`) === false, 'a laser reading unfolds the panel');
assert(await js(`document.getElementById('fields').style.display`) !== 'none', 'the field is visible for it');
await js(`window.app.ui.fields = ['','']; window.app.render();`);
// So would a flow with no keypad.
await click('#panel-fold');
assert(await js(`window.app.ui.panelHidden`) === true, 'folded again');
await click('#log-btn');
await js(`document.querySelector('#log-list [data-act="edit"]').click()`);
assert(await js(`window.app.ui.panelHidden`) === false, 'starting an edit unfolds the keypad');
await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
await settleFrame();

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

await js(`window.app.pressKey('flip')`); // keyboard 'f' path: rotate the item
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

// In move mode, tapping a bare wall opens the wall editor too.
await settleFrame();
const vpm = await viewpos();
await tapAtRaw(Math.round((vpm.B.x + vpm.C.x) / 2), Math.round((vpm.B.y + vpm.C.y) / 2));
assert(await js('window.app.ui.flow?.kind') === 'wall-edit', 'move-mode wall tap opens the wall editor');
await key('ok');
await key('ok'); // both fields empty: wall unchanged, flow ends
assert(await js('window.app.ui.flow') === null, 'empty edit leaves the wall untouched');

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
assert(await js(`document.querySelector('[data-key="flip"]').style.display`) !== 'none', 'swap key appears in the side-choice flow');
assert(await js(`document.querySelector('[data-key="flip"]').textContent`) === 'swap', 'keypad key reads swap');
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
const visUi = await js(`(() => {
  const rows = [...document.querySelectorAll('#log-list .log-row')].filter(r => r.querySelector('[data-act="vis"]'));
  const pills = rows.map(r => r.querySelector('.pill')?.textContent ?? '');
  const btns = [...document.querySelectorAll('#log-list [data-act="vis"]')].map(b => b.textContent);
  return { pills, btns };
})()`);
assert(visUi.pills.length >= 2 && visUi.pills.every((t) => /shown|hidden/.test(t)), 'status pills show shown/hidden');
assert(visUi.btns.every((t) => /hide|show/.test(t)), 'visibility buttons are labelled with the action');
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
  const rec = v.tapTargets.find(t => t.pointId === pt.id);
  const vec = rec.mesh.position.clone();
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

// The ceiling dimension marker opens the height editor directly.
assert(await js('window.app.view3d.tapTargets.some(t => t.roomHeightWall != null)'), 'ceiling marker tappable in 3D');
await settleFrame();
const hm = await js(`(() => {
  const v = window.app.view3d;
  const rec = v.tapTargets.find(t => t.roomHeightWall != null);
  const r = document.getElementById('plan3d').getBoundingClientRect();
  const vec = rec.mesh.position.clone();
  vec.project(v.camera);
  return { x: Math.round(r.left + (vec.x + 1) / 2 * r.width), y: Math.round(r.top + (1 - vec.y) / 2 * r.height) };
})()`);
await tapAtRaw(hm.x, hm.y);
assert(await js('window.app.ui.flow?.kind') === 'room-height', 'marker tap opens the ceiling editor');
await keys(['2', '7', '0']);
await key('ok');
assert(near((await state()).walls[0].height, 2.7), 'ceiling edited from the 3D marker');
await click('#undo');
assert(near((await state()).walls[0].height, 2.5), 'undo restores the ceiling');

// Tap a solid wall face in 3D: the wall editor opens there too.
await settleFrame();
const wf = await js(`(() => {
  const v = window.app.view3d;
  const rec = v.wallRecs.find(w => w.mesh.material !== v.wallFaded);
  const r = document.getElementById('plan3d').getBoundingClientRect();
  const vec = new v.camera.position.constructor(rec.mid.x, 1.2, -rec.mid.y);
  vec.project(v.camera);
  return { x: Math.round(r.left + (vec.x + 1) / 2 * r.width), y: Math.round(r.top + (1 - vec.y) / 2 * r.height) };
})()`);
await tapAtRaw(wf.x, wf.y);
assert(await js('window.app.ui.flow?.kind') === 'wall-edit', '3D wall-face tap opens the wall editor');
await key('ok');
await key('ok'); // empty: unchanged
assert(await js('window.app.ui.flow') === null, '3D wall edit closes cleanly');

// Detail mode works inside 3D: corner angles + fix diagnostics as labels.
await click('#show-work3d');
await settleFrame();
assert(await js(`document.getElementById('show-work3d').classList.contains('on')`), '3D detail button lights up');
const angCount = await js(`[...document.querySelectorAll('#overlay3d .lbl.ang')].length`);
assert(angCount >= 3, `interior angles overlaid in 3D (${angCount})`);
await click('#show-work3d');
await settleFrame();
assert(await js(`[...document.querySelectorAll('#overlay3d .lbl.ang')].length`) === 0, '3D detail toggles off');
await shot('09-3d');
await click('#view3d-btn');
assert(await js('window.app.ui.view') === 'plan', 'back to plan');

// --- export / import --------------------------------------------------------
const exported = await js('window.app.exportString()');
assert(JSON.parse(exported).state.items.length === (await state()).items.length, 'export contains items');
await js(`window.app.store.clearAll()`);
assert((await state()).points.length === 0, 'cleared');

// Laser auto mode: in the empty state one reading measures the first wall.
await js('window.app.ui.autoLaser = true; window.app.laser.cb.onMeasurement(3.0)');
st = await state();
assert(st.points.length === 2 && near(st.measurements[0].d, 3.0), 'auto laser: anchor reading commits itself');
assert(st.walls[0]?.pts.length === 2, 'auto laser: first wall started');
await js('window.app.ui.autoLaser = false; window.app.store.clearAll()');
assert((await state()).points.length === 0, 're-cleared');

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

// Walling pause: a reference-only point commits without joining the run.
await click('#modebar [data-mode="wall"]');
await click('#pause-btn');
await click('#modebar [data-mode="measure"]');
await keys(['4', '2', '7']);
await key('ok');
await keys(['2', '5', '0']);
await key('ok');
st = await state();
assert(st.points.length === 7, 'paused commit still places the point');
assert(st.walls.at(-1).pts.length === 2, 'paused point stays out of the wall run');
await click('#undo');
await click('#modebar [data-mode="wall"]');
await click('#pause-btn'); // resume walling
await click('#modebar [data-mode="measure"]');
assert((await state()).points.length === 6, 'reference point undone for the walled retry');

await keys(['4', '2', '7']);
await key('ok');
await keys(['2', '5', '0']);
await settleFrame();
const propAng = await js(`[...document.querySelectorAll('#overlay .lbl.ang.prop')].map(l => l.textContent)`);
assert(propAng.length === 1 && /^9[01]/.test(propAng[0]), `proposed wall angle previews live (${propAng.join(' ')})`);
await key('ok');
st = await state();
assert(st.points.length === 7 && st.points.at(-1).floor === st.activeFloor, 'upstairs point committed');
assert(st.walls.at(-1).floor === st.activeFloor && st.walls.at(-1).pts.length === 3, 'upstairs auto-wall run E-F-G');
await click('#close-room');
await key('ok');
st = await state();
assert(st.walls.length === 2 && st.walls.at(-1).closed, 'upstairs room closed');

// Delete a mistaken point straight from the entry interface.
await js('window.app.ui.refs = []; window.app.render();');
await tapPoint('G');
assert(await js(`document.getElementById('del-point').style.display`) !== 'none', 'delete offered for a single selected point');
await click('#del-point');
st = await state();
assert(st.points.length === 6, 'point deleted in one tap (no dependents)');
assert(!st.walls.at(-1).closed && st.walls.at(-1).pts.length === 2, 'its wall link removed, loop re-opened');
await click('#undo');
st = await state();
assert(st.points.length === 7 && st.walls.at(-1).closed, 'undo restores point, link and closure');

// Derive the real floor-to-floor from the staircase: 13 risers of 22 cm
// with an odd 24 cm bottom step = 288 cm.
await click('#log-btn');
await js(`
  document.getElementById('fc-n').value = 13;
  document.getElementById('fc-r').value = 22;
  document.getElementById('fc-b').value = 24;
`);
await js(`[...document.querySelectorAll('#log-list [data-act="ap1"]')].at(0).click()`);
st = await state();
assert(near(st.floors[1].elevation, 2.88), `stair calculator sets the elevation (${(st.floors[1].elevation * 100).toFixed(1)} cm)`);
await click('#log-close');

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

// Raised floor section in the corner.
await click('#modebar [data-mode="item"]');
await click('#item-new');
await js(`
  document.getElementById('if-name').value = 'raised corner';
  document.getElementById('if-category').value = 'platform';
  document.getElementById('if-w').value = 180;
  document.getElementById('if-d').value = 140;
  document.getElementById('if-h').value = 16;
`);
await click('#if-place-drop');
st = await state();
assert(st.items.at(-1).category === 'platform' && near(st.items.at(-1).h, 0.16), 'raised floor platform added');

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

// Theme toggle: boots with the OS preference (either way), and the button
// flips document CSS, the plan canvas palette, persistence and a toast.
const bootTheme = await js(`document.documentElement.dataset.theme`);
assert(bootTheme === 'light' || bootTheme === 'dark', `boots with a resolved theme (${bootTheme})`);
if (bootTheme === 'dark') await shot('14-dark');
const flipped = bootTheme === 'dark' ? 'light' : 'dark';
await click('#theme-btn');
assert(await js(`document.documentElement.dataset.theme`) === flipped, `theme button flips to ${flipped}`);
{
  const bodyBg = await js(`getComputedStyle(document.body).backgroundColor`);
  const wantBg = flipped === 'dark' ? 'rgb(21, 22, 27)' : 'rgb(246, 244, 238)';
  assert(bodyBg === wantBg, `CSS variables follow the ${flipped} palette (${bodyBg})`);
  const gridHex = await js(`window.app.plan.grid.children[0].material.color.getHex()`);
  const wantGrid = flipped === 'dark' ? 0x1d1f26 : 0xe8e4d9;
  assert(gridHex === wantGrid, `plan grid rebuilt with the ${flipped} palette (0x${gridHex.toString(16)})`);
}
assert(await js(`[...document.querySelectorAll('#toasts .toast')].some(t => /${flipped} mode/i.test(t.textContent))`), 'theme change raises a toast');
assert(await js(`localStorage.getItem('house-measurer.theme')`) === flipped, 'explicit theme choice persists');
if (flipped === 'dark') await shot('14-dark');
await click('#theme-btn');
assert(await js(`document.documentElement.dataset.theme`) === bootTheme, 'theme toggles back');

// Laser panel: opens from the header, holds status pill, offset and frames.
await click('#laser-btn');
assert(await js(`!document.getElementById('laser-sheet').hidden`), 'laser button opens the laser panel');
assert(await js(`document.getElementById('laser-pill').textContent`) === 'off', 'laser pill reads off when disconnected');
assert(await js(`!document.getElementById('laser-connect').hidden`), 'connect button offered');
assert(await js(`document.getElementById('laser-disconnect').hidden`), 'disconnect hidden while off');
assert(Math.abs(parseFloat(await js(`document.getElementById('laser-off').value`)) - 10) < 0.01, 'remote offset shown in the panel (default 10 cm)');
await js(`document.getElementById('laser-off').value = '9.5'`);
await click('#laser-setlo');
assert(Math.abs(await js(`window.app.laser.remoteOffset`) - 0.095) < 1e-9, 'offset set from the panel');
assert(await js(`[...document.querySelectorAll('#toasts .toast')].some(t => /9.5 cm/.test(t.textContent))`), 'offset change raises a toast');
await js(`document.getElementById('laser-off').value = '10'`);
await click('#laser-setlo');

// Auto survey mode is configured here now.
assert(await js(`document.getElementById('auto-pill').textContent`) === 'off', 'auto mode reads off in the laser panel');
await click('#auto-btn');
assert(await js(`window.app.ui.autoLaser === true`), 'auto toggles on from the panel');
assert(await js(`document.getElementById('auto-pill').textContent`) === 'on', 'auto pill follows');
await click('#auto-btn');
assert(await js(`window.app.ui.autoLaser === false`), 'auto toggles back off');

// Calibration: guarded without a meter, and the full flow with a stub.
await click('#laser-cal');
assert(await js(`[...document.querySelectorAll('#toasts .toast')].some(t => /needs a connected/i.test(t.textContent))`), 'calibrate without a meter explains itself');
await js(`(() => {
  const l = window.app.laser;
  l.connected = true;
  l.deviceRef = 'back';
  l.boschChar = { properties: { write: false, writeWithoutResponse: true }, writeValueWithoutResponse: async () => {} };
})()`);
await click('#laser-cal');
assert(await js(`window.app.ui.laserCal?.stage`) === 'button', 'calibration waits for the button press');
assert(await js(`!document.getElementById('laser-cal-msg').hidden`), 'calibration instructions shown');
await js(`window.app.laser.cb.onMeasurement(2.527, { kind: 'push', raw: 2.527 })`);
assert(await js(`window.app.ui.laserCal?.stage`) === 'remote', 'button reading captured, remote shot fired');
await js(`window.app.laser.cb.onMeasurement(2.527, { kind: 'remote', raw: 2.427 })`);
assert(await js(`window.app.ui.laserCal`) === null, 'calibration completes');
assert(Math.abs(await js(`window.app.laser.remoteOffset`) - 0.1) < 1e-9, 'body length derived from push-minus-raw (100 mm)');
assert(await js(`[...document.querySelectorAll('#toasts .toast')].some(t => /Calibrated: body length 100.0 mm/.test(t.textContent))`), 'calibration announces the measured body length');

// OK doubles as the laser trigger while the field is empty, and the app
// marks which point to aim at (with its note when it has one).
await js(`window.app.setMode('measure')`);
await js(`(() => {
  const app = window.app, pts = app.store.state.points;
  app.store.setPointNote(pts[0].id, 'left window reveal');
  app.ui.refs = [pts[0].id, pts[1].id];
  app.ui.fields = ['', ''];
  app.ui.active = 0;
  app.render();
})()`);
assert(await js(`document.querySelector('[data-key="ok"]').textContent`) === 'shoot', 'OK becomes shoot with a meter connected and nothing typed');
assert(await js(`document.querySelector('[data-key="ok"]').classList.contains('shoot')`), 'shoot styling applied');
{
  const stat = await js(`document.getElementById('status').textContent`);
  assert(/Distance 1 of 2/.test(stat) && /left window reveal/.test(stat), `status names the mark and its note (${stat.slice(0, 60)})`);
  assert(!/aim|shoot at/i.test(stat), 'status implies no direction - a distance reads the same from either end');
}
// The cue lives in the reference slot and the field label, never on the plan.
assert(await js(`document.querySelector('#field0 label').textContent`) === 'to A - left window reveal (1 of 2)', 'field label carries the mark and its note');
{
  const now = await js(`[...document.querySelectorAll('.refslot')].map(e => e.className.includes('now'))`);
  assert(now[0] === true && now[1] === false, 'the slot being entered is the highlighted one');
}
await settleFrame();
assert(await js(`document.querySelectorAll('#overlay .lbl.aim').length`) === 0, 'nothing is drawn over the plan for aiming');
// The dot is held on while the reading is expected, so aiming does not
// need the meter's own button.
assert(await js(`window.app.laser.aiming === true`), 'aim keep-alive runs while a reading is expected');
// Pressing it fires the meter instead of committing.
await js(`window.app.laser._fired = 0; window.app.laser.remoteTrigger = async () => { window.app.laser._fired++; }`);
await key('ok');
assert(await js(`window.app.laser._fired`) === 1, 'the shoot key triggers the meter');
assert(await js(`window.app.ui.active`) === 0, 'shooting does not advance the field');
// A typed digit turns it back into a commit key.
await key('2');
assert(await js(`document.querySelector('[data-key="ok"]').textContent`) === 'OK', 'OK returns once a value is typed');
assert(await js(`window.app.laser.aiming === false`), 'a typed value stops the keep-alive');
await key('ok');
{
  const now = await js(`[...document.querySelectorAll('.refslot')].map(e => e.className.includes('now'))`);
  assert(now[0] === false && now[1] === true, 'the highlight follows to the second distance');
}
await key('del');
await key('del');
assert(await js(`document.querySelector('[data-key="ok"]').textContent`) === 'shoot', 'and back to shoot when cleared');
assert(await js(`window.app.laser.aiming === true`), 'clearing the field resumes the dot');
// The keep-alive can be switched off in the laser panel.
await click('#laser-btn');
assert(await js(`document.getElementById('aim-pill').textContent`) === 'on', 'panel shows the keep-alive on');
await click('#aim-btn');
assert(await js(`window.app.laser.aimEnabled === false && window.app.laser.aiming === false`), 'panel toggle stops the dot');
assert(await js(`localStorage.getItem('house-measurer.laserAim')`) === 'off', 'keep-alive preference persists');
await click('#aim-btn');
await click('#laser-close');
await js(`(() => { const app = window.app; app.ui.refs = []; app.ui.fields = ['','']; app.render(); })()`);

// With a meter connected, shoot lives on its own row - big and fully on
// screen at phone width (it used to fall off the wrapping refbar).
await js(`window.app.setMode('measure')`);
await settleFrame();
{
  const r = await js(`(() => {
    const b = document.getElementById('shoot-btn').getBoundingClientRect();
    return { y: b.y, w: b.width, right: b.right, bottom: b.bottom, iw: innerWidth, ih: innerHeight };
  })()`);
  assert(r.w > 120 && r.y > 0 && r.right <= r.iw && r.bottom <= r.ih,
    `shoot button prominent and fully on screen (${Math.round(r.w)}px wide at ${r.iw}px viewport)`);
}

// Continuous tracking: samples average into the field, nothing commits.
const ptsBeforeTrack = (await state()).points.length;
await js(`window.app.laser.cb.onTrack(1.500, { min: 1.489, max: 2.4 })`);
await js(`window.app.laser.cb.onTrack(1.504, { min: 1.489, max: 2.4 })`);
await js(`window.app.laser.cb.onTrack(1.496, { min: 1.489, max: 2.4 })`);
assert(await js(`window.app.ui.fields[window.app.ui.active]`) === '1.500', 'tracking averages into the active field');
assert(/average of 3/.test(await js(`document.getElementById('status').textContent`)), 'tracking status counts samples and shows meter min/max');
assert((await state()).points.length === ptsBeforeTrack, 'tracking commits nothing');
await js(`clearTimeout(window.app.ui.track?.timer); window.app.ui.track = null; window.app.ui.fields = ['', '']; window.app.render();`);

await js(`(() => { const l = window.app.laser; l.connected = false; l.boschChar = null; l.deviceRef = null; window.app.render(); })()`);

await click('#laser-close');
assert(await js(`document.getElementById('laser-sheet').hidden`), 'laser panel closes');

// Undo/redo live in the mode bar now, small but functional.
assert(await js(`document.getElementById('undo').closest('#modebar') !== null`), 'undo sits in the mode bar');

// No horizontal overflow at phone widths (pill + all header buttons live).
for (const w of [412, 360]) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: 915, deviceScaleFactor: 2, mobile: true });
  await settleFrame();
  const over = await js('document.documentElement.scrollWidth - window.innerWidth');
  assert(over <= 0, `no horizontal overflow at ${w}px (overflow ${over}px)`);
}
await send('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2, mobile: true });
await settleFrame();

// Laser auto mode drives the point loop: two readings = one point.
await click('#modebar [data-mode="measure"]');
await js(`(() => {
  const app = window.app, pts = app.store.state.points;
  app.ui.refs = [pts[0].id, pts[1].id];
  app.ui.autoLaser = true;
  app.render();
})()`);
const beforeAuto = await state();
await js('window.app.laser.cb.onMeasurement(2.0)');
assert(await js('window.app.ui.fields[0]') === '2.0' && await js('window.app.ui.active') === 1,
  'auto laser: first reading fills ref-1 and advances');
await js('window.app.laser.cb.onMeasurement(2.2)');
st = await state();
assert(st.points.length === beforeAuto.points.length + 1, 'auto laser: second reading commits the point');
assert(st.measurements.length === beforeAuto.measurements.length + 2, 'auto laser: both distances recorded');
await js('window.app.ui.autoLaser = false');
await click('#undo');
assert((await state()).points.length === beforeAuto.points.length, 'auto-committed point undoes in one step');

// Multi-reference fixing: 3 refs, sequential distances, auto side.
await js(`(() => {
  const app = window.app, pts = app.store.state.points;
  app.ui.refs = [pts[0].id, pts[1].id, pts[2].id];
  app.ui.multiD = [];
  app.render();
})()`);
assert(/1 of 3/.test(await js(`document.querySelector('#field0 label').textContent`)), 'multi-fix labels the sequence');
await keys(['2', '0', '8']);
await key('ok');
await keys(['2', '1', '0']);
await key('ok');
assert(await js('window.app.ui.multiD.length') === 2, 'two distances collected');
// A mis-fired reading steps back with del.
await key('del');
assert(await js('window.app.ui.multiD.length') === 1, 'del retracts the last collected reading');
await keys(['2', '1', '0']);
await key('ok');
await keys(['2', '1', '9']);
await key('ok');
st = await state();
assert(st.points.length === beforeAuto.points.length + 1, 'multi-fix commits after the last distance');
assert(st.measurements.length === beforeAuto.measurements.length + 3, 'fix pair plus extra recorded atomically');
assert(st.points.at(-1).fix.side === 1, 'side disambiguated by the third distance');
const mp = await js('(() => { const s = window.app.store; return s.solved.pos.get(s.state.points.at(-1).id); })()');
assert(mp.y > 0 && near(mp.x, 1.7, 0.05) && near(mp.y, 1.2, 0.05), `multi-fixed point lands where measured (${mp.x.toFixed(2)}, ${mp.y.toFixed(2)})`);
const mres = await js('(() => { const s = window.app.store; return (s.solved.pres.get(s.state.points.at(-1).id) || 0) * 100; })()');
assert(mres < 2, `redundant fix residual small (${mres.toFixed(2)} cm)`);
await click('#undo');
assert((await state()).points.length === beforeAuto.points.length, 'multi-fix undoes in one step');
await js('window.app.ui.refs = []; window.app.render();');

await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await sleep(400);
await settleFrame();
// The side-column layout gains nothing from folding, so the handle is
// not offered - and the keypad is back even if the phone was folded.
assert(await js(`document.getElementById('panel-fold').style.display`) === 'none', 'fold handle withdrawn in the side-panel layout');
assert(await js(`document.getElementById('keypad').style.display`) !== 'none', 'keypad shown in the side-panel layout');
await shot('11-desktop');
await js('window.app.toggle3D()');
await sleep(600);
await shot('12-desktop-3d');

console.log(problems.length ? `\nPROBLEMS (${problems.length}):\n` + problems.join('\n') : '\nNO PROBLEMS');
ws.close();
process.exit(problems.length ? 1 : 0);
