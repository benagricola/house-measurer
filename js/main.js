// Controller: wires the store, the plan view, the 3D view and the input
// panel together. All interaction flows live here.

import {
  parseDistance, fmtDist, circleIntersect, CLAMP_TOL, pointName,
  pointSegDist, itemCorners, pointInItem, angleDeg, interiorAngles,
  segIntersects, weakDir,
} from './geometry.js';
import { Store } from './state.js';
import { PlanView } from './plan.js';
import { View3D } from './view3d.js';
import { CATEGORIES, PRESETS, WALL_CATEGORIES, categoryColor, stairSteps, stairRise } from './items.js';
import { LaserLink } from './laser.js';
import { applyTheme, currentTheme, PLAN_PALETTES, SKY_PALETTES } from './theme.js';

const CAM_KEY = 'house-measurer.cam';
const $ = (id) => document.getElementById(id);

const store = new Store(window.localStorage);
store.load();

const ui = {
  mode: 'measure',   // measure | wall | item | move
  view: 'plan',      // plan | 3d
  refs: [],          // up to four point ids selected as references
  multiD: [],        // collected distances when more than two refs are set
  fields: ['', ''],  // raw keypad strings
  active: 0,
  lastId: null,      // last committed point (flip target in measure mode)
  message: null,
  activeWallId: null,
  selItem: null,
  flow: null,        // placement / edit flow, see startFlow()
  flowSide: 1,       // candidate side while a flow preview is active
  drag: null,        // transient item drag (not yet committed)
  // Reference-first by default: new points are reference-only until the
  // user turns walling on (or builds walls by hand in walls mode).
  wallPause: true,
  coachDone: false,
};
try {
  ui.wallPause = localStorage.getItem('house-measurer.walling') !== 'on';
  ui.coachDone = localStorage.getItem('house-measurer.coach') === 'done';
} catch {}

const plan = new PlanView($('plan'), $('overlay'), $('scalebar'), {
  onTap: handleTap,
  onCamera: saveCameraSoon,
  onDragStart: handleDragStart,
  onDragMove: handleDragMove,
  onDragEnd: handleDragEnd,
});
let view3d = null; // created lazily on first 3D toggle

// Theme: the document reads CSS variables off data-theme; the canvases
// get their palettes pushed here. Explicit choice persists; otherwise
// the OS preference decides.
let theme = currentTheme();
function setAppTheme(t, { persist = false } = {}) {
  theme = applyTheme(t, { persist });
  plan.setTheme(PLAN_PALETTES[t]);
  view3d?.setTheme(SKY_PALETTES[t]);
  const btn = $('theme-btn');
  if (btn) btn.textContent = t === 'dark' ? 'light' : 'dark';
}
setAppTheme(theme);

// Open the thickness/height editor for a wall segment (2D or 3D tap).
function openWallEditor(seg) {
  const key = `${seg.pa}:${seg.pb}`;
  const zone = seg.t < 0.3 ? 'a' : seg.t > 0.7 ? 'b' : 'mid';
  const names = `${store.point(seg.pa)?.name}-${store.point(seg.pb)?.name}`;
  const zoneTxt = zone === 'mid' ? 'whole top edge'
    : `height at the ${store.point(zone === 'a' ? seg.pa : seg.pb)?.name} end only`;
  startFlow({ kind: 'wall-edit', wallId: seg.wallId, key, zone, pa: seg.pa, pb: seg.pb },
    `Wall ${names}: thickness, then height (${zoneTxt}). Empty keeps current.`);
}

function handleTap3D({ pointId, ghostSide, roomHeightWall, wallSeg, world }) {
  if (ghostSide != null && twoFieldFlow()) return void commitPoint(ghostSide);
  if (roomHeightWall != null) {
    const w = store.wall(roomHeightWall);
    if (!w) return;
    const h = Math.round((w.height || store.state.roomHeight || 2.6) * 100);
    return startFlow({ kind: 'room-height', wallId: w.id },
      `Ceiling height for this room in cm (now ${h} cm)`);
  }
  if (pointId != null) {
    if (ui.mode === 'wall') {
      const r = store.addWallPoint(ui.activeWallId, pointId);
      ui.activeWallId = r.closed ? null : r.wallId;
      if (r.closed) return roomClosed(r.wallId);
      return say('Wall: tap the next point (first point again closes)');
    }
    if (twoFieldFlow()) {
      if (cornerFromPoint(pointId)) return;
      return toggleRef(pointId);
    }
  }
  // A wall face: edit it where its height is actually visible.
  if (wallSeg != null && !ui.flow) return openWallEditor(wallSeg);
}

// --- helpers ---------------------------------------------------------------

const anchorMode = () => store.state.points.length === 0;
const pos = (id) => store.solved.pos.get(id);
const twoFieldFlow = () => !ui.flow || ui.flow.kind === 'item-c1' || ui.flow.kind === 'item-c2';
const activeFloor = () => store.state.activeFloor;
const onFloor = (thing) => thing && thing.floor === activeFloor();
const floorVisible = (id) => store.floor(id)?.visible !== false;
const offFloorRefs = () => ui.refs.filter((id) => !onFloor(store.point(id)));
// The measurement already recorded between the two selected points, if
// any - the button says "edit" for these and "record" for a fresh pair.
const pairMeasurement = () => {
  if (ui.refs.length !== 2) return null;
  const [p, q] = ui.refs;
  return store.state.measurements.find(
    (m) => (m.p === p && m.q === q) || (m.p === q && m.q === p)) ?? null;
};

function say(text, cls = '') {
  ui.message = text ? { text, cls } : null;
  render();
}

// Transient toast pills, stacked top-centre above everything (sheets
// included, so feedback from data-sheet actions is visible too).
function toast(text, cls = '') {
  const wrap = $('toasts');
  if (!wrap) return;
  const t = document.createElement('div');
  t.className = 'toast ' + cls;
  t.textContent = text;
  wrap.appendChild(t);
  while (wrap.children.length > 3) wrap.firstChild.remove();
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 250);
  }, 2400);
}

// Status line + toast in one: for milestones worth a glanceable ping.
function note(text, cls = '') {
  toast(text, cls);
  say(text, cls);
}

// Points that failed to solve, with the reason and a best-effort plan
// position (the clamped circle intersection) when their references still
// solve. Unsolved points MUST stay visible - a silently vanished point
// has caused real survey damage before.
function unsolvedPoints(floorOnly = true) {
  const out = [];
  const errs = store.solved.errors;
  if (!errs || !errs.size) return out;
  for (const pt of store.state.points) {
    if (pos(pt.id)) continue;
    const reason = errs.get(pt.id);
    if (!reason) continue;
    if (floorOnly && !onFloor(pt)) continue;
    let p = null;
    const f = pt.fix;
    if (f && f.stack == null) {
      const P = pos(f.r1), Q = pos(f.r2);
      const dTo = (a) => store.state.measurements.find(
        (m) => (m.p === a && m.q === pt.id) || (m.p === pt.id && m.q === a))?.d;
      const d1 = dTo(f.r1), d2 = dTo(f.r2);
      if (P && Q && d1 != null && d2 != null) {
        const c = circleIntersect(P, d1, Q, d2);
        if (c.ok) p = f.side >= 0 ? c.left : c.right;
      }
    }
    out.push({ pt, reason, p });
  }
  return out;
}

// Points whose ADJUSTED position sits on the opposite side of their
// r1->r2 line to their stored side flag. Least squares can rescue a
// mirrored point (strong redundant distances drag it across), which
// LOOKS right - but the stale flag still poisons the chain solve for
// any new point measured from it. Flipping the point heals the flag.
function floorCentroid(floorId) {
  let x = 0, y = 0, n = 0;
  for (const pt of store.state.points) {
    if (pt.floor !== floorId) continue;
    const p = pos(pt.id);
    if (!p) continue;
    x += p.x; y += p.y; n++;
  }
  return n ? { x: x / n, y: y / n } : null;
}

function sideMismatches() {
  const out = [];
  for (const pt of store.state.points) {
    const f = pt.fix;
    if (!f || f.stack != null || f.side == null) continue;
    const p = pos(pt.id), P = pos(f.r1), Q = pos(f.r2);
    if (!p || !P || !Q) continue;
    const cross = (Q.x - P.x) * (p.y - P.y) - (Q.y - P.y) * (p.x - P.x);
    const len = Math.hypot(Q.x - P.x, Q.y - P.y) || 1;
    if (Math.abs(cross) / len < 0.02) continue; // on the line: ambiguous, fine
    if (Math.sign(cross) !== Math.sign(f.side)) out.push(pt);
  }
  return out;
}

// --- survey check (the built-in "what is wrong and what do I do") ----------

// Is the straight line between two solved positions crossed by any wall
// segment on this floor? Walls touching either endpoint do not count.
function sightBlocked(a, b, floorId) {
  for (const wall of store.state.walls) {
    if (wall.floor !== floorId) continue;
    const run = wall.closed ? [...wall.pts, wall.pts[0]] : wall.pts;
    for (let i = 0; i + 1 < run.length; i++) {
      const p = pos(run[i]), q = pos(run[i + 1]);
      if (p && q && segIntersects(a, b, p, q)) return true;
    }
  }
  return false;
}

// Does the ray from a wall point toward a target run nearly parallel to
// a wall attached to that point? Such a shot reads the wall face, not
// the mark (the grazing failure seen on a real survey).
function sightGrazes(ptId, from, to) {
  const dir = { x: to.x - from.x, y: to.y - from.y };
  const dl = Math.hypot(dir.x, dir.y) || 1;
  for (const wall of store.state.walls) {
    const run = wall.closed ? [...wall.pts, wall.pts[0]] : wall.pts;
    for (let i = 0; i + 1 < run.length; i++) {
      if (run[i] !== ptId && run[i + 1] !== ptId) continue;
      const p = pos(run[i]), q = pos(run[i + 1]);
      if (!p || !q) continue;
      const wl = Math.hypot(q.x - p.x, q.y - p.y) || 1;
      const cosang = Math.abs((dir.x * (q.x - p.x) + dir.y * (q.y - p.y)) / (dl * wl));
      if (cosang > 0.966) return true; // within ~15 degrees of the wall
    }
  }
  return false;
}

// Best additional references for strengthening a point's fix: aligned
// with the fix's weak axis, clear of walls, not grazing along a wall at
// either end. Returns up to three {pt, score, d}.
function strengthenCandidates(pt) {
  const p = pos(pt.id);
  const f = pt.fix;
  if (!p || !f || f.stack != null) return [];
  const P = pos(f.r1), Q = pos(f.r2);
  if (!P || !Q) return [];
  const w = weakDir(p, P, Q);
  const out = [];
  for (const c of store.state.points) {
    if (c.id === pt.id || c.id === f.r1 || c.id === f.r2 || c.floor !== pt.floor) continue;
    const q = pos(c.id);
    if (!q) continue;
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d < 0.4 || d > 15) continue;
    const u = { x: (q.x - p.x) / d, y: (q.y - p.y) / d };
    const score = Math.abs(u.x * w.x + u.y * w.y);
    if (score < 0.45) continue;
    if (sightBlocked(p, q, pt.floor)) continue;
    if (sightGrazes(pt.id, p, q) || sightGrazes(c.id, q, p)) continue;
    out.push({ pt: c, score, d });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 3);
}

