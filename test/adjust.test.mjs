import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  solve, adjust, solveAdjusted, pointSegDist, itemCorners, pointInItem,
  angleDeg, interiorAngles,
} from '../js/geometry.js';
import { Store } from '../js/state.js';
import { stairRise, stairSteps } from '../js/items.js';

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

test('store: late flip of a mis-sided point, then mirror of its branch', () => {
  const st = new Store(memStorage());
  const { a, b } = st.setAnchors(4, { wall: false });
  const c = st.addPoint(a, b, 3, 5, 1, {});   // 3-4-5: C = (0, 3)
  const d = st.addPoint(a, c, 2, 2, 1, {});   // D = (-1.3229, 1.5)
  const t = st.addStackedPoint(d, {});        // twin riding on D
  const pos = (id) => st.solved.pos.get(id);
  close(pos(c).y, 3, 1e-9);
  close(pos(d).x, -Math.sqrt(4 - 2.25), 1e-9);
  close(pos(d).y, 1.5, 1e-9);

  // The branch of C is everything transitively fixed from it.
  const branch = st.pointBranch(c).map((p) => p.id).sort();
  assert.deepEqual(branch, [d, t].sort(), 'branch = D and its stacked twin');

  st.flipSide(c);
  close(pos(c).y, -3, 1e-9, 'C mirrors across the baseline');
  // D re-solves from the moved C with its stored side: NOT the mirror.
  close(pos(d).x, Math.sqrt(4 - 2.25), 1e-9);
  close(pos(d).y, -1.5, 1e-9);

  st.flipDependents(c);
  // Now the whole branch is the exact reflection of the original.
  close(pos(d).x, -Math.sqrt(4 - 2.25), 1e-9);
  close(pos(d).y, -1.5, 1e-9);
  close(pos(t).x, pos(d).x, 1e-12, 'stacked twin follows, no side of its own');
  assert.equal(st.point(t).fix.side, undefined);

  st.undo();
  st.undo();
  close(pos(c).y, 3, 1e-9, 'two undos restore everything');
  close(pos(d).y, 1.5, 1e-9);
});

test('store: reference-first anchors take no run; seedWallRun starts it at A-B', () => {
  const st = new Store(memStorage());
  const { a, b } = st.setAnchors(3.42, { wall: false });
  assert.equal(st.state.walls.length, 0, 'no run while walling is off');
  const c = st.addPoint(a, b, 2, 2.5, 1, { autoWall: false });
  assert.equal(st.state.walls.length, 0, 'reference point stays out of walls');
  st.seedWallRun([a, b]);
  assert.equal(st.state.walls.length, 1);
  assert.deepEqual(st.state.walls[0].pts, [a, b], 'run seeded with the anchor pair');
  const d = st.addPoint(a, c, 2, 2, 1, { autoWall: true });
  assert.deepEqual(st.state.walls[0].pts, [a, b, d], 'chaining continues from the seed');
  st.undo();
  assert.deepEqual(st.state.walls[0].pts, [a, b], 'undo removes the chained point and its link');
});

test('store: anchors start a wall run; points auto-chain; close; heights', () => {
  const st = new Store(memStorage());
  const { a, b } = st.setAnchors(4);
  const run = st.openWall();
  assert.ok(run, 'anchor commit starts the wall run');
  assert.deepEqual(run.pts, [a, b]);
  const wallId = run.id;

  const c = st.addPoint(a, b, 3, 5, 1, { autoWall: true });
  assert.deepEqual(st.state.walls[0].pts, [a, b, c], 'point appended to the run');
  assert.equal(st.hasClosedRoomOn(st.state.activeFloor), false);

  assert.equal(st.closeWall(wallId), true);
  assert.equal(st.state.walls[0].closed, true);
  assert.equal(st.hasClosedRoomOn(st.state.activeFloor), true);
  assert.equal(st.openWall(), null);

  st.setWallHeight(wallId, 2.4);
  assert.equal(st.wall(wallId).height, 2.4);

  // After a closed room, addPoint without autoWall leaves walls alone.
  const d = st.addPoint(a, c, 2, 2.5, 1);
  assert.equal(st.state.walls[0].pts.length, 3);
  assert.ok(st.point(d));

  // One undo step covers point + wall link together.
  st.undo(); // remove d
  st.undo(); // un-set height
  st.undo(); // un-close
  st.undo(); // removes c AND its wall link atomically
  assert.equal(st.state.points.length, 2);
  assert.deepEqual(st.state.walls[0].pts, [a, b]);
});

