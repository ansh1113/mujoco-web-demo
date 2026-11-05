// Standing balance controller for the Menagerie Unitree G1 (29-DoF, position-servo actuators).
//
// Every physics step (500 Hz) it reads the whole-body centre of mass, its velocity and the pelvis
// attitude, and adds feedback offsets to a slightly crouched nominal posture:
//
//   capture point     xi = c_xy + v_xy / omega,   omega = sqrt(g / z_com)
//   error             e  = xi - (support centre + forward bias), expressed in the heading frame
//   ankle strategy    ankle pitch / roll  += Ka * e  + Kv * v          (shift the centre of pressure)
//   hip strategy      hip pitch / roll    += Kt * tilt + Kw * rate + Kh * e   (keep pelvis upright,
//                                                                              swing the trunk)
//   waist             waist pitch         += Kw * pelvis pitch                 (torso upright)
//
// The joint servos (kp = 500, critically damped, Menagerie defaults) turn these target offsets into
// torques. Gains were tuned offline in Python MuJoCo 3.17 (same engine as this WASM build) by random
// search on a push-recovery benchmark: 0.1 s pushes on the torso from 6 directions.

export const GAINS = {
  hip0: -0.1759, knee0: 0.4163, ank0: -0.1542, // nominal crouch (rad)
  xoff: 0.0554,                                 // capture-point target ahead of the support centre (m)
  kap: 3.8346, kav: -0.2361,                    // ankle pitch: CP error, COM velocity
  khp: 0.4369, khd: 0.0, khx: 1.228,            // hip pitch: pelvis pitch, pitch rate, CP error
  karl: 0.3212, karv: -0.4562,                  // ankle roll: CP error, COM velocity
  khr: -0.3969, khrd: -0.056, khy: 1.1544,      // hip roll: pelvis roll, roll rate, CP error
  kwp: 0.7413,                                  // waist pitch: pelvis pitch
};

const G = 9.81;
const LEG_JOINTS = ['hip_pitch', 'hip_roll', 'hip_yaw', 'knee', 'ankle_pitch', 'ankle_roll'];

export class BalanceController {
  constructor(mj, model, gains = GAINS) {
    this.mj = mj;
    this.m = model;
    this.g = gains;
    this.enabled = true;
    const act = (n) => model.actuator(n).id;
    this.leg = {};
    for (const side of ['left', 'right']) this.leg[side] = LEG_JOINTS.map((j) => act(`${side}_${j}_joint`));
    this.waistPitch = act('waist_pitch_joint');
    this.pelvis = model.body('pelvis').id;
    this.torso = model.body('torso_link').id;
    // foot contact spheres (4 per foot) define the support polygon
    this.footGeoms = [];
    const leftFoot = model.body('left_ankle_roll_link').id, rightFoot = model.body('right_ankle_roll_link').id;
    for (let i = 0; i < model.ngeom; i++) {
      const b = model.geom_bodyid[i];
      if (model.geom_type[i] === 2 && (b === leftFoot || b === rightFoot)) this.footGeoms.push(i);
    }
    this.jntQpos = [];
    for (let i = 0; i < model.nu; i++) this.jntQpos.push(model.jnt_qposadr[model.actuator_trnid[2 * i]]);
    this.q0 = this.nominal();
    this.qKey = Float64Array.from(model.key_ctrl.subarray(0, model.nu)); // Menagerie 'stand' (straight legs)
    this.u = new Float64Array(model.nu);
    this.state = { com: [0, 0, 0], cp: [0, 0], support: [0, 0], err: [0, 0], footPts: [] };
  }

  nominal() {
    const q0 = Float64Array.from(this.m.key_ctrl.subarray(0, this.m.nu));
    for (const side of ['left', 'right']) {
      const [hp, , , kn, ap] = this.leg[side];
      q0[hp] = this.g.hip0;
      q0[kn] = this.g.knee0;
      q0[ap] = this.g.ank0;
    }
    return q0;
  }

