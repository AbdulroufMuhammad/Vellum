/**
 * Vellum soft-body toolkit: squishy, grabbable, cuttable objects (jelly, fruit, pudding, cake, cheese, dough)
 * in the browser, no dependencies. Describe the shape as a signed-distance function; the toolkit builds a
 * tetrahedral simulation mesh, a smooth render surface, runs the physics, and cuts the object in two with a
 * plane, leaving real flat cut faces and two pieces that fall apart.
 *
 * The physics core (co-rotational tetrahedral elasticity + volume constraints under XPBD, grabbing, floor
 * friction, edge damping) is adapted from a hand-built jelly-knife demo; the shape generation, plane cutting,
 * render embedding and Babylon.js glue are new.
 *
 *   import { sd, SoftObject, attachBabylon } from "<this file>";
 *   const obj = new SoftObject({ sdf: sd.ellipsoid(0, 0.9, 0, 0.8, 0.9, 0.8), bounds: { min: [-1, 0, -1], max: [1, 2, 1] }, cell: 0.1 });
 *   const world = attachBabylon(BABYLON, scene, camera, canvas, obj, { material });
 *   engine.runRenderLoop(() => { world.update(engine.getDeltaTime()); scene.render(); });
 *
 * Scale: model the object about 1 to 2 units across (not real centimetres); the physics is tuned for that size.
 */

// ───────────────────────────── signed-distance helpers ─────────────────────────────
// Each helper returns a function (x, y, z) -> distance (negative inside). Combine them to describe any shape.
const len3 = (x, y, z) => Math.sqrt(x * x + y * y + z * z);
export const sd = {
  sphere: (cx, cy, cz, r) => (x, y, z) => len3(x - cx, y - cy, z - cz) - r,
  /** Approximate ellipsoid: exact on the axes, good enough elsewhere. */
  ellipsoid: (cx, cy, cz, rx, ry, rz) => {
    const m = Math.min(rx, ry, rz);
    return (x, y, z) => (len3((x - cx) / rx, (y - cy) / ry, (z - cz) / rz) - 1) * m;
  },
  /** Box with half-sizes hx, hy, hz and optional corner rounding. */
  box: (cx, cy, cz, hx, hy, hz, round = 0) => (x, y, z) => {
    const qx = Math.abs(x - cx) - hx + round, qy = Math.abs(y - cy) - hy + round, qz = Math.abs(z - cz) - hz + round;
    return len3(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0) - round;
  },
  capsule: (ax, ay, az, bx, by, bz, r) => (x, y, z) => {
    const pax = x - ax, pay = y - ay, paz = z - az, bax = bx - ax, bay = by - ay, baz = bz - az;
    const h = Math.min(1, Math.max(0, (pax * bax + pay * bay + paz * baz) / (bax * bax + bay * bay + baz * baz)));
    return len3(pax - bax * h, pay - bay * h, paz - baz * h) - r;
  },
  /** Torus lying flat (axis Y): ring radius R, tube radius r. */
  torus: (cx, cy, cz, R, r) => (x, y, z) => {
    const qx = Math.hypot(x - cx, z - cz) - R, qy = y - cy;
    return Math.hypot(qx, qy) - r;
  },
  /** Half-space: keeps what is below the plane through (px,py,pz) with outward normal (nx,ny,nz). */
  halfspace: (px, py, pz, nx, ny, nz) => {
    const l = len3(nx, ny, nz);
    return (x, y, z) => ((x - px) * nx + (y - py) * ny + (z - pz) * nz) / l;
  },
  union: (...f) => (x, y, z) => { let d = Infinity; for (const g of f) d = Math.min(d, g(x, y, z)); return d; },
  intersect: (...f) => (x, y, z) => { let d = -Infinity; for (const g of f) d = Math.max(d, g(x, y, z)); return d; },
  subtract: (a, b) => (x, y, z) => Math.max(a(x, y, z), -b(x, y, z)),
  /** Smooth union: blends shapes together like clay (k about 0.1 to 0.3). */
  smoothUnion: (k, ...f) => (x, y, z) => {
    let d = f[0](x, y, z);
    for (let i = 1; i < f.length; i++) {
      const e = f[i](x, y, z), h = Math.max(k - Math.abs(d - e), 0) / k;
      d = Math.min(d, e) - h * h * k * 0.25;
    }
    return d;
  },
  /** Squash/stretch a shape by (sx, sy, sz) about the origin. */
  scale: (f, sx, sy, sz) => { const m = Math.min(sx, sy, sz); return (x, y, z) => f(x / sx, y / sy, z / sz) * m; },
};

function gradient(sdf, x, y, z, h) {
  return [(sdf(x + h, y, z) - sdf(x - h, y, z)) / (2 * h), (sdf(x, y + h, z) - sdf(x, y - h, z)) / (2 * h), (sdf(x, y, z + h) - sdf(x, y, z - h)) / (2 * h)];
}

/** Move a point onto the zero set of the SDF (a few Newton steps along the gradient). */
function projectToSurface(sdf, p, h, steps = 4) {
  for (let s = 0; s < steps; s++) {
    const d = sdf(p[0], p[1], p[2]);
    if (Math.abs(d) < h * 0.01) break;
    const g = gradient(sdf, p[0], p[1], p[2], h * 0.5), gl = g[0] * g[0] + g[1] * g[1] + g[2] * g[2] || 1;
    p[0] -= (d * g[0]) / gl; p[1] -= (d * g[1]) / gl; p[2] -= (d * g[2]) / gl;
  }
  return p;
}

// ───────────────────────────── meshing ─────────────────────────────
/** Union-find over tets: connected components of a tet mesh (pieces). */
export function connectedComponents(nVerts, tets) {
  const parent = new Int32Array(nVerts).map((_, i) => i);
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  for (let t = 0; t < tets.length; t += 4) for (let k = 1; k < 4; k++) { const a = find(tets[t]), b = find(tets[t + k]); if (a !== b) parent[a] = b; }
  const map = new Map(); const comp = new Uint16Array(nVerts);
  for (let i = 0; i < nVerts; i++) { const r = find(i); if (!map.has(r)) map.set(r, map.size); comp[i] = map.get(r); }
  return { comp, count: map.size };
}

function tetVolume(p, a, b, c, d) {
  const bx = p[3 * b] - p[3 * a], by = p[3 * b + 1] - p[3 * a + 1], bz = p[3 * b + 2] - p[3 * a + 2];
  const cx = p[3 * c] - p[3 * a], cy = p[3 * c + 1] - p[3 * a + 1], cz = p[3 * c + 2] - p[3 * a + 2];
  const dx = p[3 * d] - p[3 * a], dy = p[3 * d + 1] - p[3 * a + 1], dz = p[3 * d + 2] - p[3 * a + 2];
  return (bx * (cy * dz - cz * dy) - by * (cx * dz - cz * dx) + bz * (cx * dy - cy * dx)) / 6;
}

/**
 * Tetrahedral simulation mesh of the region where sdf < 0, on a body-centred-cubic lattice (the symmetric one:
 * a grid of cubes plus a vertex at every cube centre, four tets around every face shared by two neighbouring
 * cubes). A plain cube-split mesh leans one way along its diagonal and makes soft bodies drift sideways.
 * Boundary vertices are pulled onto the surface, and the tets are shuffled (a fixed shuffle) so the solver's
 * sweep has no direction either.
 */
export function tetMeshFromSDF(sdf, bounds, cell) {
  const h = cell * 1.2;   // cube size: BCC edges are 0.87h and h, so this keeps the tet size close to `cell`
  // the lattice is centred on the bounds, so the mesh is as symmetric about the object as the shape itself is
  const dim = (a) => Math.ceil((bounds.max[a] - bounds.min[a]) / h) + 2;
  const nx = dim(0), ny = dim(1), nz = dim(2);
  const x0 = (bounds.min[0] + bounds.max[0]) / 2 - (nx * h) / 2, y0 = (bounds.min[1] + bounds.max[1]) / 2 - (ny * h) / 2, z0 = (bounds.min[2] + bounds.max[2]) / 2 - (nz * h) / 2;
  const used = new Map(); const rest = []; const tets = [];
  const cornerKey = (i, j, k) => (i * (ny + 2) + j) * (nz + 2) + k;
  const centerKey = (i, j, k) => 1e9 + (i * ny + j) * nz + k;
  const vert = (key, x, y, z) => {
    let v = used.get(key);
    if (v === undefined) { v = rest.length / 3; used.set(key, v); rest.push(x, y, z); }
    return v;
  };
  const corner = (i, j, k) => vert(cornerKey(i, j, k), x0 + i * h, y0 + j * h, z0 + k * h);
  const center = (i, j, k) => vert(centerKey(i, j, k), x0 + (i + 0.5) * h, y0 + (j + 0.5) * h, z0 + (k + 0.5) * h);
  const cen = (i, j, k) => [x0 + (i + 0.5) * h, y0 + (j + 0.5) * h, z0 + (k + 0.5) * h];
  // four tets around the face shared by cells A and B; `ring` lists that face's four corners in order
  const pair = (a, b, ring) => {
    for (let m = 0; m < 4; m++) {
      const c1 = ring[m], c2 = ring[(m + 1) % 4];
      const pts = [a, b, c1, c2].map((q) => (q.cell ? cen(...q.cell) : [x0 + q.c[0] * h, y0 + q.c[1] * h, z0 + q.c[2] * h]));
      const mid = [0, 1, 2].map((d) => (pts[0][d] + pts[1][d] + pts[2][d] + pts[3][d]) / 4);
      if (sdf(mid[0], mid[1], mid[2]) >= 0) continue;
      tets.push(...[a, b, c1, c2].map((q) => (q.cell ? center(...q.cell) : corner(...q.c))));
    }
  };
  const C = (i, j, k) => ({ cell: [i, j, k] }), K = (i, j, k) => ({ c: [i, j, k] });
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) for (let k = 0; k < nz; k++) {
    const c = cen(i, j, k);
    if (sdf(c[0], c[1], c[2]) > h * 1.5) continue;
    if (i + 1 < nx) pair(C(i, j, k), C(i + 1, j, k), [K(i + 1, j, k), K(i + 1, j + 1, k), K(i + 1, j + 1, k + 1), K(i + 1, j, k + 1)]);
    if (j + 1 < ny) pair(C(i, j, k), C(i, j + 1, k), [K(i, j + 1, k), K(i, j + 1, k + 1), K(i + 1, j + 1, k + 1), K(i + 1, j + 1, k)]);
    if (k + 1 < nz) pair(C(i, j, k), C(i, j, k + 1), [K(i, j, k + 1), K(i + 1, j, k + 1), K(i + 1, j + 1, k + 1), K(i, j + 1, k + 1)]);
  }
  const r = Float32Array.from(rest);
  // boundary vertices that ended up outside the shape are pulled onto its surface
  for (let v = 0; v < r.length / 3; v++) {
    const d = sdf(r[3 * v], r[3 * v + 1], r[3 * v + 2]);
    if (d > 0) { const p = projectToSurface(sdf, [r[3 * v], r[3 * v + 1], r[3 * v + 2]], cell); r[3 * v] = p[0]; r[3 * v + 1] = p[1]; r[3 * v + 2] = p[2]; }
  }
  // orient every tet positively and drop slivers the projection flattened
  const good = [];
  const ref = (h * h * h) / 12;
  for (let t = 0; t < tets.length; t += 4) {
    let [a, b, c, d] = [tets[t], tets[t + 1], tets[t + 2], tets[t + 3]];
    let v = tetVolume(r, a, b, c, d);
    if (v < 0) { [c, d] = [d, c]; v = -v; }
    if (v > ref * 0.06) good.push([a, b, c, d]);
  }
  // fixed shuffle (the same mesh every time)
  let seed = 12345;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = good.length - 1; i > 0; i--) { const k = Math.floor(rnd() * (i + 1)); [good[i], good[k]] = [good[k], good[i]]; }
  // compact vertex numbering (some vertices lost all their tets)
  const remap = new Int32Array(r.length / 3).fill(-1); const outRest = [];
  const outTets = new Uint32Array(good.length * 4);
  good.forEach((q, n) => q.forEach((v, k) => {
    if (remap[v] < 0) { remap[v] = outRest.length / 3; outRest.push(r[3 * v], r[3 * v + 1], r[3 * v + 2]); }
    outTets[4 * n + k] = remap[v];
  }));
  return { rest: Float32Array.from(outRest), tets: outTets };
}

