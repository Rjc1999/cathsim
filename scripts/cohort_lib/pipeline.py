"""One case, end to end: CT + chamber masks → GLB + index.json (+ quality evidence). Shared by process_cohort_case.py (the
hand-curated case_2002) and batch_process_cohort.py (automatic naming). Stage descriptions are in process_cohort_case.py."""
from __future__ import annotations

import json
import shutil
import subprocess
import time
from pathlib import Path

import numpy as np
import scipy.ndimage as ndi
from scipy.spatial import cKDTree

from . import anatomy, autolabel, labeling, meshing, qc
from .glb import GlbBuilder
from .io_lps import load_case, make_roi_grid, resample_case
from .skeleton import ConsolidationParams, build_tree, consolidate_tree, smooth_geometry
from .vessels import Ostia, VesselParams, ascending_aorta, extract_coronaries

COMPRESS_SCRIPT = Path(__file__).resolve().parents[1] / "compress-glb.mjs"
ENVELOPE_TRIS = 14000
CONSOLIDATION = ConsolidationParams()  # 22 mm twigs, side branches >= 20 mm and > 25 deg, parallel strands within 5 mm over > 12 mm
PART_TRIS = 1400
CORONARY_TRIS = (25000, 34000)  # total budget range for both trees
TRIS_PER_MM = 40
SILHOUETTE_COLORS = {  # clay teaching colours, used by the 3D twin via COLOR_0
    "LV": (0.79, 0.46, 0.37),
    "RV": (0.87, 0.60, 0.53),
    "LA": (0.50, 0.58, 0.69),
    "RA": (0.56, 0.64, 0.74),
    "Aorta": (0.66, 0.72, 0.80),
    "PulmonaryTrunk": (0.56, 0.64, 0.74),
}


class Timer:
    def __init__(self, log):
        self.t = time.time()
        self.log = log
        self.stages: dict[str, float] = {}

    def lap(self, name: str) -> None:
        now = time.time()
        self.stages[name] = round(now - self.t, 1)
        self.log(f"  [{name}: {self.stages[name]:.0f} s]")
        self.t = now


