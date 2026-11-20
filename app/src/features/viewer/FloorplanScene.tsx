/**
 * The scene inside the R3F <Canvas>: lights, the plan model, room labels, and
 * orbit controls framed to the building's size.
 *
 * The model is built imperatively (buildFloorplanGroup) and handed to R3F with
 * <primitive object={...}>, so viewer, AR and GLB share one builder. useMemo
 * rebuilds it only when the plan or scale changes; the effect disposes the old
 * GPU buffers.
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
import { roomLabel } from "@/features/plan/labels";
import { boundsCenter, computeBounds, planToLocal, polygonCentroid, type Plan } from "@/lib/plan";
import { buildFloorplanGroup, disposeGroup } from "@/lib/three/buildFloorplanGroup";
import { applyWallOpacity } from "@/lib/three/materials";
import styles from "./viewer.module.css";

interface FloorplanSceneProps {
  plan: Plan;
  ppm: number;
  wallHeightM: number;
  showLabels: boolean;
  wallOpacity: number;
}

export function FloorplanScene({ plan, ppm, wallHeightM, showLabels, wallOpacity }: FloorplanSceneProps) {
  const model = useMemo(() => buildFloorplanGroup(plan, { ppm, wallHeightM, includeRooms: true }), [plan, ppm, wallHeightM]);
  useEffect(() => () => disposeGroup(model.group), [model]);
  // Opacity only touches the material, no rebuild needed.
  useEffect(() => applyWallOpacity(model.wallMaterial, wallOpacity), [model, wallOpacity]);

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

  // Frame the camera on the footprint: distance grows with the building size.
  const size = Math.max(model.widthM, model.depthM, 1);

  return (
    <>
      <color attach="background" args={["#f4f4f4"]} />
      <hemisphereLight args={["#ffffff", "#707070", 2.0]} />
      <directionalLight position={[size, size * 2, size * 0.6]} intensity={1.1} />
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

/** Place the camera at a 3/4 view proportional to the building, once per size. */
function CameraFrame({ size }: { size: number }) {
  const camera = useThree((s) => s.camera);
  useEffect(() => {
    camera.position.set(size * 0.6, size * 0.9, size * 1.0);
    camera.lookAt(0, 0, 0);
  }, [camera, size]);
  return null;
}
