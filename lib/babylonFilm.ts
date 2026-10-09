/**
 * The agent's recipes for the "film look" (WebGPU-first rendering, post-processing, believable materials)
 * and for physics with Havok (bouncing, grabbing, detachable parts). Every snippet here was run in headless
 * Chromium against the real CDN builds before being written down; they're meant to be copied, not improvised.
 */
const BABYLON_VERSION = "7.54.3";
const HAVOK_VERSION = "1.3.10";
const HAVOK_JS = `https://cdn.jsdelivr.net/npm/@babylonjs/havok@${HAVOK_VERSION}/lib/esm/HavokPhysics_es.js`;
const HAVOK_WASM = `https://cdn.jsdelivr.net/npm/@babylonjs/havok@${HAVOK_VERSION}/lib/esm/HavokPhysics.wasm`;

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
- Soft, wobbly, squishy things (jelly, a melon, a cushion) are not rigid bodies. Fake them well by squashing the mesh from the impact (scale along the impact normal, down to about 0.85, and spring back over about 0.4 s with an overshoot) on top of a low-restitution rigid body; a real soft-body (cuttable jelly) is a much bigger system than this guide covers.
- Keep the step stable: the physics runs at a fixed rate on its own; never change body positions every frame for a body you also want simulated. Don't call scene.render() yourself; use engine.runRenderLoop.
`;
}
