# Vendored runtime files

Committed so the site works from any static host (GitHub Pages, Netlify, a plain `python -m http.server`)
with no CDN and no build step.

| Directory | Package | Version | License | Files |
|---|---|---|---|---|
| `mujoco/` | [`@mujoco/mujoco`](https://www.npmjs.com/package/@mujoco/mujoco) — official MuJoCo WASM bindings (single-threaded build) | 3.17.0 | Apache-2.0 | `mujoco.js`, `mujoco.wasm` |
| `three/` | [`three`](https://www.npmjs.com/package/three) | 0.180.0 | MIT (`three/LICENSE`) | `three.module.min.js`, `three.core.min.js`, `OrbitControls.js`, `BufferGeometryUtils.js` |
| `ort/` | [`onnxruntime-web`](https://www.npmjs.com/package/onnxruntime-web) — WASM-only bundle | 1.23.2 | MIT (declared in its package.json; no LICENSE file ships in the npm tarball) | `ort.wasm.min.mjs`, `ort-wasm-simd-threaded.{mjs,wasm}` |

To update: `npm pack <pkg>@<version>`, copy the files above, and run `npm test`.
The `//# sourceMappingURL` comment was removed from `ort.wasm.min.mjs` (the map isn't shipped).
