"""Centerline tree of a coronary lumen mask: skeleton → shortest-path tree from the ostium → spur pruning → segments.

Radii come from the Euclidean distance transform of the lumen (the distance to the nearest non-lumen voxel at the skeleton
voxel), i.e. the true local caliber, not a fitted constant.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import scipy.ndimage as ndi
import scipy.sparse as sp
from scipy.sparse.csgraph import dijkstra
from skimage.morphology import skeletonize

from .io_lps import Grid


@dataclass
class Segment:
    id: int
    parent: int
    pts: np.ndarray  # (n, 3) LPS mm, origin → distal
    radius: np.ndarray  # (n,) mm
    children: list[int] = field(default_factory=list)
    length: float = 0.0
    subtree_length: float = 0.0
    start_dist: float = 0.0  # path distance from the root to the first point (mm)


@dataclass
class Tree:
    segments: list[Segment]
    skeleton_zyx: np.ndarray  # (m, 3) voxel indices of every kept skeleton voxel
    node_segment: np.ndarray  # (m,) segment id of each skeleton voxel
    radius_mm: np.ndarray  # (m,) local radius at each skeleton voxel
    node_dist: np.ndarray  # (m,) path distance from the root along the tree (mm)
    node_tangent: np.ndarray  # (m, 3) unit direction of the vessel at each skeleton voxel (root → distal)
    edt: np.ndarray  # distance transform of the lumen (mm), full grid


_OFFS = np.array([(a, b, c) for a in (-1, 0, 1) for b in (-1, 0, 1) for c in (-1, 0, 1) if (a, b, c) != (0, 0, 0)])


def _graph(sk_idx: np.ndarray, shape, spacing: float):
    flat = np.ravel_multi_index(sk_idx.T, shape)
    lookup = {int(f): i for i, f in enumerate(flat)}
    rows, cols, w = [], [], []
    for i, p in enumerate(sk_idx):
        for o in _OFFS:
            q = p + o
            if np.any(q < 0) or np.any(q >= shape):
                continue
            j = lookup.get(int(np.ravel_multi_index(q, shape)))
            if j is not None:
                rows.append(i)
                cols.append(j)
                w.append(float(np.linalg.norm(o)) * spacing)
    n = len(sk_idx)
    return sp.csr_matrix((w, (rows, cols)), shape=(n, n))


def build_tree(lumen: np.ndarray, ostium_lps: np.ndarray, grid: Grid, min_spur_mm: float = 3.0) -> Tree:
    spc = grid.spacing
    edt = ndi.distance_transform_edt(lumen, sampling=spc)
    sk = skeletonize(lumen)
    sk_idx = np.argwhere(sk)
    if len(sk_idx) == 0:
        raise RuntimeError("empty skeleton")
    g = _graph(sk_idx, lumen.shape, spc)
    pts_lps = grid.zyx_to_lps(sk_idx)
    root = int(np.argmin(np.linalg.norm(pts_lps - ostium_lps, axis=1)))
    dist, pred = dijkstra(g, directed=False, indices=root, return_predecessors=True)
    reach = np.isfinite(dist)
    n = len(sk_idx)
    parent = np.where(reach, pred, -9999)
    parent[root] = -1
    # children lists of the shortest-path tree
    kids: list[list[int]] = [[] for _ in range(n)]
    for i in range(n):
        if reach[i] and parent[i] >= 0:
            kids[int(parent[i])].append(i)
    alive = reach.copy()

    def prune_pass() -> int:
        removed = 0
        leaves = [i for i in range(n) if alive[i] and i != root and not any(alive[c] for c in kids[i])]
        for leaf in leaves:
            chain, cur, length = [leaf], leaf, 0.0
            while True:
                par = int(parent[cur])
                if par < 0:
                    break
                length += float(np.linalg.norm(pts_lps[cur] - pts_lps[par]))
                live_kids = [c for c in kids[par] if alive[c]]
                if len(live_kids) > 1 or par == root:
                    break  # reached a junction (or the root): the chain is a spur candidate
                chain.append(par)
                cur = par
            # a spur ends at a junction; only prune if short, and never the main trunk
            if length < min_spur_mm:
                par = int(parent[cur])
                if par >= 0 and len([c for c in kids[par] if alive[c]]) > 1:
                    for c in chain:
                        alive[c] = False
                    removed += len(chain)
        return removed

    for _ in range(3):
        if prune_pass() == 0:
            break

    def alive_kids(i):
        return [c for c in kids[i] if alive[c]]

    segments: list[Segment] = []
    node_segment = np.full(n, -1, dtype=int)
    radius = edt[tuple(sk_idx.T)]

    def trace(start: int, parent_seg: int):
        stack = [(start, parent_seg)]
        while stack:
            s, ps = stack.pop()
            chain = [s]
            while True:
                ks = alive_kids(chain[-1])
                if len(ks) != 1:
                    break
                chain.append(ks[0])
            sid = len(segments)
            seg = Segment(id=sid, parent=ps, pts=pts_lps[chain], radius=radius[chain].copy())
            for a, b in zip(chain[:-1], chain[1:]):
                seg.length += float(np.linalg.norm(pts_lps[a] - pts_lps[b]))
            if ps >= 0:
                par = segments[ps]
                seg.start_dist = par.start_dist + par.length + float(np.linalg.norm(pts_lps[chain[0]] - par.pts[-1]))
            segments.append(seg)
            node_segment[chain] = sid
            if ps >= 0:
                segments[ps].children.append(sid)
            for c in alive_kids(chain[-1]):
                stack.append((c, sid))

    trace(root, -1)
    for seg in reversed(segments):
        seg.subtree_length = seg.length + sum(segments[c].subtree_length for c in seg.children)
    # path distance from the root and local tangent (central difference over +-3 skeleton points of the same chain)
    node_dist = np.zeros(n)
    node_tan = np.zeros((n, 3))
    point_index = {tuple(pts_lps[i]): i for i in range(n)}
    for seg in segments:
        order = [point_index[tuple(q)] for q in seg.pts]
        d = seg.start_dist
        node_dist[order[0]] = d
        for a_, b_ in zip(order[:-1], order[1:]):
            d += float(np.linalg.norm(pts_lps[a_] - pts_lps[b_]))
            node_dist[b_] = d
        for k, i in enumerate(order):
            t = pts_lps[order[min(k + 3, len(order) - 1)]] - pts_lps[order[max(k - 3, 0)]]
            ln = np.linalg.norm(t)
            if ln > 1e-9:
                node_tan[i] = t / ln
            elif seg.parent >= 0:  # single-point segment: inherit the direction from the parent's last points
                pp = segments[seg.parent].pts
                t = seg.pts[0] - pp[max(len(pp) - 4, 0)]
                ln = np.linalg.norm(t)
                node_tan[i] = t / ln if ln > 1e-9 else 0.0
    keep = node_segment >= 0
    return Tree(segments=segments, skeleton_zyx=sk_idx[keep], node_segment=node_segment[keep], radius_mm=radius[keep], node_dist=node_dist[keep], node_tangent=node_tan[keep], edt=edt)


def nearest_segment(tree: Tree, point_lps: np.ndarray) -> tuple[int, float]:
    best, best_d = -1, np.inf
    for s in tree.segments:
        d = float(np.min(np.linalg.norm(s.pts - point_lps, axis=1)))
        if d < best_d:
            best, best_d = s.id, d
    return best, best_d


def describe(tree: Tree) -> list[str]:
    lines = []

    def walk(sid: int, depth: int) -> None:
        s = tree.segments[sid]
        lines.append(
            f"{'  ' * depth}seg{sid} len {s.length:5.1f} mm  subtree {s.subtree_length:6.1f} mm  r~{np.median(s.radius):.2f}  "
            f"start [{', '.join(f'{v:.0f}' for v in s.pts[0])}] end [{', '.join(f'{v:.0f}' for v in s.pts[-1])}]"
        )
        for c in s.children:
            walk(c, depth + 1)

    walk(0, 0)
    return lines


def prune_twigs(tree: Tree, min_twig_mm: float) -> set[int]:
    """Segment ids to keep after removing terminal segments (and everything under them) whose subtree is shorter than
    `min_twig_mm`, repeated until stable. The trunk and any segment with a long subtree are never removed."""
    kept = {s.id for s in tree.segments}

    def live_children(sid):
        return [c for c in tree.segments[sid].children if c in kept]

    changed = True
    while changed:
        changed = False
        for s in tree.segments:
            if s.id not in kept or s.id == 0:
                continue
            if not live_children(s.id) and s.length < min_twig_mm:
                kept.discard(s.id)
                changed = True
    return kept


def smooth_geometry(tree: Tree, kept: set[int], pos_window: int = 3, rad_window: int = 4, radius_offset_mm: float = 0.25, min_radius_mm: float = 0.45):
    """Smoothed centerline positions and calibre for every kept skeleton node, aligned with the rows of the tree arrays.

    Positions: moving average along each segment (segment end points stay fixed, so branches keep touching their parent).
    Calibre: the EDT radius of the thresholded lumen, median-filtered along the segment (junction nodes and voxel noise give
    spikes) then lightly averaged; `radius_offset_mm` adds the half-voxel the distance transform loses (it measures to the
    centre of the nearest outside voxel), and a floor keeps distal twigs from collapsing."""
    pts = np.full((len(tree.node_segment), 3), np.nan)
    rad = np.full(len(tree.node_segment), np.nan)
    rows_by_seg: dict[int, np.ndarray] = {}
    for sid in kept:
        rows = np.nonzero(tree.node_segment == sid)[0]
        rows_by_seg[sid] = rows[np.argsort(tree.node_dist[rows])]
    # the LPS position of a row = its voxel centre; recompute from the segment's own point array (same order)
    for sid, rows in rows_by_seg.items():
        seg = tree.segments[sid]
        p = seg.pts.copy()
        r = np.array([tree.radius_mm[i] for i in rows])
        n = len(p)
        ps = p.copy()
        for i in range(1, n - 1):
            a, b = max(0, i - pos_window), min(n, i + pos_window + 1)
            ps[i] = p[a:b].mean(axis=0)
        med = np.array([np.median(r[max(0, i - rad_window) : i + rad_window + 1]) for i in range(n)])
        rs = np.array([med[max(0, i - 2) : i + 3].mean() for i in range(n)])
        pts[rows] = ps
        rad[rows] = np.maximum(rs + radius_offset_mm, min_radius_mm)
    return pts, rad


# ----------------------------------------------------------------------------------------------------------------------
# Consolidation: a clean, canonical tree (one trunk per vessel, a few real side branches) instead of a braided bush.
#
# The skeleton of a thresholded lumen mask carries three kinds of clutter: micro-twigs (partial-volume spurs and septal
# stubs), side "branches" that hug the parent vessel (a duplicate centerline of the same lumen, or a neighbouring cardiac vein
# such as the great cardiac vein / anterior interventricular vein that the intensity threshold cannot tell apart from the
# artery), and parallel strands that run side by side for centimetres ("railroad tracking"). All three are removed here.
# The unit of the rules is a CHAIN: consecutive segments joined without a real junction (a junction is a node with at least
# two surviving children), so a strand that had twigs pruned off it is still one strand.
# ----------------------------------------------------------------------------------------------------------------------
from scipy.spatial import cKDTree  # noqa: E402


@dataclass
class ConsolidationParams:
    twig_mm: float = 22.0  # dead-end chains shorter than this are micro-twigs
    min_branch_mm: float = 20.0  # a side branch must reach this length (subtree)
    min_takeoff_deg: float = 25.0  # ... and leave the parent at more than this angle
    major_branch_mm: float = 60.0  # a branch with at least this much vessel beyond it is a main vessel (e.g. LAD vs LCx at the left-main
    # bifurcation, which can leave at a small angle), not a spur: exempt from the angle rule
    parallel_mm: float = 5.0  # two strands closer than this ...
    parallel_run_mm: float = 12.0  # ... over a run longer than this are one vessel seen twice
    parallel_min_dot: float = 0.5  # ... if they also run co-directionally (cos of the angle between tangents)
    parallel_min_frac: float = 0.5  # the suppressed strand must lie at least this fraction inside the other's corridor
    junction_probe_mm: float = 6.0  # arc length used to measure a take-off direction


@dataclass
class Chain:
    segs: list[int]
    parent: int
    children: list[int] = field(default_factory=list)
    pts: np.ndarray = field(default_factory=lambda: np.zeros((0, 3)))
    rad: np.ndarray = field(default_factory=lambda: np.zeros(0))
    length: float = 0.0
    sub_len: float = 0.0


def _polyline_length(p: np.ndarray) -> float:
    return float(np.linalg.norm(np.diff(p, axis=0), axis=1).sum()) if len(p) > 1 else 0.0


def build_chains(tree: Tree, kept: set[int]) -> list[Chain]:
    """Chains of the kept tree; chain 0 contains the root. A child chain always has a larger index than its parent."""

    def live(sid: int) -> list[int]:
        return [c for c in tree.segments[sid].children if c in kept]

    chains: list[Chain] = []
    stack = [(0, -1)]
    while stack:
        start, pc = stack.pop()
        segs = [start]
        while len(live(segs[-1])) == 1:
            segs.append(live(segs[-1])[0])
        idx = len(chains)
        pts = np.vstack([tree.segments[s].pts for s in segs])
        rad = np.concatenate([tree.segments[s].radius for s in segs])
        chains.append(Chain(segs=segs, parent=pc, pts=pts, rad=rad, length=_polyline_length(pts)))
        if pc >= 0:
            chains[pc].children.append(idx)
        for c in live(segs[-1]):
            stack.append((c, idx))
    for c in reversed(chains):
        c.sub_len = c.length + sum(chains[k].sub_len for k in c.children)
    return chains


def _remove_subtree(tree: Tree, kept: set[int], sid: int) -> int:
    n, stack = 0, [sid]
    while stack:
        s = stack.pop()
        if s in kept:
            kept.discard(s)
            n += 1
        stack.extend(tree.segments[s].children)
    return n


def _is_ancestor(chains: list[Chain], a: int, b: int) -> bool:
    while b >= 0:
        if b == a:
            return True
        b = chains[b].parent
    return False


def _walk_back(chains: list[Chain], ci: int, mm: float) -> np.ndarray:
    """Points of the trunk ending at the END of chain `ci`, last `mm` mm, in distal order."""
    out: list[np.ndarray] = []
    got = 0.0
    while ci >= 0 and got < mm:
        p = chains[ci].pts
        out.insert(0, p)
        got += chains[ci].length
        ci = chains[ci].parent
    pts = np.vstack(out)
    # trim to the last `mm` mm
    s = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(pts, axis=0), axis=1))])
    return pts[s >= s[-1] - mm]


def takeoff_angle_deg(chains: list[Chain], ci: int, probe_mm: float) -> float:
    """Angle between the parent trunk direction (last `probe_mm` before the junction) and the child's first `probe_mm`."""
    c = chains[ci]
    back = _walk_back(chains, c.parent, probe_mm)
    d_parent = back[-1] - back[0]
    s = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(c.pts, axis=0), axis=1))])
    k = int(np.searchsorted(s, probe_mm))
    k = min(max(k, 1), len(c.pts) - 1)
    d_child = c.pts[k] - back[-1]
    n1, n2 = np.linalg.norm(d_parent), np.linalg.norm(d_child)
    if n1 < 1e-6 or n2 < 1e-6:
        return 0.0
    return float(np.degrees(np.arccos(np.clip(np.dot(d_parent, d_child) / (n1 * n2), -1, 1))))


