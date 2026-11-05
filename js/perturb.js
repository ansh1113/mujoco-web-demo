// Click/touch-drag perturbation, in the spirit of MuJoCo's native viewer: grab any movable body
// and pull it with a damped spring. The force is applied through data.xfrc_applied at the body's
// centre of mass (plus the matching torque for an off-centre grab point).
import * as THREE from 'three';

export class Perturb {
  /**
   * @param viewer   Viewer
   * @param {object} o
   * @param {number} o.stiffness  spring constant [N/m]
   * @param {number} o.damping    [N s/m] on the grab point's velocity
   * @param {number} o.maxForce   clamp [N]
   * @param {boolean} o.massScaled  stiffness/damping per kg of the grabbed body's subtree
   */
  constructor(viewer, { stiffness = 400, damping = 40, maxForce = 300, massScaled = false,
                        onChange = () => {} } = {}) {
    this.v = viewer;
    this.k0 = this.k = stiffness;
    this.c0 = this.c = damping;
    this.massScaled = massScaled; // if set, stiffness/damping are per kg of the grabbed subtree
    this.maxForce = maxForce;
    this.onChange = onChange;
    this.active = false;
    this.body = -1;
    this.local = new THREE.Vector3();      // grab point in the body frame
    this.target = new THREE.Vector3();     // where the pointer is (world)
    this.anchor = new THREE.Vector3();     // grab point (world)
    this.prevAnchor = null;
    this.vel = new THREE.Vector3();
    this.force = new THREE.Vector3();
    this.plane = new THREE.Plane();
    this.ray = new THREE.Raycaster();
    this.ndc = new THREE.Vector2();

    const lineGeom = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    this.line = new THREE.Line(lineGeom, new THREE.LineBasicMaterial({ color: 0xff5a36, depthTest: false }));
    this.line.renderOrder = 10;
    this.dot = new THREE.Mesh(new THREE.SphereGeometry(0.018, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xff5a36, depthTest: false }));
    this.dot.renderOrder = 11;
    this.grip = this.dot.clone();
    this.grip.scale.setScalar(0.6);
    this.line.visible = this.dot.visible = this.grip.visible = false;
    for (const o of [this.line, this.dot, this.grip]) o.layers.set(1);
    viewer.scene.add(this.line, this.dot, this.grip);

