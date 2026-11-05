"""Build the *placeholder* pick-and-place policy as an ONNX graph.

It is a stateless, scripted (not learned) reactive controller written directly in ONNX ops so that it
plugs into exactly the same runtime path as the learned policy:

    inputs   proprio      [B, To=2, 12]  float32   (same layout as diffusion-pick)
             noise        [B, Tp=16, 5]  float32   (accepted for interface parity, unused)
             object_state [B, 7]         float32   red cube xyz, red cube yaw (folded to [-pi/4, pi/4]),
                                                    bowl xyz  -- *privileged* state; the real policy
                                                    sees front_rgb / wrist_rgb instead
    output   actions      [B, Tp=16, 5]  float32   absolute TCP targets (x, y, z, yaw, grip) at 10 Hz

The web runtime feeds each input by *name*, so the diffusion-pick export (front_rgb, wrist_rgb,
proprio, noise) drops into the same slot without code changes.

    python tools/make_placeholder_policy.py            # writes models/placeholder_pick.onnx (+ .json)
"""
import json
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper as h, numpy_helper

OUT = Path(__file__).resolve().parent.parent / "models"
TP, A = 16, 5
DT = 0.1
VMAX = 0.25          # m/s TCP speed limit of the generated chunk
H_TRAVEL = 0.14      # cruise height
H_GRASP = 0.018      # TCP height at grasp (cube center is 0.02)
H_RELEASE = 0.085
XY_TOL = 0.018
CUBE_HALF = 0.02


def reference(proprio, obj):
    """NumPy reference of the graph (used to unit-test the ONNX file)."""
    p = proprio[:, -1, :3]
    yaw_now = np.arctan2(proprio[:, -1, 3], proprio[:, -1, 4])
    w = proprio[:, -1, 5]
    c, cyaw, b = obj[:, :3], obj[:, 3], obj[:, 4:7]
    dxy_c = np.linalg.norm(p[:, :2] - c[:, :2], axis=1)
    dxy_b = np.linalg.norm(p[:, :2] - b[:, :2], axis=1)
    near = (dxy_c < XY_TOL) & (np.abs(p[:, 2] - c[:, 2]) < 0.015)
    attached = np.linalg.norm(p - c, axis=1) < 0.035
    holding = attached & (w < 0.065) & (c[:, 2] > 0.012)
    closing = near & ~holding
    cube_in_bowl = (np.linalg.norm(c[:, :2] - b[:, :2], axis=1) < 0.05) & (c[:, 2] < 0.06)

    # --- approach (default branch)
    above_cube = dxy_c < XY_TOL
    low = p[:, 2] < H_TRAVEL - 0.03
    tgt_app = np.where(above_cube[:, None], np.stack([c[:, 0], c[:, 1], np.full_like(c[:, 0], H_GRASP)], 1),
                       np.where(low[:, None], np.stack([p[:, 0], p[:, 1], np.full_like(c[:, 0], H_TRAVEL)], 1),
                                np.stack([c[:, 0], c[:, 1], np.full_like(c[:, 0], H_TRAVEL)], 1)))
    # --- carry
    over_bowl = dxy_b < XY_TOL
    tgt_carry = np.where(over_bowl[:, None], np.stack([b[:, 0], b[:, 1], np.full_like(c[:, 0], H_RELEASE - 0.01)], 1),
                         np.where(low[:, None], np.stack([p[:, 0], p[:, 1], np.full_like(c[:, 0], H_TRAVEL)], 1),
                                  np.stack([b[:, 0], b[:, 1], np.full_like(c[:, 0], H_TRAVEL)], 1)))
    release = over_bowl & (p[:, 2] < H_RELEASE)
    # --- retreat
    tgt_ret = np.stack([p[:, 0], p[:, 1], np.full_like(c[:, 0], H_TRAVEL + 0.06)], 1)

    tgt = np.where(cube_in_bowl[:, None], tgt_ret,
                   np.where(holding[:, None], tgt_carry, np.where(closing[:, None], p, tgt_app)))
    grip = np.where(cube_in_bowl, 0.0, np.where(holding, np.where(release, 0.0, 1.0),
                                               np.where(closing, 1.0, 0.0)))
    yaw = np.where(holding | cube_in_bowl, yaw_now, cyaw)
    k = np.arange(1, TP + 1, dtype=np.float32)[None, :, None]
    d = tgt - p
    n = np.linalg.norm(d, axis=1, keepdims=True)[:, None]
    step = np.minimum(1.0, k * VMAX * DT / np.maximum(n, 1e-6))
    xyz = p[:, None] + d[:, None] * step
    out = np.concatenate([xyz, np.broadcast_to(yaw[:, None, None], xyz.shape[:2] + (1,)),
                          np.broadcast_to(grip[:, None, None], xyz.shape[:2] + (1,))], -1)
    return out.astype(np.float32)