test('store: walls draw, close, step back, delete', () => {
  const st = new Store(memStorage());
  const { a, b } = st.setAnchors(4, { wall: false });
  assert.equal(st.state.walls.length, 0, 'wall:false skips the auto run');
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

test('store: v1 state in storage migrates to current shape', () => {
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
  assert.equal(st.state.v, 3);
  assert.deepEqual(st.state.walls, []);
  assert.deepEqual(st.state.items, []);
  assert.equal(st.state.layers[0].id, 'current');
  assert.equal(st.state.floors[0].id, 'f0');
  assert.equal(st.state.points[0].floor, 'f0');
  assert.equal(st.state.roomHeight, 2.6);
  // Undoing into a v1 snapshot must also come back migrated.
  assert.ok(st.undo());
  assert.equal(st.state.v, 3);
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

test('solve + adjust: stacked points ride their owner', () => {
  const s = {
    points: [
      { id: 1, name: 'A', fix: null },
      { id: 2, name: 'B', fix: null },
      { id: 3, name: 'C', fix: { stack: 1 } },          // above A
      { id: 4, name: 'D', fix: { stack: 2 } },          // above B
      { id: 5, name: 'E', fix: { r1: 3, r2: 4, side: 1 } }, // fixed from the twins
    ],
    measurements: [
      { id: 10, p: 1, q: 2, d: 4 },
      { id: 11, p: 3, q: 5, d: 3 },
      { id: 12, p: 4, q: 5, d: 5 },
    ],
  };
  const r = solveAdjusted(s);
  close(r.pos.get(3).x, 0, 1e-6);
  close(r.pos.get(4).x, 4, 1e-6);
  close(r.pos.get(5).x, 0, 1e-3);
  close(r.pos.get(5).y, 3, 1e-3);
  // A redundant cross-check through a stacked twin still lands on the owner.
  s.measurements.push({ id: 13, p: 1, q: 5, d: 3.02 });
  const r2 = solveAdjusted(s);
  assert.ok(Math.abs(r2.mres.get(13)) < 0.02, 'stacked-twin measurement participates in LSQ');
  assert.ok(r2.pres.get(5) > 0.005, 'residual attributed');
});

test('store: floors, stacked points, per-floor auto-walling', () => {
  const st = new Store(memStorage());
  const { a, b } = st.setAnchors(4);
  const c = st.addPoint(a, b, 3, 5, 1, { autoWall: true });
  const w1 = st.openWall();
  assert.equal(w1.pts.length, 3);
  st.closeWall(w1.id);

  const f2 = st.addFloor('upstairs', 2.9);
  assert.equal(st.state.activeFloor, f2);
  assert.equal(st.openWall(), null, 'open-wall lookup is per floor');
  assert.equal(st.hasClosedRoomOn(f2), false);
  assert.equal(st.hasClosedRoomOn('f0'), true);

  const a2 = st.addStackedPoint(a, { autoWall: true });
  const b2 = st.addStackedPoint(b, { autoWall: true });
  assert.equal(st.point(a2).floor, f2);
  assert.deepEqual(st.openWall().pts, [a2, b2], 'stacked points start the upstairs run');
  const p1 = st.solved.pos.get(a2);
  close(p1.x, 0); close(p1.y, 0);
  close(st.solved.pos.get(b2).x, 4);

  const e = st.addPoint(a2, b2, 3, 5, 1, { autoWall: true });
  close(st.solved.pos.get(e).y, 3);
  assert.equal(st.point(e).floor, f2);
  assert.equal(st.openWall().pts.length, 3);

  st.setFloorElevation(f2, 3.0);
  assert.equal(st.floor(f2).elevation, 3);
  assert.equal(st.deleteFloor(f2), false, 'occupied floor cannot be deleted');
  st.setActiveFloor('f0');
  assert.equal(st.state.activeFloor, 'f0');
});

test('store: v2 state migrates to v3 with floor stamps', () => {
  const storage = memStorage();
  storage.setItem('house-measurer.v1', JSON.stringify({
    state: {
      v: 2,
      points: [{ id: 1, name: 'A', fix: null }, { id: 2, name: 'B', fix: null }],
      measurements: [{ id: 3, p: 1, q: 2, d: 4 }],
      walls: [{ id: 9, pts: [1, 2], closed: false }],
      items: [{ id: 5, name: 'x', category: 'other', layer: 'current', w: 1, d: 1, h: 1, x: 0, y: 0, rot: 0, z0: 0 }],
      layers: [{ id: 'current', name: 'current', visible: true }],
      activeLayer: 'current',
      roomHeight: 2.6,
    },
    undoStack: [], redoStack: [], nextId: 10,
  }));
  const st = new Store(storage);
  st.load();
  assert.equal(st.state.v, 3);
  assert.equal(st.state.floors[0].id, 'f0');
  assert.equal(st.state.points[0].floor, 'f0');
  assert.equal(st.state.walls[0].floor, 'f0');
  assert.equal(st.state.items[0].floor, 'f0');
});

test('store: per-segment wall thickness and sloped heights', () => {
  const st = new Store(memStorage());
  const { a, b } = st.setAnchors(4);
  const w = st.openWall();
  const key = `${a}:${b}`;
  st.setWallSeg(w.id, key, { t: 0.55, h1: 1.2, h2: 1.2 });
  assert.equal(st.wall(w.id).thick[key], 0.55);
  assert.deepEqual(st.wall(w.id).segH[key], [1.2, 1.2]);
  // Raise one end only: the other keeps its value.
  st.setWallSeg(w.id, key, { h1: 2.4 });
  assert.deepEqual(st.wall(w.id).segH[key], [2.4, 1.2]);
  assert.equal(st.wall(w.id).thick[key], 0.55, 'thickness untouched');
  st.setDefaultWallThickness(0.12);
  assert.equal(st.state.wallThickness, 0.12);
  st.undo();
  st.undo();
  st.undo();
  assert.equal(st.state.wallThickness, 0.09);
  assert.equal(st.wall(w.id).thick, undefined);
});

test('store: deletePoint cleans up; freed names are reused, never duplicated', () => {
  const st = new Store(memStorage());
  const { a, b } = st.setAnchors(4);
  const c = st.addPoint(a, b, 3, 5, 1, { autoWall: true });
  st.closeWall(st.state.walls[0].id);

  assert.equal(st.pointDependents(c).length, 0);
  st.deletePoint(c);
  assert.equal(st.state.points.length, 2);
  assert.equal(st.state.measurements.length, 1, 'its measurements went too');
  assert.deepEqual(st.state.walls[0].pts, [a, b]);
  assert.equal(st.state.walls[0].closed, false, 'loop below 3 points re-opens');

  const d = st.addPoint(a, b, 2, 3, 1);
  assert.equal(st.point(d).name, 'C', 'freed name reused - no duplicate letters');

  const e = st.addPoint(a, b, 3, 5, 1);
  const f = st.addPoint(a, e, 2, 2, 1);
  assert.deepEqual(st.pointDependents(e).map((p) => p.id), [f]);
  st.deletePoint(e);
  assert.ok(st.solved.errors.has(f), 'dependent left unsolved, not silently moved');
  st.undo();
  assert.ok(!st.solved.errors.has(f));
});

test('store: addPoint extras commit atomically and feed the adjustment', () => {
  const st = new Store(memStorage());
  const { a, b } = st.setAnchors(4);
  const c = st.addPoint(a, b, 3, 5, 1);            // C at (0, 3)
  // New point fixed from A and B, with an extra check distance to C that
  // disagrees by 2 cm - the fit should spread it as residuals.
  const p = st.addPoint(a, b, Math.SQRT2 * 2, Math.hypot(2, 2 - 4) /*2.828*/, 1, {
    extras: [{ p: c, d: Math.hypot(2, 3 - 2) + 0.02 }],
  });
  assert.equal(st.state.measurements.length, 6, 'fix pair + extra in one commit');
  assert.ok(st.solved.pres.get(p) > 0.003, 'extra participates: residual appears');
  st.undo();
  assert.ok(!st.point(p), 'one undo removes point with all its measurements');
  assert.equal(st.state.measurements.length, 3);
});

test('store: detachPointFromWalls and load-bearing measurement analysis', () => {
  const st = new Store(memStorage());
  const { a, b } = st.setAnchors(4);
  const c = st.addPoint(a, b, 3, 5, 1, { autoWall: true });
  const d = st.addPoint(a, b, 2, 3.4, 1, { autoWall: true });
  st.closeWall(st.state.walls[0].id);

  // Detach keeps the point and the loop (4 -> 3 points stays closed).
  st.detachPointFromWalls(d);
  assert.deepEqual(st.state.walls[0].pts, [a, b, c]);
  assert.equal(st.state.walls[0].closed, true);
  assert.ok(st.point(d), 'point survives as a reference');
  st.detachPointFromWalls(c);
  assert.equal(st.state.walls[0].closed, false, 'below 3 the loop opens');

  // Load analysis: fix measurements carry their point (and its chain).
  const mAC = st.state.measurements.find((m) => m.p === a && m.q === c);
  assert.deepEqual(st.measurementLoad(mAC.id).map((p) => p.id), [c]);
  // The anchor baseline carries B.
  const mAB = st.state.measurements.find((m) => m.p === a && m.q === b);
  assert.ok(st.measurementLoad(mAB.id).some((p) => p.id === b));
  // A duplicate of the same pair makes the original safe to delete.
  st.addMeasurement(a, c, 3.001);
  assert.equal(st.measurementLoad(mAC.id).length, 0);
});

test('angles: between segments and interior angles with reflex corners', () => {
  close(angleDeg({ x: -1, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 1 }), 90);
  close(angleDeg({ x: -1, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 1 }), 135);
  // Unit square, either winding: all 90.
  const sq = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  for (const a of interiorAngles(sq)) close(a, 90);
  for (const a of interiorAngles([...sq].reverse())) close(a, 90);
  // L-shape: five 90s and one 270 (the chimney-breast corner).
  const L = [
    { x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 1 },
    { x: 1, y: 1 }, { x: 1, y: 2 }, { x: 0, y: 2 },
  ];
  const angs = interiorAngles(L).map((a) => Math.round(a));
  assert.equal(angs.filter((a) => a === 90).length, 5);
  assert.equal(angs.filter((a) => a === 270).length, 1);
});

test('stairRise: odd first/last risers, degenerate counts', () => {
  assert.equal(stairRise(13, 20), 260);
  assert.equal(stairRise(13, 20, 24), 264);      // odd bottom step
  assert.equal(stairRise(13, 20, 24, 17), 261);  // odd top too
  assert.equal(stairRise(2, 20, 24), 44);
  assert.equal(stairRise(1, 20, 24), 24);
  assert.equal(stairRise(null, 20), null);
  assert.equal(stairRise(13, null), null);
  assert.equal(stairSteps(2.9), 16);
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
