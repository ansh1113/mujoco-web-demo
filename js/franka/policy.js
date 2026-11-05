// ONNX policy runner (onnxruntime-web, WASM backend).
//
// Inputs are fed *by name*, so any model following diffusion-pick's export convention works:
//   front_rgb, wrist_rgb  uint8   [1, To, 3, H, W]   (64x64 renders of the 'front' / 'wrist' cameras)
//   proprio               float32 [1, To, 12]
//   noise                 float32 [1, Tp, 5]          (DDIM initial noise, N(0, I))
//   object_state          float32 [1, 7]              (privileged; only the placeholder uses it)
// Output: actions float32 [1, Tp, 5] = absolute TCP targets (x, y, z, yaw, grip) at 10 Hz.

const DEFAULT_META = { obs_horizon: 2, pred_horizon: 16, action_horizon: 8, action_dim: 5, img_size: 64 };
export const KNOWN_INPUTS = ['front_rgb', 'wrist_rgb', 'proprio', 'noise', 'object_state'];

export class OnnxPolicy {
  constructor(ort, session, meta, label) {
    this.ort = ort;
    this.session = session;
    this.meta = { ...DEFAULT_META, ...meta };
    this.label = label;
    this.inputs = session.inputNames;
    const unknown = this.inputs.filter((n) => !KNOWN_INPUTS.includes(n));
    if (unknown.length) {
      throw new Error(`policy needs input(s) ${unknown.join(', ')}; this demo provides ${KNOWN_INPUTS.join(', ')}`);
    }
    this.output = session.outputNames.includes('actions') ? 'actions' : session.outputNames[0];
    this.lastMs = 0;
  }

  /**
   * @param ort       the onnxruntime-web module
   * @param {string|ArrayBuffer|Uint8Array} src  model URL or bytes
   * @param {object} [meta]  export metadata (diffusion-pick writes it next to the .onnx as .json)
   */
  static async load(ort, src, meta = null, label = '') {
    let bytes = src;
    if (typeof src === 'string') {
      const res = await fetch(src);
      if (!res.ok) throw new Error(`could not fetch ${src} (${res.status})`);
      bytes = new Uint8Array(await res.arrayBuffer());
      if (!meta) {
        try {
          const mres = await fetch(src.replace(/\.onnx(\?.*)?$/, '.json'));
          if (mres.ok) meta = await mres.json();
        } catch { /* optional */ }
      }
    }
    const session = await ort.InferenceSession.create(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
    return new OnnxPolicy(ort, session, meta || {}, label);
  }

  get needsImages() { return this.inputs.includes('front_rgb') || this.inputs.includes('wrist_rgb'); }
  get usesPrivilegedState() { return this.inputs.includes('object_state'); }

  /** Index of the first action of the chunk to execute, and how many to execute (receding horizon). */
  get actionStart() { return this.meta.action_start ?? this.meta.obs_horizon - 1; }
  get actionHorizon() { return this.meta.action_horizon ?? 8; }

  /**
   * @param {object[]} hist  the last To observations, oldest first; each has
   *                         { proprio: Float32Array(12), front_rgb?: Uint8Array(3*H*W), wrist_rgb?, object_state }
   * @param rng  object with normal() for the diffusion noise
   * @returns {Float32Array[]} the actions to execute
   */
  async act(hist, rng) {
    const { ort, meta } = this;
    const To = meta.obs_horizon, Tp = meta.pred_horizon, A = meta.action_dim, H = meta.img_size;
    const h = hist.slice(-To);
    while (h.length < To) h.unshift(h[0]);
    const feeds = {};
    for (const name of this.inputs) {
      if (name === 'proprio') {
        const buf = new Float32Array(To * 12);
        h.forEach((o, t) => buf.set(o.proprio, 12 * t));
        feeds.proprio = new ort.Tensor('float32', buf, [1, To, 12]);
      } else if (name === 'front_rgb' || name === 'wrist_rgb') {
        const n = 3 * H * H;
        const buf = new Uint8Array(To * n);
        h.forEach((o, t) => buf.set(o[name], n * t));
        feeds[name] = new ort.Tensor('uint8', buf, [1, To, 3, H, H]);
      } else if (name === 'noise') {
        const buf = new Float32Array(Tp * A);
        for (let i = 0; i < buf.length; i++) buf[i] = rng.normal();
        feeds.noise = new ort.Tensor('float32', buf, [1, Tp, A]);
      } else if (name === 'object_state') {
        feeds.object_state = new ort.Tensor('float32', h[h.length - 1].object_state, [1, 7]);
      }
    }
    const t0 = performance.now();
    const out = await this.session.run(feeds);
    this.lastMs = performance.now() - t0;
    const a = out[this.output].data;
    for (const t of Object.values(feeds)) t.dispose?.();
    const chunk = [];
    const start = this.actionStart;
    for (let k = start; k < Math.min(Tp, start + this.actionHorizon); k++) chunk.push(a.slice(k * A, k * A + A));
    out[this.output].dispose?.();
    return chunk;
  }

  async dispose() { await this.session.release?.(); }
}
