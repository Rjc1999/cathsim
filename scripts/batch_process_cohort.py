"""Cohort batch tool for CathSim: discover and screen cases, process a selection, write the library manifest.

    PY="D:/CT to map/.venv/Scripts/python.exe"
    $PY scripts/batch_process_cohort.py discover                          # screen all cases -> build/cohort/discovery.{json,md}
    $PY scripts/batch_process_cohort.py pool --n 14                        # print the extractability-ranked candidate pool
    $PY scripts/batch_process_cohort.py process --pool 14 [--jobs 2]       # run the pipeline per case -> public/models/case_NNNN.*
    $PY scripts/batch_process_cohort.py process --cases 2003 2010 --force [--reuse-lumen]
    $PY scripts/batch_process_cohort.py manifest [--max-cases 10]          # quality-gate + public/models/cases_manifest.json

Per case, logs and a result.json go to build/cohort/<case_id>/ (run.log, result.json). One failing case never stops the batch.
Automatic branch naming is provisional (not clinically reviewed); the manifest says so.
"""
from __future__ import annotations

import argparse
import gc
import json
import sys
import time
import traceback
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

BUILD = Path("build/cohort")
MODELS = Path("public/models")
CURATED = {"ct_test_2002_image": ("case_2002", Path("build/case_2002/result.json"))}


def out_name(case_id: str) -> str:
    return "case_" + case_id.split("_")[2]


