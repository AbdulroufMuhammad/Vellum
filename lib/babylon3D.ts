/**
 * How the agent builds realistic 3D scenes with Babylon.js, and the hook that lets the browser
 * check inspect the scene. Babylon.js is the engine for 3D builds (moved from three.js): it needs
 * far less manual setup to get a correct-looking result (shadows, environment lighting, camera
 * controls are one call each, not fifteen lines of boilerplate), and its CSG2 (built on the
 * Manifold library) computes real boolean cuts, both verified directly in this app's sandboxed
 * headless check before being written up here.
 *
 * HDRIs and the real-model library are shared with the (still-supported, for older projects)
 * three.js path in lib/threeD.ts: an .hdr file or a .glb/.gltf model is just a file, not tied to
 * either engine.
 */
import { HDRIS, MODEL_LIBRARY, is3DRequest } from "@/lib/threeD";

export { HDRIS, MODEL_LIBRARY, is3DRequest };

const BABYLON_VERSION = "7.54.3";
const BABYLON_CDN = `https://cdn.jsdelivr.net/npm/@babylonjs/core@${BABYLON_VERSION}`; // CSG2 ships inside @babylonjs/core, no separate package

/** The agent's playbook for realistic 3D with Babylon.js, added to its instructions for 3D requests. */
export function babylonGuide() {
  return `## Realistic 3D (Babylon.js)
Aim for a product-render look, not a toy: correct silhouette and proportions, nothing floating, believable materials and light.

Plan (in the plan's sections): the object's real dimensions in metres; a parts list, each with its size, shape technique, material and exactly what it attaches to (parent part and contact point); the camera views that show it best.

Setup: import Babylon from the CDN as ES modules (no build step, one <script type="module">):
\`\`\`
<script type="importmap">{"imports":{"@babylonjs/core":"${BABYLON_CDN}/+esm","@babylonjs/loaders":"https://cdn.jsdelivr.net/npm/@babylonjs/loaders@${BABYLON_VERSION}/+esm"}}</script>
\`\`\`
\`const BABYLON = await import("@babylonjs/core"); const engine = new BABYLON.Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true }); const scene = new BABYLON.Scene(engine);\` Real models first: if the request is (or contains) one of these, load it with SceneLoader instead of modelling it (\`await BABYLON.SceneLoader.ImportMeshAsync("", "", url, scene)\`, importing "@babylonjs/loaders" for glTF support), then light and present it well:
${MODEL_LIBRARY.map((m) => `- ${m.name} (${m.what}): ${m.url}`).join("\n")}

Modelling (when no real model fits): never assemble an object from generic boxes, spheres and cylinders, even if a request or process says "simple shapes"; that reads as a toy. Model each part's real form.
- Build in real units (1 unit = 1 metre) around one origin; parent every part to its parent part (mesh.parent = hull, positioned relative to it) so parts sit exactly on or in what they attach to. Nothing may float: every part touches its parent.
- Pick the technique per part: MeshBuilder.CreateLathe (a "shape" profile array of points revolved around Y) for anything turned or round (bottles, nozzles, bodies, wheels); MeshBuilder.ExtrudeShape or ExtrudeShapeCustom along a path for panels and profiles with thickness (give the 2D profile rounded corners with a short arc of points instead of hard corners); MeshBuilder.CreateTube along a Curve3 (Curve3.CreateCatmullRomSpline through the two parts' real anchor points) for pipes and cables; mesh.createInstance("name") for repeats (track links, bolts, rivets, cooling tubes) — much cheaper than cloning, and the automatic check treats a handful of instances as one part, so don't create more than a few hundred.
- Cut detail, don't fake it: a hatch, vent, bolt hole, recessed panel or access port is a real cut through the surface, not a dark decal painted on top, which reads as flat the moment the camera isn't square-on. Initialize once per page with \`await BABYLON.InitializeCSG2Async();\`, then for each cut: \`const a = BABYLON.CSG2.FromMesh(base); const b = BABYLON.CSG2.FromMesh(cutterMesh); const result = a.subtract(b).toMesh("name", scene); base.dispose(); cutterMesh.dispose();\` CSG2.add(other) unions two CSG2 objects (for a compound cutter); .intersect(other) keeps only the overlap.
- Batch repeated cuts, never chain them one at a time: subtracting against an already-cut, ever-growing result gets much slower per cut as it grows, and a hull covered in individually chained bolt holes and vents can make the browser check itself crash or time out. For a row of bolt holes, rivets or vents, first .add() all the cutter CSG2 objects together into one compound cutter, THEN .subtract() that compound cutter from the base ONCE. Keep round cutters low-poly (tessellation 10 to 16 is plenty for a bolt hole) since every cutter's triangles add to the cost.
- Garments and soft goods: model from the real pattern silhouette (a 2D Shape of the flat garment, extruded thinly with a bevel, then gently displaced), not from cylinders; a T-shirt reads as a flat-lay or on an invisible form.
- Soften every hard edge (a small bevel/fillet, or mesh.convertToFlatShadedMesh() only where a hard edge is correct), add small real details at the right scale (seams, panel lines, bolts), and check proportions against the real object's dimensions.

Materials and light — this is where Babylon needs far less code than a from-scratch renderer:
- PBRMaterial with real values: \`mat.metallic\` and \`mat.roughness\` (metals metallic 1 and roughness 0.2 to 0.5, painted metal metallic 0 to 0.3 with mat.clearCoat.isEnabled = true, rubber roughness 0.9, fabric roughness 0.85, glass via mat.subSurface.isRefractionEnabled = true). Add surface texture with a CanvasTexture-equivalent (a <canvas> drawn with noise/grain/weave/scratches, then \`new BABYLON.DynamicTexture(...)\` or a data URL through \`new BABYLON.Texture(dataUrl, scene)\`) used as mat.bumpTexture or mat.microSurfaceTexture (inverted, for roughness variation).
- Light with an HDRI: \`scene.environmentTexture = new BABYLON.HDRCubeTexture(url, scene, 128); scene.environmentIntensity = 1.1;\` — every PBRMaterial picks this up automatically for realistic reflections and ambient light, no per-material wiring needed:
${HDRIS.map((h) => `  - ${h.name} (${h.mood}): ${h.url}`).join("\n")}
  Add one directional key light with real shadows: \`const sun = new BABYLON.DirectionalLight("sun", direction, scene); sun.position = ...; const shadowGen = new BABYLON.ShadowGenerator(1024, sun); shadowGen.useBlurExponentialShadowMap = true; shadowGen.addShadowCaster(mesh);\` for each part that should cast one, and \`mesh.receiveShadows = true\` for the ground.
- A ground plane (MeshBuilder.CreateGround) with mesh.receiveShadows = true and mesh.metadata = { ground: true } (see the check hook below) keeps the model grounded, not floating in void.

Camera and checks:
- Use an ArcRotateCamera and fit it to the model, not a guessed distance: after building, compute the model's world bounding box (union each part's \`mesh.getBoundingInfo().boundingBox.minimumWorld/maximumWorld\`), get its centre and radius (half the box diagonal), then \`camera.setTarget(centre); camera.radius = radius / Math.sin((camera.fov ?? 0.8) / 2) * 1.3;\` so it fills about 60 to 75% of the frame and is never cut off. \`camera.attachControl(canvas, true)\` for orbit controls with damping (\`camera.inertia = 0.85\`) and sensible \`camera.lowerRadiusLimit\` / \`upperRadiusLimit\`.
- Keep all the scene code in ONE <script type="module"> (if the file is written in parts, the whole script goes in the last part).
- Right after building the scene, expose it for the automatic check: \`window.__vellumBabylon = { BABYLON, scene, camera, engine };\` name each part's mesh (mesh.name = "turret") and mark floors with mesh.metadata = { ground: true } and any backdrop, sweep or dome with mesh.metadata = { backdrop: true } (a backdrop material with backFaceCulling = false, the usual way to see the inside of a dome, is also recognised automatically). The check photographs the model from several angles and flags parts that float, a model cut off by the frame, or spanning under 40% of it.
- Start the render loop last: \`engine.runRenderLoop(() => scene.render()); addEventListener("resize", () => engine.resize());\``;
}