// All current diagnoses, worst first. Each: { sev: 'err'|'warn'|'info',
// title, body, steps: [], selectIds?: [pointIds to select on tap] }.
function surveyIssues() {
  const issues = [];
  const errs = store.solved.errors ?? new Map();

  // Unsolved points: root causes get the full prescription; points that
  // are merely downstream get grouped under their root.
  const waiting = [];
  for (const u of unsolvedPoints(false)) {
    if (u.reason === 'reference not solved') { waiting.push(u.pt); continue; }
    const f = u.pt.fix;
    const fixMeas = f && f.stack == null
      ? store.state.measurements.filter((m) =>
        (m.p === u.pt.id || m.q === u.pt.id) &&
        [f.r1, f.r2].includes(m.p === u.pt.id ? m.q : m.p))
      : [];
    const vals = fixMeas.map((m) => {
      const other = m.p === u.pt.id ? m.q : m.p;
      return `${store.point(other)?.name} ${fmtDist(m.d)}`;
    }).join(' and ');
    issues.push({
      sev: 'err',
      title: `${u.pt.name} cannot be placed`,
      body: `${u.reason}. Its fix distances are ${vals || 'missing'} - at least one is wrong (a mis-read, a cm/m mix-up, or a shot that hit the wrong thing).`,
      steps: [
        'Re-measure the suspect distance in the room.',
        'Open data - measurements: edit the wrong value (the rows for this point are marked "unsolved").',
        `Or delete ${u.pt.name} in data - unsolved points, and fix it again from references with clean sight lines.`,
      ],
    });
  }
  if (waiting.length) {
    issues.push({
      sev: 'warn',
      title: `${waiting.map((p) => p.name).join(', ')} waiting on a broken point`,
      body: 'These points are measured from an unsolved point. They come back by themselves the moment the point above them is repaired - fix the red entry first.',
      steps: [],
    });
  }

  for (const pt of sideMismatches()) {
    issues.push({
      sev: 'warn',
      title: `${pt.name}: side flag contradicts its solution`,
      body: 'The adjustment rescued this point onto its true side, but the stored flag still says the mirror. New points measured from it can fail to place until it is healed.',
      steps: [`Tap ${pt.name} so it is the only selected point, press flip once. It will not move - the flag heals.`],
      selectIds: [pt.id],
    });
  }

  // Measurements that fight the rest of the network.
  const badMeas = [...(store.solved.mres ?? new Map()).entries()]
    .filter(([, r]) => Math.abs(r) >= 0.03)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, 3);
  for (const [mid, r] of badMeas) {
    const m = store.state.measurements.find((x) => x.id === mid);
    if (!m) continue;
    const a = store.point(m.p)?.name, b = store.point(m.q)?.name;
    issues.push({
      sev: 'warn',
      title: `${a} to ${b} disagrees by ${(Math.abs(r) * 100).toFixed(1)} cm`,
      body: `The recorded ${fmtDist(m.d)} conflicts with everything else, so nearby points are compromised toward it. Common causes: slant between marks at different heights, a graze along a wall, the wrong mark.`,
      steps: [
        `Re-measure ${a} to ${b} level and square.`,
        'Edit the value in data - measurements (or delete it if it was a bad shot).',
      ],
    });
  }

  // Weak fix geometry, with concrete strengthening candidates.
  for (const pt of store.state.points) {
    const f = pt.fix;
    if (!f || f.stack != null) continue;
    const p = pos(pt.id), P = pos(f.r1), Q = pos(f.r2);
    if (!p || !P || !Q) continue;
    const ang = angleDeg(P, p, Q);
    if (ang >= 30 && ang <= 150) continue;
    const cands = strengthenCandidates(pt);
    const candTxt = cands.length
      ? `Best extra references: ${cands.map((c) => `${c.pt.name} (~${fmtDist(c.d)})`).join(', ')} - chosen for a strong angle with clear sight lines.`
      : 'No existing point offers a good angle - place a new reference first.';
    issues.push({
      sev: 'warn',
      title: `${pt.name}: weak fix geometry (rays cross at ${Math.round(ang)}°)`,
      body: `Millimetres of laser noise become centimetres of position error at this angle, with no residual to show for it. ${candTxt}`,
      steps: cands.length ? [
        `Measure ${pt.name} to ${cands[0].pt.name} (about ${fmtDist(cands[0].d)}).`,
        'Tap the button below (it selects the pair), then press record and type the distance.',
      ] : [],
      selectIds: cands.length ? [pt.id, cands[0].pt.id] : [pt.id],
    });
  }

  // Tiny drawn edges whose ends were never tied directly: both ends were
  // fixed by metres-long shots carrying millimetre noise, so their
  // RELATIVE error is a large fraction of a short edge - the edge's
  // angle swings wildly (1 cm across 9 cm is 6 degrees). A ruler tie
  // pins the length; diagonals across the feature pin the angle.
  const seenShort = new Set();
  for (const wall of store.state.walls) {
    const run = wall.closed ? [...wall.pts, wall.pts[0]] : wall.pts;
    for (let i = 0; i + 1 < run.length; i++) {
      const a = run[i], b = run[i + 1];
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      if (seenShort.has(key)) continue;
      seenShort.add(key);
      const pa = pos(a), pb = pos(b);
      if (!pa || !pb) continue;
      const d = Math.hypot(pb.x - pa.x, pb.y - pa.y);
      if (d <= 0 || d >= 0.45) continue;
      const direct = store.state.measurements.some(
        (m) => (m.p === a && m.q === b) || (m.p === b && m.q === a));
      if (direct) continue;
      const na = store.point(a)?.name, nb = store.point(b)?.name;
      issues.push({
        sev: 'warn',
        title: `${na}-${nb}: short edge (${(d * 100).toFixed(0)} cm) with no direct measurement`,
        body: 'An edge this short inherits the relative error of two long fixes, so its angle is unreliable - it will draw slanted even when the real corners are square. Measure it directly with a ruler or tape; for a protrusion, also record the two diagonals across it.',
        steps: [
          `Measure ${na} to ${nb} directly.`,
          'Tap the button below (it selects the pair), then press record and type the value.',
        ],
        selectIds: [a, b],
      });
      if (issues.length > 12) break;
    }
  }

  return issues;
}

function visibleLayers() {


  return new Set(store.state.layers.filter((l) => l.visible).map((l) => l.id));
}

function validateUi() {
  const before = ui.refs.length;
  ui.refs = ui.refs.filter((id) => store.point(id) && pos(id));
  if (ui.refs.length !== before) ui.multiD = [];
  if (!Array.isArray(ui.multiD)) ui.multiD = [];
  if (ui.lastId && !store.point(ui.lastId)) ui.lastId = null;
  if (ui.flipArm != null && (ui.refs.length !== 1 || ui.refs[0] !== ui.flipArm)) ui.flipArm = null;
  if (ui.selItem && !store.item(ui.selItem)) ui.selItem = null;
  if (ui.activeWallId && !store.wall(ui.activeWallId)) ui.activeWallId = null;
}

// With a triggerable meter connected and nothing typed yet, the primary
// key fires the laser instead of committing - one thumb position for
// shoot, shoot, commit, so aim never has to be broken to hunt a button.
// Only where an empty OK has no other meaning (flows that treat empty as
// "keep current" keep their OK).
function okIsShoot() {
  if (!laser.canTrigger) return false;
  if (ui.fields[ui.active]) return false;
  if (ui.flow && ui.flow.kind !== 'record') return false;
  return ui.mode === 'measure' || anchorMode();
}

// Which mark the next distance is for. A distance is symmetric - you
// may stand at either end - so this only ever NAMES the mark, never
// tells you which way to point.
function aimTarget() {
  if (!ui.refs.length || ui.mode !== 'measure' || ui.flow || anchorMode()) return null;
  const id = multiMode() ? ui.refs[ui.multiD.length] : ui.refs[ui.active];
  return id != null && pos(id) ? id : null;
}

// Multi-reference fixing: past the first two refs, distances are entered
// one at a time into ui.multiD.
const multiMode = () =>
  !ui.flow && ui.mode === 'measure' && !anchorMode() && ui.refs.length > 2;

// Candidate positions from the first two distances against the first two
// refs (extra references refine the fix through least squares on commit).
function preview() {
  if (ui.refs.length < 2 || !twoFieldFlow()) return null;
  let d1, d2;
  if (multiMode()) {
    const k = ui.multiD.length;
    d1 = ui.multiD[0] ?? (k === 0 ? parseDistance(ui.fields[0]) : null);
    d2 = ui.multiD[1] ?? (k === 1 ? parseDistance(ui.fields[0]) : null);
  } else if (ui.refs.length !== 2) {
    return null;
  } else {
    d1 = parseDistance(ui.fields[0]);
    d2 = parseDistance(ui.fields[1]);
  }
  if (d1 == null || d2 == null) return { d1, d2, cands: null };
  const c = circleIntersect(pos(ui.refs[0]), d1, pos(ui.refs[1]), d2);
  if (!c.ok) return { d1, d2, cands: null };
  return { d1, d2, cands: c };
}

