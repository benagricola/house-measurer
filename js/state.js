// Store: state + undo/redo + persistence. No DOM; storage is injected
// (window.localStorage in the app, a plain object mock in tests).

import { solveAdjusted, pointName } from './geometry.js';

export const STORAGE_KEY = 'house-measurer.v1';
const UNDO_CAP = 200;

function emptyState() {
  return {
    v: 3,
    points: [],
    measurements: [],
    walls: [],        // { id, pts: [pointId...], closed, height?, floor }
    items: [],        // see addItem for shape
    layers: [{ id: 'current', name: 'current', visible: true }],
    activeLayer: 'current',
    floors: [{ id: 'f0', name: 'ground', elevation: 0, visible: true }],
    activeFloor: 'f0',
    roomHeight: 2.6,
    wallThickness: 0.09, // default; segments can override (wall.thick)
  };
}

// Idempotent shape upgrade; also applied after undo/redo restores so old
// snapshots (or a v1/v2 localStorage) never leave fields missing.
function migrate(s) {
  const base = emptyState();
  for (const k of Object.keys(base)) if (s[k] === undefined) s[k] = base[k];
  const f0 = s.floors[0]?.id ?? 'f0';
  for (const p of s.points) if (p.floor === undefined) p.floor = f0;
  for (const w of s.walls) if (w.floor === undefined) w.floor = f0;
  for (const it of s.items) if (it.floor === undefined) it.floor = f0;
  if (!s.floors.some((f) => f.id === s.activeFloor)) s.activeFloor = f0;
  s.v = 3;
  return s;
}

export class Store {
  constructor(storage) {
    this.storage = storage;
    this.state = emptyState();
    this.undoStack = [];
    this.redoStack = [];
    this.nextId = 1;
    this.listeners = new Set();
    this.solved = solveAdjusted(this.state);
  }

