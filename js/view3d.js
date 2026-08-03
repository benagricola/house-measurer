// Extruded 3D perspective view. Plan coords (x, y) map to world (x, 0, -y),
// so a plan rotation theta becomes rotation.y = theta and the room reads the
// same way round as the plan.
//
// Rendering: PBR materials with procedural canvas textures (js/textures.js),
// a generated environment map, one soft shadow-casting sun, tone mapping.
// Walls are extruded shapes with real openings cut for mounted windows and
// doors. Dollhouse cutaway: walls between the camera and the room interior
// fade to translucent (recomputed while orbiting) and stop casting shadows.

import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { RoomEnvironment } from '../vendor/RoomEnvironment.js';
import { RoundedBoxGeometry } from '../vendor/RoundedBoxGeometry.js';
import { categoryColor } from './items.js';
import { itemCorners } from './geometry.js';
import {
  floorMaterial, wallMaterial, groundMaterial, plainMaterial, steelMaterial,
  glassMaterial, itemMaterials, doorSlabMaterial, frameMaterial,
} from './textures.js';

const WALL_T = 0.09; // rendered wall thickness, metres
const WALL_COLOR = 0xd9d2bf;

export class View3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.06;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    // Soft warm sky gradient + matching fog.
    const sky = document.createElement('canvas');
    sky.width = 2; sky.height = 256;
    const sctx = sky.getContext('2d');
    const grad = sctx.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, '#f4efe3');
    grad.addColorStop(0.6, '#eae4d4');
    grad.addColorStop(1, '#ded7c4');
    sctx.fillStyle = grad;
    sctx.fillRect(0, 0, 2, 256);
    const skyTex = new THREE.CanvasTexture(sky);
    skyTex.colorSpace = THREE.SRGBColorSpace;
    this.scene.background = skyTex;
    this.scene.fog = new THREE.Fog(0xe2dbc9, 26, 70);

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.05, 500);
    this.camera.position.set(4, 5, 7);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    this.scene.add(new THREE.HemisphereLight(0xfff6e6, 0x8f8674, 0.5));
    this.sun = new THREE.DirectionalLight(0xfff1dd, 2.6);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0003;
    this.sun.shadow.normalBias = 0.02;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
    const fill = new THREE.DirectionalLight(0xdfe8f5, 0.55);
    fill.position.set(-6, 7, 5);
    this.scene.add(fill);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = false;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.02;
    this.controls.addEventListener('change', () => {
      this.updateOcclusion();
      this.requestRender();
    });

    this.group = new THREE.Group();
    this.scene.add(this.group);
    this._tempGeos = [];
    this._dirty = false;

    this.wallFaded = new THREE.MeshLambertMaterial({
      color: WALL_COLOR, transparent: true, opacity: 0.12, depthWrite: false,
    });
    this.wallRecs = [];  // { mesh, mid, n, key } - n points away from the room
    this.mountRecs = []; // { meshes, key, faded } - window/door composites

    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(60, 48),
      groundMaterial()
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.012;
    ground.receiveShadow = true;
    this.scene.add(ground);

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

  geo(g) { this._tempGeos.push(g); return g; }

  shadowed(mesh, receive = true) {
    mesh.castShadow = true;
    mesh.receiveShadow = receive;
    return mesh;
  }

  // 4-sided tapered hood body: bottom rect (wb x db) to top rect (wt x dt).
  frustumGeometry(wb, db, wt, dt, h) {
    const b = [[-wb / 2, -db / 2], [wb / 2, -db / 2], [wb / 2, db / 2], [-wb / 2, db / 2]];
    const t = [[-wt / 2, -dt / 2], [wt / 2, -dt / 2], [wt / 2, dt / 2], [-wt / 2, dt / 2]];
    const pos = [];
    const quad = (a, bq, c, d) => pos.push(...a, ...bq, ...c, ...a, ...c, ...d);
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      // b runs CCW seen from above; wind so normals face outward.
      quad(
        [b[j][0], 0, b[j][1]], [b[i][0], 0, b[i][1]],
        [t[i][0], h, t[i][1]], [t[j][0], h, t[j][1]]
      );
    }
    quad([t[3][0], h, t[3][1]], [t[2][0], h, t[2][1]], [t[1][0], h, t[1][1]], [t[0][0], h, t[0][1]]);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    return g;
  }

  // --- item composites -----------------------------------------------------

  buildWindow(it) {
    const g = new THREE.Group();
    const t = 0.07, depth = Math.min(it.d, 0.13);
    const fm = frameMaterial();
    const bar = (w, h, d, x, y) => {
      const m = this.shadowed(new THREE.Mesh(this.geo(new THREE.BoxGeometry(w, h, d)), fm));
      m.position.set(x, y, 0);
      g.add(m);
      return m;
    };
    bar(it.w, t, depth, 0, it.h / 2 - t / 2);
    bar(it.w, t, depth, 0, -it.h / 2 + t / 2);
    bar(t, it.h - 2 * t, depth, -it.w / 2 + t / 2, 0);
    bar(t, it.h - 2 * t, depth, it.w / 2 - t / 2, 0);
    if (it.w > 0.85) bar(0.05, it.h - 2 * t, depth * 0.8, 0, 0);
    // sill sticking into the room
    bar(it.w + 0.08, 0.035, depth + 0.1, 0, -it.h / 2 - 0.017);
    const glass = new THREE.Mesh(
      this.geo(new THREE.PlaneGeometry(it.w - 2 * t, it.h - 2 * t)),
      glassMaterial()
    );
    g.add(glass);
    return g;
  }

  buildDoor(it) {
    const g = new THREE.Group();
    const slabT = Math.min(0.055, it.d);
    const color = categoryColor('door');
    const slab = this.shadowed(new THREE.Mesh(
      this.geo(new RoundedBoxGeometry(it.w - 0.04, it.h - 0.02, slabT, 2, 0.008)),
      [plainMaterial(color, 0.6), plainMaterial(color, 0.6), plainMaterial(color, 0.6),
       plainMaterial(color, 0.6), doorSlabMaterial(color), doorSlabMaterial(color)]
    ));
    slab.position.y = -0.01;
    g.add(slab);
    const knobGeo = this.geo(new THREE.SphereGeometry(0.032, 16, 12));
    for (const side of [1, -1]) {
      const knob = new THREE.Mesh(knobGeo, steelMaterial());
      knob.position.set(it.w / 2 - 0.09, -it.h / 2 + 1.02, side * (slabT / 2 + 0.025));
      g.add(knob);
    }
    return g;
  }

  buildHood(it) {
    const g = new THREE.Group();
    const steel = steelMaterial();
    const baseH = 0.06;
    const funnelH = it.h * 0.5;
    const chimneyH = it.h - baseH - funnelH;
    const base = this.shadowed(new THREE.Mesh(
      this.geo(new RoundedBoxGeometry(it.w, baseH, it.d, 2, 0.012)), steel
    ));
    base.position.y = -it.h / 2 + baseH / 2;
    g.add(base);
    const funnel = this.shadowed(new THREE.Mesh(
      this.geo(this.frustumGeometry(it.w * 0.96, it.d * 0.96, 0.26, 0.26, funnelH)), steel
    ));
    funnel.position.y = -it.h / 2 + baseH;
    g.add(funnel);
    const chimney = this.shadowed(new THREE.Mesh(
      this.geo(new THREE.BoxGeometry(0.24, chimneyH, 0.24)), steel
    ));
    chimney.position.y = it.h / 2 - chimneyH / 2;
    g.add(chimney);
    return g;
  }

  buildShelf(it) {
    const g = new THREE.Group();
    const board = this.shadowed(new THREE.Mesh(
      this.geo(new RoundedBoxGeometry(it.w, Math.max(it.h, 0.03), it.d, 2, 0.008)),
      itemMaterials({ ...it, category: 'shelf' })
    ));
    g.add(board);
    const bracketGeo = this.geo(new THREE.BoxGeometry(0.025, 0.09, it.d * 0.75));
    for (const fx of [-0.32, 0.32]) {
      const b = new THREE.Mesh(bracketGeo, plainMaterial(0x4a463e, 0.6, 0.3));
      b.position.set(it.w * fx, -Math.max(it.h, 0.03) / 2 - 0.045, -it.d * 0.08);
      g.add(b);
    }
    return g;
  }

  buildGenericItem(it) {
    const r = Math.min(0.018, it.w / 6, it.h / 6, it.d / 6);
    const mesh = this.shadowed(new THREE.Mesh(
      this.geo(new RoundedBoxGeometry(it.w, it.h, it.d, 2, r)),
      itemMaterials({ ...it, color: categoryColor(it.category) })
    ));
    return mesh;
  }

  buildItem(it) {
    if (it.category === 'window') return this.buildWindow(it);
    if (it.category === 'door') return this.buildDoor(it);
    if (it.category === 'extraction') return this.buildHood(it);
    if (it.category === 'shelf') return this.buildShelf(it);
    return this.buildGenericItem(it);
  }

  // --- scene build ---------------------------------------------------------

  build(state, solved, visibleLayers) {
    this.group.clear();
    for (const g of this._tempGeos) g.dispose();
    this._tempGeos = [];
    this.wallRecs = [];
    this.mountRecs = [];
    const pos = (id) => solved.pos.get(id);
    const H = state.roomHeight || 2.6;

    const items = state.items.filter((i) => visibleLayers.has(i.layer));

    // Openings to cut per wall segment: "wallId:segIndex" -> items.
    const openings = new Map();
    for (const it of items) {
      if (it.mount && (it.category === 'window' || it.category === 'door')) {
        const key = `${it.mount.wallId}:${it.mount.seg}`;
        if (!openings.has(key)) openings.set(key, []);
        openings.get(key).push(it);
      }
    }

    let all = [];
    for (const wall of state.walls) {
      const pts = wall.pts.map(pos).filter(Boolean);
      if (!pts.length) continue;
      const cen = {
        x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
        y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
      };
      const runs = wall.closed && pts.length >= 3 ? [...pts, pts[0]] : pts;
      for (let i = 0; i + 1 < runs.length; i++) {
        const a = runs[i], b = runs[i + 1];
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        if (len < 1e-6) continue;
        const dir = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
        const key = `${wall.id}:${i}`;

        // Wall face with real openings, extruded to thickness.
        const shape = new THREE.Shape([
          new THREE.Vector2(0, 0), new THREE.Vector2(len, 0),
          new THREE.Vector2(len, H), new THREE.Vector2(0, H),
        ]);
        for (const it of openings.get(key) || []) {
          const s = (it.x - a.x) * dir.x + (it.y - a.y) * dir.y;
          const x0 = Math.max(0.02, s - it.w / 2), x1 = Math.min(len - 0.02, s + it.w / 2);
          const y0 = Math.max(0, it.z0), y1 = Math.min(H - 0.02, it.z0 + it.h);
          if (x1 - x0 < 0.05 || y1 - y0 < 0.05) continue;
          const hole = new THREE.Path([
            new THREE.Vector2(x0, y0), new THREE.Vector2(x1, y0),
            new THREE.Vector2(x1, y1), new THREE.Vector2(x0, y1),
          ]);
          shape.holes.push(hole);
        }
        const geo = this.geo(new THREE.ExtrudeGeometry(shape, { depth: WALL_T, bevelEnabled: false }));
        const mesh = this.shadowed(new THREE.Mesh(geo, wallMaterial()));
        // Local +x runs along the wall, +z extrudes to the plan-right of
        // a -> b; shift by half the thickness to centre on the wall line.
        const rn = { x: dir.y, y: -dir.x };
        mesh.rotation.y = Math.atan2(dir.y, dir.x);
        mesh.position.set(a.x - rn.x * WALL_T / 2, 0, -(a.y - rn.y * WALL_T / 2));
        this.group.add(mesh);

        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        let n = { x: -dir.y, y: dir.x };
        if ((cen.x - mid.x) * n.x + (cen.y - mid.y) * n.y > 0) n = { x: -n.x, y: -n.y };
        // Only closed rooms get the cutaway - an open run has no inside to
        // reveal, and fading it just makes a half-drawn survey look empty.
        this.wallRecs.push({ mesh, mid, n, key, cuttable: wall.closed });

        // Skirting on the room side, skipped where a door opens.
        const hasDoor = (openings.get(key) || []).some((it) => it.category === 'door');
        if (!hasDoor && len > 0.3) {
          const skirt = new THREE.Mesh(
            this.geo(new THREE.BoxGeometry(len - 0.02, 0.09, 0.02)),
            plainMaterial(0xf0ece0, 0.55)
          );
          skirt.receiveShadow = true;
          const inn = { x: -n.x, y: -n.y };
          skirt.position.set(
            mid.x + inn.x * (WALL_T / 2 + 0.01), 0.045,
            -(mid.y + inn.y * (WALL_T / 2 + 0.01))
          );
          skirt.rotation.y = Math.atan2(dir.y, dir.x);
          this.group.add(skirt);
        }
      }
      if (wall.closed && pts.length >= 3) {
        const shape = new THREE.Shape(pts.map((p) => new THREE.Vector2(p.x, p.y)));
        const floor = new THREE.Mesh(this.geo(new THREE.ShapeGeometry(shape)), floorMaterial());
        floor.rotation.x = -Math.PI / 2;
        floor.position.y = 0.004;
        floor.receiveShadow = true;
        this.group.add(floor);
      }
      all = all.concat(pts);
    }
    for (const pt of state.points) {
      const p = pos(pt.id);
      if (p) all.push(p);
    }

    for (const it of items) {
      const obj = this.buildItem(it);
      obj.position.set(it.x, it.z0 + it.h / 2, -it.y);
      obj.rotation.y = it.rot;
      obj.traverse((m) => { if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });
      this.group.add(obj);
      if (it.mount && (it.category === 'window' || it.category === 'door')) {
        const meshes = [];
        obj.traverse((m) => { if (m.isMesh) meshes.push(m); });
        this.mountRecs.push({ meshes, key: `${it.mount.wallId}:${it.mount.seg}`, faded: false });
      }
      for (const c of itemCorners(it)) all.push(c);
    }

    // Frame content + aim the sun and its shadow volume at it.
    if (all.length) {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const p of all) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      }
      const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
      const span = Math.max(maxX - minX, maxY - minY, 3);
      this.sun.position.set(cx + span * 0.9, span * 1.6 + 3, -cy + span * 0.6);
      this.sun.target.position.set(cx, 0, -cy);
      const half = Math.max(5, span * 0.9);
      Object.assign(this.sun.shadow.camera, {
        left: -half, right: half, top: half, bottom: -half, near: 1, far: span * 5 + 20,
      });
      this.sun.shadow.camera.updateProjectionMatrix();

      if (!this._framed) {
        this.controls.target.set(cx, 0.8, -cy);
        this.camera.position.set(cx + span * 1.1, span * 1.15, -cy + span * 1.5);
        this.controls.update();
        this._framed = true;
      }
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
      const outside = w.cuttable &&
        (cam.x - w.mid.x) * w.n.x + (cam.y - w.mid.y) * w.n.y > 0.01;
      if (outside) {
        if (!w.mesh.userData.solidMat) w.mesh.userData.solidMat = w.mesh.material;
        w.mesh.material = this.wallFaded;
        w.mesh.castShadow = false;
        faded.add(w.key);
      } else if (w.mesh.userData.solidMat) {
        w.mesh.material = w.mesh.userData.solidMat;
        w.mesh.castShadow = true;
      }
    }
    // Windows/doors vanish with their wall - a translucent ghost frame
    // floating near the camera reads as clutter, not context.
    for (const rec of this.mountRecs) {
      const fade = faded.has(rec.key);
      if (fade === rec.faded) continue;
      rec.faded = fade;
      for (const m of rec.meshes) m.visible = !fade;
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
