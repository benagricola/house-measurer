// Pure geometry + parsing. No DOM, no three.js — tested with node --test.

// If two circles fail to intersect by no more than this (metres), the point is
// clamped onto the line between the references instead of being rejected.
// Covers laser noise / walls out of plumb on near-collinear fixes.
export const CLAMP_TOL = 0.03;

// Parse a keypad entry into metres.
// Rule: contains a decimal point -> metres ("3.42" = 3.42 m, "15." = 15 m);
// plain integer -> centimetres ("342" = 3.42 m, "84" = 0.84 m).
// Accepts comma as decimal separator. Returns null if unparseable or <= 0.
export function parseDistance(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().replace(',', '.');
  if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const v = parseFloat(s);
  if (!isFinite(v) || v <= 0) return null;
  return s.includes('.') ? v : v / 100;
}

// Human-readable distance for labels.
export function fmtDist(m) {
  if (m == null) return '';
  if (m < 1) return `${(m * 100).toFixed(1).replace(/\.0$/, '')} cm`;
  return `${m.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')} m`;
}

// Intersect circle (p, r1) with circle (q, r2).
// Returns { ok, gap, left, right }:
//   left  = candidate on the left of the direction p -> q
//   right = candidate on the right
//   gap   = 0 if the circles genuinely intersect; otherwise the shortfall in
//           metres (circles too far apart, or one inside the other) with both
//           candidates collapsed onto the p -> q line.
// ok:false only when p and q coincide.
export function circleIntersect(p, r1, q, r2) {
  const dx = q.x - p.x, dy = q.y - p.y;
  const d = Math.hypot(dx, dy);
  if (d < 1e-9) return { ok: false, gap: Infinity };
  const ux = dx / d, uy = dy / d;
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h2 = r1 * r1 - a * a;
  let gap = 0, h = 0;
  if (h2 >= 0) {
    h = Math.sqrt(h2);
  } else {
    gap = d > r1 + r2 ? d - (r1 + r2) : Math.abs(r1 - r2) - d;
  }
  const bx = p.x + ux * a, by = p.y + uy * a;
  const nx = -uy, ny = ux; // left normal of p -> q
  return {
    ok: true,
    gap,
    left: { x: bx + nx * h, y: by + ny * h },
    right: { x: bx - nx * h, y: by - ny * h },
  };
}

// Solve every point position from the measurement chain.
//
// state = {
//   points: [{ id, name, fix }],      // creation order = solve order
//   measurements: [{ id, p, q, d }],  // symmetric distances in metres
// }
// fix: null for the two anchors, else { r1, r2, side } where side is
// +1 = left of r1 -> r2, -1 = right.
//
// Point 0 sits at the origin, point 1 on the +x axis at the measured A-B
// distance. Every later point intersects two circles around its references.
//
// Returns { pos: Map<id,{x,y}>, gaps: Map<id,metres>, errors: Map<id,string> }.
// A point whose references are unsolved inherits an error (chain cascades).
export function solve(state) {
  const pos = new Map(), gaps = new Map(), errors = new Map();
  const dist = (a, b) => {
    const m = state.measurements.find(
      (m) => (m.p === a && m.q === b) || (m.p === b && m.q === a)
    );
    return m ? m.d : null;
  };
  state.points.forEach((pt, i) => {
    if (i === 0) {
      pos.set(pt.id, { x: 0, y: 0 });
      return;
    }
    if (i === 1) {
      const d = dist(state.points[0].id, pt.id);
      if (d == null) { errors.set(pt.id, 'missing anchor distance'); return; }
      pos.set(pt.id, { x: d, y: 0 });
      return;
    }
    const f = pt.fix;
    if (!f) { errors.set(pt.id, 'no fix'); return; }
    // Stacked point: same plan position as its reference (a point declared
    // to sit directly above/below another, e.g. on the next floor).
    if (f.stack != null) {
      const sp = pos.get(f.stack);
      if (!sp) { errors.set(pt.id, 'stacked reference not solved'); return; }
      pos.set(pt.id, { x: sp.x, y: sp.y });
      return;
    }
    const P = pos.get(f.r1), Q = pos.get(f.r2);
    const d1 = dist(f.r1, pt.id), d2 = dist(f.r2, pt.id);
    if (!P || !Q || d1 == null || d2 == null) {
      errors.set(pt.id, 'reference not solved');
      return;
    }
    const c = circleIntersect(P, d1, Q, d2);
    if (!c.ok) { errors.set(pt.id, 'references coincide'); return; }
    if (c.gap > CLAMP_TOL) {
      errors.set(pt.id, `circles miss by ${(c.gap * 100).toFixed(1)} cm`);
      gaps.set(pt.id, c.gap);
      return;
    }
    if (c.gap > 0) gaps.set(pt.id, c.gap);
    pos.set(pt.id, f.side >= 0 ? c.left : c.right);
  });
  return { pos, gaps, errors };
}

