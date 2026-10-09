/**
 * The agent's recipes for the "film look" (WebGPU-first rendering, post-processing, believable materials)
 * and for physics with Havok (bouncing, grabbing, detachable parts). Every snippet here was run in headless
 * Chromium against the real CDN builds before being written down; they're meant to be copied, not improvised.
 */
const BABYLON_VERSION = "7.54.3";
const HAVOK_VERSION = "1.3.10";
const HAVOK_JS = `https://cdn.jsdelivr.net/npm/@babylonjs/havok@${HAVOK_VERSION}/lib/esm/HavokPhysics_es.js`;
const HAVOK_WASM = `https://cdn.jsdelivr.net/npm/@babylonjs/havok@${HAVOK_VERSION}/lib/esm/HavokPhysics.wasm`;

/**
 * The soft-body toolkit (lib3d/softbody.js in this repo), served by jsDelivr at a fixed commit so a design never changes under
 * the user. When the file changes, point SOFTBODY_REF at the new commit.
 */
export const SOFTBODY_REF = "9d33ea00c0089edffcd6af5f7d63e7385e3c94e9";
export const SOFTBODY_URL = `https://cdn.jsdelivr.net/gh/AbdulroufMuhammad/Vellum@${SOFTBODY_REF}/lib3d/softbody.js`;

/** Whether a request wants physics (things that fall, bounce, break apart, get grabbed or sliced). */
export function wantsPhysics(request: string) {
  return /\b(physics|bounc\w*|drag\w*|grab\w*|throw\w*|toss\w*|fall\w*|drop\w*|collid\w*|collision|ragdoll|detach\w*|pull\w* (off|out|apart)|pop\w* (off|out)|break\w*|shatter\w*|smash\w*|topple|stack\w*|pile|jelly|wobbl\w*|squish\w*|soft[- ]?body|slic\w*|cut\w*|knife)\b/i.test(request);
}

/** Engine boot, post-processing and material rules: added to every 3D request. */
export function filmLookGuide() {
  return String.raw`Engine: WebGPU first, WebGL as the automatic fallback (WebGPU runs on the visitor's own GPU, so it costs nothing to host). Boot the engine like this, exactly; checking for a real adapter first keeps the fallback silent:
const adapter = navigator.gpu ? await navigator.gpu.requestAdapter().catch(() => null) : null;
let engine = null;
if (adapter) { try { engine = new BABYLON.WebGPUEngine(canvas, { antialias: true, stencil: true, adaptToDeviceRatio: true }); await engine.initAsync(); } catch (e) { engine = null; } }
if (!engine) engine = new BABYLON.Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true, adaptToDeviceRatio: true });
Write everything after that against the engine-agnostic API (no raw WebGL calls), so both paths work. A ShaderMaterial written in GLSL won't run on WebGPU: use PBRMaterial, StandardMaterial or NodeMaterial instead, and a custom effect goes through a post-process only if the request truly needs it.

Film look (every 3D scene gets this, it is most of the difference between a toy and a render):
- Every mesh needs a PBRMaterial. A mesh left on Babylon's default material is unlit and renders pure black under environment lighting, which is the most common reason a scene looks empty.
- Lighting = one HDRI (scene.environmentTexture, intensity about 1) plus one DirectionalLight key with a ShadowGenerator (sun.intensity about 1.4 to 2, not more: higher blows the floor out to white).
- Post-processing, one pipeline: const pipe = new BABYLON.DefaultRenderingPipeline("film", true, scene, [camera]); pipe.samples = 4; pipe.bloomEnabled = true; pipe.bloomThreshold = 0.9; pipe.bloomWeight = 0.2; pipe.imageProcessingEnabled = true; pipe.imageProcessing.toneMappingEnabled = true; pipe.imageProcessing.toneMappingType = BABYLON.ImageProcessingConfiguration.TONEMAPPING_ACES; pipe.imageProcessing.exposure = 0.9; pipe.imageProcessing.contrast = 1.1; pipe.imageProcessing.vignetteEnabled = true;
- Contact shadows and depth: on WebGL only, add new BABYLON.SSAO2RenderingPipeline("ssao", scene, { ssaoRatio: 0.5, blurRatio: 1 }, [camera]); (skip it when the engine is a WebGPUEngine).
- Materials that sell the realism: PBRMaterial with the right physics: clearCoat for painted, waxy, wet or fruit skin; subSurface.isTranslucencyEnabled (and subSurface.tintColor) for flesh, jelly, wax, leaves and ears; subSurface.isRefractionEnabled with indexOfRefraction about 1.33 to 1.5 for glass, liquid and jelly; sheen for cloth; bone and teeth are off-white (about 0.9, 0.87, 0.78) with roughness 0.4 to 0.6, never pure white; give surfaces micro detail with a bumpTexture drawn on a canvas (noise, pores, grain).
- Never leave edges razor sharp: a thin bevel or a rounded form catches the light and is what reads as real.
`;
}

