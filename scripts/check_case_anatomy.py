"""Anatomical sanity checks of a processed case against its own CT masks (read-only).

    "D:/CT to map/.venv/Scripts/python.exe" scripts/check_case_anatomy.py ct_test_2002_image public/models/case_2002.index.json

Computes the grooves from the chamber masks (anterior interventricular = RV/LV interface, left AV = LA/LV interface,
right AV = RA/RV interface) and measures how close each named branch's centerline runs to its groove. Also reports where
the LV apex is (the invariant "apex points to patient left" is a property of the frame, verified here from the masks).
"""
import json
import sys
from pathlib import Path

import numpy as np
import scipy.ndimage as ndi

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cohort_lib.io_lps import load_case, make_roi_grid, resample_case  # noqa: E402

case_dir, index_path = sys.argv[1], sys.argv[2]
idx = json.loads(Path(index_path).read_text())
iso = np.array(idx["meta"]["isocenter_ct_lps_mm"])
case = load_case(case_dir)
grid, ref = make_roi_grid(case)
ct, m = resample_case(case, ref)
sp = grid.spacing


def interface(a, b, mm=3.0):
    da = ndi.distance_transform_edt(~a, sampling=sp) <= mm
    db = ndi.distance_transform_edt(~b, sampling=sp) <= mm
    return da & db


lv = m["heart_ventricle_left"] | m["heart_myocardium"]
rv, la, ra = m["heart_ventricle_right"], m["heart_atrium_left"], m["heart_atrium_right"]
heart = lv | rv | la | ra
cen = grid.zyx_to_lps(np.argwhere(heart).mean(0))
grooves = {
    "anterior IV groove (RV/LV interface, anterior half)": interface(rv, lv) & (grid.axis(1)[None, :, None] < cen[1]),
    "left AV groove (LA/LV interface)": interface(la, lv),
    "right AV groove (RA/RV interface)": interface(ra, rv),
}
pts_g = {k: grid.zyx_to_lps(np.argwhere(v)) for k, v in grooves.items()}
from scipy.spatial import cKDTree  # noqa: E402

trees = {k: cKDTree(v) for k, v in pts_g.items() if len(v)}
print("groove voxel counts:", {k.split(' (')[0]: int(v.sum()) for k, v in grooves.items()})

# LV apex: the LV (pool + myocardium) voxel farthest from the LV base centroid (LV/LA + LV/aorta interface)
base = interface(lv, la | m["aorta"], 3.0)
base_c = grid.zyx_to_lps(np.argwhere(base).mean(0))
lv_pts = grid.zyx_to_lps(np.argwhere(lv)[::20])
apex = lv_pts[np.argmax(np.linalg.norm(lv_pts - base_c, axis=1))]
print(f"LV base centre (iso frame) {np.round(base_c - iso, 1).tolist()}  LV apex (iso frame) {np.round(apex - iso, 1).tolist()}")
print(f"  apex relative to cardiac centroid: dx = {apex[0] - cen[0]:+.1f} mm (+ = patient left), dy = {apex[1] - cen[1]:+.1f} (- = anterior), dz = {apex[2] - cen[2]:+.1f} (- = inferior)")

want = {"LAD": "anterior IV groove (RV/LV interface, anterior half)", "LCx": "left AV groove (LA/LV interface)", "RCA": "right AV groove (RA/RV interface)", "AM": "right AV groove (RA/RV interface)"}
for b in idx["branches"]:
    c = np.array(b["centerline"])[:, :3] + iso
    line = f"{b['system']}/{b['id']:4s} {b['lengthMm']:6.1f} mm  start {np.round(c[0]-iso,0).tolist()} end {np.round(c[-1]-iso,0).tolist()}"
    if b["id"] in want and want[b["id"]] in trees:
        d, _ = trees[want[b["id"]]].query(c)
        line += f"  | distance to {want[b['id']].split(' (')[0]}: median {np.median(d):.1f} mm, 75th pct {np.percentile(d, 75):.1f}, within 6 mm {100 * (d <= 6).mean():.0f}%"
    if b["id"] == "LAD":
        line += f"\n      LAD tip to LV apex: {np.linalg.norm(c[-1] - apex):.1f} mm;  tip dx {c[-1][0]-cen[0]:+.0f}, dy {c[-1][1]-cen[1]:+.0f}, dz {c[-1][2]-cen[2]:+.0f} (vs cardiac centroid)"
    print(line)
