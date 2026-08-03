// Procedural materials for the 3D view - everything is drawn onto canvases
// at runtime (seeded, deterministic), so the app stays asset-free and
// offline. Materials are cached; call sites treat this as a material store.

import * as THREE from 'three';

// Deterministic PRNG so textures look identical every load.
function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function makeTex(size, draw, seed = 1) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  draw(ctx, size, lcg(seed));
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

const cache = new Map();
function memo(key, make) {
  if (!cache.has(key)) cache.set(key, make());
  return cache.get(key);
}

const css = (color) => '#' + color.toString(16).padStart(6, '0');

// --- surface drawers -------------------------------------------------------

function drawPlanks(ctx, S, rand) {
  const planks = 6, ph = S / planks;
  for (let i = 0; i < planks; i++) {
    const L = 34 + rand() * 12;
    ctx.fillStyle = `hsl(30, ${36 + rand() * 10}%, ${L}%)`;
    ctx.fillRect(0, i * ph, S, ph);
    for (let g = 0; g < 34; g++) {
      ctx.strokeStyle = `hsla(26, 42%, ${L - 10 - rand() * 12}%, ${0.06 + rand() * 0.1})`;
      ctx.lineWidth = 0.8 + rand() * 1.6;
      ctx.beginPath();
      const y0 = i * ph + rand() * ph;
      ctx.moveTo(0, y0);
      for (let x = 0; x <= S; x += 28) {
        ctx.lineTo(x, y0 + Math.sin(x * 0.012 + g * 1.7) * 2.2 + (rand() - 0.5) * 2);
      }
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(46, 28, 14, 0.6)';
    ctx.fillRect(0, i * ph - 1, S, 2);
    ctx.fillRect(rand() * S, i * ph + 1, 2, ph - 2);
  }
}

function drawPlaster(ctx, S, rand) {
  ctx.fillStyle = '#ebe5d6';
  ctx.fillRect(0, 0, S, S);
  for (let i = 0; i < 7; i++) {
    const x = rand() * S, y = rand() * S;
    const g = ctx.createRadialGradient(x, y, 0, x, y, 80 + rand() * 130);
    g.addColorStop(0, `rgba(${rand() > 0.5 ? '125,115,95' : '255,252,240'}, 0.025)`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
  }
  for (let i = 0; i < 1600; i++) {
    const v = rand();
    ctx.fillStyle = v > 0.5 ? `rgba(90,80,60,${0.02 + rand() * 0.04})` : `rgba(255,255,250,${0.02 + rand() * 0.05})`;
    ctx.fillRect(rand() * S, rand() * S, 1 + rand() * 2, 1 + rand() * 2);
  }
}

function drawButcher(ctx, S, rand) {
  const strips = 9, sw = S / strips;
  for (let i = 0; i < strips; i++) {
    const L = 40 + rand() * 16;
    ctx.fillStyle = `hsl(33, ${44 + rand() * 12}%, ${L}%)`;
    ctx.fillRect(i * sw, 0, sw, S);
    for (let g = 0; g < 16; g++) {
      ctx.strokeStyle = `hsla(28, 45%, ${L - 12}%, ${0.08 + rand() * 0.1})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      const x0 = i * sw + rand() * sw;
      ctx.moveTo(x0, 0);
      for (let y = 0; y <= S; y += 32) ctx.lineTo(x0 + (rand() - 0.5) * 3, y);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(50, 32, 16, 0.5)';
    ctx.fillRect(i * sw - 1, 0, 2, S);
  }
}

function drawSteel(ctx, S, rand) {
  const g = ctx.createLinearGradient(0, 0, S, 0);
  g.addColorStop(0, '#c7cacd');
  g.addColorStop(0.5, '#dadde0');
  g.addColorStop(1, '#c2c5c9');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  for (let i = 0; i < 300; i++) {
    ctx.fillStyle = `rgba(${rand() > 0.5 ? '255,255,255' : '110,115,120'}, ${0.02 + rand() * 0.05})`;
    ctx.fillRect(rand() * S, 0, 1, S);
  }
}

// Recessed rectangle with fake routed edges (light top/left, dark bottom/right).
function inset(ctx, x, y, w, h, strength = 0.35) {
  ctx.strokeStyle = `rgba(0,0,0,${strength})`;
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, w, h);
  ctx.strokeStyle = `rgba(255,255,255,${strength * 0.8})`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x + w, y + 1);
  ctx.lineTo(x + 1, y + 1);
  ctx.lineTo(x + 1, y + h);
  ctx.stroke();
}

function drawCupboardDoors(ctx, S, rand, color, doors) {
  ctx.fillStyle = css(color);
  ctx.fillRect(0, 0, S, S);
  const dw = S / doors;
  for (let i = 0; i < doors; i++) {
    const x = i * dw;
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(x, 0, 2, S);
    inset(ctx, x + dw * 0.09, S * 0.06, dw * 0.82, S * 0.88, 0.3);
    // knob near the opening edge
    const kx = i % 2 === 0 ? x + dw * 0.85 : x + dw * 0.15;
    ctx.fillStyle = 'rgba(40,40,44,0.85)';
    ctx.beginPath();
    ctx.arc(kx, S * 0.14, S * 0.016, 0, 7);
    ctx.fill();
  }
  // grime/shading at the bottom
  const g = ctx.createLinearGradient(0, S * 0.8, 0, S);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.14)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
}

function drawFridgeFront(ctx, S) {
  drawSteel(ctx, S, lcg(7));
  const split = S * 0.62; // fridge above, freezer below
  ctx.fillStyle = 'rgba(60,63,66,0.7)';
  ctx.fillRect(0, split - 2, S, 4);
  inset(ctx, S * 0.03, S * 0.02, S * 0.94, split - S * 0.05, 0.22);
  inset(ctx, S * 0.03, split + S * 0.02, S * 0.94, S * 0.96 - split, 0.22);
  for (const [y0, y1] of [[S * 0.08, split - S * 0.08], [split + S * 0.06, S * 0.92]]) {
    ctx.fillStyle = '#9aa0a6';
    ctx.fillRect(S * 0.075, y0, S * 0.028, y1 - y0);
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillRect(S * 0.078, y0, S * 0.008, y1 - y0);
  }
}

function drawWasherFront(ctx, S) {
  ctx.fillStyle = '#eceff1';
  ctx.fillRect(0, 0, S, S);
  ctx.fillStyle = '#dde1e4';
  ctx.fillRect(0, 0, S, S * 0.16);
  for (let i = 0; i < 4; i++) {
    ctx.fillStyle = '#7a8288';
    ctx.beginPath();
    ctx.arc(S * (0.62 + i * 0.1), S * 0.08, S * 0.024, 0, 7);
    ctx.fill();
  }
  ctx.fillStyle = '#30363b';
  ctx.fillRect(S * 0.06, S * 0.05, S * 0.28, S * 0.06);
  // porthole
  const cx = S * 0.5, cy = S * 0.58, r = S * 0.27;
  ctx.fillStyle = '#b8bec2';
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.fill();
  ctx.fillStyle = '#1d2b36';
  ctx.beginPath(); ctx.arc(cx, cy, r * 0.72, 0, 7); ctx.fill();
  ctx.strokeStyle = 'rgba(180,220,240,0.5)';
  ctx.lineWidth = S * 0.02;
  ctx.beginPath(); ctx.arc(cx, cy, r * 0.5, -2.4, -1.1); ctx.stroke();
}

function drawOvenFront(ctx, S) {
  ctx.fillStyle = '#3a3d40';
  ctx.fillRect(0, 0, S, S);
  ctx.fillStyle = '#4a4e52';
  ctx.fillRect(0, 0, S, S * 0.18);
  for (let i = 0; i < 5; i++) {
    ctx.fillStyle = '#22262a';
    ctx.beginPath(); ctx.arc(S * (0.14 + i * 0.1), S * 0.09, S * 0.028, 0, 7); ctx.fill();
    ctx.fillStyle = '#888e94';
    ctx.fillRect(S * (0.14 + i * 0.1) - 1, S * 0.06, 2, S * 0.03);
  }
  // handle bar
  ctx.fillStyle = '#b9bfc4';
  ctx.fillRect(S * 0.06, S * 0.22, S * 0.88, S * 0.045);
  // glass
  ctx.fillStyle = '#101418';
  ctx.fillRect(S * 0.1, S * 0.34, S * 0.8, S * 0.5);
  const g = ctx.createLinearGradient(0, S * 0.34, S * 0.5, S * 0.84);
  g.addColorStop(0, 'rgba(255,255,255,0.14)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.02)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(S * 0.1, S * 0.34, S * 0.8, S * 0.5);
  inset(ctx, S * 0.1, S * 0.34, S * 0.8, S * 0.5, 0.5);
}

function drawHobTop(ctx, S) {
  ctx.fillStyle = '#17191c';
  ctx.fillRect(0, 0, S, S);
  ctx.strokeStyle = 'rgba(230,235,240,0.55)';
  ctx.lineWidth = 2;
  for (const [cx, cy, r] of [[0.3, 0.3, 0.16], [0.72, 0.3, 0.12], [0.3, 0.72, 0.12], [0.72, 0.72, 0.16]]) {
    ctx.beginPath(); ctx.arc(S * cx, S * cy, S * r, 0, 7); ctx.stroke();
    ctx.beginPath(); ctx.arc(S * cx, S * cy, S * r * 0.55, 0, 7); ctx.stroke();
  }
}

function drawRadiator(ctx, S) {
  const cols = 12, cw = S / cols;
  for (let i = 0; i < cols; i++) {
    const g = ctx.createLinearGradient(i * cw, 0, (i + 1) * cw, 0);
    g.addColorStop(0, '#c9c9c4');
    g.addColorStop(0.5, '#f2f2ee');
    g.addColorStop(1, '#c2c2bd');
    ctx.fillStyle = g;
    ctx.fillRect(i * cw, 0, cw, S);
  }
  ctx.fillStyle = 'rgba(120,120,115,0.5)';
  ctx.fillRect(0, 0, S, 3);
  ctx.fillRect(0, S - 3, S, 3);
}

function drawDoorSlab(ctx, S, rand, color) {
  ctx.fillStyle = css(color);
  ctx.fillRect(0, 0, S, S);
  const g = ctx.createLinearGradient(0, 0, S, 0);
  g.addColorStop(0, 'rgba(255,255,255,0.08)');
  g.addColorStop(1, 'rgba(0,0,0,0.1)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  inset(ctx, S * 0.14, S * 0.07, S * 0.72, S * 0.36, 0.4);
  inset(ctx, S * 0.14, S * 0.5, S * 0.72, S * 0.42, 0.4);
}

// --- public material store -------------------------------------------------

export function floorMaterial() {
  return memo('floor', () => {
    const tex = makeTex(512, drawPlanks, 11);
    tex.repeat.set(1 / 1.4, 1 / 1.4); // one tile = 1.4 m; ShapeGeometry UVs are metres
    return new THREE.MeshStandardMaterial({ map: tex, roughness: 0.65, metalness: 0, bumpMap: tex, bumpScale: 0.35 });
  });
}

export function wallMaterial() {
  return memo('wall', () => {
    const tex = makeTex(512, drawPlaster, 5);
    tex.repeat.set(1.6, 1);
    return new THREE.MeshStandardMaterial({ map: tex, roughness: 0.94, metalness: 0, bumpMap: tex, bumpScale: 0.12 });
  });
}

export function groundMaterial() {
  return memo('ground', () => new THREE.MeshStandardMaterial({ color: 0xd9d2c0, roughness: 1 }));
}

export function plainMaterial(color, roughness = 0.85, metalness = 0) {
  return memo(`plain:${color}:${roughness}:${metalness}`, () =>
    new THREE.MeshStandardMaterial({ color, roughness, metalness }));
}

export function steelMaterial() {
  return memo('steel', () => {
    const tex = makeTex(256, drawSteel, 3);
    return new THREE.MeshStandardMaterial({ map: tex, roughness: 0.38, metalness: 0.75 });
  });
}

export function glassMaterial() {
  return memo('glass', () => new THREE.MeshStandardMaterial({
    color: 0xa8c8d8, transparent: true, opacity: 0.3,
    roughness: 0.06, metalness: 0.6, envMapIntensity: 1.4,
    depthWrite: false, side: THREE.DoubleSide,
  }));
}

const faceTex = (key, drawer, seed) => memo(`tex:${key}`, () => {
  const t = makeTex(512, drawer, seed);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
});

function frontMat(key, drawer, { roughness = 0.5, metalness = 0.2 } = {}) {
  return memo(`front:${key}`, () => new THREE.MeshStandardMaterial({
    map: faceTex(key, drawer, 9), roughness, metalness,
  }));
}

// Six-material array for a box item: [+x, -x, +y(top), -y, +z(front), -z(back)].
function faces(side, top, front, back = front) {
  return [side, side, top, side, front, back];
}

// Guess the appliance face art from the item's name.
function applianceKind(name) {
  const n = (name || '').toLowerCase();
  if (/fridge|freezer/.test(n)) return 'fridge';
  if (/wash|dryer|dish/.test(n)) return 'washer';
  if (/oven|hob|cook|stove/.test(n)) return 'oven';
  return 'steel';
}

// Materials (single or six-array) for a plain box item of this category.
export function itemMaterials(item) {
  const { category, name, color } = item;
  if (category === 'appliance') {
    const kind = applianceKind(name);
    const steel = steelMaterial();
    if (kind === 'fridge') return faces(steel, steel, frontMat('fridge', drawFridgeFront, { roughness: 0.4, metalness: 0.55 }));
    if (kind === 'washer') return faces(plainMaterial(0xe6e9ea, 0.5), plainMaterial(0xe6e9ea, 0.5), frontMat('washer', drawWasherFront, { roughness: 0.45, metalness: 0.1 }));
    if (kind === 'oven') {
      return faces(
        plainMaterial(0x3a3d40, 0.5, 0.4),
        memo('hobtop', () => new THREE.MeshStandardMaterial({ map: faceTex('hob', drawHobTop, 2), roughness: 0.25, metalness: 0.3 })),
        frontMat('oven', drawOvenFront, { roughness: 0.4, metalness: 0.4 })
      );
    }
    return steel;
  }
  if (category === 'worktop') {
    const doors = Math.max(1, Math.round(item.w / 0.55));
    const front = memo(`wtfront:${doors}`, () => new THREE.MeshStandardMaterial({
      map: makeTex(512, (c, s, r) => drawCupboardDoors(c, s, r, 0xe8e2d2, doors), 13),
      roughness: 0.6,
    }));
    const top = memo('butcher', () => {
      const t = makeTex(512, drawButcher, 17);
      return new THREE.MeshStandardMaterial({ map: t, roughness: 0.5, bumpMap: t, bumpScale: 0.2 });
    });
    return faces(plainMaterial(0xe8e2d2, 0.6), top, front);
  }
  if (category === 'cupboard') {
    const doors = Math.max(1, Math.round(item.w / 0.5));
    const front = memo(`cbfront:${color}:${doors}`, () => new THREE.MeshStandardMaterial({
      map: makeTex(512, (c, s, r) => drawCupboardDoors(c, s, r, color, doors), 19),
      roughness: 0.55,
    }));
    return faces(plainMaterial(color, 0.55), plainMaterial(color, 0.55), front);
  }
  if (category === 'radiator') {
    const mat = memo('radiator', () => {
      const t = makeTex(256, drawRadiator, 23);
      return new THREE.MeshStandardMaterial({ map: t, roughness: 0.45, metalness: 0.25, bumpMap: t, bumpScale: 0.4 });
    });
    return faces(plainMaterial(0xd9d9d4, 0.5, 0.2), plainMaterial(0xd9d9d4, 0.5, 0.2), mat, mat);
  }
  if (category === 'shelf') {
    return memo('shelfwood', () => {
      const t = makeTex(256, drawButcher, 29);
      return new THREE.MeshStandardMaterial({ map: t, roughness: 0.55 });
    });
  }
  if (category === 'extraction') return steelMaterial();
  return plainMaterial(color, 0.75);
}

export function doorSlabMaterial(color) {
  return memo(`doorslab:${color}`, () => new THREE.MeshStandardMaterial({
    map: makeTex(512, (c, s, r) => drawDoorSlab(c, s, r, color), 31),
    roughness: 0.6,
  }));
}

export function frameMaterial() {
  return plainMaterial(0xf2efe6, 0.5);
}
