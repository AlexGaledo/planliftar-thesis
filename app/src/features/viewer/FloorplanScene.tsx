/**
 * The scene inside the R3F <Canvas>: lights, the plan model, room labels, and
 * orbit controls framed to the building's size.
 *
 * The model is built imperatively (buildFloorplanGroup) and handed to R3F with
 * <primitive object={...}>, so viewer, AR and GLB share one builder. useMemo
 * rebuilds it only when the plan or scale changes; the effect disposes the old
 * GPU buffers.
 *
 * The default "home" theme loads textures and door/window models
 * asynchronously: the first build waits for them (useThemeReady), and if they
 * are slow the untextured model shows first and is rebuilt once when they land.
 * Lighting (environment map + hemisphere + sun) comes from lib/three/lighting.
 *
 * @param plan         prepared plan
 * @param ppm          plan px per metre
 * @param wallHeightM  wall height in metres
 * @param showLabels   draw room names
 * @param wallOpacity  1 = solid
 */
import { Html, OrbitControls } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { roomLabel } from "@/features/plan/labels";
import { boundsCenter, computeBounds, planToLocal, polygonCentroid, type Plan } from "@/lib/plan";
import { buildFloorplanGroup, disposeGroup } from "@/lib/three/buildFloorplanGroup";
import { createRoomEnvironment, VIEWER_LIGHTS } from "@/lib/three/lighting";
import { applyWallOpacity } from "@/lib/three/materials";
import { DEFAULT_THEME } from "@/lib/three/surfaceTheme";
import { useThemeReady } from "@/lib/three/useThemeReady";
import styles from "./viewer.module.css";

interface FloorplanSceneProps {
  plan: Plan;
  ppm: number;
  wallHeightM: number;
  showLabels: boolean;
  wallOpacity: number;
}

export function FloorplanScene({ plan, ppm, wallHeightM, showLabels, wallOpacity }: FloorplanSceneProps) {
  const { ready, canBuild } = useThemeReady(DEFAULT_THEME);
  // `ready` is a dependency on purpose: a build made before the assets arrived
  // (canBuild after the grace period) is replaced once they do.
  const model = useMemo(
    () => (canBuild ? buildFloorplanGroup(plan, { ppm, wallHeightM, includeRooms: true, theme: DEFAULT_THEME }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [plan, ppm, wallHeightM, canBuild, ready],
  );
  useEffect(() => () => disposeGroup(model?.group), [model]);
  // Opacity only touches the material, no rebuild needed.
  useEffect(() => model?.wallMaterials.forEach((m) => applyWallOpacity(m, wallOpacity)), [model, wallOpacity]);

  const labels = useMemo(() => {
    const center = boundsCenter(computeBounds(plan));
    return (plan.rooms ?? [])
      .map((r, i) => {
        if (r.polygon.length < 3) return null;
        const c = polygonCentroid(r.polygon);
        const l = planToLocal(c.x, c.y, center, ppm);
        return { key: r.id ?? String(i), text: roomLabel(r.type ?? r.name, i), position: [l.x, 0.05, l.z] as [number, number, number] };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
  }, [plan, ppm]);

  const { hemisphere: hemi, sun } = VIEWER_LIGHTS;
  if (!model) {
    // The environment is prefiltered while the theme loads, off the model's critical path.
    return (
      <>
        <color attach="background" args={["#f4f4f4"]} />
        <ViewerEnvironment />
      </>
    );
  }

  // Frame the camera on the footprint: distance grows with the building size.
  const size = Math.max(model.widthM, model.depthM, 1);

  return (
    <>
      <color attach="background" args={["#f4f4f4"]} />
      <ViewerEnvironment />
      <hemisphereLight args={[hemi.sky, hemi.ground, hemi.intensity]} />
      <directionalLight position={[size, size * 2, size * 0.6]} color={sun.color} intensity={sun.intensity} />
      <primitive object={model.group} />
      {showLabels &&
        labels.map((l) => (
          <Html key={l.key} position={l.position} center zIndexRange={[10, 0]} className={styles.label}>
            {l.text}
          </Html>
        ))}
      <gridHelper args={[size * 3, Math.round(size * 3), "#bdbdbd", "#e2e2e2"]} position={[0, -0.021, 0]} />
      <OrbitControls
        makeDefault
        target={[0, 0, 0]}
        minDistance={0.5}
        maxDistance={size * 6}
        maxPolarAngle={Math.PI / 2 - 0.05}
        // Re-key on size so the initial camera distance resets for a new plan.
        key={size}
      />
      <CameraFrame size={size} />
    </>
  );
}

/** Neutral image-based light (RoomEnvironment via PMREM), made once per viewer and freed with it. */
function ViewerEnvironment() {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    const env = createRoomEnvironment(gl);
    const previous: THREE.Texture | null = scene.environment;
    scene.environment = env.texture;
    return () => {
      scene.environment = previous;
      env.dispose();
    };
  }, [gl, scene]);
  return null;
}

/**
 * Place the camera at a 3/4 view proportional to the building. On a tall
 * (portrait) canvas the horizontal field of view is narrow, so back off by
 * 1/aspect to keep the whole footprint in frame.
 */
function CameraFrame({ size }: { size: number }) {
  const camera = useThree((s) => s.camera);
  const aspect = useThree((s) => s.size.width / Math.max(1, s.size.height));
  useEffect(() => {
    const k = Math.max(1, 1 / aspect) * 1.1;
    camera.position.set(size * 0.6 * k, size * 0.9 * k, size * 1.0 * k);
    camera.lookAt(0, 0, 0);
  }, [camera, size, aspect]);
  return null;
}
