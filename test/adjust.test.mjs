import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  solve, adjust, solveAdjusted, pointSegDist, itemCorners, pointInItem,
} from '../js/geometry.js';
import { Store } from '../js/state.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
  };
}

// A 3-4-5 network with an exact redundant diagonal: adjustment must keep
// the exact solution and report ~zero residuals.
test('adjust: consistent redundant network has zero residuals', () => {
  const s = {
    points: [
      { id: 1, name: 'A', fix: null },
      { id: 2, name: 'B', fix: null },
      { id: 3, name: 'C', fix: { r1: 1, r2: 2, side: 1 } },
      { id: 4, name: 'D', fix: { r1: 1, r2: 3, side: -1 } },
    ],
    measurements: [
      { id: 10, p: 1, q: 2, d: 4 },
      { id: 11, p: 1, q: 3, d: 3 },
      { id: 12, p: 2, q: 3, d: 5 },       // C = (0, 3)
      { id: 13, p: 1, q: 4, d: 4 },
      { id: 14, p: 3, q: 4, d: 5 },       // D = (4, 0)... coincides with B
      { id: 15, p: 2, q: 4, d: 0.0001 },  // redundant tie D ~ B
    ],
  };
  const chain = solve(s);
  const adj = adjust(s, chain);
  assert.ok(adj);
  for (const [, r] of adj.mres) assert.ok(Math.abs(r) < 1e-3, `residual ${r}`);
  close(adj.pos.get(3).x, 0, 1e-3);
  close(adj.pos.get(3).y, 3, 1e-3);
});

// Perturb one measurement: the error must spread and be reported, with every
// residual well below the raw 2 cm disagreement.
test('adjust: inconsistent measurement spreads error and reports residuals', () => {
  const s = {
    points: [
      { id: 1, name: 'A', fix: null },
      { id: 2, name: 'B', fix: null },
      { id: 3, name: 'C', fix: { r1: 1, r2: 2, side: 1 } },
    ],
    measurements: [
      { id: 10, p: 1, q: 2, d: 4 },
      { id: 11, p: 1, q: 3, d: 3 },
      { id: 12, p: 2, q: 3, d: 5 },
      { id: 13, p: 1, q: 3, d: 3.02 },  // re-measured 2 cm long
    ],
  };
  const r = solveAdjusted(s);
  // Adjusted |A-C| settles between the 3.00 and 3.02 claims: the short one
  // reads positive (actual > measured), the long one negative.
  const r11 = r.mres.get(11), r13 = r.mres.get(13);
  assert.ok(r11 > 0 && r13 < 0, 'error split across the duplicate pair');
  assert.ok(Math.abs(r11) < 0.02 && Math.abs(r13) < 0.02);
  close(Math.abs(r13 - r11), 0.02, 1e-6); // the 2 cm disagreement is preserved
  assert.ok(r.pres.get(3) > 0.005, 'point residual reported');
  assert.ok(r.pres.get(3) < 0.02);
});

test('solveAdjusted: no measurements yields empty maps, no crash', () => {
  const r = solveAdjusted({ points: [], measurements: [] });
  assert.equal(r.pos.size, 0);
  assert.equal(r.mres.size, 0);
});

test('pointSegDist', () => {
  const r = pointSegDist({ x: 2, y: 1 }, { x: 0, y: 0 }, { x: 4, y: 0 });
  close(r.d, 1);
  close(r.t, 0.5);
  const beyond = pointSegDist({ x: 6, y: 0 }, { x: 0, y: 0 }, { x: 4, y: 0 });
  close(beyond.d, 2);
  close(beyond.t, 1);
});

test('itemCorners and pointInItem respect rotation', () => {
  const it = { x: 1, y: 1, rot: Math.PI / 2, w: 2, d: 1 };
  const cs = itemCorners(it);
  // w axis now points along +y: corners at x = 1 +- 0.5, y = 1 +- 1.
  close(Math.max(...cs.map((c) => c.y)), 2);
  close(Math.max(...cs.map((c) => c.x)), 1.5);
  assert.ok(pointInItem({ x: 1, y: 1.9 }, it));
  assert.ok(!pointInItem({ x: 1.9, y: 1 }, it));
});

