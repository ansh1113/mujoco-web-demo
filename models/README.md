# Policy slot

The pick-and-place tab loads the model named in [`js/franka/policy-slot.js`](../js/franka/policy-slot.js)
(default: `placeholder_pick.onnx`). A `<name>.json` next to `<name>.onnx` is read for metadata
(`obs_horizon`, `pred_horizon`, `action_horizon`, `img_size`); without it the values are inferred
from the graph's input shapes.

| File | What it is |
|---|---|
| `placeholder_pick.onnx` | Scripted, stateless pick-and-place controller compiled to plain ONNX ops by `tools/make_placeholder_policy.py`. Uses **privileged** object state (`object_state`), so it is a stand-in for the wiring, not a learned policy. 5.8 KB. |
| `placeholder_pick.json` | Its metadata. |

## Dropping in diffusion-pick's Diffusion Policy

```bash
cp ../diffusion-pick/exports/dp_reduced.onnx ../diffusion-pick/exports/dp_reduced.json models/
```

then either set `url: 'models/dp_reduced.onnx'` in `js/franka/policy-slot.js`, or open
`index.html?policy=models/dp_reduced.onnx#pick`. (`models/dp_*.onnx` is git-ignored because the file
is 27 MB; remove that line from `.gitignore` if you want to host it.)

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
