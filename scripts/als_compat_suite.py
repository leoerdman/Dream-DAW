#!/usr/bin/env python3
from __future__ import annotations

import argparse
import gzip
import json
import os
import time
from collections import Counter
from dataclasses import asdict, dataclass
from pathlib import Path
import xml.etree.ElementTree as ET


CONTAINER_TAGS = {
    "AudioEffectGroupDevice",
    "InstrumentGroupDevice",
    "DrumGroupDevice",
    "MidiEffectGroupDevice",
}

TRACK_TAGS = {"AudioTrack", "MidiTrack", "GroupTrack", "MainTrack"}
COUNT_TAGS = {"AudioClip", "MidiClip", "FloatEvent", "SampleRef"}


def norm_key(raw: str) -> str:
    return "".join(ch.lower() for ch in raw if ch.isalnum())


def map_internal(plugin_id: str, plugin_name: str) -> tuple[str, str] | None:
    merged = f"{plugin_id} {plugin_name}".lower()
    compact = norm_key(merged)

    if "originalsimpler" in compact:
        return ("internal://instrument/sampler", "Sampler")
    if (
        "drift" in compact
        or "operator" in merged
        or "analog" in merged
        or "wavetable" in merged
        or "simplesinesynth" in compact
        or "wavesynth" in compact
        or "instrumentvector" in compact
        or "stringstudio" in compact
    ):
        return ("internal://instrument/wave-synth", "Wave Synth")
    if "sampler" in merged or "simpler" in merged or "multisampler" in compact:
        return ("internal://instrument/sampler", "Sampler")

    if "eq" in merged or "channeleq" in compact:
        return ("internal://effect/eq-eight", "EQ Eight")
    if (
        "compressor" in merged
        or "glue" in merged
        or "multibanddynamics" in compact
        or "drumbuss" in compact
    ):
        return ("internal://effect/compressor", "Compressor")
    if (
        "delay" in merged
        or "echo" in merged
        or "pingpong" in compact
        or "beatrepeat" in compact
        or "graindelay" in compact
        or "filterdelay" in compact
        or "spectraltime" in compact
    ):
        return ("internal://effect/delay", "Delay")
    if (
        "reverb" in merged
        or "corpus" in merged
        or "resonator" in merged
        or "spectralresonator" in compact
    ):
        return ("internal://effect/reverb", "Reverb")
    if "autofilter" in compact:
        return ("internal://effect/auto-filter", "Auto Filter")
    if "autopan" in compact:
        return ("internal://effect/auto-pan", "Auto Pan")
    if "midipitcher" in compact:
        return ("internal://midi-fx/pitch", "MIDI Pitch")
    if "mxdevicescale" in compact or compact == "scale":
        return ("internal://midi-fx/scale", "MIDI Scale")
    if "mxdevicevelocity" in compact or compact == "velocity":
        return ("internal://midi-fx/velocity", "MIDI Velocity")
    if "mxdevicerandom" in compact or compact == "random" or "midirandom" in compact:
        return ("internal://midi-fx/random", "MIDI Random")
    if "midinotelength" in compact:
        return ("internal://midi-fx/velocity", "MIDI Note Length")
    if "stereogain" in compact or "utility" in merged:
        return ("internal://effect/utility", "Utility")
    if (
        "mxdeviceaudioeffect" in compact
        or "mxdevicemidieffect" in compact
        or "tuner" in merged
        or "spectral" in compact
        or "shifter" in compact
        or "frequencyshifter" in compact
    ):
        return ("internal://effect/utility", "Utility")
    if "saturator" in merged or "dynamictube" in compact or "tube" == compact:
        return ("internal://effect/saturator", "Saturator")
    if "phaser" in merged or "phasernew" in compact:
        return ("internal://effect/phaser", "Phaser")
    if "flanger" in merged:
        return ("internal://effect/flanger", "Flanger")
    if "chorus" in merged:
        return ("internal://effect/chorus", "Chorus")
    if "limiter" in merged:
        return ("internal://effect/limiter", "Limiter")
    if "gate" in merged:
        return ("internal://effect/gate", "Gate")
    if "redux" in compact or "bitcrusher" in merged:
        return ("internal://effect/bitcrusher", "Bitcrusher")
    if (
        "distortion" in merged
        or "overdrive" in merged
        or "pedal" in merged
        or "cabinet" in merged
        or "amp" in merged
        or "erosion" in merged
        or "vocoder" in merged
        or "vinyl" in merged
        or "shaper" in merged
    ):
        return ("internal://effect/distortion", "Distortion")
    if "hybrid" in compact:
        return ("internal://effect/reverb", "Reverb")
    if "roar" in compact:
        return ("internal://effect/distortion", "Distortion")

    return None


