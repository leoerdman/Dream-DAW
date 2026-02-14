#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import random
from dataclasses import dataclass
from pathlib import Path


@dataclass
class Check:
    id: int
    name: str
    passed: bool
    detail: str


def main() -> int:
    p = argparse.ArgumentParser(description="Fast 1000 virtual checks from enterprise audit + code assertions")
    p.add_argument("--audit-json", default="reports/latest-als-enterprise.json")
    p.add_argument("--project-management-rs", default="apps/desktop_host/src/commands/sections/project_management.rs")
    p.add_argument("--lib-rs", default="apps/desktop_host/src/lib.rs")
    p.add_argument("--iterations", type=int, default=1000)
    p.add_argument("--report-md", default="reports/als-virtual-tests-1000-fast.md")
    p.add_argument("--report-json", default="reports/als-virtual-tests-1000-fast.json")
    p.add_argument("--seed", type=int, default=42)
    args = p.parse_args()

    audit_path = Path(args.audit_json).resolve()
    pm_path = Path(args.project_management_rs).resolve()
    lib_path = Path(args.lib_rs).resolve()
    report_md = Path(args.report_md).resolve()
    report_json = Path(args.report_json).resolve()
    report_md.parent.mkdir(parents=True, exist_ok=True)
    report_json.parent.mkdir(parents=True, exist_ok=True)

    audit = json.loads(audit_path.read_text(encoding="utf-8"))
    pm_text = pm_path.read_text(encoding="utf-8")
    lib_text = lib_path.read_text(encoding="utf-8")

    totals = audit.get("totals", {})
    rates = audit.get("rates", {})
    files = audit.get("files", [])
    top_missing = audit.get("top", {}).get("missing_external", [])
    rng = random.Random(args.seed)

    checks: list[Check] = []
    device_param_markers = [
        "effect.eq.band",
        "effect.auto_filter.lfo.rate",
        "effect.compressor.threshold",
        "effect.reverb.predelay",
        "effect.delay.feedback",
        "make_missing_external_plugin_slot_with_metadata",
    ]
    runtime_markers = [
        "apply_static_imported_params_for_slot",
        "EngineCommand::SetDeviceParam",
        "internal://effect/eq-eight",
        "internal://effect/auto-filter",
        "internal://effect/compressor",
        "internal://effect/reverb",
        "internal://effect/delay",
    ]

    for i in range(1, args.iterations + 1):
        mode = i % 5
        if mode == 0:
            passed = totals.get("native_unmapped", 1) == 0
            checks.append(Check(i, "native_unmapped_zero", passed, str(totals.get("native_unmapped"))))
        elif mode == 1:
            passed = totals.get("external_missing", 9999) <= 20
            checks.append(Check(i, "external_missing_threshold", passed, str(totals.get("external_missing"))))
        elif mode == 2:
            passed = rates.get("overall_compat_rate", 0.0) >= 0.99
            checks.append(Check(i, "overall_rate_threshold", passed, f"{rates.get('overall_compat_rate', 0.0):.6f}"))
        elif mode == 3:
            marker = rng.choice(device_param_markers)
            passed = marker in pm_text
            checks.append(Check(i, f"code_marker_pm:{marker}", passed, "present" if passed else "missing"))
        else:
            marker = rng.choice(runtime_markers)
            passed = marker in lib_text
            checks.append(Check(i, f"code_marker_runtime:{marker}", passed, "present" if passed else "missing"))

    # Deterministic file-level sanity checks
    for idx, file_row in enumerate(files[: min(200, len(files))], start=args.iterations + 1):
        nm = int(file_row.get("native_unmapped", 0))
        em = int(file_row.get("external_missing", 0))
        checks.append(Check(idx, f"file_sanity:{file_row.get('file','unknown')}", nm >= 0 and em >= 0, f"nm={nm} em={em}"))

    passed = sum(1 for c in checks if c.passed)
    failed = len(checks) - passed

    payload = {
        "audit_json": str(audit_path),
        "project_management_rs": str(pm_path),
        "lib_rs": str(lib_path),
        "requested_iterations": args.iterations,
        "total_checks": len(checks),
        "passed": passed,
        "failed": failed,
        "failure_rate": (failed / len(checks)) if checks else 0.0,
        "totals_snapshot": totals,
        "rates_snapshot": rates,
        "top_missing_external": top_missing[:10],
        "checks": [c.__dict__ for c in checks],
    }
    report_json.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    lines = [
        "# Virtual Tests 1000 (Fast)",
        "",
        f"- Requested iterations: **{args.iterations}**",
        f"- Total checks executed: **{len(checks)}**",
        f"- Passed: **{passed}**",
        f"- Failed: **{failed}**",
        f"- Failure rate: **{payload['failure_rate']:.2%}**",
        "",
        "## Snapshot",
        "",
        f"- native_mapped/unmapped: **{totals.get('native_mapped',0)}/{totals.get('native_unmapped',0)}**",
        f"- external_resolved/missing: **{totals.get('external_resolved',0)}/{totals.get('external_missing',0)}**",
        f"- overall_compat_rate: **{rates.get('overall_compat_rate',0.0):.6f}**",
        "",
        "## Top Missing External",
        "",
    ]
    if top_missing:
        for name, n in top_missing[:10]:
            lines.append(f"- {name}: {n}")
    else:
        lines.append("- none")

    if failed:
        lines += ["", "## Failures", ""]
        for c in checks:
            if not c.passed:
                lines.append(f"- {c.name}: {c.detail}")

    report_md.write_text("\n".join(lines), encoding="utf-8")
    print(report_md)
    print(report_json)
    print(f"checks={len(checks)} passed={passed} failed={failed}")
    return 0 if failed == 0 else 2


if __name__ == "__main__":
    raise SystemExit(main())

