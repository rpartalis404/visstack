import * as THREE from 'three';

/**
 * Shared Three.js scaffold: renderer, scene, camera, canvas attachment,
 * resize and disposal. Each visualization builds on top (adds its own
 * post-processing composer, materials, meshes, uniforms, etc).
 *
 * The scaffold deliberately does NOT create a composer — post-processing
 * chains vary wildly between visualizations.
 */
export interface ThreeScaffold {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** Current width in CSS pixels. */
  width: number;
  /** Current height in CSS pixels. */
  height: number;
  /** Call when the container resizes. */
  resize(w: number, h: number): void;
  /** Detach canvas, dispose renderer. Does not dispose meshes/materials — the
   *  plugin owns those. */
  destroy(): void;
}

export interface ScaffoldOptions {
  fov?: number;
  near?: number;
  far?: number;
  /** Packed RGB, e.g. 0x06060b. */
  clearColor?: number;
  /** Initial camera Z offset. */
  cameraZ?: number;
  /** antialias passed to WebGLRenderer. */
  antialias?: boolean;
}

export function createThreeScaffold(
  container: HTMLElement,
  options: ScaffoldOptions = {},
): ThreeScaffold {
  const {
    fov = 60,
    near = 0.1,
    far = 100,
    clearColor = 0x06060b,
    cameraZ = 7,
    antialias = true,
  } = options;

  const rect = container.getBoundingClientRect();
  const width = Math.max(1, rect.width);
  const height = Math.max(1, rect.height);

  const renderer = new THREE.WebGLRenderer({ antialias, alpha: false });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(width, height);
  renderer.setClearColor(clearColor, 1);
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(fov, width / height, near, far);
  camera.position.set(0, 0, cameraZ);

  const scaffold: ThreeScaffold = {
    renderer,
    scene,
    camera,
    width,
    height,
    resize(w: number, h: number) {
      scaffold.width = w;
      scaffold.height = h;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    },
    destroy() {
      if (renderer.domElement.parentElement === container) {
        container.removeChild(renderer.domElement);
      }
      renderer.dispose();
    },
  };
  return scaffold;
}
