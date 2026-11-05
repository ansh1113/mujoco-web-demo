"""Export the diffusion-pick tabletop scene (Panda + 3 cubes + bowl) to a standalone MJCF for the browser.

The scene is *not* re-authored by hand: it is produced by diffusion-pick's own `dpick.env.build_model`
(with the decimated "lite" visual meshes the policy was trained with), so the physics, cameras and
lights match the training environment exactly.

    MUJOCO_GL=glfw python tools/build_franka_scene.py --dpick ../diffusion-pick
"""
import argparse
import inspect
import os
import re
import shutil
import sys
from pathlib import Path

os.environ.setdefault("MUJOCO_GL", "glfw")  # only needed so `import mujoco` doesn't probe EGL

OUT = Path(__file__).resolve().parent.parent / "assets" / "franka"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dpick", default="../diffusion-pick", help="path to the diffusion-pick checkout")
    args = ap.parse_args()
    sys.path.insert(0, str(Path(args.dpick).resolve()))
    os.environ["PANDA_VISUAL"] = "lite"
    import mujoco
    import dpick.env as E

    # Re-run build_model but stop before compile() so we can serialize the spec.
    src = inspect.getsource(E.build_model).replace("return spec.compile()", "return spec")
    ns = dict(vars(E))
    exec(src, ns)
    spec = ns["build_model"](0)
    model = spec.compile()  # validates + makes to_xml() resolve defaults
    xml = spec.to_xml()

    if OUT.exists():
        shutil.rmtree(OUT)
    (OUT / "meshes").mkdir(parents=True)
    used = set()

    def relink(mt):
        p = Path(mt.group(1))
        if not p.is_absolute():
            p = E.ASSET_DIR / "assets" / p
        name = ("lite_" if "assets_lite" in str(p) else "") + p.name
        used.add((p, name))
        return f'file="{name}"'

    xml = re.sub(r'file="([^"]+\.(?:obj|stl|STL))"', relink, xml)
    xml = re.sub(r'meshdir="[^"]*"', 'meshdir="meshes"', xml)
    if 'meshdir=' not in xml:
        xml = xml.replace("<compiler", '<compiler meshdir="meshes"', 1)
    for p, name in used:
        shutil.copy(p, OUT / "meshes" / name)
    (OUT / "pick_scene.xml").write_text(xml)
    shutil.copy(E.ASSET_DIR / "LICENSE", OUT / "LICENSE.menagerie-panda")

    # sanity: the exported file must compile to the same model
    m2 = mujoco.MjModel.from_xml_path(str(OUT / "pick_scene.xml"))
    assert (m2.nq, m2.nv, m2.nu, m2.ngeom, m2.nmesh) == (model.nq, model.nv, model.nu, model.ngeom, model.nmesh)
    assert abs(m2.opt.timestep - model.opt.timestep) < 1e-12
    print(f"wrote {OUT/'pick_scene.xml'}  nq={m2.nq} nu={m2.nu} ngeom={m2.ngeom} meshes={len(used)}")


if __name__ == "__main__":
    main()
