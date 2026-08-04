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

  // autoWall: chain the new point into the active floor's open wall run in
  // the same undo step.
  addPoint(r1, r2, d1, d2, side, { autoWall = false } = {}) {
    const id = this.nextId++, m1 = this.nextId++, m2 = this.nextId++;
    this.commit((s) => {
      s.points.push({ id, name: pointName(s.points.length), fix: { r1, r2, side }, floor: s.activeFloor });
      s.measurements.push({ id: m1, p: r1, q: id, d: d1 });
      s.measurements.push({ id: m2, p: r2, q: id, d: d2 });
      if (autoWall) this._autoWallAppend(s, id);
    });
    return id;
  }

  // A point on the active floor pinned directly above/below an existing
  // point (same plan position) - the cross-floor reference.
  addStackedPoint(refId, { autoWall = false } = {}) {
    const id = this.nextId++;
    this.commit((s) => {
      s.points.push({ id, name: pointName(s.points.length), fix: { stack: refId }, floor: s.activeFloor });
      if (autoWall) this._autoWallAppend(s, id);
    });
    return id;
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

  // Thickness of one wall segment, metres. Keyed by its endpoint ids so the
  // value survives edits elsewhere in the polyline.
  setWallThickness(id, segKey, t) {
    this.commit((s) => {
      const w = s.walls.find((w) => w.id === id);
      if (!w) return;
      if (!w.thick) w.thick = {};
      w.thick[segKey] = t;
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
