// Regression test for lib3d/softbody.js: node scripts/test-softbody.mjs
import { sd, SoftObject } from "../lib3d/softbody.js";

let failed = 0;
const check = (name, ok, extra = "") => { console.log((ok ? "ok   " : "FAIL ") + name + (extra ? "  " + extra : "")); if (!ok) failed++; };

const make = (cell = 0.15) => new SoftObject({
  sdf: sd.ellipsoid(0, 0.8, 0, 0.75, 0.8, 0.75), bounds: { min: [-1, -0.1, -1], max: [1, 1.8, 1] }, cell, drop: 0.5, firmness: 0.5,
  colorAt: (x, y, z, d, cap) => (cap ? [0.9, 0.2, 0.25] : [0.2, 0.5, 0.2]),
});

const t0 = Date.now();
const obj = make();
check("builds in under 2 s", Date.now() - t0 < 2000, `${Date.now() - t0} ms, ${obj.sb.nT} tets, ${obj.rTet.length} render vertices`);
check("one piece to start", obj.pieces === 1);

// winding: Babylon's convention has cross(b-a, c-a) pointing inward
let outward = 0;
for (let f = 0; f < obj.rIdx.length; f += 3) {
  const P = [0, 1, 2].map((k) => [obj.rPos[3 * obj.rIdx[f + k]], obj.rPos[3 * obj.rIdx[f + k] + 1], obj.rPos[3 * obj.rIdx[f + k] + 2]]);
  const u = P[1].map((v, k) => v - P[0][k]), w = P[2].map((v, k) => v - P[0][k]);
  const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
  const m = [P[0][0], P[0][1] - 0.8, P[0][2]];
  if (n[0] * m[0] + n[1] * m[1] + n[2] * m[2] > 0) outward++;
}
check("surface winding is consistent", outward === 0, `${outward} flipped`);

for (let i = 0; i < 200; i++) obj.step();
check("stays finite and keeps its volume", [...obj.sb.x].every(Number.isFinite) && Math.abs(obj.sb.volumeRatio() - 1) < 0.03, `volume ratio ${obj.sb.volumeRatio().toFixed(3)}`);
check("no inverted elements", obj.sb.minVolumeRatio() > 0.2, `min ${obj.sb.minVolumeRatio().toFixed(2)}`);
const c = obj.sb.centroid();
check("does not drift sideways", Math.hypot(c[0], c[2]) < 0.15, `centroid (${c[0].toFixed(2)}, ${c[2].toFixed(2)})`);

const miss = obj.cut(c[0] + 5, c[1], c[2], 1, 0, 0);
check("a cut that misses is refused", miss.ok === false);
const res = obj.cut(c[0], c[1], c[2], 1, 0, 0);
check("a cut makes two pieces", res.ok && obj.pieces === 2, `${obj.pieces} pieces`);
check("render indices are valid", [...obj.rIdx].every((i) => i < obj.rTet.length));
check("cut faces exist", obj.rCap.reduce((a, b) => a + b, 0) > 100, `${obj.rCap.reduce((a, b) => a + b, 0)} cap vertices`);
const res2 = obj.cut(obj.sb.centroid()[0] + 1.5, c[1], c[2], 1, 0, 0);
for (let i = 0; i < 240; i++) obj.step();
obj.updateRender();
check("pieces stay finite after settling", [...obj.rPos].every(Number.isFinite) && [...obj.sb.x].every(Number.isFinite));
const second = make(); for (let i = 0; i < 100; i++) second.step();
const c2 = second.sb.centroid();
const r = second.cut(c2[0], c2[1], c2[2], 1, 0.3, 0.2); const r2 = second.cut(c2[0] - 0.4, c2[1], c2[2], 0, 0, 1);
check("cuts can be repeated", r.ok && second.pieces >= 3, `${second.pieces} pieces after two cuts (second ok=${r2.ok})`);
void res2;
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
