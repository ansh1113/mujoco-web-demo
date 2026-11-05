// Browser-side half of tools/lab/run.cjs. Uses the site's own modules, so observations rendered here
// are pixel-for-pixel what the deployed page feeds the policy.
import { getMujoco, Rng } from '../../js/runtime.js';
import { PickEnv } from '../../js/franka/env.js';
import { OnnxPolicy } from '../../js/franka/policy.js';
import { loadPickScene, createPickViewer } from '../../js/franka/scene.js';

const ROOT = new URL('../../', import.meta.url).href;
let S = null;

function b64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

async function init() {
  const mj = await getMujoco();
  const { model, data } = await loadPickScene(mj, `${ROOT}assets/franka`);
  const { viewer, cams } = createPickViewer(document.getElementById('view'), model, data);
  const env = new PickEnv(mj, model, data);
  const ort = await import('../../vendor/ort/ort.wasm.min.mjs');
  ort.env.wasm.wasmPaths = `${ROOT}vendor/ort/`;
  ort.env.wasm.numThreads = 1;
  ort.env.logLevel = 'error';
  S = { mj, model, data, viewer, cams, env, ort, policy: null };
  return { nq: model.nq };
}

/** Render front + wrist for each recorded state. qpos: flat [T * nq]. Returns base64 of T x (front CHW, wrist CHW). */
async function renderStates(bowlXY, qpos) {
  const { mj, model, data, cams, env } = S;
  const nq = model.nq, T = qpos.length / nq, n = 3 * 64 * 64;
  const bp = model.body_pos;
  bp[3 * env.bowl] = bowlXY[0];
  bp[3 * env.bowl + 1] = bowlXY[1];
  const out = new Uint8Array(T * 2 * n);
  for (let t = 0; t < T; t++) {
    data.qpos.set(qpos.slice(t * nq, (t + 1) * nq));
    mj.mj_forward(model, data);
    const [f, w] = await cams.capture([env.cam.front, env.cam.wrist]);
    out.set(f.chw, (2 * t) * n);
    out.set(w.chw, (2 * t + 1) * n);
  }
  return b64(out);
}

async function loadPolicy(url) {
  await S.policy?.dispose();
  S.policy = await OnnxPolicy.load(S.ort, `${ROOT}${url}`, null, url);
  return { inputs: S.policy.inputs, meta: S.policy.meta };
}

/** Closed-loop episode, mirroring diffusion-pick's scripts/eval_onnx.py (receding horizon, Ta = 8). */
async function evalEpisode(seed, maxSteps = 200) {
  const { env, cams, policy } = S;
  const rng = new Rng(seed + 7_777);
  env.reset(seed);
  const observe = async () => {
    const o = { proprio: env.proprio(), object_state: env.objectState() };
    const [f, w] = await cams.capture([env.cam.front, env.cam.wrist]);
    o.front_rgb = f.chw;
    o.wrist_rgb = w.chw;
    return o;
  };
  const hist = [await observe()];
  let queue = [], inferMs = 0, calls = 0;
  for (let t = 0; t < maxSteps; t++) {
    if (!queue.length) {
      queue = await policy.act(hist, rng);
      inferMs += policy.lastMs; calls += 1;
    }
    env.beginStep(queue.shift());
    while (!env.substep());
    hist.push(await observe());
    if (hist.length > policy.meta.obs_horizon) hist.shift();
    if (env.isSuccess()) return { seed, success: true, steps: t + 1, inferMs: inferMs / calls };
  }
  return { seed, success: false, steps: maxSteps, inferMs: inferMs / calls };
}

window.lab = { init, renderStates, loadPolicy, evalEpisode };
window.labReady = true;