/** Smooth render surface of sdf = 0 (naive surface nets): { positions, indices } with shared, smoothly shaded vertices. */
export function surfaceMeshFromSDF(sdf, bounds, cell) {
  const [x0, y0, z0] = bounds.min, [x1, y1, z1] = bounds.max;
  const nx = Math.ceil((x1 - x0) / cell) + 1, ny = Math.ceil((y1 - y0) / cell) + 1, nz = Math.ceil((z1 - z0) / cell) + 1;
  const val = new Float32Array((nx + 1) * (ny + 1) * (nz + 1));
  const gi = (i, j, k) => (i * (ny + 1) + j) * (nz + 1) + k;
  for (let i = 0; i <= nx; i++) for (let j = 0; j <= ny; j++) for (let k = 0; k <= nz; k++) val[gi(i, j, k)] = sdf(x0 + i * cell, y0 + j * cell, z0 + k * cell);
  const cellVert = new Int32Array(nx * ny * nz).fill(-1);
  const ci = (i, j, k) => (i * ny + j) * nz + k;
  const positions = [];
  const corner = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) for (let k = 0; k < nz; k++) {
    const v = corner.map((c) => val[gi(i + c[0], j + c[1], k + c[2])]);
    let mask = 0; for (let q = 0; q < 8; q++) if (v[q] < 0) mask |= 1 << q;
    if (mask === 0 || mask === 255) continue;
    let sx = 0, sy = 0, sz = 0, n = 0;
    for (const [a, b] of edges) {
      if ((v[a] < 0) === (v[b] < 0)) continue;
      const t = v[a] / (v[a] - v[b]);
      sx += corner[a][0] + (corner[b][0] - corner[a][0]) * t; sy += corner[a][1] + (corner[b][1] - corner[a][1]) * t; sz += corner[a][2] + (corner[b][2] - corner[a][2]) * t; n++;
    }
    const p = [x0 + (i + sx / n) * cell, y0 + (j + sy / n) * cell, z0 + (k + sz / n) * cell];
    projectToSurface(sdf, p, cell, 2);
    cellVert[ci(i, j, k)] = positions.length / 3; positions.push(p[0], p[1], p[2]);
  }
  const indices = [];
  const quad = (a, b, c, d, flip) => { if (a < 0 || b < 0 || c < 0 || d < 0) return; if (flip) indices.push(a, c, b, a, d, c); else indices.push(a, b, c, a, c, d); };
  for (let i = 1; i < nx; i++) for (let j = 1; j < ny; j++) for (let k = 1; k < nz; k++) {
    const here = val[gi(i, j, k)] < 0;
    if (here !== (val[gi(i + 1, j, k)] < 0)) quad(cellVert[ci(i, j - 1, k - 1)], cellVert[ci(i, j, k - 1)], cellVert[ci(i, j, k)], cellVert[ci(i, j - 1, k)], here);
    if (here !== (val[gi(i, j + 1, k)] < 0)) quad(cellVert[ci(i - 1, j, k - 1)], cellVert[ci(i - 1, j, k)], cellVert[ci(i, j, k)], cellVert[ci(i, j, k - 1)], here);
    if (here !== (val[gi(i, j, k + 1)] < 0)) quad(cellVert[ci(i - 1, j - 1, k)], cellVert[ci(i, j - 1, k)], cellVert[ci(i, j, k)], cellVert[ci(i - 1, j, k)], here);
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}


