"""Loading a cohort case and bringing it onto one clean patient-LPS grid.

Frames, because this is where mirror errors are born:

* SimpleITK physical space is **LPS** (+x = patient Left, +y = Posterior, +z = Superior). Reading a NIfTI with SimpleITK
  converts the file's RAS+ world frame to LPS, so everything below is LPS without any manual sign flipping.
* The case's CT is stored LAS with a left-handed (negative-determinant) affine, while its TotalSegmentator masks sit on a
  j-flipped copy of that grid ("handedness canonicalised"). Index-wise they do not line up; in physical space they do.
  Everything is therefore resampled onto one reference grid *through physical space*, never by array index.
* The reference grid is axis-aligned with an identity direction matrix, so numpy arrays are indexed [k=z, j=y, i=x] and
  LPS(x, y, z) = origin + spacing * (i, j, k). That makes every later index <-> millimetre conversion trivial.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
import SimpleITK as sitk

MASK_NAMES = (
    "aorta",
    "heart_atrium_left",
    "heart_atrium_right",
    "heart_myocardium",
    "heart_ventricle_left",
    "heart_ventricle_right",
    "pulmonary_artery",
)


@dataclass
class Grid:
    """Axis-aligned LPS voxel grid: LPS = origin + spacing * (i, j, k); arrays are indexed [k, j, i]."""

    origin: np.ndarray  # (3,) LPS mm of voxel (0, 0, 0)
    spacing: float  # isotropic, mm
    shape: tuple[int, int, int]  # (nz, ny, nx)

    def zyx_to_lps(self, zyx) -> np.ndarray:
        zyx = np.asarray(zyx, dtype=float)
        return self.origin + self.spacing * zyx[..., ::-1]

    def lps_to_zyx(self, lps) -> np.ndarray:
        lps = np.asarray(lps, dtype=float)
        return ((lps - self.origin) / self.spacing)[..., ::-1]

    def axis(self, k: int) -> np.ndarray:
        """LPS coordinates of the voxel centres along axis k (0 = x, 1 = y, 2 = z)."""
        n = self.shape[2 - k]
        return self.origin[k] + self.spacing * np.arange(n)


@dataclass
class Case:
    case_id: str
    ct: sitk.Image
    masks: dict[str, sitk.Image]
    root: Path


def load_case(case_dir: str | Path, ct_path: str | Path | None = None, seg_dir: str | Path | None = None) -> Case:
    """Load a case. By default the CT and `segmentation/` live under `case_dir`; for the cohort layout the CT is in
    `batch_cases/<id>/` and the masks in `batch_results/<id>/segmentation/`, so both can be given explicitly."""
    root = Path(case_dir)
    ct_file = Path(ct_path) if ct_path else next(root.glob("*.nii.gz"))
    seg = Path(seg_dir) if seg_dir else root / "segmentation"
    ct = sitk.ReadImage(str(ct_file))
    masks = {n: sitk.ReadImage(str(seg / f"{n}.nii.gz")) for n in MASK_NAMES}
    return Case(case_id=root.name, ct=ct, masks=masks, root=root)


def _mask_bbox_lps(img: sitk.Image) -> tuple[np.ndarray, np.ndarray]:
    a = sitk.GetArrayFromImage(img) > 0
    idx = np.argwhere(a)
    corners = [idx.min(0), idx.max(0)]
    pts = np.array([img.TransformIndexToPhysicalPoint([int(c[2]), int(c[1]), int(c[0])]) for c in corners])
    return pts.min(0), pts.max(0)


def make_roi_grid(case: Case, spacing: float = 0.5, pad_mm: float = 22.0) -> tuple[Grid, sitk.Image]:
    """Reference grid around the cardiac chambers (+ pad), clipped to the CT's own extent (never extrapolated)."""
    lo = np.full(3, np.inf)
    hi = np.full(3, -np.inf)
    for name in MASK_NAMES:
        if name in ("aorta", "pulmonary_artery"):
            continue  # the aorta mask includes the descending aorta far from the heart
        a, b = _mask_bbox_lps(case.masks[name])
        lo, hi = np.minimum(lo, a), np.maximum(hi, b)
    # CT extent in LPS
    size = np.array(case.ct.GetSize())
    corners = np.array(
        [case.ct.TransformIndexToPhysicalPoint([int(i * (size[0] - 1)), int(j * (size[1] - 1)), int(k * (size[2] - 1))]) for i in (0, 1) for j in (0, 1) for k in (0, 1)]
    )
    ct_lo, ct_hi = corners.min(0), corners.max(0)
    origin = np.maximum(lo - pad_mm, ct_lo)
    top = np.minimum(hi + pad_mm, ct_hi)
    shape_xyz = np.ceil((top - origin) / spacing).astype(int)
    ref = sitk.Image([int(s) for s in shape_xyz], sitk.sitkInt16)
    ref.SetSpacing((spacing,) * 3)
    ref.SetOrigin([float(v) for v in origin])
    ref.SetDirection((1, 0, 0, 0, 1, 0, 0, 0, 1))
    return Grid(origin=origin, spacing=spacing, shape=(int(shape_xyz[2]), int(shape_xyz[1]), int(shape_xyz[0]))), ref


def resample_case(case: Case, ref: sitk.Image) -> tuple[np.ndarray, dict[str, np.ndarray]]:
    """CT (cubic B-spline, HU as float32) and masks (nearest neighbour) on the reference grid, via physical space."""
    ct = sitk.Resample(case.ct, ref, sitk.Transform(), sitk.sitkBSpline, -1024.0, sitk.sitkFloat32)
    masks = {
        n: sitk.GetArrayFromImage(sitk.Resample(im, ref, sitk.Transform(), sitk.sitkNearestNeighbor, 0, sitk.sitkUInt8)).astype(bool)
        for n, im in case.masks.items()
    }
    return sitk.GetArrayFromImage(ct), masks
