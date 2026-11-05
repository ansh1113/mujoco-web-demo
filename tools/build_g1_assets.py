"""Copy the Unitree G1 from MuJoCo Menagerie into assets/g1 with decimated meshes for the web.

Menagerie's G1 ships ~20 MB of STL (393k triangles). The model's masses/inertias are given explicitly
(<inertial>), and collisions use the convex hull of each mesh, so decimating the meshes changes the
visuals but not the dynamics in any meaningful way. Target: ~10% of the triangles (~2 MB).

    git clone --depth 1 https://github.com/google-deepmind/mujoco_menagerie /tmp/menagerie
    python tools/build_g1_assets.py --menagerie /tmp/menagerie
"""
import argparse
import re
import shutil
from pathlib import Path

import numpy as np

OUT = Path(__file__).resolve().parent.parent / "assets" / "g1"


def read_stl(path):
    raw = path.read_bytes()
    if raw[:5] == b"solid" and b"facet" in raw[:300]:  # ASCII STL
        v = np.array(re.findall(rb"vertex\s+(\S+)\s+(\S+)\s+(\S+)", raw), dtype=np.float64)
        tri = v.reshape(-1, 3, 3)
    else:
        n = int(np.frombuffer(raw[80:84], np.uint32)[0])
        rec = np.frombuffer(raw[84:84 + n * 50], dtype=np.dtype([("n", "<f4", 3), ("v", "<f4", (3, 3)), ("a", "<u2")]))
        tri = rec["v"].astype(np.float64)
    verts, inv = np.unique(np.round(tri.reshape(-1, 3), 7), axis=0, return_inverse=True)
    faces = inv.reshape(-1, 3)
    faces = faces[(faces[:, 0] != faces[:, 1]) & (faces[:, 1] != faces[:, 2]) & (faces[:, 0] != faces[:, 2])]
    return verts, faces


def write_stl(path, verts, faces):
    tri = verts[faces].astype(np.float32)
    nrm = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    nrm /= np.maximum(np.linalg.norm(nrm, axis=1, keepdims=True), 1e-12)
    rec = np.zeros(len(faces), dtype=np.dtype([("n", "<f4", 3), ("v", "<f4", (3, 3)), ("a", "<u2")]))
    rec["n"], rec["v"] = nrm, tri
    with open(path, "wb") as f:
        f.write(b"decimated for mujoco-web-demo".ljust(80, b" "))
        f.write(np.uint32(len(faces)).tobytes())
        f.write(rec.tobytes())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--menagerie", required=True)
    ap.add_argument("--keep", type=float, default=0.10, help="fraction of triangles to keep")
    ap.add_argument("--min-faces", type=int, default=300)
    args = ap.parse_args()
    import fast_simplification

    src = Path(args.menagerie) / "unitree_g1"
    if OUT.exists():
        shutil.rmtree(OUT)
    (OUT / "assets").mkdir(parents=True)
    xml = (src / "g1.xml").read_text()
    files = sorted(set(re.findall(r'file="([^"]+)"', xml)))
    before = after = 0
    for fn in files:
        v, f = read_stl(src / "assets" / fn)
        before += len(f)
        target = max(args.min_faces, int(len(f) * args.keep))
        if len(f) > target:
            v, f = fast_simplification.simplify(v.astype(np.float32), f.astype(np.int32), 1 - target / len(f))
        after += len(f)
        write_stl(OUT / "assets" / fn, np.asarray(v, np.float64), np.asarray(f))
    shutil.copy(src / "g1.xml", OUT / "g1.xml")
    for extra in ("LICENSE", "README.md"):
        shutil.copy(src / extra, OUT / f"{extra}.menagerie")
    print(f"{len(files)} meshes: {before} -> {after} triangles")

    import mujoco
    m = mujoco.MjModel.from_xml_path(str(OUT / "g1.xml"))
    ref = mujoco.MjModel.from_xml_path(str(src / "g1.xml"))
    assert np.allclose(m.body_mass, ref.body_mass) and np.allclose(m.body_inertia, ref.body_inertia)
    print("decimated model compiles; body masses/inertias identical to Menagerie")


if __name__ == "__main__":
    main()
