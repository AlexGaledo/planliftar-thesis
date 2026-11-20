/**
 * Procedural plaster texture, UV scaling and wall opacity.
 * Ported from ar.html (makeWallTexture, scaleBoxUVs, applyWallOpacity).
 *
 * Why a lit material + a texture instead of a flat unlit colour: with
 * MeshBasicMaterial every face of every box is the same colour, so at 1:1 the
 * corners vanish. The low-contrast noise also gives ARCore something to track
 * when a wall fills the camera view. The materials themselves come from the
 * active SurfaceTheme (surfaceTheme.ts).
 */
import * as THREE from "three";

/** One texture tile per metre, so texel density is identical on every wall. */
const TILES_PER_M = 1.0;
const TEXTURE_SIZE = 256;

let sharedTexture: THREE.Texture | null = null;
/** No 2D canvas here (tests): stop asking, the answer will not change. */
let textureUnavailable = false;

/**
 * Seeded PRNG (mulberry32). Procedural textures must be identical on every load,
 * or bake-off screenshots and GLB sizes are not reproducible.
 */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The procedural texture, created once and shared. Drawn to a canvas so the app
 * makes no image request (works offline). Returns null where there is no canvas
 * 2D context (tests), in which case walls simply render untextured.
 */
export function getWallTexture(): THREE.Texture | null {
  if (sharedTexture) return sharedTexture;
  if (textureUnavailable || typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = TEXTURE_SIZE;
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = canvas.getContext("2d");
  } catch {
    ctx = null;
  }
  if (!ctx) {
    textureUnavailable = true;
    return null;
  }

  ctx.fillStyle = "#e8e6e1";
  ctx.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
  // fine speckle: plaster tooth
  const img = ctx.getImageData(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
  const random = seededRandom(0x5eed);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (random() - 0.5) * 18;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
  // faint horizontal courses, a real-world size cue when you walk up to a wall
  ctx.strokeStyle = "rgba(0,0,0,0.06)";
  ctx.lineWidth = 1;
  for (let y = 0; y <= TEXTURE_SIZE; y += TEXTURE_SIZE / 4) {
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(TEXTURE_SIZE, y + 0.5);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  tex.colorSpace = THREE.SRGBColorSpace;
  // Opaque: GLTFExporter writes PNG unless told otherwise, and noise does not
  // compress as PNG (~190 KB vs ~20 KB as JPEG).
  tex.userData.mimeType = "image/jpeg";
  sharedTexture = tex;
  return tex;
}

/**
 * BoxGeometry gives every face UVs of 0..1, so a 6 m wall and a 0.3 m stub get
 * the same single tile. Rescale each face by its real size instead. Vertex order
 * is BoxGeometry's own: 4 per face, faces +x, -x, +y, -y, +z, -z. The box is
 * built as (thickness, height, length).
 */
export function scaleBoxUVs(geom: THREE.BufferGeometry, thickness: number, height: number, length: number): void {
  const faceUV: [number, number][] = [
    [length, height], // +x long face
    [length, height], // -x long face
    [thickness, length], // +y top
    [thickness, length], // -y bottom
    [thickness, height], // +z end cap
    [thickness, height], // -z end cap
  ];
  const uv = geom.attributes.uv as THREE.BufferAttribute | undefined;
  // A segmented box would break the indexing; bail rather than scramble UVs.
  if (!uv || uv.count !== 24) return;
  for (let f = 0; f < 6; f++) {
    const su = faceUV[f][0] * TILES_PER_M;
    const sv = faceUV[f][1] * TILES_PER_M;
    for (let v = 0; v < 4; v++) {
      const i = f * 4 + v;
      uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
    }
  }
  uv.needsUpdate = true;
}

/**
 * Opacity below 1 must switch to transparent AND turn depth writes off, or
 * translucent walls hide each other in draw order. Solid walls cull back faces
 * (nobody can see them); see-through walls need them back.
 */
export function applyWallOpacity(material: THREE.Material, opacity: number): void {
  const solid = opacity >= 0.99;
  material.opacity = opacity;
  material.transparent = !solid;
  material.depthWrite = solid;
  material.side = solid ? THREE.FrontSide : THREE.DoubleSide;
  material.needsUpdate = true;
}
