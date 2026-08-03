// Controller: wires the store, the plan view, the 3D view and the input
// panel together. All interaction flows live here.

import {
  parseDistance, fmtDist, circleIntersect, CLAMP_TOL, pointName,
  pointSegDist, itemCorners, pointInItem,
} from './geometry.js';
import { Store } from './state.js';
import { PlanView } from './plan.js';
import { View3D } from './view3d.js';
import { CATEGORIES, PRESETS, WALL_CATEGORIES, categoryColor } from './items.js';

const CAM_KEY = 'house-measurer.cam';
const $ = (id) => document.getElementById(id);

const store = new Store(window.localStorage);
store.load();

const ui = {
  mode: 'measure',   // measure | wall | item | move
  view: 'plan',      // plan | 3d
  refs: [],          // up to two point ids selected as references
  fields: ['', ''],  // raw keypad strings
  active: 0,
  lastId: null,      // last committed point (flip target in measure mode)
  message: null,
  activeWallId: null,
  selItem: null,
  flow: null,        // placement / edit flow, see startFlow()
  flowSide: 1,       // candidate side while a flow preview is active
  drag: null,        // transient item drag (not yet committed)
};

const plan = new PlanView($('plan'), $('overlay'), $('scalebar'), {
  onTap: handleTap,
  onCamera: saveCameraSoon,
  onDragStart: handleDragStart,
  onDragMove: handleDragMove,
  onDragEnd: handleDragEnd,
});
let view3d = null; // created lazily on first 3D toggle

// --- helpers ---------------------------------------------------------------

const anchorMode = () => store.state.points.length === 0;
const pos = (id) => store.solved.pos.get(id);
const twoFieldFlow = () => !ui.flow || ui.flow.kind === 'item-c1' || ui.flow.kind === 'item-c2';

function say(text, cls = '') {
  ui.message = text ? { text, cls } : null;
  render();
}

function visibleLayers() {
  return new Set(store.state.layers.filter((l) => l.visible).map((l) => l.id));
}

function validateUi() {
  ui.refs = ui.refs.filter((id) => store.point(id) && pos(id));
  if (ui.lastId && !store.point(ui.lastId)) ui.lastId = null;
  if (ui.selItem && !store.item(ui.selItem)) ui.selItem = null;
  if (ui.activeWallId && !store.wall(ui.activeWallId)) ui.activeWallId = null;
}

// Candidate positions from the two typed distances against the two refs.
function preview() {
  if (ui.refs.length !== 2 || !twoFieldFlow()) return null;
  const d1 = parseDistance(ui.fields[0]);
  const d2 = parseDistance(ui.fields[1]);
  if (d1 == null || d2 == null) return { d1, d2, cands: null };
  const c = circleIntersect(pos(ui.refs[0]), d1, pos(ui.refs[1]), d2);
  if (!c.ok) return { d1, d2, cands: null };
  return { d1, d2, cands: c };
}

function wallSegments() {
  const segs = [];
  for (const wall of store.state.walls) {
    const runs = wall.closed ? [...wall.pts, wall.pts[0]] : wall.pts;
    for (let i = 0; i + 1 < runs.length; i++) {
      const a = pos(runs[i]), b = pos(runs[i + 1]);
      if (a && b) segs.push({ wallId: wall.id, seg: i, a, b, pa: runs[i], pb: runs[i + 1] });
    }
  }
  return segs;
}

function hitWall(world, screen) {
  const s = plan.worldPerPx;
  let best = null, bestD = 14 * s;
  for (const seg of wallSegments()) {
    const r = pointSegDist(world, seg.a, seg.b);
    if (r.d < bestD) { best = { ...seg, t: r.t }; bestD = r.d; }
  }
  return best;
}

function hitPoint(screen) {
  let best = null, bestD = 26;
  for (const pt of store.state.points) {
    const p = pos(pt.id);
    if (!p) continue;
    const sp = plan.worldToScreen(p.x, p.y);
    const d = Math.hypot(sp.x - screen.x, sp.y - screen.y);
    if (d < bestD) { best = pt.id; bestD = d; }
  }
  return best;
}

function hitItem(world) {
  const vis = visibleLayers();
  const items = store.state.items.filter((i) => vis.has(i.layer));
  for (let i = items.length - 1; i >= 0; i--) {
    if (pointInItem(world, items[i], 2 * plan.worldPerPx)) return items[i].id;
  }
  return null;
}

// --- flows -----------------------------------------------------------------
// null                                : measure mode fixes new points
// { kind: 'item-c1', draft }          : two distances fix item corner 1
// { kind: 'item-c2', draft, c1 }      : two distances fix corner 2, or tap a
//                                       wall to align, or OK to keep width
// { kind: 'item-side', draft, c1, dir, wEff } : choose rect side, OK commits
// { kind: 'item-wallmount', draft }   : tap a wall segment
// { kind: 'item-walloffset', draft, wall, endIdx } : offset from wall end
// { kind: 'edit-meas', measId }       : keypad edits one measurement

function startFlow(flow, msg) {
  ui.flow = flow;
  ui.flowSide = 1;
  ui.fields = ['', ''];
  ui.active = 0;
  say(msg);
}

function endFlow(msg, cls) {
  ui.flow = null;
  ui.fields = ['', ''];
  ui.active = 0;
  say(msg || null, cls);
}

