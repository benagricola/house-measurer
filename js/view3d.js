// Extruded 3D perspective view. Plan coords (x, y) map to world (x, 0, -y),
// so a plan rotation theta becomes rotation.y = theta and the room reads the
// same way round as the plan (plan north = away from the camera start pose).
//
// Dollhouse cutaway: any wall standing between the camera and the room
// interior fades to translucent (recomputed live while orbiting), so the
// inside is always visible. Windows/doors embedded in a faded wall fade
// with it; items that hang inside the room stay solid.

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
    this.controls.addEventListener('change', () => {
      this.updateOcclusion();
      this.requestRender();
    });

    this.group = new THREE.Group();
    this.scene.add(this.group);
    this._tempGeos = [];
    this._dirty = false;

    this.wallSolid = new THREE.MeshLambertMaterial({ color: WALL_COLOR });
    this.wallFaded = new THREE.MeshLambertMaterial({
      color: WALL_COLOR, transparent: true, opacity: 0.13, depthWrite: false,
    });
    this.fadedItemMats = new Map();
    this.wallRecs = [];  // { mesh, mid, n, key } - n points away from the room
    this.mountRecs = []; // { mesh, key, solidMat } - centred wall items

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

  fadedItemMat(color) {
    if (!this.fadedItemMats.has(color)) {
      this.fadedItemMats.set(color, new THREE.MeshLambertMaterial({
        color, transparent: true, opacity: 0.25, depthWrite: false,
      }));
    }
    return this.fadedItemMats.get(color);
  }

  geo(g) { this._tempGeos.push(g); return g; }

  // Rebuild the whole scene from state + solved positions. Cheap at house scale.
  build(state, solved, visibleLayers) {
    this.group.clear();
    for (const g of this._tempGeos) g.dispose();
    this._tempGeos = [];
    this.wallRecs = [];
    this.mountRecs = [];
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
      if (!pts.length) continue;
      // "Inside" for the fade test: the wall's own centroid. Exact for
      // closed rooms; a sensible stand-in for open runs.
      const cen = {
        x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
        y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
      };
      const runs = wall.closed && pts.length >= 3 ? [...pts, pts[0]] : pts;
      for (let i = 0; i + 1 < runs.length; i++) {
        const a = runs[i], b = runs[i + 1];
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        if (len < 1e-6) continue;
        const mesh = boxAt((a.x + b.x) / 2, (a.y + b.y) / 2, 0, len, H, WALL_T,
          Math.atan2(b.y - a.y, b.x - a.x), this.wallSolid);
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        let n = { x: -(b.y - a.y) / len, y: (b.x - a.x) / len };
        if ((cen.x - mid.x) * n.x + (cen.y - mid.y) * n.y > 0) n = { x: -n.x, y: -n.y };
        this.wallRecs.push({ mesh, mid, n, key: `${wall.id}:${i}` });
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
      const color = categoryColor(it.category);
      const mesh = boxAt(it.x, it.y, it.z0, it.w, it.h, it.d, it.rot, this.mat(color));
      // Windows/doors live inside the wall slab: fade them with their wall.
      if (it.mount && (it.category === 'window' || it.category === 'door')) {
        this.mountRecs.push({
          mesh, key: `${it.mount.wallId}:${it.mount.seg}`,
          solidMat: this.mat(color), fadedMat: this.fadedItemMat(color),
        });
      }
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

    this.updateOcclusion();
    this.requestRender();
  }

  // Fade every wall the camera is outside of - those are the ones standing
  // between the camera and the room interior. Runs on every orbit change.
  updateOcclusion() {
    const cam = { x: this.camera.position.x, y: -this.camera.position.z };
    const faded = new Set();
    for (const w of this.wallRecs) {
      const outside = (cam.x - w.mid.x) * w.n.x + (cam.y - w.mid.y) * w.n.y > 0.01;
      w.mesh.material = outside ? this.wallFaded : this.wallSolid;
      if (outside) faded.add(w.key);
    }
    for (const m of this.mountRecs) {
      m.mesh.material = faded.has(m.key) ? m.fadedMat : m.solidMat;
    }
    this.fadedKeys = faded;
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
