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

// Point name from creation index: A..Z, AA, AB, ...
export function pointName(i) {
  let n = i, s = '';
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}
