"""Inspect a cohort CT case: headers, orientation, voxel grid, mask labels, intensity statistics.

    "D:/CT to map/.venv/Scripts/python.exe" scripts/inspect_cohort_case.py ct_test_2002_image

Read-only. Prints everything the processing pipeline relies on (affine, axis codes, spacing, grid sizes, mask
volumes and bounding boxes in millimetres, HU statistics inside each mask).
"""
from __future__ import annotations

import sys
from pathlib import Path

import nibabel as nib
import numpy as np


def describe(path: Path) -> nib.Nifti1Image:
    img = nib.load(str(path))
    aff = img.affine
    print(f"\n{path.name}")
    print(f"  shape {img.shape}  dtype {img.get_data_dtype()}  zooms {tuple(round(float(z), 4) for z in img.header.get_zooms()[:3])}")
    print(f"  axis codes (nibabel, voxel i/j/k -> world): {''.join(nib.aff2axcodes(aff))}   det(R) = {np.linalg.det(aff[:3, :3]):+.3e}")
    print(f"  sform code {int(img.header['sform_code'])}, qform code {int(img.header['qform_code'])}")
    print("  affine:\n" + "\n".join("    " + "  ".join(f"{v:10.4f}" for v in row) for row in aff))
    return img


def main(case_dir: str) -> None:
    root = Path(case_dir)
    ct_path = next(root.glob("*.nii.gz"))
    ct_img = describe(ct_path)
    ct = np.asarray(ct_img.dataobj, dtype=np.float32)
    print(f"  HU: min {ct.min():.0f}  p1 {np.percentile(ct, 1):.0f}  median {np.median(ct):.0f}  p99 {np.percentile(ct, 99):.0f}  max {ct.max():.0f}")
    hdr = ct_img.header
    print(f"  descrip: {hdr['descrip'].tobytes().decode(errors='ignore').strip(chr(0))!r}  db_name: {hdr['db_name'].tobytes().decode(errors='ignore').strip(chr(0))!r}")

    seg_dir = root / "segmentation"
    clamped = seg_dir / "_ts_input_clamped.nii.gz"
    if clamped.exists():
        c_img = describe(clamped)
        same = np.allclose(c_img.affine, ct_img.affine) and c_img.shape == ct_img.shape
        print(f"  -> same grid/affine as the CT: {same}")

    zooms = np.array(ct_img.header.get_zooms()[:3])
    for p in sorted(seg_dir.glob("*.nii.gz")):
        if p.name.startswith("_"):
            continue
        img = describe(p)
        m = np.asarray(img.dataobj)
        labels = np.unique(m)
        on = m > 0
        vox = int(on.sum())
        ml = vox * float(np.prod(np.array(img.header.get_zooms()[:3]))) / 1000.0
        idx = np.argwhere(on)
        if len(idx):
            w0 = nib.affines.apply_affine(img.affine, idx.min(0))
            w1 = nib.affines.apply_affine(img.affine, idx.max(0))
            lo, hi = np.minimum(w0, w1), np.maximum(w0, w1)
            # The masks live on a j-flipped copy of the CT grid ("handedness canonicalised"), so map each mask voxel to the
            # CT voxel at the same WORLD position before reading HU (index-by-index comparison reads the wrong voxels).
            to_ct = np.linalg.inv(ct_img.affine) @ img.affine
            ijk = np.round(nib.affines.apply_affine(to_ct, idx)).astype(int)
            ok = np.all((ijk >= 0) & (ijk < np.array(ct.shape)), axis=1)
            ctw = ct[tuple(ijk[ok].T)]
            hu = f"HU p5/p50/p95 = {np.percentile(ctw, 5):.0f}/{np.percentile(ctw, 50):.0f}/{np.percentile(ctw, 95):.0f} ({ok.mean() * 100:.0f}% of voxels inside the CT grid)"
            # nibabel world frame is NIfTI RAS+ (+x Right, +y Anterior); LPS = (-x, -y, z)
            lps_lo = np.array([-hi[0], -hi[1], lo[2]]); lps_hi = np.array([-lo[0], -lo[1], hi[2]])
            print(f"  labels {labels.tolist()}  voxels {vox}  volume {ml:.1f} mL")
            print(f"    RAS+ bbox lo {lo.round(1).tolist()} hi {hi.round(1).tolist()}   LPS bbox lo {lps_lo.round(1).tolist()} hi {lps_hi.round(1).tolist()}")
            print(f"    {hu}")
        else:
            print(f"  EMPTY mask  labels {labels.tolist()}")
    _ = zooms


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "ct_test_2002_image")