test('store: walls draw, close, step back, delete', () => {
  const st = new Store(memStorage());
  const { a, b } = st.setAnchors(4);
  const c = st.addPoint(a, b, 3, 5, 1);

  let r = st.addWallPoint(null, a);
  r = st.addWallPoint(r.wallId, b);
  r = st.addWallPoint(r.wallId, c);
  assert.equal(r.closed, false);
  r = st.addWallPoint(r.wallId, a); // back to start -> closes
  assert.equal(r.closed, true);
  assert.equal(st.state.walls[0].pts.length, 3);

  st.popWallPoint(r.wallId); // un-close
  assert.equal(st.state.walls[0].closed, false);
  st.popWallPoint(r.wallId);
  st.popWallPoint(r.wallId);
  st.popWallPoint(r.wallId); // empties -> wall removed
  assert.equal(st.state.walls.length, 0);
});

test('store: items, layers, visibility, mount cleanup on wall delete', () => {
  const st = new Store(memStorage());
  const { a, b } = st.setAnchors(4);
  const w = st.addWallPoint(null, a);
  st.addWallPoint(w.wallId, b);

  const item = st.addItem({ name: 'fridge', category: 'appliance', w: 0.7, d: 0.7, h: 1.8, x: 1, y: 1, rot: 0, mount: { wallId: w.wallId, seg: 0 } });
  const lay = st.addLayer('plan B');
  assert.equal(st.state.activeLayer, lay);
  const item2 = st.addItem({ name: 'hood', category: 'extraction', w: 0.9, d: 0.5, h: 0.4, z0: 1.95 });
  assert.equal(st.item(item2).layer, lay);

  st.setLayerVisible(lay, false);
  assert.equal(st.state.layers.find((l) => l.id === lay).visible, false);

  st.deleteWall(w.wallId);
  assert.equal(st.item(item).mount, null, 'mount cleared when wall deleted');

  st.deleteLayer(lay);
  assert.ok(!st.item(item2), 'layer delete removes its items');
  assert.equal(st.state.activeLayer, 'current');

  st.undo(); // restore layer + item
  assert.ok(st.item(item2));
  assert.equal(st.item(item2).layer, lay);
});

test('store: v1 state in storage migrates to v2 shape', () => {
  const storage = memStorage();
  storage.setItem('house-measurer.v1', JSON.stringify({
    state: {
      v: 1,
      points: [{ id: 1, name: 'A', fix: null }, { id: 2, name: 'B', fix: null }],
      measurements: [{ id: 3, p: 1, q: 2, d: 4 }],
    },
    undoStack: [JSON.stringify({ v: 1, points: [], measurements: [] })],
    redoStack: [],
    nextId: 4,
  }));
  const st = new Store(storage);
  st.load();
  assert.equal(st.state.v, 2);
  assert.deepEqual(st.state.walls, []);
  assert.deepEqual(st.state.items, []);
  assert.equal(st.state.layers[0].id, 'current');
  assert.equal(st.state.roomHeight, 2.6);
  // Undoing into a v1 snapshot must also come back migrated.
  assert.ok(st.undo());
  assert.equal(st.state.v, 2);
  assert.deepEqual(st.state.walls, []);
});

test('store: measurement edit and delete recompute the solution', () => {
  const st = new Store(memStorage());
  const { a, b } = st.setAnchors(4);
  const c = st.addPoint(a, b, 3, 5, 1);
  const mC = st.state.measurements.find((m) => m.q === c && m.p === a);
  st.updateMeasurement(mC.id, 3.5);
  assert.ok(Math.abs(st.solved.pos.get(c).y - 3) > 0.1, 'position moved after edit');
  st.deleteMeasurement(mC.id);
  assert.ok(st.solved.errors.has(c), 'point unsolvable after losing a fix measurement');
  st.undo();
  assert.ok(!st.solved.errors.has(c));
});

test('store: importState replaces and is undoable', () => {
  const st = new Store(memStorage());
  st.setAnchors(4);
  const exported = JSON.parse(JSON.stringify(st.state));
  st.addPoint(st.state.points[0].id, st.state.points[1].id, 3, 5, 1);
  st.importState(exported);
  assert.equal(st.state.points.length, 2);
  st.undo();
  assert.equal(st.state.points.length, 3);
});