// ───────────────────────────── soft-body physics (XPBD tetrahedral, co-rotational elasticity) ─────────────────────────────
export class SoftBody {
  constructor(mesh, opts = {}) {
    const { rest, tets, tetSoft } = mesh;
    this.subIndex = 0;
    this.comp = mesh.comp || new Uint16Array(rest.length / 3);
    this.nComp = mesh.nComp || 1;
    if (!mesh.comp) { const c = connectedComponents(rest.length / 3, tets); this.comp = c.comp; this.nComp = c.count; }
    this.n = rest.length / 3;
    this.nT = tets.length / 4;
    this.tets = tets;
    this.rest = Float32Array.from(rest);
    this.x = new Float32Array(rest.length);
    this.prev = new Float32Array(rest.length);
    this.v = new Float32Array(rest.length);
    this.invMass = new Float32Array(this.n);
    this.mass = new Float32Array(this.n);
    this.restVol = new Float32Array(this.nT);
    this.density = 1.0;

    // masses from rest volumes
    let vol = 0;
    for (let t = 0; t < this.nT; t++) {
      const v = this.tetVol(this.rest, t);
      this.restVol[t] = v; vol += v;
      for (let k = 0; k < 4; k++) this.mass[tets[4 * t + k]] += v * this.density / 4;
    }
    this.totalRestVolume = vol;
    this.totalMass = 0;
    for (let i = 0; i < this.n; i++) { this.invMass[i] = 1 / this.mass[i]; this.totalMass += this.mass[i]; }

    // unique edges
    const set = new Map();
    const pairs = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]];
    for (let t = 0; t < this.nT; t++) for (const [a, b] of pairs) {
      let i = tets[4 * t + a], j = tets[4 * t + b];
      if (i > j) [i, j] = [j, i];
      set.set(i * 65536 + j, [i, j]);
    }
    this.nE = set.size;
    this.edges = new Uint32Array(this.nE * 2);
    this.restLen = new Float32Array(this.nE);
    let e = 0;
    for (const [i, j] of set.values()) {
      this.edges[2 * e] = i; this.edges[2 * e + 1] = j;
      this.restLen[e] = Math.hypot(rest[3 * i] - rest[3 * j], rest[3 * i + 1] - rest[3 * j + 1], rest[3 * i + 2] - rest[3 * j + 2]);
      e++;
    }
    // shuffle edge order a little (reduces Gauss–Seidel directional bias)
    for (let k = this.nE - 1; k > 0; k--) {
      const r = (k * 2654435761) % (k + 1);
      for (const arr of [this.edges]) { const a0 = arr[2 * k], a1 = arr[2 * k + 1]; arr[2 * k] = arr[2 * r]; arr[2 * k + 1] = arr[2 * r + 1]; arr[2 * r] = a0; arr[2 * r + 1] = a1; }
      const tmp = this.restLen[k]; this.restLen[k] = this.restLen[r]; this.restLen[r] = tmp;
    }

    // co-rotational tet elasticity: rest shape, inverse rest matrix, warm-started rotation
    this.tetQ = new Float32Array(this.nT * 12);     // rest positions relative to tet centroid
    this.tetDmInv = new Float32Array(this.nT * 9);
    this.tetRot = new Float32Array(this.nT * 4);    // quaternion (x, y, z, w)
    this.tetFirm = new Float32Array(this.nT);
    for (let t = 0; t < this.nT; t++) {
      const id = [tets[4 * t], tets[4 * t + 1], tets[4 * t + 2], tets[4 * t + 3]];
      let cx = 0, cy = 0, cz = 0, M = 0;
      for (const v of id) { const mv = this.mass[v]; M += mv; cx += rest[3 * v] * mv; cy += rest[3 * v + 1] * mv; cz += rest[3 * v + 2] * mv; }
      cx /= M; cy /= M; cz /= M;
      for (let k = 0; k < 4; k++) {
        this.tetQ[12 * t + 3 * k] = rest[3 * id[k]] - cx;
        this.tetQ[12 * t + 3 * k + 1] = rest[3 * id[k] + 1] - cy;
        this.tetQ[12 * t + 3 * k + 2] = rest[3 * id[k] + 2] - cz;
      }
      // Dm columns: X1-X0, X2-X0, X3-X0 → store inverse row-major
      const m = [];
      for (let r = 0; r < 3; r++) for (let c = 1; c < 4; c++) m.push(rest[3 * id[c] + r] - rest[3 * id[0] + r]);
      const inv = inv3(m);
      this.tetDmInv.set(inv, 9 * t);
      this.tetRot[4 * t + 3] = 1;
      this.tetFirm[t] = tetSoft ? tetSoft[t] : 1.0;   // >1 softer, <1 stiffer than the body's firmness
    }

    // parameters (tuned in sim units: metres-ish, seconds)
    this.gravity = opts.gravity ?? -9.81;
    this.firmness = opts.firmness ?? 0.5;   // 0..1 UI value
    this.damping = opts.damping ?? 0.45;    // 0..1 UI value
    this.substeps = 10;
    this.stepDt = 1 / 60;
    this.friction = 0.55;
    this.floorY = 0;
    this.maxSpeed = 12;

    this.maxReach = opts.maxReach ?? 2.2;
    this.pressBand = opts.pressBand ?? 0.45;
    this.collideDist = opts.collideDist ?? 0.13;
    // grab state
    this.grabIdx = new Int32Array(this.n);
    this.grabW = new Float32Array(this.n);
    this.grabOff = new Float32Array(this.n * 3);
    this.grabN = 0;
    this.grabTarget = new Float32Array(3);
    this.grabRot = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    this.grabbing = false;

    this.time = 0;
    this.reset(0);
  }

  tetVol(p, t) {
    const T = this.tets;
    const a = T[4 * t], b = T[4 * t + 1], c = T[4 * t + 2], d = T[4 * t + 3];
    const ax = p[3 * a], ay = p[3 * a + 1], az = p[3 * a + 2];
    const b0 = p[3 * b] - ax, b1 = p[3 * b + 1] - ay, b2 = p[3 * b + 2] - az;
    const c0 = p[3 * c] - ax, c1 = p[3 * c + 1] - ay, c2 = p[3 * c + 2] - az;
    const d0 = p[3 * d] - ax, d1 = p[3 * d + 1] - ay, d2 = p[3 * d + 2] - az;
    return (b0 * (c1 * d2 - c2 * d1) - b1 * (c0 * d2 - c2 * d0) + b2 * (c0 * d1 - c1 * d0)) / 6;
  }

  reset(drop = 0.35) {
    for (let i = 0; i < this.n; i++) {
      this.x[3 * i] = this.rest[3 * i];
      this.x[3 * i + 1] = this.rest[3 * i + 1] + drop;
      this.x[3 * i + 2] = this.rest[3 * i + 2];
    }
    this.prev.set(this.x);
    this.v.fill(0);
    this.endGrab();
  }

  // stiffness mapping: firmness 0..1 → edge compliance (log scale)
  shapeCompliance() { return Math.exp(Math.log(3.0) + (Math.log(0.05) - Math.log(3.0)) * this.firmness); }
  volCompliance() { return 1e-4 * (1 - 0.7 * this.firmness); }
  // damping 0..1 → rate (1/s) of relative-velocity decay along edges
  dampRate() { return 2 + 40 * this.damping * this.damping; }

  nudge(strength = 1) {
    // small hop with a twist — every particle gets v = v_lin + ω × (x − c)
    const c = this.centroid();
    const vy = 2.2 * strength, wx = 2.4 * strength, wz = -1.5 * strength, wy = 1.2 * strength;
    for (let i = 0; i < this.n; i++) {
      const rx = this.x[3 * i] - c[0], ry = this.x[3 * i + 1] - c[1], rz = this.x[3 * i + 2] - c[2];
      this.v[3 * i] += wy * rz - wz * ry;
      this.v[3 * i + 1] += vy + wz * rx - wx * rz;
      this.v[3 * i + 2] += wx * ry - wy * rx;
    }
  }

  centroid() {
    let x = 0, y = 0, z = 0, m = 0;
    for (let i = 0; i < this.n; i++) {
      const w = this.mass[i]; m += w;
      x += this.x[3 * i] * w; y += this.x[3 * i + 1] * w; z += this.x[3 * i + 2] * w;
    }
    return [x / m, y / m, z / m];
  }

  // ── grabbing ──
  beginGrab(hit, radius = 0.4) {
    this.grabN = 0;
    let nearest = -1, nd = Infinity;
    for (let i = 0; i < this.n; i++) {
      const d = Math.hypot(this.x[3 * i] - hit[0], this.x[3 * i + 1] - hit[1], this.x[3 * i + 2] - hit[2]);
      if (d < nd) { nd = d; nearest = i; }
    }
    const cg = nearest >= 0 ? this.comp[nearest] : 0;   // only the piece that was touched
    for (let i = 0; i < this.n; i++) {
      if (this.comp[i] !== cg) continue;
      const dx = this.x[3 * i] - hit[0], dy = this.x[3 * i + 1] - hit[1], dz = this.x[3 * i + 2] - hit[2];
      const d = Math.hypot(dx, dy, dz);
      if (d < radius) {
        const f = 1 - d / radius;
        const k = this.grabN++;
        this.grabIdx[k] = i; this.grabW[k] = f * f * (3 - 2 * f);
        this.grabOff[3 * k] = dx; this.grabOff[3 * k + 1] = dy; this.grabOff[3 * k + 2] = dz;
      }
    }
    if (this.grabN === 0 && nearest >= 0) {
      this.grabIdx[0] = nearest; this.grabW[0] = 1;
      this.grabOff[0] = this.x[3 * nearest] - hit[0]; this.grabOff[1] = this.x[3 * nearest + 1] - hit[1]; this.grabOff[2] = this.x[3 * nearest + 2] - hit[2];
      this.grabN = 1;
    }
    this.grabTarget.set(hit);
    this.grabStart = Float32Array.from(hit);
    this.grabRot.set([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    this.grabbing = true;
  }
  moveGrab(target, rot) {
    this.grabTarget.set(target);
    // bounded reach: a strong stretch, never an unbounded one
    const dx = target[0] - this.grabStart[0], dy = target[1] - this.grabStart[1], dz = target[2] - this.grabStart[2];
    const d = Math.hypot(dx, dy, dz), maxReach = this.maxReach;
    if (d > maxReach) { const k = maxReach / d; this.grabTarget[0] = this.grabStart[0] + dx * k; this.grabTarget[1] = this.grabStart[1] + dy * k; this.grabTarget[2] = this.grabStart[2] + dz * k; }
    if (rot) this.grabRot.set(rot);
    // never drive the held patch into the floor: lift the whole patch instead of crushing it
    const R = this.grabRot;
    let lowest = Infinity;
    for (let k = 0; k < this.grabN; k++) lowest = Math.min(lowest, R[3] * this.grabOff[3 * k] + R[4] * this.grabOff[3 * k + 1] + R[5] * this.grabOff[3 * k + 2]);
    if (Number.isFinite(lowest)) this.grabTarget[1] = Math.max(this.grabTarget[1], this.floorY + 0.004 - lowest);
  }
  endGrab() { this.grabbing = false; this.grabN = 0; }

  // ── simulation ──
  step() {
    const sub = this.substeps;
    const dt = this.stepDt / sub;
    for (let s = 0; s < sub; s++) this.substep(dt);
    this.time += this.stepDt;
    // settling: once the jelly is nearly still, bleed off the last residual jitter
    if (!this.grabbing) {
      const ke = this.kineticEnergy() / this.totalMass; // ≈ ½ v²
      if (ke < 2e-3) {
        const f = Math.max(0.86, 1 - 0.14 * (1 - ke / 2e-3));
        for (let i = 0; i < this.v.length; i++) this.v[i] *= f;
      }
    }
    // safety: any non-finite value → reset gently
    for (let i = 0; i < this.x.length; i += 97) if (!Number.isFinite(this.x[i])) { this.reset(0.2); break; }
  }

  substep(dt) {
    const { x, prev, v, invMass, n } = this;
    const g = this.gravity * dt;
    // light air drag; while held, the hand steadies the slice a little more
    const air = Math.exp(-(this.grabbing ? 2.5 : 0.08) * dt);
    for (let i = 0; i < n; i++) {
      const k = 3 * i;
      v[k + 1] += g;
      v[k] *= air; v[k + 1] *= air; v[k + 2] *= air;
      prev[k] = x[k]; prev[k + 1] = x[k + 1]; prev[k + 2] = x[k + 2];
      x[k] += v[k] * dt; x[k + 1] += v[k + 1] * dt; x[k + 2] += v[k + 2] * dt;
    }
    if (this.grabbing) this.solveGrab(dt);
    this.solveTets(dt);
    this.solveVolumes(dt);
    if (this.nComp > 1 && (this.subIndex++ & 1) === 0) this.collidePieces();
    this.solveFloor();
    const inv = 1 / dt, vmax = this.maxSpeed;
    for (let i = 0; i < 3 * n; i += 3) {
      let vx = (x[i] - prev[i]) * inv, vy = (x[i + 1] - prev[i + 1]) * inv, vz = (x[i + 2] - prev[i + 2]) * inv;
      const sp = Math.hypot(vx, vy, vz);
      if (sp > vmax) { const f = vmax / sp; vx *= f; vy *= f; vz *= f; }
      v[i] = vx; v[i + 1] = vy; v[i + 2] = vz;
    }
    this.dampEdges(dt);
  }

  solveGrab(dt) {
    const { x, invMass } = this;
    const a = 2e-6 / (dt * dt);
    const R = this.grabRot, T = this.grabTarget;
    for (let k = 0; k < this.grabN; k++) {
      const i = this.grabIdx[k], w = invMass[i];
      const ox = this.grabOff[3 * k], oy = this.grabOff[3 * k + 1], oz = this.grabOff[3 * k + 2];
      const tx = T[0] + R[0] * ox + R[1] * oy + R[2] * oz;
      const ty = Math.max(T[1] + R[3] * ox + R[4] * oy + R[5] * oz, this.floorY + 0.005);
      const tz = T[2] + R[6] * ox + R[7] * oy + R[8] * oz;
      let f = this.grabW[k] * w / (w + a);
      // pressing down near the table: yield instead of crushing the jelly underneath
      if (ty < x[3 * i + 1] && ty < this.pressBand) f *= Math.max(0.12, ty / this.pressBand);
      x[3 * i] += (tx - x[3 * i]) * f;
      x[3 * i + 1] += (ty - x[3 * i + 1]) * f;
      x[3 * i + 2] += (tz - x[3 * i + 2]) * f;
    }
  }

  // Per-tet co-rotational shape matching: find the rotation that best maps the rest tet onto the
  // current one (Müller et al. 2016, warm-started quaternion), then pull the four corners toward the
  // rotated rest shape with XPBD compliance. Inverted tets are always pushed back to a proper shape.
  solveTets(dt) {
    const { x, tets, tetQ, tetRot: Q, tetFirm, mass } = this;
    const base = this.shapeCompliance() / (dt * dt);
    for (let t = 0; t < this.nT; t++) {
      const a = 3 * tets[4 * t], b = 3 * tets[4 * t + 1], c = 3 * tets[4 * t + 2], d = 3 * tets[4 * t + 3];
      const ma = mass[a / 3], mb = mass[b / 3], mc = mass[c / 3], md = mass[d / 3];
      const M = ma + mb + mc + md;
      const cx = (x[a] * ma + x[b] * mb + x[c] * mc + x[d] * md) / M;
      const cy = (x[a + 1] * ma + x[b + 1] * mb + x[c + 1] * mc + x[d + 1] * md) / M;
      const cz = (x[a + 2] * ma + x[b + 2] * mb + x[c + 2] * mc + x[d + 2] * md) / M;
      const T = 12 * t;
      // A = Σ m p qᵀ (mass-weighted covariance of current vs rest, both about their centroids)
      let f00 = 0, f01 = 0, f02 = 0, f10 = 0, f11 = 0, f12 = 0, f20 = 0, f21 = 0, f22 = 0;
      {
        let px = (x[a] - cx) * ma, py = (x[a + 1] - cy) * ma, pz = (x[a + 2] - cz) * ma;
        let q0 = tetQ[T], q1 = tetQ[T + 1], q2 = tetQ[T + 2];
        f00 += px * q0; f01 += px * q1; f02 += px * q2; f10 += py * q0; f11 += py * q1; f12 += py * q2; f20 += pz * q0; f21 += pz * q1; f22 += pz * q2;
        px = (x[b] - cx) * mb; py = (x[b + 1] - cy) * mb; pz = (x[b + 2] - cz) * mb; q0 = tetQ[T + 3]; q1 = tetQ[T + 4]; q2 = tetQ[T + 5];
        f00 += px * q0; f01 += px * q1; f02 += px * q2; f10 += py * q0; f11 += py * q1; f12 += py * q2; f20 += pz * q0; f21 += pz * q1; f22 += pz * q2;
        px = (x[c] - cx) * mc; py = (x[c + 1] - cy) * mc; pz = (x[c + 2] - cz) * mc; q0 = tetQ[T + 6]; q1 = tetQ[T + 7]; q2 = tetQ[T + 8];
        f00 += px * q0; f01 += px * q1; f02 += px * q2; f10 += py * q0; f11 += py * q1; f12 += py * q2; f20 += pz * q0; f21 += pz * q1; f22 += pz * q2;
        px = (x[d] - cx) * md; py = (x[d + 1] - cy) * md; pz = (x[d + 2] - cz) * md; q0 = tetQ[T + 9]; q1 = tetQ[T + 10]; q2 = tetQ[T + 11];
        f00 += px * q0; f01 += px * q1; f02 += px * q2; f10 += py * q0; f11 += py * q1; f12 += py * q2; f20 += pz * q0; f21 += pz * q1; f22 += pz * q2;
      }
      let qx = Q[4 * t], qy = Q[4 * t + 1], qz = Q[4 * t + 2], qw = Q[4 * t + 3];
      let r00, r01, r02, r10, r11, r12, r20, r21, r22;
      for (let it = 0; it < 2; it++) {
        r00 = 1 - 2 * (qy * qy + qz * qz); r01 = 2 * (qx * qy - qw * qz); r02 = 2 * (qx * qz + qw * qy);
        r10 = 2 * (qx * qy + qw * qz); r11 = 1 - 2 * (qx * qx + qz * qz); r12 = 2 * (qy * qz - qw * qx);
        r20 = 2 * (qx * qz - qw * qy); r21 = 2 * (qy * qz + qw * qx); r22 = 1 - 2 * (qx * qx + qy * qy);
        const ox = (r10 * f20 - r20 * f10) + (r11 * f21 - r21 * f11) + (r12 * f22 - r22 * f12);
        const oy = (r20 * f00 - r00 * f20) + (r21 * f01 - r01 * f21) + (r22 * f02 - r02 * f22);
        const oz = (r00 * f10 - r10 * f00) + (r01 * f11 - r11 * f01) + (r02 * f12 - r12 * f02);
        const den = Math.abs(r00 * f00 + r10 * f10 + r20 * f20 + r01 * f01 + r11 * f11 + r21 * f21 + r02 * f02 + r12 * f12 + r22 * f22) + 1e-12;
        const wx = ox / den, wy = oy / den, wz = oz / den;
        const w = Math.sqrt(wx * wx + wy * wy + wz * wz);
        if (w < 1e-6) break;
        // small-angle quaternion step (renormalised below); large jumps are clamped
        const sc = w > 1 ? 0.5 / w : 0.5;
        const ax = wx * sc, ay = wy * sc, az = wz * sc, cs = 1;
        const nx = cs * qx + ax * qw + ay * qz - az * qy;
        const ny = cs * qy - ax * qz + ay * qw + az * qx;
        const nz = cs * qz + ax * qy - ay * qx + az * qw;
        const nw = cs * qw - ax * qx - ay * qy - az * qz;
        const nl = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz + nw * nw);
        qx = nx * nl; qy = ny * nl; qz = nz * nl; qw = nw * nl;
      }
      r00 = 1 - 2 * (qy * qy + qz * qz); r01 = 2 * (qx * qy - qw * qz); r02 = 2 * (qx * qz + qw * qy);
      r10 = 2 * (qx * qy + qw * qz); r11 = 1 - 2 * (qx * qx + qz * qz); r12 = 2 * (qy * qz - qw * qx);
      r20 = 2 * (qx * qz - qw * qy); r21 = 2 * (qy * qz + qw * qx); r22 = 1 - 2 * (qx * qx + qy * qy);
      Q[4 * t] = qx; Q[4 * t + 1] = qy; Q[4 * t + 2] = qz; Q[4 * t + 3] = qw;
      // the same fraction for all four corners keeps linear and angular momentum intact
      const f = 1 / (1 + base * tetFirm[t] * M * 0.25);
      let q0 = tetQ[T], q1 = tetQ[T + 1], q2 = tetQ[T + 2];
      x[a] += (cx + r00 * q0 + r01 * q1 + r02 * q2 - x[a]) * f; x[a + 1] += (cy + r10 * q0 + r11 * q1 + r12 * q2 - x[a + 1]) * f; x[a + 2] += (cz + r20 * q0 + r21 * q1 + r22 * q2 - x[a + 2]) * f;
      q0 = tetQ[T + 3]; q1 = tetQ[T + 4]; q2 = tetQ[T + 5];
      x[b] += (cx + r00 * q0 + r01 * q1 + r02 * q2 - x[b]) * f; x[b + 1] += (cy + r10 * q0 + r11 * q1 + r12 * q2 - x[b + 1]) * f; x[b + 2] += (cz + r20 * q0 + r21 * q1 + r22 * q2 - x[b + 2]) * f;
      q0 = tetQ[T + 6]; q1 = tetQ[T + 7]; q2 = tetQ[T + 8];
      x[c] += (cx + r00 * q0 + r01 * q1 + r02 * q2 - x[c]) * f; x[c + 1] += (cy + r10 * q0 + r11 * q1 + r12 * q2 - x[c + 1]) * f; x[c + 2] += (cz + r20 * q0 + r21 * q1 + r22 * q2 - x[c + 2]) * f;
      q0 = tetQ[T + 9]; q1 = tetQ[T + 10]; q2 = tetQ[T + 11];
      x[d] += (cx + r00 * q0 + r01 * q1 + r02 * q2 - x[d]) * f; x[d + 1] += (cy + r10 * q0 + r11 * q1 + r12 * q2 - x[d + 1]) * f; x[d + 2] += (cz + r20 * q0 + r21 * q1 + r22 * q2 - x[d + 2]) * f;
    }
  }

  solveVolumes(dt) {
    const { x, invMass, tets, restVol } = this;
    const alpha0 = this.volCompliance() / (dt * dt);
    for (let t = 0; t < this.nT; t++) {
      const a = tets[4 * t], b = tets[4 * t + 1], c = tets[4 * t + 2], d = tets[4 * t + 3];
      const A = 3 * a, B = 3 * b, Cc = 3 * c, D = 3 * d;
      // gradients (Müller): g_a = (d-b)×(c-b), g_b = (c-a)×(d-a), g_c = (d-a)×(b-a), g_d = (b-a)×(c-a)
      const bax = x[B] - x[A], bay = x[B + 1] - x[A + 1], baz = x[B + 2] - x[A + 2];
      const cax = x[Cc] - x[A], cay = x[Cc + 1] - x[A + 1], caz = x[Cc + 2] - x[A + 2];
      const dax = x[D] - x[A], day = x[D + 1] - x[A + 1], daz = x[D + 2] - x[A + 2];
      const dbx = x[D] - x[B], dby = x[D + 1] - x[B + 1], dbz = x[D + 2] - x[B + 2];
      const cbx = x[Cc] - x[B], cby = x[Cc + 1] - x[B + 1], cbz = x[Cc + 2] - x[B + 2];
      const gax = dby * cbz - dbz * cby, gay = dbz * cbx - dbx * cbz, gaz = dbx * cby - dby * cbx;
      const gbx = cay * daz - caz * day, gby = caz * dax - cax * daz, gbz = cax * day - cay * dax;
      const gcx = day * baz - daz * bay, gcy = daz * bax - dax * baz, gcz = dax * bay - day * bax;
      const gdx = bay * caz - baz * cay, gdy = baz * cax - bax * caz, gdz = bax * cay - bay * cax;
      const V = (dax * gdx + day * gdy + daz * gdz) / 6;
      const wa = invMass[a], wb = invMass[b], wc = invMass[c], wd = invMass[d];
      const wsum = wa * (gax * gax + gay * gay + gaz * gaz) + wb * (gbx * gbx + gby * gby + gbz * gbz)
                 + wc * (gcx * gcx + gcy * gcy + gcz * gcz) + wd * (gdx * gdx + gdy * gdy + gdz * gdz);
      if (wsum < 1e-12) continue;
      const r0 = restVol[t];
      // anti-inversion: elements far below rest volume get a rigid (compliance-free) correction
      const alpha = V < 0.25 * r0 ? 0 : alpha0;
      const C = 6 * (V - r0);
      let s = -C / (wsum + alpha);
      x[A] += gax * s * wa; x[A + 1] += gay * s * wa; x[A + 2] += gaz * s * wa;
      x[B] += gbx * s * wb; x[B + 1] += gby * s * wb; x[B + 2] += gbz * s * wb;
      x[Cc] += gcx * s * wc; x[Cc + 1] += gcy * s * wc; x[Cc + 2] += gcz * s * wc;
      x[D] += gdx * s * wd; x[D + 1] += gdy * s * wd; x[D + 2] += gdz * s * wd;
    }
  }

  // pieces push each other apart: particle spheres of different pieces may not overlap.
  // Only pairs of pieces whose bounding boxes touch are examined, and only the particles
  // inside the shared region — so pieces lying apart cost almost nothing.
  collidePieces() {
    const { x, invMass, comp, n, nComp } = this;
    const D = this.collideDist;
    if (!this.cBox || this.cBox.length !== nComp * 6) { this.cBox = new Float32Array(nComp * 6); this.cListA = new Int32Array(n); this.cListB = new Int32Array(n); }
    const box = this.cBox;
    for (let c = 0; c < nComp; c++) { box[6 * c] = box[6 * c + 1] = box[6 * c + 2] = Infinity; box[6 * c + 3] = box[6 * c + 4] = box[6 * c + 5] = -Infinity; }
    for (let p = 0; p < n; p++) {
      const o = 6 * comp[p];
      for (let k = 0; k < 3; k++) { const v = x[3 * p + k]; if (v < box[o + k]) box[o + k] = v; if (v > box[o + 3 + k]) box[o + 3 + k] = v; }
    }
    const LA = this.cListA, LB = this.cListB;
    for (let A = 0; A < nComp; A++) for (let B = A + 1; B < nComp; B++) {
      const lo = [0, 0, 0], hi = [0, 0, 0];
      let overlap = true;
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.max(box[6 * A + k], box[6 * B + k]) - D; hi[k] = Math.min(box[6 * A + 3 + k], box[6 * B + 3 + k]) + D;
        if (lo[k] > hi[k]) { overlap = false; break; }
      }
      if (!overlap) continue;
      let na = 0, nb = 0;
      for (let p = 0; p < n; p++) {
        const c = comp[p];
        if (c !== A && c !== B) continue;
        const px = x[3 * p], py = x[3 * p + 1], pz = x[3 * p + 2];
        if (px < lo[0] || px > hi[0] || py < lo[1] || py > hi[1] || pz < lo[2] || pz > hi[2]) continue;
        if (c === A) LA[na++] = p; else LB[nb++] = p;
      }
      for (let i = 0; i < na; i++) {
        const p = LA[i];
        for (let j = 0; j < nb; j++) {
          const q = LB[j];
          const dx = x[3 * q] - x[3 * p], dy = x[3 * q + 1] - x[3 * p + 1], dz = x[3 * q + 2] - x[3 * p + 2];
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 >= D * D || d2 < 1e-12) continue;
          const d = Math.sqrt(d2), wp = invMass[p], wq = invMass[q];
          // gentle: a few millimetres per pass, so freshly cut faces ease apart instead of popping
          const push = Math.min(D - d, 0.006) / (d * (wp + wq));
          x[3 * p] -= dx * push * wp; x[3 * p + 1] -= dy * push * wp; x[3 * p + 2] -= dz * push * wp;
          x[3 * q] += dx * push * wq; x[3 * q + 1] += dy * push * wq; x[3 * q + 2] += dz * push * wq;
        }
      }
    }
  }

  // best-fit rigid frame (rest → world) of one piece: centroids and a rotation matrix (row-major)
  pieceFrame(c) {
    const { x, rest, mass, comp, n } = this;
    let M = 0; const cw = [0, 0, 0], cr = [0, 0, 0];
    for (let i = 0; i < n; i++) if (comp[i] === c) { const m = mass[i]; M += m; for (let k = 0; k < 3; k++) { cw[k] += x[3 * i + k] * m; cr[k] += rest[3 * i + k] * m; } }
    for (let k = 0; k < 3; k++) { cw[k] /= M; cr[k] /= M; }
    const A = new Float64Array(9);
    for (let i = 0; i < n; i++) if (comp[i] === c) {
      const m = mass[i];
      for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) A[3 * r + k] += m * (x[3 * i + r] - cw[r]) * (rest[3 * i + k] - cr[k]);
    }
    // Müller et al. rotation extraction, iterated from identity
    let qx = 0, qy = 0, qz = 0, qw = 1;
    const R = new Float64Array(9);
    for (let it = 0; it < 40; it++) {
      R[0] = 1 - 2 * (qy * qy + qz * qz); R[1] = 2 * (qx * qy - qw * qz); R[2] = 2 * (qx * qz + qw * qy);
      R[3] = 2 * (qx * qy + qw * qz); R[4] = 1 - 2 * (qx * qx + qz * qz); R[5] = 2 * (qy * qz - qw * qx);
      R[6] = 2 * (qx * qz - qw * qy); R[7] = 2 * (qy * qz + qw * qx); R[8] = 1 - 2 * (qx * qx + qy * qy);
      let ox = 0, oy = 0, oz = 0, den = 0;
      for (let col = 0; col < 3; col++) {
        const rx = R[col], ry = R[3 + col], rz = R[6 + col], ax = A[col], ay = A[3 + col], az = A[6 + col];
        ox += ry * az - rz * ay; oy += rz * ax - rx * az; oz += rx * ay - ry * ax; den += rx * ax + ry * ay + rz * az;
      }
      const s = 1 / (Math.abs(den) + 1e-12);
      const wx = ox * s, wy = oy * s, wz = oz * s, w = Math.hypot(wx, wy, wz);
      if (w < 1e-9) break;
      const h = Math.min(w, 2) / 2, sn = Math.sin(h) / w, cs = Math.cos(h);
      const ax = wx * sn, ay = wy * sn, az = wz * sn;
      const nx = cs * qx + ax * qw + ay * qz - az * qy, ny = cs * qy - ax * qz + ay * qw + az * qx;
      const nz = cs * qz + ax * qy - ay * qx + az * qw, nw = cs * qw - ax * qx - ay * qy - az * qz;
      const l = Math.hypot(nx, ny, nz, nw); qx = nx / l; qy = ny / l; qz = nz / l; qw = nw / l;
    }
    return { cw, cr, R };
  }

  solveFloor() {
    const { x, prev, n } = this;
    const fy = this.floorY, mu = this.friction;
    for (let i = 0; i < n; i++) {
      const k = 3 * i;
      const pen = fy - x[k + 1];
      if (pen <= 0) continue;
      x[k + 1] = fy;
      // Coulomb-style positional friction
      const dx = x[k] - prev[k], dz = x[k + 2] - prev[k + 2];
      const dl = Math.hypot(dx, dz);
      if (dl < 1e-12) continue;
      // static friction for micro-slip, kinetic friction otherwise (never locks in large strain)
      const f = dl < mu * pen ? 1 : mu * pen / dl;
      x[k] -= dx * f; x[k + 2] -= dz * f;
    }
  }

  dampEdges(dt) {
    const { x, v, invMass, edges } = this;
    const k = 1 - Math.exp(-this.dampRate() * dt);
    for (let e = 0; e < this.nE; e++) {
      const i = edges[2 * e], j = edges[2 * e + 1];
      const I = 3 * i, J = 3 * j;
      let nx = x[J] - x[I], ny = x[J + 1] - x[I + 1], nz = x[J + 2] - x[I + 2];
      const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (l < 1e-9) continue;
      nx /= l; ny /= l; nz /= l;
      const rv = (v[J] - v[I]) * nx + (v[J + 1] - v[I + 1]) * ny + (v[J + 2] - v[I + 2]) * nz;
      const wi = invMass[i], wj = invMass[j], ws = wi + wj;
      const imp = rv * k / ws;
      v[I] += nx * imp * wi; v[I + 1] += ny * imp * wi; v[I + 2] += nz * imp * wi;
      v[J] -= nx * imp * wj; v[J + 1] -= ny * imp * wj; v[J + 2] -= nz * imp * wj;
    }
  }

  // ── diagnostics ──
  volumeRatio() {
    let s = 0;
    for (let t = 0; t < this.nT; t++) s += this.tetVol(this.x, t);
    return s / this.totalRestVolume;
  }
  minVolumeRatio() {
    let m = Infinity;
    for (let t = 0; t < this.nT; t++) m = Math.min(m, this.tetVol(this.x, t) / this.restVol[t]);
    return m;
  }
  kineticEnergy() {
    let e = 0;
    for (let i = 0; i < this.n; i++) {
      const k = 3 * i;
      e += 0.5 * this.mass[i] * (this.v[k] ** 2 + this.v[k + 1] ** 2 + this.v[k + 2] ** 2);
    }
    return e;
  }
  // mean deviation from rest shape after best rigid alignment is expensive; use edge strain instead
  meanStrain() {
    let s = 0;
    const { x, edges, restLen } = this;
    for (let e = 0; e < this.nE; e++) {
      const i = 3 * edges[2 * e], j = 3 * edges[2 * e + 1];
      s += Math.abs(Math.hypot(x[i] - x[j], x[i + 1] - x[j + 1], x[i + 2] - x[j + 2]) / restLen[e] - 1);
    }
    return s / this.nE;
  }
  minY() { let m = Infinity; for (let i = 1; i < this.x.length; i += 3) m = Math.min(m, this.x[i]); return m; }
}