function wallSegments() {
  const segs = [];
  for (const wall of store.state.walls) {
    if (!onFloor(wall)) continue;
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
  // Active-floor points win; ghosted other-floor points are still tappable
  // (that is how you pick a point to stack above).
  let best = null, bestD = 26, bestActive = false;
  for (const pt of store.state.points) {
    const p = pos(pt.id);
    if (!p || !floorVisible(pt.floor)) continue;
    const sp = plan.worldToScreen(p.x, p.y);
    const d = Math.hypot(sp.x - screen.x, sp.y - screen.y);
    const active = onFloor(pt);
    if (d < 26 && (d < bestD || (active && !bestActive))) {
      if (active || !bestActive) { best = pt.id; bestD = d; bestActive = active; }
    }
  }
  return best;
}

function hitItem(world) {
  const vis = visibleLayers();
  const items = store.state.items.filter((i) => vis.has(i.layer) && onFloor(i));
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
  toast(`${draft.name} placed`, 'good');
  endFlow(`${draft.name} placed - drag to adjust, lock when happy`, 'good');
  return id;
}

// --- measure-mode actions --------------------------------------------------

function toggleRef(id) {
  const i = ui.refs.indexOf(id);
  if (i >= 0) ui.refs.splice(i, 1);
  else if (ui.refs.length < 4) ui.refs.push(id);
  else return say('Four references is the maximum - tap one to deselect it first', 'warn');
  ui.multiD = [];
  ui.flipArm = null;
  ui.message = null;
  render();
}

function commitAnchor() {
  const d = parseDistance(ui.fields[0]);
  if (d == null) return say('Type the distance between anchor A and anchor B', 'warn');
  const { a, b } = store.setAnchors(d, { wall: !ui.wallPause });
  ui.refs = [a, b];
  ui.fields = ['', ''];
  ui.active = 0;
  plan.fitAll([...store.solved.pos.values()]);
  toast('A and B placed', 'good');
  say(ui.wallPause
    ? 'A-B fixed. Fix reference points around the space next - then build the outline in walls mode (or turn walling on to chain as you measure).'
    : 'A-B fixed and walling started. Measure the corners in order round the room.');
}

// Explain WHY two circles cannot meet, with the numbers and a way out.
function gapExplain(c, d1, d2) {
  const n1 = store.point(ui.refs[0])?.name ?? 'ref 1';
  const n2 = store.point(ui.refs[1])?.name ?? 'ref 2';
  const p1 = pos(ui.refs[0]), p2 = pos(ui.refs[1]);
  const sep = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  if (d1 + d2 < sep) {
    return `Too short by ${(c.gap * 100).toFixed(1)} cm: ${fmtDist(d1)} + ${fmtDist(d2)} cannot span the ${fmtDist(sep)} between ${n1} and ${n2}. Re-measure, or check a cm/m mix-up.`;
  }
  return `${fmtDist(Math.max(d1, d2))} overshoots: it is more than the distance ${n1} to ${n2} (${fmtDist(sep)}) plus the other reading. One value is too long - re-measure it.`;
}

// A room has just been closed: ask for its ceiling height on the keypad.
function roomClosed(wallId) {
  const h = store.wall(wallId)?.height || store.state.roomHeight || 2.6;
  startFlow({ kind: 'room-height', wallId },
    `Room closed. Ceiling height in cm? OK keeps ${Math.round(h * 100)} cm.`);
}

function closeRoomAction() {
  const wall = store.openWall();
  if (!wall || wall.pts.length < 3) return say('Need at least 3 points in the wall run first', 'warn');
  store.closeWall(wall.id);
  ui.activeWallId = null;
  roomClosed(wall.id);
}

// In the item corner flows, tapping an already-fixed point uses that point
// as the corner directly - but only once both reference slots are filled
// and nothing is typed, so ref selection by tapping still works.
function cornerFromPoint(pid) {
  if (!(ui.flow?.kind === 'item-c1' || ui.flow?.kind === 'item-c2')) return false;
  if (ui.refs.length < 2) return false;
  if (parseDistance(ui.fields[0]) != null || parseDistance(ui.fields[1]) != null) return false;
  const p = pos(pid);
  if (!p) return false;
  acceptCorner({ x: p.x, y: p.y });
  return true;
}

// Shared corner-transition for item flows: called with a resolved position.
function acceptCorner(c) {
  if (ui.flow.kind === 'item-c1') {
    ui.flow = { kind: 'item-c2', draft: ui.flow.draft, c1: c };
    ui.fields = ['', ''];
    ui.active = 0;
    ui.flowSide = 1;
    say('Corner 2: distances, tap a point or wall, or OK to use item width');
    return;
  }
  const dx = c.x - ui.flow.c1.x, dy = c.y - ui.flow.c1.y;
  const wEff = Math.hypot(dx, dy);
  if (wEff < 0.02) return say('Corners coincide - measure the far corner', 'warn');
  ui.flow = {
    kind: 'item-side', draft: ui.flow.draft, c1: ui.flow.c1,
    dir: { x: dx / wEff, y: dy / wEff }, wEff,
  };
  ui.fields = ['', ''];
  ui.flowSide = 1;
  say('Tap the rectangle that matches reality (flip swaps), OK commits');
}

function commitPoint(side) {
  if (ui.refs.length !== 2) return say('Tap 2 reference points on the plan first', 'warn');
  const d1 = parseDistance(ui.fields[0]);
  const d2 = parseDistance(ui.fields[1]);
  if (d1 == null || d2 == null) {
    ui.active = d1 == null ? 0 : 1;
    return say('Type both distances, then OK', 'warn');
  }
  const off = offFloorRefs();
  if (off.length) {
    return say(`${off.map((id) => store.point(id).name).join(', ')} is on another floor - press "stack here" to pin it to this floor first (laser distances across floors are slant, not plan)`, 'warn');
  }
  const c = circleIntersect(pos(ui.refs[0]), d1, pos(ui.refs[1]), d2);
  if (!c.ok) return say('Reference points coincide', 'warn');
  if (c.gap > CLAMP_TOL) { buzz(200); return say(gapExplain(c, d1, d2), 'err'); }
  // Corner flows share the two-distance commit path.
  if (ui.flow?.kind === 'item-c1' || ui.flow?.kind === 'item-c2') {
    return acceptCorner(side >= 0 ? c.left : c.right);
  }
  const name = store.nextName();
  // Until this floor's first room is closed, new points chain straight
  // into the wall run - measuring the room IS drawing it. The pause
  // toggle exempts reference-only points (marks you cannot see A/B from).
  const autoWall = !store.hasClosedRoomOn(activeFloor()) && ui.wallPause !== true;
  ui.lastId = store.addPoint(ui.refs[0], ui.refs[1], d1, d2, side, { autoWall });
  ui.fields = ['', ''];
  ui.active = 0;
  const p = pos(ui.lastId);
  if (p && !plan.isOnScreen(p.x, p.y)) plan.fitAll([...store.solved.pos.values()]);
  const wallHint = autoWall && (store.openWall()?.pts.length >= 3)
    ? ' - "close room" when you are back at the start'
    : '';
  buzz([30, 60, 30]);
  toast(`${name} placed`, 'good');
  say(`${name} placed - flip if it is on the wrong side${wallHint}`, 'good');
}

// Commit a point fixed against 3-4 references: the first two form the
// chain fix, the rest become bundled check measurements so least squares
// balances everything at once. With a third distance the mirror ambiguity
// resolves itself - the side whose candidate best matches the extra
// distances wins (a tapped ghost still overrides).
function commitMultiPoint(forcedSide = null) {
  const off = offFloorRefs();
  if (off.length) {
    return say(`${off.map((id) => store.point(id).name).join(', ')} is on another floor - press "stack here" first`, 'warn');
  }
  const d = ui.multiD;
  const c = circleIntersect(pos(ui.refs[0]), d[0], pos(ui.refs[1]), d[1]);
  if (!c.ok) return say('The first two references coincide', 'warn');
  if (c.gap > CLAMP_TOL) {
    buzz(200);
    return say(gapExplain(c, d[0], d[1]) + ' (del steps back a reading, Escape restarts)', 'err');
  }
  const m = d.length;
  const extraRefs = ui.refs.slice(2, m);
  let side = forcedSide;
  if (side == null) {
    let sumL = 0, sumR = 0;
    extraRefs.forEach((r, i) => {
      const rp = pos(r);
      sumL += Math.abs(Math.hypot(c.left.x - rp.x, c.left.y - rp.y) - d[i + 2]);
      sumR += Math.abs(Math.hypot(c.right.x - rp.x, c.right.y - rp.y) - d[i + 2]);
    });
    side = extraRefs.length ? (sumL <= sumR ? 1 : -1) : 1;
  }
  const name = store.nextName();
  const autoWall = !store.hasClosedRoomOn(activeFloor()) && ui.wallPause !== true;
  ui.lastId = store.addPoint(ui.refs[0], ui.refs[1], d[0], d[1], side, {
    autoWall, extras: extraRefs.map((r, i) => ({ p: r, d: d[i + 2] })),
  });
  ui.multiD = [];
  ui.fields = ['', ''];
  ui.active = 0;
  const p = pos(ui.lastId);
  if (p && !plan.isOnScreen(p.x, p.y)) plan.fitAll([...store.solved.pos.values()]);
  const res = (store.solved.pres.get(ui.lastId) || 0) * 100;
  const cls = res < 1 ? 'good' : res < 3 ? 'warn' : 'err';
  buzz([30, 60, 30]);
  toast(`${name} fixed - worst residual ${res.toFixed(1)} cm`, cls);
  say(`${name} fixed from ${2 + extraRefs.length} references (side chosen automatically) - worst residual ${res.toFixed(1)} cm`, cls);
}

// Replace every off-floor reference with a stacked twin pinned to this
// floor at the same plan position.
function stackRefs() {
  const off = offFloorRefs();
  if (!off.length) return;
  const autoWall = !store.hasClosedRoomOn(activeFloor()) && ui.wallPause !== true;
  const made = [];
  for (const id of off) {
    const nid = store.addStackedPoint(id, { autoWall });
    ui.refs[ui.refs.indexOf(id)] = nid;
    made.push(`${store.point(nid).name} above ${store.point(id).name}`);
    ui.lastId = nid;
  }
  say(`Stacked ${made.join(', ')} - measure from ${made.length > 1 ? 'them' : 'it'} now`, 'good');
}

function commitCheck() {
  if (ui.refs.length !== 2) return say('Tap 2 points to record a distance between them', 'warn');
  if (offFloorRefs().length) return say('Both points must be on this floor (cross-floor laser shots are slant distances)', 'warn');
  const v = parseDistance(ui.fields[ui.active]) ?? parseDistance(ui.fields[0]);
  if (v == null) return say('Type the measured distance first', 'warn');
  const [n1, n2] = ui.refs.map((id) => store.point(id).name);
  // Sanity-check against the current solution: a reading far off the solved
  // distance is almost always a typo or a cm/m mix-up, and committing it
  // would drag every point toward a compromise. Ask before accepting.
  const p1 = pos(ui.refs[0]), p2 = pos(ui.refs[1]);
  const predicted = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  const diff = Math.abs(v - predicted);
  const existing = pairMeasurement();
  const armKey = `${ui.refs[0]}:${ui.refs[1]}:${v}`;
  if (diff > 0.15 && ui.checkArm !== armKey) {
    ui.checkArm = armKey;
    return say(`${n1} to ${n2} currently solves to ${fmtDist(predicted)}, but you typed ${fmtDist(v)} - ${(diff * 100).toFixed(0)} cm apart. Typo or cm/m mix-up? Press ${existing ? 'edit' : 'record'} again to keep it anyway.`, 'err');
  }
  ui.checkArm = null;
  if (!ui.coachDone) coachFinish();
  // An already-measured pair is CHANGED, never duplicated - whichever
  // route got here (typed then pressed, or through the flow).
  if (existing) {
    store.updateMeasurement(existing.id, v);
    ui.fields = ['', ''];
    ui.active = 0;
    const r0 = (store.solved.mres.get(existing.id) || 0) * 100;
    return note(`${n1} to ${n2} updated to ${fmtDist(v)} - residual ${r0.toFixed(1)} cm`,
      Math.abs(r0) < 1 ? 'good' : Math.abs(r0) < 3 ? 'warn' : 'err');
  }
  const id = store.addMeasurement(ui.refs[0], ui.refs[1], v);
  const r = (store.solved.mres.get(id) || 0) * 100;
  ui.fields = ['', ''];
  ui.active = 0;
  if (Math.abs(r) >= 3) {
    say(`Check recorded, but it disagrees by ${Math.abs(r).toFixed(1)} cm - all points have shifted to a compromise. If it was wrong, delete or edit it in data.`, 'err');
  } else {
    note(`Check recorded - residual ${r.toFixed(1)} cm`, Math.abs(r) < 1 ? 'good' : 'warn');
  }
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
      if (multiMode() && !f[ui.active] && ui.multiD.length) {
        // A mis-fired laser reading is retracted one step at a time.
        const popped = ui.multiD.pop();
        return say(`Removed ${fmtDist(popped)} - shoot ${store.point(ui.refs[ui.multiD.length])?.name} again`, 'warn');
      }
      if (!f[ui.active] && ui.active === 1) ui.active = 0; // step back a field
      else f[ui.active] = f[ui.active].slice(0, -1);
    }
  }

  if (key === 'flip') return pressFlip();
  if (key === 'ok') return okIsShoot() ? laser.remoteTrigger() : pressOk();
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
  // A single selected point flips no matter when it was measured. Its
  // dependents re-solve from the new position with their stored sides;
  // when the whole branch turns out mirrored, a second press of flip
  // mirrors the dependents as well.
  if (ui.mode === 'measure' && !ui.flow && ui.refs.length === 1) {
    const id = ui.refs[0];
    const pt = store.point(id);
    if (pt?.fix?.side != null) {
      if (ui.flipArm === id) {
        ui.flipArm = null;
        const branch = store.flipDependents(id);
        const flipped = branch.filter((p) => p.fix?.side != null);
        return note(flipped.length
          ? `${flipped.map((p) => p.name).join(', ')} mirrored to follow ${pt.name}`
          : `Nothing measured from ${pt.name} to mirror`, 'good');
      }
      store.flipSide(id);
      const deps = store.pointBranch(id);
      ui.flipArm = deps.length ? id : null;
      return say(`${pt.name} flipped to the other side${deps.length
        ? ` - ${deps.map((p) => p.name).join(', ')} re-solved from it. If they landed mirrored too, press flip again.`
        : ''}`, 'good');
    }
  }
  if (ui.lastId && store.point(ui.lastId)?.fix?.side != null) store.flipSide(ui.lastId);
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
  if (ui.flow?.kind === 'record') {
    const v = parseDistance(ui.fields[0]);
    if (v == null) return say('Type the measured distance', 'warn');
    const { p, q, measId } = ui.flow;
    const [n1, n2] = [store.point(p)?.name, store.point(q)?.name];
    const p1 = pos(p), p2 = pos(q);
    if (p1 && p2) {
      const predicted = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      const diff = Math.abs(v - predicted);
      if (diff > 0.15 && ui.checkArm !== `flow:${v}`) {
        ui.checkArm = `flow:${v}`;
        return say(`${n1} to ${n2} currently solves to ${fmtDist(predicted)}, but you typed ${fmtDist(v)} - ${(diff * 100).toFixed(0)} cm apart. Typo or cm/m mix-up? Press OK again to keep it.`, 'err');
      }
    }
    ui.checkArm = null;
    if (measId != null) {
      store.updateMeasurement(measId, v);
      toast(`${n1}-${n2} updated to ${fmtDist(v)}`, 'good');
      return endFlow(`${n1} to ${n2} updated to ${fmtDist(v)}`, 'good');
    }
    const id = store.addMeasurement(p, q, v);
    const r = (store.solved.mres.get(id) || 0) * 100;
    toast(`Check recorded (${r.toFixed(1)} cm)`, Math.abs(r) < 1 ? 'good' : Math.abs(r) < 3 ? 'warn' : 'err');
    return endFlow(Math.abs(r) >= 3
      ? `Recorded, but it disagrees by ${Math.abs(r).toFixed(1)} cm - points shifted to a compromise. Edit or delete it in data if it was wrong.`
      : `${n1} to ${n2} recorded - residual ${r.toFixed(1)} cm`, Math.abs(r) < 1 ? 'good' : 'warn');
  }
  if (ui.flow?.kind === 'edit-meas') {
    const v = parseDistance(ui.fields[0]);
    if (v == null) return say('Type the corrected distance', 'warn');
    store.updateMeasurement(ui.flow.measId, v);
    toast('Measurement updated', 'good');
    return endFlow('Measurement updated', 'good');
  }
  if (ui.flow?.kind === 'room-height') {
    const v = parseDistance(ui.fields[0]);
    const wallId = ui.flow.wallId;
    if (v != null) store.setWallHeight(wallId, v);
    const h = store.wall(wallId)?.height || store.state.roomHeight || 2.6;
    toast(`Ceiling ${Math.round(h * 100)} cm for this room`, 'good');
    return endFlow(`Ceiling ${Math.round(h * 100)} cm for this room`, 'good');
  }
  if (ui.flow?.kind === 'wall-edit') {
    if (ui.active === 0) {
      ui.active = 1;
      return render();
    }
    const t = parseDistance(ui.fields[0]);
    const hv = parseDistance(ui.fields[1]);
    if (t == null && hv == null) return endFlow('Wall unchanged');
    const patch = { t };
    if (hv != null) {
      if (ui.flow.zone !== 'b') patch.h1 = hv;
      if (ui.flow.zone !== 'a') patch.h2 = hv;
    }
    store.setWallSeg(ui.flow.wallId, ui.flow.key, patch);
    const bits = [];
    if (t != null) bits.push(`thickness ${Math.round(t * 100)} cm`);
    if (hv != null) bits.push(`height ${Math.round(hv * 100)} cm`);
    toast(`Wall updated: ${bits.join(', ')}`, 'good');
    return endFlow(`Wall updated: ${bits.join(', ')}`, 'good');
  }
  if (ui.flow?.kind === 'item-c2' && parseDistance(ui.fields[0]) == null && parseDistance(ui.fields[1]) == null) {
    // Keep the item's own width, axis-aligned; rotate/drag later.
    ui.flow = { kind: 'item-side', draft: ui.flow.draft, c1: ui.flow.c1, dir: { x: 1, y: 0 }, wEff: ui.flow.draft.w };
    ui.flowSide = 1;
    return say('Tap the rectangle that matches reality (flip swaps), OK commits');
  }

  if (multiMode()) {
    const v = parseDistance(ui.fields[0]);
    if (v == null) {
      return say(`Type the distance to ${store.point(ui.refs[ui.multiD.length])?.name}`, 'warn');
    }
    ui.multiD.push(v);
    ui.fields = ['', ''];
    ui.active = 0;
    if (ui.multiD.length >= ui.refs.length) return commitMultiPoint();
    return render();
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

// Returns true when the tap hit something and acted on it; unconsumed taps
// feed the plan view's double-tap zoom.
function handleTap(world, screen) {
  if (ui.view === '3d') return false;

  if (ui.mode === 'wall') {
    const pid = hitPoint(screen);
    if (pid != null) {
      const r = store.addWallPoint(ui.activeWallId, pid);
      ui.activeWallId = r.closed ? null : r.wallId;
      if (r.closed) roomClosed(r.wallId);
      else say('Wall: tap the next point (first point again closes)');
      return true;
    }
    // Tap on a wall segment: edit its thickness and height. Tapping near an
    // end edits the height at that end only (sloped ceilings); the middle
    // sets both ends.
    const seg = hitWall(world, screen);
    if (seg) {
      openWallEditor(seg);
      return true;
    }
    return false;
  }

  if (ui.mode === 'move' && !ui.flow) {
    const iid = hitItem(world);
    if (iid != null) {
      ui.selItem = iid;
      ui.message = null;
      render();
      return true;
    }
    ui.selItem = null;
    // No item under the tap: a wall tap opens the wall editor here too.
    const seg = hitWall(world, screen);
    if (seg) {
      openWallEditor(seg);
      return true;
    }
    ui.message = null;
    render();
    return false;
  }

  if (ui.flow?.kind === 'item-side') {
    for (const cand of sideCandidates(ui.flow)) {
      if (pointInItem(world, { ...cand.rect }, 4 * plan.worldPerPx)) {
        commitItemAt(cand.rect, ui.flow.draft);
        return true;
      }
    }
    return false;
  }
  if (ui.flow?.kind === 'item-wallmount') {
    const wall = hitWall(world, screen);
    if (!wall) { say('Tap a wall segment (draw walls first in wall mode)', 'warn'); return false; }
    const nearEnd = wall.t <= 0.5 ? 0 : 1;
    ui.flow = { kind: 'item-walloffset', draft: ui.flow.draft, wall, endIdx: nearEnd };
    ui.fields = ['', ''];
    ui.active = 0;
    ui.flowSide = 1;
    say('Distance from the marked wall end to the item edge (flip swaps end)');
    return true;
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
        say('Aligned with wall - tap the matching rectangle, OK commits');
        return true;
      }
    }
  }

  // Point-fixing flows: ghosts first (bigger target), then reference points.
  if (twoFieldFlow()) {
    const pv = preview();
    if (pv && pv.cands && pv.cands.gap <= CLAMP_TOL) {
      for (const [side, p] of [[+1, pv.cands.left], [-1, pv.cands.right]]) {
        const sp = plan.worldToScreen(p.x, p.y);
        if (Math.hypot(sp.x - screen.x, sp.y - screen.y) < 30) {
          if (multiMode() && ui.multiD.length >= 2) commitMultiPoint(side);
          else if (!multiMode()) commitPoint(side);
          else return false;
          return true;
        }
      }
    }
    const pid = hitPoint(screen);
    if (pid != null) {
      if (cornerFromPoint(pid)) return true;
      toggleRef(pid);
      return true;
    }
  }
  return false;
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

