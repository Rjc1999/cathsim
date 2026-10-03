"""Process the hand-curated case_2002 (thin wrapper around cohort_lib.pipeline.run_case; the stages are documented there).

    "D:/CT to map/.venv/Scripts/python.exe" scripts/process_cohort_case.py ct_test_2002_image \
        --config scripts/cohort_configs/case_2002.json --out public/models --name case_2002

Stages: 1 load (CT + chamber masks onto one 0.5 mm patient-LPS grid, via physical space); 2 coronary lumen from the contrast CT
(no coronary mask exists); 3 centerline trees, twig pruning, branch naming (curated config here, automatic in the batch tool);
4 coronary meshes (centerline tubes with measured calibre, Taubin, decimation, per-vertex radius/axis/label); 5 closed SOLID
cardiac silhouette + CT-derived spine/diaphragm; 6 isocenter normalisation and GLB + index.json export (+ meshopt).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from cohort_lib.pipeline import run_case  # noqa: E402


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("case_dir")
    ap.add_argument("--config", default="scripts/cohort_configs/case_2002.json")
    ap.add_argument("--out", default="public/models")
    ap.add_argument("--name", default="case_2002")
    ap.add_argument("--workdir", default=None)
    ap.add_argument("--spacing", type=float, default=0.5)
    ap.add_argument("--pin-anchors", action="store_true")
    ap.add_argument("--no-compress", action="store_true")
    ap.add_argument("--reuse-coronaries", action="store_true")
    a = ap.parse_args()
    case_dir = Path(a.case_dir)
    cfg_path = Path(a.config)
    res = run_case(
        case_id=case_dir.name,
        ct_path=next(case_dir.glob("*.nii.gz")),
        seg_dir=case_dir / "segmentation",
        out_name=a.name,
        out_dir=Path(a.out),
        workdir=Path(a.workdir or f"build/{a.name}"),
        cfg=json.loads(cfg_path.read_text(encoding="utf-8")),
        reuse_coronaries=a.reuse_coronaries,
        compress=not a.no_compress,
        spacing=a.spacing,
        pin_anchors_to=cfg_path if a.pin_anchors else None,
    )
    wd = Path(a.workdir or f"build/{a.name}")
    (wd / "result.json").write_text(json.dumps(res, indent=1, default=float), encoding="utf-8")
    print(json.dumps({k: res[k] for k in ("status", "glb_kb", "coronary_tris", "envelope_tris", "branch_quality", "variants") if k in res}, indent=1))


if __name__ == "__main__":
    main()
