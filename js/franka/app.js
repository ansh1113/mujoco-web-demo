// Tab 2: Franka Panda pick-and-place driven by an ONNX policy (onnxruntime-web).
import { loadScene, Rng } from '../runtime.js';
import { Viewer } from '../viewer.js';
import { Perturb } from '../perturb.js';
import { SimLoop } from '../loop.js';
import { PickEnv } from './env.js';
import { OnnxPolicy } from './policy.js';
import { PolicyCameras } from './cams.js';
import { POLICY_SLOT } from './policy-slot.js';

const $ = (id) => document.getElementById(id);
const MAX_STEPS = 200;     // 20 s at 10 Hz, as in diffusion-pick's evaluation
const PAUSE_AFTER = 1600;  // ms to show the outcome before the next episode

async function loadOrt() {
  const ort = await import('../../vendor/ort/ort.wasm.min.mjs');
  ort.env.wasm.wasmPaths = new URL('../../vendor/ort/', import.meta.url).href;
  ort.env.wasm.numThreads = 1;   // no cross-origin isolation on static hosts
  ort.env.wasm.proxy = false;
  ort.env.logLevel = 'error';
  return ort;
}

/** Fill in obs/pred horizons from the graph's input shapes when no metadata JSON is available. */
function inferMeta(session) {
  const meta = {};
  const md = session.inputMetadata;
  if (!Array.isArray(md)) return meta;
  for (const im of md) {
    const s = im.shape;
    if (!Array.isArray(s)) continue;
    if (im.name === 'proprio' && typeof s[1] === 'number') meta.obs_horizon = s[1];
    if (im.name === 'noise' && typeof s[1] === 'number') meta.pred_horizon = s[1];
    if (im.name === 'front_rgb' && typeof s[3] === 'number') meta.img_size = s[3];
  }
  return meta;
}

