"""Validate every case in public/models/cases_manifest.json: GLB header/structure, index.json contents, manifest consistency.

    "D:/CT to map/.venv/Scripts/python.exe" scripts/validate_library.py
"""
import json, struct, sys
from pathlib import Path
import numpy as np

sys.stdout.reconfigure(encoding="utf-8")
root = Path("public/models")
man = json.loads((root / "cases_manifest.json").read_text(encoding="utf-8"))
bad = 0
print(f"{'case':10s} {'name':10s} {'GLB KB':>6s} {'kinds':28s} {'branches':>8s} {'iso-centered?':14s} {'isoCT':24s}")
for c in man["cases"]:
    glb = (root / f"{c['id']}.glb").read_bytes()
    idx = json.loads((root / f"{c['id']}.index.json").read_text(encoding="utf-8"))
    errs = []
    magic, ver, length = struct.unpack("<4sII", glb[:12])
    if magic != b"glTF" or ver != 2 or length != len(glb):
        errs.append("bad GLB header")
    jl, jt = struct.unpack("<I4s", glb[12:20])
    gj = json.loads(glb[20:20 + jl])
    kinds = {}
    for n in gj["nodes"]:
        k = (n.get("extras") or {}).get("kind")
        if k:
            kinds[k] = kinds.get(k, 0) + 1
    if kinds.get("shadow") != 1 or kinds.get("coronary", 0) < 3 or kinds.get("silhouette", 0) != 6:
        errs.append(f"unexpected node kinds {kinds}")
    # centred: the accessor min/max of the shadow envelope should straddle the origin, and the centerline centroid is near it
    ids = [b["id"] for b in idx["branches"]]
    for need in ("LAD", "LCx", "RCA", "LM"):
        if need not in ids:
            errs.append(f"missing {need}")
    if sorted(ids) != sorted(c["branches"]):
        errs.append("manifest branches differ from index")
    cl = np.vstack([np.array(b["centerline"])[:, :3] for b in idx["branches"]])
    cen = cl.mean(0)
    if np.linalg.norm(cen) > 70:
        errs.append(f"centerlines far from the isocenter ({np.round(cen,0)})")
    env = c["landmarkBoundsMm"]["envelope"]
    if not (np.all(np.array(env["min"]) < 0) and np.all(np.array(env["max"]) > 0)):
        errs.append("envelope does not straddle the isocenter")
    if not all(np.isfinite(cl).ravel()):
        errs.append("non-finite centerline")
    bad += bool(errs)
    print(f"{c['id']:10s} {c['displayName']:10s} {len(glb)//1024:6d} {str(kinds):28s} {len(ids):8d} {'yes' if not errs else 'NO':14s} {np.round(c['isocenterCtLpsMm'],0).tolist()}" + (f"  ERRORS: {errs}" if errs else ""))
print("valid" if not bad else f"{bad} case(s) invalid")
sys.exit(1 if bad else 0)
