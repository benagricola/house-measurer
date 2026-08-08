import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDistance, fmtDist, circleIntersect, solve, pointName, CLAMP_TOL,
  segIntersects, weakDir, outwardNormal,
} from '../js/geometry.js';
import { Store } from '../js/state.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

test('parseDistance: integer means cm, decimal means metres', () => {
  close(parseDistance('342'), 3.42);
  close(parseDistance('84'), 0.84);
  close(parseDistance('3.42'), 3.42);
  close(parseDistance('15.'), 15);
  close(parseDistance('.5'), 0.5);
  close(parseDistance('3,42'), 3.42); // comma as decimal separator
  close(parseDistance(' 120 '), 1.2);
});

test('parseDistance: rejects junk', () => {
  for (const bad of ['', '.', '0', '0.0', '1.2.3', '-3', 'abc', '3a', null, undefined]) {
    assert.equal(parseDistance(bad), null, `should reject ${bad}`);
  }
});

test('fmtDist', () => {
  assert.equal(fmtDist(0.84), '84 cm');
  assert.equal(fmtDist(3.42), '3.42 m');
  assert.equal(fmtDist(3.425), '3.425 m');
});

test('circleIntersect: symmetric case, left is left of p->q', () => {
  const c = circleIntersect({ x: 0, y: 0 }, Math.SQRT2, { x: 2, y: 0 }, Math.SQRT2);
  assert.ok(c.ok);
  assert.equal(c.gap, 0);
  close(c.left.x, 1); close(c.left.y, 1);
  close(c.right.x, 1); close(c.right.y, -1);
});

test('circleIntersect: 3-4-5 right angle', () => {
  const c = circleIntersect({ x: 0, y: 0 }, 3, { x: 4, y: 0 }, 5);
  close(c.left.x, 0); close(c.left.y, 3);
});

test('circleIntersect: small shortfall clamps onto the line with gap set', () => {
  const c = circleIntersect({ x: 0, y: 0 }, 2, { x: 4, y: 0 }, 1.98);
  assert.ok(c.ok);
  close(c.gap, 0.02, 1e-9);
  close(c.left.y, 0);
  assert.equal(c.left.x, c.right.x);
  assert.ok(c.left.x > 2 && c.left.x < 2.02);
});

test('circleIntersect: one circle inside the other', () => {
  const c = circleIntersect({ x: 0, y: 0 }, 5, { x: 1, y: 0 }, 1);
  close(c.gap, 3); // |r1 - r2| - d
});

test('circleIntersect: coincident centres fail', () => {
  assert.equal(circleIntersect({ x: 0, y: 0 }, 2, { x: 0, y: 0 }, 3).ok, false);
});

test('solve: anchor pair then chained point', () => {
  const s = {
    points: [
      { id: 1, name: 'A', fix: null },
      { id: 2, name: 'B', fix: null },
      { id: 3, name: 'C', fix: { r1: 1, r2: 2, side: 1 } },
    ],
    measurements: [
      { id: 10, p: 1, q: 2, d: 4 },
      { id: 11, p: 1, q: 3, d: 3 },
      { id: 12, p: 3, q: 2, d: 5 }, // order-independent lookup
    ],
  };
  const r = solve(s);
  close(r.pos.get(1).x, 0);
  close(r.pos.get(2).x, 4);
  close(r.pos.get(3).x, 0);
  close(r.pos.get(3).y, 3);
  s.points[2].fix.side = -1;
  close(solve(s).pos.get(3).y, -3);
});

test('solve: chain cascades and errors are reported, never silently placed', () => {
  const s = {
    points: [
      { id: 1, name: 'A', fix: null },
      { id: 2, name: 'B', fix: null },
      { id: 3, name: 'C', fix: { r1: 1, r2: 2, side: 1 } },
      { id: 4, name: 'D', fix: { r1: 3, r2: 2, side: 1 } }, // depends on C
    ],
    measurements: [
      { id: 10, p: 1, q: 2, d: 4 },
      { id: 11, p: 1, q: 3, d: 1 },
      { id: 12, p: 2, q: 3, d: 1 }, // impossible: 1 + 1 < 4
      { id: 13, p: 3, q: 4, d: 1 },
      { id: 14, p: 2, q: 4, d: 1 },
    ],
  };
  const r = solve(s);
  assert.ok(!r.pos.has(3));
  assert.ok(r.errors.get(3).includes('miss'));
  assert.equal(r.errors.get(4), 'reference not solved');
});

test('solve: gap within tolerance is placed but reported', () => {
  const s = {
    points: [
      { id: 1, name: 'A', fix: null },
      { id: 2, name: 'B', fix: null },
      { id: 3, name: 'C', fix: { r1: 1, r2: 2, side: 1 } },
    ],
    measurements: [
      { id: 10, p: 1, q: 2, d: 4 },
      { id: 11, p: 1, q: 3, d: 2 },
      { id: 12, p: 2, q: 3, d: 1.99 },
    ],
  };
  const r = solve(s);
  assert.ok(r.pos.has(3));
  close(r.gaps.get(3), 0.01, 1e-9);
  assert.ok(r.gaps.get(3) < CLAMP_TOL);
});

