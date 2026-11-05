"""Glue between diffusion-pick's demo data and the browser re-renderer (tools/lab/run.cjs).

1. states: diffusion-pick's per-frame simulator states (scripts/export_states.py) -> JSON for the browser
       python tools/replay_to_zarr.py states --npz ../diffusion-pick/data/demos_64_states.npz --out /tmp/states.json
2. render (browser):
       node tools/lab/run.cjs render --states /tmp/states.json --out /tmp/frames.u8
3. zarr: the browser frames + the original zarr's proprio/actions/episode_ends/attrs -> a new zarr
       python tools/replay_to_zarr.py zarr --src ../diffusion-pick/data/demos_64.zarr --frames /tmp/frames.u8 \
           --out ../diffusion-pick/data/demos_64_threejs.zarr
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np

H = 64


def cmd_states(a):
    z = np.load(a.npz)
    qpos, bowl, ends = z["qpos"], z["bowl"], z["episode_ends"]
    starts = np.concatenate([[0], ends[:-1]])
    eps = [dict(bowl=bowl[e, :2].tolist(), qpos=qpos[s:t].reshape(-1).tolist()) for e, (s, t) in enumerate(zip(starts, ends))]
    Path(a.out).write_text(json.dumps(dict(nq=int(qpos.shape[1]), episodes=eps)))
    print(f"{len(eps)} episodes, {len(qpos)} frames -> {a.out}")


def cmd_zarr(a):
    sys.path.insert(0, str(Path(a.src).resolve().parent.parent))
    from dpick.dataset import load_zarr, write_zarr

    data, ends, attrs = load_zarr(a.src)
    n = len(data["action"])
    raw = np.fromfile(a.frames, dtype=np.uint8)
    assert raw.size == n * 2 * 3 * H * H, f"{raw.size} bytes != {n} frames x 2 cams x 3x{H}x{H}"
    frames = raw.reshape(n, 2, 3, H, H).transpose(0, 1, 3, 4, 2)  # -> N, cam, H, W, C (zarr is NHWC)
    starts = np.concatenate([[0], ends[:-1]])
    eps = []
    for s, t in zip(starts, ends):
        eps.append(dict(front_rgb=np.ascontiguousarray(frames[s:t, 0]), wrist_rgb=np.ascontiguousarray(frames[s:t, 1]),
                        proprio=data["proprio"][s:t], action=data["action"][s:t]))
    attrs = dict(attrs, renderer="three.js (mujoco-web-demo, headless Chromium/SwiftShader)",
                 source_zarr=str(Path(a.src).name))
    write_zarr(a.out, eps, attrs=attrs)
    d2, e2, _ = load_zarr(a.out)
    assert np.array_equal(e2, ends) and np.array_equal(d2["action"], data["action"]) and np.array_equal(d2["proprio"], data["proprio"])
    print(f"wrote {a.out}: {n} frames, {len(ends)} episodes (actions/proprio identical to {a.src})")
    for k in ("front_rgb", "wrist_rgb"):
        print(f"  {k}: mean RGB  original {data[k].reshape(-1, 3).mean(0).round(1)}  three.js {d2[k].reshape(-1, 3).mean(0).round(1)}")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("states")
    s.add_argument("--npz", required=True)
    s.add_argument("--out", required=True)
    z = sub.add_parser("zarr")
    z.add_argument("--src", required=True)
    z.add_argument("--frames", required=True)
    z.add_argument("--out", required=True)
    a = ap.parse_args()
    {"states": cmd_states, "zarr": cmd_zarr}[a.cmd](a)


if __name__ == "__main__":
    main()