function sideCandidates(flow) {
  // Two rect placements for corner c1 + direction dir: depth on either side.
  const { draft, c1, dir, wEff } = flow;
  const n = { x: -dir.y, y: dir.x };
  const rot = Math.atan2(dir.y, dir.x);
  return [1, -1].map((side) => ({
    side,
    rect: {
      x: c1.x + dir.x * wEff / 2 + n.x * side * draft.d / 2,
      y: c1.y + dir.y * wEff / 2 + n.y * side * draft.d / 2,
      rot, w: wEff, d: draft.d,
    },
  }));
}

function wallOffsetPreview(flow) {
  const off = parseDistance(ui.fields[0]) ?? 0;
  const { wall, endIdx, draft } = flow;
  const e = endIdx === 0 ? wall.a : wall.b;
  const o = endIdx === 0 ? wall.b : wall.a;
  const len = Math.hypot(o.x - e.x, o.y - e.y) || 1;
  const u = { x: (o.x - e.x) / len, y: (o.y - e.y) / len };
  const n = { x: -u.y, y: u.x };
  const rot = Math.atan2(u.y, u.x);
  const cx = e.x + u.x * (off + draft.w / 2);
  const cy = e.y + u.y * (off + draft.w / 2);
  const centred = draft.category === 'window' || draft.category === 'door';
  const shift = centred ? 0 : (draft.d / 2 + 0.04) * ui.flowSide;
  return {
    endPoint: e, u, rot, centred,
    rect: { x: cx + n.x * shift, y: cy + n.y * shift, rot, w: draft.w, d: draft.d },
  };
}

function commitItemAt(rect, draft, mount = null) {
  const id = store.addItem({
    ...draft, x: rect.x, y: rect.y, rot: rect.rot, w: rect.w ?? draft.w, mount,
  });
  ui.mode = 'move';
  ui.selItem = id;
  endFlow(`${draft.name} placed - drag to adjust, lock when happy`, 'good');
  return id;
}

// --- measure-mode actions --------------------------------------------------

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
  ui.refs = [a, b];
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
  // Corner flows share the two-distance commit path.
  if (ui.flow?.kind === 'item-c1') {
    ui.flow = { kind: 'item-c2', draft: ui.flow.draft, c1: side >= 0 ? c.left : c.right };
    ui.fields = ['', ''];
    ui.active = 0;
    ui.flowSide = 1;
    return say('Corner 2: two distances, or tap a wall to align, or OK to use item width');
  }
  if (ui.flow?.kind === 'item-c2') {
    const c2 = side >= 0 ? c.left : c.right;
    const dx = c2.x - ui.flow.c1.x, dy = c2.y - ui.flow.c1.y;
    const wEff = Math.hypot(dx, dy);
    if (wEff < 0.02) return say('Corners coincide - measure the far corner', 'warn');
    ui.flow = {
      kind: 'item-side', draft: ui.flow.draft, c1: ui.flow.c1,
      dir: { x: dx / wEff, y: dy / wEff }, wEff,
    };
    ui.fields = ['', ''];
    ui.flowSide = 1;
    return say('Tap the rectangle that matches reality (flip swaps), OK commits');
  }
  const name = pointName(store.state.points.length);
  ui.lastId = store.addPoint(ui.refs[0], ui.refs[1], d1, d2, side);
  ui.fields = ['', ''];
  ui.active = 0;
  const p = pos(ui.lastId);
  if (p && !plan.isOnScreen(p.x, p.y)) plan.fitAll([...store.solved.pos.values()]);
  say(`${name} placed - flip if it is on the wrong side`, 'good');
}

function commitCheck() {
  if (ui.refs.length !== 2) return say('Tap 2 points to record a distance between them', 'warn');
  const v = parseDistance(ui.fields[ui.active]) ?? parseDistance(ui.fields[0]);
  if (v == null) return say('Type the measured distance first', 'warn');
  const id = store.addMeasurement(ui.refs[0], ui.refs[1], v);
  const r = (store.solved.mres.get(id) || 0) * 100;
  ui.fields = ['', ''];
  ui.active = 0;
  const cls = Math.abs(r) < 1 ? 'good' : Math.abs(r) < 3 ? 'warn' : 'err';
  say(`Check recorded - residual ${r.toFixed(1)} cm`, cls);
}

// --- keypad ----------------------------------------------------------------

function pressKey(key) {
  const f = ui.fields;
  if (anchorMode() || ['measure'].includes(ui.mode) || twoFieldFlow() || ui.flow) {
    if (key >= '0' && key <= '9') {
      if (f[ui.active].length < 7) f[ui.active] += key;
      ui.message = null;
    } else if (key === '.') {
      if (!f[ui.active].includes('.')) f[ui.active] += '.';
    } else if (key === 'del') {
      f[ui.active] = f[ui.active].slice(0, -1);
    } else if (key === 'clear') {
      f[ui.active] = '';
    }
  }

  if (key === 'flip') return pressFlip();
  if (key === 'ok') return pressOk();
  render();
}

function pressFlip() {
  if (ui.flow?.kind === 'item-side' || ui.flow?.kind === 'item-walloffset'
    || ((ui.flow?.kind === 'item-c1' || ui.flow?.kind === 'item-c2') && preview()?.cands)) {
    ui.flowSide *= -1;
    return render();
  }
  if (ui.mode === 'move' && ui.selItem) {
    const it = store.item(ui.selItem);
    if (it && !it.locked) store.updateItem(ui.selItem, { rot: it.rot + Math.PI / 2 });
    return;
  }
  if (ui.lastId && store.point(ui.lastId)?.fix) store.flipSide(ui.lastId);
}