function inv3(m) { // row-major 3x3
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C, k = 1 / det;
  return [A * k, -(b * i - c * h) * k, (b * f - c * e) * k, B * k, (a * i - c * g) * k, -(a * f - c * d) * k, C * k, -(a * h - b * g) * k, (a * e - b * d) * k];
}


// ───────────────────────────── locating points inside tets ─────────────────────────────
function vol6(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz) {
  const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az, wx = dx - ax, wy = dy - ay, wz = dz - az;
  return ux * (vy * wz - vz * wy) - uy * (vx * wz - vz * wx) + uz * (vx * wy - vy * wx);
}
function baryOf(pos, tets, t, px, py, pz, out) {
  const a = 3 * tets[4 * t], b = 3 * tets[4 * t + 1], c = 3 * tets[4 * t + 2], d = 3 * tets[4 * t + 3];
  const ax = pos[a], ay = pos[a + 1], az = pos[a + 2], bx = pos[b], by = pos[b + 1], bz = pos[b + 2];
  const cx = pos[c], cy = pos[c + 1], cz = pos[c + 2], dx = pos[d], dy = pos[d + 1], dz = pos[d + 2];
  const V = vol6(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz) || 1e-12;
  out[0] = vol6(px, py, pz, bx, by, bz, cx, cy, cz, dx, dy, dz) / V;
  out[1] = vol6(ax, ay, az, px, py, pz, cx, cy, cz, dx, dy, dz) / V;
  out[2] = vol6(ax, ay, az, bx, by, bz, px, py, pz, dx, dy, dz) / V;
  out[3] = vol6(ax, ay, az, bx, by, bz, cx, cy, cz, px, py, pz) / V;
}

