// JavaScript port of diffusion-pick's `dpick/env.py` (PickPlaceEnv): "put the red cube in the bowl".
//
// The MJCF is exported from diffusion-pick's own build_model() (tools/build_franka_scene.py), and
// this file mirrors the Python env line by line:
//   * action (10 Hz): absolute TCP target [x, y, z, yaw, grip], grip in [0, 1] (1 = close)
//   * a damped-least-squares IK loop at 250 Hz (every 2nd 500 Hz physics step) with null-space
//     posture regulation converts it to joint targets for the Panda's position servos
//   * proprio (12): [tcp xyz, sin yaw, cos yaw, finger width, q1..q6]
//   * success: red cube inside the bowl, resting on its floor, and released
// Layout randomization follows the same distributions (the PRNG differs from NumPy's, so a given
// seed gives a different layout than in Python).
import { la, Rng } from '../runtime.js';

export const HOME_Q = [0.0, 0.1, 0.0, -2.2, 0.0, 2.3, 0.785];
export const CONTROL_HZ = 10;
const PHYS_DT = 0.002;
export const N_SUBSTEPS = Math.round(1 / (CONTROL_HZ * PHYS_DT)); // 50
const IK_EVERY = 2;
const CUBE_HALF = 0.02;
const BOWL_R_IN = 0.075;
const BOWL_BASE_H = 0.006;
const WORKSPACE = { x: [0.38, 0.64], y: [-0.22, 0.22] };
const COLORS = ['red', 'green', 'blue'];

export class PickEnv {
  constructor(mj, model, data, { maxSteps = 200 } = {}) {
    this.mj = mj;
    this.m = model;
    this.d = data;
    this.maxSteps = maxSteps;
    const jid = (n) => model.jnt(n).id;
    this.armJnt = [1, 2, 3, 4, 5, 6, 7].map((i) => jid(`joint${i}`));
    this.armQ = this.armJnt.map((j) => model.jnt_qposadr[j]);
    this.armV = this.armJnt.map((j) => model.jnt_dofadr[j]);
    this.lo = this.armJnt.map((j) => model.jnt_range[2 * j] + 0.01);
    this.hi = this.armJnt.map((j) => model.jnt_range[2 * j + 1] - 0.01);
    this.fingerQ = ['finger_joint1', 'finger_joint2'].map((n) => model.jnt_qposadr[jid(n)]);
    this.tcp = model.site('tcp').id;
    this.bowl = model.body('bowl').id;
    this.cubeQ = Object.fromEntries(COLORS.map((c) => [c, model.jnt_qposadr[jid(`${c}_cube_joint`)]]));
    this.cubeBody = Object.fromEntries(COLORS.map((c) => [c, model.body(`${c}_cube`).id]));
    this.cam = { front: model.cam('front').id, wrist: model.cam('wrist').id };
    this.jacp = new mj.DoubleBuffer(3 * model.nv);
    this.jacr = new mj.DoubleBuffer(3 * model.nv);
    this.J = new Float64Array(42);
    this.target = new Float64Array(5);
    this.sub = N_SUBSTEPS; // substep index within the current control step (N = idle)
    this.t = 0;
  }