// Solve A x = b by Gaussian elimination with partial pivoting.
// A is an array of Float64Array rows; both are destroyed. Returns x or null.
function solveLinear(A, b) {
  const n = b.length;
  const x = new Float64Array(n);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    if (Math.abs(A[piv][col]) < 1e-14) return null;
    [A[col], A[piv]] = [A[piv], A[col]];
    [b[col], b[piv]] = [b[piv], b[col]];
    for (let r = col + 1; r < n; r++) {
      const f = A[r][col] / A[col][col];
      if (!f) continue;
      for (let c = col; c < n; c++) A[r][c] -= f * A[col][c];
      b[r] -= f * b[col];
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let c = r + 1; c < n; c++) s -= A[r][c] * x[c];
    x[r] = s / A[r][r];
  }
  return x;
}

// Least-squares adjustment (Gauss-Newton) of all chain-solved positions
// against ALL measurements. Distributes laser noise across the network and
// yields a residual per measurement. Gauge: first point pinned at the
// origin, second point pinned to the +x axis.
// Returns { pos, mres: Map<measId, m>, pres: Map<pointId, m> } or null when
// there is nothing to adjust.
export function adjust(state, chain) {
  // A stacked point shares its owner's plan coordinates, so it shares the
  // owner's variables: measurements to it act on the owner directly.
  const byId = new Map(state.points.map((p) => [p.id, p]));
  const ownerOf = (id) => {
    let p = byId.get(id);
    const seen = new Set();
    while (p?.fix?.stack != null && !seen.has(p.id)) {
      seen.add(p.id);
      p = byId.get(p.fix.stack);
    }
    return p?.id ?? id;
  };
  const ids = state.points
    .filter((p) => chain.pos.has(p.id) && ownerOf(p.id) === p.id)
    .map((p) => p.id);
  if (ids.length < 2) return null;
  const idx = new Map(ids.map((id, i) => [id, i]));
  const varOf = (i) => (i === 0 ? [-1, -1] : i === 1 ? [0, -1] : [2 * i - 3, 2 * i - 2]);
  const nv = 2 * ids.length - 3;
  const X = ids.map((id) => ({ ...chain.pos.get(id) }));
  const meas = state.measurements
    .map((m) => ({ ...m, p: ownerOf(m.p), q: ownerOf(m.q) }))
    .filter((m) => idx.has(m.p) && idx.has(m.q) && m.p !== m.q);
  if (!meas.length) return null;

  for (let iter = 0; iter < 12; iter++) {
    const A = Array.from({ length: nv }, () => new Float64Array(nv));
    const g = new Float64Array(nv);
    for (const m of meas) {
      const i = idx.get(m.p), j = idx.get(m.q);
      const dx = X[i].x - X[j].x, dy = X[i].y - X[j].y;
      const dist = Math.hypot(dx, dy) || 1e-12;
      const r = dist - m.d;
      const ux = dx / dist, uy = dy / dist;
      const entries = [];
      const [xi, yi] = varOf(i), [xj, yj] = varOf(j);
      if (xi >= 0) entries.push([xi, ux]);
      if (yi >= 0) entries.push([yi, uy]);
      if (xj >= 0) entries.push([xj, -ux]);
      if (yj >= 0) entries.push([yj, -uy]);
      for (const [a, va] of entries) {
        g[a] += va * r;
        for (const [b, vb] of entries) A[a][b] += va * vb;
      }
    }
    for (let k = 0; k < nv; k++) A[k][k] += 1e-9;
    const delta = solveLinear(A, g);
    if (!delta) break;
    let maxd = 0;
    ids.forEach((id, i) => {
      const [xv, yv] = varOf(i);
      if (xv >= 0) { X[i].x -= delta[xv]; maxd = Math.max(maxd, Math.abs(delta[xv])); }
      if (yv >= 0) { X[i].y -= delta[yv]; maxd = Math.max(maxd, Math.abs(delta[yv])); }
    });
    if (maxd < 1e-9) break;
  }

  const mres = new Map(), pres = new Map();
  for (const m of state.measurements) {
    const i = idx.get(ownerOf(m.p)), j = idx.get(ownerOf(m.q));
    if (i == null || j == null || i === j) continue;
    const r = Math.hypot(X[i].x - X[j].x, X[i].y - X[j].y) - m.d;
    mres.set(m.id, r);
    pres.set(m.p, Math.max(pres.get(m.p) || 0, Math.abs(r)));
    pres.set(m.q, Math.max(pres.get(m.q) || 0, Math.abs(r)));
  }
  const pos = new Map(ids.map((id, i) => [id, X[i]]));
  // Stacked points ride on their owner's adjusted position.
  for (const p of state.points) {
    if (!pos.has(p.id) && chain.pos.has(p.id)) {
      const o = pos.get(ownerOf(p.id));
      if (o) pos.set(p.id, { ...o });
    }
  }
  return { pos, mres, pres };
}

