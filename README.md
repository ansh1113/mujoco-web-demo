# mujoco-web-demo

MuJoCo physics running entirely in the browser via the official WebAssembly build. It is a static site:
no backend and no build step, and every dependency is vendored.

| Tab | What you can do |
|---|---|
| **Humanoid balance** | Click-drag (or touch-drag) the **Unitree G1** from MuJoCo Menagerie to shove it while a capture-point balance controller written in JavaScript keeps it standing. Toggle the controller off to compare with the bare position servos. |
| **Policy pick-and-place** | A **Franka Panda** puts the red cube in the bowl. The task is the one from [diffusion-pick](https://github.com/ansh1113/diffusion-pick), driven by an **ONNX policy** through onnxruntime-web. The default is diffusion-pick's Diffusion Policy (`dp_reduced`, from pixels); a scripted placeholder is selectable. You can drag the cubes or the arm to disturb it. |

![Humanoid balance tab: G1 being pulled by the torso, with the support polygon and capture point drawn on the floor](docs/screenshots/balance.jpg)

![Pick-and-place tab: Panda carrying the red cube, with the policy's 64x64 front and wrist camera views in the side panel](docs/screenshots/pick.jpg)

<p align="center">
  <img src="docs/screenshots/mobile-balance.jpg" width="270" alt="Balance tab on a phone">
  &nbsp;&nbsp;
  <img src="docs/screenshots/mobile-pick.jpg" width="270" alt="Pick-and-place tab on a phone">
</p>

*Screenshots are written by the Playwright test (`npm test`) in headless Chromium with SwiftShader software WebGL.
That renderer is also why the "Sim speed" readout shows about 0.45× in them; on a GPU both demos run in real time.*

## Run it

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000. Any static host works: GitHub Pages, Netlify, or `npx serve`. The tab state is
kept in the URL hash (`#balance`, `#pick`).

To deploy on GitHub Pages, go to Settings → Pages and set the source to the default branch, root folder. No
cross-origin-isolation headers are needed because the single-threaded MuJoCo and onnxruntime builds are used.

## Tab 1: Unitree G1 balance

* **Model.** `assets/g1/g1.xml` is Menagerie's 29-DoF G1, unmodified. Its meshes are decimated from 393k to 45k
  triangles (`tools/build_g1_assets.py`), which cuts them from 20 MB to 2 MB. The masses and inertias are explicit
  in the MJCF, and the build script asserts that they are identical to Menagerie's.
* **Perturbation.** Grab any body to drag it with a damped spring (capped at 160 N), applied through
  `xfrc_applied` at the body's centre of mass, with the matching torque for an off-centre grab. *Random push*
  applies 130 N for 0.1 s to the torso.
* **Controller** (`js/g1/balance.js`, about 150 lines). It runs every 2 ms physics step:
  * It computes the whole-body COM *c*, the COM velocity *v* and the capture point *ξ = c + v/ω*, with *ω = √(g/z)*.
  * The capture-point error relative to the foot-support centre, taken in the robot's heading frame, drives an
    **ankle strategy** (ankle pitch/roll offsets that move the centre of pressure).
  * It also drives a **hip strategy**: hip pitch/roll offsets from the CP error plus pelvis tilt and rate.
  * A waist term keeps the torso upright.
  * The offsets are added to a slightly crouched posture, and Menagerie's position servos (kp = 500, critically
    damped) turn them into torques.
* **Tuning.** Gains were found by random search in Python MuJoCo 3.17 (the same engine version as the WASM build)
  on a push benchmark. The JS port reproduces the Python numbers.

`npm run bench` (`tests/balance_bench.mjs`) runs this benchmark headless in Node, with the shipped JS controller
and the shipped WASM build. Each value is the largest 0.1 s push on the torso that the robot survives:

| Direction | Servos holding Menagerie `stand` keyframe | Balance controller |
|---|---:|---:|
| forward | 50 N | **250 N** |
| backward | 38 N | **113 N** |
| left / right | 144 N | **169 N** |
| forward-left | 69 N | **219 N** |
| back-left | 56 N | **169 N** |

**Limits.** This is a standing controller and it does not take steps. A sustained sideways pull of about 50 N
needs more centre-of-pressure shift than the 30 cm stance allows, so the robot tips onto one foot and pivots or
falls. The page auto-resets 1.8 s after a fall. Capture-point stepping is the natural next step. A first
IK-based stepping attempt was not shipped: it lifted the swing foot without first shifting weight onto the stance
foot, so the robot rolled toward the unsupported side and forward push tolerance dropped from 250 N to 56 N. A real
stepping controller needs a weight-shift phase before lift-off.

## Tab 2: Franka pick-and-place with an ONNX policy

* **Scene.** `assets/franka/pick_scene.xml` is produced by diffusion-pick's own `dpick.env.build_model()`
  (`tools/build_franka_scene.py` serializes the `MjSpec`). It has the same Panda with the lite visual meshes, the
  same table, cubes and bowl, and the same `front` and `wrist` cameras, lights and solver options.
* **Environment.** `js/franka/env.js` ports `PickPlaceEnv` line by line:
  * a 10 Hz action `[x, y, z, yaw, grip]` (absolute TCP target);
  * a 250 Hz damped-least-squares IK loop with null-space posture regulation;
  * the same layout randomization, 12-D proprio and success test.
* **Policy loop** (`js/franka/app.js`, `js/franka/policy.js`). It mirrors `scripts/eval_onnx.py`:
  * It keeps an observation history of `To` frames.
  * When the action queue is empty, it runs the model and enqueues actions `To-1 … To-1+7`, a receding horizon of
    8 steps, i.e. 0.8 s.
  * Physics pauses while inference is in flight.
  * Episodes time out after 200 steps (20 s). After a success, a new random layout starts.
* **Observations.** Proprio is read from MuJoCo. `front_rgb` and `wrist_rgb` are 64×64 renders of the MJCF cameras.
  They are read back asynchronously into the uint8 `[1, To, 3, 64, 64]` layout diffusion-pick uses, and shown in
  the side panel as "what the policy sees".

### Policy slot

The tab loads the model named in **[`js/franka/policy-slot.js`](js/franka/policy-slot.js)**. Inputs are fed
**by name**, so any model that uses a subset of `front_rgb`, `wrist_rgb`, `proprio`, `noise` and `object_state`
works without code changes. See [`models/README.md`](models/README.md) for the full contract.

* **Default: `models/dp_reduced.onnx` (27 MB).** diffusion-pick's Diffusion Policy exactly as exported
  (`exports/dp_reduced.onnx`, plus its `.json` metadata). It sees only the 64×64 `front`/`wrist` renders and proprio.
  In this page's renderer it succeeds on **40/50** layouts (`results/browser_eval_dp_reduced.json`, via
  `node tools/lab/run.cjs eval --policy models/dp_reduced.onnx --seeds 1000:1050`), against 87/100 in
  diffusion-pick's own MuJoCo-rendered eval. Its DDIM-unrolled graph takes about 95–105 ms per chunk on
  single-threaded WASM.