  // ------------------------------------------------------------------ state
  tcpPos() { const x = this.d.site_xpos; return [x[3 * this.tcp], x[3 * this.tcp + 1], x[3 * this.tcp + 2]]; }
  tcpRot() { return this.d.site_xmat.slice(9 * this.tcp, 9 * this.tcp + 9); }
  tcpYaw() { const R = this.tcpRot(); return Math.atan2(R[3], R[0]); }
  fingerWidth() { const q = this.d.qpos; return q[this.fingerQ[0]] + q[this.fingerQ[1]]; }
  cubePos(c = 'red') { const a = this.cubeQ[c], q = this.d.qpos; return [q[a], q[a + 1], q[a + 2]]; }
  cubeYaw(c = 'red') {
    const a = this.cubeQ[c], q = this.d.qpos;
    const [w, x, y, z] = [q[a + 3], q[a + 4], q[a + 5], q[a + 6]];
    const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)); // = atan2(R10, R00)
    const p4 = Math.PI / 4, p2 = Math.PI / 2;
    return ((((yaw + p4) % p2) + p2) % p2) - p4; // fold to [-pi/4, pi/4) like NumPy's %
  }
  bowlPos() { const p = this.m.body_pos; return [p[3 * this.bowl], p[3 * this.bowl + 1], p[3 * this.bowl + 2]]; }

  proprio() {
    const p = this.tcpPos(), yaw = this.tcpYaw(), q = this.d.qpos;
    const out = new Float32Array(12);
    out.set(p, 0);
    out[3] = Math.sin(yaw); out[4] = Math.cos(yaw); out[5] = this.fingerWidth();
    for (let i = 0; i < 6; i++) out[6 + i] = q[this.armQ[i]];
    return out;
  }

  /** Privileged object state used by the placeholder policy: red cube xyz, folded yaw, bowl xyz. */
  objectState() {
    return Float32Array.from([...this.cubePos('red'), this.cubeYaw('red'), ...this.bowlPos()]);
  }

  isSuccess() {
    const c = this.cubePos('red'), b = this.bowlPos();
    const inXY = Math.hypot(c[0] - b[0], c[1] - b[1]) < BOWL_R_IN - 0.01;
    const resting = c[2] < BOWL_BASE_H + CUBE_HALF + 0.015;
    const p = this.tcpPos();
    const released = this.fingerWidth() > 0.05 || Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]) > 0.04;
    return inXY && resting && released;
  }

  // ------------------------------------------------------------------ reset
  sampleLayout(rng) {
    for (let it = 0; it < 1000; it++) {
      const bowl = [rng.uniform(...WORKSPACE.x), rng.uniform(...WORKSPACE.y)];
      const pts = [];
      let ok = true;
      for (let k = 0; k < 3 && ok; k++) {
        let placed = false;
        for (let t = 0; t < 200; t++) {
          const p = [rng.uniform(...WORKSPACE.x), rng.uniform(...WORKSPACE.y)];
          if (Math.hypot(p[0] - bowl[0], p[1] - bowl[1]) < BOWL_R_IN + 0.06) continue;
          if (pts.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 0.075)) continue;
          pts.push(p); placed = true; break;
        }
        ok = placed;
      }
      if (ok) return { bowl, pts };
    }
    throw new Error('could not sample layout');
  }

  reset(seed) {
    const { mj, m, d } = this;
    const rng = new Rng(seed);
    this.seed = seed;
    mj.mj_resetData(m, d);
    const { bowl, pts } = this.sampleLayout(rng);
    const bp = m.body_pos;
    bp[3 * this.bowl] = bowl[0]; bp[3 * this.bowl + 1] = bowl[1];
    const qpos = d.qpos;
    COLORS.forEach((c, i) => {
      const a = this.cubeQ[c];
      const yaw = rng.uniform(-Math.PI / 4, Math.PI / 4);
      qpos.set([pts[i][0], pts[i][1], CUBE_HALF + 0.001, Math.cos(yaw / 2), 0, 0, Math.sin(yaw / 2)], a);
    });
    const q0 = HOME_Q.map((q) => q + 0.06 * rng.normal());
    this.armQ.forEach((a, i) => { qpos[a] = q0[i]; });
    this.fingerQ.forEach((a) => { qpos[a] = 0.04; });
    const ctrl = d.ctrl;
    for (let i = 0; i < 7; i++) ctrl[i] = q0[i];
    ctrl[7] = 255;
    mj.mj_forward(m, d);
    const p = this.tcpPos();
    this.target.set([p[0], p[1], p[2], this.tcpYaw(), 0]);
    for (let i = 0; i < Math.round(0.3 / PHYS_DT); i++) mj.mj_step(m, d);
    this.t = 0;
    this.sub = N_SUBSTEPS;
  }

  // ------------------------------------------------------------------ control
  ikStep(pos, yaw) {
    const { mj, m, d, J } = this;
    mj.mj_jacSite(m, d, this.jacp, this.jacr, this.tcp);
    const jp = this.jacp.GetView(), jr = this.jacr.GetView(), nv = m.nv;
    for (let c = 0; c < 7; c++) {
      const dof = this.armV[c];
      for (let r = 0; r < 3; r++) { J[r * 7 + c] = jp[r * nv + dof]; J[(r + 3) * 7 + c] = jr[r * nv + dof]; }
    }
    const sp = d.site_xpos, t = this.tcp;
    const err = new Float64Array(6);
    err[0] = pos[0] - sp[3 * t]; err[1] = pos[1] - sp[3 * t + 1]; err[2] = pos[2] - sp[3 * t + 2];
    let n = Math.hypot(err[0], err[1], err[2]);
    if (n > 0.04) for (let k = 0; k < 3; k++) err[k] *= 0.04 / n;
    // orientation error: Re = Rt R^T with Rt = hand pointing down with the given yaw
    const R = this.tcpRot();
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const Rt = [c, s, 0, s, -c, 0, 0, 0, -1];
    const Re = new Float64Array(9);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      Re[3 * i + j] = Rt[3 * i] * R[3 * j] + Rt[3 * i + 1] * R[3 * j + 1] + Rt[3 * i + 2] * R[3 * j + 2];
    }
    let qe = la.mat2quat(Re);
    if (qe[0] < 0) qe = qe.map((v) => -v);
    err[3] = 2 * qe[1]; err[4] = 2 * qe[2]; err[5] = 2 * qe[3];
    n = Math.hypot(err[3], err[4], err[5]);
    if (n > 0.4) for (let k = 3; k < 6; k++) err[k] *= 0.4 / n;
    // JJt = J J^T + lambda I
    const JJt = new Float64Array(36);
    for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) {
      let acc = 0;
      for (let k = 0; k < 7; k++) acc += J[i * 7 + k] * J[j * 7 + k];
      JJt[i * 6 + j] = acc + (i === j ? 1e-3 : 0);
    }
    const y1 = la.solve(JJt.slice(), err, 6);
    const qpos = d.qpos;
    const q = this.armQ.map((a) => qpos[a]);
    const dq = new Float64Array(7);
    for (let k = 0; k < 7; k++) { let acc = 0; for (let i = 0; i < 6; i++) acc += J[i * 7 + k] * y1[i]; dq[k] = acc; }
    // null-space posture regulation: (I - J^+ J) n,  J^+ = J^T (J J^T)^-1
    const nul = q.map((qi, k) => 0.2 * (HOME_Q[k] - qi));
    const Jn = new Float64Array(6);
    for (let i = 0; i < 6; i++) { let acc = 0; for (let k = 0; k < 7; k++) acc += J[i * 7 + k] * nul[k]; Jn[i] = acc; }
    const y2 = la.solve(JJt, Jn, 6);
    const ctrl = d.ctrl;
    for (let k = 0; k < 7; k++) {
      let acc = 0;
      for (let i = 0; i < 6; i++) acc += J[i * 7 + k] * y2[i];
      const qd = q[k] + dq[k] + nul[k] - acc;
      ctrl[k] = Math.min(this.hi[k], Math.max(this.lo[k], qd));
    }
  }

  /** Start a 10 Hz control step; then call substep() until it returns true. */
  beginStep(action) {
    const a = Array.from(action);
    a[0] = Math.min(0.8, Math.max(0.2, a[0]));
    a[1] = Math.min(0.4, Math.max(-0.4, a[1]));
    a[2] = Math.min(0.45, Math.max(0.0, a[2]));
    a[3] = Math.min(Math.PI / 2, Math.max(-Math.PI / 2, a[3]));
    a[4] = Math.min(1, Math.max(0, a[4]));
    this.target.set(a);
    this.d.ctrl[7] = 255 * (1 - a[4]);
    this.sub = 0;
  }

  get stepping() { return this.sub < N_SUBSTEPS; }

  /** One 500 Hz physics step. Returns true when the current control step has finished. */
  substep(beforeStep) {
    if (this.sub % IK_EVERY === 0) this.ikStep(this.target, this.target[3]);
    beforeStep?.();
    this.mj.mj_step(this.m, this.d);
    this.sub += 1;
    if (this.sub === N_SUBSTEPS) { this.t += 1; return true; }
    return false;
  }
}
