"""Before/after numbers for the centerline consolidation (micro-twig, side-branch and parallel-strand rules).

    "D:/CT to map/.venv/Scripts/python.exe" scripts/consolidation_report.py 2022 2030 [--out build/consolidation_report.json]

Reads the cached coronary lumens (build/cohort/<id>/coronaries.npz, build/case_2002/ for the curated case), builds the
skeleton tree per coronary system, and compares:
  before = the old rule (terminal segments < 12 mm removed),
  after  = consolidate_tree (22 mm twigs, side branches >= 20 mm and > 25 deg, parallel strands within 5 mm over > 12 mm).
Reported per system: surviving segments, chains (stretches between real junctions), terminal tips, total centerline length,
and the number of chain pairs that still run co-directionally within 5 mm for more than 12 mm ("railroad" pairs).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cohort_lib import discovery  # noqa: E402
from cohort_lib.io_lps import load_case, make_roi_grid  # noqa: E402
from cohort_lib.skeleton import ConsolidationParams, _is_ancestor, build_chains, build_tree, consolidate_tree, parallel_run_mm, prune_twigs, resample_with_tangents  # noqa: E402


def stats(tree, kept) -> dict:
    chains = build_chains(tree, kept)
    samples = [resample_with_tangents(c.pts) for c in chains]
    p = ConsolidationParams()
    pairs = 0
    for a in range(len(chains)):
        for b in range(a + 1, len(chains)):
            if _is_ancestor(chains, a, b) or _is_ancestor(chains, b, a) or min(chains[a].length, chains[b].length) < p.parallel_run_mm:
                continue
            ra = parallel_run_mm(samples[a][0], samples[a][1], samples[b][0], samples[b][1], p.parallel_mm, p.parallel_min_dot)
            rb = parallel_run_mm(samples[b][0], samples[b][1], samples[a][0], samples[a][1], p.parallel_mm, p.parallel_min_dot)
            if (ra[0] >= p.parallel_run_mm and ra[1] >= 0.35) or (rb[0] >= p.parallel_run_mm and rb[1] >= 0.35):
                pairs += 1
    return {
        "segments": len(kept),
        "chains": len(chains),
        "tips": sum(1 for c in chains if not c.children),
        "centerline_mm": round(sum(c.length for c in chains)),
        "parallel_pairs": pairs,
    }


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("cases", nargs="+", type=int)
    ap.add_argument("--out", default="build/consolidation_report.json")
    a = ap.parse_args()
    report = {}
    for n in a.cases:
        cid = f"ct_test_{n}_image"
        wd = Path("build/case_2002") if n == 2002 else Path("build/cohort") / cid
        case = load_case(Path(discovery.CASES_ROOT) / cid, ct_path=Path(discovery.CASES_ROOT) / cid / f"{cid}.nii.gz", seg_dir=Path(discovery.RESULTS_ROOT) / cid / "segmentation")
        grid, _ = make_roi_grid(case)
        z = np.load(wd / "coronaries.npz")
        meta = json.loads((wd / "coronaries.json").read_text())
        vess = np.load(wd / "vesselness.npy", mmap_mode="r") if (wd / "vesselness.npy").exists() else None
        row = {}
        for system in ("LCA", "RCA"):
            tree = build_tree(z[system], np.array(meta["ostia_lps"][system]), grid)
            before = prune_twigs(tree, 12.0)
            after, rep = consolidate_tree(tree, {s.id for s in tree.segments}, ConsolidationParams(), vess=vess, grid=grid)
            row[system] = {"all_segments": len(tree.segments), "before": stats(tree, before), "after": stats(tree, after), "removed": {k: rep[k] for k in ("twig", "side_branch", "parallel")}}
            b, c = row[system]["before"], row[system]["after"]
            print(f"{n} {system}: segments {len(tree.segments)} -> before {b['segments']} / after {c['segments']} | tips {b['tips']} -> {c['tips']} | centerline {b['centerline_mm']} -> {c['centerline_mm']} mm | parallel pairs {b['parallel_pairs']} -> {c['parallel_pairs']} | removed {row[system]['removed']}")
        report[str(n)] = row
    Path(a.out).write_text(json.dumps(report, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