  load() {
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (data && data.state && data.state.v >= 1) {
        this.state = migrate(data.state);
        this.undoStack = data.undoStack || [];
        this.redoStack = data.redoStack || [];
        this.nextId = data.nextId || 1;
        this.solved = solveAdjusted(this.state);
      }
    } catch (e) {
      console.warn('load failed, starting fresh', e);
    }
  }

  save() {
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify({
        state: this.state,
        undoStack: this.undoStack.slice(-50),
        redoStack: this.redoStack.slice(-50),
        nextId: this.nextId,
      }));
    } catch (e) {
      console.warn('save failed', e);
    }
  }

  // Replace the whole state (JSON import). Undoable like everything else.
  importState(newState) {
    this.commit((s, st) => {
      st.state = migrate(newState);
    });
  }

  onChange(fn) { this.listeners.add(fn); }
  emit() { for (const fn of this.listeners) fn(); }

  afterChange() {
    this.solved = solveAdjusted(this.state);
    this.save();
    this.emit();
  }

  // Snapshot current state, apply mutator, recompute. Everything is undoable.
  // The mutator gets (state, store) - mutate state, or assign store.state.
  commit(mutator) {
    this.undoStack.push(JSON.stringify(this.state));
    if (this.undoStack.length > UNDO_CAP) this.undoStack.shift();
    this.redoStack = [];
    mutator(this.state, this);
    this.afterChange();
  }

  undo() {
    if (!this.undoStack.length) return false;
    this.redoStack.push(JSON.stringify(this.state));
    this.state = migrate(JSON.parse(this.undoStack.pop()));
    this.afterChange();
    return true;
  }

  redo() {
    if (!this.redoStack.length) return false;
    this.undoStack.push(JSON.stringify(this.state));
    this.state = migrate(JSON.parse(this.redoStack.pop()));
    this.afterChange();
    return true;
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  point(id) { return this.state.points.find((p) => p.id === id); }

  // First unused letter name - deletions free names without ever colliding.
  nextName() {
    const used = new Set(this.state.points.map((p) => p.name));
    for (let i = 0; ; i++) {
      const n = pointName(i);
      if (!used.has(n)) return n;
    }
  }

  // Points fixed from this one (two-distance refs or stacks) - they become
  // unsolvable if it goes.
  pointDependents(id) {
    return this.state.points.filter(
      (p) => p.fix && (p.fix.r1 === id || p.fix.r2 === id || p.fix.stack === id)
    );
  }

  // Everything transitively fixed from this point (through two-distance
  // refs and stacked twins), NOT including the point itself.
  pointBranch(id) {
    const ids = new Set([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const p of this.state.points) {
        if (!p.fix || ids.has(p.id)) continue;
        if (ids.has(p.fix.r1) || ids.has(p.fix.r2) || ids.has(p.fix.stack)) {
          ids.add(p.id);
          grew = true;
        }
      }
    }
    ids.delete(id);
    return this.state.points.filter((p) => ids.has(p.id));
  }

  // Mirror a whole mis-sided branch in one step: negates the side flag of
  // every point transitively fixed from id (stacked twins have no side and
  // simply follow their owner). Used after flipping a reference point when
  // its dependents turn out to be mirrored with it.
  flipDependents(id) {
    const branch = this.pointBranch(id);
    const flipIds = new Set(branch.filter((p) => p.fix?.side != null).map((p) => p.id));
    if (flipIds.size) {
      this.commit((s) => {
        for (const p of s.points) if (flipIds.has(p.id)) p.fix.side *= -1;
      });
    }
    return branch;
  }

  // Take a point out of every wall polyline WITHOUT deleting it - for
  // points that were only ever references, not corners. Closed loops stay
  // closed while they keep 3+ points (the outline simply reroutes).
  detachPointFromWalls(id) {
    this.commit((s) => {
      for (const w of s.walls) {
        const i = w.pts.indexOf(id);
        if (i >= 0) {
          w.pts.splice(i, 1);
          if (w.closed && w.pts.length < 3) w.closed = false;
        }
      }
      s.walls = s.walls.filter((w) => w.pts.length > 0);
    });
  }

  // The measurements a point's fix depends on - deleting one unsolves the
  // point and everything chained from it.
  fixMeasurementIds(pt) {
    if (!pt?.fix || pt.fix.stack != null) return [];
    return this.state.measurements
      .filter((m) =>
        (m.p === pt.id && (m.q === pt.fix.r1 || m.q === pt.fix.r2)) ||
        (m.q === pt.id && (m.p === pt.fix.r1 || m.p === pt.fix.r2)))
      .map((m) => m.id);
  }

  // Points whose fix would lose a measurement if this one were deleted
  // (only counting the FIRST matching measurement per pair - a duplicate
  // re-measurement makes the original safe to drop).
  measurementLoad(measId) {
    const m = this.measurement(measId);
    if (!m) return [];
    const twin = this.state.measurements.find((o) => o.id !== measId
      && ((o.p === m.p && o.q === m.q) || (o.p === m.q && o.q === m.p)));
    if (twin) return []; // a duplicate covers the same pair
    const load = this.state.points.filter((pt) => this.fixMeasurementIds(pt).includes(measId));
    // The anchor baseline: the first A-B measurement positions point B.
    const [pa, pb] = this.state.points;
    if (pa && pb && ((m.p === pa.id && m.q === pb.id) || (m.p === pb.id && m.q === pa.id))) {
      if (!load.includes(pb)) load.push(pb);
    }
    return load;
  }

  // Remove a point, its measurements and its wall links; a closed loop
  // dropping below 3 points re-opens. Dependent points are kept (they show
  // as unsolved) so a mistaken delete is a plain undo away.
  deletePoint(id) {
    this.commit((s) => {
      s.points = s.points.filter((p) => p.id !== id);
      s.measurements = s.measurements.filter((m) => m.p !== id && m.q !== id);
      for (const w of s.walls) {
        const i = w.pts.indexOf(id);
        if (i >= 0) {
          w.pts.splice(i, 1);
          if (w.closed && w.pts.length < 3) w.closed = false;
        }
      }
      s.walls = s.walls.filter((w) => w.pts.length > 0);
    });
  }
  item(id) { return this.state.items.find((i) => i.id === id); }
  wall(id) { return this.state.walls.find((w) => w.id === id); }
  measurement(id) { return this.state.measurements.find((m) => m.id === id); }

  // --- points & measurements ----------------------------------------------

  // Append to (or start) the active floor's open wall run - the
  // auto-walling that runs until that floor's first room closes.
  _autoWallAppend(s, pointId) {
    let w = s.walls.find((w) => !w.closed && w.floor === s.activeFloor && w.pts.length >= 1);
    if (!w) {
      w = { id: this.nextId++, pts: [], closed: false, floor: s.activeFloor };
      s.walls.push(w);
    }
    if (!w.pts.includes(pointId)) w.pts.push(pointId);
  }

  // First measurement: creates anchors A and B, and (unless told otherwise)
  // starts the wall run that auto-chains points until the first room closes.
  setAnchors(d, { wall = true } = {}) {
    const a = this.nextId++, b = this.nextId++, m = this.nextId++;
    this.commit((s) => {
      s.points.push(
        { id: a, name: 'A', fix: null, floor: s.activeFloor },
        { id: b, name: 'B', fix: null, floor: s.activeFloor }
      );
      s.measurements.push({ id: m, p: a, q: b, d });
      if (wall) {
        this._autoWallAppend(s, a);
        this._autoWallAppend(s, b);
      }
    });
    return { a, b };
  }

  // Seed the auto-wall run with already-existing points, in order - used
  // when walling gets switched on after the anchors were placed without
  // a run (reference-first flow), so the outline still starts at A-B.
  seedWallRun(ids) {
    if (!ids.length) return;
    this.commit((s) => {
      for (const id of ids) this._autoWallAppend(s, id);
    });
  }

  // autoWall: chain the new point into the active floor's open wall run in
  // the same undo step. extras: additional [{p, d}] distances to more
  // references, committed atomically - the redundancy that lets the
  // least-squares fit average noise down and expose blunders.
  addPoint(r1, r2, d1, d2, side, { autoWall = false, extras = [] } = {}) {
    const id = this.nextId++, m1 = this.nextId++, m2 = this.nextId++;
    const extraIds = extras.map(() => this.nextId++);
    this.commit((s) => {
      s.points.push({ id, name: this.nextName(), fix: { r1, r2, side }, floor: s.activeFloor });
      s.measurements.push({ id: m1, p: r1, q: id, d: d1 });
      s.measurements.push({ id: m2, p: r2, q: id, d: d2 });
      extras.forEach((e, i) => s.measurements.push({ id: extraIds[i], p: e.p, q: id, d: e.d }));
      if (autoWall) this._autoWallAppend(s, id);
    });
    return id;
  }

  // A point on the active floor pinned directly above/below an existing
  // point (same plan position) - the cross-floor reference.
  addStackedPoint(refId, { autoWall = false } = {}) {
    const id = this.nextId++;
    this.commit((s) => {
      s.points.push({ id, name: this.nextName(), fix: { stack: refId }, floor: s.activeFloor });
      if (autoWall) this._autoWallAppend(s, id);
    });
    return id;
  }

  // A short free-text note on a point ("radiator corner", "left reveal").
  // Marks in the room are often unlabelled; this is how a point stays
  // identifiable days later.
  setPointNote(id, note) {
    const txt = String(note ?? '').trim().slice(0, 60);
    this.commit((s) => {
      const p = s.points.find((x) => x.id === id);
      if (!p) return;
      if (txt) p.note = txt;
      else delete p.note;
    });
  }

  flipSide(id) {
    const pt = this.point(id);
    if (!pt || !pt.fix) return;
    this.commit((s) => {
      s.points.find((p) => p.id === id).fix.side *= -1;
    });
  }

  // Extra/check measurement between two existing points (redundancy).
  addMeasurement(p, q, d) {
    const id = this.nextId++;
    this.commit((s) => s.measurements.push({ id, p, q, d }));
    return id;
  }

  updateMeasurement(id, d) {
    this.commit((s) => {
      const m = s.measurements.find((m) => m.id === id);
      if (m) m.d = d;
    });
  }

  deleteMeasurement(id) {
    this.commit((s) => {
      s.measurements = s.measurements.filter((m) => m.id !== id);
    });
  }

  // --- walls ---------------------------------------------------------------

  // Append a point to the wall polyline being drawn (activeWallId), starting
  // a new wall when needed. Tapping the wall's first point again closes it.
  // Returns { wallId, closed }.
  addWallPoint(activeWallId, pointId) {
    let wall = activeWallId != null ? this.wall(activeWallId) : null;
    if (wall && (wall.closed || !wall.pts.length)) wall = null;
    if (!wall) {
      const id = this.nextId++;
      this.commit((s) => s.walls.push({ id, pts: [pointId], closed: false, floor: s.activeFloor }));
      return { wallId: id, closed: false };
    }
    if (wall.pts.includes(pointId)) {
      if (pointId === wall.pts[0] && wall.pts.length >= 3) {
        this.commit((s) => { s.walls.find((w) => w.id === wall.id).closed = true; });
        return { wallId: wall.id, closed: true };
      }
      return { wallId: wall.id, closed: false }; // ignore repeat taps
    }
    this.commit((s) => s.walls.find((w) => w.id === wall.id).pts.push(pointId));
    return { wallId: wall.id, closed: false };
  }

  // Step back while drawing; drops the wall when it empties.
  popWallPoint(wallId) {
    const wall = this.wall(wallId);
    if (!wall) return;
    this.commit((s) => {
      const w = s.walls.find((w) => w.id === wallId);
      if (w.closed) w.closed = false;
      else w.pts.pop();
      if (!w.pts.length) s.walls = s.walls.filter((x) => x.id !== wallId);
    });
  }

  closeWall(id) {
    const wall = this.wall(id);
    if (!wall || wall.closed || wall.pts.length < 3) return false;
    this.commit((s) => { s.walls.find((w) => w.id === id).closed = true; });
    return true;
  }

  // Ceiling height for one room (closed wall loop), metres.
  setWallHeight(id, h) {
    this.commit((s) => {
      const w = s.walls.find((w) => w.id === id);
      if (w) w.height = h;
    });
  }

  // Per-segment overrides, keyed by endpoint ids so values survive edits
  // elsewhere in the polyline. t = thickness; h1/h2 = height at the first/
  // second endpoint (a sloped top edge when they differ). Null leaves a
  // value unchanged. One undo step for the whole edit.
  setWallSeg(id, segKey, { t = null, h1 = null, h2 = null } = {}) {
    this.commit((s) => {
      const w = s.walls.find((w) => w.id === id);
      if (!w) return;
      if (t != null) {
        if (!w.thick) w.thick = {};
        w.thick[segKey] = t;
      }
      if (h1 != null || h2 != null) {
        if (!w.segH) w.segH = {};
        const roomH = w.height || s.roomHeight || 2.6;
        const cur = w.segH[segKey] || [roomH, roomH];
        w.segH[segKey] = [h1 ?? cur[0], h2 ?? cur[1]];
      }
    });
  }

  setDefaultWallThickness(t) {
    this.commit((s) => { s.wallThickness = t; });
  }

  // True once a room is closed on the given floor - after that, new points
  // there are unspecified.
  hasClosedRoomOn(floorId) {
    return this.state.walls.some((w) => w.closed && w.floor === floorId);
  }

  // The active floor's open wall run that auto-chaining extends, if any.
  openWall() {
    return this.state.walls.find(
      (w) => !w.closed && w.floor === this.state.activeFloor && w.pts.length >= 1
    ) || null;
  }

  // --- floors --------------------------------------------------------------

  floor(id) { return this.state.floors.find((f) => f.id === id); }

  addFloor(name, elevation) {
    const id = 'floor' + this.nextId++;
    this.commit((s) => {
      s.floors.push({ id, name, elevation, visible: true });
      s.activeFloor = id;
    });
    return id;
  }

  setActiveFloor(id) {
    if (!this.floor(id)) return;
    this.commit((s) => { s.activeFloor = id; });
  }

  setFloorElevation(id, elevation) {
    this.commit((s) => {
      const f = s.floors.find((f) => f.id === id);
      if (f) f.elevation = elevation;
    });
  }

  setFloorVisible(id, visible) {
    this.commit((s) => {
      const f = s.floors.find((f) => f.id === id);
      if (f) f.visible = visible;
    });
  }

  floorEmpty(id) {
    const s = this.state;
    return !s.points.some((p) => p.floor === id) && !s.walls.some((w) => w.floor === id)
      && !s.items.some((i) => i.floor === id);
  }

  deleteFloor(id) {
    if (this.state.floors.length < 2 || !this.floorEmpty(id)) return false;
    this.commit((s) => {
      s.floors = s.floors.filter((f) => f.id !== id);
      if (s.activeFloor === id) s.activeFloor = s.floors[0].id;
    });
    return true;
  }

  deleteWall(id) {
    this.commit((s) => {
      s.walls = s.walls.filter((w) => w.id !== id);
      for (const it of s.items) {
        if (it.mount && it.mount.wallId === id) it.mount = null;
      }
    });
  }

  // --- items & layers ------------------------------------------------------

  addItem(props) {
    const id = this.nextId++;
    this.commit((s) => {
      s.items.push({
        id,
        name: props.name || 'item',
        category: props.category || 'other',
        layer: props.layer || s.activeLayer,
        w: props.w, d: props.d, h: props.h,
        x: props.x ?? 0, y: props.y ?? 0, rot: props.rot ?? 0,
        z0: props.z0 ?? 0,
        mount: props.mount ?? null, // { wallId, seg } for wall-mounted
        locked: props.locked ?? false,
        floor: props.floor ?? s.activeFloor,
      });
    });
    return id;
  }

  updateItem(id, patch) {
    this.commit((s) => {
      const it = s.items.find((i) => i.id === id);
      if (it) Object.assign(it, patch);
    });
  }

  deleteItem(id) {
    this.commit((s) => { s.items = s.items.filter((i) => i.id !== id); });
  }

  addLayer(name) {
    const id = 'layer' + this.nextId++;
    this.commit((s) => {
      s.layers.push({ id, name, visible: true });
      s.activeLayer = id;
    });
    return id;
  }

  setLayerVisible(id, visible) {
    this.commit((s) => {
      const l = s.layers.find((l) => l.id === id);
      if (l) l.visible = visible;
    });
  }

  setActiveLayer(id) {
    this.commit((s) => { s.activeLayer = id; });
  }

  deleteLayer(id) {
    if (id === 'current') return;
    this.commit((s) => {
      s.layers = s.layers.filter((l) => l.id !== id);
      s.items = s.items.filter((i) => i.layer !== id);
      if (s.activeLayer === id) s.activeLayer = 'current';
    });
  }

  setRoomHeight(h) {
    this.commit((s) => { s.roomHeight = h; });
  }

  clearAll() {
    this.commit((s, st) => { st.state = emptyState(); });
  }
}
