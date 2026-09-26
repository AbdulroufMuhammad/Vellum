/**
 * How the agent builds realistic 3D scenes (three.js), what real assets it can
 * use, and the hook that lets the browser check inspect the scene.
 *
 * Every URL here is served by cdn.jsdelivr.net (an allowed host) and was
 * checked to load. Models are the Khronos glTF sample assets and three.js's
 * example models; HDRIs are three.js's example environment maps.
 */
const THREE_VERSION = "0.170.0";
const THREE_GH = "https://cdn.jsdelivr.net/gh/mrdoob/three.js@r170";
const KHRONOS = "https://cdn.jsdelivr.net/gh/KhronosGroup/glTF-Sample-Assets@main/Models";

export const HDRIS: { name: string; mood: string; url: string }[] = [
  { name: "Royal esplanade", mood: "bright, soft daylight; product shots", url: `${THREE_GH}/examples/textures/equirectangular/royal_esplanade_1k.hdr` },
  { name: "Venice sunset", mood: "warm golden sunset", url: `${THREE_GH}/examples/textures/equirectangular/venice_sunset_1k.hdr` },
  { name: "Quarry", mood: "neutral overcast outdoors; vehicles, machinery", url: `${THREE_GH}/examples/textures/equirectangular/quarry_01_1k.hdr` },
  { name: "Pedestrian overpass", mood: "urban, cool daylight", url: `${THREE_GH}/examples/textures/equirectangular/pedestrian_overpass_1k.hdr` },
  { name: "Moonless golf", mood: "dark night; dramatic studio-like contrast", url: `${THREE_GH}/examples/textures/equirectangular/moonless_golf_1k.hdr` },
  { name: "San Giuseppe bridge", mood: "crisp outdoor daylight, higher detail (2k)", url: `${THREE_GH}/examples/textures/equirectangular/san_giuseppe_bridge_2k.hdr` },
];

/** Real, freely licensed glTF models to use when the request is one of these things (or includes one). */
export const MODEL_LIBRARY: { name: string; what: string; url: string }[] = [
  { name: "Damaged sci-fi helmet", what: "battle-worn sci-fi flight helmet", url: `${THREE_GH}/examples/models/gltf/DamagedHelmet/glTF/DamagedHelmet.gltf` },
  { name: "Flight helmet", what: "WWII leather pilot helmet with goggles on a stand", url: `${KHRONOS}/FlightHelmet/glTF/FlightHelmet.gltf` },
  { name: "Ferrari", what: "detailed sports car (body, wheels, glass as separate meshes)", url: `${THREE_GH}/examples/models/gltf/ferrari.glb` },
  { name: "Car concept", what: "modern concept car", url: `${KHRONOS}/CarConcept/glTF-Binary/CarConcept.glb` },
  { name: "Toy car", what: "small toy car with fabric and clearcoat", url: `${KHRONOS}/ToyCar/glTF-Binary/ToyCar.glb` },
  { name: "Sneaker", what: "sneaker with several material variants", url: `${KHRONOS}/MaterialsVariantsShoe/glTF-Binary/MaterialsVariantsShoe.glb` },
  { name: "Chronograph watch", what: "wristwatch with working-looking dial", url: `${KHRONOS}/ChronographWatch/glTF-Binary/ChronographWatch.glb` },
  { name: "Sunglasses", what: "sunglasses with tinted lenses", url: `${KHRONOS}/SunglassesKhronos/glTF-Binary/SunglassesKhronos.glb` },
  { name: "Velvet sofa", what: "velvet sofa", url: `${KHRONOS}/GlamVelvetSofa/glTF-Binary/GlamVelvetSofa.glb` },
  { name: "Fabric chair", what: "armchair with sheen fabric", url: `${KHRONOS}/SheenChair/glTF-Binary/SheenChair.glb` },
  { name: "Antique camera", what: "antique bellows camera on a tripod", url: `${KHRONOS}/AntiqueCamera/glTF-Binary/AntiqueCamera.glb` },
  { name: "Boombox", what: "retro boombox", url: `${KHRONOS}/BoomBox/glTF-Binary/BoomBox.glb` },
  { name: "Lantern", what: "old street lantern", url: `${KHRONOS}/Lantern/glTF-Binary/Lantern.glb` },
  { name: "Water bottle", what: "metal water bottle", url: `${KHRONOS}/WaterBottle/glTF-Binary/WaterBottle.glb` },
  { name: "Iridescent lamp", what: "table lamp with iridescent glass", url: `${KHRONOS}/IridescenceLamp/glTF-Binary/IridescenceLamp.glb` },
  { name: "Corset", what: "fabric corset garment", url: `${KHRONOS}/Corset/glTF-Binary/Corset.glb` },
  { name: "Avocado", what: "avocado half (food)", url: `${KHRONOS}/Avocado/glTF-Binary/Avocado.glb` },
  { name: "Robot", what: "friendly animated robot character (walk, dance, wave clips)", url: `${THREE_GH}/examples/models/gltf/RobotExpressive/RobotExpressive.glb` },
  { name: "Soldier", what: "animated human soldier (idle, walk, run clips)", url: `${THREE_GH}/examples/models/gltf/Soldier.glb` },
  { name: "Horse", what: "animated galloping horse", url: `${THREE_GH}/examples/models/gltf/Horse.glb` },
  { name: "Parrot", what: "animated flying parrot", url: `${THREE_GH}/examples/models/gltf/Parrot.glb` },
  { name: "Fox", what: "animated low-poly fox", url: `${KHRONOS}/Fox/glTF-Binary/Fox.glb` },
  { name: "Littlest Tokyo", what: "detailed miniature Tokyo street diorama (animated)", url: `${THREE_GH}/examples/models/gltf/LittlestTokyo.glb` },
];

