// Controller: wires the store, the plan view and the input panel together.

import { parseDistance, fmtDist, circleIntersect, CLAMP_TOL, pointName } from './geometry.js';
import { Store } from './state.js';
import { PlanView } from './plan.js';

const CAM_KEY = 'house-measurer.cam';
const $ = (id) => document.getElementById(id);

const store = new Store(window.localStorage);
store.load();

const ui = {
  refs: [],         // up to two point ids selected as references
  fields: ['', ''], // raw keypad strings
  active: 0,
  lastId: null,     // last committed point (flip target)
  message: null,    // transient status text {text, cls}
};

const plan = new PlanView($('plan'), $('overlay'), $('scalebar'), {
  onTap: handleTap,
  onCamera: saveCameraSoon,
});

// --- helpers ---------------------------------------------------------------

const mode = () => (store.state.points.length === 0 ? 'anchor' : 'measure');
const pos = (id) => store.solved.pos.get(id);

function say(text, cls = '') {
  ui.message = text ? { text, cls } : null;
  render();
}

function validateUi() {
  ui.refs = ui.refs.filter((id) => store.point(id) && pos(id));
  if (ui.lastId && !store.point(ui.lastId)) ui.lastId = null;
}

function preview() {
  // Current candidate positions from the two typed distances, or null.
  if (mode() !== 'measure' || ui.refs.length !== 2) return null;
  const d1 = parseDistance(ui.fields[0]);
  const d2 = parseDistance(ui.fields[1]);
  if (d1 == null || d2 == null) return { d1, d2, cands: null };
  const c = circleIntersect(pos(ui.refs[0]), d1, pos(ui.refs[1]), d2);
  if (!c.ok) return { d1, d2, cands: null };
  return { d1, d2, cands: c };
}

// --- actions ---------------------------------------------------------------

function toggleRef(id) {
  const i = ui.refs.indexOf(id);
  if (i >= 0) ui.refs.splice(i, 1);
  else if (ui.refs.length < 2) ui.refs.push(id);
  else ui.refs = [id];
  ui.message = null;
  render();
}

function commitAnchor() {
  const d = parseDistance(ui.fields[0]);
  if (d == null) return say('Type the distance between anchor A and anchor B', 'warn');
  const { a, b } = store.setAnchors(d);
  ui.refs = [a, b]; // next point is usually measured from A and B
  ui.fields = ['', ''];
  ui.active = 0;
  plan.fitAll([...store.solved.pos.values()]);
  say('A and B fixed. Tap 2 reference points, type the 2 distances.');
}

function commitPoint(side) {
  if (ui.refs.length !== 2) return say('Tap 2 reference points on the plan first', 'warn');
  const d1 = parseDistance(ui.fields[0]);
  const d2 = parseDistance(ui.fields[1]);
  if (d1 == null || d2 == null) {
    ui.active = d1 == null ? 0 : 1;
    return say('Type both distances, then OK', 'warn');
  }
  const c = circleIntersect(pos(ui.refs[0]), d1, pos(ui.refs[1]), d2);
  if (!c.ok) return say('Reference points coincide', 'warn');
  if (c.gap > CLAMP_TOL) {
    return say(`Circles miss by ${(c.gap * 100).toFixed(1)} cm - check the two distances`, 'err');
  }
  const name = pointName(store.state.points.length);
  ui.lastId = store.addPoint(ui.refs[0], ui.refs[1], d1, d2, side);
  ui.fields = ['', ''];
  ui.active = 0;
  const p = pos(ui.lastId);
  if (p && !plan.isOnScreen(p.x, p.y)) plan.fitAll([...store.solved.pos.values()]);
  say(`${name} placed - flip if it is on the wrong side`, 'good');
}

