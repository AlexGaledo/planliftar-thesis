/**
 * One-off: normalise Kenney Furniture Kit 2.0 (CC0) door/window GLBs into
 * unit boxes for the Option 3 "Kit Fixtures" bake-off.
 *   node normalize_fixtures.mjs <kenney "GLTF format" dir> <out dir>
 * Run it from a scratch dir with @gltf-transform/{core,extensions,functions}@4
 * installed (they are not app dependencies), then copy the output to
 * app/public/models/fixtures/.
 * - door   <- doorway.glb   (frame + panelled leaf + lever handle)
 * - window <- wallWindow.glb (casing + sash + glass; the wall primitive is dropped)
 * Output: 1 x 1 x 1 m box, pivot at bottom centre, width on +X, depth on Z.
 * Materials are renamed to the SurfaceKind they are remapped onto at runtime
 * (door, window_frame, glass, hardware); KHR_materials_unlit is removed.
 * Needs @gltf-transform/core + functions (v4), not an app dependency.
 */
import path from "node:path";
import { NodeIO } from "@gltf-transform/core";
import { KHRMaterialsUnlit } from "@gltf-transform/extensions";
import { prune, getBounds } from "@gltf-transform/functions";

const [src, out] = process.argv.slice(2);
const io = new NodeIO().registerExtensions([KHRMaterialsUnlit]);

// (node name, source material) -> target kind; null = drop the primitive
// part "frame" stretches to the wall thickness at runtime, part "leaf" keeps its depth.
const JOBS = {
  door: {
    file: "doorway.glb",
    map: { "doorway(Clone)|wood": ["window_frame", "frame"], "door|wood": ["door", "leaf"], "door|metal": ["hardware", "leaf"] },
  },
  window: {
    file: "wallWindow.glb",
    map: {
      // casing around the hole; its primitive also carries the wall's top/bottom caps (x 0..1), cut below
      "wallWindow(Clone)|wood": ["window_frame", "frame", (mn, mx) => mn[0] > 0.2 && mx[0] < 0.8],
      "wallWindow(Clone)|metalDark": null, // wall back face
      "wallWindow(Clone)|_defaultMat": null, // wall
      "window|wood": ["window_frame", "leaf"],
      "window|glass": ["glass", "leaf"],
    },
  },
};

for (const [name, job] of Object.entries(JOBS)) {
  const doc = await io.read(path.join(src, job.file));
  const root = doc.getRoot();
  const targets = new Map();
  const matFor = (kind) => {
    if (!targets.has(kind)) targets.set(kind, doc.createMaterial(kind).setBaseColorFactor([1, 1, 1, 1]).setMetallicFactor(0).setRoughnessFactor(0.8));
    return targets.get(kind);
  };
  const scene0 = root.listScenes()[0];
  const parts = { frame: doc.createNode("frame").setMesh(doc.createMesh("frame")), leaf: doc.createNode("leaf").setMesh(doc.createMesh("leaf")) };
  const srcNodes = root.listNodes().filter((n) => n.getMesh() && n !== parts.frame && n !== parts.leaf);
  for (const node of srcNodes) {
    const mtx = node.getWorldMatrix();
    for (const prim of node.getMesh().listPrimitives()) {
      const key = `${node.getName()}|${prim.getMaterial()?.getName()}`;
      if (!(key in job.map)) throw new Error(`${name}: unmapped ${key}`);
      if (job.map[key] === null) continue;
      const [kind, part, keep] = job.map[key];
      if (node.getRotation().some((r, i) => Math.abs(r - [0, 0, 0, 1][i]) > 1e-6) || node.getScale().some((x) => Math.abs(x - 1) > 1e-6))
        throw new Error(`${name}: node ${node.getName()} has rotation/scale`);
      // Unindexed copy of the kept triangles, world transform (translation only) baked in.
      const pos = prim.getAttribute("POSITION"), nor = prim.getAttribute("NORMAL"), idx = prim.getIndices();
      const n = idx ? idx.getCount() : pos.getCount();
      const P = [], N = [];
      for (let t = 0; t < n; t += 3) {
        const ids = [0, 1, 2].map((k) => (idx ? idx.getScalar(t + k) : t + k));
        const vs = ids.map((i) => pos.getElement(i, []).map((x, a) => x + mtx[12 + a]));
        const mn = [0, 1, 2].map((a) => Math.min(...vs.map((v) => v[a]))), mx = [0, 1, 2].map((a) => Math.max(...vs.map((v) => v[a])));
        if (keep && !keep(mn, mx)) continue;
        vs.forEach((v, k) => (P.push(...v), N.push(...nor.getElement(ids[k], []))));
      }
      const out = doc.createPrimitive()
        .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setArray(new Float32Array(P)))
        .setAttribute("NORMAL", doc.createAccessor().setType("VEC3").setArray(new Float32Array(N)))
        .setMaterial(matFor(kind));
      parts[part].getMesh().addPrimitive(out);
    }
  }
  for (const node of srcNodes) node.dispose();
  for (const node of scene0.listChildren()) scene0.removeChild(node);
  scene0.addChild(parts.frame).addChild(parts.leaf);
  for (const m of root.listMaterials()) if (![...targets.values()].includes(m)) m.dispose();
  for (const e of root.listExtensionsUsed()) e.dispose();
  const buf = root.listBuffers()[0];
  root.listAccessors().forEach((a) => a.setBuffer(buf));
  await doc.transform(prune());
  const scene = scene0;
  // Unit box = the FRAME's bounds (door handles may poke out in depth).
  const frameOnly = doc.createScene("tmp").addChild(parts.frame);
  const b = getBounds(frameOnly);
  frameOnly.removeChild(parts.frame).dispose();
  scene.addChild(parts.frame);
  const size = [0, 1, 2].map((i) => b.max[i] - b.min[i]);
  const cx = (b.min[0] + b.max[0]) / 2, cz = (b.min[2] + b.max[2]) / 2;
  const seen = new Set();
  for (const prim of root.listMeshes().flatMap((m) => m.listPrimitives())) {
    const pos = prim.getAttribute("POSITION");
    if (seen.has(pos)) continue;
    seen.add(pos);
    const v = [0, 0, 0];
    for (let i = 0; i < pos.getCount(); i++) {
      pos.getElement(i, v);
      pos.setElement(i, [(v[0] - cx) / size[0], (v[1] - b.min[1]) / size[1], (v[2] - cz) / size[2]]);
    }
    // Non-uniform scale: normals need the inverse-transpose; the kit is all axis-aligned faces, renormalise.
    const n = prim.getAttribute("NORMAL");
    if (n && !seen.has(n)) {
      seen.add(n);
      const nn = n.clone();
      prim.setAttribute("NORMAL", nn);
      for (let i = 0; i < nn.getCount(); i++) {
        nn.getElement(i, v);
        const w = [v[0] / size[0], v[1] / size[1], v[2] / size[2]];
        const l = Math.hypot(...w) || 1;
        nn.setElement(i, w.map((x) => x / l));
      }
    }
  }
  root.listScenes()[0].setExtras({ nativeSize: size, source: `Kenney Furniture Kit 2.0 / ${job.file} (CC0)` });
  await doc.transform(prune());
  await io.write(path.join(out, `${name}.glb`), doc);
  console.log(name, "native size", size.map((x) => x.toFixed(3)).join(" x "));
}