def resample_with_tangents(pts: np.ndarray, step: float = 1.0) -> tuple[np.ndarray, np.ndarray]:
    """Points every `step` mm along a polyline and the (smoothed) unit tangent at each, in the polyline's direction."""
    if len(pts) < 2:
        return pts.copy(), np.zeros_like(pts)
    s = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(pts, axis=0), axis=1))])
    if s[-1] < 1e-6:
        return pts[:1].copy(), np.zeros((1, 3))
    t = np.arange(0, s[-1] + 1e-9, step)
    p = np.stack([np.interp(t, s, pts[:, k]) for k in range(3)], axis=1)
    w = 3
    tan = np.zeros_like(p)
    for i in range(len(p)):
        d = p[min(i + w, len(p) - 1)] - p[max(i - w, 0)]
        n = np.linalg.norm(d)
        tan[i] = d / n if n > 1e-9 else 0.0
    return p, tan


def parallel_run_mm(pa: np.ndarray, ta: np.ndarray, pb: np.ndarray, tb: np.ndarray, dist_mm: float, min_dot: float) -> tuple[float, float]:
    """(longest contiguous run in mm, fraction of A's samples) where A lies within `dist_mm` of B and runs co-directionally."""
    if len(pa) == 0 or len(pb) == 0:
        return 0.0, 0.0
    d, j = cKDTree(pb).query(pa)
    close = (d < dist_mm) & (np.sum(ta * tb[j], axis=1) > min_dot)
    best = run = 0
    gap = 0
    for flag in close:
        if flag:
            run += 1 + gap
            gap = 0
            best = max(best, run)
        elif gap < 1 and run > 0:  # tolerate a one-sample dropout
            gap += 1
        else:
            run = gap = 0
    return float(best), float(close.mean())