function pressKey(key) {
  const f = ui.fields;
  if (key >= '0' && key <= '9') {
    if (f[ui.active].length < 7) f[ui.active] += key;
    ui.message = null;
  } else if (key === '.') {
    if (!f[ui.active].includes('.')) f[ui.active] += '.';
  } else if (key === 'del') {
    f[ui.active] = f[ui.active].slice(0, -1);
  } else if (key === 'clear') {
    f[ui.active] = '';
  } else if (key === 'flip') {
    if (ui.lastId && store.point(ui.lastId)?.fix) store.flipSide(ui.lastId);
    return;
  } else if (key === 'ok') {
    if (mode() === 'anchor') return commitAnchor();
    if (ui.active === 0 && parseDistance(f[1]) == null) {
      if (parseDistance(f[0]) == null) return say('Type the distance to the first reference', 'warn');
      ui.active = 1;
    } else {
      return commitPoint(+1);
    }
  }
  render();
}

function handleTap(world, screen) {
  // Ghost candidates first (bigger target), then points.
  const pv = preview();
  if (pv && pv.cands && pv.cands.gap <= CLAMP_TOL) {
    for (const [side, p] of [[+1, pv.cands.left], [-1, pv.cands.right]]) {
      const sp = plan.worldToScreen(p.x, p.y);
      if (Math.hypot(sp.x - screen.x, sp.y - screen.y) < 30) return commitPoint(side);
    }
  }
  let best = null, bestD = 26;
  for (const pt of store.state.points) {
    const p = pos(pt.id);
    if (!p) continue;
    const sp = plan.worldToScreen(p.x, p.y);
    const d = Math.hypot(sp.x - screen.x, sp.y - screen.y);
    if (d < bestD) { best = pt.id; bestD = d; }
  }
  if (best != null) toggleRef(best);
}

// --- rendering -------------------------------------------------------------

function fieldLabel(i) {
  if (mode() === 'anchor') return 'distance A to B';
  const id = ui.refs[i];
  return id ? `to ${store.point(id).name}` : `to ref ${i + 1}`;
}

function renderPanel() {
  const m = mode();
  $('field1').style.display = m === 'anchor' ? 'none' : '';
  $('refbar').style.display = m === 'anchor' ? 'none' : '';

  for (const i of [0, 1]) {
    const el = $(`field${i}`);
    el.classList.toggle('active', ui.active === i);
    el.querySelector('label').textContent = fieldLabel(i);
    const v = ui.fields[i];
    el.querySelector('.val').textContent = v || ' ';
    el.classList.toggle('empty', !v);
    const d = parseDistance(v);
    el.querySelector('.interp').textContent = v ? (d != null ? `= ${fmtDist(d)}` : 'invalid') : ' ';
  }

  for (const i of [0, 1]) {
    const slot = $(`ref${i}`);
    const id = ui.refs[i];
    slot.textContent = id ? store.point(id).name : `tap ref ${i + 1}`;
    slot.classList.toggle('set', !!id);
  }

  const flip = document.querySelector('[data-key="flip"]');
  if (flip) flip.disabled = !(ui.lastId && store.point(ui.lastId)?.fix);

  // Status line: explicit message wins, else a contextual hint.
  let msg = ui.message;
  if (!msg) {
    if (m === 'anchor') msg = { text: 'Measure your two anchor marks and type the distance', cls: '' };
    else if (ui.refs.length < 2) msg = { text: 'Tap 2 reference points on the plan', cls: '' };
    else {
      const pv = preview();
      if (pv && pv.cands && pv.cands.gap > CLAMP_TOL) {
        msg = { text: `Circles miss by ${(pv.cands.gap * 100).toFixed(1)} cm`, cls: 'err' };
      } else if (pv && pv.cands) {
        msg = { text: 'OK places the marked candidate - or tap the other one', cls: '' };
      } else {
        msg = { text: `Type distances to ${store.point(ui.refs[0]).name} and ${store.point(ui.refs[1]).name}`, cls: '' };
      }
    }
  }
  $('status').textContent = msg.text;
  $('status').className = msg.cls;

  $('undo').disabled = !store.canUndo;
  $('redo').disabled = !store.canRedo;

  // Residual pill: clamp gap of the last placed point.
  const pill = $('gap-pill');
  if (ui.lastId && store.point(ui.lastId)?.fix) {
    const gap = (store.solved.gaps.get(ui.lastId) || 0) * 100;
    pill.hidden = false;
    pill.textContent = `${store.point(ui.lastId).name}: ${gap.toFixed(1)} cm`;
    pill.className = gap < 1 ? 'good' : gap < 3 ? 'warn' : 'err';
  } else {
    pill.hidden = true;
  }
}

