// Offscreen 64x64 renders of the scene's MuJoCo cameras ('front', 'wrist'), packed as uint8 CHW
// tensors exactly like diffusion-pick's observations (front_rgb / wrist_rgb).
//
// Note: this is three.js rasterising the same geometry, not MuJoCo's OpenGL renderer, so images
// differ in shading from the training data (see README: sim-to-sim visual gap). The background is
// black and decorations (grid, drag handles) are hidden, as in MuJoCo's offscreen renders.
//
// Frames are rendered synchronously (so they match the physics state at the control step) and read
// back asynchronously through a pixel-buffer object, which avoids stalling the GPU pipeline.
import * as THREE from 'three';

export class PolicyCameras {
  constructor(viewer, size = 64) {
    this.v = viewer;
    this.size = size;
    this.slots = new Map(); // camera id -> { cam, rt, rgba }
    this.black = new THREE.Color(0, 0, 0);
  }

  slot(id) {
    if (!this.slots.has(id)) {
      const cam = new THREE.PerspectiveCamera(this.v.model.cam_fovy[id], 1, 0.01, 10);
      cam.matrixAutoUpdate = false;
      cam.layers.set(0); // geometry only
      const rt = new THREE.WebGLRenderTarget(this.size, this.size, { samples: 4 });
      rt.texture.colorSpace = THREE.SRGBColorSpace;
      this.slots.set(id, { cam, rt, rgba: new Uint8Array(this.size * this.size * 4) });
    }
    return this.slots.get(id);
  }

  /** Render the given MuJoCo cameras now; resolves to [{ chw, image }] once the pixels are back. */
  capture(ids) {
    const { renderer, scene, data } = this.v;
    // geom poses must reflect the current physics state, not the last rendered frame
    this.v.sync();
    const p = data.cam_xpos, R = data.cam_xmat;
    const bg = scene.background, fog = scene.fog, tone = renderer.toneMapping;
    scene.background = this.black;
    scene.fog = null;
    // theme-independent: use the MJCF floor colour so light/dark mode give identical observations
    const floorColor = this.v.floorMat?.color.clone();
    if (floorColor) this.v.floorMat.color.copy(this.v.floorModelColor);
    renderer.toneMapping = THREE.NoToneMapping;
    const reads = [];
    for (const id of ids) {
      const { cam, rt, rgba } = this.slot(id);
      // MuJoCo cameras look along -z with +y up, which is also three.js' convention.
      cam.matrix.set(R[9 * id], R[9 * id + 1], R[9 * id + 2], p[3 * id],
                     R[9 * id + 3], R[9 * id + 4], R[9 * id + 5], p[3 * id + 1],
                     R[9 * id + 6], R[9 * id + 7], R[9 * id + 8], p[3 * id + 2],
                     0, 0, 0, 1);
      cam.updateMatrixWorld(true);
      renderer.setRenderTarget(rt);
      renderer.render(scene, cam);
      reads.push(renderer.readRenderTargetPixelsAsync(rt, 0, 0, this.size, this.size, rgba).then(() => this.pack(rgba)));
    }
    renderer.setRenderTarget(null);
    if (floorColor) this.v.floorMat.color.copy(floorColor);
    renderer.toneMapping = tone;
    scene.background = bg;
    scene.fog = fog;
    return Promise.all(reads);
  }

  pack(rgba) {
    // WebGL rows are bottom-up; images are top-down.
    const S = this.size, n = S * S;
    const chw = new Uint8Array(3 * n);
    const image = new ImageData(S, S);
    for (let y = 0; y < S; y++) {
      const src = (S - 1 - y) * S;
      for (let x = 0; x < S; x++) {
        const i = 4 * (src + x), o = y * S + x;
        chw[o] = rgba[i]; chw[n + o] = rgba[i + 1]; chw[2 * n + o] = rgba[i + 2];
        image.data[4 * o] = rgba[i]; image.data[4 * o + 1] = rgba[i + 1];
        image.data[4 * o + 2] = rgba[i + 2]; image.data[4 * o + 3] = 255;
      }
    }
    return { chw, image };
  }

  dispose() { for (const { rt } of this.slots.values()) rt.dispose(); }
}
