// Shared construction of the pick-and-place scene + viewer, so the page, the dataset re-renderer
// (tools/replay.html) and the browser evaluation all render the policy cameras identically.
import { loadScene } from '../runtime.js';
import { Viewer } from '../viewer.js';
import { PolicyCameras } from './cams.js';

export async function loadPickScene(mj, base = 'assets/franka', onProgress) {
  return loadScene(mj, base, 'franka', 'pick_scene.xml', onProgress);
}

export function createPickViewer(container, model, data) {
  const viewer = new Viewer({
    container, model, data,
    cameraPos: [1.72, -1.05, 0.98], cameraTarget: [0.38, 0.0, 0.16], fov: 38, shadowExtent: 1.0,
  });
  viewer.followShadow(0.45, 0);
  const cams = new PolicyCameras(viewer, 64);
  return { viewer, cams };
}