    // Listen on the container in the capture phase so a grab pre-empts OrbitControls.
    const el = viewer.container;
    this._down = (e) => this.onDown(e);
    this._move = (e) => this.onMove(e);
    this._up = (e) => this.onUp(e);
    el.addEventListener('pointerdown', this._down, true);
    el.addEventListener('pointermove', this._move, true);
    el.addEventListener('pointerup', this._up, true);
    el.addEventListener('pointercancel', this._up, true);
  }

  setRay(e) {
    const r = this.v.renderer.domElement.getBoundingClientRect();
    this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.v.camera);
  }

  onDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    this.setRay(e);
    const hit = this.ray.intersectObjects(this.v.pickables, false)[0];
    if (!hit) return;
    e.stopPropagation();
    e.preventDefault();
    this.v.controls.enabled = false;
    this.v.container.setPointerCapture?.(e.pointerId);
    this.pointerId = e.pointerId;
    this.active = true;
    this.body = hit.object.userData.bodyId;
    if (this.massScaled) {
      const mass = Math.max(this.v.model.body_subtreemass[this.body], 0.05);
      this.k = this.k0 * mass;
      this.c = this.c0 * mass;
    }
    const d = this.v.data;
    const b = this.body;
    const xp = d.xpos, xm = d.xmat;
    const rel = hit.point.clone().sub(new THREE.Vector3(xp[3 * b], xp[3 * b + 1], xp[3 * b + 2]));
    // local = R^T * rel  (xmat is row-major)
    this.local.set(
      xm[9 * b] * rel.x + xm[9 * b + 3] * rel.y + xm[9 * b + 6] * rel.z,
      xm[9 * b + 1] * rel.x + xm[9 * b + 4] * rel.y + xm[9 * b + 7] * rel.z,
      xm[9 * b + 2] * rel.x + xm[9 * b + 5] * rel.y + xm[9 * b + 8] * rel.z);
    this.target.copy(hit.point);
    const n = new THREE.Vector3();
    this.v.camera.getWorldDirection(n);
    this.plane.setFromNormalAndCoplanarPoint(n, hit.point);
    this.prevAnchor = null;
    this.v.container.classList.add('grabbing');
    this.onChange(this);
  }

  onMove(e) {
    if (!this.active) {
      // hover feedback
      if (e.pointerType === 'mouse') {
        this.setRay(e);
        const hit = this.ray.intersectObjects(this.v.pickables, false)[0];
        this.v.container.classList.toggle('can-grab', !!hit);
      }
      return;
    }
    if (e.pointerId !== this.pointerId) return;
    e.stopPropagation();
    this.setRay(e);
    const p = new THREE.Vector3();
    if (this.ray.ray.intersectPlane(this.plane, p)) this.target.copy(p);
  }

  onUp(e) {
    if (!this.active || e.pointerId !== this.pointerId) return;
    e.stopPropagation();
    this.release();
  }

  release() {
    if (this.body >= 0) {
      const xf = this.v.data.xfrc_applied;
      for (let k = 0; k < 6; k++) xf[6 * this.body + k] = 0;
    }
    this.active = false;
    this.body = -1;
    this.force.set(0, 0, 0);
    this.v.controls.enabled = true;
    this.v.container.classList.remove('grabbing');
    this.line.visible = this.dot.visible = this.grip.visible = false;
    this.onChange(this);
  }

  /** Grab point in world coordinates from the current body pose. */
  updateAnchor() {
    const d = this.v.data, b = this.body, l = this.local;
    const xp = d.xpos, xm = d.xmat;
    this.anchor.set(
      xp[3 * b] + xm[9 * b] * l.x + xm[9 * b + 1] * l.y + xm[9 * b + 2] * l.z,
      xp[3 * b + 1] + xm[9 * b + 3] * l.x + xm[9 * b + 4] * l.y + xm[9 * b + 5] * l.z,
      xp[3 * b + 2] + xm[9 * b + 6] * l.x + xm[9 * b + 7] * l.y + xm[9 * b + 8] * l.z);
  }

  /** Call before every mj_step. */
  apply(dt) {
    if (!this.active) return;
    const d = this.v.data, b = this.body;
    this.updateAnchor();
    if (this.prevAnchor) {
      this.vel.subVectors(this.anchor, this.prevAnchor).divideScalar(dt);
    } else {
      this.prevAnchor = new THREE.Vector3();
      this.vel.set(0, 0, 0);
    }
    this.prevAnchor.copy(this.anchor);
    const f = this.force.subVectors(this.target, this.anchor).multiplyScalar(this.k)
      .addScaledVector(this.vel, -this.c);
    if (f.length() > this.maxForce) f.setLength(this.maxForce);
    const xi = d.xipos;
    const rx = this.anchor.x - xi[3 * b], ry = this.anchor.y - xi[3 * b + 1], rz = this.anchor.z - xi[3 * b + 2];
    const xf = d.xfrc_applied;
    xf[6 * b] = f.x; xf[6 * b + 1] = f.y; xf[6 * b + 2] = f.z;
    xf[6 * b + 3] = ry * f.z - rz * f.y;
    xf[6 * b + 4] = rz * f.x - rx * f.z;
    xf[6 * b + 5] = rx * f.y - ry * f.x;
  }

  /** Update the rubber-band visuals (once per rendered frame). */
  draw() {
    if (!this.active) return;
    this.updateAnchor();
    const pos = this.line.geometry.attributes.position;
    pos.setXYZ(0, this.anchor.x, this.anchor.y, this.anchor.z);
    pos.setXYZ(1, this.target.x, this.target.y, this.target.z);
    pos.needsUpdate = true;
    this.line.geometry.computeBoundingSphere();
    this.dot.position.copy(this.target);
    this.grip.position.copy(this.anchor);
    this.line.visible = this.dot.visible = this.grip.visible = true;
  }

  dispose() {
    const el = this.v.container;
    el.removeEventListener('pointerdown', this._down, true);
    el.removeEventListener('pointermove', this._move, true);
    el.removeEventListener('pointerup', this._up, true);
    el.removeEventListener('pointercancel', this._up, true);
  }
}