/** Spatial hash over tets, to find the tet that contains (or is nearest to) a point. */
class TetLocator {
  constructor(pos, tets, cell, mask) {
    this.pos = pos; this.tets = tets; this.h = cell * 2; this.mask = mask || null; this.grid = new Map();
    const nT = tets.length / 4;
    for (let t = 0; t < nT; t++) {
      let cx = 0, cy = 0, cz = 0;
      for (let k = 0; k < 4; k++) { const v = tets[4 * t + k]; cx += pos[3 * v]; cy += pos[3 * v + 1]; cz += pos[3 * v + 2]; }
      const key = this.key(cx / 4, cy / 4, cz / 4);
      let l = this.grid.get(key); if (!l) this.grid.set(key, (l = [])); l.push(t);
    }
    this.tmp = [0, 0, 0, 0];
  }
  key(x, y, z) { return this.k3(Math.floor(x / this.h), Math.floor(y / this.h), Math.floor(z / this.h)); }
  k3(i, j, k) { return ((i + 2048) * 4096 + (j + 2048)) * 4096 + (k + 2048); }
  /** Best tet for a point (side filter: only tets whose mask value equals `want`). Returns { tet, bary } or null. */
  locate(px, py, pz, want) {
    const gx = Math.floor(px / this.h), gy = Math.floor(py / this.h), gz = Math.floor(pz / this.h);
    let best = -1, bestScore = -Infinity; const bb = [0, 0, 0, 0], tmp = this.tmp;
    for (let r = 1; r <= 4 && best < 0 || (best >= 0 && bestScore < -0.2 && r <= 4); r++) {
      for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) for (let k = -r; k <= r; k++) {
        if (r > 1 && Math.max(Math.abs(i), Math.abs(j), Math.abs(k)) < r) continue;   // only the new shell
        const l = this.grid.get(this.k3(gx + i, gy + j, gz + k));
        if (!l) continue;
        for (const t of l) {
          if (this.mask && want !== undefined && this.mask[t] !== want) continue;
          baryOf(this.pos, this.tets, t, px, py, pz, tmp);
          const score = Math.min(tmp[0], tmp[1], tmp[2], tmp[3]);
          if (score > bestScore) { bestScore = score; best = t; bb[0] = tmp[0]; bb[1] = tmp[1]; bb[2] = tmp[2]; bb[3] = tmp[3]; }
        }
      }
      if (best >= 0 && bestScore > -0.2) break;
    }
    return best < 0 ? null : { tet: best, bary: bb };
  }
}