function pressOk() {
  if (anchorMode()) return commitAnchor();

  if (ui.flow?.kind === 'item-side') {
    const cand = sideCandidates(ui.flow).find((c) => c.side === ui.flowSide);
    return commitItemAt(cand.rect, ui.flow.draft);
  }
  if (ui.flow?.kind === 'item-walloffset') {
    if (parseDistance(ui.fields[0]) == null) return say('Type the distance from the wall end to the item edge', 'warn');
    const pvw = wallOffsetPreview(ui.flow);
    return commitItemAt(pvw.rect, ui.flow.draft, { wallId: ui.flow.wall.wallId, seg: ui.flow.wall.seg });
  }
  if (ui.flow?.kind === 'edit-meas') {
    const v = parseDistance(ui.fields[0]);
    if (v == null) return say('Type the corrected distance', 'warn');
    store.updateMeasurement(ui.flow.measId, v);
    return endFlow('Measurement updated', 'good');
  }
  if (ui.flow?.kind === 'item-c2' && parseDistance(ui.fields[0]) == null && parseDistance(ui.fields[1]) == null) {
    // Keep the item's own width, axis-aligned; rotate/drag later.
    ui.flow = { kind: 'item-side', draft: ui.flow.draft, c1: ui.flow.c1, dir: { x: 1, y: 0 }, wEff: ui.flow.draft.w };
    ui.flowSide = 1;
    return say('Tap the rectangle that matches reality (flip swaps), OK commits');
  }

  if (twoFieldFlow()) {
    if (ui.active === 0 && parseDistance(ui.fields[1]) == null) {
      if (parseDistance(ui.fields[0]) == null) return say('Type the distance to the first reference', 'warn');
      ui.active = 1;
      return render();
    }
    return commitPoint(ui.flowSide);
  }
}

// --- canvas interaction ----------------------------------------------------

function handleTap(world, screen) {
  if (ui.view === '3d') return;

  if (ui.mode === 'wall') {
    const pid = hitPoint(screen);
    if (pid == null) return;
    const r = store.addWallPoint(ui.activeWallId, pid);
    ui.activeWallId = r.closed ? null : r.wallId;
    say(r.closed ? 'Room outline closed' : 'Wall: tap the next point (first point again closes)', r.closed ? 'good' : '');
    return;
  }

  if (ui.mode === 'move' && !ui.flow) {
    const iid = hitItem(world);
    ui.selItem = iid;
    ui.message = null;
    return render();
  }

  if (ui.flow?.kind === 'item-side') {
    for (const cand of sideCandidates(ui.flow)) {
      if (pointInItem(world, { ...cand.rect }, 4 * plan.worldPerPx)) {
        return commitItemAt(cand.rect, ui.flow.draft);
      }
    }
    return;
  }
  if (ui.flow?.kind === 'item-wallmount') {
    const wall = hitWall(world, screen);
    if (!wall) return say('Tap a wall segment (draw walls first in wall mode)', 'warn');
    const nearEnd = wall.t <= 0.5 ? 0 : 1;
    ui.flow = { kind: 'item-walloffset', draft: ui.flow.draft, wall, endIdx: nearEnd };
    ui.fields = ['', ''];
    ui.active = 0;
    ui.flowSide = 1;
    return say('Distance from the marked wall end to the item edge (flip swaps end)');
  }
  if (ui.flow?.kind === 'item-c2') {
    // A wall tap aligns the item with that wall, extending toward the tap.
    const pv = preview();
    const ghostHit = pv?.cands && pv.cands.gap <= CLAMP_TOL &&
      [pv.cands.left, pv.cands.right].some((p) => {
        const sp = plan.worldToScreen(p.x, p.y);
        return Math.hypot(sp.x - screen.x, sp.y - screen.y) < 30;
      });
    if (!ghostHit && hitPoint(screen) == null) {
      const wall = hitWall(world, screen);
      if (wall) {
        const len = Math.hypot(wall.b.x - wall.a.x, wall.b.y - wall.a.y) || 1;
        let dir = { x: (wall.b.x - wall.a.x) / len, y: (wall.b.y - wall.a.y) / len };
        const c1 = ui.flow.c1;
        const ahead = (world.x - c1.x) * dir.x + (world.y - c1.y) * dir.y;
        if (ahead < 0) dir = { x: -dir.x, y: -dir.y };
        ui.flow = { kind: 'item-side', draft: ui.flow.draft, c1, dir, wEff: ui.flow.draft.w };
        ui.flowSide = 1;
        return say('Aligned with wall - tap the matching rectangle, OK commits');
      }
    }
  }

  // Point-fixing flows: ghosts first (bigger target), then reference points.
  if (twoFieldFlow()) {
    const pv = preview();
    if (pv && pv.cands && pv.cands.gap <= CLAMP_TOL) {
      for (const [side, p] of [[+1, pv.cands.left], [-1, pv.cands.right]]) {
        const sp = plan.worldToScreen(p.x, p.y);
        if (Math.hypot(sp.x - screen.x, sp.y - screen.y) < 30) return commitPoint(side);
      }
    }
    const pid = hitPoint(screen);
    if (pid != null) return toggleRef(pid);
  }
}