function renderPlan() {
  const content = { points: [], segments: [], circles: [], ghosts: [], labels: [] };
  const pts = store.state.points;

  // Anchor-mode live preview: show A and B while the first distance is typed.
  if (mode() === 'anchor') {
    const d = parseDistance(ui.fields[0]);
    content.points.push({ x: 0, y: 0, style: 'anchor' });
    content.labels.push({ key: 'pA', x: 0, y: 0, text: 'A', cls: 'name', dy: -18 });
    if (d != null) {
      content.ghosts.push({ x: d, y: 0, primary: true });
      content.segments.push({ x1: 0, y1: 0, x2: d, y2: 0, style: 'ab' });
      content.labels.push({ key: 'pB', x: d, y: 0, text: 'B', cls: 'name', dy: -18 });
      content.labels.push({ key: 'dAB', x: d / 2, y: 0, text: fmtDist(d), cls: 'ray', dy: 14 });
      plan.fitAll([{ x: 0, y: 0 }, { x: d, y: 0 }]);
    }
    plan.update(content);
    return;
  }

  // The A-B baseline.
  const pA = pos(pts[0]?.id), pB = pos(pts[1]?.id);
  if (pA && pB) content.segments.push({ x1: pA.x, y1: pA.y, x2: pB.x, y2: pB.y, style: 'ab' });

  for (const pt of pts) {
    const p = pos(pt.id);
    if (!p) continue;
    content.points.push({
      x: p.x, y: p.y,
      style: pt.fix ? 'point' : 'anchor',
      refIndex: ui.refs.indexOf(pt.id) >= 0 ? ui.refs.indexOf(pt.id) : null,
      isLast: pt.id === ui.lastId,
    });
    content.labels.push({ key: `p${pt.id}`, x: p.x, y: p.y, text: pt.name, cls: 'name', dy: -18 });
  }

  // Live trilateration preview: circles, both candidates, rays + distances.
  const pv = preview();
  if (pv && pv.cands && pv.cands.gap <= CLAMP_TOL) {
    // When a new candidate pair appears off-screen, widen the view so both
    // are visible and tappable. Only on change, so manual panning sticks.
    const key = `${ui.refs.join(':')}:${pv.d1}:${pv.d2}`;
    if (key !== renderPlan.lastPreviewKey) {
      renderPlan.lastPreviewKey = key;
      const { left, right } = pv.cands;
      if (!plan.isOnScreen(left.x, left.y) || !plan.isOnScreen(right.x, right.y)) {
        plan.fitAll([...store.solved.pos.values(), left, right]);
      }
    }
  }
  if (pv) {
    const [r1, r2] = ui.refs.map(pos);
    if (pv.d1 != null) content.circles.push({ cx: r1.x, cy: r1.y, r: pv.d1 });
    if (pv.d2 != null) content.circles.push({ cx: r2.x, cy: r2.y, r: pv.d2 });
    if (pv.cands && pv.cands.gap <= CLAMP_TOL) {
      const name = pointName(pts.length);
      for (const [side, p, primary] of [[+1, pv.cands.left, true], [-1, pv.cands.right, false]]) {
        content.ghosts.push({ x: p.x, y: p.y, primary });
        content.labels.push({
          key: `gh${side}`, x: p.x, y: p.y,
          text: primary ? `${name}?` : 'or here',
          cls: primary ? 'ghost' : 'ghost dim', dy: -20,
        });
      }
      const t = pv.cands.left;
      content.segments.push({ x1: r1.x, y1: r1.y, x2: t.x, y2: t.y, style: 'ray' });
      content.segments.push({ x1: r2.x, y1: r2.y, x2: t.x, y2: t.y, style: 'ray' });
      content.labels.push({ key: 'rd1', x: (r1.x + t.x) / 2, y: (r1.y + t.y) / 2, text: fmtDist(pv.d1), cls: 'ray' });
      content.labels.push({ key: 'rd2', x: (r2.x + t.x) / 2, y: (r2.y + t.y) / 2, text: fmtDist(pv.d2), cls: 'ray' });
    }
  }

  plan.update(content);
}

