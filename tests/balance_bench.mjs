// Headless push-recovery benchmark for the G1 balance controller, using the exact JS controller and
// MuJoCo WASM build the site ships.   node tests/balance_bench.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import loadMujoco from '../vendor/mujoco/mujoco.js';
import { BalanceController } from '../js/g1/balance.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mj = await loadMujoco();
const dir = path.join(ROOT, 'assets/g1');
for (const f of JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'))).files) {
  const parts = `/g1/${f}`.split('/').slice(1, -1);
  let cur = '';
  for (const p of parts) { cur += `/${p}`; try { mj.FS.mkdir(cur); } catch { /* exists */ } }
  mj.FS.writeFile(`/g1/${f}`, fs.readFileSync(path.join(dir, f)));
}
const model = mj.MjModel.from_xml_path('/g1/scene.xml');
const data = new mj.MjData(model);
const ctl = new BalanceController(mj, model);
const torso = model.body('torso_link').id;

function survives(F, dir, enabled = true, dur = 0.1, T = 3.0) {
  ctl.enabled = enabled;
  ctl.reset(data);
  while (data.time < 1.0) { ctl.compute(data); mj.mj_step(model, data); }
  if (ctl.fallen(data)) return false;
  const t0 = data.time;
  const xf = data.xfrc_applied;
  while (data.time < t0 + T) {
    const on = data.time < t0 + dur;
    for (let k = 0; k < 3; k++) xf[6 * torso + k] = on ? F * dir[k] : 0;
    ctl.compute(data);
    mj.mj_step(model, data);
    if (ctl.fallen(data)) { for (let k = 0; k < 3; k++) xf[6 * torso + k] = 0; return false; }
  }
  return true;
}

function maxPush(dir, enabled) {
  let lo = 0, hi = 400;
  if (!survives(0, dir, enabled)) return -1;
  for (let i = 0; i < 6; i++) { const mid = (lo + hi) / 2; if (survives(mid, dir, enabled)) lo = mid; else hi = mid; }
  return Math.round(lo);
}

const DIRS = { forward: [1, 0, 0], backward: [-1, 0, 0], left: [0, 1, 0], right: [0, -1, 0],
  'fwd-left': [0.7, 0.7, 0], 'back-left': [-0.7, 0.7, 0] };
const rows = [];
for (const [name, d] of Object.entries(DIRS)) {
  rows.push({ direction: name, 'passive (N)': maxPush(d, false), 'balance (N)': maxPush(d, true) });
}
console.log('Largest survivable 0.1 s push on the torso (bisection, 3 s horizon).');
console.log("passive = servos holding Menagerie's 'stand' keyframe; balance = this controller.");
console.table(rows);
const ok = rows.every((r) => r['balance (N)'] > r['passive (N)']);
if (!ok) { console.error('balance controller is not better than passive in every direction'); process.exit(1); }
