"""Per-path groove corridors of the cached LCA/RCA trees of a cohort case (debug aid for the automatic labelling)."""
import json, sys
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.stdout.reconfigure(encoding="utf-8")
from cohort_lib import autolabel, discovery
from cohort_lib.io_lps import load_case, make_roi_grid, resample_case
from cohort_lib.skeleton import build_tree, prune_twigs
from cohort_lib.vessels import Ostia

n = int(sys.argv[1])
cid = f"ct_test_{n}_image"
wd = Path("build/cohort") / cid
case = load_case(Path(discovery.CASES_ROOT) / cid, ct_path=Path(discovery.CASES_ROOT) / cid / f"{cid}.nii.gz", seg_dir=Path(discovery.RESULTS_ROOT) / cid / "segmentation")
grid, ref = make_roi_grid(case)
ct, masks = resample_case(case, ref)
z = np.load(wd / "coronaries.npz")
meta = json.loads((wd / "coronaries.json").read_text())
g = autolabel.compute_grooves(masks, grid)
print("groove voxel counts", g.counts, "apex", np.round(g.apex, 1), "centroid", np.round(g.centroid, 1))
for system in ("LCA", "RCA"):
    tree = build_tree(z[system], np.array(meta["ostia_lps"][system]), grid)
    kept = prune_twigs(tree, 12.0)
    paths = autolabel._paths(tree, kept)
    print(system, "segments", len(tree.segments), "kept", len(kept), "paths", len(paths))
    want = {"LCA": ["anterior_iv", "left_av"], "RCA": ["right_av"]}[system]
    rows = []
    for p in paths:
        row = [autolabel._path_len(tree, p)] + [autolabel._corridor_mm(tree, p, g.trees[k], autolabel.RCA_CORRIDOR_MM if k == "right_av" else autolabel.CORRIDOR_MM) for k in want]
        rows.append(row)
    rows.sort(key=lambda r: -r[1])
    for r in rows[:8]:
        print("   len %.0f  " % r[0] + "  ".join(f"{k} {v:.0f}" for k, v in zip(want, r[1:])))
print("-- cross check: every tree against every groove")
for system in ("LCA", "RCA"):
    tree = build_tree(z[system], np.array(meta["ostia_lps"][system]), grid)
    kept = prune_twigs(tree, 12.0)
    for k in g.trees:
        best = max(autolabel._corridor_mm(tree, p, g.trees[k]) for p in autolabel._paths(tree, kept))
        print(f"   {system} vs {k}: best path corridor {best:.0f} mm")