function render() {
  validateUi();
  renderPanel();
  renderPlan();
}

// --- boot ------------------------------------------------------------------

function buildKeypad() {
  const keys = [
    ['1', '1'], ['2', '2'], ['3', '3'], ['del', 'del'],
    ['4', '4'], ['5', '5'], ['6', '6'], ['clear', 'C'],
    ['7', '7'], ['8', '8'], ['9', '9'], ['ok', 'OK'],
    ['.', '.'], ['0', '0'], ['flip', 'flip'],
  ];
  const pad = $('keypad');
  for (const [key, label] of keys) {
    const b = document.createElement('button');
    b.dataset.key = key;
    b.textContent = label;
    b.className = 'key ' + (/^[0-9.]$/.test(key) ? 'digit' : key);
    b.addEventListener('pointerdown', (e) => e.preventDefault()); // no focus steal
    b.addEventListener('click', () => pressKey(key));
    pad.appendChild(b);
  }
}

function saveCameraSoon() {
  clearTimeout(saveCameraSoon.t);
  saveCameraSoon.t = setTimeout(() => {
    try {
      localStorage.setItem(CAM_KEY, JSON.stringify({ cx: plan.cx, cy: plan.cy, viewH: plan.viewH }));
    } catch {}
  }, 400);
}

function restoreCamera() {
  try {
    const cam = JSON.parse(localStorage.getItem(CAM_KEY));
    if (cam && isFinite(cam.cx) && store.state.points.length) {
      plan.setView(cam.cx, cam.cy, cam.viewH);
      return;
    }
  } catch {}
  plan.fitAll([...store.solved.pos.values()]);
}

buildKeypad();

$('undo').addEventListener('click', () => store.undo());
$('redo').addEventListener('click', () => store.redo());
$('fit').addEventListener('click', () => plan.fitAll([...store.solved.pos.values()]));
$('help').addEventListener('click', () => { $('help-overlay').hidden = false; });
$('help-close').addEventListener('click', () => { $('help-overlay').hidden = true; });
$('help-overlay').addEventListener('click', (e) => {
  if (e.target === $('help-overlay')) $('help-overlay').hidden = true;
});
$('clear-all').addEventListener('click', (e) => {
  const b = e.target;
  if (b.dataset.armed) {
    store.clearAll();
    ui.refs = []; ui.fields = ['', '']; ui.lastId = null; ui.active = 0;
    delete b.dataset.armed;
    b.textContent = 'clear everything';
    $('help-overlay').hidden = true;
    plan.fitAll([]);
  } else {
    b.dataset.armed = '1';
    b.textContent = 'tap again to really clear';
    setTimeout(() => { delete b.dataset.armed; b.textContent = 'clear everything'; }, 3000);
  }
});

for (const i of [0, 1]) {
  $(`field${i}`).addEventListener('click', () => { ui.active = i; render(); });
}

// Physical keyboard (Chromebook / laptop).
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); return void store.undo(); }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Z')) { e.preventDefault(); return void store.redo(); }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key >= '0' && e.key <= '9') return pressKey(e.key);
  if (e.key === '.' || e.key === ',') return pressKey('.');
  if (e.key === 'Backspace') return pressKey('del');
  if (e.key === 'Enter') { e.preventDefault(); return pressKey('ok'); }
  if (e.key === 'Tab') { e.preventDefault(); ui.active = 1 - ui.active; return render(); }
  if (e.key === 'f') return pressKey('flip');
  if (e.key === 'Escape') {
    if (ui.fields[ui.active]) ui.fields[ui.active] = '';
    else ui.refs = [];
    return render();
  }
});

store.onChange(render);
restoreCamera();
render();

// Debug / test hooks.
window.app = { store, plan, ui, render, pressKey, toggleRef };