/** Physics recipes (Havok): added when the request involves things that move, fall, break or get grabbed. */
export function physicsGuide() {
  return String.raw`## Physics (Havok)
Real rigid-body physics, running in the browser on the visitor's machine. Add it to the importmap and boot it once, before creating bodies:
"@babylonjs/havok": "${HAVOK_JS}" in the importmap, then:
const { default: HavokPhysics } = await import("@babylonjs/havok");
const havok = await HavokPhysics({ locateFile: () => "${HAVOK_WASM}" });
scene.enablePhysics(new BABYLON.Vector3(0, -9.81, 0), new BABYLON.HavokPlugin(true, havok));
Units are metres and kilograms: model at real size and give real masses (a tooth is about 0.003 kg, a melon about 4 kg, a skull about 0.7 kg; a mass far from real looks wrong when it falls).

- Bodies: const agg = new BABYLON.PhysicsAggregate(mesh, BABYLON.PhysicsShapeType.SPHERE | BOX | CAPSULE | CYLINDER | CONVEX_HULL | MESH, { mass, restitution, friction }, scene). mass 0 is a fixed body (floor, walls, anything that never moves). Use CONVEX_HULL for irregular solids, never MESH for a moving body (only for static ones). The mesh follows the body automatically; read agg.body for velocity and impulses.
- Bounce: restitution is the bounciness (rubber ball 0.85, melon 0.35, wood 0.4, stone 0.1). Set it on BOTH the moving body and the floor; the two are combined. Soft things: low restitution plus high friction plus linear/angular damping (agg.body.setLinearDamping(0.2)).
- Walls and a floor of real thickness, so fast bodies can't tunnel through: a floor box at least 0.5 m thick, not a zero-thickness plane.
- Grab and throw (the interaction people expect): on pointerdown, scene.pick(); if it hit a mesh with a body, remember it and a drag plane facing the camera through the hit point (BABYLON.Plane.FromPositionAndNormal(hit.pickedPoint, camera.getForwardRay().direction)); on pointermove, ray = scene.createPickingRay(x, y, BABYLON.Matrix.Identity(), camera), find where it crosses the plane (ray.intersectsPlane(plane) gives the distance), and every frame steer the body to that target with body.setLinearVelocity(target.subtract(pos).scale(12)) and body.setAngularVelocity(BABYLON.Vector3.Zero()); on pointerup just let go, so it keeps its velocity and is thrown. Set camera.detachControl() while dragging a body and attachControl() after, so the camera doesn't orbit at the same time.
- Detachable parts (a skull's teeth, a toy's wheels, a lid, a pin): lock the part to its parent with a constraint, then break it when it's pulled hard enough.
  const lock = new BABYLON.LockConstraint(pivotInParent, pivotInPart, axisInParent, axisInPart, scene); parentAgg.body.addConstraint(partAgg.body, lock);
  pivotInParent is the joint position relative to the parent mesh's centre, pivotInPart relative to the part's centre, and the part's mesh must already sit at its real place on the parent. Make the part a dynamic body (mass above 0, small) and the parent mass 0 or heavy.
  To break it: each frame, while the part is being dragged, measure how far it has been pulled from its rest position (part.position.subtract(restPosition).length()); past a threshold (about 0.04 m for a tooth, with a slight wobble allowed first by easing the pull) call lock.dispose() once, mark the part detached, and from then on it's an ordinary free body that falls, bounces and can be thrown. For a loose-feeling joint use BABYLON.Physics6DoFConstraint with limits instead of a rigid lock.
  Hide nothing: when a part comes out, whatever was under it (a socket, a root, a hole) must already exist in the parent, so build the cavity into the parent before the part is attached.
- Stacks, piles and toppling: lots of identical bodies: use one PhysicsAggregate per instance (clone the mesh, don't merge them), give them slight random rotation and offset so they don't land in a perfect column, and keep the count modest (under about 150 bodies) so it stays at 60 fps.
- A reset button that puts every body back: store each body's start position and rotation, then on reset set mesh.position / mesh.rotationQuaternion back AND call body.setLinearVelocity(Vector3.Zero()) and body.setAngularVelocity(Vector3.Zero()); re-create any constraint you disposed.
- Soft, wobbly, squishy things (jelly, a melon, pudding, dough) that get squashed, stretched or sliced are NOT rigid bodies: use the soft-body toolkit (its own section, when present) for them, not Havok. Havok is for hard things.
- Keep the step stable: the physics runs at a fixed rate on its own; never change body positions every frame for a body you also want simulated. Don't call scene.render() yourself; use engine.runRenderLoop.
`;
}