def _strand_score(c: Chain, vess_at: np.ndarray | None) -> float:
    """Evidence that a chain is a real artery: calibre x vesselness / tortuosity (path length over end-to-end distance)."""
    chord = float(np.linalg.norm(c.pts[-1] - c.pts[0]))
    tort = max(1.0, c.length / chord) if chord > 1e-6 else 3.0
    v = 1.0 if vess_at is None or not len(vess_at) else float(np.mean(vess_at))
    return float(np.mean(c.rad)) * v / tort


def consolidate_tree(tree: Tree, kept: set[int], params: ConsolidationParams | None = None, vess: np.ndarray | None = None, grid: Grid | None = None, protect: set[int] | None = None) -> tuple[set[int], dict]:
    """Returns (kept segment ids, report). `protect` = segment ids (e.g. curated branch heads and tips) that are never removed,
    nor are their ancestors. `vess` (Frangi volume on `grid`) refines the strand comparison; without it caliber alone is used."""
    p = params or ConsolidationParams()
    kept = set(kept)
    rep: dict = {"before_kept": len(kept), "twig": 0, "side_branch": 0, "parallel": 0, "parallel_pairs": []}
    prot: set[int] = set()
    for s in protect or ():
        while s >= 0 and s not in prot:
            prot.add(s)
            s = tree.segments[s].parent

    def protected(chain: Chain) -> bool:
        return any(s in prot for s in chain.segs) or 0 in chain.segs

    def vess_of(c: Chain) -> np.ndarray | None:
        if vess is None or grid is None:
            return None
        idx = np.clip(np.round(grid.lps_to_zyx(c.pts)).astype(int), 0, np.array(vess.shape) - 1)
        return np.asarray(vess[tuple(idx.T)], dtype=float)

    def twig_pass() -> int:
        removed = 0
        changed = True
        while changed:
            changed = False
            chains = build_chains(tree, kept)
            for ci, c in enumerate(chains):
                if c.children or c.parent < 0 or c.length >= p.twig_mm or protected(c):
                    continue
                sibs = chains[c.parent].children
                if len(sibs) > 1 and all(not chains[k].children and chains[k].length < p.twig_mm for k in sibs):
                    # every branch at this junction is a stub: the longest one is the vessel's own tip, keep it
                    if ci == max(sibs, key=lambda k: chains[k].length) and c.length >= 8.0:
                        continue
                removed += _remove_subtree(tree, kept, c.segs[0])
                changed = True
                break
        return removed

    def side_pass() -> int:
        removed = 0
        changed = True
        while changed:
            changed = False
            chains = build_chains(tree, kept)
            for ci, c in enumerate(chains):
                if c.parent < 0:
                    continue
                sibs = chains[c.parent].children
                if len(sibs) < 2 or protected(c):
                    continue
                cont = max(sibs, key=lambda k: (chains[k].sub_len, chains[k].length))
                if ci == cont:
                    continue
                ang = takeoff_angle_deg(chains, ci, p.junction_probe_mm)
                if c.sub_len >= p.major_branch_mm:
                    continue
                if ang <= p.min_takeoff_deg or c.sub_len < p.min_branch_mm:
                    removed += _remove_subtree(tree, kept, c.segs[0])
                    changed = True
                    break
        return removed

    def parallel_pass() -> int:
        removed = 0
        for _ in range(12):
            chains = build_chains(tree, kept)
            samples = [resample_with_tangents(c.pts) for c in chains]
            scores = [_strand_score(c, vess_of(c)) for c in chains]
            cands = []
            for a in range(1, len(chains)):
                for b in range(len(chains)):
                    if a == b or _is_ancestor(chains, a, b) or _is_ancestor(chains, b, a):
                        continue
                    if min(chains[a].length, chains[b].length) < p.parallel_run_mm:
                        continue
                    run, frac = parallel_run_mm(samples[a][0], samples[a][1], samples[b][0], samples[b][1], p.parallel_mm, p.parallel_min_dot)
                    if run >= p.parallel_run_mm and frac >= p.parallel_min_frac:
                        cands.append((run, a, b))
            hit = None
            for run, a, b in sorted(cands, reverse=True):
                # A lies in B's corridor; B may lie in A's too. The weaker (lower calibre x vesselness / tortuosity) goes.
                back = parallel_run_mm(samples[b][0], samples[b][1], samples[a][0], samples[a][1], p.parallel_mm, p.parallel_min_dot)
                both = back[0] >= p.parallel_run_mm and back[1] >= p.parallel_min_frac
                loser = a
                if both and scores[b] < scores[a] and not protected(chains[b]):
                    loser = b
                elif protected(chains[a]):
                    if both and not protected(chains[b]):
                        loser = b
                    else:
                        continue
                winner = b if loser == a else a
                if scores[loser] > scores[winner] * 1.25 and not both:
                    continue  # the strand lying inside the other's corridor is clearly the stronger vessel: leave both
                hit = (loser, winner, run)
                break
            if hit is None:
                break
            loser, winner, run = hit
            rep["parallel_pairs"].append({"suppressed_len_mm": round(chains[loser].length, 1), "kept_len_mm": round(chains[winner].length, 1), "run_mm": round(run, 1), "score_suppressed": round(scores[loser], 3), "score_kept": round(scores[winner], 3)})
            removed += _remove_subtree(tree, kept, chains[loser].segs[0])
        return removed

    for _ in range(3):
        n = twig_pass()
        n_side = side_pass()
        n_par = parallel_pass()
        rep["twig"] += n
        rep["side_branch"] += n_side
        rep["parallel"] += n_par
        if n + n_side + n_par == 0:
            break
    rep["after_kept"] = len(kept)
    rep["chains"] = len(build_chains(tree, kept))
    return kept, rep
