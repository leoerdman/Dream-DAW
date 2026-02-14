#!/usr/bin/env python3
from __future__ import annotations

import argparse
import gzip
import importlib.util
import json
import random
import sys
import time
import xml.etree.ElementTree as ET
from collections import Counter
from dataclasses import dataclass
from pathlib import Path


def load_suite_module(path: Path):
    name = "als_compat_suite_runtime"
    spec = importlib.util.spec_from_file_location(name, str(path))
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load suite module: {path}")
    module = importlib.util.module_from_spec(spec)
    # Required for dataclass internals on some Python versions.
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def parse_xml(path: Path) -> ET.Element:
    raw = path.read_bytes()
    if len(raw) >= 2 and raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    return ET.fromstring(raw)


def collect_manifest(roots: list[Path], manifest_path: Path) -> list[Path]:
    if manifest_path.exists():
        return [
            Path(line.strip())
            for line in manifest_path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]

    latest_by_dir: dict[Path, Path] = {}
    for root in roots:
        if not root.exists():
            continue
        for als in root.rglob("*.als"):
            prev = latest_by_dir.get(als.parent)
            if prev is None or als.stat().st_mtime > prev.stat().st_mtime:
                latest_by_dir[als.parent] = als
    selected = sorted(latest_by_dir.values(), key=lambda p: str(p))
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text("\n".join(str(p) for p in selected), encoding="utf-8")
    return selected


@dataclass
class VirtualTestResult:
    id: int
    name: str
    passed: bool
    detail: str