/** Whether a request is a 3D scene, so the 3D guide and the 3D checks apply. */
export function is3DRequest(templateId: string, request: string) {
  return templateId === "3d" || /\b(3d|3-d|three\.js|webgl|3d model|model of a|render of)\b/i.test(request);
}

/** The agent's playbook for realistic 3D, added to its instructions for 3D requests. */
export function threeDGuide() {
  return `## Realistic 3D (three.js)
Aim for a product-render look, not a toy: correct silhouette and proportions, nothing floating, believable materials and light.

Plan (in the plan's sections): the object's real dimensions in metres; a parts list, each with its size, shape technique, material and exactly what it attaches to (parent part and contact point); the camera views that show it best.

Real models first: if the request is (or contains) one of these, load it with GLTFLoader instead of modelling it, then light and present it well:
${MODEL_LIBRARY.map((m) => `- ${m.name} (${m.what}): ${m.url}`).join("\n")}

Modelling (when no real model fits): never assemble an object from generic boxes, spheres and cylinders, even if a request or process says "simple shapes"; that reads as a toy. Model each part's real form.
- Build in real units (1 unit = 1 metre) around one origin; put every part in a THREE.Group hierarchy that mirrors the parts list (hull → turret → barrel), placed relative to its parent, so parts sit exactly on or in what they attach to. Nothing may float: every part touches its parent.
- Pick the technique per part: LatheGeometry for anything turned or round (bottles, nozzles, bodies, wheels), ExtrudeGeometry with bevelEnabled for plates, panels and flat parts with thickness, RoundedBoxGeometry (addons/geometries/RoundedBoxGeometry.js) instead of hard boxes, TubeGeometry along a CatmullRomCurve3 through the two parts' real anchor points for pipes and cables, InstancedMesh for repeats (track links, bolts, rivets, cooling tubes).
- Garments and soft goods: model from the real pattern silhouette (a Shape of the flat garment, extruded thinly with a generous bevel, then gently displaced), not from cylinders; a T-shirt reads as a flat-lay or on an invisible form.
- Soften every hard edge (bevels), add small real details at the right scale (seams, panel lines, bolts), and check proportions against the real object's dimensions.

Organic and soft-blended forms (creatures, characters, anything sculpted rather than built from flat parts): assembling separate lathe/extrude pieces always shows a seam where they meet, which reads as glued-together, not grown or sculpted. Build these as one continuously blended field instead, with MarchingCubes (addons/objects/MarchingCubes.js):
- Model it as a list of balls, one per mass (torso, head, each limb segment), each with a real-world centre and radius. Import { MarchingCubes } from the addon, then: \`const effect = new MarchingCubes(48, material, false, false, 60000); effect.isolation = 80; effect.reset();\` and for each ball, with a bounding cube side CUBE chosen with real headroom around the object (see below) and a fixed subtract (9 is a good default):
  \`const strength = (subtract + effect.isolation) * (r / CUBE) ** 2; effect.addBall(0.5 + x / CUBE, 0.5 + y / CUBE, 0.5 + z / CUBE, strength, subtract);\`
  The visible radius of a lone ball is sqrt(strength / (subtract + isolation)), not sqrt(strength / subtract): the isolation threshold shrinks it further, so strength must include it or every mass renders far smaller than intended.
- Overlap masses that should blend (a limb into the torso, a head into a neck): place them so their radii sum to noticeably more than the distance between centres, or they render as separate untouched spheres instead of one blended body. Masses that should stay a distinct bump (eyes) overlap only a little.
- Give the field's bounding cube (CUBE) real headroom, at least 30% wider than the object's own extent: MarchingCubes ignores its outer two grid cells, so a mass placed near the cube's edge gets clipped and punches a hole or flat spot in the surface.
- After \`effect.update()\`, its position/normal buffers are still sized for the largest mesh it could ever produce, padded with stale zero data past what this generation used; trim them or every bounding-box calculation on the mesh (the camera fit, the automatic check) reads that padding as extra geometry at the origin:
  \`const n = effect.count; effect.geometry.setAttribute('position', new THREE.BufferAttribute(effect.positionArray.slice(0, n * 3), 3)); effect.geometry.setAttribute('normal', new THREE.BufferAttribute(effect.normalArray.slice(0, n * 3), 3)); effect.geometry.setDrawRange(0, n); effect.geometry.computeBoundingBox();\`
- Scale the mesh with \`effect.scale.setScalar(CUBE / 2)\` (its local space spans -1 to 1). Ordinary hard-surface parts (eyes, clothing, accessories) can still be separate meshes added alongside it in the same group; they just need to actually touch its surface, not float near it.
- Keep using the hard-surface techniques above for anything with flat faces, sharp edges or machined parts; MarchingCubes is for the parts of the model that should read as one continuous, sculpted mass.

Materials and light:
- MeshPhysicalMaterial with real values: metals metalness 1 and roughness 0.2 to 0.5, painted metal metalness 0 to 0.3 with clearcoat, rubber roughness 0.9, fabric roughness 0.85 with sheen, glass transmission. Add surface texture with a CanvasTexture (noise, grain, weave, scratches) used as roughnessMap or bumpMap.
- Light with an HDRI environment (RGBELoader from addons/loaders/RGBELoader.js, then scene.environment; keep the background a neutral colour or gradient):
${HDRIS.map((h) => `  - ${h.name} (${h.mood}): ${h.url}`).join("\n")}
  plus one soft key light that casts shadows (PCFSoftShadowMap, shadow.radius) and a shadow-catching ground (ShadowMaterial or a subtle floor).
- renderer.toneMapping = ACESFilmicToneMapping, outputColorSpace SRGBColorSpace, devicePixelRatio capped at 2.

Camera and checks:
- Fit the camera to the model's bounding box (Box3.setFromObject on the model group, not the scene) so it fills about 60 to 75% of the frame and is never cut off; orbit controls with damping and sensible limits.
- Keep all the scene code in ONE <script type="module"> (if the file is written in parts, the whole script goes in the last part).
- Import three.js ${THREE_VERSION} via the import map (build/three.module.js and examples/jsm/ addons from jsDelivr).
- Right after building the scene, expose it for the automatic check: window.__vellum3d = { THREE, scene, camera, renderer }; name each part's mesh (mesh.name = "turret"), mark floors with mesh.userData.ground = true and any backdrop, sweep or dome with mesh.userData.backdrop = true. The check photographs the model from several angles and flags parts that float or a model cut off by the frame.`;
}