class G:
    def __init__(self):
        self.nodes, self.inits, self.n = [], [], 0

    def c(self, v, dtype=np.float32):
        self.n += 1
        name = f"c{self.n}"
        self.inits.append(numpy_helper.from_array(np.asarray(v, dtype=dtype), name))
        return name

    def op(self, t, *ins, **attrs):
        self.n += 1
        out = f"t{self.n}"
        self.nodes.append(h.make_node(t, list(ins), [out], **attrs))
        return out

    # helpers
    def sl(self, x, start, end, axis):
        return self.op("Slice", x, self.c([start], np.int64), self.c([end], np.int64), self.c([axis], np.int64))

    def norm2(self, x):  # over last axis, keepdims
        return self.op("Sqrt", self.op("ReduceSum", self.op("Mul", x, x), self.c([-1], np.int64), keepdims=1))

    def where(self, cond, a, b):
        return self.op("Where", cond, a, b)

    def lt(self, a, b):
        return self.op("Less", a, b)

    def band(self, a, b):
        return self.op("And", a, b)


def build():
    g = G()
    proprio = h.make_tensor_value_info("proprio", TensorProto.FLOAT, ["batch", 2, 12])
    noise = h.make_tensor_value_info("noise", TensorProto.FLOAT, ["batch", TP, A])
    obj = h.make_tensor_value_info("object_state", TensorProto.FLOAT, ["batch", 7])
    actions = h.make_tensor_value_info("actions", TensorProto.FLOAT, ["batch", TP, A])

    last = g.op("Squeeze", g.sl("proprio", -1, 2, 1), g.c([1], np.int64))  # [B,12]
    p = g.sl(last, 0, 3, 1)
    pxy = g.sl(last, 0, 2, 1)
    pz = g.sl(last, 2, 3, 1)
    yaw_now = g.op("Atan", g.op("Div", g.sl(last, 3, 4, 1), g.sl(last, 4, 5, 1)))  # cos>0 always here
    w = g.sl(last, 5, 6, 1)
    c = g.sl("object_state", 0, 3, 1)
    cxy = g.sl("object_state", 0, 2, 1)
    cz = g.sl("object_state", 2, 3, 1)
    cyaw = g.sl("object_state", 3, 4, 1)
    bxy = g.sl("object_state", 4, 6, 1)
    # all predicates are [B,1] bool
    dxy_c = g.norm2(g.op("Sub", pxy, cxy))
    dxy_b = g.norm2(g.op("Sub", pxy, bxy))
    near = g.band(g.lt(dxy_c, g.c([XY_TOL])), g.lt(g.op("Abs", g.op("Sub", pz, cz)), g.c([0.015])))
    attached = g.lt(g.norm2(g.op("Sub", p, c)), g.c([0.035]))
    holding = g.band(g.band(attached, g.lt(w, g.c([0.065]))), g.op("Greater", cz, g.c([0.012])))
    closing = g.band(near, g.op("Not", holding))
    cube_in_bowl = g.band(g.lt(g.norm2(g.op("Sub", cxy, bxy)), g.c([0.05])), g.lt(cz, g.c([0.06])))
    above_cube = g.lt(dxy_c, g.c([XY_TOL]))
    low = g.lt(pz, g.c([H_TRAVEL - 0.03]))
    over_bowl = g.lt(dxy_b, g.c([XY_TOL]))
    release = g.band(over_bowl, g.lt(pz, g.c([H_RELEASE])))

    def xyz(xy, zval):
        z = g.op("Add", g.op("Mul", g.sl(xy, 0, 1, 1), g.c([0.0])), g.c([zval]))  # [B,1] filled with zval
        return g.op("Concat", xy, z, axis=1)

    tgt_app = g.where(above_cube, xyz(cxy, H_GRASP), g.where(low, xyz(pxy, H_TRAVEL), xyz(cxy, H_TRAVEL)))
    tgt_carry = g.where(over_bowl, xyz(bxy, H_RELEASE - 0.01), g.where(low, xyz(pxy, H_TRAVEL), xyz(bxy, H_TRAVEL)))
    tgt_ret = xyz(pxy, H_TRAVEL + 0.06)
    tgt = g.where(cube_in_bowl, tgt_ret, g.where(holding, tgt_carry, g.where(closing, p, tgt_app)))
    one, zero = g.c([1.0]), g.c([0.0])
    grip = g.where(cube_in_bowl, zero, g.where(holding, g.where(release, zero, one), g.where(closing, one, zero)))
    yaw = g.where(g.op("Or", holding, cube_in_bowl), yaw_now, cyaw)

    d = g.op("Sub", tgt, p)                                     # [B,3]
    n = g.op("Max", g.norm2(d), g.c([1e-6]))                    # [B,1]
    k = g.c(np.arange(1, TP + 1, dtype=np.float32).reshape(1, TP, 1) * VMAX * DT)  # [1,TP,1]
    step = g.op("Min", g.op("Div", k, g.op("Unsqueeze", n, g.c([1], np.int64))), g.c([1.0]))  # [B,TP,1]
    xyz_seq = g.op("Add", g.op("Unsqueeze", p, g.c([1], np.int64)),
                   g.op("Mul", g.op("Unsqueeze", d, g.c([1], np.int64)), step))  # [B,TP,3]
    ones = g.op("Add", g.op("Mul", step, g.c([0.0])), g.c([1.0]))  # [B,TP,1]
    yaw_seq = g.op("Mul", ones, g.op("Unsqueeze", yaw, g.c([1], np.int64)))
    grip_seq = g.op("Mul", ones, g.op("Unsqueeze", grip, g.c([1], np.int64)))
    # consume `noise` (multiplied by 0) so the input is kept by every runtime/optimizer
    nz = g.op("Mul", g.op("ReduceSum", "noise", g.c([1, 2], np.int64), keepdims=1), g.c([0.0]))  # [B,1,1]
    out = g.op("Add", g.op("Concat", xyz_seq, yaw_seq, grip_seq, axis=2), nz)
    g.nodes.append(h.make_node("Identity", [out], ["actions"]))

    graph = h.make_graph(g.nodes, "placeholder_pick_policy", [proprio, noise, obj], [actions], g.inits)
    model = h.make_model(graph, opset_imports=[h.make_opsetid("", 17)], producer_name="mujoco-web-demo")
    model.ir_version = 8
    model.doc_string = ("Scripted placeholder for the diffusion-pick policy (privileged object state, not learned). "
                        "Replace with diffusion-pick/exports/dp_reduced.onnx.")
    onnx.checker.check_model(model)
    return model


