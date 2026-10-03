"""Coronary lumen extraction from a contrast CT when no coronary mask exists.

Why this is not a global threshold: in this CT the coronaries are ~400 HU proximally but only 120-200 HU distally
(partial volume, radius ~0.6 mm), while the pulmonary veins, atrial appendages, chamber rims and the internal mammary
arteries are as bright as the proximal vessels. Intensity alone either misses the distal tree or floods the mediastinum.
What does separate them is geometry and context, so the method is:

  1. Vesselness (multi-scale Frangi) gives a calibre-independent "tube-likeness" that stays high on thin distal vessels.
  2. A domain restricts candidates to the epicardial region: within 7 mm of the heart surface (the coronaries sit in
     epicardial fat; the internal mammary arteries sit 19-20 mm away), outside the chamber blood pools (their partial-volume
     rims are plate-like but bright), outside the myocardium and outside structures thicker than a coronary (opening).
  3. Minimal-path (geodesic) cost from each aortic ostium over a soft tubularity cost: strict vesselness blobs that are
     reachable cheaply are kept, each assigned to the geodesically nearer ostium (LCA / RCA), and the cheapest paths are
     kept as bridges across short low-vesselness gaps.
  4. The *lumen* is NOT the vesselness mask (that is a thin ridge, median radius 0.7 mm). It is re-segmented around the
     bridged centerlines with a local half-maximum threshold, taken from the peak HU of the nearest centerline voxel, so
     calibre follows the data instead of a global cut: bright proximal vessels and faint distal ones both keep their size.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field

import cc3d
import numpy as np
import scipy.ndimage as ndi
from skimage.filters import frangi
from skimage.graph import MCP_Geometric
from skimage.morphology import skeletonize

from .io_lps import Grid


@dataclass
class VesselParams:
    smooth_sigma_mm: float = 0.3
    frangi_sigmas_mm: tuple[float, ...] = (0.5, 0.75, 1.1, 1.5)
    max_distance_to_epicardium_mm: float = 7.0
    root_zone_mm: float = 12.0  # near the ascending aorta the domain is widened so the ostia connect
    pool_margin_mm: float = 1.2
    myocardium_margin_mm: float = 0.4
    max_vessel_radius_mm: float = 2.6  # structures with a larger inscribed radius are chambers / veins / aorta
    strict_vesselness: float = 0.004
    strict_min_hu: float = 110.0
    min_blob_voxels: int = 20
    max_geodesic_cost: float = 2000.0
    max_gap_mm: float = 3.5  # a path may cross at most this much non-vessel space between strict vessel voxels
    ostium_band_mm: tuple[float, float] = (5.0, 35.0)  # above the lowest ascending-aorta slice
    ostium_vesselness: float = 0.004
    ostium_min_hu: float = 280.0
    background_hu: float = -60.0  # epicardial fat, for the half-maximum lumen threshold
    lumen_min_threshold_hu: float = 140.0
    lumen_radius_mm: tuple[float, float] = (1.0, 2.6)  # allowed radius at peak HU 150 → 400
    cranial_margin_mm: float = 3.0  # coronaries lie below the sinuses: limit = top of the ostium band + this
    keep_below_z_mm: float | None = None  # explicit override of the cranial limit
    log: list[str] = field(default_factory=list)


def _say(p: VesselParams, msg: str) -> None:
    p.log.append(msg)
    print("  " + msg, flush=True)


def ascending_aorta(masks: dict[str, np.ndarray], grid: Grid) -> np.ndarray:
    """The aorta component that touches the LV: the ascending aorta. (The arch is outside the scan; the descending
    aorta is a second component.)"""
    lab, n = cc3d.connected_components(masks["aorta"], connectivity=26, return_N=True)
    d_lv = ndi.distance_transform_edt(~masks["heart_ventricle_left"], sampling=grid.spacing)
    best, best_size = 0, -1
    for i in range(1, n + 1):
        comp = lab == i
        if d_lv[comp].min() < 3.0 and comp.sum() > best_size:
            best, best_size = i, int(comp.sum())
    if best == 0:
        raise RuntimeError("no aorta component touches the left ventricle")
    return lab == best


def vesselness(ct: np.ndarray, region: np.ndarray, grid: Grid, p: VesselParams) -> np.ndarray:
    """Multi-scale Frangi (bright tubes) on a crop around `region`; zero elsewhere. ~100 s for a heart-sized ROI."""
    sm = ndi.gaussian_filter(ct, p.smooth_sigma_mm / grid.spacing)
    idx = np.argwhere(region)
    lo, hi = idx.min(0), idx.max(0) + 1
    sl = tuple(slice(a, b) for a, b in zip(lo, hi))
    crop = np.clip(sm[sl], -200, 600)
    sig = [s / grid.spacing for s in p.frangi_sigmas_mm]
    v = np.zeros_like(sm)
    v[sl] = frangi(crop, sigmas=sig, black_ridges=False, alpha=0.5, beta=0.5)
    return v


@dataclass
class Ostia:
    lca: np.ndarray  # LPS mm
    rca: np.ndarray


def detect_ostia(ct_sm, vess, asc, pools, grid: Grid, p: VesselParams, anterior_xy: np.ndarray | None = None) -> Ostia:
    """Ostia = the two largest strongly tubular, bright clusters hugging the sinuses of the ascending aorta.
    Left or right is decided by the rotation around the aortic axis, not by x alone (the heart can be rotated by tens of degrees):
    with `a` the axial direction from the aortic axis towards the right ventricle / pulmonary trunk (anterior) and v the ostium's
    offset from the axis, the left sinus is the one with the larger cross(a, v) = a_x v_y - a_y v_x (a = (0, -1) gives plain +x = left)."""
    zc = grid.axis(2)
    zmin = zc[np.nonzero(asc.any(axis=(1, 2)))[0].min()]
    band = (zc[:, None, None] >= zmin + p.ostium_band_mm[0]) & (zc[:, None, None] <= zmin + p.ostium_band_mm[1])
    d_asc = ndi.distance_transform_edt(~asc, sampling=grid.spacing)
    excl = ndi.distance_transform_edt(~pools, sampling=grid.spacing) <= 0.9
    cand = band & (d_asc > 0.6) & (d_asc <= 8.0) & (vess > p.ostium_vesselness) & (ct_sm >= p.ostium_min_hu) & ~asc & ~excl
    lab, n = cc3d.connected_components(cand, connectivity=26, return_N=True)
    sizes = np.bincount(lab.ravel())
    sizes[0] = 0
    order = np.argsort(sizes)[::-1]
    picked: list[tuple[int, np.ndarray]] = []
    for c in order:
        if sizes[c] < 100:
            break
        idx = np.argwhere(lab == c)
        d = d_asc[tuple(idx.T)]
        pt = grid.zyx_to_lps(idx[np.argmin(d)])  # voxel of the cluster closest to the aortic wall
        if all(np.linalg.norm(pt - q) > 12.0 for _, q in picked):
            picked.append((int(sizes[c]), pt))
        if len(picked) == 2:
            break
    if len(picked) < 2:
        raise RuntimeError("fewer than two ostium candidates found; adjust the ostium band / thresholds")
    a, b = picked[0][1], picked[1][1]
    if anterior_xy is None:
        lca, rca = (a, b) if a[0] > b[0] else (b, a)
    else:
        sl = np.argwhere(asc & (zc[:, None, None] >= zmin + 8.0) & (zc[:, None, None] <= zmin + 22.0))
        c = grid.zyx_to_lps(sl.mean(0))[:2]  # axial position of the aortic axis (x, y)
        ra = anterior_xy - c

        def side(q):
            v = q[:2] - c
            return ra[0] * v[1] - ra[1] * v[0]

        lca, rca = (a, b) if side(a) > side(b) else (b, a)
    return Ostia(lca=lca, rca=rca)


def build_domain(ct_sm, vess, asc, masks, grid: Grid, p: VesselParams) -> dict[str, np.ndarray]:
    sp = grid.spacing
    chambers = masks["heart_ventricle_left"] | masks["heart_ventricle_right"] | masks["heart_atrium_left"] | masks["heart_atrium_right"]
    pools = chambers | masks["pulmonary_artery"]
    # epicardial envelope: closed, filled union of chambers + LV myocardium
    env = ndi.binary_closing(chambers | masks["heart_myocardium"], structure=ndi.generate_binary_structure(3, 1), iterations=int(round(8 / sp)))
    env = ndi.binary_fill_holes(env)
    d_env = ndi.distance_transform_edt(~env, sampling=sp)
    d_asc = ndi.distance_transform_edt(~asc, sampling=sp)
    d_pool = ndi.distance_transform_edt(~pools, sampling=sp)
    d_myo = ndi.distance_transform_edt(~masks["heart_myocardium"], sampling=sp)
    # structures thicker than a coronary (exact opening of the bright mask)
    bright = ct_sm >= 230
    core = ndi.distance_transform_edt(bright, sampling=sp) >= p.max_vessel_radius_mm
    thick = ndi.distance_transform_edt(~core, sampling=sp) <= p.max_vessel_radius_mm + 0.7
    allowed = ((d_env <= p.max_distance_to_epicardium_mm) | (d_asc <= p.root_zone_mm)) & (d_pool > p.pool_margin_mm) & ~asc & ~thick & (d_myo > p.myocardium_margin_mm)
    zc = grid.axis(2)
    zmin_asc = zc[np.nonzero(asc.any(axis=(1, 2)))[0].min()]
    z_limit = p.keep_below_z_mm if p.keep_below_z_mm is not None else zmin_asc + p.ostium_band_mm[1] + p.cranial_margin_mm
    allowed &= zc[:, None, None] <= z_limit
    p.log.append(f"cranial limit z <= {z_limit:.1f} mm")
    strict = allowed & (vess > p.strict_vesselness) & (ct_sm >= p.strict_min_hu)
    return dict(allowed=allowed, strict=strict, thick=thick, d_env=d_env, d_asc=d_asc, d_pool=d_pool, d_myo=d_myo, pools=pools, chambers=chambers, env=env)


def geodesic_tree(ct_sm, vess, dom, ostia: Ostia, grid: Grid, p: VesselParams):
    """Minimal-path reach from both ostia → strict vessel blobs (Voronoi-assigned) + bridge paths. Returns centerline seeds."""
    strict, allowed = dom["strict"], dom["allowed"]
    tub = np.clip(vess / 0.03, 0, 1) * np.clip((ct_sm - 40) / 150, 0.05, 1)
    cost = np.where(allowed, 1.0 / (0.03 + tub), 1e5).astype(np.float32)
    starts, cums, mcps = {}, {}, {}
    for name, pt in (("LCA", ostia.lca), ("RCA", ostia.rca)):
        k = np.round(grid.lps_to_zyx(pt)).astype(int)
        r = int(round(4.5 / grid.spacing))
        sl = tuple(slice(max(0, a - r), a + r + 1) for a in k)
        sub = np.where(strict[sl] & (ct_sm[sl] > 250), vess[sl], -1)
        kk = np.unravel_index(np.argmax(sub), sub.shape)
        start = tuple(int(sl[i].start + kk[i]) for i in range(3))
        mcp = MCP_Geometric(cost)
        cum, _ = mcp.find_costs([start])
        starts[name], cums[name], mcps[name] = start, cum, mcp
    blobs, nb = cc3d.connected_components(strict, connectivity=26, return_N=True)
    sizes = np.bincount(blobs.ravel())
    sizes[0] = 0
    ids = np.arange(1, nb + 1)
    min_cost = {n: ndi.minimum(cums[n], blobs, index=ids) for n in cums}
    max_gap_vox = int(round(p.max_gap_mm / grid.spacing))
    seeds = {"LCA": np.zeros_like(strict), "RCA": np.zeros_like(strict)}
    # Candidate blobs, cheapest first. A blob is accepted only if the minimal path from its ostium crosses at most
    # `max_gap_mm` of non-vessel space between strict-vessel voxels (so a vessel cannot be reached by cutting across
    # tissue), and the whole path is cheap enough. The accepted path voxels become the bridges across short gaps.
    cand = [bi for bi in range(1, nb + 1) if sizes[bi] >= p.min_blob_voxels and min(min_cost["LCA"][bi - 1], min_cost["RCA"][bi - 1]) < p.max_geodesic_cost]
    cand.sort(key=lambda bi: min(min_cost["LCA"][bi - 1], min_cost["RCA"][bi - 1]))
    accepted = 0
    for bi in cand:
        vox = np.argwhere(blobs == bi)
        # try the cheaper ostium first, then the other: a blob that one system cannot reach without crossing too much
        # non-vessel space (e.g. the proximal LAD hidden behind the pulmonary root) may still hang off the other tree
        order = sorted(("LCA", "RCA"), key=lambda n: min_cost[n][bi - 1])
        for name in order:
            if min_cost[name][bi - 1] >= p.max_geodesic_cost:
                continue
            end = tuple(vox[np.argmin(cums[name][tuple(vox.T)])])
            path = np.array(mcps[name].traceback(end))
            if path.ndim != 2 or path.shape[1] != 3:
                continue
            on_vessel = strict[tuple(path.T)]
            run = longest = 0
            for flag in on_vessel:
                run = 0 if flag else run + 1
                longest = max(longest, run)
            if longest > max_gap_vox:
                continue
            seeds[name][tuple(path.T)] = True
            seeds[name] |= blobs == bi
            accepted += 1
            break
    nb_good = accepted
    good = np.zeros(nb, dtype=bool)
    _say(p, f"blobs {nb}, candidates {len(cand)}, accepted {nb_good}; ostium starts {starts}")
    return seeds, starts, cums


def refine_lumen(ct_sm, seeds_mask, dom, masks, asc, grid: Grid, p: VesselParams, z_limit: float) -> np.ndarray:
    """Local half-maximum lumen around the (thin) bridged centerline seeds."""
    sp = grid.spacing
    seeds_mask = ndi.binary_closing(seeds_mask, structure=np.ones((3, 3, 3)))  # 26-connect the bridged ridge
    sk = skeletonize(seeds_mask)
    if not sk.any():
        return np.zeros_like(seeds_mask)
    peak = ndi.maximum_filter(ct_sm, size=3)  # PSF-robust peak HU per skeleton voxel
    dist, near = ndi.distance_transform_edt(~sk, sampling=sp, return_indices=True)
    core = peak[tuple(near)]  # peak HU of the nearest centerline voxel, for every voxel
    thr = np.maximum(0.5 * (core + p.background_hu), p.lumen_min_threshold_hu)
    rmax = np.interp(core, [150.0, 400.0], list(p.lumen_radius_mm))
    ok = ~dom["pools"] & (dom["d_pool"] > 0.8) & ~ndi.binary_dilation(asc, iterations=1) & (dom["d_myo"] > 0.2) & ~dom["thick"]
    ok &= grid.axis(2)[:, None, None] <= z_limit
    lumen = (ct_sm >= thr) & (dist <= rmax) & ok | ndi.binary_dilation(sk, iterations=1)
    lab, n = cc3d.connected_components(lumen, connectivity=26, return_N=True)
    keep = np.unique(lab[sk])
    keep = keep[keep > 0]
    lumen = np.isin(lab, keep)
    return ndi.binary_fill_holes(lumen)


def extract_coronaries(ct, masks, grid: Grid, p: VesselParams, cache_dir=None):
    """Full extraction. Returns dict(lumen={'LCA','RCA'}, ostia, domain pieces, ct_sm, asc)."""
    t0 = time.time()
    sp = grid.spacing
    asc = ascending_aorta(masks, grid)
    ct_sm = ndi.gaussian_filter(ct, p.smooth_sigma_mm / sp)
    pools0 = masks["heart_ventricle_left"] | masks["heart_ventricle_right"] | masks["heart_atrium_left"] | masks["heart_atrium_right"] | masks["pulmonary_artery"]
    env0 = ndi.binary_fill_holes(ndi.binary_closing(pools0 | masks["heart_myocardium"], structure=ndi.generate_binary_structure(3, 1), iterations=int(round(8 / sp))))
    region = (ndi.distance_transform_edt(~env0, sampling=sp) <= p.max_distance_to_epicardium_mm + 3.0) | (ndi.distance_transform_edt(~asc, sampling=sp) <= p.root_zone_mm + 3.0)
    vess = None
    cache = None
    if cache_dir is not None:
        from pathlib import Path

        cache = Path(cache_dir) / "vesselness.npy"
        if cache.exists():
            cached = np.load(cache)
            if cached.shape == ct.shape:
                vess = cached
                _say(p, f"vesselness loaded from cache ({cache})")
            else:
                _say(p, f"cached vesselness has shape {cached.shape}, grid is {ct.shape}: recomputing")
    if vess is None:
        _say(p, "computing vesselness (Frangi, ~100 s) ...")
        vess = vesselness(ct, region, grid, p)
        if cache is not None:
            cache.parent.mkdir(parents=True, exist_ok=True)
            np.save(cache, vess.astype(np.float32))
    rv_pa = masks["heart_ventricle_right"] | masks["pulmonary_artery"]
    anterior_xy = grid.zyx_to_lps(np.argwhere(rv_pa)[::50].mean(0))[:2]
    ostia = detect_ostia(ct_sm, vess, asc, pools0, grid, p, anterior_xy=anterior_xy)
    _say(p, f"ostia (LPS mm): LCA {np.round(ostia.lca, 1).tolist()}  RCA {np.round(ostia.rca, 1).tolist()}")
    dom = build_domain(ct_sm, vess, asc, masks, grid, p)
    seeds, starts, cums = geodesic_tree(ct_sm, vess, dom, ostia, grid, p)
    z_limit = float(grid.axis(2)[np.nonzero(dom['allowed'].any(axis=(1, 2)))[0].max()])
    lumen = {k: refine_lumen(ct_sm, seeds[k], dom, masks, asc, grid, p, z_limit) for k in seeds}
    for k, v in lumen.items():
        _say(p, f"{k} lumen: {v.sum() * sp ** 3 / 1000:.2f} mL, {int(v.sum())} voxels")
    _say(p, f"coronary extraction {time.time() - t0:.0f} s")
    return dict(lumen=lumen, seeds=seeds, ostia=ostia, dom=dom, ct_sm=ct_sm, asc=asc, vess=vess, starts=starts, cums=cums)