def discover_installed_plugins() -> dict[str, str]:
    roots = [
        Path("/Library/Audio/Plug-Ins/VST"),
        Path("/Library/Audio/Plug-Ins/VST3"),
        Path("/Library/Audio/Plug-Ins/Components"),
        Path.home() / "Library/Audio/Plug-Ins/VST",
        Path.home() / "Library/Audio/Plug-Ins/VST3",
        Path.home() / "Library/Audio/Plug-Ins/Components",
    ]
    out: dict[str, str] = {}
    for root in roots:
        if not root.is_dir():
            continue
        for entry in root.iterdir():
            if entry.name.startswith("."):
                continue
            key = norm_key(entry.stem)
            if key and key not in out:
                out[key] = str(entry)
    return out


def resolve_external(name_candidates: list[str], path_candidates: list[str], installed: dict[str, str]) -> bool:
    for p in path_candidates:
        if p and Path(p).exists():
            return True
    for name in name_candidates:
        key = norm_key(name)
        if not key:
            continue
        if key in installed:
            return True
        for k in installed:
            if key in k or k in key:
                return True
    return False


def _attr(elem: ET.Element | None, key: str) -> str:
    if elem is None:
        return ""
    return (elem.get(key) or "").strip()


def _text(elem: ET.Element | None) -> str:
    if elem is None:
        return ""
    return (elem.text or "").strip()


def parse_als(path: Path) -> ET.Element:
    raw = path.read_bytes()
    if len(raw) >= 2 and raw[:2] == b"\x1f\x8b":
        try:
            return ET.fromstring(gzip.decompress(raw))
        except OSError:
            pass
    return ET.fromstring(raw)


@dataclass
class FileStats:
    file: str
    audio_tracks: int = 0
    midi_tracks: int = 0
    group_tracks: int = 0
    main_tracks: int = 0
    audio_clips: int = 0
    midi_clips: int = 0
    float_events: int = 0
    sample_refs: int = 0
    native_mapped: int = 0
    native_unmapped: int = 0
    external_resolved: int = 0
    external_missing: int = 0


@dataclass
class Totals:
    files: int = 0
    audio_tracks: int = 0
    midi_tracks: int = 0
    group_tracks: int = 0
    main_tracks: int = 0
    audio_clips: int = 0
    midi_clips: int = 0
    float_events: int = 0
    sample_refs: int = 0
    native_mapped: int = 0
    native_unmapped: int = 0
    external_resolved: int = 0
    external_missing: int = 0