/** Whether a request is for something squishy that gets grabbed, squashed or sliced (jelly, fruit, pudding, dough). */
export function wantsSoftBody(request: string) {
  return /\b(jelly|jello|pudding|gelatin|melon|watermelon|squish\w*|squash\w*|squeez\w*|wobbl\w*|jiggl\w*|soft[- ]?body|slic\w*|sliceable|cuttable|knife|cut (it|them|open|in half|through)|stretch\w*|dough|cake|cheese|blob|fruit)\b/i.test(request);
}

/** Soft-body recipe: squishy, grabbable, sliceable objects, using the toolkit (no hand-written physics). */
export function softBodyGuide() {
  return String.raw`## Soft bodies you can squash, stretch and slice (jelly, melon, pudding, dough, cheese, cake)
Never write your own soft-body physics: use the toolkit below. It's a tested library that runs on the visitor's machine: a real tetrahedral soft-body simulation (the object keeps its volume, wobbles, stretches when grabbed, settles on the floor) and a real plane cut (the object is sliced into separate pieces with flat cut faces that fall apart). It works with the Babylon.js setup above; nothing else is needed.

Import it (inside the same module script, after the engine and scene exist):
const { sd, SoftObject, attachBabylon } = await import("${SOFTBODY_URL}");

1. Describe the shape as a signed-distance function made of sd helpers (all return (x,y,z) => distance, negative inside): sd.sphere(cx,cy,cz,r), sd.ellipsoid(cx,cy,cz,rx,ry,rz), sd.box(cx,cy,cz,hx,hy,hz,round), sd.capsule(ax,ay,az,bx,by,bz,r), sd.torus(cx,cy,cz,R,r), and the combinators sd.union(...), sd.smoothUnion(k, ...) (blends like clay), sd.subtract(a,b), sd.intersect(...), sd.scale(f,sx,sy,sz). Model it about 1 to 2 units across and resting on y = 0 (the floor); real centimetre sizes fall too fast to look soft. bounds is a box that contains it with a little margin.
2. new SoftObject({ sdf, bounds, cell, firmness, damping, drop, softnessAt, colorAt }):
   - cell: the simulation element size, default 0.14 (use 0.14 to 0.18; smaller is slower, and keep a 1.5 unit object under about 5000 elements, which cell 0.14 gives).
   - firmness 0 to 1 (jelly 0.25, pudding 0.35, dough 0.4, melon 0.55, cheese 0.8) and damping 0 to 1 (default 0.45; lower is bouncier). drop lifts it above rest so it falls and wobbles on load (0.3 to 0.5 looks good).
   - softnessAt(x, y, z, depth) returns a multiplier (above 1 softer, below 1 stiffer): a firm rind is depth > -0.1 ? 0.5 : 1.
   - colorAt(x, y, z, depth, isCap) returns [r, g, b] for a vertex: depth is how far inside the original surface the point is (0 at the skin, more negative deeper); isCap is true on faces exposed by a cut. Paint the skin, and the inside, here: a watermelon is rind green for depth > -0.1, pale pith to -0.2, red flesh deeper; dark seeds are small spots, e.g. flesh with Math.sin(x*23+y*7)*Math.sin(z*19+y*11) > 0.93 as near-black. Cut faces must show the inside colours, never the skin colour.
3. attachBabylon(BABYLON, scene, camera, canvas, obj, { material, tool }) puts it on screen and wires the pointer. The material is a PBRMaterial with albedoColor white (the vertex colours from colorAt tint it); set roughness about 0.35 and clearCoat for glossy skin. It returns world with: world.update(engine.getDeltaTime()) (call it every frame, before scene.render()), world.setTool("grab" | "knife" | "orbit"), world.reset(), world.nudge() (a little hop and wobble), world.mesh (add it as a shadow caster; shadowGen.addShadowCaster(world.mesh)), world.obj.pieces (how many pieces exist), world.onCut = (result) => ..., world.cutAcross(x1, y1, x2, y2) (screen pixels).
   - Grab: press on the object and drag: it stretches and wobbles; let go and it springs back, or is thrown. Knife: draw a line across the object on screen and it is cut along that line, through to the back; draw more lines to cut the pieces further. Orbit: the camera moves instead.
4. Always give the page a toolbar of real buttons: Grab, Knife, Orbit, Reset, and a short hint ("Drag to squish. Knife: draw a line across it."), with the active tool highlighted, and call world.setTool when one is pressed. Start on "grab".
5. Render loop: engine.runRenderLoop(() => { world.update(engine.getDeltaTime()); scene.render(); }); and expose window.__vellumBabylon = { BABYLON, scene, camera, engine }.

Limits (design within them): the floor is the plane y = 0 (a visible ground mesh at y = 0 matches it); there are no walls, and soft objects don't collide with each other or with Havok bodies, so don't mix them in one scene region. One SoftObject is one connected piece at the start (several separate soft things: several SoftObjects far apart). It is for jelly-like solids, not liquids, hair or cloth. Details painted by colorAt travel with the body and are cut with it; separate meshes (seeds, a stem) are not part of the simulation, so paint those instead.

A complete working scene (copy its structure, change the shape, colours and UI):
const adapter = navigator.gpu ? await navigator.gpu.requestAdapter().catch(() => null) : null;
let engine = null;
if (adapter) { try { engine = new BABYLON.WebGPUEngine(canvas, { antialias: true, stencil: true, adaptToDeviceRatio: true }); await engine.initAsync(); } catch (e) { engine = null; } }
if (!engine) engine = new BABYLON.Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true, adaptToDeviceRatio: true });
const scene = new BABYLON.Scene(engine);
const camera = new BABYLON.ArcRotateCamera("cam", -Math.PI / 2, 1.15, 4.6, new BABYLON.Vector3(0, 0.7, 0), scene);
camera.attachControl(canvas, true);
scene.environmentTexture = new BABYLON.HDRCubeTexture("https://cdn.jsdelivr.net/gh/mrdoob/three.js@r170/examples/textures/equirectangular/royal_esplanade_1k.hdr", scene, 128);
const sun = new BABYLON.DirectionalLight("sun", new BABYLON.Vector3(-0.5, -1, 0.6), scene); sun.position = new BABYLON.Vector3(5, 10, -6); sun.intensity = 1.6;
const shadows = new BABYLON.ShadowGenerator(1024, sun); shadows.useBlurExponentialShadowMap = true; shadows.blurKernel = 24;
const ground = BABYLON.MeshBuilder.CreateGround("ground", { width: 30, height: 30 }, scene);
const groundMat = new BABYLON.PBRMaterial("groundMat", scene); groundMat.albedoColor = new BABYLON.Color3(0.8, 0.77, 0.72); groundMat.roughness = 0.9; groundMat.metallic = 0;
ground.material = groundMat; ground.receiveShadows = true; ground.metadata = { ground: true };
const { sd, SoftObject, attachBabylon } = await import("${SOFTBODY_URL}");
const obj = new SoftObject({
  sdf: sd.ellipsoid(0, 0.85, 0, 0.8, 0.85, 0.8), bounds: { min: [-1, -0.1, -1], max: [1, 1.8, 1] }, cell: 0.15, drop: 0.4, firmness: 0.55,
  softnessAt: (x, y, z, depth) => (depth > -0.1 ? 0.5 : 1),
  colorAt: (x, y, z, depth, isCap) => {
    if (depth > -0.1) return isCap ? [0.55, 0.78, 0.4] : [0.2, 0.5, 0.18];
    if (depth > -0.2) return [0.95, 0.92, 0.8];
    return Math.sin(x * 23 + y * 7) * Math.sin(z * 19 + y * 11) > 0.93 ? [0.08, 0.05, 0.05] : [0.93, 0.2, 0.3];
  },
});
const skin = new BABYLON.PBRMaterial("skin", scene); skin.albedoColor = new BABYLON.Color3(1, 1, 1); skin.roughness = 0.35; skin.metallic = 0; skin.clearCoat.isEnabled = true; skin.clearCoat.intensity = 0.5;
const world = attachBabylon(BABYLON, scene, camera, canvas, obj, { material: skin, tool: "grab" });
shadows.addShadowCaster(world.mesh);
const pipe = new BABYLON.DefaultRenderingPipeline("film", true, scene, [camera]);
pipe.samples = 4; pipe.imageProcessingEnabled = true; pipe.imageProcessing.toneMappingEnabled = true; pipe.imageProcessing.toneMappingType = BABYLON.ImageProcessingConfiguration.TONEMAPPING_ACES; pipe.imageProcessing.exposure = 0.9;
engine.runRenderLoop(() => { world.update(engine.getDeltaTime()); scene.render(); });
addEventListener("resize", () => engine.resize());
window.__vellumBabylon = { BABYLON, scene, camera, engine };
// toolbar: buttons call world.setTool("grab"), world.setTool("knife"), world.setTool("orbit"), world.reset(); highlight the active one
`;
}