# ------------------------------------------------------------------------------------------------ discover
def cmd_discover(args) -> None:
    from cohort_lib import discovery

    sys.stdout.reconfigure(encoding="utf-8")
    BUILD.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    ids = [f"ct_test_{n}_image" for n in args.cases] if args.cases else None
    reports = []
    all_ids = ids or sorted(p.name for p in discovery.CASES_ROOT.iterdir() if p.is_dir() and p.name.startswith("ct_test_"))
    print(f"discovery: {len(all_ids)} candidate folders in {discovery.CASES_ROOT}")
    for i, cid in enumerate(all_ids, 1):
        t = time.time()
        try:
            r = discovery.screen_case(cid)
        except Exception as e:  # keep scanning: one broken case must not stop the survey
            r = discovery.CaseReport(case_id=cid, blockers=[f"screening error: {type(e).__name__}: {e}"])
        reports.append(r)
        status = "BLOCKED" if r.blockers else f"score {r.score:5.1f}"
        print(f"[{i:2d}/{len(all_ids)}] {cid} {status:>12s}  {time.time() - t:4.1f}s  " + ("; ".join(r.blockers + r.flags)[:150] if (r.blockers or r.flags) else ""), flush=True)
    (BUILD / "discovery.json").write_text(discovery.to_json(reports), encoding="utf-8")
    usable = [r for r in reports if r.usable]
    lines = [
        "# Cohort discovery and screening",
        "",
        f"{len(reports)} candidate folders, {len(usable)} pass the objective screen, {len(reports) - len(usable)} blocked. "
        f"`QC_REJECTED` present on {sum(r.qc_rejected_marker for r in reports)} cases (it is an 'unattended run, not reviewed' marker, so it is a flag, not a filter). "
        f"Existing coronary masks: {sum(bool(r.coronary_masks) for r in reports)}.",
        "",
        "| case | score | CT shape | spacing (mm) | axes | aorta HU | LV mL | LA mL | blockers / flags |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    for r in sorted(reports, key=lambda r: (-r.usable, -r.score)):
        lines.append(
            f"| {r.case_id} | {r.score:.0f} | {r.ct_shape} | {r.ct_spacing} | {r.ct_axes} | {r.hu_in_masks.get('aorta', '')} | {r.volumes_ml.get('heart_ventricle_left', '')} | {r.volumes_ml.get('heart_atrium_left', '')} | "
            + ("**BLOCKED:** " + "; ".join(r.blockers) + ". " if r.blockers else "")
            + "; ".join(f for f in r.flags if "QC_REJECTED" not in f)
            + " |"
        )
    (BUILD / "discovery.md").write_text("\n".join(lines), encoding="utf-8")
    print(f"\nwrote {BUILD / 'discovery.json'} and discovery.md  ({time.time() - t0:.0f} s)")


# ------------------------------------------------------------------------------------------------ pool
def extractability(r: dict) -> float:
    """Rank by how well a coronary tree can be extracted: aortic contrast, in-plane resolution, slice thickness."""
    hu = min(r["hu_in_masks"].get("aorta", 0), 550) / 550 * 40
    inplane = max(r["ct_spacing"][:2])
    res = max(0.0, min(1.0, (0.6 - inplane) / 0.3)) * 40
    sl = 20 if r["ct_spacing"][2] <= 0.5 else 15
    pen = -10 if r["hu_in_masks"].get("heart_myocardium", 0) > 0.6 * r["hu_in_masks"].get("aorta", 1) else 0
    return round(hu + res + sl + pen, 1)


def candidate_pool(n: int, ras_cases: int = 1) -> list[dict]:
    disc = json.loads((BUILD / "discovery.json").read_text(encoding="utf-8"))
    ok = [r for r in disc if not r["blockers"] and r["case_id"] not in CURATED and (r["summary_status"] in ("ok", None)) and r["hu_in_masks"].get("aorta", 0) >= 350]
    for r in ok:
        r["extract_score"] = extractability(r)
    ok.sort(key=lambda r: -r["extract_score"])
    pool = ok[:n]
    # keep a right-handed-affine (RAS) case in the pool on purpose: it exercises the frame handling
    need = ras_cases - sum(r["ct_axes"] == "RAS" for r in pool)
    if need > 0:
        extra = [r for r in ok[n:] if r["ct_axes"] == "RAS"][:need]
        pool = pool[: n - len(extra)] + extra
    return pool


def cmd_pool(args) -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    for i, r in enumerate(candidate_pool(args.n), 1):
        print(f"{i:2d}. {r['case_id']}  extract {r['extract_score']:5.1f}  {r['ct_axes']}  inplane {max(r['ct_spacing'][:2]):.3f}  aorta {r['hu_in_masks']['aorta']:.0f} HU")


# ------------------------------------------------------------------------------------------------ process
def _process_one(case_id: str, force: bool, compress: bool, reuse_lumen: bool = False) -> dict:
    """Run one case; log to build/cohort/<id>/run.log. Never raises."""
    from cohort_lib import discovery
    from cohort_lib.pipeline import run_case

    sys.stdout.reconfigure(encoding="utf-8")  # worker processes do not inherit the reconfigured console encoding
    wd = BUILD / case_id
    wd.mkdir(parents=True, exist_ok=True)
    res_path = wd / "result.json"
    name = out_name(case_id)
    if not force and res_path.exists():
        prev = json.loads(res_path.read_text(encoding="utf-8"))
        if prev.get("status") in ("ok", "skipped") and (prev["status"] == "skipped" or (MODELS / f"{name}.glb").exists()):
            return {**prev, "cached": True}
    logf = open(wd / "run.log", "w", encoding="utf-8")

    def log(msg: str) -> None:
        line = f"{time.strftime('%H:%M:%S')} [{case_id[8:12]}] {msg}"
        print(line, flush=True)
        logf.write(line + "\n")
        logf.flush()

    t0 = time.time()
    log(f"=== {case_id} -> {name} ===")
    try:
        res = run_case(
            case_id=case_id,
            ct_path=Path(discovery.CASES_ROOT) / case_id / f"{case_id}.nii.gz",
            seg_dir=Path(discovery.RESULTS_ROOT) / case_id / "segmentation",
            out_name=name,
            out_dir=MODELS,
            workdir=wd,
            cfg=None,
            compress=compress,
            reuse_coronaries=reuse_lumen,
            log=log,
        )
    except RuntimeError as e:  # the extraction found no usable coronary structure (no ostia, empty tree): a skip, with its reason
        res = {"case_id": case_id, "name": name, "status": "skipped", "reason": f"coronary extraction failed: {e}"}
        log(f"SKIPPED: {res['reason']}")
    except Exception as e:  # a failure in one case must not stop the batch
        res = {"case_id": case_id, "name": name, "status": "error", "reason": f"{type(e).__name__}: {e}", "trace": traceback.format_exc()[-1500:]}
        log(f"ERROR {res['reason']}")
    res["total_s"] = round(time.time() - t0, 1)
    log(f"=== {case_id}: {res['status']} in {res['total_s']:.0f} s " + (f"| {res.get('coronary_tris', '?')} coronary tris, {res.get('envelope_tris', '?')} envelope tris, GLB {res.get('glb_kb', '?')} KB" if res["status"] == "ok" else f"| {res.get('reason', '')}"))
    res_path.write_text(json.dumps(res, indent=1, default=float), encoding="utf-8")
    logf.close()
    gc.collect()
    return res


def cmd_process(args) -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    if args.cases:
        ids = [f"ct_test_{n}_image" for n in args.cases]
    else:
        ids = [r["case_id"] for r in candidate_pool(args.pool)]
    print(f"batch: {len(ids)} cases: {', '.join(i[8:12] for i in ids)}  (jobs={args.jobs})", flush=True)
    t0 = time.time()
    results = []
    if args.jobs <= 1:
        for i, cid in enumerate(ids, 1):
            print(f"\n##### case {i}/{len(ids)} #####", flush=True)
            results.append(_process_one(cid, args.force, not args.no_compress, args.reuse_lumen))
    else:
        with ProcessPoolExecutor(max_workers=args.jobs) as ex:
            futs = {ex.submit(_process_one, cid, args.force, not args.no_compress, args.reuse_lumen): cid for cid in ids}
            for fut in as_completed(futs):
                results.append(fut.result())
    print("\n===== batch summary =====")
    for r in sorted(results, key=lambda r: r["case_id"]):
        extra = f"{r.get('coronary_tris', '-')} cor tris, {r.get('envelope_tris', '-')} env tris, {r.get('glb_kb', '-')} KB" if r["status"] == "ok" else r.get("reason", "")
        print(f"  {r['case_id']}: {r['status']:8s} {'(cached) ' if r.get('cached') else ''}{r.get('total_s', ''):>6} s  {extra}")
    print(f"total {time.time() - t0:.0f} s")


# ------------------------------------------------------------------------------------------------ manifest
def gate(r: dict) -> list[str]:
    """Objective post-extraction anatomy gate. Returns the list of failed checks (empty = pass)."""
    fails = []
    bq = r.get("branch_quality", {})
    lad, lcx, rca = bq.get("LAD"), bq.get("LCx"), bq.get("RCA")
    if r.get("status") != "ok":
        return [r.get("reason", "processing failed")]
    if not lad or lad["within6_pct"] < 60:
        fails.append(f"LAD off the anterior interventricular groove ({lad['within6_pct'] if lad else 0:.0f}% within 6 mm)")
    if lad and lad.get("tip_to_apex_mm", 99) > 60:
        fails.append(f"LAD tip {lad['tip_to_apex_mm']:.0f} mm from the apex")
    # the LCx must lie on the left AV groove for at least 25 mm (enforced when naming); its distal part may leave the groove
    # (OM / posterolateral continuation), so the share of the path inside the groove is a note, not a gate
    if not lcx or lcx["median_mm"] > 12:
        fails.append(f"LCx median {lcx['median_mm'] if lcx else 99:.0f} mm from the left AV groove")
    if not rca or rca["length_mm"] < 50:
        fails.append("RCA missing or shorter than 50 mm")
    if r.get("coronary_tris", 0) < 15000:
        fails.append(f"only {r.get('coronary_tris', 0)} coronary triangles")
    if r.get("envelope_tris", 0) < 8000:
        fails.append("envelope too coarse")
    return fails


def limitations(r: dict) -> list[str]:
    """Plain-language caveats from the measured quality numbers (shown with the case in the manifest)."""
    out = []
    bq = r.get("branch_quality", {})
    lad, lcx = bq.get("LAD"), bq.get("LCx")
    if lad and lad.get("tip_to_apex_mm", 0) > 30:
        out.append(f"LAD traced to {lad['tip_to_apex_mm']:.0f} mm from the apex (distal LAD not followed)")
    if lcx and lcx["within6_pct"] < 50:
        out.append("LCx distal part leaves the left AV groove")
    tree = r.get("centerline_mm", {})
    if tree.get("LCA", 0) > 700 or tree.get("RCA", 0) > 600:
        out.append(f"tree still bushy after consolidation (LCA {tree.get('LCA', 0):.0f} mm, RCA {tree.get('RCA', 0):.0f} mm of centerline)")
    return out


def variant_note(v: dict, branches: list[str]) -> str:
    dom = v.get("dominance", "undetermined")
    parts = {"right": "right dominant (est.)", "left": "left dominant (est.)", "balanced": "balanced (est.)"}.get(dom, "dominance undetermined")
    extras = []
    if v.get("ramus_like"):
        extras.append("ramus-like intermediate branch")
    if v.get("lm_length_mm") is not None and v["lm_length_mm"] < 5:
        extras.append("short left main")
    return parts + (", " + ", ".join(extras) if extras else "")


def cmd_manifest(args) -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    disc = {r["case_id"]: r for r in json.loads((BUILD / "discovery.json").read_text(encoding="utf-8"))}
    rows = []
    for cid, (name, path) in CURATED.items():
        if path.exists():
            r = json.loads(path.read_text(encoding="utf-8"))
            r["curated"] = True
            rows.append(r)
    for p in sorted(BUILD.glob("ct_test_*/result.json")):
        r = json.loads(p.read_text(encoding="utf-8"))
        r["curated"] = False
        rows.append(r)
    log_rows, ok = [], []
    for r in rows:
        r["gate_fails"] = [] if r.get("curated") else gate(r)
        r["extract_score"] = None if r.get("curated") else disc.get(r["case_id"], {}).get("extract_score") or (extractability(disc[r["case_id"]]) if r["case_id"] in disc else None)
        r["limitations"] = [] if r.get("curated") else limitations(r)
        (ok if not r["gate_fails"] else log_rows).append(r)
    # choose: case_2002 first; then by extractability, but make sure each dominance class present is represented
    new = sorted([r for r in ok if not r.get("curated")], key=lambda r: (len(r["limitations"]), -(r["extract_score"] or 0)))
    chosen: list[dict] = [r for r in ok if r.get("curated")]
    budget = args.max_cases - len(chosen)
    seen_dom = {r["variants"].get("dominance") for r in chosen}
    for r in new:
        if len(chosen) - len([c for c in chosen if c.get("curated")]) >= budget:
            break
        d = r["variants"].get("dominance")
        if d not in seen_dom:
            chosen.append(r)
            seen_dom.add(d)
    for r in new:
        if r in chosen:
            continue
        if len(chosen) - 1 >= budget:
            break
        chosen.append(r)
    chosen.sort(key=lambda r: (not r.get("curated"), r["case_id"]))
    cases = []
    for i, r in enumerate(chosen, 1):
        name = r["name"]
        idx = json.loads((MODELS / f"{name}.index.json").read_text(encoding="utf-8"))
        note = variant_note(r["variants"], r["branches"])
        cases.append(
            {
                "id": name,
                "number": i,
                "displayName": f"Patient {i}",
                "label": f"Patient {i} - {note[0].upper() + note[1:]}",
                "variantNote": note,
                "variants": r["variants"],
                "limitations": r["limitations"],
                "sourceCase": r["case_id"],
                "glb": f"/models/{name}.glb",
                "index": f"/models/{name}.index.json",
                "isocenterCtLpsMm": r["isocenter_ct_lps_mm"],
                "landmarkBoundsMm": {"envelope": r["envelope_bounds_mm"], "diaphragmApex": idx["landmarks"]["diaphragm_apex"], "spineDetected": r["spine_detected"]},
                "branches": r["branches"],
                "triangles": {"coronary": r["coronary_tris"], "envelope": r["envelope_tris"]},
                "sizeKb": {"glb": r["glb_kb"], "index": r["index_kb"]},
                "branchQuality": r["branch_quality"],
                "labeling": "curated" if r.get("curated") else "automatic",
                "sourceFrame": r["source"],
                "provisional": True,
            }
        )
    manifest = {
        "version": 1,
        "generated": time.strftime("%Y-%m-%d"),
        "note": "Educational library derived from CT cases; branch labels are provisional and not clinically reviewed. Frame: LPS mm, isocenter (0,0,0) = cardiac chamber volume centroid.",
        "default": cases[0]["id"],
        "cases": cases,
    }
    MODELS.mkdir(parents=True, exist_ok=True)
    (MODELS / "cases_manifest.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    print(f"manifest: {len(cases)} cases -> {MODELS / 'cases_manifest.json'}")
    for c in cases:
        print(f"  {c['displayName']:11s} {c['id']}  {c['variantNote']:40s}  {c['triangles']}  {c['sizeKb']['glb']} KB")
    chosen_ids = {c["sourceCase"] for c in cases}
    rest = [r for r in rows if r["case_id"] not in chosen_ids]
    # drop public/models files of processed-but-unselected cases so the app only ships the library
    for r in rest:
        for ext in (".glb", ".index.json"):
            f = MODELS / f"{r['name']}{ext}"
            if f.exists() and not args.keep_unselected:
                f.unlink()
    print("not in library:")
    for r in rest:
        why = "; ".join(r["gate_fails"]) if r["gate_fails"] else "beyond the library size limit"
        print(f"  {r['case_id']}: {r['status']} - {why}")
    (BUILD / "manifest_summary.json").write_text(json.dumps({"selected": [c["id"] for c in cases], "not_selected": [{"case": r["case_id"], "status": r["status"], "why": r["gate_fails"] or ["beyond the library size limit"], "variants": r.get("variants"), "branch_quality": r.get("branch_quality")} for r in rest]}, indent=1), encoding="utf-8")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("discover", help="scan and screen candidate cases")
    d.add_argument("--cases", nargs="*", type=int, help="case numbers (e.g. 2003 2010); default all")
    d.set_defaults(fn=cmd_discover)
    p = sub.add_parser("pool", help="print the extractability-ranked candidate pool")
    p.add_argument("--n", type=int, default=14)
    p.set_defaults(fn=cmd_pool)
    q = sub.add_parser("process", help="run the pipeline on a pool or explicit cases")
    q.add_argument("--pool", type=int, default=14, help="size of the ranked pool when --cases is not given")
    q.add_argument("--cases", nargs="*", type=int)
    q.add_argument("--jobs", type=int, default=1)
    q.add_argument("--force", action="store_true", help="re-run even if a result.json exists")
    q.add_argument("--no-compress", action="store_true")
    q.add_argument("--reuse-lumen", action="store_true", help="reuse the cached coronary lumen (skips stage 2; for changes to the tree/label/mesh stages)")
    q.set_defaults(fn=cmd_process)
    m = sub.add_parser("manifest", help="gate results and write public/models/cases_manifest.json")
    m.add_argument("--max-cases", type=int, default=10, help="library size including case_2002")
    m.add_argument("--keep-unselected", action="store_true", help="do not delete GLB/index of processed but unselected cases")
    m.set_defaults(fn=cmd_manifest)
    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