// --- survey check sheet ------------------------------------------------------

function renderDoctor() {
  const list = $('doctor-list');
  list.innerHTML = '';
  const issues = surveyIssues();
  if (!issues.length) {
    list.innerHTML = '<div class="doc-card info"><b>No problems found</b>' +
      '<p>Every point solves, no side flags disagree, residuals are inside 3 cm and no fix has a dangerously shallow angle. ' +
      'Recorded diagonals are still the cheapest insurance - select two points, press record, type the taped or shot distance.</p></div>';
    return;
  }
  for (const iss of issues) {
    const card = document.createElement('div');
    card.className = 'doc-card ' + iss.sev;
    card.innerHTML = `<b>${iss.title}</b><p>${iss.body}</p>` +
      (iss.steps.length ? `<ol>${iss.steps.map((t) => `<li>${t}</li>`).join('')}</ol>` : '');
    if (iss.selectIds?.length) {
      const btn = document.createElement('button');
      btn.textContent = iss.selectIds.length > 1
        ? `select ${iss.selectIds.map((id) => store.point(id)?.name).join(' + ')}`
        : `select ${store.point(iss.selectIds[0])?.name}`;
      btn.addEventListener('click', () => {
        ui.refs = iss.selectIds.filter((id) => store.point(id) && pos(id));
        ui.mode = 'measure';
        ui.flow = null;
        $('doctor-sheet').hidden = true;
        say(iss.selectIds.length > 1
          ? 'Pair selected - press record (or edit) and type the measured distance'
          : 'Point selected - press flip to heal it, or delete if it is wrong');
      });
      const row = document.createElement('div');
      row.className = 'row';
      row.appendChild(btn);
      card.appendChild(row);
    }
    list.appendChild(card);
  }
}

$('health-pill').addEventListener('click', () => {
  $('doctor-sheet').hidden = false;
  renderDoctor();
});
$('doctor-close').addEventListener('click', () => { $('doctor-sheet').hidden = true; });
$('doctor-sheet').addEventListener('click', (e) => {
  if (e.target === $('doctor-sheet')) $('doctor-sheet').hidden = true;
});

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
  else {
    addRow(
      '<span class="log-name">between</span><span class="log-val">measured</span>' +
      '<span class="log-res">error</span><span class="log-actions"></span>',
      'log-cols'
    );
  }
  for (const m of store.state.measurements) {
    const a = store.point(m.p)?.name ?? '?', b = store.point(m.q)?.name ?? '?';
    const r = store.solved.mres.get(m.id);
    const broken = r == null && (store.solved.errors?.has(m.p) || store.solved.errors?.has(m.q));
    const rc = broken ? 'err' : r == null ? '' : Math.abs(r) < 0.01 ? 'good' : Math.abs(r) < 0.03 ? 'warn' : 'err';
    const rtxt = broken ? 'unsolved' : r == null ? '' : `${(r * 100).toFixed(1)} cm`;
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
    row.querySelector('[data-act="del"]').addEventListener('click', () => {
      // Deleting a measurement a fix depends on unsolves points; make the
      // cascade explicit and require a second press.
      const load = store.measurementLoad(m.id);
      if (load.length && ui.measArm !== m.id) {
        ui.measArm = m.id;
        say(`${a} to ${b} fixes ${load.map((p) => p.name).join(', ')} - deleting it leaves them (and anything measured from them) unsolved. Press x again to delete anyway.`, 'err');
        return;
      }
      ui.measArm = null;
      store.deleteMeasurement(m.id);
    });
  }

  section('points');
  if (!store.state.points.length) addRow('<span class="dim">none yet</span>');
  else {
    addRow('<span class="log-name">point</span><span class="log-val">note (what it is)</span>', 'log-cols');
    for (const pt of store.state.points) {
      const fl = store.floor(pt.floor);
      const row = addRow(
        `<span class="log-name"><b>${pt.name}</b>${fl && pt.floor !== activeFloor() ? ` <span class="dim">${fl.name}</span>` : ''}</span>` +
        `<input data-act="note" placeholder="e.g. left window reveal" value="${(pt.note ?? '').replace(/"/g, '&quot;')}">`
      );
      const input = row.querySelector('[data-act="note"]');
      input.addEventListener('change', () => {
        store.setPointNote(pt.id, input.value);
        toast(input.value.trim() ? `${pt.name}: ${input.value.trim()}` : `${pt.name} note cleared`, 'good');
      });
    }
  }

  const unsolved = unsolvedPoints(false);
  if (unsolved.length) {
    section('unsolved points');
    for (const u of unsolved) {
      const floorName = store.floor(u.pt.floor)?.name;
      const row = addRow(
        `<span class="log-name">${u.pt.name}${floorName && u.pt.floor !== activeFloor() ? ` <span class="dim">(${floorName})</span>` : ''}</span>` +
        `<span class="log-res err">${u.reason}</span>` +
        `<button data-act="del">x</button>`
      );
      row.querySelector('[data-act="del"]').addEventListener('click', () => {
        const deps = store.pointBranch(u.pt.id);
        if (deps.length && ui.measArm !== `pt${u.pt.id}`) {
          ui.measArm = `pt${u.pt.id}`;
          say(`${u.pt.name} has ${deps.map((d) => d.name).join(', ')} measured from it - deleting unsolves them too. Press x again to delete anyway.`, 'err');
          return;
        }
        ui.measArm = null;
        store.deletePoint(u.pt.id);
        toast(`${u.pt.name} deleted`, 'good');
      });
    }
    addRow('<span class="dim">an unsolved point usually means one of its two fix distances is wrong - edit it in the measurements above</span>');
  }

  const mism = sideMismatches();
  if (mism.length) {
    section('side flags to heal');
    for (const pt of mism) {
      addRow(
        `<span class="log-name">${pt.name}</span>` +
        `<span class="log-res warn">solution is on the other side of its reference line - select ${pt.name} and press flip</span>`
      );
    }
  }

  section('walls and rooms');
  if (!store.state.walls.length) addRow('<span class="dim">none yet - points auto-chain into walls until a room closes</span>');
  for (const w of store.state.walls) {
    const names = w.pts.map((id) => store.point(id)?.name ?? '?').join('-');
    const h = Math.round((w.height || store.state.roomHeight || 2.6) * 100);
    const row = addRow(
      `<span class="log-name">${names}${w.closed ? ` <span class="dim">room, ceiling ${h} cm</span>` : ' <span class="dim">open run</span>'}</span>` +
      (w.closed ? `<button data-act="height">ceiling</button>` : '') +
      `<button data-act="del">x</button>`
    );
    row.querySelector('[data-act="height"]')?.addEventListener('click', () => {
      $('log-sheet').hidden = true;
      startFlow({ kind: 'room-height', wallId: w.id },
        `Ceiling height for ${names} in cm (now ${h} cm)`);
    });
    row.querySelector('[data-act="del"]').addEventListener('click', () => { store.deleteWall(w.id); });
  }

  section('layers');
  for (const l of store.state.layers) {
    const row = addRow(
      `<span class="pill ${l.visible ? 'on' : 'off'}">${l.visible ? 'shown' : 'hidden'}</span>` +
      `<span class="log-name ${store.state.activeLayer === l.id ? 'active-layer' : ''}">${l.name}</span>` +
      `<button data-act="vis">${l.visible ? 'hide' : 'show'}</button>` +
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
    if (name) {
      store.addLayer(name);
      toast(`Layer "${name}" added`, 'good');
    }
  });

  section('floors');
  for (const f of store.state.floors) {
    const active = store.state.activeFloor === f.id;
    const row = addRow(
      `<span class="pill ${f.visible ? 'on' : 'off'}">${f.visible ? 'shown' : 'hidden'}</span>` +
      `<span class="log-name ${active ? 'active-layer' : ''}">${f.name}</span>` +
      `<input data-act="elev" type="number" value="${Math.round(f.elevation * 100)}"> cm ` +
      `<button data-act="vis">${f.visible ? 'hide' : 'show'}</button>` +
      `<button data-act="use">${active ? 'active' : 'go'}</button>` +
      (store.state.floors.length > 1 && store.floorEmpty(f.id) ? `<button data-act="del">x</button>` : '')
    );
    row.querySelector('[data-act="vis"]').addEventListener('click', () => store.setFloorVisible(f.id, !f.visible));
    row.querySelector('[data-act="use"]').addEventListener('click', () => store.setActiveFloor(f.id));
    row.querySelector('[data-act="elev"]').addEventListener('change', (e) => {
      const v = parseFloat(e.target.value);
      if (isFinite(v)) store.setFloorElevation(f.id, v / 100);
    });
    row.querySelector('[data-act="del"]')?.addEventListener('click', () => store.deleteFloor(f.id));
  }
  const addFloorRow = addRow(
    `<input id="new-floor-name" placeholder="floor name"><input id="new-floor-off" type="number" placeholder="+cm" value="290"><button data-act="addf">+ floor</button>`
  );
  addFloorRow.querySelector('[data-act="addf"]').addEventListener('click', () => {
    const name = $('new-floor-name').value.trim() || `floor ${store.state.floors.length + 1}`;
    const off = parseFloat($('new-floor-off').value);
    const base = store.floor(store.state.activeFloor)?.elevation ?? 0;
    store.addFloor(name, base + (isFinite(off) ? off / 100 : 2.9));
    note(`${name} added and active - tap a ghosted point below, then "stack here" to anchor it`, 'good');
    $('log-sheet').hidden = true;
  });

  // Floor-to-floor is rarely measurable directly - derive it. From the
  // stairs: riser count x riser height, with odd first/last risers. Or:
  // ceiling height at the stairwell + the floor build-up you can measure
  // at the opening's edge.
  if (store.state.floors.length > 1) {
    section('floor-to-floor calculator');
    const num = (id) => {
      const v = parseFloat($(id)?.value);
      return isFinite(v) && v > 0 ? v : null;
    };
    const riseRow = addRow(
      `<input id="fc-n" type="number" placeholder="risers" title="number of risers"> x ` +
      `<input id="fc-r" type="number" placeholder="riser cm" title="typical riser"> ` +
      `first <input id="fc-b" type="number" placeholder="-" title="odd first riser, if different"> ` +
      `last <input id="fc-t" type="number" placeholder="-" title="odd last riser, if different"> ` +
      `<b id="fc-total1" class="log-res"></b>`
    );
    const ceilRow = addRow(
      `<span class="dim">or</span> ceiling <input id="fc-c" type="number" placeholder="cm"> ` +
      `+ floor build <input id="fc-f" type="number" placeholder="cm"> ` +
      `<b id="fc-total2" class="log-res"></b>`
    );
    const stairTotal = () => stairRise(num('fc-n'), num('fc-r'), num('fc-b'), num('fc-t'));
    const ceilTotal = () => (num('fc-c') != null && num('fc-f') != null ? num('fc-c') + num('fc-f') : null);
    const showTotals = () => {
      $('fc-total1').textContent = stairTotal() != null ? `= ${stairTotal().toFixed(1)} cm` : '';
      $('fc-total2').textContent = ceilTotal() != null ? `= ${ceilTotal().toFixed(1)} cm` : '';
    };
    for (const el of [...riseRow.querySelectorAll('input'), ...ceilRow.querySelectorAll('input')]) {
      el.addEventListener('input', showTotals);
    }
    const floorOpts = store.state.floors.slice(1)
      .map((f) => `<option value="${f.id}">${f.name}</option>`).join('');
    const applyRow = addRow(
      `<select id="fc-floor">${floorOpts}</select>` +
      `<button data-act="ap1">set from stairs</button>` +
      `<button data-act="ap2">set from ceiling</button>`
    );
    $('fc-floor').value = store.state.floors.at(-1).id;
    const apply = (total) => {
      if (total == null) return say('Fill the calculator fields first', 'warn');
      const target = store.floor($('fc-floor').value);
      const i = store.state.floors.findIndex((f) => f.id === target.id);
      const below = store.state.floors[i - 1];
      store.setFloorElevation(target.id, below.elevation + total / 100);
      note(`${target.name} set to ${total.toFixed(1)} cm above ${below.name}`, 'good');
    };
    applyRow.querySelector('[data-act="ap1"]').addEventListener('click', () => apply(stairTotal()));
    applyRow.querySelector('[data-act="ap2"]').addEventListener('click', () => apply(ceilTotal()));
  }

  const hRow = addRow(
    `<span class="log-name">default ceiling for new rooms</span>` +
    `<input id="room-h" type="number" value="${Math.round((store.state.roomHeight || 2.6) * 100)}"> cm ` +
    `<button data-act="set">set</button>`
  );
  hRow.querySelector('[data-act="set"]').addEventListener('click', () => {
    const v = parseFloat($('room-h').value);
    if (isFinite(v) && v > 100) {
      store.setRoomHeight(v / 100);
      toast(`Default ceiling ${Math.round(v)} cm`, 'good');
    }
  });
  const tRow = addRow(
    `<span class="log-name">default wall thickness (tap a wall in walls mode to override a segment)</span>` +
    `<input id="wall-t" type="number" value="${Math.round((store.state.wallThickness || 0.09) * 100)}"> cm ` +
    `<button data-act="sett">set</button>`
  );
  tRow.querySelector('[data-act="sett"]').addEventListener('click', () => {
    const v = parseFloat($('wall-t').value);
    if (isFinite(v) && v > 1) {
      store.setDefaultWallThickness(v / 100);
      toast(`Default wall thickness ${Math.round(v)} cm`, 'good');
    }
  });

  section('data');
  const dRow = addRow(
    `<button data-act="doctor">survey check</button>` +
    `<button data-act="export">download JSON</button>` +
    `<button data-act="copy">copy JSON</button>` +
    `<button data-act="import">import...</button>`
  );
  dRow.querySelector('[data-act="doctor"]').addEventListener('click', () => {
    $('log-sheet').hidden = true;
    $('doctor-sheet').hidden = false;
    renderDoctor();
  });
  dRow.querySelector('[data-act="export"]').addEventListener('click', exportJSON);
  dRow.querySelector('[data-act="copy"]').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(exportString());
      toast('JSON copied to clipboard', 'good');
      $('log-sheet').hidden = true;
    } catch { toast('Clipboard blocked - use download instead', 'warn'); }
  });
  dRow.querySelector('[data-act="import"]').addEventListener('click', () => {
    $('import-box').hidden = !$('import-box').hidden;
  });
}

