"""Write assets/<scene>/manifest.json (the files the browser writes into MuJoCo's virtual FS).
A static site can't list directories, so the loader needs this list."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "assets"
for scene in sorted(p for p in ROOT.iterdir() if p.is_dir()):
    files = sorted(str(f.relative_to(scene)) for f in scene.rglob("*")
                   if f.suffix.lower() in (".xml", ".stl", ".obj", ".png"))
    (scene / "manifest.json").write_text(json.dumps({"files": files}, indent=0))
    print(scene.name, len(files), "files")