function handleDragStart(world) {
  if (ui.view === '3d' || ui.mode !== 'move' || ui.flow) return false;
  const sel = ui.selItem && store.item(ui.selItem);
  if (sel && !sel.locked) {
    const hd = rotateHandlePos(sel);
    const sp = plan.worldToScreen(hd.x, hd.y);
    const wp = plan.worldToScreen(world.x, world.y);
    if (Math.hypot(sp.x - wp.x, sp.y - wp.y) < 26) {
      ui.drag = { kind: 'rotate', id: sel.id, rot0: sel.rot, a0: Math.atan2(world.y - sel.y, world.x - sel.x) };
      return true;
    }
  }
  const iid = hitItem(world);
  if (iid) {
    const it = store.item(iid);
    if (it.locked) return false;
    ui.selItem = iid;
    ui.drag = { kind: 'move', id: iid, x0: it.x, y0: it.y, gx: world.x, gy: world.y, dx: 0, dy: 0, rot: it.rot };
    render();
    return true;
  }
  return false;
}

function handleDragMove(world) {
  const d = ui.drag;
  if (!d) return;
  if (d.kind === 'move') {
    d.dx = world.x - d.gx;
    d.dy = world.y - d.gy;
  } else if (d.kind === 'rotate') {
    const it = store.item(d.id);
    if (!it) return;
    let rot = d.rot0 + Math.atan2(world.y - it.y, world.x - it.x) - d.a0;
    d.newRot = snapAngle(rot);
  }
  render();
}

function handleDragEnd(cancelled) {
  const d = ui.drag;
  ui.drag = null;
  if (!d || cancelled) return render();
  if (d.kind === 'move' && (d.dx || d.dy)) {
    const it = store.item(d.id);
    if (it) store.updateItem(d.id, { x: d.x0 + d.dx, y: d.y0 + d.dy, mount: null });
  } else if (d.kind === 'rotate' && d.newRot != null) {
    store.updateItem(d.id, { rot: d.newRot, mount: null });
  } else {
    render();
  }
}

function snapAngle(rot) {
  const snaps = [];
  for (let k = 0; k < 24; k++) snaps.push((k * Math.PI) / 12);
  for (const seg of wallSegments()) snaps.push(Math.atan2(seg.b.y - seg.a.y, seg.b.x - seg.a.x));
  const norm = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  let best = rot, bestD = 4 * (Math.PI / 180);
  for (const s of snaps) {
    for (const cand of [s, s + Math.PI]) {
      const d = Math.abs(norm(rot - cand));
      if (d < bestD) { best = cand; bestD = d; }
    }
  }
  return norm(best);
}

function rotateHandlePos(it) {
  const off = it.d / 2 + 30 * plan.worldPerPx;
  return { x: it.x - Math.sin(it.rot) * off, y: it.y + Math.cos(it.rot) * off };
}

// --- item form sheet -------------------------------------------------------

let formItemId = null; // editing an existing item, else null (new draft)

function openItemForm(itemId = null) {
  formItemId = itemId;
  const it = itemId ? store.item(itemId) : null;
  $('if-name').value = it ? it.name : '';
  $('if-category').value = it ? it.category : 'appliance';
  $('if-w').value = it ? Math.round(it.w * 100) : 60;
  $('if-d').value = it ? Math.round(it.d * 100) : 60;
  $('if-h').value = it ? Math.round(it.h * 100) : 90;
  $('if-z0').value = it ? Math.round(it.z0 * 100) : 0;
  const laySel = $('if-layer');
  laySel.innerHTML = '';
  for (const l of store.state.layers) {
    const o = document.createElement('option');
    o.value = l.id;
    o.textContent = l.name;
    laySel.appendChild(o);
  }
  laySel.value = it ? it.layer : store.state.activeLayer;
  $('if-delete').style.display = it ? '' : 'none';
  $('if-lock').style.display = it ? '' : 'none';
  $('if-lock').textContent = it?.locked ? 'unlock' : 'lock';
  $('item-form').hidden = false;
}

function readItemForm() {
  const num = (id, dflt) => {
    const v = parseFloat($(id).value);
    return isFinite(v) && v > 0 ? v / 100 : dflt;
  };
  return {
    name: $('if-name').value.trim() || 'item',
    category: $('if-category').value,
    w: num('if-w', 0.6), d: num('if-d', 0.6), h: num('if-h', 0.9),
    z0: (() => { const v = parseFloat($('if-z0').value); return isFinite(v) && v >= 0 ? v / 100 : 0; })(),
    layer: $('if-layer').value,
  };
}

function applyItemForm(placement) {
  const draft = readItemForm();
  $('item-form').hidden = true;
  if (formItemId) {
    store.updateItem(formItemId, draft);
    say('Item updated', 'good');
    return;
  }
  if (placement === 'measure') {
    ui.mode = 'measure';
    startFlow({ kind: 'item-c1', draft }, 'Corner 1: tap 2 reference points, type the 2 distances');
  } else if (placement === 'wall') {
    startFlow({ kind: 'item-wallmount', draft }, 'Tap the wall this item sits on');
  } else {
    const rect = { x: plan.cx, y: plan.cy, rot: 0, w: draft.w, d: draft.d };
    commitItemAt(rect, draft);
  }
}

// --- log sheet -------------------------------------------------------------