// Chain solve + least-squares adjustment in one call.
// Returns { pos, gaps, errors, mres, pres }.
export function solveAdjusted(state) {
  const chain = solve(state);
  const adj = adjust(state, chain);
  if (!adj) return { ...chain, mres: new Map(), pres: new Map() };
  return { pos: adj.pos, gaps: chain.gaps, errors: chain.errors, mres: adj.mres, pres: adj.pres };
}

// Distance from point to segment [a, b], plus the clamped parameter t.
export function pointSegDist(p, a, b) {
  const abx = b.x - a.x, aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2)) : 0;
  const cx = a.x + abx * t, cy = a.y + aby * t;
  return { d: Math.hypot(p.x - cx, p.y - cy), t, cx, cy };
}

// Corners of a rotated rectangle item {x, y, rot, w, d} (centre-based), CCW.
export function itemCorners(it) {
  const c = Math.cos(it.rot), s = Math.sin(it.rot);
  const hw = it.w / 2, hd = it.d / 2;
  return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([lx, ly]) => ({
    x: it.x + lx * c - ly * s,
    y: it.y + lx * s + ly * c,
  }));
}

export function pointInItem(p, it, marginM = 0) {
  const c = Math.cos(-it.rot), s = Math.sin(-it.rot);
  const dx = p.x - it.x, dy = p.y - it.y;
  const lx = dx * c - dy * s, ly = dx * s + dy * c;
  return Math.abs(lx) <= it.w / 2 + marginM && Math.abs(ly) <= it.d / 2 + marginM;
}

// Angle at vertex v between the segments v-prev and v-next, degrees 0..180.
export function angleDeg(prev, v, next) {
  const a1 = Math.atan2(prev.y - v.y, prev.x - v.x);
  const a2 = Math.atan2(next.y - v.y, next.x - v.x);
  let d = Math.abs(a1 - a2) * 180 / Math.PI;
  if (d > 180) d = 360 - d;
  return d;
}

// Interior angle at every vertex of a closed loop (no repeated last point).
// Orientation-aware, so reflex corners (chimney breasts) read > 180.
export function interiorAngles(pts) {
  const n = pts.length;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    area += p.x * q.y - q.x * p.y;
  }
  const ccw = area > 0;
  return pts.map((v, i) => {
    const prev = pts[(i - 1 + n) % n], next = pts[(i + 1) % n];
    const d1 = { x: v.x - prev.x, y: v.y - prev.y };
    const d2 = { x: next.x - v.x, y: next.y - v.y };
    const turn = Math.atan2(d1.x * d2.y - d1.y * d2.x, d1.x * d2.x + d1.y * d2.y) * 180 / Math.PI;
    return ccw ? 180 - turn : 180 + turn;
  });
}

// Point name from creation index: A..Z, AA, AB, ...
export function pointName(i) {
  let n = i, s = '';
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}
