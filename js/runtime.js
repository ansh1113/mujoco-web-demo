// MuJoCo WebAssembly runtime: loads the official @mujoco/mujoco build once and
// compiles MJCF scenes from files fetched into its in-memory file system.
import loadMujoco from '../vendor/mujoco/mujoco.js';

let mujocoPromise = null;

/** Lazily instantiate the (single-threaded) MuJoCo WASM module. */
export function getMujoco() {
  if (!mujocoPromise) {
    mujocoPromise = loadMujoco({
      locateFile: (path) => new URL(`../vendor/mujoco/${path}`, import.meta.url).href,
      print: () => {},
      printErr: (msg) => console.warn('[mujoco]', msg),
    });
  }
  return mujocoPromise;
}

function mkdirs(FS, path) {
  let cur = '';
  for (const part of path.split('/').filter(Boolean)) {
    cur += `/${part}`;
    try { FS.mkdir(cur); } catch { /* exists */ }
  }
}

/**
 * Fetch every file listed in `<baseUrl>/manifest.json` into MuJoCo's virtual FS under `/<name>`
 * and compile `entry`. Returns { model, data }.
 */
export async function loadScene(mj, baseUrl, name, entry, onProgress = () => {}) {
  const root = `/${name}`;
  const manifest = await (await fetch(`${baseUrl}/manifest.json`)).json();
  let done = 0;
  await Promise.all(manifest.files.map(async (file) => {
    const res = await fetch(`${baseUrl}/${file}`);
    if (!res.ok) throw new Error(`failed to fetch ${baseUrl}/${file}: ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    const full = `${root}/${file}`;
    mkdirs(mj.FS, full.slice(0, full.lastIndexOf('/')));
    mj.FS.writeFile(full, buf);
    onProgress(++done / manifest.files.length);
  }));
  const model = mj.MjModel.from_xml_path(`${root}/${entry}`);
  const data = new mj.MjData(model);
  return { model, data };
}

/** Small linear-algebra helpers shared by the controllers (row-major, Float64Array). */
export const la = {
  /** Solve A x = b in place for a dense n x n system (Gaussian elimination, partial pivoting). */
  solve(A, b, n) {
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(A[r * n + c]) > Math.abs(A[p * n + c])) p = r;
      if (p !== c) {
        for (let k = 0; k < n; k++) { const t = A[c * n + k]; A[c * n + k] = A[p * n + k]; A[p * n + k] = t; }
        const t = b[c]; b[c] = b[p]; b[p] = t;
      }
      const piv = A[c * n + c];
      for (let r = c + 1; r < n; r++) {
        const f = A[r * n + c] / piv;
        if (f === 0) continue;
        for (let k = c; k < n; k++) A[r * n + k] -= f * A[c * n + k];
        b[r] -= f * b[c];
      }
    }
    for (let r = n - 1; r >= 0; r--) {
      let s = b[r];
      for (let k = r + 1; k < n; k++) s -= A[r * n + k] * b[k];
      b[r] = s / A[r * n + r];
    }
    return b;
  },
  /** Quaternion (w, x, y, z) from a row-major 3x3 rotation matrix. */
  mat2quat(R) {
    const tr = R[0] + R[4] + R[8];
    let w, x, y, z;
    if (tr > 0) {
      const s = Math.sqrt(tr + 1) * 2;
      w = 0.25 * s; x = (R[7] - R[5]) / s; y = (R[2] - R[6]) / s; z = (R[3] - R[1]) / s;
    } else if (R[0] > R[4] && R[0] > R[8]) {
      const s = Math.sqrt(1 + R[0] - R[4] - R[8]) * 2;
      w = (R[7] - R[5]) / s; x = 0.25 * s; y = (R[1] + R[3]) / s; z = (R[2] + R[6]) / s;
    } else if (R[4] > R[8]) {
      const s = Math.sqrt(1 + R[4] - R[0] - R[8]) * 2;
      w = (R[2] - R[6]) / s; x = (R[1] + R[3]) / s; y = 0.25 * s; z = (R[5] + R[7]) / s;
    } else {
      const s = Math.sqrt(1 + R[8] - R[0] - R[4]) * 2;
      w = (R[3] - R[1]) / s; x = (R[2] + R[6]) / s; y = (R[5] + R[7]) / s; z = 0.25 * s;
    }
    return [w, x, y, z];
  },
};

/** Seedable PRNG (mulberry32) + Gaussian samples, so episodes are reproducible from a seed. */
export class Rng {
  constructor(seed = 1) { this.s = seed >>> 0; this.spare = null; }
  next() {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  uniform(lo, hi) { return lo + (hi - lo) * this.next(); }
  normal() {
    if (this.spare !== null) { const s = this.spare; this.spare = null; return s; }
    let u = 0; while (u === 0) u = this.next();
    const v = this.next();
    const r = Math.sqrt(-2 * Math.log(u));
    this.spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  }
}