function exportString() {
  return JSON.stringify({
    app: 'house-measurer', version: store.state.v,
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
    note('Imported (undo restores the previous state)', 'good');
  } catch (e) {
    say(`Import failed: ${e.message}`, 'err');
  }
}

// --- rendering -------------------------------------------------------------

function fieldLabel(i) {
  if (anchorMode()) return 'first wall: A to B';
  if (ui.flow?.kind === 'item-walloffset') {
    return i === 0 ? `from ${store.point(ui.flow.wall[ui.flow.endIdx === 0 ? 'pa' : 'pb'])?.name ?? 'end'} to edge` : '';
  }
  if (ui.flow?.kind === 'edit-meas') {
    const m = store.measurement(ui.flow.measId);
    return i === 0 ? `${store.point(m?.p)?.name ?? '?'} to ${store.point(m?.q)?.name ?? '?'}` : '';
  }
  if (ui.flow?.kind === 'record') {
    return i === 0 ? `${store.point(ui.flow.p)?.name ?? '?'} to ${store.point(ui.flow.q)?.name ?? '?'}` : '';
  }
  if (ui.flow?.kind === 'room-height') return i === 0 ? 'ceiling height' : '';
  if (multiMode()) {
    const k = ui.multiD.length;
    const pt = store.point(ui.refs[k]);
    return i === 0
      ? `to ${pt?.name ?? '?'}${pt?.note ? ` - ${pt.note}` : ''} (${k + 1} of ${ui.refs.length})`
      : '';
  }
  if (ui.flow?.kind === 'wall-edit') {
    const w = store.wall(ui.flow.wallId);
    if (i === 0) {
      const curT = w?.thick?.[ui.flow.key] ?? store.state.wallThickness ?? 0.09;
      return `thickness (${Math.round(curT * 100)})`;
    }
    const roomH = w?.height || store.state.roomHeight || 2.6;
    const [h1, h2] = w?.segH?.[ui.flow.key] || [roomH, roomH];
    if (ui.flow.zone === 'a') return `height at ${store.point(ui.flow.pa)?.name} (${Math.round(h1 * 100)})`;
    if (ui.flow.zone === 'b') return `height at ${store.point(ui.flow.pb)?.name} (${Math.round(h2 * 100)})`;
    return `height (${Math.round(h1 * 100)}${h1 !== h2 ? '/' + Math.round(h2 * 100) : ''})`;
  }
  const id = ui.refs[i];
  if (!id) return `to ref ${i + 1} (${i + 1} of 2)`;
  const pt = store.point(id);
  return `to ${pt.name}${pt.note ? ` - ${pt.note}` : ''} (${i + 1} of 2)`;
}

function renderPanel() {
  const anchor = anchorMode();
  const oneField = ui.flow?.kind === 'item-walloffset' || ui.flow?.kind === 'edit-meas'
    || ui.flow?.kind === 'record' || ui.flow?.kind === 'room-height' || multiMode();
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

  for (const b of document.querySelectorAll('#modebar button[data-mode]')) {
    b.classList.toggle('on', b.dataset.mode === ui.mode);
  }

  if (showFields) {
    // One box at a time, always: two-value entries walk through their
    // fields sequentially (OK advances, del on an empty box steps back)
    // instead of showing a pair of boxes for one or two values.
    const single = anchor || oneField;
    $('field0').style.display = single || ui.active === 0 ? '' : 'none';
    $('field1').style.display = !single && ui.active === 1 ? '' : 'none';
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
    // Slots grow with the selection (2 minimum, 4 maximum). A filled chip
    // taps off; the trailing faint slot hints that more references help.
    const slots = $('refslots');
    slots.innerHTML = '';
    const shown = Math.max(2, Math.min(4, ui.refs.length + (ui.flow ? 0 : 1)));
    for (let i = 0; i < shown; i++) {
      const id = ui.refs[i];
      const el = document.createElement('span');
      const isNow = id != null && id === aimTarget();
      el.className = 'refslot' + (id ? ' set' : '') + (i >= 2 && !id ? ' extra' : '') + (isNow ? ' now' : '');
      el.textContent = id ? store.point(id).name : i < 2 ? `tap ref ${i + 1}` : '+ ref';
      if (isNow) el.title = store.point(id).note || 'the distance being entered now';
      if (id) el.addEventListener('click', () => toggleRef(id));
      slots.appendChild(el);
    }
    const pairM = pairMeasurement();
    $('check-btn').style.display = ui.refs.length === 2 && !ui.flow && !offFloorRefs().length ? '' : 'none';
    $('check-btn').textContent = pairM ? 'edit' : 'record';
    $('check-btn').title = pairM
      ? `change the recorded distance between these two points (now ${fmtDist(pairM.d)})`
      : 'record the measured distance between these two points';
    $('stack-btn').style.display = !ui.flow && offFloorRefs().length ? '' : 'none';
    $('del-point').style.display = ui.mode === 'measure' && !ui.flow && ui.refs.length === 1 ? '' : 'none';
    const selFlip = ui.refs.length === 1 && store.point(ui.refs[0])?.fix?.side != null ? ui.refs[0] : null;
    const lastFlip = ui.refs.length !== 1 && ui.lastId && store.point(ui.lastId)?.fix?.side != null ? ui.lastId : null;
    const flipTarget = ui.mode === 'measure' && !ui.flow ? (selFlip ?? lastFlip) : null;
    $('flip-btn').style.display = flipTarget ? '' : 'none';
    if (flipTarget) $('flip-btn').textContent = `flip ${store.point(flipTarget).name}`;
    const selPt = ui.refs.length === 1 ? ui.refs[0] : null;
    const inWall = selPt != null && store.state.walls.some((w) => w.pts.includes(selPt));
    $('unwall-btn').style.display = ui.mode === 'measure' && !ui.flow && inWall ? '' : 'none';
  }
  const autoWalling = !anchorMode() && !store.hasClosedRoomOn(activeFloor());
  $('pause-btn').style.display = ui.mode === 'wall' && !ui.flow && autoWalling ? '' : 'none';
  $('pause-btn').textContent = ui.wallPause ? 'walling: off' : 'walling: on';
  $('pause-btn').classList.toggle('on', !ui.wallPause);
  // The shoot row exists only when the meter can actually be triggered;
  // auto survey mode is configured in the laser panel.
  $('laserbar').style.display = laser.canTrigger && ui.mode === 'measure' && !ui.flow ? '' : 'none';
  $('shoot-btn').style.display = laser.canTrigger ? '' : 'none';
  // "close room" appears while a wall run with 3+ points is waiting.
  const open = store.openWall();
  const closable = !ui.flow && open && open.pts.length >= 3;
  $('close-room').style.display = closable && (ui.mode === 'measure' || ui.mode === 'wall') ? '' : 'none';
  $('wall-new').disabled = !ui.activeWallId && !open;
  $('show-work').classList.toggle('on', !!ui.showWork);
  $('show-work3d').classList.toggle('on', !!ui.showWork);
  const fb = $('floor-btn');
  fb.style.display = store.state.floors.length > 1 ? '' : 'none';
  fb.textContent = store.floor(activeFloor())?.name ?? 'floor';
  $('laser-btn').classList.toggle('on', !!laser.connected);

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

  // The keypad key is purely a candidate/side SWAP inside placement
  // flows; flipping a measured point is an action on that point and
  // lives next to delete in the refbar instead.
  const okKey = document.querySelector('[data-key="ok"]');
  if (okKey) {
    const shoot = okIsShoot();
    okKey.textContent = shoot ? 'shoot' : 'OK';
    okKey.classList.toggle('shoot', shoot);
  }
  const flipKey = document.querySelector('[data-key="flip"]');
  const zeroKey = document.querySelector('[data-key="0"]');
  if (flipKey) {
    const flowSwap = ui.flow?.kind === 'item-side' || ui.flow?.kind === 'item-walloffset' ||
      ((ui.flow?.kind === 'item-c1' || ui.flow?.kind === 'item-c2') && preview()?.cands);
    flipKey.style.display = flowSwap ? '' : 'none';
    flipKey.disabled = !flowSwap;
    if (zeroKey) zeroKey.style.gridArea = flowSwap ? '4 / 2' : '4 / 2 / 5 / 4';
  }

  // Status line.
  let msg = ui.message;
  if (!msg) {
    if (anchor) msg = { text: 'Measure your first wall: tape its two ends (A and B, corners are ideal), type the distance', cls: '' };
    else if (ui.mode === 'wall') msg = { text: ui.activeWallId ? 'Tap the next point (first point again closes)' : 'Tap points in order to draw a wall, or tap a wall to set its thickness', cls: '' };
    else if (ui.mode === 'move') msg = { text: ui.selItem ? 'Drag to move, handle rotates, flip = 90 degrees' : 'Tap an item to select it', cls: '' };
    else if (ui.mode === 'item') msg = { text: 'Tap an item to edit it, or add a new one', cls: '' };
    else if (ui.flow) msg = { text: '', cls: '' };
    else if (ui.refs.length < 2 && unsolvedPoints().length) {
      const u = unsolvedPoints();
      msg = {
        text: `${u.map((x) => x.pt.name).join(', ')} cannot be placed - ${u[0].reason}${u.length > 1 ? ' (first of ' + u.length + ')' : ''}. Edit the distances in data, or delete the point there.`,
        cls: 'err',
      };
    }
    else if (ui.refs.length < 2 && sideMismatches().length) {
      const names = sideMismatches().map((p) => p.name).join(', ');
      msg = { text: `${names}: the solved position contradicts the stored side flag (a rescued mirror) - select the point and press flip to heal it, or new points measured from it can fail.`, cls: 'warn' };
    }
    else if (ui.refs.length < 2) msg = { text: 'Tap 2 reference points on the plan', cls: '' };
    else if (multiMode()) {
      const k = ui.multiD.length;
      const t = store.point(ui.refs[k]);
      msg = {
        text: `Multi-fix: distance ${k + 1} of ${ui.refs.length}, ${t?.name}${t?.note ? ` - ${t.note}` : ''} - side picks itself from the extras`,
        cls: '',
      };
    }
    else {
      const pv = preview();
      if (pv && pv.cands && pv.cands.gap > CLAMP_TOL) {
        msg = { text: gapExplain(pv.cands, pv.d1, pv.d2), cls: 'err' };
      } else if (pv && pv.cands) {
        msg = { text: 'OK places the marked candidate - or tap the other one', cls: '' };
      } else {
        const t = store.point(ui.refs[ui.active]);
        msg = t
          ? { text: `Distance ${ui.active + 1} of 2: ${t.name}${t.note ? ` - ${t.note}` : ''}`, cls: '' }
          : { text: `Type distances to ${store.point(ui.refs[0]).name} and ${store.point(ui.refs[1]).name}`, cls: '' };
      }
    }
  }
  $('status').textContent = msg.text;
  $('status').className = msg.cls;

  $('undo').disabled = !store.canUndo;
  $('redo').disabled = !store.canRedo;
  $('view3d-btn').classList.toggle('on', ui.view === '3d');

  // Survey-check pill: appears only when the doctor has something to say.
  const nIssues = surveyIssues().filter((i) => i.sev !== 'info');
  const hp = $('health-pill');
  hp.hidden = nIssues.length === 0;
  if (nIssues.length) {
    hp.textContent = `check: ${nIssues.length}`;
    hp.className = nIssues.some((i) => i.sev === 'err') ? 'err' : 'warn';
  }

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
      // With walling on the first measurement IS the first wall; with the
      // reference-first default it is the baseline the survey hangs off.
      content.ghosts.push({ x: d, y: 0, primary: true });
      content.segments.push(ui.wallPause
        ? { x1: 0, y1: 0, x2: d, y2: 0, style: 'ab' }
        : { x1: 0, y1: 0, x2: d, y2: 0, style: 'wall', t: store.state.wallThickness ?? 0.09 });
      content.labels.push({ key: 'pB', x: d, y: 0, text: 'B', cls: 'name', dy: -18 });
      content.labels.push({
        key: 'dAB', x: d / 2, y: 0,
        text: `${ui.wallPause ? 'A to B' : 'first wall'} ${fmtDist(d)}`, cls: 'ray', dy: 16,
      });
      plan.fitAll([{ x: 0, y: 0 }, { x: d, y: 0 }]);
    }
    plan.update(content);
    return;
  }

  // Walls + closed-room fill: active floor solid, other visible floors as a
  // faint ghost underlay for cross-floor alignment.
  for (const wall of store.state.walls) {
    if (!floorVisible(wall.floor)) continue;
    const ghost = !onFloor(wall);
    const runs = wall.closed ? [...wall.pts, wall.pts[0]] : wall.pts;
    const active = wall.id === ui.activeWallId;
    // Measured points are on the inner wall surface: draw the wall band
    // shifted outward so the line through the points is its inner edge.
    // Closed rooms know their inside (the polygon); open runs use the
    // centroid of the floor's survey points instead - the surveyor and
    // every mark are inside the space, the far side is unreachable.
    const solved = wall.pts.map(pos).filter(Boolean);
    const runCen = solved.length ? {
      x: solved.reduce((s, q) => s + q.x, 0) / solved.length,
      y: solved.reduce((s, q) => s + q.y, 0) / solved.length,
    } : null;
    const cen = wall.closed && solved.length >= 3 ? runCen : floorCentroid(wall.floor) ?? runCen;
    for (let i = 0; i + 1 < runs.length; i++) {
      const a = pos(runs[i]), b = pos(runs[i + 1]);
      if (!a || !b) continue;
      const t = wall.thick?.[`${runs[i]}:${runs[i + 1]}`] ?? store.state.wallThickness ?? 0.09;
      let ox = 0, oy = 0;
      if (cen) {
        const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        let nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        if ((cen.x - mx) * nx + (cen.y - my) * ny > 0) { nx = -nx; ny = -ny; }
        ox = nx * t / 2; oy = ny * t / 2;
      }
      content.segments.push({
        x1: a.x + ox, y1: a.y + oy, x2: b.x + ox, y2: b.y + oy, t,
        style: ghost ? 'wallGhost' : active ? 'wallActive' : 'wall',
      });
    }
    if (wall.closed && !ghost) {
      const poly = wall.pts.map(pos).filter(Boolean);
      if (poly.length >= 3) content.polygons.push({ pts: poly, color: 0x9a8f6a, opacity: 0.07 });
    }
  }

  // Detail view: flag ill-conditioned fixes - rays meeting at a shallow
  // (or near-straight) angle mean the circles cross at a glancing angle,
  // so millimetres of laser noise become centimetres of position error
  // with no residual to show for it.
  if (ui.showWork) {
    for (const pt of pts) {
      if (!onFloor(pt) || !pt.fix || pt.fix.stack != null) continue;
      const p = pos(pt.id), r1 = pos(pt.fix.r1), r2 = pos(pt.fix.r2);
      if (!p || !r1 || !r2) continue;
      const ang = angleDeg(r1, p, r2);
      if (ang >= 30 && ang <= 150) continue;
      const bad = ang < 15 || ang > 165;
      content.labels.push({
        key: `fq${pt.id}`, x: p.x, y: p.y, dy: 46,
        text: `fix ${Math.round(ang)}°`,
        cls: bad ? 'res err' : 'res warn',
      });
    }
  }

  // Detail view: interior angles at every wall corner on this floor.
  if (ui.showWork) {
    const off = 26 * plan.worldPerPx;
    for (const wall of store.state.walls) {
      if (!onFloor(wall)) continue;
      const solved = wall.pts.map(pos);
      if (solved.some((p) => !p)) continue;
      const n = solved.length;
      const closed = wall.closed && n >= 3;
      const ints = closed ? interiorAngles(solved) : null;
      for (let i = 0; i < n; i++) {
        if (!closed && (i === 0 || i === n - 1)) continue;
        const v = solved[i];
        const prev = solved[(i - 1 + n) % n], next = solved[(i + 1) % n];
        const ang = closed ? ints[i] : angleDeg(prev, v, next);
        const l1 = Math.hypot(prev.x - v.x, prev.y - v.y) || 1;
        const l2 = Math.hypot(next.x - v.x, next.y - v.y) || 1;
        let bx = (prev.x - v.x) / l1 + (next.x - v.x) / l2;
        let by = (prev.y - v.y) / l1 + (next.y - v.y) / l2;
        const bl = Math.hypot(bx, by);
        if (bl < 1e-6) { bx = -(next.y - v.y) / l2; by = (next.x - v.x) / l2; }
        else { bx /= bl; by /= bl; }
        if (closed && ang > 180) { bx = -bx; by = -by; } // reflex: bisector flips
        content.labels.push({
          key: `an${wall.id}:${i}`, x: v.x + bx * off, y: v.y + by * off,
          text: `${Math.round(ang)}°`, cls: 'ang',
        });
      }
    }
  }

  // A-B baseline (only until walls exist; it is scaffolding, not geometry).
  if (!store.state.walls.length) {
    const pA = pos(pts[0]?.id), pB = pos(pts[1]?.id);
    if (pA && pB) content.segments.push({ x1: pA.x, y1: pA.y, x2: pB.x, y2: pB.y, style: 'ab' });
  }

  // Items on visible layers, active floor only.
  const vis = visibleLayers();
  for (const it of store.state.items) {
    if (!vis.has(it.layer) || !onFloor(it)) continue;
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
    // Stairs: draw the treads so the flight reads as steps in plan.
    if (it.category === 'stairs') {
      const n = stairSteps(it.h);
      const cos = Math.cos(rot), sin = Math.sin(rot);
      for (let s = 1; s < n; s++) {
        const lx = -it.w / 2 + (it.w * s) / n;
        content.segments.push({
          x1: x + lx * cos - (-it.d / 2) * sin, y1: y + lx * sin + (-it.d / 2) * cos,
          x2: x + lx * cos - (it.d / 2) * sin, y2: y + lx * sin + (it.d / 2) * cos,
          style: 'ray',
        });
      }
    }
  }

  // Points, names, residual badges. Active floor solid; other visible
  // floors ghosted (still tappable, for stacking). Reference rings only
  // where reference selection means something.
  const showRefs = ui.mode === 'measure' || twoFieldFlow() && ui.flow;
  for (const pt of pts) {
    const p = pos(pt.id);
    if (!p || !floorVisible(pt.floor)) continue;
    const ghost = !onFloor(pt);
    content.points.push({
      x: p.x, y: p.y,
      style: ghost ? 'ghostpt' : pt.fix ? 'point' : 'anchor',
      refIndex: showRefs && ui.refs.indexOf(pt.id) >= 0 ? ui.refs.indexOf(pt.id) : null,
      isLast: !ghost && pt.id === ui.lastId,
    });
    // Ghost labels sit higher so stacked twins do not print over their
    // owner's label at the same plan position.
    content.labels.push({
      key: `p${pt.id}`, x: p.x, y: p.y, text: pt.name,
      cls: ghost ? 'name faint' : 'name', dy: ghost ? -32 : -18,
    });
    if (ghost) continue;
    const res = store.solved.pres.get(pt.id) || 0;
    if (res >= 0.001) {
      const cls = res < 0.01 ? 'res good' : res < 0.03 ? 'res warn' : 'res err';
      content.labels.push({ key: `r${pt.id}`, x: p.x, y: p.y, text: `${(res * 100).toFixed(1)}`, cls, dy: 15 });
    }
  }
  // Unsolved points: red marker at the nearest-consistent position (or
  // none if their references are broken too) plus the reason, so a
  // failed fix is a visible, explained thing rather than a vanishing.
  for (const u of unsolvedPoints()) {
    if (!u.p) continue;
    content.points.push({ x: u.p.x, y: u.p.y, style: 'error' });
    content.labels.push({ key: `up${u.pt.id}`, x: u.p.x, y: u.p.y, text: `${u.pt.name}?`, cls: 'name', dy: -18 });
    content.labels.push({ key: `ue${u.pt.id}`, x: u.p.x, y: u.p.y, text: `unsolved: ${u.reason}`, cls: 'res err', dy: 15 });
  }

  // The current mark is called out in the reference slots and the field
  // label, not on the plan - a marker there just covers the geometry.
  // Reframing is still worth it when the mark is off screen.
  const aimId = aimTarget();
  if (aimId != null && renderPlan.lastAim !== aimId) {
    renderPlan.lastAim = aimId;
    const ap = pos(aimId);
    if (ap && !plan.isOnScreen(ap.x, ap.y)) plan.fitAll([...store.solved.pos.values()]);
  } else if (aimId == null) {
    renderPlan.lastAim = null;
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

      // The corner the proposed wall would make with the existing run -
      // live feedback that a mis-read distance shows up as a wrong angle.
      if (!ui.flow) {
        const run = !store.hasClosedRoomOn(activeFloor()) && store.openWall();
        if (run && run.pts.length >= 2) {
          const vtx = pos(run.pts[run.pts.length - 1]);
          const prev = pos(run.pts[run.pts.length - 2]);
          if (vtx && prev) {
            const ang = angleDeg(prev, vtx, t);
            const proposedWall = { x1: vtx.x, y1: vtx.y, x2: t.x, y2: t.y };
            content.segments.push({ ...proposedWall, style: 'ray' });
            const l1 = Math.hypot(prev.x - vtx.x, prev.y - vtx.y) || 1;
            const l2 = Math.hypot(t.x - vtx.x, t.y - vtx.y) || 1;
            let bx = (prev.x - vtx.x) / l1 + (t.x - vtx.x) / l2;
            let by = (prev.y - vtx.y) / l1 + (t.y - vtx.y) / l2;
            const bl = Math.hypot(bx, by) || 1;
            const off = 30 * plan.worldPerPx;
            content.labels.push({
              key: 'angp', x: vtx.x + (bx / bl) * off, y: vtx.y + (by / bl) * off,
              text: `${Math.round(ang)}°`, cls: 'ang prop',
            });
          }
        }
      }
    }
  }

  // "Show working": construction circles for an existing point - the last
  // placed one, or a single selected point. Explains how a fix was solved.
  if (ui.showWork && !(pv && pv.cands)) {
    let target = null;
    if (ui.refs.length === 1 && store.point(ui.refs[0])?.fix) target = store.point(ui.refs[0]);
    else if (ui.lastId && store.point(ui.lastId)?.fix) target = store.point(ui.lastId);
    if (target) {
      const tp = pos(target.id);
      const dist = (a, b) => store.state.measurements.find(
        (m) => (m.p === a && m.q === b) || (m.p === b && m.q === a))?.d;
      for (const [i, rid] of [[0, target.fix.r1], [1, target.fix.r2]]) {
        const rp = pos(rid), d = dist(rid, target.id);
        if (!rp || d == null || !tp) continue;
        content.circles.push({ cx: rp.x, cy: rp.y, r: d });
        content.segments.push({ x1: rp.x, y1: rp.y, x2: tp.x, y2: tp.y, style: 'ray' });
        content.labels.push({
          key: `wk${i}`, x: (rp.x + tp.x) / 2, y: (rp.y + tp.y) / 2,
          text: fmtDist(d), cls: 'ray',
        });
      }
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

// Survey overlay for the 3D view: points, candidates, circles, rays and
// labels, so measuring works without leaving 3D.
function surveyViz() {
  const viz = { points: [], ghosts: [], circles: [], rays: [], labels: [], heights: [] };
  const elev = (fid) => store.floor(fid)?.elevation ?? 0;
  const activeE = elev(activeFloor());
  // Ceiling markers: a vertical dimension at each room's first corner,
  // tappable to edit that room's height.
  for (const wall of store.state.walls) {
    if (!wall.closed || !floorVisible(wall.floor)) continue;
    const p = pos(wall.pts[0]);
    if (!p) continue;
    // Nudge the marker into the room so it does not sit inside the walls.
    const solvedPts = wall.pts.map(pos).filter(Boolean);
    const cen = {
      x: solvedPts.reduce((s, q) => s + q.x, 0) / solvedPts.length,
      y: solvedPts.reduce((s, q) => s + q.y, 0) / solvedPts.length,
    };
    const dl = Math.hypot(cen.x - p.x, cen.y - p.y) || 1;
    const mx = p.x + ((cen.x - p.x) / dl) * 0.22;
    const my = p.y + ((cen.y - p.y) / dl) * 0.22;
    const e = elev(wall.floor);
    const h = wall.height || store.state.roomHeight || 2.6;
    viz.heights.push({ x: mx, y: my, e, h, wallId: wall.id });
    viz.labels.push({
      key: `wh${wall.id}`, x: mx, y: my, z: e + h / 2,
      text: `${Math.round(h * 100)} cm`, cls: 'ray',
    });
  }
  for (const pt of store.state.points) {
    const p = pos(pt.id);
    if (!p || !floorVisible(pt.floor)) continue;
    const e = elev(pt.floor);
    // Pins sit on top of the wall the point belongs to (using the height at
    // this end of each adjacent segment, so sloped walls carry their pins
    // correctly): always visible, easy to tap, clear of the ceiling rule.
    let top = null;
    for (const w of store.state.walls) {
      if (w.floor !== pt.floor || !w.pts.includes(pt.id)) continue;
      const roomH = w.height || store.state.roomHeight || 2.6;
      const runIds = w.closed && w.pts.length >= 3 ? [...w.pts, w.pts[0]] : w.pts;
      for (let i = 0; i + 1 < runIds.length; i++) {
        if (runIds[i] !== pt.id && runIds[i + 1] !== pt.id) continue;
        const [h1, h2] = w.segH?.[`${runIds[i]}:${runIds[i + 1]}`] || [roomH, roomH];
        top = Math.max(top ?? 0, e + (runIds[i] === pt.id ? h1 : h2));
      }
    }
    const base = top ?? e;
    const refIdx = ui.refs.indexOf(pt.id);
    viz.points.push({
      id: pt.id, x: p.x, y: p.y, e: base,
      style: pt.fix ? 'point' : 'anchor',
      ref: refIdx >= 0 ? refIdx : null,
      isLast: pt.id === ui.lastId,
    });
    viz.labels.push({ key: `p${pt.id}`, x: p.x, y: p.y, z: base + 0.55, text: pt.name, cls: 'name' });
    // Detail mode carries the fix-quality diagnostics into 3D: residual
    // badges and the shallow-ray warning, stacked under the pin label.
    if (ui.showWork && onFloor(pt)) {
      const res = store.solved.pres.get(pt.id) || 0;
      if (res >= 0.001) {
        const cls = res < 0.01 ? 'res good' : res < 0.03 ? 'res warn' : 'res err';
        viz.labels.push({ key: `r3${pt.id}`, x: p.x, y: p.y, z: base + 0.32, text: `${(res * 100).toFixed(1)}`, cls });
      }
      if (pt.fix && pt.fix.stack == null) {
        const r1 = pos(pt.fix.r1), r2 = pos(pt.fix.r2);
        if (r1 && r2) {
          const ang = angleDeg(r1, p, r2);
          if (!(ang >= 30 && ang <= 150)) {
            const bad = ang < 15 || ang > 165;
            viz.labels.push({
              key: `fq3${pt.id}`, x: p.x, y: p.y, z: base + 0.14,
              text: `fix ${Math.round(ang)}°`, cls: bad ? 'res err' : 'res warn',
            });
          }
        }
      }
    }
  }
  // Detail mode: interior angles at the wall corners of the active floor,
  // just above floor level where the corner geometry is visible.
  if (ui.showWork) {
    for (const wall of store.state.walls) {
      if (!onFloor(wall)) continue;
      const solved = wall.pts.map(pos);
      if (solved.some((p) => !p)) continue;
      const n = solved.length;
      const closed = wall.closed && n >= 3;
      const ints = closed ? interiorAngles(solved) : null;
      for (let i = 0; i < n; i++) {
        if (!closed && (i === 0 || i === n - 1)) continue;
        const v = solved[i];
        const prev = solved[(i - 1 + n) % n], next = solved[(i + 1) % n];
        const ang = closed ? ints[i] : angleDeg(prev, v, next);
        const l1 = Math.hypot(prev.x - v.x, prev.y - v.y) || 1;
        const l2 = Math.hypot(next.x - v.x, next.y - v.y) || 1;
        let bx = (prev.x - v.x) / l1 + (next.x - v.x) / l2;
        let by = (prev.y - v.y) / l1 + (next.y - v.y) / l2;
        const bl = Math.hypot(bx, by);
        if (bl < 1e-6) { bx = -(next.y - v.y) / l2; by = (next.x - v.x) / l2; }
        else { bx /= bl; by /= bl; }
        if (closed && ang > 180) { bx = -bx; by = -by; }
        viz.labels.push({
          key: `an3${wall.id}:${i}`, x: v.x + bx * 0.35, y: v.y + by * 0.35,
          z: activeE + 0.08, text: `${Math.round(ang)}°`, cls: 'ang',
        });
      }
    }
  }
  for (const u of unsolvedPoints()) {
    if (!u.p) continue;
    viz.points.push({ id: u.pt.id, x: u.p.x, y: u.p.y, e: activeE, style: 'anchor', ref: null, isLast: false });
    viz.labels.push({ key: `up${u.pt.id}`, x: u.p.x, y: u.p.y, z: activeE + 0.55, text: `${u.pt.name}?`, cls: 'name' });
    viz.labels.push({ key: `ue${u.pt.id}`, x: u.p.x, y: u.p.y, z: activeE + 0.32, text: `unsolved: ${u.reason}`, cls: 'res err' });
  }
  const pv = preview();
  if (pv) {
    const [r1, r2] = ui.refs.map(pos);
    if (pv.d1 != null) viz.circles.push({ cx: r1.x, cy: r1.y, r: pv.d1, e: activeE });
    if (pv.d2 != null) viz.circles.push({ cx: r2.x, cy: r2.y, r: pv.d2, e: activeE });
    if (pv.cands && pv.cands.gap <= CLAMP_TOL) {
      const name = store.nextName();
      for (const [side, p] of [[+1, pv.cands.left], [-1, pv.cands.right]]) {
        const primary = side === (ui.flow ? ui.flowSide : 1);
        viz.ghosts.push({ x: p.x, y: p.y, e: activeE, side, primary });
        viz.labels.push({
          key: `gh${side}`, x: p.x, y: p.y, z: activeE + 1.15,
          text: primary ? `${name}?` : 'or here',
          cls: primary ? 'ghost' : 'ghost dim',
        });
      }
      const t = (ui.flow ? ui.flowSide : 1) >= 0 ? pv.cands.left : pv.cands.right;
      viz.rays.push({ x1: r1.x, y1: r1.y, x2: t.x, y2: t.y, e: activeE });
      viz.rays.push({ x1: r2.x, y1: r2.y, x2: t.x, y2: t.y, e: activeE });
    }
  }
  return viz;
}

// First-survey coach: four stage-driven tips that follow the actual
// survey state (baseline -> references -> outline -> checks). One tap
// hides them for good; "clear everything" or the help card brings them
// back. The card ignores pointer events except its hide button, so it
// never blocks canvas taps.
const COACH_TIPS = [
  'The baseline: tape two marks (A and B) at either end of a straight wall, measure between them with the laser, type it in. Every other point gets fixed by distances back to points like these.',
  'Reference points first: new points are reference-only while walling is off. Fix a few spread around the space - especially ones that can see what A and B cannot (through doorways, past corners). Rays crossing near 90 degrees make the strongest fixes.',
  'Build the outline: in walls mode tap the corner points in order, and tap the first corner again to close the room (the ceiling height is asked once closed). Or toggle walling: on (also in walls mode) and new points chain into the outline as you measure them.',
  'Tighten it: select two points, press record, type a measured distance. Disagreement shows up as residuals, and the detail button reveals wall angles and weak fixes. That is the whole loop - references, corners, checks.',
];

function coachStage() {
  if (ui.coachDone || ui.flow) return null;
  if (anchorMode()) return 0;
  if (store.hasClosedRoomOn(activeFloor())) return 3;
  const refCount = store.state.points.filter((p) => onFloor(p)).length - 2;
  if (ui.wallPause && refCount < 2) return 1;
  return 2;
}

function renderCoach() {
  const el = $('coach');
  if (!el) return;
  const stage = coachStage();
  el.hidden = stage == null;
  if (stage == null) return;
  $('coach-text').textContent = COACH_TIPS[stage];
  $('coach-step').textContent = `tip ${stage + 1} of ${COACH_TIPS.length}`;
}

function coachFinish() {
  ui.coachDone = true;
  try { localStorage.setItem('house-measurer.coach', 'done'); } catch {}
  renderCoach();
}

function render() {
  validateUi();
  renderPanel();
  renderCoach();
  // The dot stays lit exactly while a reading is expected.
  if (okIsShoot()) laser.aimStart(); else laser.aimStop();
  if (ui.view === '3d') {
    if (view3d) view3d.build(store.state, store.solved, visibleLayers(), surveyViz());
  } else {
    renderPlan();
  }
  if (!$('log-sheet').hidden) renderLog();
  if (!$('doctor-sheet').hidden) renderDoctor();
}

// --- boot ------------------------------------------------------------------

function buildKeypad() {
  // [key, label, gridArea] - del is double-height (no cryptic C key).
  const keys = [
    ['1', '1', '1/1'], ['2', '2', '1/2'], ['3', '3', '1/3'], ['del', 'del', '1/4/3/5'],
    ['4', '4', '2/1'], ['5', '5', '2/2'], ['6', '6', '2/3'],
    ['7', '7', '3/1'], ['8', '8', '3/2'], ['9', '9', '3/3'], ['ok', 'OK', '3/4/5/5'],
    ['.', '.', '4/1'], ['0', '0', '4/2'], ['flip', 'swap', '4/3'],
  ];
  const pad = $('keypad');
  for (const [key, label, area] of keys) {
    const b = document.createElement('button');
    b.dataset.key = key;
    b.textContent = label;
    b.className = 'key ' + (/^[0-9.]$/.test(key) ? 'digit' : key);
    b.style.gridArea = area.split('/').join(' / ');
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
    if (!view3d) {
      view3d = new View3D($('plan3d'), $('overlay3d'), { onTap: handleTap3D });
      view3d.setTheme(SKY_PALETTES[theme]);
    }
    view3d.refit();
    view3d.resize();
  }
  render();
}

$('theme-btn').addEventListener('click', () => {
  setAppTheme(theme === 'dark' ? 'light' : 'dark', { persist: true });
  toast(theme === 'dark' ? 'Dark mode' : 'Light mode', 'good');
});

// Bluetooth laser: a decoded reading fills the active field exactly as if
// typed (metres with a decimal point), so you check it and press OK.
// Haptic cadence for heads-up surveying: short tick = reading logged,
// triple = point committed, long = refused. No-op without a vibrator,
// and skipped before the first user interaction (the browser would
// block it and log an intervention error).
const buzz = (p) => {
  try {
    if (navigator.userActivation?.hasBeenActive) navigator.vibrate?.(p);
  } catch {}
};

const laser = new LaserLink({

  // Continuous mode streams [current, min, max] several times a second.
  // Hand-held that mostly measures hand shake, so the active field gets
  // a rolling average; a big jump or a pause starts a fresh window
  // (re-aimed at something else). Nothing commits - the settled value
  // sits in the field for OK, and auto mode ignores the stream.
  onTrack: (cur, { min, max }) => {
    const t = ui.track || (ui.track = { samples: [] });
    const now = Date.now();
    if (t.at && (now - t.at > 1500 || Math.abs(cur - t.last) > 0.05)) t.samples = [];
    t.at = now;
    t.last = cur;
    t.samples.push(cur);
    if (t.samples.length > 24) t.samples.shift();
    const n = t.samples.length;
    const avg = t.samples.reduce((a, b) => a + b, 0) / n;
    const spread = (Math.max(...t.samples) - Math.min(...t.samples)) * 1000;
    const txt = avg.toFixed(3);
    ui.fields[ui.active] = txt;
    const mm = (v) => (isFinite(v) ? v.toFixed(3) : '?');
    clearTimeout(t.timer);
    t.timer = setTimeout(() => {
      ui.track = null;
      say(`Tracking ended: ${txt} m in the field (average of ${n}, spread ${spread.toFixed(0)} mm). Meter min ${mm(min)} / max ${mm(max)}.`, 'good');
    }, 1400);
    say(`Tracking: ${txt} m - average of ${n}, spread ${spread.toFixed(0)} mm (meter min ${mm(min)} / max ${mm(max)})`);
  },

  onMeasurement: (m, meta = {}) => {
    buzz(25);
    if (ui.laserCal) return laserCalStep(m, meta);
    const txt = m.toFixed(3).replace(/0+$/, '').replace(/\.$/, '.0');
    ui.fields[ui.active] = txt;
    const auto = ui.autoLaser === true;
    // Auto survey loop: each reading advances the flow, each pair commits
    // a point (which chains into the wall run until the room closes). The
    // gap guard still refuses impossible pairs, flip still swaps sides,
    // undo still unwinds - the laser only replaces typing and OK.
    if (auto && anchorMode()) {
      say(`Laser: ${fmtDist(m)} for the first wall`, 'good');
      return commitAnchor();
    }
    if (auto && multiMode() && !offFloorRefs().length) {
      ui.fields[0] = txt;
      ui.active = 0;
      return pressOk(); // collects into the multi fix, commits on the last
    }
    if (auto && ui.mode === 'measure' && !ui.flow
      && ui.refs.length === 2 && !offFloorRefs().length) {
      const d0 = parseDistance(ui.fields[0]);
      const d1 = parseDistance(ui.fields[1]);
      if (d0 != null && d1 != null) return commitPoint(ui.flowSide);
      if (d0 != null) {
        ui.active = 1;
        return say(`Laser: ${fmtDist(m)} to ${store.point(ui.refs[0]).name} - now shoot ${store.point(ui.refs[1]).name}`, 'good');
      }
      ui.active = 0;
      return say(`Laser: ${fmtDist(m)} - shoot ${store.point(ui.refs[0]).name} first`, 'good');
    }
    say(`Laser: ${fmtDist(m)} - OK to commit`, 'good');
  },
  onStatus: (text, cls) => {
    say(text, cls);
    renderPanel();
    if (!$('laser-sheet').hidden) renderLaser();
    // Connection milestones surface as toasts; a successful connect also
    // closes the panel so measuring can start immediately.
    if (/^Laser connected/.test(text)) {
      toast(text, 'good');
      $('laser-sheet').hidden = true;
    } else if (/^Laser disconnected/.test(text) || /^Meter reference/.test(text)) {
      toast(text, 'warn');
    }
  },
  onRaw: () => { if (!$('laser-sheet').hidden) renderLaser(); },
});

// --- laser panel ------------------------------------------------------------

function renderLaser() {
  const on = !!laser.connected;
  $('laser-pill').className = 'pill ' + (on ? 'on' : 'off');
  $('laser-pill').textContent = on ? 'connected' : 'off';
  const nameEl = $('laser-name');
  nameEl.textContent = on
    ? laser.deviceLabel
    : laser.secureContextProblem || 'not connected';
  nameEl.classList.toggle('dim', !on);
  $('laser-connect').hidden = on;
  $('laser-disconnect').hidden = !on;
  const off = $('laser-off');
  if (document.activeElement !== off) off.value = (laser.remoteOffset * 100).toFixed(1);
  $('aim-pill').className = 'pill ' + (laser.aimEnabled ? 'on' : 'off');
  $('aim-pill').textContent = laser.aimEnabled ? 'on' : 'off';
  $('aim-btn').textContent = laser.aimEnabled ? 'turn off' : 'turn on';
  $('auto-pill').className = 'pill ' + (ui.autoLaser === true ? 'on' : 'off');
  $('auto-pill').textContent = ui.autoLaser === true ? 'on' : 'off';
  $('auto-btn').textContent = ui.autoLaser === true ? 'turn off' : 'turn on';
  const ref = laser.deviceRef;
  const refEl = $('laser-ref');
  refEl.textContent = ref === 'back' ? 'back edge' : ref === 'front' ? 'front edge'
    : ref ? `other (${ref})` : 'unknown';
  refEl.className = 'pill ' + (ref === 'back' ? 'on' : ref === 'front' ? 'warn' : 'off');
  $('laser-cal').textContent = ui.laserCal ? 'cancel' : 'calibrate';
  const calMsg = $('laser-cal-msg');
  calMsg.hidden = !ui.laserCal;
  if (ui.laserCal) {
    calMsg.textContent = ui.laserCal.stage === 'button'
      ? 'Prop the meter dead still against something solid, aim at a flat target, then press the meter\'s own measure button once.'
      : 'Hold still - firing the remote shot...';
  }
  $('laser-frames').textContent = laser.rawLog.length ? laser.rawLog.join('\n') : 'none yet';
}

$('laser-btn').addEventListener('click', () => {
  $('laser-sheet').hidden = false;
  renderLaser();
});
$('laser-close').addEventListener('click', () => { $('laser-sheet').hidden = true; });
$('laser-sheet').addEventListener('click', (e) => {
  if (e.target === $('laser-sheet')) $('laser-sheet').hidden = true;
});
$('laser-connect').addEventListener('click', () => laser.connect());
$('laser-disconnect').addEventListener('click', () => laser.disconnect());
$('laser-setlo').addEventListener('click', () => {
  const v = parseFloat($('laser-off').value);
  if (isFinite(v) && v >= 0 && v < 50) {
    laser.remoteOffset = v / 100;
    try { localStorage.setItem('house-measurer.laserOffset', String(laser.remoteOffset)); } catch {}
    toast(`Remote readings corrected by +${v.toFixed(1)} cm`, 'good');
    renderLaser();
  } else {
    toast('Offset must be between 0 and 50 cm', 'warn');
  }
});
$('aim-btn').addEventListener('click', () => {
  laser.aimEnabled = !laser.aimEnabled;
  try { localStorage.setItem('house-measurer.laserAim', laser.aimEnabled ? 'on' : 'off'); } catch {}
  if (!laser.aimEnabled) laser.aimStop();
  toast(laser.aimEnabled ? 'Laser dot held on while aiming' : 'Laser dot keep-alive off', 'good');
  renderLaser();
  render();
});
$('laser-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(laser.rawLog.join('\n'));
    toast('Frames copied to clipboard', 'good');
  } catch {
    toast('Clipboard blocked - long-press the frame text to select it', 'warn');
  }
});

