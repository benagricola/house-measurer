// Extruded 3D perspective view. Plan coords (x, y) map to world (x, 0, -y),
// so a plan rotation theta becomes rotation.y = theta and the room reads the
// same way round as the plan (plan north = away from the camera start pose).

import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { categoryColor } from './items.js';
import { itemCorners } from './geometry.js';

const BG = 0xe9e5da;
const WALL_COLOR = 0xcfc9b8;
const FLOOR_COLOR = 0xd8d2c2;
const WALL_T = 0.08; // rendered wall thickness, metres

export class View3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setClearColor(BG);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.05, 500);
    this.camera.position.set(4, 5, 7);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(5, 10, 4);
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0xffffff, 0.4);
    fill.position.set(-6, 6, -5);
    this.scene.add(fill);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = false;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.02; // stay above the floor
    this.controls.addEventListener('change', () => this.requestRender());

    this.group = new THREE.Group();
    this.scene.add(this.group);
    this._tempGeos = [];
    this._dirty = false;

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas.parentElement);
  }

  resize() {
    const w = this.canvas.parentElement.clientWidth;
    const h = this.canvas.parentElement.clientHeight;
    if (w < 2 || h < 2) return;
    this.renderer.setSize(w, h, false);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  mat(color, opacity = 1) {
    this.materials = this.materials || new Map();
    const key = `${color}:${opacity}`;
    if (!this.materials.has(key)) {
      this.materials.set(key, new THREE.MeshLambertMaterial({
        color, transparent: opacity < 1, opacity,
      }));
    }
    return this.materials.get(key);
  }

  geo(g) { this._tempGeos.push(g); return g; }

  // Rebuild the whole scene from state + solved positions. Cheap at house scale.
  build(state, solved, visibleLayers) {
    this.group.clear();
    for (const g of this._tempGeos) g.dispose();
    this._tempGeos = [];
    const pos = (id) => solved.pos.get(id);
    const H = state.roomHeight || 2.6;

    const boxAt = (cx, cy, z0, w, h, d, rot, material) => {
      const m = new THREE.Mesh(this.geo(new THREE.BoxGeometry(w, h, d)), material);
      m.position.set(cx, z0 + h / 2, -cy);
      m.rotation.y = rot;
      this.group.add(m);
      return m;
    };

    let all = [];
    for (const wall of state.walls) {
      const pts = wall.pts.map(pos).filter(Boolean);
      const runs = wall.closed && pts.length >= 3 ? [...pts, pts[0]] : pts;
      for (let i = 0; i + 1 < runs.length; i++) {
        const a = runs[i], b = runs[i + 1];
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        if (len < 1e-6) continue;
        boxAt((a.x + b.x) / 2, (a.y + b.y) / 2, 0, len, H, WALL_T,
          Math.atan2(b.y - a.y, b.x - a.x), this.mat(WALL_COLOR, 0.96));
      }
      if (wall.closed && pts.length >= 3) {
        const shape = new THREE.Shape(pts.map((p) => new THREE.Vector2(p.x, p.y)));
        const floor = new THREE.Mesh(this.geo(new THREE.ShapeGeometry(shape)), this.mat(FLOOR_COLOR));
        floor.rotation.x = -Math.PI / 2; // shape (x, y) -> world (x, 0, -y)
        floor.position.y = 0.005;
        this.group.add(floor);
      }
      all = all.concat(pts);
    }
    for (const pt of state.points) {
      const p = pos(pt.id);
      if (p) all.push(p);
    }

    for (const it of state.items) {
      if (!visibleLayers.has(it.layer)) continue;
      boxAt(it.x, it.y, it.z0, it.w, it.h, it.d, it.rot, this.mat(categoryColor(it.category)));
      for (const c of itemCorners(it)) all.push(c);
    }

    // First build (or empty scene change): frame the content.
    if (!this._framed && all.length) {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const p of all) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      }
      const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
      const span = Math.max(maxX - minX, maxY - minY, 3);
      this.controls.target.set(cx, 0.8, -cy);
      this.camera.position.set(cx + span * 1.1, span * 1.15, -cy + span * 1.5);
      this.controls.update();
      this._framed = true;
    }

    this.requestRender();
  }

  refit() { this._framed = false; }

  requestRender() {
    if (this._dirty) return;
    this._dirty = true;
    requestAnimationFrame(() => {
      this._dirty = false;
      this.renderer.render(this.scene, this.camera);
    });
  }
}
