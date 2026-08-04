// Extruded 3D perspective view. Plan coords (x, y) map to world (x, 0, -y),
// so a plan rotation theta becomes rotation.y = theta and the room reads the
// same way round as the plan.
//
// Rendering: PBR materials with procedural canvas textures (js/textures.js),
// a generated environment map, one soft shadow-casting sun, tone mapping.
// Walls are extruded shapes with real openings cut for mounted windows and
// doors, each room using its own ceiling height. Dollhouse cutaway: walls
// of a closed room between the camera and its interior fade to translucent
// (open runs stay solid - nothing to reveal yet).
//
// Measuring works here too: main.js passes a survey viz (points, candidate
// ghosts, circles, rays); points and ghosts are tappable via raycast and
// labelled through a DOM overlay, so refs can be picked and points placed
// without leaving 3D.

import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { RoomEnvironment } from '../vendor/RoomEnvironment.js';
import { RoundedBoxGeometry } from '../vendor/RoundedBoxGeometry.js';
import { categoryColor, stairSteps } from './items.js';
import { itemCorners } from './geometry.js';
import {
  floorMaterial, wallMaterial, groundMaterial, plainMaterial, steelMaterial,
  glassMaterial, itemMaterials, doorSlabMaterial, frameMaterial, platformMaterials,
} from './textures.js';

const WALL_T = 0.09; // rendered wall thickness, metres
const WALL_COLOR = 0xd9d2bf;
const PIN = { anchor: 0x1f2a44, point: 0x0e7a6f, ref: 0xe8960c, ghost: 0x0e7a6f };

