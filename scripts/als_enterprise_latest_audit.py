#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import subprocess
import sys
from pathlib import Path


def select_latest_als_per_project(roots: list[Path]) -> list[Path]:
    latest_by_dir: dict[Path, Path] = {}
    for root in roots:
        if not root.exists():
            continue
        for als in root.rglob("*.als"):
            project_dir = als.parent
            prev = latest_by_dir.get(project_dir)
            if prev is None or als.stat().st_mtime > prev.stat().st_mtime:
                latest_by_dir[project_dir] = als
    return sorted(latest_by_dir.values(), key=lambda p: str(p))


def write_manifest(paths: list[Path], manifest_path: Path) -> None:
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text("\n".join(str(p) for p in paths), encoding="utf-8")


def build_symlink_set(paths: list[Path], target_dir: Path) -> int:
    if target_dir.exists():
        shutil.rmtree(target_dir)
    target_dir.mkdir(parents=True, exist_ok=True)
    created = 0
    for src in paths:
        if not src.exists():
            continue
        digest = hashlib.md5(str(src).encode("utf-8")).hexdigest()[:8]
        dst = target_dir / f"{src.stem}__{digest}.als"
        os.symlink(src, dst)
        created += 1
    return created


def run_suite(
    suite_script: Path,
    als_root: Path,
    user_folder: Path,
    report_md: Path,
    report_json: Path,
) -> int:
    cmd = [
        sys.executable,
        str(suite_script),
        "--als-root",
        str(als_root),
        "--user-folder",
        str(user_folder),
        "--report-md",
        str(report_md),
        "--report-json",
        str(report_json),
        "--skip-user-scan",
        "--strict",
    ]
    return subprocess.call(cmd)


def main() -> int:
    parser = argparse.ArgumentParser(description="Enterprise latest ALS audit across multiple project roots")
    parser.add_argument(
        "--project-root",
        action="append",
        required=True,
        help="Ableton project root (repeat for multiple roots)",
    )
    parser.add_argument("--user-folder", required=True, help="Ableton user folder")
    parser.add_argument("--reports-dir", default="reports", help="Output reports directory")
    parser.add_argument("--suite-script", default="scripts/als_compat_suite.py", help="Path to als_compat_suite.py")
    args = parser.parse_args()

    roots = [Path(p).expanduser().resolve() for p in args.project_root]
    user_folder = Path(args.user_folder).expanduser().resolve()
    reports_dir = Path(args.reports_dir).resolve()
    suite_script = Path(args.suite_script).resolve()

    selected = select_latest_als_per_project(roots)
    manifest_path = reports_dir / "latest-als-manifest.txt"
    set_dir = reports_dir / "latest-als-set"
    md_path = reports_dir / "latest-als-enterprise.md"
    json_path = reports_dir / "latest-als-enterprise.json"

    write_manifest(selected, manifest_path)
    symlink_count = build_symlink_set(selected, set_dir)

    code = run_suite(suite_script, set_dir, user_folder, md_path, json_path)

    print(f"roots={len(roots)} selected_latest={len(selected)} symlinked={symlink_count}")
    print(manifest_path)
    print(md_path)
    print(json_path)
    return code


if __name__ == "__main__":
    raise SystemExit(main())

