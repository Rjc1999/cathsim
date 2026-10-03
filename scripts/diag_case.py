"""Diagnostic figure for a processed cohort case: chamber masks, ascending aorta, extracted lumen and detected ostia
projected on the coronal (x-z) and axial (x-y) planes. Reads the cached lumen of build/cohort/<id>/.

    "D:/CT to map/.venv/Scripts/python.exe" scripts/diag_case.py 2036 [more case numbers] --out <dir>
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cohort_lib import discovery  # noqa: E402
from cohort_lib.io_lps import load_case, make_roi_grid, resample_case  # noqa: E402
from cohort_lib.vessels import ascending_aorta  # noqa: E402

COL = {"heart_ventricle_left": "tab:red", "heart_ventricle_right": "tab:orange", "heart_atrium_left": "tab:blue", "heart_atrium_right": "tab:cyan", "heart_myocardium": "tab:brown", "pulmonary_artery": "tab:purple"}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("cases", nargs="+", type=int)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    for n in a.cases:
        cid = f"ct_test_{n}_image"
        wd = Path("build/cohort") / cid
        case = load_case(Path(discovery.CASES_ROOT) / cid, ct_path=Path(discovery.CASES_ROOT) / cid / f"{cid}.nii.gz", seg_dir=Path(discovery.RESULTS_ROOT) / cid / "segmentation")
        grid, ref = make_roi_grid(case)
        ct, masks = resample_case(case, ref)
        z = np.load(wd / "coronaries.npz")
        meta = json.loads((wd / "coronaries.json").read_text())
        asc = ascending_aorta(masks, grid)
        fig, axs = plt.subplots(1, 2, figsize=(14, 7))
        ext_x = [grid.origin[0], grid.origin[0] + grid.spacing * grid.shape[2]]
        ext_y = [grid.origin[1], grid.origin[1] + grid.spacing * grid.shape[1]]
        ext_z = [grid.origin[2], grid.origin[2] + grid.spacing * grid.shape[0]]
        # coronal (project along y): rows = z (cranial up), cols = x
        for ax, axis, ext, xl, yl in ((axs[0], 1, ext_x + ext_z, "x (+Left)", "z (+Cranial)"), (axs[1], 0, ext_x + ext_y, "x (+Left)", "y (+Posterior)")):
            bg = np.clip(ct, -100, 500).max(axis=axis) if axis == 1 else np.clip(ct, -100, 500).max(axis=0)
            ax.imshow(bg, cmap="gray", origin="lower", extent=ext, aspect="equal", alpha=0.6)
            for k, c in COL.items():
                ax.contour(masks[k].any(axis=axis).astype(float), levels=[0.5], colors=[c], linewidths=0.8, origin="lower", extent=ext)
            ax.contour(asc.any(axis=axis).astype(float), levels=[0.5], colors=["gold"], linewidths=1.6, origin="lower", extent=ext)
            for k, c in (("LCA", "lime"), ("RCA", "magenta")):
                m = z[k].any(axis=axis)
                ys, xs = np.nonzero(m)
                h0 = ext[2] + ys * grid.spacing
                ax.scatter(ext[0] + xs * grid.spacing, h0, s=1, c=c)
            for k, c in (("LCA", "lime"), ("RCA", "magenta")):
                p = meta["ostia_lps"][k]
                ax.plot(p[0], p[2] if axis == 1 else p[1], "*", ms=16, mfc=c, mec="k")
            ax.set_xlabel(xl)
            ax.set_ylabel(yl)
            if axis == 0:
                ax.invert_yaxis()
        fig.suptitle(f"{cid}  gold = ascending aorta component; lime/magenta = LCA/RCA lumen; stars = ostia")
        fig.tight_layout()
        fig.savefig(out / f"diag_{n}.png", dpi=80)
        plt.close(fig)
        print("wrote", out / f"diag_{n}.png")


if __name__ == "__main__":
    main()
