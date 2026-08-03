// End-to-end drive of the real UI in headless Chrome via CDP (no deps;
// node >= 22 for the global WebSocket). Exercises keypad, canvas taps,
// ghost disambiguation, flip, undo/redo and reload persistence, and drops
// screenshots into $SHOTS (default cwd).
//
// Usage:
//   python3 -m http.server 8017            # from the repo root
//   google-chrome --headless=new --remote-debugging-port=9333 \
//     --user-data-dir=/tmp/hm-profile --window-size=412,915 about:blank &
//   SHOTS=/tmp/hm-shots node test/browser-drive.mjs
//
// NOTE: clears the app's localStorage in that Chrome profile.
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

const wsUrl = await connect();
const ws = new WebSocket(wsUrl);
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
  } else if (m.method === 'Log.entryAdded' && m.params.entry.level !== 'info') {
    problems.push(`LOG ${m.params.entry.level}: ${m.params.entry.text}`.slice(0, 300));
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

async function shot(name) {
  await sleep(150); // let rAF render
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${SHOTS}/${name}.png`, Buffer.from(r.data, 'base64'));
  console.log('shot', name);
}

async function tapAt(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await sleep(40);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await sleep(80);
}

const key = (k) => js(`document.querySelector('[data-key="${k}"]').click()`);
const keys = async (s) => { for (const k of s) { await key(k); await sleep(30); } };

function assert(cond, label) {
  if (cond) console.log('ok  ', label);
  else { console.log('FAIL', label); problems.push('ASSERT: ' + label); }
}
const near = (a, b, eps = 1e-4) => Math.abs(a - b) < eps;

await send('Runtime.enable');
await send('Page.enable');
await send('Log.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url: APP });
for (let i = 0; i < 40 && !(await js('!!window.app').catch(() => false)); i++) await sleep(200);
assert(await js('!!window.app'), 'app booted');
await js('localStorage.clear(); location.reload();');
await sleep(800);
for (let i = 0; i < 40 && !(await js('!!window.app').catch(() => false)); i++) await sleep(200);

await shot('01-empty');

// Anchor A-B = 342 cm
await keys(['3', '4', '2']);
await shot('02-anchor-typing');
await key('ok');
let st = await js('JSON.stringify(window.app.store.state)').then(JSON.parse);
assert(st.points.length === 2, 'anchors created');
assert(near(st.measurements[0].d, 3.42), 'A-B = 3.42 m');
await shot('03-anchors');

// C from A (300) and B (400)
await keys(['3', '0', '0']);
await key('ok');
assert(await js('window.app.ui.active') === 1, 'OK advances to second field');
await keys(['4', '0', '0']);
await shot('04-candidates');
await key('ok');
st = await js('JSON.stringify(window.app.store.state)').then(JSON.parse);
assert(st.points.length === 3, 'C committed');
let posC = await js('(() => { const p = [...window.app.store.solved.pos]; return p[2][1]; })()');
assert(near(posC.x, 0.68661, 1e-3) && near(posC.y, 2.92108, 1e-3), `C at expected spot (got ${posC.x.toFixed(4)}, ${posC.y.toFixed(4)})`);
await shot('05-C-committed');

// Flip side
await key('flip');
posC = await js('[...window.app.store.solved.pos][2][1]');
assert(near(posC.y, -2.92108, 1e-3), 'flip moves C to the right side');
await key('flip');
posC = await js('[...window.app.store.solved.pos][2][1]');
assert(posC.y > 0, 'flip back');

// Select refs B and C by tapping the canvas (A is currently ref -> tap removes it)
const vp = await js(`(() => {
  const r = document.getElementById('plan').getBoundingClientRect();
  const out = {};
  for (const pt of window.app.store.state.points) {
    const p = window.app.store.solved.pos.get(pt.id);
    const s = window.app.plan.worldToScreen(p.x, p.y);
    out[pt.name] = { x: Math.round(r.left + s.x), y: Math.round(r.top + s.y) };
  }
  return out;
})()`);
await tapAt(vp.A.x, vp.A.y); // deselect A -> refs [B]
let refs = await js('window.app.ui.refs.map(id => window.app.store.point(id).name)');
assert(refs.join('') === 'B', `tap toggles ref off (refs: ${refs})`);
await tapAt(vp.C.x, vp.C.y); // -> refs [B, C]
refs = await js('window.app.ui.refs.map(id => window.app.store.point(id).name)');
assert(refs.join(',') === 'B,C', `taps select refs B,C (refs: ${refs})`);

// D from B (250) and C (280)
await keys(['2', '5', '0']);
await key('ok');
await keys(['2', '8', '0']);
await shot('06-candidates-BC');
// Tap the secondary (right-side) ghost to choose the other candidate.
// Compute its viewport position analytically from the store.
const rightGhost = await js(`(() => {
  const app = window.app, st = app.store, ui = app.ui;
  const P = st.solved.pos.get(ui.refs[0]), Q = st.solved.pos.get(ui.refs[1]);
  const d1 = 2.5, d2 = 2.8;
  const dx = Q.x - P.x, dy = Q.y - P.y, d = Math.hypot(dx, dy);
  const ux = dx / d, uy = dy / d, a = (d1 * d1 - d2 * d2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, d1 * d1 - a * a));
  const bx = P.x + ux * a, by = P.y + uy * a;
  const right = { x: bx + uy * h, y: by - ux * h };
  const r = document.getElementById('plan').getBoundingClientRect();
  const s = app.plan.worldToScreen(right.x, right.y);
  return { x: Math.round(r.left + s.x), y: Math.round(r.top + s.y), world: right,
           view: { cx: app.plan.cx, cy: app.plan.cy, viewH: app.plan.viewH, w: app.plan.w, h: app.plan.h } };
})()`);
console.log('right ghost at', JSON.stringify(rightGhost));
assert(await js(`document.querySelectorAll('.lbl.ghost').length`) >= 1, 'ghost labels rendered');
await tapAt(rightGhost.x, rightGhost.y);
st = await js('JSON.stringify(window.app.store.state)').then(JSON.parse);
if (st.points.length !== 4) {
  console.log('DEBUG ui:', JSON.stringify(await js('({refs: window.app.ui.refs, fields: window.app.ui.fields, active: window.app.ui.active, msg: document.getElementById("status").textContent})')));
}
assert(st.points.length === 4, 'D committed by tapping ghost');
assert(st.points[3]?.fix?.side === -1, 'ghost tap chose the right-hand side');
await shot('07-D-committed');

// Undo / redo via header buttons
await js(`document.getElementById('undo').click()`);
st = await js('JSON.stringify(window.app.store.state)').then(JSON.parse);
assert(st.points.length === 3, 'undo removes D');
await js(`document.getElementById('redo').click()`);
st = await js('JSON.stringify(window.app.store.state)').then(JSON.parse);
assert(st.points.length === 4, 'redo restores D');

// Persistence across reload
await send('Page.navigate', { url: APP });
await sleep(1000);
st = await js('JSON.stringify(window.app.store.state)').then(JSON.parse);
assert(st.points.length === 4, 'state survives reload');
assert(await js('window.app.store.canUndo'), 'undo history survives reload');
await shot('08-after-reload');

// Desktop layout
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await sleep(400);
await shot('09-desktop');

console.log(problems.length ? `\nPROBLEMS (${problems.length}):\n` + problems.join('\n') : '\nNO PROBLEMS');
ws.close();
process.exit(problems.length ? 1 : 0);
