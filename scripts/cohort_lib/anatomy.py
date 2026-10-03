"""Cardiac silhouette (closed solid) and CT-derived orientation landmarks.

The TotalSegmentator heartchambers masks are blood pools (plus the LV myocardium). RV, LA and RA walls are not segmented, so
those pools are grown by a typical wall thickness (RV 2.5 mm, atria 2.0 mm) to approximate the epicardial surface.
Every part is a SOLID voxel volume, so its mesh is closed and has no hollow double wall; the filled union is what the fluoro
soft-tissue shadow measures (see src/components/SoftTissueShadow.tsx).
"""
from __future__ import annotations

import cc3d
import numpy as np
import scipy.ndimage as ndi

from .io_lps import Grid

WALL_MM = {"RV": 2.5, "LA": 2.0, "RA": 2.0}
AORTA_ABOVE_VALVE_MM = 45.0  # ascending aorta kept up to this height above its lowest slice (the root and sinuses)
PA_MAX_DISTANCE_MM = 18.0  # pulmonary trunk and the first part of its branches


def _grow(m: np.ndarray, mm: float, sp: float) -> np.ndarray:
    return ndi.distance_transform_edt(~m, sampling=sp) <= mm


def silhouette_parts(masks: dict[str, np.ndarray], asc: np.ndarray, grid: Grid) -> dict[str, np.ndarray]:
    sp = grid.spacing
    zc = grid.axis(2)
    lv = masks["heart_ventricle_left"] | masks["heart_myocardium"]
    chambers = lv | masks["heart_ventricle_right"] | masks["heart_atrium_left"] | masks["heart_atrium_right"]
    zmin_asc = zc[np.nonzero(asc.any(axis=(1, 2)))[0].min()]
    parts = {
        "LV": lv,
        "RV": _grow(masks["heart_ventricle_right"], WALL_MM["RV"], sp),
        "LA": _grow(masks["heart_atrium_left"], WALL_MM["LA"], sp),
        "RA": _grow(masks["heart_atrium_right"], WALL_MM["RA"], sp),
        "Aorta": asc & (zc[:, None, None] <= zmin_asc + AORTA_ABOVE_VALVE_MM),
        "PulmonaryTrunk": masks["pulmonary_artery"] & (ndi.distance_transform_edt(~chambers, sampling=sp) <= PA_MAX_DISTANCE_MM),
    }
    return parts


def filled_envelope(parts: dict[str, np.ndarray], grid: Grid, closing_mm: float = 2.0) -> np.ndarray:
    """Union of the parts, closed and hole-filled, keeping the largest component."""
    sp = grid.spacing
    u = np.zeros_like(next(iter(parts.values())))
    for m in parts.values():
        u |= m
    r = int(round(closing_mm / sp))
    u = ndi.binary_closing(u, structure=ndi.generate_binary_structure(3, 1), iterations=r)
    u = ndi.binary_fill_holes(u)
    lab, n = cc3d.connected_components(u, connectivity=26, return_N=True)
    sizes = np.bincount(lab.ravel())
    sizes[0] = 0
    return lab == int(np.argmax(sizes))


def cardiac_centroid(masks: dict[str, np.ndarray], grid: Grid) -> np.ndarray:
    """Volume centroid (LPS mm) of the cardiac chambers: the cath-lab isocenter. Includes the LV myocardium."""
    m = masks["heart_ventricle_left"] | masks["heart_myocardium"] | masks["heart_ventricle_right"] | masks["heart_atrium_left"] | masks["heart_atrium_right"]
    return grid.zyx_to_lps(np.argwhere(m).mean(axis=0))


def detect_spine(ct: np.ndarray, masks: dict[str, np.ndarray], desc_aorta: np.ndarray, grid: Grid) -> dict | None:
    """Thoracic vertebral column from the CT: moderately bright (cancellous bone) blob behind the descending aorta.
    Returns per-slice centres (LPS mm) and an equivalent radius, or None if nothing credible is found."""
    sp = grid.spacing
    sm = ndi.gaussian_filter(ct, 1.0 / sp)
    mask_any = np.zeros_like(desc_aorta)
    for m in masks.values():
        mask_any |= m
    ok = ~ndi.binary_dilation(mask_any | desc_aorta, iterations=int(round(3 / sp)))
    zc = grid.axis(2)
    cen_y = grid.axis(1)[np.nonzero(desc_aorta.any(axis=(0, 2)))[0]].mean() if desc_aorta.any() else None
    if cen_y is None:
        return None
    ymask = grid.axis(1)[None, :, None] >= cen_y + 8.0  # strictly behind the descending aorta
    bone = (sm >= 120) & (sm <= 420) & ok & ymask
    bone = ndi.binary_opening(bone, iterations=2)
    lab, n = cc3d.connected_components(bone, connectivity=26, return_N=True)
    if n == 0:
        return None
    sizes = np.bincount(lab.ravel())
    sizes[0] = 0
    blob = lab == int(np.argmax(sizes))
    if blob.sum() * sp ** 3 < 15000:  # < 15 mL: not a vertebral column
        return None
    centres, radii = [], []
    for k in range(blob.shape[0]):
        sl = blob[k]
        if sl.sum() * sp * sp < 300:
            continue
        ys, xs = np.nonzero(sl)
        centres.append([grid.origin[0] + xs.mean() * sp, grid.origin[1] + ys.mean() * sp, zc[k]])
        radii.append(float(np.sqrt(sl.sum() * sp * sp / np.pi)))
    if len(centres) < 20:
        return None
    return {"centres": np.array(centres), "radii": np.array(radii), "volume_ml": float(blob.sum() * sp ** 3 / 1000)}