  /** Put the robot in the nominal posture with its feet on the floor. */
  reset(data) {
    const { mj, m } = this;
    mj.mj_resetDataKeyframe(m, data, 0);
    const qpos = data.qpos;
    const q = this.enabled ? this.q0 : this.qKey;
    this.jntQpos.forEach((adr, i) => { qpos[adr] = q[i]; });
    mj.mj_forward(m, data);
    let zmin = Infinity;
    const gx = data.geom_xpos, gs = m.geom_size;
    for (const g of this.footGeoms) zmin = Math.min(zmin, gx[3 * g + 2] - gs[3 * g]);
    data.qpos[2] -= zmin;
    data.ctrl.set(q);
    mj.mj_forward(m, data);
  }

  /** Compute actuator targets; call once per physics step, before mj_step. */
  compute(data) {
    const { mj, m, g } = this;
    const u = this.u;
    // Disabled = what Menagerie gives you out of the box: servos holding the 'stand' keyframe.
    u.set(this.enabled ? this.q0 : this.qKey);
    mj.mj_subtreeVel(m, data);
    const P = this.pelvis;
    const com = data.subtree_com, lv = data.subtree_linvel;
    const c = [com[3 * P], com[3 * P + 1], com[3 * P + 2]];
    const v = [lv[3 * P], lv[3 * P + 1], lv[3 * P + 2]];
    const gx = data.geom_xpos;
    let sx = 0, sy = 0, sz = 0;
    const pts = this.state.footPts;
    pts.length = 0;
    for (const gi of this.footGeoms) {
      sx += gx[3 * gi]; sy += gx[3 * gi + 1]; sz += gx[3 * gi + 2];
      pts.push([gx[3 * gi], gx[3 * gi + 1]]);
    }
    const n = this.footGeoms.length;
    sx /= n; sy /= n; sz /= n;
    const R = data.xmat.subarray(9 * P, 9 * P + 9);
    const yaw = Math.atan2(R[3], R[0]);
    const cy = Math.cos(yaw), sny = Math.sin(yaw);
    const w = Math.sqrt(G / Math.max(c[2] - sz, 0.3));
    const xi = [c[0] + v[0] / w, c[1] + v[1] / w];
    // forward bias is along the robot heading
    const ewx = xi[0] - sx - g.xoff * cy, ewy = xi[1] - sy - g.xoff * sny;
    const ex = cy * ewx + sny * ewy;
    const ey = -sny * ewx + cy * ewy;
    const vx = cy * v[0] + sny * v[1];
    const vy = -sny * v[0] + cy * v[1];
    const zx = R[2], zy = R[5];
    const pitch = cy * zx + sny * zy;
    const roll = -(-sny * zx + cy * zy);
    const cv = data.cvel;
    const wpitch = -sny * cv[6 * P] + cy * cv[6 * P + 1];
    const wroll = cy * cv[6 * P] + sny * cv[6 * P + 1];

    Object.assign(this.state, { com: c, cp: xi, support: [sx, sy], err: [ex, ey], yaw });

    if (this.enabled) {
      for (const side of ['left', 'right']) {
        const [hp, hr, , , ap, ar] = this.leg[side];
        u[ap] += g.kap * ex + g.kav * vx;
        u[hp] += g.khp * pitch + g.khd * wpitch + g.khx * ex;
        u[ar] += g.karl * ey + g.karv * vy;
        u[hr] += g.khr * roll + g.khrd * wroll + g.khy * ey;
      }
      u[this.waistPitch] += g.kwp * pitch;
    }
    data.ctrl.set(u);
    return u;
  }

  /** Fallen = pelvis low, or torso tipped more than ~55 degrees from vertical. */
  fallen(data) {
    const upZ = data.xmat[9 * this.torso + 8];
    return data.qpos[2] < 0.5 || upZ < 0.57;
  }
}
