// Top-down plan renderer: three.js orthographic scene + touch gestures +
// DOM overlay for text labels. Dumb view: main.js hands it a display list:
// {
//   points:   [{x, y, style, refIndex, isLast}],
//   segments: [{x1, y1, x2, y2, style: 'ab'|'ray'|'wall'|'wallActive'}],
//   circles:  [{cx, cy, r}],
//   ghosts:   [{x, y, primary}],
//   rects:    [{x, y, rot, w, d, color, opacity, halo}],   // items
//   polygons: [{pts: [{x,y}...], color, opacity}],          // room fill
//   handles:  [{x, y}],                                     // rotate handle
//   labels:   [{key, x, y, text, cls, dx, dy}],
// }

import * as THREE from 'three';

const BG = 0xf6f4ee;
const COLORS = {
  gridMinor: 0xe8e4d9,
  gridMajor: 0xd6d0bf,
  segment: 0x8a867a,
  ray: 0xb0aa9c,
  wall: 0x3a3a40,
  wallActive: 0xe8960c,
  wallGhost: 0xc4beae,
  ghostpt: 0xb5af9f,
  circle: 0xc9c3b2,
  anchor: 0x1f2a44,
  point: 0x0e7a6f,
  error: 0xc0392b,
  refRing: 0xe8960c,
  lastRing: 0x9fbfba,
  ghost: 0x0e7a6f,
  halo: 0xe8960c,
  handle: 0xe8960c,
};

const NICE = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50];

