/**
 * Lighting shared by the 3D viewer, the bake-off page and AR, so screenshots
 * measure what users see (docs/research/bakeoff/DECISION.md fix W2).
 *
 * Viewer: a neutral image-based environment (three's RoomEnvironment through
 * PMREM) lights every face, so near-white plaster renders near white instead
 * of mid-grey; a weaker sun keeps faces distinguishable. ACES tone mapping.
 *
 * AR: no environment map (the camera feed is the background, and WebXR light
 * estimation is out of scope), so a brighter hemisphere light does that job.
 * No tone mapping in AR (three's default for the XR renderer here).
 *
 * The GLB carries no lights: model-viewer and Scene Viewer bring their own.
 */
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

export const VIEWER_LIGHTS = {
  hemisphere: { sky: 0xffffff, ground: 0x8a8a8a, intensity: 0.9 },
  sun: { color: 0xffffff, intensity: 0.7 },
} as const;

export const AR_LIGHTS = {
  hemisphere: { sky: 0xffffff, ground: 0xb0b0b0, intensity: 3.2 },
  sun: { color: 0xffffff, intensity: 0.8 },
} as const;

/**
 * A prefiltered RoomEnvironment for scene.environment (`.texture`). The caller
 * owns the render target and disposes it with the viewer; the generator and
 * the temporary scene are freed here.
 */
export function createRoomEnvironment(renderer: THREE.WebGLRenderer): THREE.WebGLRenderTarget {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment(renderer);
  const target = pmrem.fromScene(room, 0.04);
  room.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
  });
  pmrem.dispose();
  return target;
}

/** Hemisphere + sun for a plain three.js scene (bake-off page, AR). */
export function addLights(scene: THREE.Scene, lights: typeof VIEWER_LIGHTS | typeof AR_LIGHTS, sunPos: THREE.Vector3): void {
  const h = lights.hemisphere;
  scene.add(new THREE.HemisphereLight(h.sky, h.ground, h.intensity));
  const sun = new THREE.DirectionalLight(lights.sun.color, lights.sun.intensity);
  sun.position.copy(sunPos);
  scene.add(sun);
}
