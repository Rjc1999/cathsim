"""Foreshortening of each named branch over standard gantry views, from the case index (same maths as src/lib/viewMetrics.ts).

    "D:/CT to map/.venv/Scripts/python.exe" scripts/check_views.py public/models/case_2002.index.json
"""
import json
import sys

import numpy as np

idx = json.load(open(sys.argv[1]))
D = np.pi / 180


def basis(a, b):
    a, b = a * D, b * D
    d = np.array([np.sin(a) * np.cos(b), -np.cos(a) * np.cos(b), np.sin(b)])
    up = np.array([-np.sin(a) * np.sin(b), np.cos(a) * np.sin(b), np.cos(b)])
    return d, up, np.cross(d, up)


def ratio(c, a, b):
    d, up, side = basis(a, b)
    p2 = np.stack([c @ up, c @ side], 1)
    return min(1.0, np.linalg.norm(np.diff(p2, axis=0), axis=1).sum() / np.linalg.norm(np.diff(c, axis=0), axis=1).sum())


views = [("AP 0/0", 0, 0), ("LAO30 CRA30", 30, 30), ("LAO40 CRA30", 40, 30), ("RAO30 CRA20", -30, 20), ("RAO30 CAU25", -30, -25), ("LAO45 CAU30 (spider)", 45, -30), ("LAO40 0", 40, 0), ("RAO30 0", -30, 0)]
ids = [(b["system"], b["id"]) for b in idx["branches"]]
print(f"{'view':22s}" + "".join(f"{s}/{i:4s} " for s, i in ids))
for name, a, b in views:
    row = []
    for br in idx["branches"]:
        c = np.array(br["centerline"])[:, :3]
        row.append(f"{ratio(c, a, b) * 100:7.0f}%")
    print(f"{name:22s}" + " ".join(row))
