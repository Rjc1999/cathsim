"""Automatic branch naming from anatomical grooves (for cases without a hand-curated config).

The three epicardial grooves are computed from the chamber masks (no coronary information needed):
  * anterior interventricular groove = RV/LV interface, anterior half;  the LAD runs in it, to the apex
  * left atrioventricular groove     = LA/LV interface;                 the LCx runs in it
  * right atrioventricular groove    = RA/RV interface;                 the RCA runs in it
Each root-to-leaf path of the pruned centerline tree is scored by the length of path that stays within a corridor of its
groove; the best path is the vessel. Side branches are named by position (lateral side branches of the LAD = diagonals,
of the LCx = obtuse marginals). Everything the data does not support stays unnamed, and the evidence is returned so a case
can be accepted or rejected on measured grounds. This reproduces the labelling format of the curated config
(cohort_configs/*.json), so the rest of the pipeline is shared.

Honest scope: this identifies the LAD, LCx, LM, diagonals, obtuse marginals and the RCA trunk. It does not name PDA, PLB or
acute marginal branches (no reliable criterion at this image resolution) and it cannot tell an artery from a neighbouring vein
by intensity, so labels remain provisional.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import scipy.ndimage as ndi
from scipy.spatial import cKDTree

from .io_lps import Grid
from .skeleton import Tree, build_chains, parallel_run_mm, resample_with_tangents

CORRIDOR_MM = 5.0
RCA_CORRIDOR_MM = 6.0
MIN_SIDE_BRANCH_MM = 15.0
SIDE_BRANCH_MAX_GROOVE_MM = 10.0


class LabelingError(RuntimeError):
    """The anatomy could not be identified on measured grounds (the case is skipped, not guessed)."""


@dataclass
class Grooves:
    trees: dict[str, cKDTree]
    centroid: np.ndarray  # cardiac chamber centroid, CT-frame LPS
    lv_centroid: np.ndarray
    apex: np.ndarray
    counts: dict[str, int] = field(default_factory=dict)


def _interface(a: np.ndarray, b: np.ndarray, sp: float, mm: float = 3.0) -> np.ndarray:
    return (ndi.distance_transform_edt(~a, sampling=sp) <= mm) & (ndi.distance_transform_edt(~b, sampling=sp) <= mm)


def compute_grooves(masks: dict[str, np.ndarray], grid: Grid) -> Grooves:
    """The three epicardial grooves as point sets on the outer surface of the heart: surface voxels that lie close to BOTH
    neighbouring chambers (ventricular wall + epicardial fat is ~6-10 mm, so a blood-pool contact line would sit too deep)."""
    sp = grid.spacing
    lv = masks["heart_ventricle_left"] | masks["heart_myocardium"]
    rv, la, ra = masks["heart_ventricle_right"], masks["heart_atrium_left"], masks["heart_atrium_right"]
    heart = lv | rv | la | ra
    cen = grid.zyx_to_lps(np.argwhere(heart).mean(0))
    env = ndi.binary_fill_holes(ndi.binary_closing(heart, structure=ndi.generate_binary_structure(3, 1), iterations=int(round(6 / sp))))
    surface = env & ~ndi.binary_erosion(env, iterations=2)
    d = {k: ndi.distance_transform_edt(~m, sampling=sp) for k, m in (("lv", lv), ("rv", rv), ("la", la), ("ra", ra))}
    anterior = grid.axis(1)[None, :, None] < cen[1]
    sets = {
        "anterior_iv": surface & (d["lv"] <= 6.0) & (d["rv"] <= 10.0) & anterior,
        "left_av": surface & (d["lv"] <= 6.0) & (d["la"] <= 8.0),
        "right_av": surface & (d["rv"] <= 8.0) & (d["ra"] <= 8.0),
    }
    trees, counts = {}, {}
    for k, m in sets.items():
        pts = grid.zyx_to_lps(np.argwhere(m))
        counts[k] = len(pts)
        if len(pts) < 200:
            raise LabelingError(f"{k} groove not found in the masks ({len(pts)} voxels)")
        trees[k] = cKDTree(pts[:: max(1, len(pts) // 60000)])
    base = _interface(lv, la | masks["aorta"], sp)
    base_c = grid.zyx_to_lps(np.argwhere(base).mean(0)) if base.any() else cen
    lv_pts = grid.zyx_to_lps(np.argwhere(lv)[::20])
    apex = lv_pts[np.argmax(np.linalg.norm(lv_pts - base_c, axis=1))]
    return Grooves(trees=trees, centroid=cen, lv_centroid=grid.zyx_to_lps(np.argwhere(lv).mean(0)), apex=apex, counts=counts)


def _paths(tree: Tree, kept: set[int]) -> list[list[int]]:
    out: list[list[int]] = []

    def walk(sid: int, acc: list[int]) -> None:
        acc = acc + [sid]
        ks = [c for c in tree.segments[sid].children if c in kept]
        if not ks:
            out.append(acc)
        for c in ks:
            walk(c, acc)

    walk(0, [])
    return out


def _path_points(tree: Tree, path: list[int]) -> np.ndarray:
    return np.vstack([tree.segments[s].pts for s in path])


def _corridor_mm(tree: Tree, path: list[int], gtree: cKDTree, width: float = CORRIDOR_MM) -> float:
    pts = _path_points(tree, path)
    if len(pts) < 2:
        return 0.0
    step = np.linalg.norm(np.diff(pts, axis=0), axis=1)
    mid = (pts[1:] + pts[:-1]) / 2
    d, _ = gtree.query(mid)
    return float(step[d <= width].sum())


def _path_len(tree: Tree, path: list[int]) -> float:
    return float(sum(tree.segments[s].length for s in path))


def _side_branches(tree: Tree, kept: set[int], path: list[int], skip: set[int]) -> list[tuple[float, int, np.ndarray]]:
    """(attach path distance, child segment, attach point) for kept children hanging off `path`."""
    on = set(path)
    out = []
    for sid in path:
        s = tree.segments[sid]
        for c in s.children:
            if c in kept and c not in on and c not in skip and tree.segments[c].subtree_length >= MIN_SIDE_BRANCH_MM:
                out.append((tree.segments[c].start_dist, c, s.pts[-1]))
    return sorted(out)


def _subtree(tree: Tree, sid: int) -> list[int]:
    out, stack = [], [sid]
    while stack:
        s = stack.pop()
        out.append(s)
        stack.extend(tree.segments[s].children)
    return out


def _groove_dist(tree: Tree, sid: int, kept: set[int], grooves: Grooves) -> float:
    pts = np.vstack([tree.segments[s].pts for s in _subtree(tree, sid) if s in kept])
    d = np.min([g.query(pts)[0] for g in grooves.trees.values()], axis=0)
    return float(np.median(d))


def make_config(trees: dict[str, Tree], kept: dict[str, set[int]], grooves: Grooves, twig_mm: float) -> tuple[dict, dict]:
    """Returns (config in the curated-config format, evidence/quality dict). Raises LabelingError if LAD, LCx or RCA are not found."""
    ev: dict = {}
    cfg: dict = {"twig_prune_mm": twig_mm, "branches": {"LCA": [], "RCA": []}, "exclude_segs": {"LCA": [], "RCA": []}, "auto": True}

    # ---- LCA: LAD and LCx
    t, kp = trees["LCA"], kept["LCA"]
    paths = _paths(t, kp)
    lad = max(paths, key=lambda p: (_corridor_mm(t, p, grooves.trees["anterior_iv"]), _path_len(t, p)))
    lad_corr = _corridor_mm(t, lad, grooves.trees["anterior_iv"])
    ev["LAD_corridor_mm"] = round(lad_corr, 1)
    ev["LAD_length_mm"] = round(_path_len(t, lad), 1)
    if lad_corr < 40 or _path_len(t, lad) < 60:
        raise LabelingError(f"LAD not identified (best path stays {lad_corr:.0f} mm in the anterior interventricular groove, length {_path_len(t, lad):.0f} mm)")
    lad_set = set(lad)

    def overlap(p):
        return sum(t.segments[s].length for s in p if s in lad_set)

    lcx_cands = [p for p in paths if overlap(p) <= 25.0 and p[-1] not in lad_set]
    lcx = max(lcx_cands, key=lambda p: (_corridor_mm(t, p, grooves.trees["left_av"]), _path_len(t, p)), default=None)
    lcx_corr = _corridor_mm(t, lcx, grooves.trees["left_av"]) if lcx else 0.0
    ev["LCx_corridor_mm"] = round(lcx_corr, 1)
    if lcx is None or lcx_corr < 25:
        raise LabelingError(f"LCx not identified (best path stays {lcx_corr:.0f} mm in the left AV groove)")
    lcx_set = set(lcx)
    shared = [s for s in lad if s in lcx_set]
    lad_own = [s for s in lad if s not in lcx_set]
    lcx_own = [s for s in lcx if s not in lad_set]
    if not lad_own or not lcx_own:
        raise LabelingError("LAD and LCx do not diverge")
    div_dist = t.segments[min(lad_own[0], lcx_own[0], key=lambda s: t.segments[s].start_dist)].start_dist
    lm_mm = float(np.clip(div_dist, 5.0, 20.0))
    cfg["lm_length_mm"] = round(lm_mm, 1)
    ev["LM_length_mm"] = round(lm_mm, 1)
    cfg["branches"]["LCA"].append({"id": "LM", "label": "Left main", "lm": True, "labelT": 0.6})
    cfg["branches"]["LCA"].append({"id": "LAD", "label": "Left anterior descending", "seg": lad_own[0], "tip_seg": lad[-1], "labelT": 0.35})
    cfg["branches"]["LCA"].append({"id": "LCx", "label": "Left circumflex", "seg": lcx_own[0], "tip_seg": lcx[-1], "labelT": 0.4})
    named_roots = {lad_own[0], lcx_own[0]}

    # diagonals (lateral side branches of the LAD) and a possible ramus (lateral branch right at the trifurcation)
    diag = 0
    ramus = False
    for dist, c, attach in _side_branches(t, kp, lad, skip=lcx_set):
        s = t.segments[c]
        lateral = float(s.pts[:, 0].mean() - attach[0]) > 2.0  # +x = patient left
        if not lateral:
            continue
        if dist <= lm_mm + 8.0:
            ramus = True
        if diag < 2:
            diag += 1
            cfg["branches"]["LCA"].append({"id": f"D{diag}", "label": "First diagonal / ramus" if diag == 1 else "Second diagonal", "seg": c, "labelT": 0.6})
            named_roots.add(c)
    om = 0
    for dist, c, attach in _side_branches(t, kp, [s for s in lcx if s not in lad_set], skip=set()):
        s = t.segments[c]
        if dist <= lm_mm + 10.0 or float(s.pts[:, 0].mean() - attach[0]) <= 0.0:
            continue
        if om < 2:
            om += 1
            cfg["branches"]["LCA"].append({"id": f"OM{om}", "label": "First obtuse marginal" if om == 1 else "Second obtuse marginal", "seg": c, "labelT": 0.55})
            named_roots.add(c)
    ev["n_diagonals"], ev["n_obtuse_marginals"], ev["ramus_like"] = diag, om, ramus

    # exclusions: any other side branch that does not hug an epicardial groove (not a coronary branch)
    on_paths = lad_set | lcx_set
    for sid in sorted(kp):
        if sid in on_paths or sid in named_roots:
            continue
        s = t.segments[sid]
        if s.parent in on_paths or s.parent in named_roots or s.parent < 0:
            pass
        if s.parent in on_paths and sid not in named_roots:
            if _groove_dist(t, sid, kp, grooves) > SIDE_BRANCH_MAX_GROOVE_MM:
                cfg["exclude_segs"]["LCA"].append({"seg": sid, "reason": "side branch median >10 mm from every epicardial groove"})

    # single-trunk exclusivity along the anterior interventricular groove: no other strand may run beside the LAD trunk
    lad_pts, lad_tan = resample_with_tangents(_path_points(t, lad))
    n_rail = 0
    for sid in sorted(kp):
        if sid in on_paths or sid in named_roots or t.segments[sid].parent not in lad_set:
            continue
        chain, cur, got = [], sid, 0.0
        while got < 40.0:  # the heaviest continuation of this side strand, up to 40 mm
            chain.append(cur)
            got += t.segments[cur].length
            ks = [c for c in t.segments[cur].children if c in kp]
            if not ks:
                break
            cur = max(ks, key=lambda c: t.segments[c].subtree_length)
        pa, ta = resample_with_tangents(np.vstack([t.segments[c].pts for c in chain]))
        run, frac = parallel_run_mm(pa, ta, lad_pts, lad_tan, 5.0, 0.5)
        if run >= 12.0 and frac >= 0.5:
            cfg["exclude_segs"]["LCA"].append({"seg": sid, "reason": f"strand parallel to the LAD trunk ({run:.0f} mm within 5 mm): one LAD per groove"})
            n_rail += 1
    ev["LAD_parallel_strands_excluded"] = n_rail

    # ---- RCA
    t_lca, lad_set_lca = t, lad_set
    t, kp = trees["RCA"], kept["RCA"]
    paths = _paths(t, kp)
    rca = max(paths, key=lambda p: (_corridor_mm(t, p, grooves.trees["right_av"], RCA_CORRIDOR_MM), _path_len(t, p)))
    rca_corr = _corridor_mm(t, rca, grooves.trees["right_av"], RCA_CORRIDOR_MM)
    ev["RCA_corridor_mm"] = round(rca_corr, 1)
    ev["RCA_length_mm"] = round(_path_len(t, rca), 1)
    if rca_corr < 25 or _path_len(t, rca) < 50:
        raise LabelingError(f"RCA not identified (best path stays {rca_corr:.0f} mm in the right AV groove, length {_path_len(t, rca):.0f} mm)")
    cfg["branches"]["RCA"].append({"id": "RCA", "label": "Right coronary artery", "seg": rca[0], "tip_seg": rca[-1], "labelT": 0.4})
    rset = set(rca)
    for sid in sorted(kp):
        if sid in rset:
            continue
        s = t.segments[sid]
        if s.parent in rset and _groove_dist(t, sid, kp, grooves) > SIDE_BRANCH_MAX_GROOVE_MM:
            cfg["exclude_segs"]["RCA"].append({"seg": sid, "reason": "side branch median >10 mm from every epicardial groove"})
    # no strand of the RCA tree may run down the anterior interventricular groove beside the LAD either
    n_rca_rail = 0
    for ch in build_chains(t, kp)[1:]:
        if set(ch.segs) & rset or ch.length < 12.0:
            continue
        pa, ta = resample_with_tangents(ch.pts)
        run, frac = parallel_run_mm(pa, ta, lad_pts, lad_tan, 5.0, 0.5)
        if run >= 12.0 and frac >= 0.5:
            cfg["exclude_segs"]["RCA"].append({"seg": ch.segs[0], "reason": f"strand running beside the LAD trunk ({run:.0f} mm within 5 mm): belongs to the LAD territory, not the RCA"})
            n_rca_rail += 1
    ev["RCA_strands_beside_LAD_excluded"] = n_rca_rail
    _ = (t_lca, lad_set_lca)
    return cfg, ev


def branch_quality(index_branches: list[dict], grooves: Grooves, iso: np.ndarray) -> dict:
    """Groove adherence of the final named centerlines (iso-frame index → CT frame), plus LAD-tip-to-apex distance."""
    want = {"LAD": "anterior_iv", "LCx": "left_av", "RCA": "right_av"}
    q: dict = {}
    for b in index_branches:
        if b["id"] in want:
            c = np.array(b["centerline"])[:, :3] + iso
            d, _ = grooves.trees[want[b["id"]]].query(c)
            q[b["id"]] = {"median_mm": round(float(np.median(d)), 1), "within6_pct": round(float(100 * (d <= 6).mean()), 0), "length_mm": b["lengthMm"]}
            if b["id"] == "LAD":
                q["LAD"]["tip_to_apex_mm"] = round(float(np.linalg.norm(c[-1] - grooves.apex)), 1)
    return q


def estimate_variants(trees: dict[str, Tree], kept: dict[str, set[int]], grooves: Grooves, evidence: dict) -> dict:
    """Heuristic coronary variant estimate from measured centerlines. Every item states its evidence; weak evidence → 'undetermined'."""
    out: dict = {}
    # dominance: how much of each tree runs on the inferior-posterior (diaphragmatic) surface of the LV
    ref = grooves.lv_centroid
    inf = {}
    for system in ("LCA", "RCA"):
        t = trees[system]
        tot = 0.0
        for sid in kept[system]:
            p = t.segments[sid].pts
            if len(p) < 2:
                continue
            step = np.linalg.norm(np.diff(p, axis=0), axis=1)
            mid = (p[1:] + p[:-1]) / 2
            sel = (mid[:, 2] < ref[2] - 5.0) & (mid[:, 1] > ref[1] - 5.0)
            tot += float(step[sel].sum())
        inf[system] = tot
    total = inf["LCA"] + inf["RCA"]
    out["inferior_wall_mm"] = {k: round(v, 0) for k, v in inf.items()}
    if total < 40:
        out["dominance"] = "undetermined"
    else:
        r = inf["RCA"] / total
        out["dominance"] = "right" if r >= 0.7 else "left" if r <= 0.3 else "balanced"
    out["dominance_basis"] = "estimate from centerline length on the inferior-posterior LV wall (LCA vs RCA); weak evidence below 40 mm total"
    out["ramus_like"] = bool(evidence.get("ramus_like"))
    out["lm_length_mm"] = evidence.get("LM_length_mm")
    return out
