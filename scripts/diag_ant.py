"""Anterior-slab coronal MIP of the CT with the extracted lumens, to see whether the LAD is present in the CT and the extraction."""
import json, sys
from pathlib import Path
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
sys.path.insert(0, str(Path(__file__).resolve().parent))
from cohort_lib import discovery
from cohort_lib.io_lps import load_case, make_roi_grid, resample_case

n = int(sys.argv[1]); out = Path(sys.argv[2])
cid = f"ct_test_{n}_image"
wd = Path("build/cohort") / cid
case = load_case(Path(discovery.CASES_ROOT) / cid, ct_path=Path(discovery.CASES_ROOT) / cid / f"{cid}.nii.gz", seg_dir=Path(discovery.RESULTS_ROOT) / cid / "segmentation")
grid, ref = make_roi_grid(case)
ct, masks = resample_case(case, ref)
z = np.load(wd / "coronaries.npz")
heart = masks["heart_ventricle_left"] | masks["heart_ventricle_right"] | masks["heart_atrium_left"] | masks["heart_atrium_right"]
yy = grid.zyx_to_lps(np.argwhere(heart))[:, 1]
y0, y1 = float(yy.min()), float(np.median(yy))
j0, j1 = int((y0 - grid.origin[1]) / grid.spacing), int((y1 - grid.origin[1]) / grid.spacing)
ext = [grid.origin[0], grid.origin[0] + grid.spacing * grid.shape[2], grid.origin[2], grid.origin[2] + grid.spacing * grid.shape[0]]
fig, axs = plt.subplots(1, 2, figsize=(15, 7))
mip = np.clip(ct[:, j0:j1, :], 0, 500).max(axis=1)
for ax, show in zip(axs, (False, True)):
    ax.imshow(mip, cmap="gray", origin="lower", extent=ext, aspect="equal")
    ax.set_title(f"{cid} anterior slab y {y0:.0f}..{y1:.0f}" + (" + lumens" if show else ""))
    if show:
        for k, c in (("LCA", "lime"), ("RCA", "magenta")):
            m = z[k][:, j0:j1, :].any(axis=1)
            ys, xs = np.nonzero(m)
            ax.scatter(ext[0] + xs * grid.spacing, ext[2] + ys * grid.spacing, s=1.5, c=c)
        for kk, c in (("heart_ventricle_left", "red"), ("heart_ventricle_right", "orange")):
            ax.contour(masks[kk][:, j0:j1, :].any(axis=1).astype(float), levels=[0.5], colors=[c], linewidths=0.8, origin="lower", extent=ext)
fig.tight_layout()
fig.savefig(out / f"ant_{n}.png", dpi=75)