def main():
    OUT.mkdir(exist_ok=True, parents=True)
    model = build()
    path = OUT / "placeholder_pick.onnx"
    onnx.save(model, path)
    # self-test against the NumPy reference
    import onnxruntime as ort
    sess = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    rng = np.random.default_rng(0)
    for _ in range(200):
        B = 4
        pr = np.zeros((B, 2, 12), np.float32)
        pr[:, :, 0] = rng.uniform(0.3, 0.7, (B, 1)); pr[:, :, 1] = rng.uniform(-0.3, 0.3, (B, 1))
        pr[:, :, 2] = rng.uniform(0.0, 0.3, (B, 1))
        yw = rng.uniform(-1, 1, (B, 1)); pr[:, :, 3] = np.sin(yw); pr[:, :, 4] = np.cos(yw)
        pr[:, :, 5] = rng.uniform(0, 0.08, (B, 1))
        ob = np.zeros((B, 7), np.float32)
        ob[:, 0] = rng.uniform(0.38, 0.64, B); ob[:, 1] = rng.uniform(-0.22, 0.22, B)
        ob[:, 2] = rng.uniform(0.0, 0.2, B); ob[:, 3] = rng.uniform(-0.78, 0.78, B)
        ob[:, 4] = rng.uniform(0.38, 0.64, B); ob[:, 5] = rng.uniform(-0.22, 0.22, B)
        # make some states hit the near/holding/bowl branches
        sel = rng.random(B) < 0.5
        pr[sel, :, :3] = ob[sel, None, :3] + rng.normal(0, 0.005, (sel.sum(), 1, 3))
        nz = rng.standard_normal((B, TP, A)).astype(np.float32)
        out = sess.run(None, dict(proprio=pr, noise=nz, object_state=ob))[0]
        ref = reference(pr, ob)
        assert np.abs(out - ref).max() < 1e-4, np.abs(out - ref).max()
    meta = dict(name="placeholder (scripted, privileged state)", policy="scripted", obs_horizon=2, pred_horizon=TP,
                action_horizon=8, action_dim=A, img_size=64,
                inputs=dict(proprio=[1, 2, 12], noise=[1, TP, A], object_state=[1, 7]),
                output="actions [batch, pred_horizon, 5] = (x, y, z, yaw, grip)",
                note="Stateless scripted controller compiled to ONNX ops. Uses privileged object state.")
    path.with_suffix(".json").write_text(json.dumps(meta, indent=1))
    print(f"wrote {path} ({path.stat().st_size} bytes), ONNX == NumPy reference on 800 random states")


if __name__ == "__main__":
    main()
