# Policy slot

The pick-and-place tab loads the model named in [`js/franka/policy-slot.js`](../js/franka/policy-slot.js)
(default: `dp_browser.onnx`). A `<name>.json` next to `<name>.onnx` is read for metadata
(`obs_horizon`, `pred_horizon`, `action_horizon`, `img_size`); without it the values are inferred
from the graph's input shapes.

| File | What it is |
|---|---|
| `dp_browser.onnx` (+ `.json`) | **Default.** diffusion-pick's Diffusion Policy fine-tuned on a 50/50 mix of MuJoCo- and browser-rendered demos (see the main README, "Closing the render gap"). 43/50 in the browser. 27 MB. |
| `dp_reduced.onnx` (+ `.json`) | diffusion-pick's `exports/dp_reduced.onnx`, unchanged. 40/50 in the browser. 27 MB. |
| `placeholder_pick.onnx` | Scripted, stateless pick-and-place controller compiled to plain ONNX ops by `tools/make_placeholder_policy.py`. Uses **privileged** object state (`object_state`), so it is a stand-in for the wiring, not a learned policy. 5.8 KB. |
| `placeholder_pick.json` | Its metadata. |

## Using another diffusion-pick export

Copy `<name>.onnx` and `<name>.json` here and add an entry to `POLICY_CHOICES` in `js/franka/policy-slot.js`, or
open `index.html?policy=models/<name>.onnx#pick`. Other `models/dp_*.onnx` files are git-ignored (27 MB each);
add an `!models/<name>.onnx` line to `.gitignore` to host one.

Input contract (matched **by name**; a model may use any subset):

| Input | Type / shape | Source in the browser |
|---|---|---|
| `front_rgb` | uint8 `[1, To, 3, H, W]` | 64×64 render of the MJCF `front` camera |
| `wrist_rgb` | uint8 `[1, To, 3, H, W]` | 64×64 render of the MJCF `wrist` camera |
| `proprio` | float32 `[1, To, 12]` | TCP xyz, sin/cos yaw, finger width, q1..q6 |
| `noise` | float32 `[1, Tp, 5]` | N(0, I) DDIM initial noise |
| `object_state` | float32 `[1, 7]` | red-cube xyz, folded yaw, bowl xyz (privileged) |

Output `actions` float32 `[1, Tp, 5]` — absolute TCP targets `(x, y, z, yaw, grip)` at 10 Hz. The demo
executes actions `To-1 … To-1+Ta-1` (receding horizon, Ta = 8), exactly like `scripts/eval_onnx.py`.