function renderLog() {
  const sheet = $('log-list');
  sheet.innerHTML = '';
  const addRow = (html, cls = '') => {
    const div = document.createElement('div');
    div.className = 'log-row ' + cls;
    div.innerHTML = html;
    sheet.appendChild(div);
    return div;
  };
  const section = (t) => addRow(`<b class="log-head">${t}</b>`);

  section('measurements');
  if (!store.state.measurements.length) addRow('<span class="dim">none yet</span>');
  for (const m of store.state.measurements) {
    const a = store.point(m.p)?.name ?? '?', b = store.point(m.q)?.name ?? '?';
    const r = store.solved.mres.get(m.id);
    const rc = r == null ? '' : Math.abs(r) < 0.01 ? 'good' : Math.abs(r) < 0.03 ? 'warn' : 'err';
    const rtxt = r == null ? '' : `${(r * 100).toFixed(1)} cm`;
    const row = addRow(
      `<span class="log-name">${a} to ${b}</span><span class="log-val">${fmtDist(m.d)}</span>` +
      `<span class="log-res ${rc}">${rtxt}</span>` +
      `<button data-act="edit">edit</button><button data-act="del">x</button>`
    );
    row.querySelector('[data-act="edit"]').addEventListener('click', () => {
      $('log-sheet').hidden = true;
      startFlow({ kind: 'edit-meas', measId: m.id },
        `Editing ${a} to ${b} (was ${fmtDist(m.d)}) - type the new value, OK saves`);
    });
    row.querySelector('[data-act="del"]').addEventListener('click', () => { store.deleteMeasurement(m.id); });
  }

  section('walls');
  if (!store.state.walls.length) addRow('<span class="dim">none yet - wall mode, tap points in order</span>');
  for (const w of store.state.walls) {
    const names = w.pts.map((id) => store.point(id)?.name ?? '?').join('-');
    const row = addRow(
      `<span class="log-name">${names}${w.closed ? ' (closed)' : ''}</span><button data-act="del">x</button>`
    );
    row.querySelector('[data-act="del"]').addEventListener('click', () => { store.deleteWall(w.id); });
  }

  section('layers');
  for (const l of store.state.layers) {
    const row = addRow(
      `<button data-act="vis" class="${l.visible ? '' : 'off'}">${l.visible ? 'shown' : 'hidden'}</button>` +
      `<span class="log-name ${store.state.activeLayer === l.id ? 'active-layer' : ''}">${l.name}</span>` +
      `<button data-act="use">${store.state.activeLayer === l.id ? 'active' : 'use'}</button>` +
      (l.id !== 'current' ? `<button data-act="del">x</button>` : '')
    );
    row.querySelector('[data-act="vis"]').addEventListener('click', () => store.setLayerVisible(l.id, !l.visible));
    row.querySelector('[data-act="use"]').addEventListener('click', () => store.setActiveLayer(l.id));
    row.querySelector('[data-act="del"]')?.addEventListener('click', () => store.deleteLayer(l.id));
  }
  const addLayerRow = addRow(
    `<input id="new-layer-name" placeholder="proposal name"><button data-act="add">+ layer</button>`
  );
  addLayerRow.querySelector('[data-act="add"]').addEventListener('click', () => {
    const name = $('new-layer-name').value.trim();
    if (name) store.addLayer(name);
  });

  section('room');
  const hRow = addRow(
    `<span class="log-name">ceiling height</span>` +
    `<input id="room-h" type="number" value="${Math.round((store.state.roomHeight || 2.6) * 100)}"> cm ` +
    `<button data-act="set">set</button>`
  );
  hRow.querySelector('[data-act="set"]').addEventListener('click', () => {
    const v = parseFloat($('room-h').value);
    if (isFinite(v) && v > 100) store.setRoomHeight(v / 100);
  });

  section('data');
  const dRow = addRow(
    `<button data-act="export">download JSON</button>` +
    `<button data-act="copy">copy JSON</button>` +
    `<button data-act="import">import...</button>`
  );
  dRow.querySelector('[data-act="export"]').addEventListener('click', exportJSON);
  dRow.querySelector('[data-act="copy"]').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(exportString());
      say('JSON copied to clipboard', 'good');
      $('log-sheet').hidden = true;
    } catch { say('Clipboard blocked - use download instead', 'warn'); }
  });
  dRow.querySelector('[data-act="import"]').addEventListener('click', () => {
    $('import-box').hidden = !$('import-box').hidden;
  });
}

function exportString() {
  return JSON.stringify({
    app: 'house-measurer', version: 2,
    exported: new Date().toISOString(),
    state: store.state,
  }, null, 1);
}