// Offset self-calibration: the meter's stored body length is not in any
// readable register, but the meter APPLIES it to every back-edge button
// reading. So: one compensated button reading minus one raw remote shot,
// meter propped still in between = the constant the meter itself uses.
function laserCalStep(m, meta) {
  const cal = ui.laserCal;
  if (cal.stage === 'button' && meta.kind === 'push') {
    cal.stage = 'remote';
    cal.push = m;
    toast('Got the button reading - hold still...', 'good');
    renderLaser();
    laser.remoteTrigger();
    cal.timer = setTimeout(() => {
      if (ui.laserCal === cal) {
        ui.laserCal = null;
        toast('No remote reading came back - calibration cancelled', 'warn');
        renderLaser();
      }
    }, 4000);
    return;
  }
  if (cal.stage === 'remote' && meta.kind === 'remote') {
    clearTimeout(cal.timer);
    ui.laserCal = null;
    const body = cal.push - meta.raw;
    if (body > 0.02 && body < 0.35) {
      laser.remoteOffset = Math.round(body * 10000) / 10000;
      try { localStorage.setItem('house-measurer.laserOffset', String(laser.remoteOffset)); } catch {}
      toast(`Calibrated: body length ${(body * 1000).toFixed(1)} mm, read from the meter's own compensation`, 'good');
    } else {
      toast(`Difference came out at ${(body * 1000).toFixed(0)} mm - implausible (meter moved?). Offset unchanged.`, 'err');
    }
    renderLaser();
  }
  // Anything else (a stray frame) is ignored until the expected one lands.
}