export class PlanView {
  constructor(canvas, overlay, scalebar, callbacks = {}) {
    this.canvas = canvas;
    this.overlay = overlay;
    this.scalebar = scalebar;
    this.cb = callbacks;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setClearColor(BG);

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
    this.camera.position.set(0, 0, 10);

    // View state: centre (metres) + vertical extent of the view (metres).
    this.cx = 0;
    this.cy = 0;
    this.viewH = 6;

    // Shared unit geometries, scaled per-mesh. Nothing is ever disposed;
    // rebuilds just swap mesh instances referencing these.
    this.geoCircle = new THREE.CircleGeometry(1, 40);
    this.geoRing = new THREE.RingGeometry(0.78, 1, 40);
    this.geoThinRing = new THREE.RingGeometry(0.92, 1, 64);
    this.geoQuad = new THREE.PlaneGeometry(1, 1);
    const pts = [];
    for (let i = 0; i <= 96; i++) {
      const a = (i / 96) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a), Math.sin(a), 0));
    }
    this.geoCircleLine = new THREE.BufferGeometry().setFromPoints(pts);
    this.materials = new Map();

    this.grid = this.buildGrid();
    this.scene.add(this.grid);
    this.group = new THREE.Group();
    this.scene.add(this.group);

    this.content = {};
    this.labelPool = new Map();

    this._dirty = false;
    this.initGestures();

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas.parentElement);
    this.resize();
  }

  mat(kind, color, opacity = 1) {
    const key = `${kind}:${color}:${opacity}`;
    if (!this.materials.has(key)) {
      const opts = { color, transparent: opacity < 1, opacity };
      this.materials.set(
        key,
        kind === 'line' ? new THREE.LineBasicMaterial(opts) : new THREE.MeshBasicMaterial(opts)
      );
    }
    return this.materials.get(key);
  }

  buildGrid() {
    const g = new THREE.Group();
    const half = 60; // metres each way; plenty for a house
    const minor = [], major = [];
    for (let i = -half * 2; i <= half * 2; i++) {
      const v = i / 2; // 0.5 m steps
      const target = i % 2 === 0 ? major : minor;
      target.push(-half, v, 0, half, v, 0);
      target.push(v, -half, 0, v, half, 0);
    }
    for (const [arr, color] of [[minor, COLORS.gridMinor], [major, COLORS.gridMajor]]) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      g.add(new THREE.LineSegments(geo, this.mat('line', color)));
    }
    g.position.z = 0;
    return g;
  }

  // --- coordinates ---------------------------------------------------------
  get w() { return this.canvas.clientWidth || 1; }
  get h() { return this.canvas.clientHeight || 1; }
  get worldPerPx() { return this.viewH / this.h; }

  screenToWorld(px, py) {
    const s = this.worldPerPx;
    return { x: this.cx + (px - this.w / 2) * s, y: this.cy - (py - this.h / 2) * s };
  }

  worldToScreen(x, y) {
    const s = this.worldPerPx;
    return { x: (x - this.cx) / s + this.w / 2, y: (this.cy - y) / s + this.h / 2 };
  }

  resize() {
    const w = this.canvas.parentElement.clientWidth;
    const h = this.canvas.parentElement.clientHeight;
    if (w < 2 || h < 2) return;
    this.renderer.setSize(w, h, false);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.applyCamera();
    this.rebuild();
  }

  applyCamera() {
    const aspect = this.w / this.h;
    const hh = this.viewH / 2, hw = hh * aspect;
    this.camera.left = -hw;
    this.camera.right = hw;
    this.camera.top = hh;
    this.camera.bottom = -hh;
    this.camera.position.set(this.cx, this.cy, 10);
    this.camera.updateProjectionMatrix();
    this.updateScalebar();
  }

  setView(cx, cy, viewH) {
    this.cx = cx;
    this.cy = cy;
    this.viewH = Math.min(200, Math.max(0.5, viewH));
    this.applyCamera();
    this.rebuild();
    if (this.cb.onCamera) this.cb.onCamera();
  }

  fitAll(points, pad = 1.35) {
    if (!points.length) { this.setView(0, 0, 6); return; }
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of points) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const aspect = this.w / this.h;
    const spanY = Math.max(maxY - minY, (maxX - minX) / aspect, 2);
    this.setView(cx, cy, spanY * pad);
  }

  isOnScreen(x, y, marginPx = 30) {
    const s = this.worldToScreen(x, y);
    return s.x > marginPx && s.x < this.w - marginPx && s.y > marginPx && s.y < this.h - marginPx;
  }

  // --- content -------------------------------------------------------------
  update(content) {
    this.content = content;
    this.rebuild();
  }

  rebuild() {
    this.group.clear();
    for (const g of this._tempGeos || []) g.dispose();
    this._tempGeos = [];
    const s = this.worldPerPx;
    const c = this.content;

    for (const poly of c.polygons || []) {
      if (poly.pts.length < 3) continue;
      const shape = new THREE.Shape(poly.pts.map((p) => new THREE.Vector2(p.x, p.y)));
      const geo = new THREE.ShapeGeometry(shape);
      this._tempGeos.push(geo);
      const mesh = new THREE.Mesh(geo, this.mat('mesh', poly.color, poly.opacity));
      mesh.position.z = 0.2;
      this.group.add(mesh);
    }

    for (const seg of c.segments || []) {
      let widthPx = 1.5, color = COLORS.ray, z = 0.6;
      if (seg.style === 'ab') { widthPx = 2.5; color = COLORS.segment; z = 0.5; }
      if (seg.style === 'wall') { widthPx = Math.max(3, 0.08 / s); color = COLORS.wall; z = 0.55; }
      if (seg.style === 'wallActive') { widthPx = Math.max(3, 0.08 / s); color = COLORS.wallActive; z = 0.56; }
      if (seg.style === 'wallGhost') { widthPx = Math.max(2, 0.08 / s); color = COLORS.wallGhost; z = 0.3; }
      this.group.add(this.quad(seg.x1, seg.y1, seg.x2, seg.y2, widthPx * s, color, z));
    }

    for (const r of c.rects || []) {
      if (r.halo) {
        const pad = 5 * s;
        const halo = new THREE.Mesh(this.geoQuad, this.mat('mesh', COLORS.halo, 0.85));
        halo.position.set(r.x, r.y, 0.68);
        halo.rotation.z = r.rot;
        halo.scale.set(r.w + pad * 2, r.d + pad * 2, 1);
        this.group.add(halo);
      }
      const m = new THREE.Mesh(this.geoQuad, this.mat('mesh', r.color, r.opacity ?? 0.8));
      m.position.set(r.x, r.y, 0.7);
      m.rotation.z = r.rot;
      m.scale.set(Math.max(r.w, 2 * s), Math.max(r.d, 2 * s), 1);
      this.group.add(m);
    }

    for (const circ of c.circles || []) {
      const line = new THREE.LineLoop(this.geoCircleLine, this.mat('line', COLORS.circle));
      line.position.set(circ.cx, circ.cy, 0.4);
      line.scale.set(circ.r, circ.r, 1);
      this.group.add(line);
    }

    for (const g of c.ghosts || []) {
      const r = 11 * s;
      const fill = new THREE.Mesh(this.geoCircle, this.mat('mesh', COLORS.ghost, g.primary ? 0.4 : 0.15));
      fill.position.set(g.x, g.y, 0.9);
      fill.scale.set(r, r, 1);
      this.group.add(fill);
      const ring = new THREE.Mesh(this.geoThinRing, this.mat('mesh', COLORS.ghost, g.primary ? 0.9 : 0.35));
      ring.position.set(g.x, g.y, 0.91);
      ring.scale.set(r, r, 1);
      this.group.add(ring);
    }

    for (const p of c.points || []) {
      const r = (p.style === 'anchor' ? 8 : p.style === 'ghostpt' ? 5 : 7) * s;
      const color = COLORS[p.style] || COLORS.point;
      const dot = new THREE.Mesh(this.geoCircle, this.mat('mesh', color));
      dot.position.set(p.x, p.y, 1);
      dot.scale.set(r, r, 1);
      this.group.add(dot);
      if (p.refIndex != null) {
        const ring = new THREE.Mesh(this.geoRing, this.mat('mesh', COLORS.refRing));
        ring.position.set(p.x, p.y, 1.1);
        ring.scale.set(r + 6 * s, r + 6 * s, 1);
        this.group.add(ring);
      } else if (p.isLast) {
        const ring = new THREE.Mesh(this.geoThinRing, this.mat('mesh', COLORS.lastRing));
        ring.position.set(p.x, p.y, 1.1);
        ring.scale.set(r + 5 * s, r + 5 * s, 1);
        this.group.add(ring);
      }
    }

    for (const hd of c.handles || []) {
      const ring = new THREE.Mesh(this.geoRing, this.mat('mesh', COLORS.handle));
      ring.position.set(hd.x, hd.y, 1.2);
      ring.scale.set(10 * s, 10 * s, 1);
      this.group.add(ring);
      const dot = new THREE.Mesh(this.geoCircle, this.mat('mesh', COLORS.handle));
      dot.position.set(hd.x, hd.y, 1.2);
      dot.scale.set(4 * s, 4 * s, 1);
      this.group.add(dot);
    }

    this.requestRender();
  }

  quad(x1, y1, x2, y2, width, color, z) {
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    const m = new THREE.Mesh(this.geoQuad, this.mat('mesh', color));
    m.position.set((x1 + x2) / 2, (y1 + y2) / 2, z);
    m.rotation.z = Math.atan2(dy, dx);
    m.scale.set(len, width, 1);
    return m;
  }

  // --- labels (DOM overlay) ------------------------------------------------
  updateLabels() {
    const seen = new Set();
    for (const l of this.content.labels || []) {
      seen.add(l.key);
      let el = this.labelPool.get(l.key);
      if (!el) {
        el = document.createElement('div');
        this.overlay.appendChild(el);
        this.labelPool.set(l.key, el);
      }
      el.className = 'lbl ' + (l.cls || '');
      el.textContent = l.text;
      const sp = this.worldToScreen(l.x, l.y);
      el.style.transform = `translate(-50%, -50%) translate(${Math.round(sp.x + (l.dx || 0))}px, ${Math.round(sp.y + (l.dy || 0))}px)`;
      el.style.display = sp.x < -60 || sp.x > this.w + 60 || sp.y < -30 || sp.y > this.h + 30 ? 'none' : '';
    }
    for (const [key, el] of this.labelPool) {
      if (!seen.has(key)) { el.remove(); this.labelPool.delete(key); }
    }
  }

  updateScalebar() {
    if (!this.scalebar) return;
    const s = this.worldPerPx;
    const target = 120 * s;
    let len = NICE[0];
    for (const n of NICE) if (n <= target * 1.4) len = n;
    const px = len / s;
    this.scalebar.style.width = px + 'px';
    this.scalebar.textContent = len < 1 ? `${len * 100} cm` : `${len} m`;
  }

  requestRender() {
    if (this._dirty) return;
    this._dirty = true;
    requestAnimationFrame(() => {
      this._dirty = false;
      this.renderer.render(this.scene, this.camera);
      this.updateLabels();
    });
  }

  // --- gestures ------------------------------------------------------------
  // 1-finger: tap, pan, or (if main claims it via onDragStart) object drag.
  // 2-finger: pinch zoom. Wheel: zoom.
  initGestures() {
    const c = this.canvas;
    this.pointers = new Map();
    this.gesture = null;

    c.addEventListener('pointerdown', (e) => {
      try { c.setPointerCapture(e.pointerId); } catch {} // pointer may already be gone
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 1) {
        const local = this.eventToLocal(e.clientX, e.clientY);
        const world = this.screenToWorld(local.x, local.y);
        const claimed = this.cb.onDragStart ? this.cb.onDragStart(world, local) : false;
        this.gesture = {
          type: claimed ? 'drag' : 'pan', id: e.pointerId, t0: performance.now(),
          startX: e.clientX, startY: e.clientY,
          lastX: e.clientX, lastY: e.clientY, moved: false,
          // Fingers wobble far more than mice; a tight threshold turns taps
          // into 1-frame pans and "nothing happens".
          slop: e.pointerType === 'touch' ? 18 : 9,
        };
      } else if (this.pointers.size === 2) {
        if (this.gesture?.type === 'drag' && this.cb.onDragEnd) this.cb.onDragEnd(true);
        const [p1, p2] = [...this.pointers.values()];
        this.gesture = {
          type: 'pinch',
          d0: Math.hypot(p2.x - p1.x, p2.y - p1.y),
          mid0: this.eventToLocal((p1.x + p2.x) / 2, (p1.y + p2.y) / 2),
          cx0: this.cx, cy0: this.cy, viewH0: this.viewH,
        };
      }
      e.preventDefault();
    });

    c.addEventListener('pointermove', (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      p.x = e.clientX;
      p.y = e.clientY;
      const g = this.gesture;
      if (!g) return;
      if ((g.type === 'pan' || g.type === 'drag') && e.pointerId === g.id) {
        const dx = e.clientX - g.lastX, dy = e.clientY - g.lastY;
        if (Math.hypot(e.clientX - g.startX, e.clientY - g.startY) > g.slop) g.moved = true;
        if (g.moved) {
          if (g.type === 'pan') {
            const s = this.worldPerPx;
            this.setView(this.cx - dx * s, this.cy + dy * s, this.viewH);
          } else if (this.cb.onDragMove) {
            const local = this.eventToLocal(e.clientX, e.clientY);
            this.cb.onDragMove(this.screenToWorld(local.x, local.y), local);
          }
        }
        g.lastX = e.clientX;
        g.lastY = e.clientY;
      } else if (g.type === 'pinch' && this.pointers.size >= 2) {
        const [p1, p2] = [...this.pointers.values()];
        const d = Math.hypot(p2.x - p1.x, p2.y - p1.y);
        if (d < 5) return;
        const viewH = Math.min(200, Math.max(0.5, g.viewH0 * (g.d0 / d)));
        const mid = this.eventToLocal((p1.x + p2.x) / 2, (p1.y + p2.y) / 2);
        // Keep the world point that started under the pinch centre under it.
        const s0 = g.viewH0 / this.h;
        const wx = g.cx0 + (g.mid0.x - this.w / 2) * s0;
        const wy = g.cy0 - (g.mid0.y - this.h / 2) * s0;
        const s1 = viewH / this.h;
        this.cx = wx - (mid.x - this.w / 2) * s1;
        this.cy = wy + (mid.y - this.h / 2) * s1;
        this.viewH = viewH;
        this.applyCamera();
        this.rebuild();
        if (this.cb.onCamera) this.cb.onCamera();
      }
      e.preventDefault();
    });

    const end = (e) => {
      const g = this.gesture;
      this.pointers.delete(e.pointerId);
      if (g && (g.type === 'pan' || g.type === 'drag') && e.pointerId === g.id) {
        const quick = performance.now() - g.t0 < 700;
        if (g.type === 'drag' && this.cb.onDragEnd) this.cb.onDragEnd(false);
        if (!g.moved && quick && e.type === 'pointerup' && this.cb.onTap) {
          const local = this.eventToLocal(e.clientX, e.clientY);
          const consumed = this.cb.onTap(this.screenToWorld(local.x, local.y), local);
          // Double-tap on empty canvas zooms in - the one-handed zoom
          // (pinch needs a second hand). Taps that hit something act
          // immediately and never count toward a double-tap.
          if (consumed) {
            this._freeTap = null;
          } else {
            const now = performance.now();
            const prev = this._freeTap;
            if (prev && now - prev.t < 350 && Math.hypot(local.x - prev.x, local.y - prev.y) < 44) {
              this._freeTap = null;
              const before = this.screenToWorld(local.x, local.y);
              const viewH = Math.max(0.5, this.viewH / 1.7);
              const s1 = viewH / this.h;
              this.setView(
                before.x - (local.x - this.w / 2) * s1,
                before.y + (local.y - this.h / 2) * s1,
                viewH
              );
            } else {
              this._freeTap = { t: now, x: local.x, y: local.y };
            }
          }
        }
        this.gesture = null;
      }
      if (g && g.type === 'pinch' && this.pointers.size < 2) this.gesture = null;
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);

    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = Math.pow(1.0015, e.deltaY);
      const local = this.eventToLocal(e.clientX, e.clientY);
      const before = this.screenToWorld(local.x, local.y);
      const viewH = Math.min(200, Math.max(0.5, this.viewH * factor));
      const s1 = viewH / this.h;
      this.cx = before.x - (local.x - this.w / 2) * s1;
      this.cy = before.y + (local.y - this.h / 2) * s1;
      this.viewH = viewH;
      this.applyCamera();
      this.rebuild();
      if (this.cb.onCamera) this.cb.onCamera();
    }, { passive: false });
  }

  eventToLocal(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  }
}