* **Placeholder: `models/placeholder_pick.onnx` (5.8 KB)**, selectable in the page. A scripted, stateless
  controller compiled to ONNX ops by `tools/make_placeholder_policy.py`; it reads **privileged** `object_state`
  instead of images, so it is a stand-in for the wiring, not a learned policy (50/50 in Python, 20/20 in the JS port).
* **Other exports** load through **Load .onnx…**, `?policy=models/<name>.onnx#pick`, or `policy-slot.js`;
  inputs are matched by name.

**Visual sim-to-sim gap.** The browser renders the cameras with three.js, not with MuJoCo's OpenGL renderer.
Geometry, camera poses, FOV and the black background match, but lighting and shading differ (three.js renders the
table darker and the shadows softer). That accounts for the drop from 87% to 80%; a fine-tune on browser-rendered
demos is in progress.

## Tests

```bash
npm test
```

This runs `tests/e2e.cjs` with Playwright and headless Chromium, using SwiftShader WebGL. The test:

* serves the site statically;
* checks that the G1 stands, survives a 130 N push with the controller on and falls without it;
* performs a real mouse drag on the torso and checks that grab and release work;
* switches tabs and checks that the hidden tab's loop stops;
* waits for the placeholder to put the cube in the bowl, and checks that the 64×64 policy views render;
* loads diffusion-pick's `dp_reduced.onnx` through the file input and checks that it runs 20 control steps
  without errors;
* repeats the drag and tab checks on an iPhone 13 viewport, with touch drag and a check for horizontal overflow;
* **fails on any console error or warning, page error, failed request or HTTP 4xx/5xx**;
* rewrites the screenshots in `docs/screenshots/`.

Set `SCREENSHOTS=0` to keep the screenshots, or `DPICK_ONNX=…` to point it at another export. On the last run all
19 checks passed with 0 console messages.

```bash
npm run bench
```

This runs the push-recovery table above, in Node.

## Layout

```
index.html, css/style.css      page shell (tabs, panels; light/dark, mobile layout)
js/main.js                     tab switching, lazy loading, only the visible demo runs
js/runtime.js                  MuJoCo WASM loader (manifest -> virtual FS -> MjModel), small linear algebra, seeded RNG
js/viewer.js                   three.js scene built from MjModel geoms/meshes, synced from geom_xpos/xmat
js/perturb.js                  click/touch-drag spring perturbation via xfrc_applied
js/loop.js                     rAF loop that tracks wall-clock time (slow devices degrade to slow motion)
js/g1/                         balance controller + tab 1
js/franka/                     env port, ONNX policy runner, policy cameras, policy slot, tab 2
assets/g1, assets/franka       MJCF + meshes (+ manifest.json for the virtual FS)
models/                        placeholder policy (+ slot docs)
tools/                         asset/policy build scripts (Python)
tests/                         Playwright e2e, Node push benchmark
vendor/                        @mujoco/mujoco 3.17.0, three 0.180.0, onnxruntime-web 1.23.2 (see vendor/README.md)
```

Rebuild the assets (optional, since the outputs are committed):

```bash
pip install mujoco onnx onnxruntime fast-simplification
git clone --depth 1 https://github.com/google-deepmind/mujoco_menagerie /tmp/menagerie
python tools/build_g1_assets.py --menagerie /tmp/menagerie
python tools/build_franka_scene.py --dpick ../diffusion-pick
python tools/make_placeholder_policy.py
python tools/make_manifests.py
```

## Credits

* [MuJoCo](https://github.com/google-deepmind/mujoco) and its WASM bindings (Apache-2.0)
* Unitree G1 and Franka Emika Panda models from [MuJoCo Menagerie](https://github.com/google-deepmind/mujoco_menagerie).
  Their licenses are copied next to the assets: `assets/g1/LICENSE.menagerie`, `assets/franka/LICENSE.menagerie-panda`.
* [three.js](https://threejs.org) (MIT) and [onnxruntime-web](https://onnxruntime.ai) (MIT)
* Task, scene and policy export from [diffusion-pick](https://github.com/ansh1113/diffusion-pick)