test('pointName', () => {
  assert.equal(pointName(0), 'A');
  assert.equal(pointName(25), 'Z');
  assert.equal(pointName(26), 'AA');
  assert.equal(pointName(27), 'AB');
});

// ---- store ----------------------------------------------------------------

function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
  };
}

test('store: anchors, chained point, undo/redo, persistence round-trip', () => {
  const storage = memStorage();
  const st = new Store(storage);
  const { a, b } = st.setAnchors(4);
  const c = st.addPoint(a, b, 3, 5, 1);
  close(st.solved.pos.get(c).y, 3);

  st.flipSide(c);
  close(st.solved.pos.get(c).y, -3);

  assert.ok(st.undo()); // un-flip
  close(st.solved.pos.get(c).y, 3);
  assert.ok(st.undo()); // remove C
  assert.equal(st.state.points.length, 2);
  assert.ok(st.redo());
  assert.equal(st.state.points.length, 3);
  close(st.solved.pos.get(c).y, 3);

  // Fresh store loads persisted state including undo history.
  const st2 = new Store(storage);
  st2.load();
  assert.equal(st2.state.points.length, 3);
  close(st2.solved.pos.get(c).y, 3);
  assert.ok(st2.canUndo);
  assert.ok(st2.undo());
  assert.equal(st2.state.points.length, 2);
});

test('store: ids stay unique across undo + new commits', () => {
  const st = new Store(memStorage());
  const { a, b } = st.setAnchors(4);
  const c1 = st.addPoint(a, b, 3, 5, 1);
  st.undo();
  const c2 = st.addPoint(a, b, 2, 3, 1);
  assert.notEqual(c1, c2);
});

test('segIntersects: crossings yes, shared endpoints and disjoint no', () => {
  const P = (x, y) => ({ x, y });
  assert.ok(segIntersects(P(0, 0), P(2, 2), P(0, 2), P(2, 0)), 'X crossing');
  assert.ok(!segIntersects(P(0, 0), P(1, 0), P(0, 1), P(1, 1)), 'parallel apart');
  assert.ok(!segIntersects(P(0, 0), P(2, 2), P(2, 2), P(4, 0)), 'shared endpoint is not occlusion');
  assert.ok(!segIntersects(P(0, 0), P(1, 1), P(3, 0), P(4, 2)), 'disjoint no');
  // A wall passing just in front of the target blocks the ray.
  assert.ok(segIntersects(P(0, 0), P(4, 0), P(2, -1), P(2, 1)), 'wall across the ray');
});

test('weakDir: shallow rays weak across them, right angles perfectly conditioned', () => {
  const P = (x, y) => ({ x, y });
  // Rays from (0,0) to refs almost behind each other (5 degrees apart):
  // the weak axis is near-perpendicular to the mean ray, conditioning bad.
  const w1 = weakDir(P(0, 0), P(-3, -0.1), P(-3, 0.1));
  assert.ok(Math.abs(w1.x) < 0.1 && Math.abs(w1.y) > 0.99, `weak axis perpendicular (${w1.x.toFixed(2)}, ${w1.y.toFixed(2)})`);
  assert.ok(w1.cond < 0.05, `shallow rays badly conditioned (${w1.cond.toFixed(3)})`);
  // Right-angle rays: conditioning is perfect.
  const w2 = weakDir(P(0, 0), P(-3, 0), P(0, -3));
  assert.ok(w2.cond > 0.99, `right angle ideal (${w2.cond.toFixed(3)})`);
  // 150-degree rays: weak along the bisector's normal, mediocre cond.
  const w3 = weakDir(P(0, 0), P(-3, 0), P(3 * Math.cos(Math.PI / 6), 3 * Math.sin(Math.PI / 6)));
  assert.ok(w3.cond > 0.05 && w3.cond < 0.3, `150 degrees mediocre (${w3.cond.toFixed(3)})`);
});

test('outwardNormal: points away from the inside, whatever the winding', () => {
  const P = (x, y) => ({ x, y });
  // Wall along the x axis with the room above it: the band grows down.
  const n1 = outwardNormal(P(0, 0), P(4, 0), P(2, 3));
  close(n1.x, 0, 1e-12);
  close(n1.y, -1, 1e-12);
  // Same wall walked the other way: still away from the room.
  const n2 = outwardNormal(P(4, 0), P(0, 0), P(2, 3));
  close(n2.x, 0, 1e-12);
  close(n2.y, -1, 1e-12);
  // Always a unit vector, always perpendicular to the segment.
  const n3 = outwardNormal(P(1, 1), P(4, 5), P(0, 9));
  close(Math.hypot(n3.x, n3.y), 1, 1e-12);
  close(n3.x * 3 + n3.y * 4, 0, 1e-12);
  // No inside reference (nothing solved yet): still a unit normal.
  const n4 = outwardNormal(P(0, 0), P(0, 2), null);
  close(Math.hypot(n4.x, n4.y), 1, 1e-12);
});