// ───────────────────────────── cut-face triangulation ─────────────────────────────
// Bowyer–Watson Delaunay (from the jelly demo): returns CCW triangles as flat indices into the flat [x,y,...] array.
function delaunay(pts) {
  const n = pts.length / 2;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, pts[2 * i]); maxX = Math.max(maxX, pts[2 * i]);
    minY = Math.min(minY, pts[2 * i + 1]); maxY = Math.max(maxY, pts[2 * i + 1]);
  }
  const d = Math.max(maxX - minX, maxY - minY) * 20;
  const mx = (minX + maxX) / 2, my = (minY + maxY) / 2;
  const P = Array.from(pts);
  P.push(mx - d, my - d, mx + d, my - d, mx, my + d);
  let tris = [];
  const mk = (a, b, c) => {
    const ax = P[2 * a], ay = P[2 * a + 1], bx = P[2 * b], by = P[2 * b + 1], cx = P[2 * c], cy = P[2 * c + 1];
    const D = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
    const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / D;
    const uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / D;
    return { a, b, c, x: ux, y: uy, r2: (ax - ux) ** 2 + (ay - uy) ** 2 };
  };
  tris.push(mk(n, n + 1, n + 2));
  for (let i = 0; i < n; i++) {
    const px = P[2 * i], py = P[2 * i + 1];
    const bad = [], keep = [];
    for (const t of tris) ((px - t.x) ** 2 + (py - t.y) ** 2 < t.r2 * (1 + 1e-9) ? bad : keep).push(t);
    const edges = new Map();
    for (const t of bad) for (const [e0, e1] of [[t.a, t.b], [t.b, t.c], [t.c, t.a]]) {
      const k = e0 < e1 ? e0 * 100003 + e1 : e1 * 100003 + e0;
      const ex = edges.get(k);
      if (ex) ex.count++; else edges.set(k, { e0, e1, count: 1 });
    }
    tris = keep;
    for (const e of edges.values()) if (e.count === 1) tris.push(mk(e.e0, e.e1, i));
  }
  const res = [];
  for (const t of tris) {
    if (t.a >= n || t.b >= n || t.c >= n) continue;
    // CCW orientation
    const ax = P[2 * t.a], ay = P[2 * t.a + 1];
    const cr = (P[2 * t.b] - ax) * (P[2 * t.c + 1] - ay) - (P[2 * t.b + 1] - ay) * (P[2 * t.c] - ax);
    if (cr > 0) res.push(t.a, t.b, t.c); else res.push(t.a, t.c, t.b);
  }
  return res;
}

