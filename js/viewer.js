// three.js renderer for a MuJoCo model: builds one Object3D per visible geom from the compiled
// MjModel (primitives + mesh buffers) and copies geom_xpos / geom_xmat into them every frame.
// MuJoCo's z-up world frame is used directly (camera.up = +z).
import * as THREE from 'three';
import { OrbitControls } from '../vendor/three/OrbitControls.js';
import { toCreasedNormals } from '../vendor/three/BufferGeometryUtils.js';

export const GEOM = { PLANE: 0, HFIELD: 1, SPHERE: 2, CAPSULE: 3, ELLIPSOID: 4, CYLINDER: 5, BOX: 6, MESH: 7 };

export function themeColor(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return new THREE.Color(v || fallback);
}

export class Viewer {
  /**
   * @param {object} o
   * @param {HTMLElement} o.container  element that receives the canvas
   * @param o.model MjModel, o.data MjData
   * @param {number[]} [o.groups]       geom groups to draw (MuJoCo default visible: 0, 1, 2)
   * @param {number[]} o.cameraPos, o.cameraTarget
   */
  constructor({ container, model, data, groups = [0, 1, 2], cameraPos, cameraTarget, fov = 40,
                shadowExtent = 1.5, floorGrid = true }) {
    this.container = container;
    this.model = model;
    this.data = data;
    this.groups = new Set(groups);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.domElement.className = 'sim-canvas';
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(fov, 1, 0.02, 60);
    this.camera.up.set(0, 0, 1);
    this.camera.position.fromArray(cameraPos);
    this.camera.layers.enable(1); // layer 1 = decorations (grid, drag handles, overlays)
    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.target.fromArray(cameraTarget);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.minDistance = 0.4;
    this.controls.maxDistance = 8;
    this.controls.update();

    const hemi = new THREE.HemisphereLight(0xffffff, 0x7d828c, 1.25);
    hemi.position.set(0, 0, 1);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xffffff, 2.3);
    sun.position.set(1.5, -1.2, 3.0);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.02;
    const sc = sun.shadow.camera;
    sc.left = sc.bottom = -shadowExtent; sc.right = sc.top = shadowExtent; sc.near = 0.1; sc.far = 10;
    this.scene.add(sun, sun.target);
    this.sun = sun;
    this.sunOffset = sun.position.clone();

    this.meshCache = new Map();
    this.objects = [];   // { obj, geomId }
    this.pickables = [];
    this.floorGrid = floorGrid;
    this.buildGeoms();
    this.applyTheme();