export async function createPickDemo({ mj, ui }) {
  ui.progress(0.25, 'Loading Franka scene + onnxruntime-web…');
  const [{ model, data }, ort] = await Promise.all([
    loadScene(mj, 'assets/franka', 'franka', 'pick_scene.xml', (f) => ui.progress(0.25 + 0.5 * f)),
    loadOrt(),
  ]);
  const env = new PickEnv(mj, model, data, { maxSteps: MAX_STEPS });

  const viewer = new Viewer({
    container: $('pick-view'), model, data,
    cameraPos: [1.72, -1.05, 0.98], cameraTarget: [0.38, 0.0, 0.16], fov: 38, shadowExtent: 1.0,
  });
  viewer.followShadow(0.45, 0);
  const cams = new PolicyCameras(viewer, 64);
  const perturb = new Perturb(viewer, { stiffness: 250, damping: 12, maxForce: 40, massScaled: true });

  const status = $('pick-status');
  const setStatus = (text, state) => { status.textContent = text; status.dataset.state = state; };
  const stepChip = $('pick-step');
  const thumbs = { front: $('pick-front').getContext('2d'), wrist: $('pick-wrist').getContext('2d') };

  // ── policy slot
  const params = new URLSearchParams(location.search);
  let policy = null;
  let policyError = null;
  const rng = new Rng(Date.now() & 0xffff);

  async function setPolicy(src, label, meta = null) {
    setStatus('Loading policy…', 'busy');
    try {
      const p = await OnnxPolicy.load(ort, src, meta, label);
      if (!meta && !Object.keys(p.meta).some((k) => k === 'policy')) Object.assign(p.meta, inferMeta(p.session));
      await policy?.dispose();
      policy = p;
      policyError = null;
      $('pick-policy').textContent = label;
      const dims = { proprio: `[1,${p.meta.obs_horizon},12]`, noise: `[1,${p.meta.pred_horizon},5]`,
        object_state: '[1,7]', front_rgb: `[1,${p.meta.obs_horizon},3,${p.meta.img_size},${p.meta.img_size}]`,
        wrist_rgb: `[1,${p.meta.obs_horizon},3,${p.meta.img_size},${p.meta.img_size}]` };
      $('pick-io').textContent = `${p.inputs.map((n) => `${n}${dims[n]}`).join(' ')} → actions[1,${p.meta.pred_horizon},5]`;
      score = { ok: 0, n: 0 };
      newEpisode();
    } catch (err) {
      console.error(err);
      policyError = err;
      setStatus(`Policy error: ${err.message}`, 'bad');
    }
  }

  // ── episode state
  let hist = [];
  let queue = [];
  let thinking = false;
  let outcome = null;  // { ok, at }
  let score = { ok: 0, n: 0 };
  let seed = 0;

  let pendingReads = 0;
  let epoch = 0;
  function observe() {
    const o = { proprio: env.proprio(), object_state: env.objectState(), front_rgb: null, wrist_rgb: null };
    const ep = epoch;
    pendingReads += 1;
    cams.capture([env.cam.front, env.cam.wrist]).then(([f, w]) => {
      o.front_rgb = f.chw;
      o.wrist_rgb = w.chw;
      if (ep !== epoch) return;
      thumbs.front.putImageData(f.image, 0, 0);
      thumbs.wrist.putImageData(w.image, 0, 0);
    }).catch((err) => console.error(err)).finally(() => { pendingReads -= 1; });
    return o;
  }

  function newEpisode() {
    perturb.release();
    seed = Math.floor(Math.random() * 1e6);
    env.reset(seed);
    epoch += 1;
    hist = [observe()];
    queue = [];
    outcome = null;
    $('pick-seed').textContent = String(seed);
    updateScore();
  }

  function updateScore() {
    $('pick-score').textContent = score.n ? `${score.ok} / ${score.n}` : '0 / 0';
  }

  function finish(ok) {
    outcome = { ok, at: performance.now() };
    score.n += 1;
    score.ok += ok ? 1 : 0;
    updateScore();
  }

  function requestChunk() {
    thinking = true;
    const h = hist.slice();
    policy.act(h, rng).then((chunk) => {
      queue = chunk;
      $('pick-ms').textContent = `${policy.lastMs.toFixed(policy.lastMs < 10 ? 1 : 0)} ms`;
    }).catch((err) => {
      console.error(err);
      policyError = err;
      setStatus(`Policy error: ${err.message}`, 'bad');
    }).finally(() => { thinking = false; });
  }

  const dt = model.opt.timestep;
  function advance(simDt) {
    if (!policy || policyError) return simDt;
    if (outcome) {
      if (performance.now() - outcome.at > PAUSE_AFTER) newEpisode();
      return simDt;
    }
    let n = Math.max(1, Math.round(simDt / dt));
    let simulated = 0;
    while (n > 0 && !thinking) {
      if (!env.stepping) {
        if (env.t >= MAX_STEPS) { finish(false); break; }
        if (!queue.length) {
          // image-based policies need the camera frames of the last control step to be read back
          if (policy.needsImages && pendingReads > 0) break;
          requestChunk();
          break;
        }
        env.beginStep(queue.shift());
      }
      const done = env.substep(() => perturb.apply(dt));
      n -= 1;
      simulated += dt;
      if (done) {
        hist.push(observe());
        if (hist.length > policy.meta.obs_horizon) hist.shift();
        if (env.isSuccess()) { finish(true); break; }
      }
    }
    // a pending inference pauses physics (as in diffusion-pick's eval loop); don't count it as slowness
    return thinking ? simDt : simulated || simDt;
  }

  let lastUi = 0;
  function draw() {
    viewer.sync();
    perturb.draw();
    viewer.render();
    const now = performance.now();
    if (now - lastUi < 120) return;
    lastUi = now;
    if (policyError) return;
    stepChip.hidden = false;
    stepChip.textContent = `t ${String(env.t).padStart(3, ' ')} / ${MAX_STEPS}`;
    if (loop.paused) setStatus('Paused', 'busy');
    else if (outcome) setStatus(outcome.ok ? 'Success — cube in bowl' : 'Timed out', outcome.ok ? 'ok' : 'bad');
    else if (!policy) setStatus('Loading policy…', 'busy');
    else {
      const holding = env.fingerWidth() < 0.065 && env.cubePos()[2] > 0.03;
      setStatus(holding ? 'Carrying' : 'Running policy', 'ok');
    }
  }

  const loop = new SimLoop(advance, draw);

  $('pick-new').addEventListener('click', () => { if (policy) newEpisode(); });
  $('pick-pause').addEventListener('click', (e) => {
    loop.paused = !loop.paused;
    e.target.textContent = loop.paused ? 'Resume' : 'Pause';
  });
  $('pick-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    await setPolicy(bytes, file.name);
    e.target.value = '';
  });

  ui.progress(0.85, 'Loading policy…');
  const fromUrl = params.get('policy');
  if (fromUrl) await setPolicy(fromUrl, fromUrl.split('/').pop());
  else await setPolicy(POLICY_SLOT.url, POLICY_SLOT.label);

  return {
    start: () => loop.start(),
    stop: () => loop.stop(),
    applyTheme: () => viewer.applyTheme(),
    debug: { mj, model, data, env, viewer, perturb, loop, cams, ort,
      get policy() { return policy; }, get score() { return score; }, get error() { return policyError; },
      setPolicy, newEpisode },
  };
}