$('laser-cal').addEventListener('click', () => {
  if (ui.laserCal) {
    clearTimeout(ui.laserCal.timer);
    ui.laserCal = null;
    renderLaser();
    return;
  }
  if (!laser.canTrigger) return toast('Calibration needs a connected Bosch meter', 'warn');
  if (laser.deviceRef === 'front') {
    return toast('Set the meter to back-edge reference first - on front edge there is nothing to compensate', 'warn');
  }
  ui.laserCal = { stage: 'button' };
  renderLaser();
});
try {
  const lo = parseFloat(localStorage.getItem('house-measurer.laserOffset'));
  if (isFinite(lo) && lo >= 0 && lo < 0.5) laser.remoteOffset = lo;
  laser.aimEnabled = localStorage.getItem('house-measurer.laserAim') !== 'off';
} catch {}

buildKeypad();

$('undo').addEventListener('click', () => { ui.flipArm = null; store.undo(); });
$('redo').addEventListener('click', () => { ui.flipArm = null; store.redo(); });
$('fit').addEventListener('click', () => {
  if (ui.view === '3d' && view3d) { view3d.refit(); render(); }
  else plan.fitAll([...store.solved.pos.values()]);
});
$('view3d-btn').addEventListener('click', toggle3D);
$('log-btn').addEventListener('click', () => { $('log-sheet').hidden = false; renderLog(); });
$('log-close').addEventListener('click', () => { $('log-sheet').hidden = true; });
$('log-sheet').addEventListener('click', (e) => { if (e.target === $('log-sheet')) $('log-sheet').hidden = true; });
$('coach-hide').addEventListener('click', coachFinish);
$('coach-show').addEventListener('click', () => {
  ui.coachDone = false;
  try { localStorage.removeItem('house-measurer.coach'); } catch {}
  $('help-overlay').hidden = true;
  render();
});
$('help').addEventListener('click', () => { $('help-overlay').hidden = false; });
$('help-close').addEventListener('click', () => { $('help-overlay').hidden = true; });
$('help-overlay').addEventListener('click', (e) => {
  if (e.target === $('help-overlay')) $('help-overlay').hidden = true;
});