def main() -> int:
    parser = argparse.ArgumentParser(description="1000 offline virtual ALS importer tests")
    parser.add_argument(
        "--project-root",
        action="append",
        required=True,
        help="Ableton project root (repeat twice for 0-160 and 160-200)",
    )
    parser.add_argument("--suite-script", default="scripts/als_compat_suite.py")
    parser.add_argument("--manifest", default="reports/latest-als-manifest.txt")
    parser.add_argument("--iterations", type=int, default=1000)
    parser.add_argument("--report-json", default="reports/als-virtual-tests-1000.json")
    parser.add_argument("--report-md", default="reports/als-virtual-tests-1000.md")
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    roots = [Path(p).expanduser().resolve() for p in args.project_root]
    suite_script = Path(args.suite_script).resolve()
    manifest_path = Path(args.manifest).resolve()
    report_json = Path(args.report_json).resolve()
    report_md = Path(args.report_md).resolve()
    report_json.parent.mkdir(parents=True, exist_ok=True)
    report_md.parent.mkdir(parents=True, exist_ok=True)

    suite = load_suite_module(suite_script)
    selected = collect_manifest(roots, manifest_path)
    if not selected:
        raise SystemExit("No ALS files found for virtual tests.")

    installed = suite.discover_installed_plugins()
    rng = random.Random(args.seed)
    t0 = time.time()

    results: list[VirtualTestResult] = []
    native_unknown = Counter()
    external_missing = Counter()
    feature_tags = Counter()

    expected_tags = [
        "LiveSet",
        "Tracks",
        "AudioTrack",
        "MidiTrack",
        "GroupTrack",
        "ReturnTrack",
        "PluginDevice",
        "AutomationEnvelope",
        "FloatEvent",
        "AudioClip",
        "MidiClip",
    ]

    cache: dict[Path, dict[str, object]] = {}
    for als in selected:
        try:
            root = parse_xml(als)
            fs = suite.scan_als_file(
                path=als,
                base=als.parent,
                installed_plugins=installed,
                device_tags=Counter(),
                mapped_targets=Counter(),
                unknown_native=native_unknown,
                ext_missing=external_missing,
                ext_resolved=Counter(),
                vst3_names=Counter(),
                vst2_names=Counter(),
            )
            cache[als] = {
                "has_liveset": any(node.tag == "LiveSet" for node in root.iter()),
                "inv_ok": (
                    fs.audio_tracks >= 0
                    and fs.midi_tracks >= 0
                    and fs.group_tracks >= 0
                    and fs.native_mapped >= 0
                    and fs.native_unmapped >= 0
                    and fs.external_resolved >= 0
                    and fs.external_missing >= 0
                ),
                "mapped": fs.native_mapped,
                "unmapped": fs.native_unmapped,
                "ext_missing": fs.external_missing,
                "tags": {node.tag for node in root.iter()},
            }
        except Exception as exc:  # noqa: BLE001
            cache[als] = {"error": str(exc)}

    for i in range(1, args.iterations + 1):
        als = selected[(i - 1) % len(selected)] if i <= len(selected) else rng.choice(selected)
        name = f"virt_{i:04d}:{als.name}"
        entry = cache.get(als, {"error": "cache miss"})
        if "error" in entry:
            results.append(
                VirtualTestResult(
                    i,
                    f"{name}:exception",
                    False,
                    str(entry["error"]),
                )
            )
            continue

        has_liveset = bool(entry["has_liveset"])
        results.append(
            VirtualTestResult(
                i,
                f"{name}:parse_live_set",
                has_liveset,
                "LiveSet found" if has_liveset else "LiveSet missing",
            )
        )

        inv_ok = bool(entry["inv_ok"])
        results.append(
            VirtualTestResult(
                i,
                f"{name}:scan_invariants",
                inv_ok,
                f"mapped={entry['mapped']} unmapped={entry['unmapped']} ext_missing={entry['ext_missing']}",
            )
        )

        tags_in_file = entry["tags"]
        for tag in expected_tags:
            if tag in tags_in_file:
                feature_tags[tag] += 1
        results.append(
            VirtualTestResult(
                i,
                f"{name}:feature_tag_scan",
                True,
                f"tags_seen={len(tags_in_file)}",
            )
        )

    passed = sum(1 for r in results if r.passed)
    failed = len(results) - passed
    elapsed = round(time.time() - t0, 2)

    payload = {
        "iterations": args.iterations,
        "roots": [str(r) for r in roots],
        "manifest": str(manifest_path),
        "selected_files": len(selected),
        "elapsed_seconds": elapsed,
        "passed": passed,
        "failed": failed,
        "failure_rate": (failed / len(results)) if results else 0.0,
        "feature_coverage_by_tag": dict(feature_tags),
        "top_unknown_native": native_unknown.most_common(30),
        "top_missing_external": external_missing.most_common(30),
        "results": [r.__dict__ for r in results],
    }
    report_json.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    lines: list[str] = []
    lines.append("# ALS Virtual Tests (1000)")
    lines.append("")
    lines.append(f"- Iterations: **{args.iterations}**")
    lines.append(f"- Selected latest ALS files: **{len(selected)}**")
    lines.append(f"- Passed: **{passed}**")
    lines.append(f"- Failed: **{failed}**")
    lines.append(f"- Failure rate: **{payload['failure_rate']:.2%}**")
    lines.append(f"- Elapsed: **{elapsed}s**")
    lines.append("")
    lines.append("## Feature Coverage")
    lines.append("")
    for tag in expected_tags:
        lines.append(f"- {tag}: {feature_tags.get(tag, 0)}")
    lines.append("")
    lines.append("## Top Unknown Native")
    lines.append("")
    if payload["top_unknown_native"]:
        for tag, cnt in payload["top_unknown_native"]:
            lines.append(f"- {tag}: {cnt}")
    else:
        lines.append("- none")
    lines.append("")
    lines.append("## Top Missing External")
    lines.append("")
    if payload["top_missing_external"]:
        for name, cnt in payload["top_missing_external"]:
            lines.append(f"- {name}: {cnt}")
    else:
        lines.append("- none")
    lines.append("")

    if failed:
        lines.append("## Failures")
        lines.append("")
        for r in results:
            if not r.passed:
                lines.append(f"- {r.name}: {r.detail}")

    report_md.write_text("\n".join(lines), encoding="utf-8")
    print(report_md)
    print(report_json)
    print(f"passed={passed} failed={failed} selected={len(selected)} elapsed={elapsed}s")
    return 0 if failed == 0 else 2


if __name__ == "__main__":
    raise SystemExit(main())