def scan_als_file(
    path: Path,
    base: Path,
    installed_plugins: dict[str, str],
    device_tags: Counter[str],
    mapped_targets: Counter[str],
    unknown_native: Counter[str],
    ext_missing: Counter[str],
    ext_resolved: Counter[str],
    vst3_names: Counter[str],
    vst2_names: Counter[str],
) -> FileStats:
    fs = FileStats(file=str(path.relative_to(base)))
    root = parse_als(path)

    fs.audio_tracks = sum(1 for _ in root.iter("AudioTrack"))
    fs.midi_tracks = sum(1 for _ in root.iter("MidiTrack"))
    fs.group_tracks = sum(1 for _ in root.iter("GroupTrack"))
    fs.main_tracks = sum(1 for _ in root.iter("MainTrack"))
    fs.audio_clips = sum(1 for _ in root.iter("AudioClip"))
    fs.midi_clips = sum(1 for _ in root.iter("MidiClip"))
    fs.float_events = sum(1 for _ in root.iter("FloatEvent"))
    fs.sample_refs = sum(1 for _ in root.iter("SampleRef"))

    for devices_node in root.iter("Devices"):
        for dev in list(devices_node):
            dev_tag = dev.tag
            device_tags[dev_tag] += 1
            if dev_tag in CONTAINER_TAGS:
                continue
            if dev_tag == "PluginDevice":
                v2 = dev.find("./PluginDesc/VstPluginInfo")
                v3 = dev.find("./PluginDesc/Vst3PluginInfo")
                user_name = _attr(dev.find("./UserName"), "Value") or _text(dev.find("./UserName"))
                v2_name = _attr(v2.find("./PlugName") if v2 is not None else None, "Value")
                v2_path = _attr(v2.find("./Path") if v2 is not None else None, "Value")
                v3_name = _attr(v3.find("./Name") if v3 is not None else None, "Value")
                v3_path = _attr(v3.find("./Path") if v3 is not None else None, "Value")

                if v3_name:
                    vst3_names[v3_name] += 1
                if v2_name:
                    vst2_names[v2_name] += 1

                preferred = user_name or v3_name or v2_name or "Unknown Plugin"
                ok = resolve_external(
                    [v3_name, v2_name, user_name, preferred],
                    [v2_path, v3_path],
                    installed_plugins,
                )
                if ok:
                    fs.external_resolved += 1
                    ext_resolved[preferred] += 1
                else:
                    fs.external_missing += 1
                    ext_missing[preferred] += 1
                continue

            mapped = map_internal(dev_tag, _attr(dev.find("./UserName"), "Value") or _text(dev.find("./UserName")))
            if mapped is None:
                fs.native_unmapped += 1
                unknown_native[dev_tag] += 1
            else:
                fs.native_mapped += 1
                mapped_targets[mapped[1]] += 1

    return fs


def scan_user_folder(user_folder: Path, max_files: int | None = None) -> dict[str, object]:
    ext_counter = Counter()
    buckets = Counter()
    scanned_files = 0

    for root, dirs, files in os.walk(user_folder, followlinks=False):
        # Guard against cyclic symlink loops and hidden/metadata branches.
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for file_name in files:
            if max_files is not None and scanned_files >= max_files:
                break
            p = Path(root) / file_name
            scanned_files += 1
            ext_counter[p.suffix.lower() or "<noext>"] += 1
            sp = str(p).lower().replace("\\", "/")
            if "/presets/" in sp:
                buckets["presets"] += 1
            if "/samples/" in sp:
                buckets["samples"] += 1
            if "/defaults/" in sp:
                buckets["defaults"] += 1
            if "/grooves/" in sp:
                buckets["grooves"] += 1
            if "/clips/" in sp:
                buckets["clips"] += 1
            if "/templates/" in sp:
                buckets["templates"] += 1
            if "/remote scripts/" in sp:
                buckets["remote_scripts"] += 1
        if max_files is not None and scanned_files >= max_files:
            break

    defaults_root = user_folder / "User Library" / "Defaults"
    if not defaults_root.exists():
        defaults_candidates = [
            p for p in user_folder.rglob("Defaults") if p.is_dir() and "user library" in str(p).lower()
        ]
        defaults_root = defaults_candidates[0] if defaults_candidates else defaults_root

    default_by_dir = Counter()
    default_files = 0
    if defaults_root.exists() and defaults_root.is_dir():
        for p in defaults_root.rglob("*"):
            if not p.is_file():
                continue
            default_files += 1
            parent = p.parent
            rel = str(parent.relative_to(defaults_root)) if parent != defaults_root else "<root>"
            default_by_dir[rel] += 1

    return {
        "bucket_counts": dict(buckets),
        "extension_counts": dict(ext_counter),
        "scanned_files": scanned_files,
        "max_files_limit": max_files,
        "defaults_root": str(defaults_root),
        "defaults_file_count": default_files,
        "defaults_top_dirs": default_by_dir.most_common(50),
    }


def ratio(numer: int, denom: int) -> float:
    if denom <= 0:
        return 1.0
    return numer / denom


