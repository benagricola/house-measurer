// Store: state + undo/redo + persistence. No DOM; storage is injected
// (window.localStorage in the app, a plain object mock in tests).

import { solve, pointName } from './geometry.js';

export const STORAGE_KEY = 'house-measurer.v1';
const UNDO_CAP = 200;

export class Store {
  constructor(storage) {
    this.storage = storage;
    this.state = { v: 1, points: [], measurements: [] };
    this.undoStack = [];
    this.redoStack = [];
    this.nextId = 1;
    this.listeners = new Set();
    this.solved = solve(this.state);
  }

  load() {
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (data && data.state && data.state.v === 1) {
        this.state = data.state;
        this.undoStack = data.undoStack || [];
        this.redoStack = data.redoStack || [];
        this.nextId = data.nextId || 1;
        this.solved = solve(this.state);
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

  onChange(fn) { this.listeners.add(fn); }
  emit() { for (const fn of this.listeners) fn(); }

  afterChange() {
    this.solved = solve(this.state);
    this.save();
    this.emit();
  }

  // Snapshot current state, apply mutator, recompute. Everything is undoable.
  commit(mutator) {
    this.undoStack.push(JSON.stringify(this.state));
    if (this.undoStack.length > UNDO_CAP) this.undoStack.shift();
    this.redoStack = [];
    mutator(this.state);
    this.afterChange();
  }

  undo() {
    if (!this.undoStack.length) return false;
    this.redoStack.push(JSON.stringify(this.state));
    this.state = JSON.parse(this.undoStack.pop());
    this.afterChange();
    return true;
  }

  redo() {
    if (!this.redoStack.length) return false;
    this.undoStack.push(JSON.stringify(this.state));
    this.state = JSON.parse(this.redoStack.pop());
    this.afterChange();
    return true;
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  point(id) { return this.state.points.find((p) => p.id === id); }

  // First measurement: creates anchors A and B, d metres apart.
  setAnchors(d) {
    const a = this.nextId++, b = this.nextId++, m = this.nextId++;
    this.commit((s) => {
      s.points.push(
        { id: a, name: 'A', fix: null },
        { id: b, name: 'B', fix: null }
      );
      s.measurements.push({ id: m, p: a, q: b, d });
    });
    return { a, b };
  }

  // Fix a new point by distances d1 to r1 and d2 to r2. side: +1 left, -1 right.
  addPoint(r1, r2, d1, d2, side) {
    const id = this.nextId++, m1 = this.nextId++, m2 = this.nextId++;
    this.commit((s) => {
      s.points.push({ id, name: pointName(s.points.length), fix: { r1, r2, side } });
      s.measurements.push({ id: m1, p: r1, q: id, d: d1 });
      s.measurements.push({ id: m2, p: r2, q: id, d: d2 });
    });
    return id;
  }

  flipSide(id) {
    const pt = this.point(id);
    if (!pt || !pt.fix) return;
    this.commit((s) => {
      const p = s.points.find((p) => p.id === id);
      p.fix.side = -p.fix.side;
    });
  }

  clearAll() {
    this.commit((s) => {
      s.points = [];
      s.measurements = [];
    });
  }
}