export class View3D {
  constructor(canvas, overlay, callbacks = {}) {
    this.canvas = canvas;
    this.overlay = overlay;
    this.cb = callbacks;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.06;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
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
    this.vizGroup = new THREE.Group();
    this.scene.add(this.vizGroup);
    this._tempGeos = [];
    this._dirty = false;
    this.labelPool = new Map();
    this.viz = null;

    this.wallFaded = new THREE.MeshLambertMaterial({
      color: WALL_COLOR, transparent: true, opacity: 0.12, depthWrite: false,
    });
    this.wallRecs = [];
    this.mountRecs = [];
    this.tapTargets = []; // { mesh, pointId? , ghostSide? }

    const ground = new THREE.Mesh(new THREE.CircleGeometry(60, 48), groundMaterial());
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.012;
    ground.receiveShadow = true;
    this.scene.add(ground);

    this.geoSphere = new THREE.SphereGeometry(1, 14, 10);
    this.geoCyl = new THREE.CylinderGeometry(1, 1, 1, 10);
    const pts = [];
    for (let i = 0; i <= 96; i++) {
      const a = (i / 96) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)));
    }
    this.geoCircleLine = new THREE.BufferGeometry().setFromPoints(pts);

    this.raycaster = new THREE.Raycaster();
    this.initTap();

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas.parentElement);
  }

  initTap() {
    let start = null;
    this.canvas.addEventListener('pointerdown', (e) => {
      start = { x: e.clientX, y: e.clientY, t: performance.now(), slop: e.pointerType === 'touch' ? 18 : 9 };
    });
    this.canvas.addEventListener('pointerup', (e) => {
      if (!start) return;
      const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y) > start.slop;
      const quick = performance.now() - start.t < 700;
      start = null;
      if (moved || !quick || !this.cb.onTap) return;
      const r = this.canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        -((e.clientY - r.top) / r.height) * 2 + 1
      );
      this.raycaster.setFromCamera(ndc, this.camera);
      const hits = this.raycaster.intersectObjects(this.tapTargets.map((t) => t.mesh), false);
      if (hits.length) {
        const rec = this.tapTargets.find((t) => t.mesh === hits[0].object);
        this.cb.onTap({ pointId: rec.pointId, ghostSide: rec.ghostSide, roomHeightWall: rec.roomHeightWall });
        return;
      }
      const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
      const at = new THREE.Vector3();
      if (this.raycaster.ray.intersectPlane(plane, at)) {
        this.cb.onTap({ world: { x: at.x, y: -at.z } });
      }
    });
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
    return this.shadowed(new THREE.Mesh(
      this.geo(new RoundedBoxGeometry(it.w, it.h, it.d, 2, r)),
      itemMaterials({ ...it, color: categoryColor(it.category) })
    ));
  }

  // Straight flight ascending along local +x: w = run, d = width, h = rise.
  buildStairs(it) {
    const g = new THREE.Group();
    const n = stairSteps(it.h);
    const going = it.w / n, riser = it.h / n;
    const wood = itemMaterials({ ...it, category: 'shelf' });
    for (let i = 0; i < n; i++) {
      const stepH = riser * (i + 1);
      const step = this.shadowed(new THREE.Mesh(
        this.geo(new THREE.BoxGeometry(going, stepH, it.d)), wood
      ));
      step.position.set(-it.w / 2 + going * (i + 0.5), stepH / 2 - it.h / 2, 0);
      g.add(step);
    }
    return g;
  }

  buildItem(it) {
    if (it.category === 'window') return this.buildWindow(it);
    if (it.category === 'door') return this.buildDoor(it);
    if (it.category === 'extraction') return this.buildHood(it);
    if (it.category === 'shelf') return this.buildShelf(it);
    if (it.category === 'stairs') return this.buildStairs(it);
    if (it.category === 'platform') {
      return this.shadowed(new THREE.Mesh(
        this.geo(new THREE.BoxGeometry(it.w, it.h, it.d)),
        platformMaterials(it.w, it.d)
      ));
    }
    return this.buildGenericItem(it);
  }

  // --- scene build ---------------------------------------------------------

  build(state, solved, visibleLayers, viz = null) {
    this.group.clear();
    this.vizGroup.clear();
    for (const g of this._tempGeos) g.dispose();
    this._tempGeos = [];
    this.wallRecs = [];
    this.mountRecs = [];
    this.tapTargets = [];
    this.viz = viz;
    const pos = (id) => solved.pos.get(id);
    const defaultH = state.roomHeight || 2.6;
    const floorRec = (fid) => (state.floors || []).find((f) => f.id === fid);
    const floorShown = (fid) => floorRec(fid)?.visible !== false;
    const elevOf = (fid) => floorRec(fid)?.elevation ?? 0;
    let maxElev = 0;

    const items = state.items.filter((i) => visibleLayers.has(i.layer) && floorShown(i.floor));

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
      if (!floorShown(wall.floor)) continue;
      const elev = elevOf(wall.floor);
      maxElev = Math.max(maxElev, elev);
      const pts = wall.pts.map(pos).filter(Boolean);
      if (pts.length < 2) continue;
      const H = wall.height || defaultH;
      const cen = {
        x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
        y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
      };
      const runIds = wall.closed && pts.length >= 3 ? [...wall.pts, wall.pts[0]] : wall.pts;
      const runs = wall.closed && pts.length >= 3 ? [...pts, pts[0]] : pts;
      for (let i = 0; i + 1 < runs.length; i++) {
        const a = runs[i], b = runs[i + 1];
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        if (len < 1e-6) continue;
        const dir = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
        const key = `${wall.id}:${i}`;
        const segKey = `${runIds[i]}:${runIds[i + 1]}`;
        const segT = wall.thick?.[segKey] ?? state.wallThickness ?? WALL_T;
        // Per-end heights: a sloped top edge when they differ (eaves walls,
        // attic ceilings). Default is the room height.
        const [sh1, sh2] = wall.segH?.[segKey] || [H, H];

        const shape = new THREE.Shape([
          new THREE.Vector2(0, 0), new THREE.Vector2(len, 0),
          new THREE.Vector2(len, sh2), new THREE.Vector2(0, sh1),
        ]);
        for (const it of openings.get(key) || []) {
          const s = (it.x - a.x) * dir.x + (it.y - a.y) * dir.y;
          const x0 = Math.max(0.02, s - it.w / 2), x1 = Math.min(len - 0.02, s + it.w / 2);
          const y0 = Math.max(0, it.z0), y1 = Math.min(Math.min(sh1, sh2) - 0.02, it.z0 + it.h);
          if (x1 - x0 < 0.05 || y1 - y0 < 0.05) continue;
          shape.holes.push(new THREE.Path([
            new THREE.Vector2(x0, y0), new THREE.Vector2(x1, y0),
            new THREE.Vector2(x1, y1), new THREE.Vector2(x0, y1),
          ]));
        }
        const geo = this.geo(new THREE.ExtrudeGeometry(shape, { depth: segT, bevelEnabled: false }));
        const mesh = this.shadowed(new THREE.Mesh(geo, wallMaterial()));
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        let n = { x: -dir.y, y: dir.x };
        if ((cen.x - mid.x) * n.x + (cen.y - mid.y) * n.y > 0) n = { x: -n.x, y: -n.y };
        // Laser readings hit the INNER surface, so the measured line IS the
        // internal face: the slab's thickness grows outward from it.
        const rn = { x: dir.y, y: -dir.x }; // extrusion direction (local +z)
        const off = rn.x * n.x + rn.y * n.y > 0 ? 0 : -segT;
        mesh.rotation.y = Math.atan2(dir.y, dir.x);
        mesh.position.set(a.x + rn.x * off, elev, -(a.y + rn.y * off));
        this.group.add(mesh);

        this.wallRecs.push({ mesh, mid, n, key, cuttable: wall.closed });

        const hasDoor = (openings.get(key) || []).some((it) => it.category === 'door');
        if (!hasDoor && len > 0.3) {
          const skirt = new THREE.Mesh(
            this.geo(new THREE.BoxGeometry(len - 0.02, 0.09, 0.02)),
            plainMaterial(0xf0ece0, 0.55)
          );
          skirt.receiveShadow = true;
          const inn = { x: -n.x, y: -n.y };
          skirt.position.set(
            mid.x + inn.x * 0.011, elev + 0.045,
            -(mid.y + inn.y * 0.011)
          );
          skirt.rotation.y = Math.atan2(dir.y, dir.x);
          this.group.add(skirt);
        }
      }
      if (wall.closed && pts.length >= 3) {
        const shape = new THREE.Shape(pts.map((p) => new THREE.Vector2(p.x, p.y)));
        const floor = new THREE.Mesh(this.geo(new THREE.ShapeGeometry(shape)), floorMaterial());
        floor.rotation.x = -Math.PI / 2;
        floor.position.y = elev + 0.004;
        floor.receiveShadow = true;
        this.group.add(floor);
        // Upper rooms get a visible floor build-up (the joist/void zone).
        if (elev > 0.05) {
          const slab = new THREE.Mesh(
            this.geo(new THREE.ExtrudeGeometry(shape, { depth: 0.22, bevelEnabled: false })),
            plainMaterial(0xe6e0d0, 0.9)
          );
          slab.rotation.x = -Math.PI / 2;
          slab.position.y = elev - 0.22;
          slab.castShadow = true;
          this.group.add(slab);
        }
      }
      all = all.concat(pts);
    }
    for (const pt of state.points) {
      const p = pos(pt.id);
      if (p) all.push(p);
    }

    for (const it of items) {
      const obj = this.buildItem(it);
      obj.position.set(it.x, elevOf(it.floor) + it.z0 + it.h / 2, -it.y);
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

    this.buildViz(viz);

    if (all.length) {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const p of all) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      }
      const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
      const span = Math.max(maxX - minX, maxY - minY, 3);
      this.sun.position.set(cx + span * 0.9, span * 1.6 + 3 + maxElev, -cy + span * 0.6);
      this.sun.target.position.set(cx, 0, -cy);
      const half = Math.max(5, span * 0.9 + maxElev * 0.5);
      Object.assign(this.sun.shadow.camera, {
        left: -half, right: half, top: half, bottom: -half, near: 1, far: span * 5 + 20 + maxElev * 4,
      });
      this.sun.shadow.camera.updateProjectionMatrix();

      if (!this._framed) {
        // Wide enough that the corner pins on top of the walls stay
        // on-screen (and tappable) at the default pose.
        this.controls.target.set(cx, 0.9 + maxElev * 0.5, -cy);
        this.camera.position.set(
          cx + span * 1.3, span * 1.35 + maxElev * 0.9, -cy + span * 1.75 + maxElev * 0.4
        );
        this.controls.update();
        this._framed = true;
      }
    }

    this.updateOcclusion();
    this.requestRender();
  }

  // Survey overlay: pins for points, pillars for candidates, floor circles
  // and rays for the live preview. All tappable bits register tapTargets.
  buildViz(viz) {
    if (!viz) return;
    for (const p of viz.points || []) {
      const e = p.e || 0;
      const color = p.ref != null ? PIN.ref : PIN[p.style] || PIN.point;
      const post = new THREE.Mesh(this.geoCyl, plainMaterial(color, 0.55));
      post.scale.set(0.011, 0.42, 0.011);
      post.position.set(p.x, e + 0.21, -p.y);
      this.vizGroup.add(post);
      const head = new THREE.Mesh(this.geoSphere, plainMaterial(color, 0.45));
      const r = p.ref != null || p.isLast ? 0.055 : 0.042;
      head.scale.set(r, r, r);
      head.position.set(p.x, e + 0.44, -p.y);
      this.vizGroup.add(head);
      // generous invisible hit bubble
      const hit = new THREE.Mesh(this.geoSphere, new THREE.MeshBasicMaterial({ visible: true, transparent: true, opacity: 0 }));
      hit.scale.set(0.16, 0.3, 0.16);
      hit.position.set(p.x, e + 0.3, -p.y);
      this.vizGroup.add(hit);
      this.tapTargets.push({ mesh: hit, pointId: p.id });
    }
    for (const g of viz.ghosts || []) {
      const e = g.e || 0;
      const pillar = new THREE.Mesh(this.geoCyl, new THREE.MeshLambertMaterial({
        color: PIN.ghost, transparent: true, opacity: g.primary ? 0.45 : 0.16, depthWrite: false,
      }));
      pillar.scale.set(0.06, 1.1, 0.06);
      pillar.position.set(g.x, e + 0.55, -g.y);
      this.vizGroup.add(pillar);
      const hit = new THREE.Mesh(this.geoSphere, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0 }));
      hit.scale.set(0.2, 0.7, 0.2);
      hit.position.set(g.x, e + 0.55, -g.y);
      this.vizGroup.add(hit);
      this.tapTargets.push({ mesh: hit, ghostSide: g.side });
    }
    for (const c of viz.circles || []) {
      const line = new THREE.LineLoop(this.geoCircleLine, new THREE.LineBasicMaterial({ color: 0xa39d8c }));
      line.scale.set(c.r, 1, c.r);
      line.position.set(c.cx, (c.e || 0) + 0.02, -c.cy);
      this.vizGroup.add(line);
    }
    // Room-height dimension markers: floor-to-ceiling rule at the room's
    // first corner; tap to edit the ceiling height.
    for (const hm of viz.heights || []) {
      const mat = plainMaterial(0x6a6456, 0.6, 0);
      const rule = new THREE.Mesh(this.geoCyl, mat);
      rule.scale.set(0.008, hm.h, 0.008);
      rule.position.set(hm.x, hm.e + hm.h / 2, -hm.y);
      this.vizGroup.add(rule);
      for (const ty of [hm.e + 0.005, hm.e + hm.h]) {
        const tick = new THREE.Mesh(this.geoCyl, mat);
        tick.scale.set(0.006, 0.14, 0.006);
        tick.rotation.z = Math.PI / 2;
        tick.position.set(hm.x, ty, -hm.y);
        this.vizGroup.add(tick);
      }
      const hit = new THREE.Mesh(this.geoCyl, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0 }));
      hit.scale.set(0.14, hm.h * 0.8, 0.14);
      hit.position.set(hm.x, hm.e + hm.h / 2, -hm.y);
      this.vizGroup.add(hit);
      this.tapTargets.push({ mesh: hit, roomHeightWall: hm.wallId });
    }
    for (const s of viz.rays || []) {
      const e = (s.e || 0) + 0.02;
      const geo = this.geo(new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(s.x1, e, -s.y1), new THREE.Vector3(s.x2, e, -s.y2),
      ]));
      this.vizGroup.add(new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xa39d8c })));
    }
  }

  updateLabels() {
    const labels = this.viz?.labels || [];
    const seen = new Set();
    const v = new THREE.Vector3();
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    for (const l of labels) {
      seen.add(l.key);
      let el = this.labelPool.get(l.key);
      if (!el) {
        el = document.createElement('div');
        this.overlay.appendChild(el);
        this.labelPool.set(l.key, el);
      }
      el.className = 'lbl ' + (l.cls || '');
      el.textContent = l.text;
      v.set(l.x, l.z ?? 0.55, -l.y).project(this.camera);
      const sx = (v.x + 1) / 2 * w, sy = (1 - v.y) / 2 * h;
      const off = v.z > 1 || sx < -40 || sx > w + 40 || sy < -20 || sy > h + 20;
      el.style.display = off ? 'none' : '';
      el.style.transform = `translate(-50%, -50%) translate(${Math.round(sx)}px, ${Math.round(sy - 16)}px)`;
    }
    for (const [key, el] of this.labelPool) {
      if (!seen.has(key)) { el.remove(); this.labelPool.delete(key); }
    }
  }

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
      this.updateLabels();
    });
  }
}