function exportJSON() {
  const blob = new Blob([exportString()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `room-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function importFromText(text) {
  try {
    const data = JSON.parse(text);
    const st = data.state && data.state.points ? data.state : (data.points ? data : null);
    if (!st) throw new Error('not a house-measurer file');
    store.importState(st);
    ui.refs = []; ui.lastId = null; ui.selItem = null; ui.flow = null;
    $('log-sheet').hidden = true;
    $('import-box').hidden = true;
    plan.fitAll([...store.solved.pos.values()]);
    say('Imported (undo restores the previous state)', 'good');
  } catch (e) {
    say(`Import failed: ${e.message}`, 'err');
  }
}

// --- rendering -------------------------------------------------------------

function fieldLabel(i) {
  if (anchorMode()) return 'distance A to B';
  if (ui.flow?.kind === 'item-walloffset') {
    return i === 0 ? `from ${store.point(ui.flow.wall[ui.flow.endIdx === 0 ? 'pa' : 'pb'])?.name ?? 'end'} to edge` : '';
  }
  if (ui.flow?.kind === 'edit-meas') {
    const m = store.measurement(ui.flow.measId);
    return i === 0 ? `${store.point(m?.p)?.name ?? '?'} to ${store.point(m?.q)?.name ?? '?'}` : '';
  }
  const id = ui.refs[i];
  return id ? `to ${store.point(id).name}` : `to ref ${i + 1}`;
}

function renderPanel() {
  const anchor = anchorMode();
  const oneField = ui.flow?.kind === 'item-walloffset' || ui.flow?.kind === 'edit-meas';
  const noFields = ui.flow?.kind === 'item-side' || ui.flow?.kind === 'item-wallmount';
  const showKeypad = ui.mode === 'measure' || anchor || ui.flow;
  const showFields = showKeypad && !noFields;

  $('modebar').style.display = anchor ? 'none' : '';
  $('refbar').style.display = !anchor && showFields && twoFieldFlow() ? '' : 'none';
  $('fields').style.display = showFields ? '' : 'none';
  $('keypad').style.display = showKeypad ? '' : 'none';
  $('wallbar').style.display = ui.mode === 'wall' && !ui.flow ? '' : 'none';
  $('movebar').style.display = ui.mode === 'move' && !ui.flow ? '' : 'none';
  $('itembar').style.display = ui.mode === 'item' && !ui.flow ? '' : 'none';

  for (const b of document.querySelectorAll('#modebar button')) {
    b.classList.toggle('on', b.dataset.mode === ui.mode);
  }

  if (showFields) {
    $('field1').style.display = anchor || oneField ? 'none' : '';
    for (const i of [0, 1]) {
      const el = $(`field${i}`);
      el.classList.toggle('active', ui.active === i);
      el.querySelector('label').textContent = fieldLabel(i);
      const v = ui.fields[i];
      el.querySelector('.val').textContent = v || ' ';
      const d = parseDistance(v);
      el.querySelector('.interp').textContent = v ? (d != null ? `= ${fmtDist(d)}` : 'invalid') : ' ';
    }
  }

  if ($('refbar').style.display !== 'none') {
    for (const i of [0, 1]) {
      const slot = $(`ref${i}`);
      const id = ui.refs[i];
      slot.textContent = id ? store.point(id).name : `tap ref ${i + 1}`;
      slot.classList.toggle('set', !!id);
    }
    $('check-btn').style.display = ui.refs.length === 2 && !ui.flow ? '' : 'none';
  }

  // Move-mode chips.
  if (ui.mode === 'move' && !ui.flow) {
    const it = ui.selItem && store.item(ui.selItem);
    $('sel-name').textContent = it ? it.name : 'tap an item';
    for (const id of ['sel-edit', 'sel-lock', 'sel-del']) $(id).disabled = !it;
    if (it) $('sel-lock').textContent = it.locked ? 'unlock' : 'lock';
  }

  // Item list.
  if (ui.mode === 'item' && !ui.flow) {
    const list = $('item-list');
    list.innerHTML = '';
    const vis = visibleLayers();
    for (const it of store.state.items) {
      const row = document.createElement('div');
      row.className = 'item-row' + (vis.has(it.layer) ? '' : ' dim');
      const layer = store.state.layers.find((l) => l.id === it.layer);
      row.innerHTML =
        `<span class="swatch" style="background:#${categoryColor(it.category).toString(16).padStart(6, '0')}"></span>` +
        `<span class="log-name">${it.name}${it.locked ? ' [locked]' : ''}</span>` +
        `<span class="dim">${layer?.name ?? ''}</span>`;
      row.addEventListener('click', () => openItemForm(it.id));
      list.appendChild(row);
    }
    if (!store.state.items.length) list.innerHTML = '<div class="dim" style="padding:6px">no items yet</div>';
  }

  const flip = document.querySelector('[data-key="flip"]');
  if (flip) {
    flip.disabled = !(
      ui.flow?.kind === 'item-side' || ui.flow?.kind === 'item-walloffset' ||
      (twoFieldFlow() && ui.flow && preview()?.cands) ||
      (ui.mode === 'move' && ui.selItem && !store.item(ui.selItem)?.locked) ||
      (ui.mode === 'measure' && !ui.flow && ui.lastId && store.point(ui.lastId)?.fix)
    );
  }

  // Status line.
  let msg = ui.message;
  if (!msg) {
    if (anchor) msg = { text: 'Measure your two anchor marks and type the distance', cls: '' };
    else if (ui.mode === 'wall') msg = { text: ui.activeWallId ? 'Tap the next point (first point again closes)' : 'Tap points in order to draw a wall', cls: '' };
    else if (ui.mode === 'move') msg = { text: ui.selItem ? 'Drag to move, handle rotates, flip = 90 degrees' : 'Tap an item to select it', cls: '' };
    else if (ui.mode === 'item') msg = { text: 'Tap an item to edit it, or add a new one', cls: '' };
    else if (ui.flow) msg = { text: '', cls: '' };
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
  $('view3d-btn').classList.toggle('on', ui.view === '3d');

  // Residual pill: worst residual of the last placed point.
  const pill = $('gap-pill');
  if (ui.lastId && store.point(ui.lastId)?.fix) {
    const res = (store.solved.pres.get(ui.lastId) ?? store.solved.gaps.get(ui.lastId) ?? 0) * 100;
    pill.hidden = false;
    pill.textContent = `${store.point(ui.lastId).name}: ${res.toFixed(1)} cm`;
    pill.className = res < 1 ? 'good' : res < 3 ? 'warn' : 'err';
  } else {
    pill.hidden = true;
  }
}

function renderPlan() {
  const content = { points: [], segments: [], circles: [], ghosts: [], rects: [], polygons: [], handles: [], labels: [] };
  const pts = store.state.points;

  if (anchorMode()) {
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

  // Walls + closed-room fill.
  for (const wall of store.state.walls) {
    const runs = wall.closed ? [...wall.pts, wall.pts[0]] : wall.pts;
    const active = wall.id === ui.activeWallId;
    for (let i = 0; i + 1 < runs.length; i++) {
      const a = pos(runs[i]), b = pos(runs[i + 1]);
      if (a && b) content.segments.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, style: active ? 'wallActive' : 'wall' });
    }
    if (wall.closed) {
      const poly = wall.pts.map(pos).filter(Boolean);
      if (poly.length >= 3) content.polygons.push({ pts: poly, color: 0x9a8f6a, opacity: 0.07 });
    }
  }

  // A-B baseline (only until walls exist; it is scaffolding, not geometry).
  if (!store.state.walls.length) {
    const pA = pos(pts[0]?.id), pB = pos(pts[1]?.id);
    if (pA && pB) content.segments.push({ x1: pA.x, y1: pA.y, x2: pB.x, y2: pB.y, style: 'ab' });
  }

  // Items on visible layers.
  const vis = visibleLayers();
  for (const it of store.state.items) {
    if (!vis.has(it.layer)) continue;
    let { x, y, rot } = it;
    if (ui.drag?.kind === 'move' && ui.drag.id === it.id) { x = ui.drag.x0 + ui.drag.dx; y = ui.drag.y0 + ui.drag.dy; }
    if (ui.drag?.kind === 'rotate' && ui.drag.id === it.id && ui.drag.newRot != null) rot = ui.drag.newRot;
    const selected = ui.mode === 'move' && ui.selItem === it.id;
    content.rects.push({
      x, y, rot, w: it.w, d: it.d,
      color: categoryColor(it.category),
      opacity: it.layer === 'current' ? 0.85 : 0.7,
      halo: selected,
    });
    content.labels.push({ key: `it${it.id}`, x, y, text: it.name, cls: 'item' });
    if (selected && !it.locked && !ui.drag) {
      const hd = rotateHandlePos({ ...it, x, y, rot });
      content.handles.push(hd);
    }
  }

  // Points, names, residual badges.
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
    const res = store.solved.pres.get(pt.id) || 0;
    if (res >= 0.001) {
      const cls = res < 0.01 ? 'res good' : res < 0.03 ? 'res warn' : 'res err';
      content.labels.push({ key: `r${pt.id}`, x: p.x, y: p.y, text: `${(res * 100).toFixed(1)}`, cls, dy: 15 });
    }
  }
  // Two-distance preview (points and item corners).
  const pv = preview();
  if (pv && pv.cands && pv.cands.gap <= CLAMP_TOL) {
    const key = `${ui.refs.join(':')}:${pv.d1}:${pv.d2}:${ui.flow?.kind ?? 'pt'}`;
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
      const isCorner = ui.flow?.kind === 'item-c1' || ui.flow?.kind === 'item-c2';
      const name = isCorner ? 'corner' : pointName(pts.length);
      const primarySide = ui.flow ? ui.flowSide : 1;
      for (const [side, p] of [[+1, pv.cands.left], [-1, pv.cands.right]]) {
        const primary = side === primarySide;
        content.ghosts.push({ x: p.x, y: p.y, primary });
        content.labels.push({
          key: `gh${side}`, x: p.x, y: p.y,
          text: primary ? `${name}?` : 'or here',
          cls: primary ? 'ghost' : 'ghost dim', dy: -20,
        });
      }
      const t = primarySide >= 0 ? pv.cands.left : pv.cands.right;
      content.segments.push({ x1: r1.x, y1: r1.y, x2: t.x, y2: t.y, style: 'ray' });
      content.segments.push({ x1: r2.x, y1: r2.y, x2: t.x, y2: t.y, style: 'ray' });
      content.labels.push({ key: 'rd1', x: (r1.x + t.x) / 2, y: (r1.y + t.y) / 2, text: fmtDist(pv.d1), cls: 'ray' });
      content.labels.push({ key: 'rd2', x: (r2.x + t.x) / 2, y: (r2.y + t.y) / 2, text: fmtDist(pv.d2), cls: 'ray' });
    }
  }

  // Flow previews beyond the two-distance stage.
  if (ui.flow?.kind === 'item-c2') {
    content.ghosts.push({ x: ui.flow.c1.x, y: ui.flow.c1.y, primary: true });
    content.labels.push({ key: 'c1', x: ui.flow.c1.x, y: ui.flow.c1.y, text: 'corner 1', cls: 'ghost', dy: -20 });
  }
  if (ui.flow?.kind === 'item-side') {
    for (const cand of sideCandidates(ui.flow)) {
      content.rects.push({
        ...cand.rect,
        color: categoryColor(ui.flow.draft.category),
        opacity: cand.side === ui.flowSide ? 0.55 : 0.18,
      });
      if (cand.side === ui.flowSide) {
        content.labels.push({ key: 'side', x: cand.rect.x, y: cand.rect.y, text: `${ui.flow.draft.name}?`, cls: 'ghost' });
      }
    }
  }
  if (ui.flow?.kind === 'item-walloffset') {
    const pvw = wallOffsetPreview(ui.flow);
    content.ghosts.push({ x: pvw.endPoint.x, y: pvw.endPoint.y, primary: true });
    content.labels.push({ key: 'we', x: pvw.endPoint.x, y: pvw.endPoint.y, text: 'from here', cls: 'ghost', dy: -20 });
    if (parseDistance(ui.fields[0]) != null) {
      content.rects.push({
        ...pvw.rect, color: categoryColor(ui.flow.draft.category), opacity: 0.55,
      });
      content.labels.push({ key: 'woff', x: pvw.rect.x, y: pvw.rect.y, text: `${ui.flow.draft.name}?`, cls: 'ghost' });
    }
  }

  plan.update(content);
}

function render() {
  validateUi();
  renderPanel();
  if (ui.view === '3d') {
    if (view3d) view3d.build(store.state, store.solved, visibleLayers());
  } else {
    renderPlan();
  }
  if (!$('log-sheet').hidden) renderLog();
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
    b.className = 'key ' + (/^[0-9.]$/.test(key) ? 'digit' : key === '.' ? 'digit' : key);
    b.addEventListener('pointerdown', (e) => e.preventDefault());
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

function setMode(mode) {
  ui.mode = mode;
  ui.flow = null;
  ui.message = null;
  if (mode !== 'wall') ui.activeWallId = null;
  if (mode !== 'move') ui.selItem = null;
  render();
}

function toggle3D() {
  ui.view = ui.view === '3d' ? 'plan' : '3d';
  $('view3d-wrap').hidden = ui.view !== '3d';
  $('canvas-wrap').classList.toggle('behind', ui.view === '3d');
  if (ui.view === '3d') {
    if (!view3d) view3d = new View3D($('plan3d'));
    view3d.refit();
    view3d.resize();
  }
  render();
}

buildKeypad();

$('undo').addEventListener('click', () => store.undo());
$('redo').addEventListener('click', () => store.redo());
$('fit').addEventListener('click', () => {
  if (ui.view === '3d' && view3d) { view3d.refit(); view3d.build(store.state, store.solved, visibleLayers()); }
  else plan.fitAll([...store.solved.pos.values()]);
});
$('view3d-btn').addEventListener('click', toggle3D);
$('log-btn').addEventListener('click', () => { $('log-sheet').hidden = false; renderLog(); });
$('log-close').addEventListener('click', () => { $('log-sheet').hidden = true; });
$('log-sheet').addEventListener('click', (e) => { if (e.target === $('log-sheet')) $('log-sheet').hidden = true; });
$('help').addEventListener('click', () => { $('help-overlay').hidden = false; });
$('help-close').addEventListener('click', () => { $('help-overlay').hidden = true; });
$('help-overlay').addEventListener('click', (e) => {
  if (e.target === $('help-overlay')) $('help-overlay').hidden = true;
});

for (const b of document.querySelectorAll('#modebar button')) {
  b.addEventListener('click', () => setMode(b.dataset.mode));
}

$('wall-finish').addEventListener('click', () => { ui.activeWallId = null; say('Wall finished'); });
$('wall-back').addEventListener('click', () => {
  if (ui.activeWallId) store.popWallPoint(ui.activeWallId);
  else store.undo();
});

$('check-btn').addEventListener('click', commitCheck);

$('sel-edit').addEventListener('click', () => { if (ui.selItem) openItemForm(ui.selItem); });
$('sel-lock').addEventListener('click', () => {
  const it = ui.selItem && store.item(ui.selItem);
  if (it) store.updateItem(it.id, { locked: !it.locked });
});
$('sel-del').addEventListener('click', () => {
  if (ui.selItem) { store.deleteItem(ui.selItem); ui.selItem = null; }
});

$('item-new').addEventListener('click', () => openItemForm(null));
$('if-close').addEventListener('click', () => { $('item-form').hidden = true; });
$('if-place-measure').addEventListener('click', () => applyItemForm('measure'));
$('if-place-wall').addEventListener('click', () => applyItemForm('wall'));
$('if-place-drop').addEventListener('click', () => applyItemForm('drop'));
$('if-save').addEventListener('click', () => applyItemForm(null));
$('if-delete').addEventListener('click', () => {
  if (formItemId) { store.deleteItem(formItemId); $('item-form').hidden = true; }
});
$('if-lock').addEventListener('click', () => {
  const it = formItemId && store.item(formItemId);
  if (it) { store.updateItem(it.id, { locked: !it.locked }); $('if-lock').textContent = it.locked ? 'lock' : 'unlock'; }
});
const presetWrap = $('if-presets');
for (const p of PRESETS) {
  const b = document.createElement('button');
  b.textContent = p.name;
  b.addEventListener('click', () => {
    $('if-name').value = p.name;
    $('if-category').value = p.category;
    $('if-w').value = Math.round(p.w * 100);
    $('if-d').value = Math.round(p.d * 100);
    $('if-h').value = Math.round(p.h * 100);
    $('if-z0').value = Math.round(p.z0 * 100);
  });
  presetWrap.appendChild(b);
}
const catSel = $('if-category');
for (const [key, c] of Object.entries(CATEGORIES)) {
  const o = document.createElement('option');
  o.value = key;
  o.textContent = c.label;
  catSel.appendChild(o);
}

$('import-file').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = () => importFromText(r.result);
  r.readAsText(f);
});
$('import-apply').addEventListener('click', () => importFromText($('import-text').value));

$('clear-all').addEventListener('click', (e) => {
  const b = e.target;
  if (b.dataset.armed) {
    store.clearAll();
    ui.refs = []; ui.fields = ['', '']; ui.lastId = null; ui.active = 0;
    ui.flow = null; ui.selItem = null; ui.activeWallId = null; ui.mode = 'measure';
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
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
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
    if (ui.flow) { endFlow('Cancelled'); return; }
    if (ui.fields[ui.active]) ui.fields[ui.active] = '';
    else ui.refs = [];
    return render();
  }
});

store.onChange(render);
restoreCamera();
render();

// Debug / test hooks.
window.app = {
  store, plan, ui, render, pressKey, toggleRef, setMode, toggle3D,
  openItemForm, applyItemForm, importFromText, exportString,
  get view3d() { return view3d; },
};
