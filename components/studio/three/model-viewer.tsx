"use client";

import * as React from "react";
import { OrbitControls, Stage, useGLTF } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import type { Mesh, MeshStandardMaterial, Object3D } from "three";

/**
 * The one real three.js scene, parameterized for both of its homes: the
 * node's run well (non-interactive, auto-rotating) and the expand modal's
 * stage (orbit controls, toggles). Loaded only through `next/dynamic` in
 * `./index.tsx` — three must never reach SSR or the main bundle.
 */
export function ModelViewer({
  url,
  interactive = false,
  autoRotate = true,
  wireframe = false,
  onReady,
  onError,
}: {
  url: string;
  interactive?: boolean;
  autoRotate?: boolean;
  wireframe?: boolean;
  onReady?: () => void;
  /** Load failures land here — the presign-renewal path in MediaWell. */
  onError?: () => void;
}) {
  return (
    // Keyed by url so a renewed presigned link resets the boundary's error
    // state and remounts the loader against the fresh bytes.
    <ModelErrorBoundary key={url} onError={onError}>
      <Canvas dpr={[1, 2]} camera={{ position: [2.2, 1.6, 2.2], fov: 40 }}>
        <React.Suspense fallback={null}>
          {/* No `environment`: drei's presets fetch HDRs from a public CDN at
              runtime, and a demo must not hinge on that. The preset lights +
              contact shadow are all local. */}
          <Stage
            environment={null}
            preset="rembrandt"
            intensity={0.9}
            shadows="contact"
            adjustCamera={1.15}
          >
            <GltfModel url={url} wireframe={wireframe} onReady={onReady} />
          </Stage>
        </React.Suspense>
        <OrbitControls
          enabled={interactive}
          autoRotate={autoRotate}
          autoRotateSpeed={1.5}
          enablePan={false}
          makeDefault
        />
      </Canvas>
    </ModelErrorBoundary>
  );
}

function GltfModel({
  url,
  wireframe,
  onReady,
}: {
  url: string;
  wireframe: boolean;
  onReady?: () => void;
}) {
  const { scene } = useGLTF(url);

  React.useEffect(() => {
    onReady?.();
    // Deliberately once per loaded scene — `onReady` is a fresh closure every
    // parent render and must not retrigger the well's ready bookkeeping.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene]);

  React.useEffect(() => {
    scene.traverse((obj: Object3D) => {
      const mesh = obj as Mesh;
      if (!mesh.isMesh) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        (material as MeshStandardMaterial).wireframe = wireframe;
      }
    });
  }, [scene, wireframe]);

  return <primitive object={scene} />;
}

/**
 * `useGLTF` suspends, then *throws* on a failed fetch — an expired presigned
 * URL surfaces here rather than on a media element's `onerror`. Class-based
 * because error boundaries still have no hook form.
 */
class ModelErrorBoundary extends React.Component<
  { onError?: () => void; children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    this.props.onError?.();
  }

  render() {
    // The well's own error plate (or resign shimmer) is already showing —
    // render nothing rather than a second message inside a dead canvas.
    return this.state.failed ? null : this.props.children;
  }
}
