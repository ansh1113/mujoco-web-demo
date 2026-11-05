// Tab 1: Unitree G1 standing balance with click-drag perturbations.
import * as THREE from 'three';
import { loadScene } from '../runtime.js';
import { Viewer } from '../viewer.js';
import { Perturb } from '../perturb.js';
import { SimLoop } from '../loop.js';
import { BalanceController } from './balance.js';

const $ = (id) => document.getElementById(id);

function convexHull(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), q) <= 0) lower.pop(); lower.push(q); }
  for (const q of p.reverse()) { while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), q) <= 0) upper.pop(); upper.push(q); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

function insideHull(h, x, y) {
  for (let i = 0; i < h.length; i++) {
    const a = h[i], b = h[(i + 1) % h.length];
    if ((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]) < 0) return false;
  }
  return true;
}

export async function createBalanceDemo({ mj, ui }) {
  ui.progress(0.3, 'Loading Unitree G1 (MuJoCo Menagerie)…');
  const { model, data } = await loadScene(mj, 'assets/g1', 'g1', 'scene.xml',
    (f) => ui.progress(0.3 + 0.6 * f));
  const ctl = new BalanceController(mj, model);
  ctl.reset(data);

  const viewer = new Viewer({
    container: $('balance-view'), model, data,
    cameraPos: [1.75, -1.45, 1.1], cameraTarget: [0.05, 0, 0.6], fov: 38, shadowExtent: 1.4,
  });

  // ── overlays: support polygon, capture point, COM ground projection (layer 1 = decorations)
  const polyGeom = new THREE.BufferGeometry();
  polyGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * 16), 3));
  const poly = new THREE.LineLoop(polyGeom, new THREE.LineBasicMaterial({ color: 0x3b82f6 }));
  const cpMat = new THREE.MeshBasicMaterial({ color: 0x1f9d6b, side: THREE.DoubleSide });
  const cp = new THREE.Mesh(new THREE.RingGeometry(0.022, 0.034, 32), cpMat);
  const com = new THREE.Mesh(new THREE.CircleGeometry(0.014, 24), new THREE.MeshBasicMaterial({ color: 0x8a909a }));
  for (const o of [poly, cp, com]) { o.renderOrder = 5; o.material.depthTest = false; o.layers.set(1); viewer.scene.add(o); }
  const pushArrow = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 0.4, 0xff5a36, 0.1, 0.06);
  pushArrow.visible = false;
  pushArrow.traverse((o) => o.layers.set(1));
  viewer.scene.add(pushArrow);

  const forceChip = $('balance-force');
  const perturb = new Perturb(viewer, {
    stiffness: 700, damping: 80, maxForce: 160,
    onChange: (p) => { forceChip.hidden = !p.active; },
  });

  const status = $('balance-status');
  const setStatus = (text, state) => {
    if (status.textContent !== text) status.textContent = text;
    status.dataset.state = state;
  };

  const torso = model.body('torso_link').id;
  const pelvis = model.body('pelvis').id;
  const dt = model.opt.timestep;
  let push = null;          // { until, f: [fx, fy, fz] }
  let fallenAt = null;

  function reset() {
    perturb.release();
    ctl.reset(data);
    push = null;
    fallenAt = null;
    data.xfrc_applied.fill(0);
  }

  function advance(simDt) {
    const n = Math.max(1, Math.round(simDt / dt));
    for (let i = 0; i < n; i++) {
      if (push) {
        const xf = data.xfrc_applied;
        const on = data.time < push.until;
        for (let k = 0; k < 3; k++) xf[6 * torso + k] = on ? push.f[k] : 0;
        if (!on) push = null;
      }
      perturb.apply(dt);
      ctl.compute(data);
      mj.mj_step(model, data);
    }
    if (ctl.fallen(data)) {
      fallenAt ??= performance.now();
      if (performance.now() - fallenAt > 1800) reset();
    } else {
      fallenAt = null;
    }
    return n * dt;
  }

  const camShift = new THREE.Vector3();
  let lastUi = 0;
  function draw() {
    viewer.sync();
    perturb.draw();
    const s = ctl.state;
    // follow the robot (keeps it in frame after big shoves)
    const px = data.xpos[3 * pelvis], py = data.xpos[3 * pelvis + 1];
    const tgt = viewer.controls.target;
    camShift.set((px - tgt.x) * 0.04, (py - tgt.y) * 0.04, 0);
    tgt.add(camShift);
    viewer.camera.position.add(camShift);
    viewer.followShadow(px, py);

    const hull = convexHull(s.footPts);
    const pos = polyGeom.attributes.position;
    hull.forEach((p, i) => pos.setXYZ(i, p[0], p[1], 0.002));
    polyGeom.setDrawRange(0, hull.length);
    pos.needsUpdate = true;
    polyGeom.computeBoundingSphere();
    const inside = hull.length > 2 && insideHull(hull, s.cp[0], s.cp[1]);
    cp.position.set(s.cp[0], s.cp[1], 0.003);
    cpMat.color.set(inside ? 0x1f9d6b : 0xff5a36);
    com.position.set(s.com[0], s.com[1], 0.003);
    const showOverlay = !ctl.fallen(data);
    poly.visible = cp.visible = com.visible = showOverlay;

    if (push) {
      const f = new THREE.Vector3(...push.f);
      const tp = new THREE.Vector3(data.xpos[3 * torso], data.xpos[3 * torso + 1], data.xpos[3 * torso + 2]);
      pushArrow.setDirection(f.clone().normalize());
      pushArrow.position.copy(tp).addScaledVector(f.clone().normalize(), -0.5);
      pushArrow.visible = true;
    } else {
      pushArrow.visible = false;
    }
    viewer.render();

    const now = performance.now();
    if (now - lastUi > 120) {
      lastUi = now;
      if (ctl.fallen(data)) setStatus('Fell over — resetting…', 'bad');
      else if (!ctl.enabled) setStatus('Controller off (holding keyframe)', 'busy');
      else if (perturb.active || push) setStatus('Recovering', 'busy');
      else setStatus('Balancing', 'ok');
      if (perturb.active) forceChip.textContent = `pull ${perturb.force.length().toFixed(0)} N`;
      const e = Math.hypot(s.err[0], s.err[1]);
      $('balance-cp').textContent = `${(100 * e).toFixed(1)} cm`;
      $('balance-height').textContent = `${data.qpos[2].toFixed(2)} m`;
      $('balance-speed').textContent = `${loop.speed.toFixed(2)}×`;
    }
  }

  const loop = new SimLoop(advance, draw);

  $('balance-reset').addEventListener('click', reset);
  $('balance-push').addEventListener('click', () => {
    if (ctl.fallen(data)) return;
    const yaw = Math.atan2(data.xmat[9 * pelvis + 3], data.xmat[9 * pelvis]);
    const a = yaw + Math.random() * 2 * Math.PI;
    const F = 130;
    push = { until: data.time + 0.1, f: [F * Math.cos(a), F * Math.sin(a), 0] };
  });
  $('balance-toggle').addEventListener('change', (e) => {
    ctl.enabled = e.target.checked;
    reset();
  });

  return {
    start: () => loop.start(),
    stop: () => loop.stop(),
    applyTheme: () => viewer.applyTheme(),
    // used by the Playwright tests
    debug: { mj, model, data, ctl, viewer, perturb, loop, reset,
      push: (f) => { push = { until: data.time + 0.1, f }; } },
  };
}
