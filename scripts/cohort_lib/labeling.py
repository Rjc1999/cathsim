"""Branch naming on the patient's centerline tree, driven by a small curated config (see cohort_configs/*.json).

Mirrors what the app expects: every skeleton node ends up with exactly one branch label (unnamed twigs inherit the label of
their nearest named ancestor, so highlighting a branch lights its whole territory), plus for each named branch a smooth,
resampled main-path centerline with the local lumen radius, and the set of all its skeleton points for tap hit-testing.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .skeleton import Tree, nearest_segment


@dataclass
class BranchResult:
    id: str
    label: str
    labelT: float
    centerline: np.ndarray  # (n, 4) x, y, z, radius  (LPS mm, CT frame)
    length_mm: float
    hit_points: np.ndarray  # (k, 3)


def _smooth(pts: np.ndarray, w: int = 2) -> np.ndarray:
    out = pts.copy()
    for i in range(1, len(pts) - 1):
        a, b = max(0, i - w), min(len(pts), i + w + 1)
        out[i] = pts[a:b].mean(axis=0)
    return out


def _median(x: np.ndarray, w: int = 4) -> np.ndarray:
    return np.array([np.median(x[max(0, i - w) : i + w + 1]) for i in range(len(x))])


def _resample(pts: np.ndarray, rad: np.ndarray, step: float = 2.0) -> np.ndarray:
    seg = np.linalg.norm(np.diff(pts, axis=0), axis=1)
    s = np.concatenate([[0], np.cumsum(seg)])
    if s[-1] < 1e-6:
        return np.hstack([pts[:1], rad[:1, None]])
    t = np.unique(np.concatenate([np.arange(0, s[-1], step), [s[-1]]]))
    return np.stack([np.interp(t, s, pts[:, k]) for k in range(3)] + [np.interp(t, s, rad)], axis=1)


def label_tree(system: str, tree: Tree, kept: set[int], cfg: list[dict], lm_mm: float, twig_mm: float):
    """Returns (node_label: array of str per skeleton node (None if pruned), results: list[BranchResult])."""
    segs = tree.segments
    named: dict[int, dict] = {}
    for b in cfg:
        if b.get("lm"):
            continue
        sid = b["seg"]
        if sid not in kept:
            raise RuntimeError(f"{system}/{b['id']}: segment {sid} is not in the pruned tree (twig pruning {twig_mm} mm)")
        named[sid] = b
    root_lab = next((b["id"] for b in cfg if not b.get("lm")), cfg[0]["id"])

    seg_label: dict[int, str] = {}
    for s in segs:
        if s.id not in kept:
            continue
        if s.id in named:
            seg_label[s.id] = named[s.id]["id"]
        elif s.parent >= 0 and s.parent in seg_label:
            seg_label[s.id] = seg_label[s.parent]
        else:
            seg_label[s.id] = root_lab

    has_lm = any(b.get("lm") for b in cfg)
    node_label = np.empty(len(tree.node_segment), dtype=object)
    for i, sid in enumerate(tree.node_segment):
        if sid not in kept:
            node_label[i] = None
        elif has_lm and tree.node_dist[i] <= lm_mm:
            node_label[i] = "LM"
        else:
            node_label[i] = seg_label[int(sid)]

    # per-segment points → skeleton node rows
    results: list[BranchResult] = []
    pts_all = tree.skeleton_zyx  # voxel indices; LPS positions are attached by the caller through `lps_of_nodes`
    _ = pts_all
    return node_label, seg_label


def branch_paths(system: str, tree: Tree, kept: set[int], cfg: list[dict], seg_label: dict[int, str], node_lps: np.ndarray, node_label: np.ndarray, lm_mm: float) -> list[BranchResult]:
    segs = tree.segments
    out: list[BranchResult] = []
    for b in cfg:
        bid = b["id"]
        if b.get("lm"):
            idx = np.nonzero(node_label == "LM")[0]
            order = idx[np.argsort(tree.node_dist[idx])]
            # follow only the heaviest path: LM nodes along the trunk (first root segment chain) are enough
            pts = node_lps[order]
            rad = tree.radius_mm[order]
            if len(pts) < 2:
                pts = np.vstack([pts, pts[-1] + 0.5 * tree.node_tangent[order[-1]]])
                rad = np.append(rad, rad[-1])
            path_nodes = order
        else:
            chain: list[int] = []
            sid = b["seg"]
            if "tip_seg" in b:
                up = []
                s = b["tip_seg"]
                while s != sid:
                    up.append(s)
                    s = segs[s].parent
                    if s < 0:
                        raise RuntimeError(f"{system}/{bid}: tip segment {b['tip_seg']} is not below segment {sid}")
                chain = [sid] + up[::-1]
            else:
                s = sid
                chain = [s]
                while True:
                    ks = [c for c in segs[s].children if c in kept and seg_label.get(c) == bid]
                    if not ks:
                        break
                    s = max(ks, key=lambda c: segs[c].subtree_length)
                    chain.append(s)
            rows = np.concatenate([np.nonzero(tree.node_segment == c)[0][np.argsort(tree.node_dist[tree.node_segment == c])] for c in chain])
            rows = np.array([r for r in rows if node_label[r] == bid])
            pts, rad, path_nodes = node_lps[rows], tree.radius_mm[rows], rows
        pts = _smooth(pts)
        rad = _median(rad)
        cl = _resample(pts, rad)
        length = float(np.linalg.norm(np.diff(cl[:, :3], axis=0), axis=1).sum())
        hit_rows = np.nonzero(node_label == bid)[0][::2]
        out.append(BranchResult(id=bid, label=b["label"], labelT=float(b.get("labelT", 0.5)), centerline=cl, length_mm=length, hit_points=node_lps[hit_rows]))
        _ = path_nodes
    return out


def check_anchors(tree: Tree, cfg: list[dict], node_lps_by_seg_mid: dict[int, np.ndarray], tol_mm: float = 4.0) -> None:
    """Every configured segment must still contain its recorded anchor point (guards against silent relabelling when the
    extraction parameters or the source scan change)."""
    for b in cfg:
        if "seg" in b and "anchor" in b:
            sid, d = nearest_segment(tree, np.asarray(b["anchor"], float))
            if sid != b["seg"] or d > tol_mm:
                raise RuntimeError(f"{b['id']}: anchor resolves to segment {sid} ({d:.1f} mm), expected {b['seg']}")