def run_case(
    case_id: str,
    ct_path: Path,
    seg_dir: Path,
    out_name: str,
    out_dir: Path,
    workdir: Path,
    cfg: dict | None = None,
    reuse_coronaries: bool = False,
    compress: bool = True,
    spacing: float = 0.5,
    pin_anchors_to: Path | None = None,
    log=print,
) -> dict:
    """Process one case. `cfg` is the curated config, or None for automatic naming. Returns a result dict (never raises for
    expected anatomical failures: those come back as status 'skipped' with the reason)."""
    (workdir / "qc").mkdir(parents=True, exist_ok=True)
    out_dir.mkdir(parents=True, exist_ok=True)
    tm = Timer(log)
    result: dict = {"case_id": case_id, "name": out_name, "status": "ok"}

    # ------------------------------------------------------------------------------------------------ 1. load
    log(f"[1/6] load {case_id}")
    case = load_case(Path(ct_path).parent, ct_path=ct_path, seg_dir=seg_dir)
    grid, ref = make_roi_grid(case, spacing=spacing)
    ct, masks = resample_case(case, ref)
    sp = grid.spacing
    log(f"  ROI grid {grid.shape[::-1]} (x,y,z) @ {sp} mm; origin LPS {np.round(grid.origin, 1).tolist()}")
    src = case.ct
    result["source"] = {"ct_size": list(src.GetSize()), "ct_spacing": [round(v, 4) for v in src.GetSpacing()], "direction_det": round(float(np.linalg.det(np.array(src.GetDirection()).reshape(3, 3))), 3)}
    tm.lap("load")

    # ------------------------------------------------------------------------------------------------ 2. coronaries
    log("[2/6] coronary lumen")
    vp = VesselParams()
    cache_npz, cache_json = workdir / "coronaries.npz", workdir / "coronaries.json"
    if reuse_coronaries and cache_npz.exists() and cache_json.exists():
        z = np.load(cache_npz)
        meta_c = json.loads(cache_json.read_text())
        pools_c = masks["heart_ventricle_left"] | masks["heart_ventricle_right"] | masks["heart_atrium_left"] | masks["heart_atrium_right"] | masks["pulmonary_artery"]
        res = dict(lumen={"LCA": z["LCA"], "RCA": z["RCA"]}, ostia=Ostia(lca=np.array(meta_c["ostia_lps"]["LCA"]), rca=np.array(meta_c["ostia_lps"]["RCA"])), asc=ascending_aorta(masks, grid), dom={"pools": pools_c})
        log(f"  reused {cache_npz}")
    else:
        res = extract_coronaries(ct, masks, grid, vp, cache_dir=workdir)
        np.savez_compressed(cache_npz, LCA=res["lumen"]["LCA"], RCA=res["lumen"]["RCA"])
        cache_json.write_text(json.dumps({"ostia_lps": {"LCA": res["ostia"].lca.tolist(), "RCA": res["ostia"].rca.tolist()}, "log": vp.log}, indent=1))
    asc = res["asc"]
    result["ostia_lps"] = {"LCA": [round(float(v), 1) for v in res["ostia"].lca], "RCA": [round(float(v), 1) for v in res["ostia"].rca]}
    result["lumen_ml"] = {k: round(float(v.sum() * sp ** 3 / 1000), 2) for k, v in res["lumen"].items()}
    tm.lap("coronaries")

    # ------------------------------------------------------------------------------------------------ 3. trees + labels
    log("[3/6] centerline trees and branch naming")
    twig = float(cfg["twig_prune_mm"]) if cfg else CONSOLIDATION.twig_mm
    cparams = ConsolidationParams(**{**CONSOLIDATION.__dict__, "twig_mm": twig})
    vess_path = workdir / "vesselness.npy"
    vess = np.load(vess_path, mmap_mode="r") if vess_path.exists() else None
    result["consolidation"] = {}
    trees, kept = {}, {}
    for system in ("LCA", "RCA"):
        ostium = res["ostia"].lca if system == "LCA" else res["ostia"].rca
        trees[system] = build_tree(res["lumen"][system], ostium, grid)
        all_ids = {s.id for s in trees[system].segments}
        protect = {x for br in (cfg or {}).get("branches", {}).get(system, []) for x in (br.get("seg"), br.get("tip_seg")) if x is not None}  # curated heads/tips are never pruned
        kept[system], crep = consolidate_tree(trees[system], all_ids, cparams, vess=vess, grid=grid, protect=protect)
        crep["segments"] = len(all_ids)
        result["consolidation"][system] = crep
        log(f"  {system}: consolidation {len(all_ids)} segments -> {crep['after_kept']} (micro-twigs <{twig:.0f} mm {crep['twig']}, side branches <{cparams.min_takeoff_deg:.0f} deg or <{cparams.min_branch_mm:.0f} mm {crep['side_branch']}, parallel strands {crep['parallel']}) in {crep['chains']} chains")
        for pr in crep["parallel_pairs"]:
            log(f"      parallel strand suppressed: {pr['suppressed_len_mm']} mm (score {pr['score_suppressed']}) beside {pr['kept_len_mm']} mm (score {pr['score_kept']}), co-directional run {pr['run_mm']} mm")
    grooves = autolabel.compute_grooves(masks, grid)
    evidence: dict = {}
    if cfg is None:
        try:
            cfg, evidence = autolabel.make_config(trees, kept, grooves, twig)
        except autolabel.LabelingError as e:
            result.update(status="skipped", reason=f"anatomy not identified: {e}")
            log(f"  SKIPPED: {result['reason']}")
            return result
        cfg["case_id"] = case_id
        (workdir / "auto_config.json").write_text(json.dumps(cfg, indent=1))
        log(f"  automatic naming; evidence {evidence}")
    lm_mm = float(cfg["lm_length_mm"])
    node_lps, labels, results_b, seg_labels = {}, {}, {}, {}
    for system in ("LCA", "RCA"):
        tree, kp = trees[system], kept[system]
        for ex in cfg.get("exclude_segs", {}).get(system, []):
            stack = [ex["seg"]]
            while stack:
                sid = stack.pop()
                kp.discard(sid)
                stack.extend(tree.segments[sid].children)
            log(f"  {system}: excluded segment {ex['seg']} and its subtree ({ex['reason']})")
        bcfg = cfg["branches"][system]
        if pin_anchors_to is not None:
            for b in bcfg:
                if "seg" in b:
                    s = tree.segments[b["seg"]]
                    b["anchor"] = [round(float(v), 1) for v in s.pts[len(s.pts) // 2]]
        elif not cfg.get("auto"):
            labeling.check_anchors(tree, bcfg, {})
        nl, sl = labeling.label_tree(system, tree, kp, bcfg, lm_mm, twig)
        lps = grid.zyx_to_lps(tree.skeleton_zyx)
        results_b[system] = labeling.branch_paths(system, tree, kp, bcfg, sl, lps, nl, lm_mm)
        labels[system], node_lps[system], seg_labels[system] = nl, lps, sl
        log(f"  {system}: {len(tree.segments)} segments → {len(kp)} after consolidation; centerline {sum(tree.segments[i].length for i in kp):.0f} mm")
        for r in results_b[system]:
            log(f"    {r.id:4s} {r.length_mm:6.1f} mm  mean r {r.centerline[:, 3].mean():.2f} mm  end [{', '.join(f'{v:.0f}' for v in r.centerline[-1, :3])}]")
    if pin_anchors_to is not None:
        pin_anchors_to.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
        log(f"  anchors written to {pin_anchors_to}")
    pools = res["dom"]["pools"]
    vol = qc.masked_volume(ct, pools, asc, masks["heart_myocardium"], grid)
    try:
        qc.tree_overlay(workdir / "qc" / "tree_ids.png", vol, trees, kept, grid)
    except Exception as e:  # the QC picture is a convenience (its slab assumes a typical heart position), never a reason to lose a case
        log(f"  (QC overlay skipped: {type(e).__name__}: {e})")
    result["variants"] = autolabel.estimate_variants(trees, kept, grooves, evidence)
    tm.lap("trees")

    # ------------------------------------------------------------------------------------------------ 4. coronary meshes
    log("[4/6] coronary meshes (centerline tubes → Taubin → decimation)")
    cardiac_c = anatomy.cardiac_centroid(masks, grid)  # isocenter, CT-frame LPS
    log(f"  isocenter (cardiac chamber volume centroid), CT-frame LPS mm: {np.round(cardiac_c, 2).tolist()}")
    total_len = sum(trees[s].segments[i].length for s in ("LCA", "RCA") for i in kept[s])
    total_budget = int(np.clip(TRIS_PER_MM * total_len, *CORONARY_TRIS))
    branch_meshes, qa_rows = [], []
    for system in ("LCA", "RCA"):
        tree = trees[system]
        keep_rows = np.array([lab is not None for lab in labels[system]])
        sk_lps = node_lps[system][keep_rows]
        sk_lab = labels[system][keep_rows]
        sk_tan = tree.node_tangent[keep_rows]
        sm_pts, sm_rad = smooth_geometry(tree, kept[system])
        use = ~np.isnan(sm_rad) & keep_rows
        lumen_ml = res["lumen"][system].sum() * sp ** 3 / 1000
        v, f = meshing.balls_union_mesh(sm_pts[use], sm_rad[use], spacing=0.35)
        vol0 = meshing.signed_volume(v, f)
        v = meshing.taubin_smooth(v, f, iterations=20)
        vol1 = meshing.signed_volume(v, f)
        sys_len = sum(tree.segments[i].length for i in kept[system])
        budget = int(max(3000, total_budget * sys_len / total_len))
        v, f = meshing.decimate(v, f, budget)
        vol2 = meshing.signed_volume(v, f)
        log(f"  {system}: tube mesh {vol0 / 1000:.2f} mL → Taubin {vol1 / 1000:.2f} mL ({(vol1 / vol0 - 1) * 100:+.1f}%) → {len(f)} tris {vol2 / 1000:.2f} mL; thresholded lumen {lumen_ml:.2f} mL; boundary edges {meshing.boundary_edge_count(f)}")
        qa_rows.append((system, lumen_ml, vol2 / 1000, len(f)))
        normals = meshing.vertex_normals(v, f)
        _, nn = cKDTree(sk_lps).query(v)
        axis = sk_tan[nn]
        d = v - sk_lps[nn]
        radius = np.clip(np.linalg.norm(d - np.sum(d * axis, axis=1, keepdims=True) * axis, axis=1), 0.3, 4.5)
        vlab = sk_lab[nn]
        for b in cfg["branches"][system]:
            bid = b["id"]
            tri_lab = vlab[f]
            l0, l1, l2 = tri_lab[:, 0], tri_lab[:, 1], tri_lab[:, 2]
            tri = np.where((l0 == l1) | (l0 == l2), l0, np.where(l1 == l2, l1, l0))
            sel = f[tri == bid]
            if len(sel) == 0:
                log(f"    (no triangles for {system}/{bid})")
                continue
            sv, sf = meshing.compact(v, sel)
            used = np.unique(sel)
            branch_meshes.append(dict(system=system, id=bid, v=sv, f=sf, n=normals[used], radius=radius[used], axis=axis[used]))
    n_cor = sum(len(b["f"]) for b in branch_meshes)
    log(f"  coronary triangles total: {n_cor}")
    result["coronary_tris"] = n_cor
    tm.lap("meshes")

    # ------------------------------------------------------------------------------------------------ 5. silhouette + landmarks
    log("[5/6] cardiac silhouette (closed solid) and landmarks")
    parts = anatomy.silhouette_parts(masks, asc, grid)
    env = anatomy.filled_envelope(parts, grid)
    ev, ef = meshing.mask_to_mesh(env, grid, sigma_vox=1.0, level=0.5)
    ev = meshing.taubin_smooth(ev, ef, iterations=20)
    ev, ef = meshing.decimate(ev, ef, ENVELOPE_TRIS)
    log(f"  envelope: {len(ef)} tris, volume {meshing.signed_volume(ev, ef) / 1000:.0f} mL, boundary edges {meshing.boundary_edge_count(ef)}")
    result["envelope_tris"] = len(ef)
    result["envelope_ml"] = round(meshing.signed_volume(ev, ef) / 1000, 0)
    part_meshes = {}
    for pid, m in parts.items():
        pv, pf = meshing.mask_to_mesh(m, grid, sigma_vox=1.0, level=0.5)
        pv = meshing.taubin_smooth(pv, pf, iterations=15)
        pv, pf = meshing.decimate(pv, pf, PART_TRIS)
        part_meshes[pid] = (pv, pf)
    spine = anatomy.detect_spine(ct, masks, masks["aorta"] & ~asc, grid)
    heart_all = masks["heart_ventricle_left"] | masks["heart_myocardium"] | masks["heart_ventricle_right"] | masks["heart_atrium_left"] | masks["heart_atrium_right"]
    zmin_heart = float(grid.zyx_to_lps(np.argwhere(heart_all).min(axis=0))[2])
    log(f"  lowest cardiac point z = {zmin_heart - cardiac_c[2]:.1f} mm (iso frame); spine: " + (f"{len(spine['centres'])} slices, {spine['volume_ml']:.0f} mL" if spine else "not detected (the app keeps its procedural default)"))
    tm.lap("silhouette")

    # ------------------------------------------------------------------------------------------------ 6. export
    log("[6/6] export")
    iso = cardiac_c
    meta = {
        "case_id": case_id,
        "isocenter_ct_lps_mm": [round(float(v), 3) for v in iso],
        "frame": "LPS mm (+X patient left, +Y posterior, +Z cranial), isocenter = cardiac chamber volume centroid at (0, 0, 0)",
        "voxel_spacing_mm": sp,
        "source_ct": f"{case_id}.nii.gz; masks TotalSegmentator heartchambers_highres (non-commercial)",
        "coronary_method": "classical: Frangi vesselness + epicardial domain + minimal-path connectivity from detected ostia + local half-maximum lumen (no coronary mask existed)",
        "labeling": "curated by hand" if not cfg.get("auto") else "automatic: path selection by adherence to the anterior interventricular / left AV / right AV grooves computed from the chamber masks",
        "provisional_labels": True,
        "qc_status": "UNREVIEWED (upstream QC_REJECTED marker; coronary extraction and labels not clinically validated)",
    }
    gb = GlbBuilder(scene_extras=meta)
    gb.add_mesh("SoftTissueEnvelope", ev - iso, ef, meshing.vertex_normals(ev, ef), {"kind": "shadow", "id": "SoftTissueEnvelope", "label": "Filled cardiac volume (fluoro soft-tissue shadow)"})
    for pid, (pv, pf) in part_meshes.items():
        col = np.tile(np.array(SILHOUETTE_COLORS[pid], dtype=np.float32), (len(pv), 1))
        gb.add_mesh(pid, pv - iso, pf, meshing.vertex_normals(pv, pf), {"kind": "silhouette", "id": pid, "label": pid}, colors=col)
    for bm in branch_meshes:
        gb.add_mesh(f"{bm['system']}_{bm['id']}", bm["v"] - iso, bm["f"], bm["n"], {"kind": "coronary", "system": bm["system"], "id": bm["id"]}, radius=bm["radius"], axis=bm["axis"])
    glb_path = out_dir / f"{out_name}.glb"
    size = gb.write(glb_path)
    env_lo, env_hi = (ev - iso).min(0), (ev - iso).max(0)
    index = {
        "version": 2,
        "meta": meta,
        "branches": [],
        "landmarks": {
            "diaphragm_apex": [round(float(cardiac_c[0] - iso[0]), 1), round(float(cardiac_c[1] - iso[1]), 1), round(zmin_heart - 2.0 - iso[2], 1)],
            "spine": None if spine is None else {"centres": [[round(float(c), 1) for c in p] for p in (spine["centres"] - iso)[::6]], "radius_mm": round(float(np.median(spine["radii"])), 1)},
            "envelope_bounds_mm": {"min": [round(float(v), 1) for v in env_lo], "max": [round(float(v), 1) for v in env_hi]},
        },
        "qc": [{"system": s, "lumen_ml": round(a, 3), "mesh_ml": round(b, 3), "tris": n} for s, a, b, n in qa_rows],
    }
    for system in ("LCA", "RCA"):
        for r in results_b[system]:
            if not any(b["id"] == r.id and b["system"] == system for b in branch_meshes):
                continue
            index["branches"].append(
                {
                    "system": system,
                    "id": r.id,
                    "label": r.label,
                    "labelT": r.labelT,
                    "lengthMm": round(r.length_mm, 1),
                    "centerline": [[round(float(c), 2) for c in row] for row in (r.centerline - np.append(iso, 0.0))],
                    "hit": [[round(float(c), 1) for c in p] for p in (r.hit_points - iso)],
                }
            )
    result["branch_quality"] = autolabel.branch_quality(index["branches"], grooves, iso)
    result["evidence"] = evidence
    result["variants"]["lad_length_mm"] = next((b["lengthMm"] for b in index["branches"] if b["id"] == "LAD"), None)
    index["variants"] = result["variants"]
    idx_path = out_dir / f"{out_name}.index.json"
    idx_path.write_text(json.dumps(index, separators=(",", ":")), encoding="utf-8")
    log(f"  wrote {idx_path} ({idx_path.stat().st_size / 1024:.0f} KB)")
    if compress and shutil.which("node"):
        tmp = glb_path.with_suffix(".raw.glb")
        shutil.move(glb_path, tmp)
        r = subprocess.run(["node", str(COMPRESS_SCRIPT), str(tmp), str(glb_path)], capture_output=True, text=True)
        if r.returncode == 0:
            tmp.unlink()
            size = glb_path.stat().st_size
            log(f"  meshopt-compressed GLB: {size / 1024:.0f} KB")
        else:
            shutil.move(tmp, glb_path)
            log(f"  compression failed, kept the uncompressed GLB: {r.stderr.strip()[:200]}")
    result.update(
        glb_kb=round(glb_path.stat().st_size / 1024), index_kb=round(idx_path.stat().st_size / 1024, 1), isocenter_ct_lps_mm=meta["isocenter_ct_lps_mm"],
        envelope_bounds_mm=index["landmarks"]["envelope_bounds_mm"], branches=[b["id"] for b in index["branches"]], spine_detected=spine is not None,
        centerline_mm={s: round(sum(trees[s].segments[i].length for i in kept[s]), 0) for s in ("LCA", "RCA")},
    )
    tm.lap("export")
    result["timings_s"] = tm.stages
    return result