function insidePolygon(poly, x, y) {
  let inside = false; const n = poly.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[2 * i], yi = poly[2 * i + 1], xj = poly[2 * j], yj = poly[2 * j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Triangulates the cut outline `poly` (flat [x,y,...] loop) with interior points on a hex lattice, so the cut face has real
 * vertices to carry depth-based colour and follow the jelly as it deforms. Returns { pts: [[x,y],...] (the loop first),
 * tris } with CCW triangles.
 */
function triangulateCap(poly, spacing) {
  const nb = poly.length / 2; let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < nb; i++) { minX = Math.min(minX, poly[2 * i]); maxX = Math.max(maxX, poly[2 * i]); minY = Math.min(minY, poly[2 * i + 1]); maxY = Math.max(maxY, poly[2 * i + 1]); }
  const all = Array.from(poly); const dy = (spacing * Math.sqrt(3)) / 2; let row = 0;
  for (let y = minY + dy / 2; y < maxY; y += dy, row++) for (let x = minX + (row % 2) * spacing / 2; x < maxX; x += spacing) {
    if (!insidePolygon(poly, x, y)) continue;
    let near = Infinity;
    for (let i = 0; i < nb; i++) near = Math.min(near, Math.hypot(poly[2 * i] - x, poly[2 * i + 1] - y));
    if (near > spacing * 0.55) all.push(x, y);
  }
  const tri = delaunay(all), out = [];
  for (let f = 0; f < tri.length; f += 3) {
    const cx = (all[2 * tri[f]] + all[2 * tri[f + 1]] + all[2 * tri[f + 2]]) / 3, cy = (all[2 * tri[f] + 1] + all[2 * tri[f + 1] + 1] + all[2 * tri[f + 2] + 1]) / 3;
    if (insidePolygon(poly, cx, cy)) out.push(tri[f], tri[f + 1], tri[f + 2]);
  }
  const pts = []; for (let i = 0; i < all.length; i += 2) pts.push([all[i], all[i + 1]]);
  return { pts, tris: out };
}

// ───────────────────────────── the soft object ─────────────────────────────
/**
 * A squishy, cuttable object. Options:
 *   sdf        (x,y,z) => distance, negative inside (see `sd`)         bounds {min:[x,y,z], max:[x,y,z]} around the shape
 *   cell       tet size, default 0.14 (0.12 to 0.18 is good: about 2k to 5k tets for a 1.5 unit object; smaller is slower)
 *   surfaceCell render-surface resolution, default cell * 0.45
 *   firmness   0 (very soft) .. 1 (firm), default 0.5      damping 0..1, default 0.45
 *   gravity    default -9.81      floorY  height of the floor, default 0      drop  initial lift above rest, default 0
 *   softnessAt (x,y,z,depth) => multiplier, >1 softer / <1 stiffer (e.g. a firm rind: depth > -0.1 ? 0.4 : 1)
 *   colorAt    (x,y,z,depth,isCap) => [r,g,b] vertex colour (rind vs flesh vs cut face)
 */
export class SoftObject {
  constructor(opts) {
    this.opts = opts;
    this.sdf = opts.sdf; this.bounds = opts.bounds; this.cell = opts.cell ?? 0.14;
    this.version = 0;
    this._build();
  }

  _makeBody(rest, tets, tetSoft) {
    const o = this.opts;
    const sb = new SoftBody({ rest, tets, tetSoft }, {
      firmness: o.firmness ?? 0.5, damping: o.damping ?? 0.45, gravity: o.gravity ?? -9.81,
      collideDist: this.cell * 0.9, pressBand: this.cell * 4, maxReach: o.maxReach ?? 2.2,
    });
    sb.floorY = o.floorY ?? 0;
    return sb;
  }

  _build() {
    const o = this.opts, sdf = this.sdf;
    const tm = tetMeshFromSDF(sdf, this.bounds, this.cell);
    let tetSoft = null;
    if (o.softnessAt) {
      tetSoft = new Float32Array(tm.tets.length / 4);
      for (let t = 0; t < tetSoft.length; t++) {
        let cx = 0, cy = 0, cz = 0;
        for (let k = 0; k < 4; k++) { const v = tm.tets[4 * t + k]; cx += tm.rest[3 * v]; cy += tm.rest[3 * v + 1]; cz += tm.rest[3 * v + 2]; }
        cx /= 4; cy /= 4; cz /= 4;
        tetSoft[t] = o.softnessAt(cx, cy, cz, sdf(cx, cy, cz));
      }
    }
    this.sb = this._makeBody(tm.rest, tm.tets, tetSoft);
    this.sb.reset(o.drop ?? 0);
    const surf = surfaceMeshFromSDF(sdf, this.bounds, o.surfaceCell ?? this.cell * 0.45);
    const nR = surf.positions.length / 3;
    const loc = new TetLocator(tm.rest, tm.tets, this.cell);
    this.rTet = new Int32Array(nR); this.rBary = new Float32Array(nR * 4); this.rCap = new Uint8Array(nR);
    for (let v = 0; v < nR; v++) {
      const hit = loc.locate(surf.positions[3 * v], surf.positions[3 * v + 1], surf.positions[3 * v + 2]);
      this.rTet[v] = hit ? hit.tet : 0;
      if (hit) this.rBary.set(hit.bary, 4 * v); else this.rBary.set([1, 0, 0, 0], 4 * v);
    }
    this.rIdx = surf.indices;
    this.rPos = new Float32Array(nR * 3);
    this.tetSide = null;
    this._finishRender();
  }

  /** Recompute vertex colours and positions after the render mesh changed (build or cut). */
  _finishRender() {
    const nR = this.rTet.length;
    this.rPos = new Float32Array(nR * 3);
    this.updateRender();
    // rest-space position of each render vertex: needed for colour / depth
    this.rColor = new Float32Array(nR * 4);
    const { sb } = this, T = sb.tets;
    for (let v = 0; v < nR; v++) {
      const t = this.rTet[v]; let x = 0, y = 0, z = 0;
      for (let k = 0; k < 4; k++) { const w = this.rBary[4 * v + k], i = T[4 * t + k]; x += w * sb.rest[3 * i]; y += w * sb.rest[3 * i + 1]; z += w * sb.rest[3 * i + 2]; }
      const depth = this.sdf(x, y, z);
      const c = this.opts.colorAt ? this.opts.colorAt(x, y, z, depth, !!this.rCap[v]) : [1, 1, 1];
      this.rColor[4 * v] = c[0]; this.rColor[4 * v + 1] = c[1]; this.rColor[4 * v + 2] = c[2]; this.rColor[4 * v + 3] = 1;
    }
    this.version++;
  }

  /** Writes the current render-vertex positions from the simulation. */
  updateRender() {
    const { sb, rTet, rBary, rPos } = this, X = sb.x, T = sb.tets;
    for (let v = 0, n = rTet.length; v < n; v++) {
      const t = 4 * rTet[v], b = 4 * v;
      const a = 3 * T[t], bb = 3 * T[t + 1], c = 3 * T[t + 2], d = 3 * T[t + 3];
      const w0 = rBary[b], w1 = rBary[b + 1], w2 = rBary[b + 2], w3 = rBary[b + 3];
      rPos[3 * v] = w0 * X[a] + w1 * X[bb] + w2 * X[c] + w3 * X[d];
      rPos[3 * v + 1] = w0 * X[a + 1] + w1 * X[bb + 1] + w2 * X[c + 1] + w3 * X[d + 1];
      rPos[3 * v + 2] = w0 * X[a + 2] + w1 * X[bb + 2] + w2 * X[c + 2] + w3 * X[d + 2];
    }
  }

  step() { this.sb.step(); }
  get pieces() { return this.sb.nComp; }
  /** Put everything back as it was (one whole piece). */
  reset() { this._build(); }

  /**
   * Cut the object with the plane through (px,py,pz) with normal (nx,ny,nz), in world space.
   * Returns { ok, reason?, pieces }. The cut faces are flat, capped and shaded as the inside.
   */
  cut(px, py, pz, nx, ny, nz, opts = {}) {
    const nl = Math.hypot(nx, ny, nz); nx /= nl; ny /= nl; nz /= nl;
    const sb = this.sb, X = sb.x, nV = sb.n, nT = sb.nT, T = sb.tets;
    const dist = (i) => (X[3 * i] - px) * nx + (X[3 * i + 1] - py) * ny + (X[3 * i + 2] - pz) * nz;
    // is the plane actually inside the object?
    let pos = 0, neg = 0; const tol = this.cell * 0.25;
    for (let i = 0; i < nV; i++) { const d = dist(i); if (d > tol) pos++; else if (d < -tol) neg++; }
    if (!pos || !neg) return { ok: false, reason: "the cut misses the object", pieces: sb.nComp };

    // 1. side of every tet, from its centroid
    const side = new Int8Array(nT);
    for (let t = 0; t < nT; t++) { let d = 0; for (let k = 0; k < 4; k++) d += dist(T[4 * t + k]); side[t] = d >= 0 ? 1 : -1; }
    // 2. snap onto the plane: vertices near it, and any vertex lying on the wrong side of a tet that uses it
    const snapTol = this.cell * 0.32;
    const snapped = new Uint8Array(nV), d0 = new Float32Array(nV);
    for (let i = 0; i < nV; i++) { d0[i] = dist(i); if (Math.abs(d0[i]) < snapTol) snapped[i] = 1; }
    for (let t = 0; t < nT; t++) for (let k = 0; k < 4; k++) { const v = T[4 * t + k]; if (d0[v] * side[t] < 0) snapped[v] = 1; }
    const frames = new Map();
    const frame = (c) => { let f = frames.get(c); if (!f) { f = sb.pieceFrame(c); frames.set(c, f); } return f; };
    for (let i = 0; i < nV; i++) {
      if (!snapped[i]) continue;
      const dx = -d0[i] * nx, dy = -d0[i] * ny, dz = -d0[i] * nz;
      X[3 * i] += dx; X[3 * i + 1] += dy; X[3 * i + 2] += dz;
      sb.prev[3 * i] += dx; sb.prev[3 * i + 1] += dy; sb.prev[3 * i + 2] += dz;
      // the matching shift in rest space: world displacement mapped back through the piece's rotation
      const R = frame(sb.comp[i]).R;
      sb.rest[3 * i] += R[0] * dx + R[3] * dy + R[6] * dz;
      sb.rest[3 * i + 1] += R[1] * dx + R[4] * dy + R[7] * dz;
      sb.rest[3 * i + 2] += R[2] * dx + R[5] * dy + R[8] * dz;
    }
    // 3. drop tets flattened by the snap
    const keep = new Uint8Array(nT); let kept = 0;
    for (let t = 0; t < nT; t++) {
      let ns = 0; for (let k = 0; k < 4; k++) ns += snapped[T[4 * t + k]];
      const vol = sb.tetVol(X, t);
      if (ns === 4 || (ns > 0 && vol < 0.04 * sb.restVol[t])) continue;
      keep[t] = 1; kept++;
    }
    // 4. split snapped vertices that serve both sides, then compact
    const hasPos = new Uint8Array(nV), hasNeg = new Uint8Array(nV);
    for (let t = 0; t < nT; t++) if (keep[t]) for (let k = 0; k < 4; k++) { const v = T[4 * t + k]; if (side[t] > 0) hasPos[v] = 1; else hasNeg[v] = 1; }
    const mapPos = new Int32Array(nV).fill(-1), mapNeg = new Int32Array(nV).fill(-1);
    const rest = [], xs = [], prevs = [], vs = [], oldOf = [];
    const addVert = (v) => { const id = rest.length / 3; rest.push(sb.rest[3 * v], sb.rest[3 * v + 1], sb.rest[3 * v + 2]); xs.push(X[3 * v], X[3 * v + 1], X[3 * v + 2]); prevs.push(sb.prev[3 * v], sb.prev[3 * v + 1], sb.prev[3 * v + 2]); vs.push(sb.v[3 * v], sb.v[3 * v + 1], sb.v[3 * v + 2]); oldOf.push(v); return id; };
    const tets = [], tetMap = new Int32Array(nT).fill(-1), soft = [], newSide = [];
    for (let t = 0; t < nT; t++) {
      if (!keep[t]) continue;
      const s = side[t]; const map = s > 0 ? mapPos : mapNeg;
      const row = [];
      for (let k = 0; k < 4; k++) {
        const v = T[4 * t + k];
        // a vertex used by only one side (or not on the plane) keeps one copy; a snapped one used by both gets one per side
        if (map[v] < 0) map[v] = addVert(v);
        row.push(map[v]);
      }
      tetMap[t] = tets.length / 4; tets.push(...row); soft.push(sb.tetFirm[t]); newSide.push(s);
    }
    const restA = Float32Array.from(rest), tetsA = Uint32Array.from(tets);
    const old = { sb, rTet: this.rTet, rBary: this.rBary, rCap: this.rCap };
    // 5. rebuild the simulation, keeping positions and velocities
    const nb = this._makeBody(restA, tetsA, Float32Array.from(soft));
    nb.x.set(xs); nb.prev.set(prevs); nb.v.set(vs);
    nb.firmness = sb.firmness; nb.damping = sb.damping; nb.floorY = sb.floorY; nb.gravity = sb.gravity;
    nb.time = sb.time;
    this.sb = nb; this.tetSide = Int8Array.from(newSide);
    // pieces drift apart: along the normal, away from the cut
    const sep = opts.separation ?? 0.45, hop = opts.hop ?? 0.25;
    const compSide = new Float32Array(nb.nComp);
    for (let t = 0; t < nb.nT; t++) compSide[nb.comp[tetsA[4 * t]]] += newSide[t];
    for (let i = 0; i < nb.n; i++) {
      const s = compSide[nb.comp[i]] >= 0 ? 1 : -1;
      nb.v[3 * i] += s * nx * sep; nb.v[3 * i + 1] += s * ny * sep + hop; nb.v[3 * i + 2] += s * nz * sep;
    }
    nb.endGrab();
    // 6. cut the render surface along the same plane and cap it
    this._cutRender(old, tetMap, px, py, pz, nx, ny, nz, side);
    return { ok: true, pieces: nb.nComp };
  }

  _cutRender(old, tetMap, px, py, pz, nx, ny, nz) {
    const sbOld = old.sb, Xold = sbOld.x;   // old tets, snapped positions
    // render vertex positions under the old tets (snapped, so they sit consistently against the plane)
    const nR0 = old.rTet.length, P = new Float32Array(nR0 * 3);
    for (let v = 0; v < nR0; v++) {
      const t = old.rTet[v]; let x = 0, y = 0, z = 0;
      for (let k = 0; k < 4; k++) { const w = old.rBary[4 * v + k], i = sbOld.tets[4 * t + k]; x += w * Xold[3 * i]; y += w * Xold[3 * i + 1]; z += w * Xold[3 * i + 2]; }
      P[3 * v] = x; P[3 * v + 1] = y; P[3 * v + 2] = z;
    }
    const dv = new Float32Array(nR0);
    for (let v = 0; v < nR0; v++) { const d = (P[3 * v] - px) * nx + (P[3 * v + 1] - py) * ny + (P[3 * v + 2] - pz) * nz; dv[v] = Math.abs(d) < 1e-6 ? 1e-6 : d; }
    // locators over the NEW tets in their current positions, one mask per side
    const loc = new TetLocator(this.sb.x, this.sb.tets, this.cell, this.tetSide);
    const verts = [];                    // { p:[x,y,z], tet, bary, cap }
    const side = (v) => (dv[v] > 0 ? 1 : -1);
    const embed = (p, s) => loc.locate(p[0], p[1], p[2], s);
    // old vertices keep their embedding when their tet survived on their own side
    const idxOld = new Int32Array(nR0).fill(-1);
    for (let v = 0; v < nR0; v++) {
      const s = side(v), t = old.rTet[v]; const nt = tetMap[t];
      let tet = -1, bary = null;
      if (nt >= 0 && this.tetSide[nt] === s) { tet = nt; bary = [old.rBary[4 * v], old.rBary[4 * v + 1], old.rBary[4 * v + 2], old.rBary[4 * v + 3]]; }
      else { const h = embed([P[3 * v], P[3 * v + 1], P[3 * v + 2]], s); if (h) { tet = h.tet; bary = h.bary; } }
      if (tet < 0) continue;
      idxOld[v] = verts.length; verts.push({ tet, bary, cap: old.rCap[v] });
    }
    const crossing = new Map();          // edge key -> { A: vertex id on the + side, B: id on the - side }
    const cross = (i, j) => {
      const key = i < j ? i + "," + j : j + "," + i;
      let c = crossing.get(key);
      if (!c) {
        const t = dv[i] / (dv[i] - dv[j]);
        const p = [P[3 * i] + (P[3 * j] - P[3 * i]) * t, P[3 * i + 1] + (P[3 * j + 1] - P[3 * i + 1]) * t, P[3 * i + 2] + (P[3 * j + 2] - P[3 * i + 2]) * t];
        const mk = (s, cap) => { const h = embed(p, s); if (!h) return -1; verts.push({ tet: h.tet, bary: h.bary, cap }); return verts.length - 1; };
        // the surface's own crossing point is on both pieces' side surface, so it is not a "cap" vertex for the colour
        c = { p, A: mk(1, 0), B: mk(-1, 0), key };
        crossing.set(key, c);
      }
      return c;
    };
    const tris = []; const segsA = [];   // cap boundary segments as pairs of crossing keys
    const idxIn = this.rIdx;
    for (let f = 0; f < idxIn.length; f += 3) {
      const a = idxIn[f], b = idxIn[f + 1], c = idxIn[f + 2];
      const sa = side(a), sb2 = side(b), sc = side(c);
      if (sa === sb2 && sb2 === sc) { if (idxOld[a] >= 0 && idxOld[b] >= 0 && idxOld[c] >= 0) tris.push(idxOld[a], idxOld[b], idxOld[c]); continue; }
      // rotate so that vertex `lone` is the one alone on its side
      const ids = [a, b, c], ss = [sa, sb2, sc];
      let lone = ss[0] !== ss[1] && ss[0] !== ss[2] ? 0 : ss[1] !== ss[0] && ss[1] !== ss[2] ? 1 : 2;
      const L = ids[lone], M1 = ids[(lone + 1) % 3], M2 = ids[(lone + 2) % 3], sl = ss[lone];
      const c1 = cross(L, M1), c2 = cross(L, M2);
      const g = (cc, s) => (s > 0 ? cc.A : cc.B);
      // lone side gets one small triangle; the other side gets a quad (two triangles); winding is preserved
      const loneTri = [idxOld[L], g(c1, sl), g(c2, sl)];
      const otherSide = -sl;
      const q = [g(c1, otherSide), idxOld[M1], idxOld[M2], g(c2, otherSide)];
      if (!loneTri.includes(-1)) tris.push(loneTri[0], loneTri[1], loneTri[2]);
      if (!q.includes(-1) && idxOld[M1] >= 0 && idxOld[M2] >= 0) tris.push(q[0], q[1], q[2], q[0], q[2], q[3]);
      // original winding is (a, b, c); when `lone` is not index 0 the rotation keeps it cyclic, so no flip is needed
      segsA.push([c1.key, c2.key]);
    }
    // 7. cap each side: chain the boundary segments into loops, triangulate every loop
    const adj = new Map();
    for (const [k1, k2] of segsA) { (adj.get(k1) || adj.set(k1, []).get(k1)).push(k2); (adj.get(k2) || adj.set(k2, []).get(k2)).push(k1); }
    const used = new Set(); const loops = [];
    for (const start of adj.keys()) {
      if (used.has(start)) continue;
      const loop = [start]; used.add(start); let cur = start;
      for (;;) {
        const nxt = (adj.get(cur) || []).find((k) => !used.has(k));
        if (nxt === undefined) break;
        loop.push(nxt); used.add(nxt); cur = nxt;
      }
      if (loop.length >= 3) loops.push(loop);
    }
    // plane basis
    let ux, uy, uz; if (Math.abs(nx) < 0.9) { ux = 0; uy = nz; uz = -ny; } else { ux = -nz; uy = 0; uz = nx; }
    const ul = Math.hypot(ux, uy, uz); ux /= ul; uy /= ul; uz /= ul;
    const vx = ny * uz - nz * uy, vy = nz * ux - nx * uz, vz = nx * uy - ny * ux;
    for (const loop of loops) {
      const pts = loop.map((k) => crossing.get(k));
      const poly = new Float32Array(pts.length * 2);
      pts.forEach((c, i) => { const dx = c.p[0] - px, dy = c.p[1] - py, dz = c.p[2] - pz; poly[2 * i] = dx * ux + dy * uy + dz * uz; poly[2 * i + 1] = dx * vx + dy * vy + dz * vz; });
      const fine = triangulateCap(poly, this.cell * 0.36), sgn = 1;   // delaunay returns CCW in (u, v), where u x v = n
      const capTris = fine.tris;
      // 3D position of every cap point: the loop's own points exactly, interior points back from plane coordinates
      const p3 = fine.pts.map((q, i) => (i < pts.length ? pts[i].p : [px + ux * q[0] + vx * q[1], py + uy * q[0] + vy * q[1], pz + uz * q[0] + vz * q[1]]));
      // cap vertices: fresh copies per side (flagged as cut face), embedded in that side's tets
      for (const s of [1, -1]) {
        const ids = p3.map((pp) => { const h = embed(pp, s); if (!h) return -1; verts.push({ tet: h.tet, bary: h.bary, cap: 1 }); return verts.length - 1; });
        // The triangles have cross(b-a, c-a) . n = sign sgn. Convention (Babylon's left-handed one): cross points INWARD,
        // i.e. along +n for the + side's cap (whose outward normal is -n) and along -n for the - side's cap.
        const flip = s > 0 ? sgn < 0 : sgn > 0;
        for (let i = 0; i < capTris.length; i += 3) {
          const t0 = ids[capTris[i]], t1 = ids[capTris[i + 1]], t2 = ids[capTris[i + 2]];
          if (t0 < 0 || t1 < 0 || t2 < 0) continue;
          if (flip) tris.push(t0, t2, t1); else tris.push(t0, t1, t2);
        }
      }
    }
    // 8. install the new render mesh
    const nR = verts.length;
    this.rTet = new Int32Array(nR); this.rBary = new Float32Array(nR * 4); this.rCap = new Uint8Array(nR);
    verts.forEach((v, i) => { this.rTet[i] = v.tet; this.rBary.set(v.bary, 4 * i); this.rCap[i] = v.cap; });
    this.rIdx = Uint32Array.from(tris);
    this._finishRender();
  }
}


// ───────────────────────────── Babylon.js glue ─────────────────────────────
/**
 * Puts a SoftObject on screen and wires the pointer: tool "grab" drags the jelly about (it stretches and wobbles),
 * tool "knife" draws a line across the screen and cuts the object along it, tool "orbit" leaves the camera alone.
 * Returns { mesh, update(dtMs), setTool(name), cutAcross(x1,y1,x2,y2), nudge(), reset(), tool, onCut, dispose() }.
 * Options: material (a PBRMaterial; vertex colours from colorAt are applied on top), tool ("grab" default),
 * grabRadius (default 0.45), flipWinding (default false), onCut(result), onGrab(), onRelease().
 */
export function attachBabylon(BABYLON, scene, camera, canvas, obj, o = {}) {
  const mesh = new BABYLON.Mesh("softbody", scene);
  mesh.useVertexColors = true; mesh.hasVertexAlpha = false;
  if (o.material) mesh.material = o.material;
  mesh.alwaysSelectAsActiveMesh = true;
  const flip = o.flipWinding ?? false;
  let seen = -1, normals = new Float32Array(0);
  const world = { mesh, obj, tool: o.tool ?? "grab", onCut: o.onCut, onGrab: o.onGrab, onRelease: o.onRelease };

  const upload = () => {
    const idx = Array.from(obj.rIdx);
    if (flip) for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
    normals = new Float32Array(obj.rPos.length);
    BABYLON.VertexData.ComputeNormals(obj.rPos, idx, normals);
    const vd = new BABYLON.VertexData();
    vd.positions = Array.from(obj.rPos); vd.indices = idx; vd.normals = Array.from(normals); vd.colors = Array.from(obj.rColor);
    vd.applyToMesh(mesh, true);
    world._idx = idx; seen = obj.version;
  };
  upload();

  let acc = 0, cost = 0, frames = 0;
  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
  world.update = (dtMs) => {
    acc += Math.min(dtMs || 16, 50) / 1000;
    let steps = 0; const t0 = now();
    while (acc >= 1 / 60 && steps < 2) { obj.step(); acc -= 1 / 60; steps++; }
    if (acc > 1 / 30) acc = 0;
    // a slow machine gets fewer solver substeps (softer, less accurate) instead of a slideshow
    if (steps) {
      cost = cost * 0.9 + ((now() - t0) / steps) * 0.1;
      if (++frames % 20 === 0) { const sb = obj.sb; if (cost > 9 && sb.substeps > 4) sb.substeps--; else if (cost < 5 && sb.substeps < 10) sb.substeps++; }
    }
    if (steps === 0) return;
    obj.updateRender();
    if (seen !== obj.version) { upload(); return; }
    BABYLON.VertexData.ComputeNormals(obj.rPos, world._idx, normals);
    mesh.updateVerticesData(BABYLON.VertexBuffer.PositionKind, obj.rPos);
    mesh.updateVerticesData(BABYLON.VertexBuffer.NormalKind, normals);
    mesh.refreshBoundingInfo();
  };

  // ── knife overlay ──
  let svg = null, line = null;
  const ensureSvg = () => {
    if (svg) return;
    svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.style.cssText = "position:fixed;pointer-events:none;z-index:5;left:0;top:0;width:100vw;height:100vh;";
    line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("stroke", "#fff"); line.setAttribute("stroke-width", "2"); line.setAttribute("stroke-dasharray", "3 6"); line.setAttribute("stroke-linecap", "round");
    line.style.filter = "drop-shadow(0 0 2px rgba(0,0,0,.6))";
    svg.appendChild(line); document.body.appendChild(svg);
  };
  const showLine = (a, b) => { ensureSvg(); line.setAttribute("x1", a.x); line.setAttribute("y1", a.y); line.setAttribute("x2", b.x); line.setAttribute("y2", b.y); svg.style.display = ""; };
  const hideLine = () => { if (svg) svg.style.display = "none"; };

  const rect = () => canvas.getBoundingClientRect();
  const rayAt = (cx, cy) => { const r = rect(); return scene.createPickingRay((cx - r.left) * (canvas.width / r.width), (cy - r.top) * (canvas.height / r.height), BABYLON.Matrix.Identity(), camera); };

  /** Cut along the screen line (x1,y1) to (x2,y2): the cut sheet passes through the camera and both points. */
  world.cutAcross = (x1, y1, x2, y2) => {
    const a = rayAt(x1, y1).direction, b = rayAt(x2, y2).direction, p = camera.globalPosition ?? camera.position;
    const n = BABYLON.Vector3.Cross(a, b);
    if (n.length() < 1e-5) return { ok: false, reason: "the stroke was too short" };
    n.normalize();
    // make the plane pass through the object, not just the camera: it already does, since both rays start at the camera
    const res = obj.cut(p.x, p.y, p.z, n.x, n.y, n.z);
    endGrab();
    if (res.ok) upload();
    world.onCut?.(res);
    return res;
  };

  // ── pointer ──
  let grabbing = false, plane = null, start = null, knifing = false, camDetached = false;
  const detach = () => { if (!camDetached) { camera.detachControl(); camDetached = true; } };
  const attach = () => { if (camDetached) { camera.attachControl(canvas, true); camDetached = false; } };
  const endGrab = () => { if (grabbing) { obj.sb.endGrab(); grabbing = false; plane = null; world.onRelease?.(); } };

  const onDown = (e) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    if (world.tool === "knife") { start = { x: e.clientX, y: e.clientY }; knifing = true; detach(); return; }
    if (world.tool !== "grab") return;
    const r = rect();
    const pick = scene.pick((e.clientX - r.left) * (canvas.width / r.width), (e.clientY - r.top) * (canvas.height / r.height), (m) => m === mesh);
    if (!pick?.hit || !pick.pickedPoint) return;
    detach();
    const p = pick.pickedPoint;
    obj.sb.beginGrab([p.x, p.y, p.z], o.grabRadius ?? 0.45);
    grabbing = true;
    plane = BABYLON.Plane.FromPositionAndNormal(p, camera.getForwardRay().direction.scale(-1));
    world.onGrab?.();
  };
  const onMove = (e) => {
    if (knifing && start) { showLine(start, { x: e.clientX, y: e.clientY }); return; }
    if (!grabbing || !plane) return;
    const ray = rayAt(e.clientX, e.clientY);
    const d = ray.intersectsPlane(plane);
    if (d == null) return;
    const q = ray.origin.add(ray.direction.scale(d));
    obj.sb.moveGrab([q.x, q.y, q.z]);
  };
  const onUp = (e) => {
    if (knifing && start) {
      hideLine();
      const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y);
      if (moved > 24) world.cutAcross(start.x, start.y, e.clientX, e.clientY);
      start = null; knifing = false; attach(); return;
    }
    if (grabbing) { endGrab(); attach(); }
  };
  canvas.addEventListener("pointerdown", onDown);
  addEventListener("pointermove", onMove);
  addEventListener("pointerup", onUp);
  addEventListener("pointercancel", onUp);
  canvas.style.touchAction = "none";

  world.setTool = (t) => { world.tool = t; endGrab(); knifing = false; hideLine(); attach(); canvas.style.cursor = t === "knife" ? "crosshair" : t === "grab" ? "grab" : "move"; };
  world.setTool(world.tool);
  world.nudge = (s = 1) => obj.sb.nudge(s);
  world.reset = () => { endGrab(); obj.reset(); upload(); };
  world.dispose = () => {
    canvas.removeEventListener("pointerdown", onDown); removeEventListener("pointermove", onMove); removeEventListener("pointerup", onUp); removeEventListener("pointercancel", onUp);
    svg?.remove(); mesh.dispose(); attach();
  };
  return world;
}