    this._mat = new THREE.Matrix4();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
  }

  applyTheme() {
    this.scene.background = themeColor('--sim-bg', '#eef0f3');
    this.scene.fog = new THREE.Fog(this.scene.background, 5, 13);
    if (this.floorMat) this.floorMat.color.copy(themeColor('--sim-floor', '#e3e5e8'));
    if (this.grid) {
      const c = themeColor('--sim-grid', '#c9ccd2');
      this.grid.material.color.copy(c);
    }
  }

  resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  meshGeometry(id) {
    if (this.meshCache.has(id)) return this.meshCache.get(id);
    const m = this.model;
    const vert = m.mesh_vert, face = m.mesh_face;
    const vadr = m.mesh_vertadr[id], fadr = m.mesh_faceadr[id], nf = m.mesh_facenum[id];
    const pos = new Float32Array(nf * 9);
    for (let f = 0; f < nf; f++) {
      for (let j = 0; j < 3; j++) {
        const vi = vadr + face[3 * (fadr + f) + j];
        pos[9 * f + 3 * j] = vert[3 * vi];
        pos[9 * f + 3 * j + 1] = vert[3 * vi + 1];
        pos[9 * f + 3 * j + 2] = vert[3 * vi + 2];
      }
    }
    let g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    // Smooth normals within 35 degrees, hard edges beyond: decimated meshes ship poor normals.
    g = toCreasedNormals(g, (35 * Math.PI) / 180);
    g.computeBoundingSphere();
    this.meshCache.set(id, g);
    return g;
  }

  geomGeometry(i) {
    const m = this.model;
    const t = m.geom_type[i];
    const s = [m.geom_size[3 * i], m.geom_size[3 * i + 1], m.geom_size[3 * i + 2]];
    switch (t) {
      case GEOM.SPHERE: return new THREE.SphereGeometry(s[0], 24, 16);
      case GEOM.ELLIPSOID: return new THREE.SphereGeometry(1, 24, 16).scale(s[0], s[1], s[2]);
      case GEOM.CAPSULE: return new THREE.CapsuleGeometry(s[0], 2 * s[1], 8, 20).rotateX(Math.PI / 2);
      case GEOM.CYLINDER: return new THREE.CylinderGeometry(s[0], s[0], 2 * s[1], 32).rotateX(Math.PI / 2);
      case GEOM.BOX: return new THREE.BoxGeometry(2 * s[0], 2 * s[1], 2 * s[2]);
      case GEOM.MESH: return this.meshGeometry(m.geom_dataid[i]);
      default: return null;
    }
  }

  buildGeoms() {
    const m = this.model;
    const rgba = m.geom_rgba, matRgba = m.mat_rgba;
    for (let i = 0; i < m.ngeom; i++) {
      if (!this.groups.has(m.geom_group[i])) continue;
      const matId = m.geom_matid[i];
      const c = matId >= 0 ? matRgba.subarray(4 * matId, 4 * matId + 4) : rgba.subarray(4 * i, 4 * i + 4);
      if (c[3] === 0) continue;
      const color = new THREE.Color().setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);
      if (m.geom_type[i] === GEOM.PLANE) {
        this.addFloor(i, color);
        continue;
      }
      const geom = this.geomGeometry(i);
      if (!geom) continue;
      const mat = new THREE.MeshStandardMaterial({
        color, roughness: 0.55, metalness: 0.05, transparent: c[3] < 1, opacity: c[3],
      });
      const obj = new THREE.Mesh(geom, mat);
      obj.castShadow = true;
      obj.receiveShadow = true;
      obj.matrixAutoUpdate = false;
      obj.userData.geomId = i;
      obj.userData.bodyId = m.geom_bodyid[i];
      this.scene.add(obj);
      this.objects.push({ obj, geomId: i });
      if (m.body_weldid[m.geom_bodyid[i]] !== 0) this.pickables.push(obj);
    }
  }

  addFloor(i, color) {
    const m = this.model;
    const sx = m.geom_size[3 * i] || 20;
    const sy = m.geom_size[3 * i + 1] || 20;
    const g = new THREE.PlaneGeometry(2 * sx, 2 * sy);
    this.floorModelColor = color.clone(); // the MJCF colour (the theme colour is applied on top)
    this.floorMat = new THREE.MeshStandardMaterial({ color, roughness: 0.95, metalness: 0 });
    const floor = new THREE.Mesh(g, this.floorMat);
    floor.receiveShadow = true;
    floor.matrixAutoUpdate = false;
    this.scene.add(floor);
    this.objects.push({ obj: floor, geomId: i });
    if (this.floorGrid) {
      const half = Math.min(sx, 6);
      const grid = new THREE.GridHelper(2 * half, 4 * half, 0xcccccc, 0xcccccc);
      grid.rotateX(Math.PI / 2);
      grid.material.transparent = true;
      grid.material.opacity = 0.6;
      grid.position.z = 0.0005;
      grid.layers.set(1);
      floor.add(grid);
      this.grid = grid;
    }
  }

  /** Copy geom poses from MjData into the scene graph. */
  sync() {
    const xpos = this.data.geom_xpos, xmat = this.data.geom_xmat;
    const M = this._mat;
    for (const { obj, geomId: i } of this.objects) {
      const p = 3 * i, r = 9 * i;
      M.set(xmat[r], xmat[r + 1], xmat[r + 2], xpos[p],
            xmat[r + 3], xmat[r + 4], xmat[r + 5], xpos[p + 1],
            xmat[r + 6], xmat[r + 7], xmat[r + 8], xpos[p + 2],
            0, 0, 0, 1);
      obj.matrix.copy(M);
      obj.matrixWorldNeedsUpdate = true;
    }
  }

  /** Keep the shadow frustum centred on a point of interest (e.g. the robot). */
  followShadow(x, y) {
    this.sun.target.position.set(x, y, 0);
    this.sun.position.set(x + this.sunOffset.x, y + this.sunOffset.y, this.sunOffset.z);
  }

  render() {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