for (const b of document.querySelectorAll('#modebar button[data-mode]')) {
  b.addEventListener('click', () => setMode(b.dataset.mode));
}

$('wall-new').addEventListener('click', () => {
  ui.activeWallId = null;
  say('Next tapped point starts a separate wall run');
});
$('wall-back').addEventListener('click', () => {
  // Steps back the wall being drawn; on a closed room it re-opens the loop.
  const w = (ui.activeWallId && store.wall(ui.activeWallId))
    || store.openWall() || store.state.walls.at(-1);
  if (w) store.popWallPoint(w.id);
  else store.undo();
});
$('close-room').addEventListener('click', closeRoomAction);
const toggleWork = () => {
  ui.showWork = !ui.showWork;
  say(ui.showWork
    ? 'Detail on: wall angles shown; tap a single point to see its construction circles'
    : null);
};
$('show-work').addEventListener('click', toggleWork);
$('show-work3d').addEventListener('click', toggleWork);

$('check-btn').addEventListener('click', () => {
  if (ui.refs.length !== 2) return say('Tap 2 points to record a distance between them', 'warn');
  if (offFloorRefs().length) return say('Both points must be on this floor (cross-floor laser shots are slant distances)', 'warn');
  const typed = parseDistance(ui.fields[ui.active]) ?? parseDistance(ui.fields[0]);
  if (typed != null) return commitCheck();
  // Nothing typed yet: ask for the ONE distance this needs, and update
  // in place when the pair is already measured (no silent duplicates).
  const [p, q] = ui.refs;
  const existing = store.state.measurements.find(
    (m) => (m.p === p && m.q === q) || (m.p === q && m.q === p));
  const [n1, n2] = ui.refs.map((id) => store.point(id).name);
  startFlow({ kind: 'record', p, q, measId: existing?.id ?? null },
    existing
      ? `Editing ${n1} to ${n2} (now ${fmtDist(existing.d)}) - type the new value, OK saves it`
      : `${n1} to ${n2}: type the measured distance, OK records it`);
});
$('stack-btn').addEventListener('click', stackRefs);
$('unwall-btn').addEventListener('click', () => {
  const id = ui.refs[0];
  const pt = id != null && store.point(id);
  if (!pt) return;
  store.detachPointFromWalls(id);
  say(`${pt.name} taken out of the wall outline - it stays as a reference point`, 'good');
});
$('pause-btn').addEventListener('click', () => {
  ui.wallPause = !ui.wallPause;
  try { localStorage.setItem('house-measurer.walling', ui.wallPause ? 'off' : 'on'); } catch {}
  if (!ui.wallPause && !store.hasClosedRoomOn(activeFloor()) && !store.openWall()) {
    // Walling switched on with no outline yet: start the run at the
    // anchor pair so the chain continues A-B-... as expected.
    const anchors = store.state.points.filter((p) => onFloor(p) && !p.fix);
    if (anchors.length === 2) store.seedWallRun(anchors.map((p) => p.id));
  }
  say(ui.wallPause
    ? 'Walling off: new points are reference-only'
    : 'Walling on: new points chain into the wall outline until the room closes');
});
$('shoot-btn').addEventListener('click', () => laser.remoteTrigger());
$('flip-btn').addEventListener('click', () => pressFlip());
$('auto-btn').addEventListener('click', () => {
  ui.autoLaser = ui.autoLaser !== true;
  if (!$('laser-sheet').hidden) renderLaser();
  toast(ui.autoLaser ? 'Auto survey mode on' : 'Auto survey mode off', 'good');
  say(ui.autoLaser
    ? 'Auto on: shoot ref 1, shoot ref 2, point placed - repeat around the room'
    : 'Auto off: laser readings fill the field, you press OK');
});
$('del-point').addEventListener('click', () => {
  const id = ui.refs[0];
  const pt = id != null && store.point(id);
  if (!pt) return;
  const deps = store.pointDependents(id);
  if (deps.length && ui.delArm !== id) {
    ui.delArm = id;
    return say(`${pt.name} fixes ${deps.map((d) => d.name).join(', ')} - deleting it leaves them unsolved. Tap delete again to proceed.`, 'err');
  }
  ui.delArm = null;
  const name = pt.name;
  store.deletePoint(id);
  ui.refs = [];
  note(`${name} deleted (undo brings it back)`, 'good');
});
$('floor-btn').addEventListener('click', () => {
  const floors = store.state.floors;
  const i = floors.findIndex((f) => f.id === activeFloor());
  store.setActiveFloor(floors[(i + 1) % floors.length].id);
  say(`Now on ${store.floor(activeFloor()).name}`);
});

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
    ui.coachDone = false;
    ui.wallPause = true;
    try {
      localStorage.removeItem('house-measurer.coach');
      localStorage.removeItem('house-measurer.walling');
    } catch {}
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
    else if (ui.multiD.length) ui.multiD = [];
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
  openItemForm, applyItemForm, importFromText, exportString, laser,
  get view3d() { return view3d; },
};
