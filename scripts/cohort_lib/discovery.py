"""Cohort discovery and objective QC screening (read-only).

For every `ct_test_*` case it inventories the inputs and measures what can be measured without extracting the coronaries:

* inputs: contrast CT volume, the seven TotalSegmentator chamber masks, any coronary mask (none exist in this cohort);
* markers: the upstream `QC_REJECTED` file and `batch_case_summary.json` status. In this cohort the marker means "unattended
  run, not reviewed" (0 of 39 were visually confirmed), so it is reported as a FLAG, never used as a filter on its own;
* spatial integrity: CT header (shape, spacing, axis codes, determinant), masks on the CT's own grid or its j-flipped
  twin, every mask inside the CT field of view and clear of its border;
* mask <-> CT alignment through physical space: median HU inside each pool must be contrast-enhanced (a flipped or
  misregistered mask would sit on lung or fat);
* contrast and coverage: aortic / LA HU, ascending-aortic root height inside the FOV (ostia need the sinuses), chamber
  volumes within physiological range, slice thickness and in-plane spacing.

Each case gets a 0-100 screening score and a list of flags / blockers.
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path

import nibabel as nib
import numpy as np
import SimpleITK as sitk

from .io_lps import MASK_NAMES

CASES_ROOT = Path(r"D:\CT to map\batch_cases")
RESULTS_ROOT = Path(r"D:\CT to map\batch_results")

# physiological sanity ranges (mL) for TotalSegmentator pools at any phase; generous on purpose
VOLUME_RANGE_ML = {
    "heart_ventricle_left": (25, 320),
    "heart_myocardium": (40, 260),
    "heart_ventricle_right": (30, 320),
    "heart_atrium_left": (25, 220),
    "heart_atrium_right": (25, 260),
    "aorta": (30, 400),
    "pulmonary_artery": (10, 160),
}


@dataclass
class CaseReport:
    case_id: str
    ct_path: str | None = None
    seg_dir: str | None = None
    has_ct: bool = False
    has_all_masks: bool = False
    coronary_masks: list[str] = field(default_factory=list)
    qc_rejected_marker: bool = False
    summary_status: str | None = None
    ct_shape: list[int] | None = None
    ct_spacing: list[float] | None = None
    ct_axes: str | None = None
    ct_det: float | None = None
    ct_hu: list[float] | None = None
    volumes_ml: dict[str, float] = field(default_factory=dict)
    hu_in_masks: dict[str, float] = field(default_factory=dict)
    border_touch: list[str] = field(default_factory=list)
    asc_aorta_height_mm: float | None = None
    score: float = 0.0
    flags: list[str] = field(default_factory=list)
    blockers: list[str] = field(default_factory=list)

    @property
    def usable(self) -> bool:
        return not self.blockers


def _mask_stats(mask_img: sitk.Image, ct: sitk.Image, ct_arr: np.ndarray) -> tuple[float, float, bool, np.ndarray]:
    """volume mL, median HU of the CT sampled at the mask voxels through physical space, touches-CT-border flag, LPS z extent."""
    a = sitk.GetArrayFromImage(mask_img) > 0
    idx = np.argwhere(a)
    if len(idx) == 0:
        return 0.0, float("nan"), False, np.zeros(2)
    sp = mask_img.GetSpacing()
    vol = float(a.sum() * sp[0] * sp[1] * sp[2] / 1000.0)
    sub = idx[:: max(1, len(idx) // 20000)]
    pts = np.array([mask_img.TransformIndexToPhysicalPoint([int(i[2]), int(i[1]), int(i[0])]) for i in sub])
    ci = np.array([ct.TransformPhysicalPointToContinuousIndex(p) for p in pts])
    size = np.array(ct.GetSize())
    inside = np.all((ci >= 0) & (ci <= size - 1), axis=1)
    hu = ct_arr[tuple(np.round(ci[inside][:, ::-1]).astype(int).T)] if inside.any() else np.array([np.nan])
    margin = 2  # voxels
    touches = bool(np.any((ci < margin) | (ci > size - 1 - margin)))
    return vol, float(np.median(hu)), touches, np.array([pts[:, 2].min(), pts[:, 2].max()])


def screen_case(case_id: str) -> CaseReport:
    r = CaseReport(case_id=case_id)
    ct_file = CASES_ROOT / case_id / f"{case_id}.nii.gz"
    res = RESULTS_ROOT / case_id
    seg = res / "segmentation"
    r.ct_path, r.seg_dir = str(ct_file), str(seg)
    r.has_ct = ct_file.exists()
    r.has_all_masks = all((seg / f"{n}.nii.gz").exists() for n in MASK_NAMES)
    r.coronary_masks = sorted(p.name for p in list(res.rglob("*coron*")) + list(seg.glob("*coron*")))
    r.qc_rejected_marker = (res / "QC_REJECTED").exists()
    summ = res / "batch_case_summary.json"
    if summ.exists():
        r.summary_status = json.loads(summ.read_text()).get("status")
    if not r.has_ct:
        r.blockers.append("no CT volume")
    if not r.has_all_masks:
        r.blockers.append("missing chamber mask(s)")
    if r.blockers:
        return r

    img = nib.load(str(ct_file))
    r.ct_shape = [int(v) for v in img.shape]
    r.ct_spacing = [round(float(v), 4) for v in img.header.get_zooms()[:3]]
    r.ct_axes = "".join(nib.aff2axcodes(img.affine))
    r.ct_det = float(np.linalg.det(img.affine[:3, :3]))
    ct = sitk.ReadImage(str(ct_file))
    arr = sitk.GetArrayFromImage(ct).astype(np.float32)
    r.ct_hu = [float(np.percentile(arr, 1)), float(np.percentile(arr, 99))]

    score = 100.0
    # spacing
    if r.ct_spacing[2] > 1.0:
        r.blockers.append(f"slice spacing {r.ct_spacing[2]} mm > 1.0")
    elif r.ct_spacing[2] > 0.75:
        r.flags.append(f"slice spacing {r.ct_spacing[2]} mm")
        score -= 8
    if max(r.ct_spacing[:2]) > 0.6:
        r.flags.append(f"in-plane spacing {max(r.ct_spacing[:2])} mm")
        score -= 8
    if abs(r.ct_spacing[0] - r.ct_spacing[1]) > 1e-3:
        r.flags.append("anisotropic in-plane spacing")
    # header sanity
    if not np.isfinite(r.ct_det) or abs(r.ct_det) < 1e-6:
        r.blockers.append("degenerate CT affine")

    stats = {}
    for n in MASK_NAMES:
        m = sitk.ReadImage(str(seg / f"{n}.nii.gz"))
        if m.GetSize() != ct.GetSize():
            r.flags.append(f"{n}: grid {m.GetSize()} differs from CT {ct.GetSize()} (resampled via physical space)")
        vol, hu, touch, zext = _mask_stats(m, ct, arr)
        stats[n] = (vol, hu, touch, zext)
        r.volumes_ml[n] = round(vol, 1)
        r.hu_in_masks[n] = round(hu, 0) if np.isfinite(hu) else float("nan")
        lo, hi = VOLUME_RANGE_ML[n]
        if vol == 0:
            r.blockers.append(f"{n} empty")
        elif not (lo <= vol <= hi):
            r.flags.append(f"{n} volume {vol:.0f} mL outside {lo}-{hi}")
            score -= 6
        if touch and n not in ("aorta", "pulmonary_artery"):
            r.border_touch.append(n)
    if r.border_touch:
        r.blockers.append("chamber mask touches the CT border: heart cut by the FOV (" + ", ".join(r.border_touch) + ")")

    # alignment: contrast-filled pools must sit on bright voxels (a misregistered / flipped mask sits on lung or fat)
    for n in ("heart_ventricle_left", "heart_atrium_left", "aorta"):
        hu = r.hu_in_masks.get(n, float("nan"))
        if not np.isfinite(hu) or hu < 150:
            r.blockers.append(f"{n} median HU {hu}: mask not aligned with contrast blood")
    aorta_hu = r.hu_in_masks.get("aorta", 0)
    if np.isfinite(aorta_hu):
        if aorta_hu < 280:
            r.flags.append(f"modest aortic enhancement {aorta_hu:.0f} HU")
            score -= 15
        elif aorta_hu < 350:
            score -= 5
    if r.hu_in_masks.get("heart_myocardium", 0) > 0.8 * aorta_hu:
        r.flags.append("myocardium nearly as bright as blood (poor contrast separation)")
        score -= 10

    # ascending aorta must show its root and sinuses inside the FOV
    z = stats["aorta"][3]
    zlv = stats["heart_ventricle_left"][3]
    r.asc_aorta_height_mm = round(float(z[1] - zlv[0]), 1)
    if z[1] - stats["heart_ventricle_left"][3][1] < 25:
        r.flags.append("ascending aorta ends close to the LV top: little aortic root in the FOV")
        score -= 12
    if r.qc_rejected_marker:
        r.flags.append("QC_REJECTED marker (unattended run, not reviewed)")
    if r.summary_status not in ("ok", None):
        r.flags.append(f"upstream status {r.summary_status}")
        score -= 10
    r.score = max(0.0, round(score, 1))
    return r


def discover(case_ids: list[str] | None = None) -> list[CaseReport]:
    ids = case_ids or sorted(p.name for p in CASES_ROOT.iterdir() if p.is_dir() and p.name.startswith("ct_test_"))
    out = []
    for cid in ids:
        out.append(screen_case(cid))
    return out


def to_json(reports: list[CaseReport]) -> str:
    return json.dumps([asdict(r) for r in reports], indent=1, default=float)