def main() -> int:
    ap = argparse.ArgumentParser(description="Batch ALS compatibility suite")
    ap.add_argument("--als-root", required=True, help="Root folder with Ableton projects / ALS files")
    ap.add_argument("--user-folder", required=True, help="Ableton User Folder")
    ap.add_argument("--report-md", required=True, help="Output markdown path")
    ap.add_argument("--report-json", required=True, help="Output json path")
    ap.add_argument("--max-native-unmapped", type=int, default=None)
    ap.add_argument("--max-external-missing", type=int, default=None)
    ap.add_argument("--min-overall-rate", type=float, default=None)
    ap.add_argument("--strict", action="store_true", help="Fail when at least one ALS parse error occurs")
    ap.add_argument("--limit-files", type=int, default=None, help="Limit ALS files scanned (debug)")
    ap.add_argument("--user-max-files", type=int, default=200000, help="Safety cap for User Folder scan")
    ap.add_argument("--skip-user-scan", action="store_true", help="Skip User Folder inventory")
    args = ap.parse_args()

    t0 = time.time()
    als_root = Path(args.als_root)
    user_folder = Path(args.user_folder)
    report_md = Path(args.report_md)
    report_json = Path(args.report_json)
    report_md.parent.mkdir(parents=True, exist_ok=True)
    report_json.parent.mkdir(parents=True, exist_ok=True)

    als_files = sorted(als_root.rglob("*.als"))
    if args.limit_files is not None:
        als_files = als_files[: max(0, args.limit_files)]
    installed_plugins = discover_installed_plugins()

    totals = Totals(files=len(als_files))
    device_tags = Counter()
    mapped_targets = Counter()
    unknown_native = Counter()
    ext_missing = Counter()
    ext_resolved = Counter()
    vst3_names = Counter()
    vst2_names = Counter()
    per_file: list[FileStats] = []
    parse_errors: list[dict[str, str]] = []

    for als in als_files:
        try:
            fs = scan_als_file(
                path=als,
                base=als_root,
                installed_plugins=installed_plugins,
                device_tags=device_tags,
                mapped_targets=mapped_targets,
                unknown_native=unknown_native,
                ext_missing=ext_missing,
                ext_resolved=ext_resolved,
                vst3_names=vst3_names,
                vst2_names=vst2_names,
            )
            per_file.append(fs)

            totals.audio_tracks += fs.audio_tracks
            totals.midi_tracks += fs.midi_tracks
            totals.group_tracks += fs.group_tracks
            totals.main_tracks += fs.main_tracks
            totals.audio_clips += fs.audio_clips
            totals.midi_clips += fs.midi_clips
            totals.float_events += fs.float_events
            totals.sample_refs += fs.sample_refs
            totals.native_mapped += fs.native_mapped
            totals.native_unmapped += fs.native_unmapped
            totals.external_resolved += fs.external_resolved
            totals.external_missing += fs.external_missing
        except Exception as exc:  # noqa: BLE001
            parse_errors.append({"file": str(als), "error": str(exc)})

    user_inventory = (
        scan_user_folder(user_folder, max_files=args.user_max_files)
        if not args.skip_user_scan
        else {
            "bucket_counts": {},
            "extension_counts": {},
            "scanned_files": 0,
            "max_files_limit": 0,
            "defaults_root": str(user_folder / "User Library" / "Defaults"),
            "defaults_file_count": 0,
            "defaults_top_dirs": [],
        }
    )

    native_total = totals.native_mapped + totals.native_unmapped
    external_total = totals.external_resolved + totals.external_missing
    overall_total = native_total + external_total
    native_rate = ratio(totals.native_mapped, native_total)
    external_rate = ratio(totals.external_resolved, external_total)
    overall_rate = ratio(totals.native_mapped + totals.external_resolved, overall_total)

    elapsed = round(time.time() - t0, 2)

    payload = {
        "als_root": str(als_root),
        "user_folder": str(user_folder),
        "generated_at_epoch": int(time.time()),
        "elapsed_seconds": elapsed,
        "installed_plugins_indexed": len(installed_plugins),
        "totals": asdict(totals),
        "rates": {
            "native_mapped_rate": native_rate,
            "external_resolved_rate": external_rate,
            "overall_compat_rate": overall_rate,
        },
        "parse_errors": parse_errors,
        "top": {
            "device_tags": device_tags.most_common(100),
            "mapped_targets": mapped_targets.most_common(50),
            "unknown_native": unknown_native.most_common(100),
            "missing_external": ext_missing.most_common(100),
            "resolved_external": ext_resolved.most_common(100),
            "vst3_names": vst3_names.most_common(80),
            "vst2_names": vst2_names.most_common(80),
        },
        "user_inventory": user_inventory,
        "files": [asdict(f) for f in per_file],
    }
    report_json.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    md: list[str] = []
    md.append("# Ableton Import Compatibility Suite")
    md.append("")
    md.append("## Summary")
    md.append("")
    md.append(f"- ALS root: `{als_root}`")
    md.append(f"- User folder: `{user_folder}`")
    md.append(f"- ALS files: **{totals.files}**")
    md.append(f"- Parse errors: **{len(parse_errors)}**")
    md.append(f"- Scan time: **{elapsed}s**")
    md.append(f"- Indexed installed plugins: **{len(installed_plugins)}**")
    md.append(f"- User folder scanned files: **{user_inventory['scanned_files']}**")
    md.append(f"- Tracks: audio **{totals.audio_tracks}**, midi **{totals.midi_tracks}**, group **{totals.group_tracks}**, main **{totals.main_tracks}**")
    md.append(f"- Clips: audio **{totals.audio_clips}**, midi **{totals.midi_clips}**")
    md.append(f"- FloatEvent: **{totals.float_events}**; SampleRef: **{totals.sample_refs}**")
    md.append(f"- Native mapped/unmapped: **{totals.native_mapped}/{totals.native_unmapped}** ({native_rate:.2%})")
    md.append(f"- External resolved/missing: **{totals.external_resolved}/{totals.external_missing}** ({external_rate:.2%})")
    md.append(f"- Overall compat rate: **{overall_rate:.2%}**")
    md.append("")

    md.append("## CI Gates")
    md.append("")

    checks: list[tuple[str, bool, str]] = []
    if args.max_native_unmapped is not None:
        ok = totals.native_unmapped <= args.max_native_unmapped
        checks.append(("max_native_unmapped", ok, f"{totals.native_unmapped} <= {args.max_native_unmapped}"))
    if args.max_external_missing is not None:
        ok = totals.external_missing <= args.max_external_missing
        checks.append(("max_external_missing", ok, f"{totals.external_missing} <= {args.max_external_missing}"))
    if args.min_overall_rate is not None:
        ok = overall_rate >= args.min_overall_rate
        checks.append(("min_overall_rate", ok, f"{overall_rate:.4f} >= {args.min_overall_rate:.4f}"))
    if args.strict:
        ok = len(parse_errors) == 0
        checks.append(("strict_parse_errors", ok, f"{len(parse_errors)} == 0"))

    if checks:
        for name, ok, detail in checks:
            md.append(f"- {'PASS' if ok else 'FAIL'} `{name}`: {detail}")
    else:
        md.append("- No thresholds provided.")
    md.append("")

    md.append("## Top Missing External Plugins")
    md.append("")
    if ext_missing:
        for name, count in ext_missing.most_common(40):
            md.append(f"- {name}: {count}")
    else:
        md.append("- none")
    md.append("")

    md.append("## Top Unmapped Native Tags")
    md.append("")
    if unknown_native:
        for name, count in unknown_native.most_common(40):
            md.append(f"- {name}: {count}")
    else:
        md.append("- none")
    md.append("")

    md.append("## User Library Defaults")
    md.append("")
    md.append(f"- Defaults root: `{user_inventory['defaults_root']}`")
    md.append(f"- Default files: **{user_inventory['defaults_file_count']}**")
    md.append("")
    for rel, count in user_inventory["defaults_top_dirs"][:30]:
        md.append(f"- {rel}: {count}")
    md.append("")

    md.append("## Per File")
    md.append("")
    md.append("| File | Native mapped | Native unmapped | External resolved | External missing | Audio clips | MIDI clips |")
    md.append("|---|---:|---:|---:|---:|---:|---:|")
    for row in per_file:
        md.append(
            f"| `{row.file}` | {row.native_mapped} | {row.native_unmapped} | {row.external_resolved} | {row.external_missing} | {row.audio_clips} | {row.midi_clips} |"
        )
    md.append("")

    if parse_errors:
        md.append("## Parse Errors")
        md.append("")
        for e in parse_errors[:80]:
            md.append(f"- `{e['file']}`: {e['error']}")
        md.append("")

    report_md.write_text("\n".join(md), encoding="utf-8")

    failed = any(not ok for _, ok, _ in checks)
    if failed:
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
