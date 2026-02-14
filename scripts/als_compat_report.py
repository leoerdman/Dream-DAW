#!/usr/bin/env python3
from __future__ import annotations

import gzip
import os
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
import xml.etree.ElementTree as ET


CONTAINER_TAGS = {
    "AudioEffectGroupDevice",
    "InstrumentGroupDevice",
    "DrumGroupDevice",
    "MidiEffectGroupDevice",
}


def normalize_key(raw: str) -> str:
    return "".join(ch.lower() for ch in raw if ch.isalnum())


def map_internal(plugin_id: str, plugin_name: str) -> tuple[str, str] | None:
    merged = f"{plugin_id} {plugin_name}".lower()
    compact = normalize_key(merged)

    if "originalsimpler" in compact or "drift" in compact:
        if "originalsimpler" in compact:
            return ("internal://instrument/sampler", "Sampler")
        return ("internal://instrument/wave-synth", "Wave Synth")

    if (
        "operator" in merged
        or "analog" in merged
        or "wavetable" in merged
        or "simplesinesynth" in compact
        or "wave synth" in merged
        or "wavesynth" in compact
    ):
        return ("internal://instrument/wave-synth", "Wave Synth")
    if "sampler" in merged or "simpler" in merged:
        return ("internal://instrument/sampler", "Sampler")

    if "eq" in merged or "channel eq" in merged:
        return ("internal://effect/eq-eight", "EQ Eight")
    if "compressor" in merged or "glue" in merged or "multibanddynamics" in compact or "drumbuss" in compact:
        return ("internal://effect/compressor", "Compressor")
    if (
        "delay" in merged
        or "echo" in merged
        or "ping pong" in merged
        or "beatrepeat" in compact
        or "graindelay" in compact
        or "filterdelay" in compact
        or "spectraltime" in compact
    ):
        return ("internal://effect/delay", "Delay")
    if (
        "reverb" in merged
        or "corpus" in merged
        or "resonators" in merged
        or "spectralresonator" in compact
        or "resonator" in compact
    ):
        return ("internal://effect/reverb", "Reverb")
    if "chorus" in merged:
        return ("internal://effect/chorus", "Chorus")
    if "stereogain" in compact:
        return ("internal://effect/utility", "Utility")
    if "autopan" in compact:
        return ("internal://effect/auto-pan", "Auto Pan")
    if "midipitcher" in compact:
        return ("internal://effect/utility", "Utility")
    if "noise machine" in merged or "noisemachine" in compact:
        return ("internal://effect/noise-machine", "Noise Machine")
    if "saturator" in merged or "dynamictube" in compact:
        return ("internal://effect/saturator", "Saturator")
    if (
        "utility" in merged
        or "looper" in merged
        or "tuner" in merged
        or "spectrum" in merged
        or "frequencyshifter" in compact
        or "pitchhack" in compact
        or "spectral" in compact
        or "mxdeviceaudioeffect" in compact
        or "mxdevicemidieffect" in compact
    ):
        return ("internal://effect/utility", "Utility")
    if "limiter" in merged:
        return ("internal://effect/limiter", "Limiter")
    if "gate" in merged:
        return ("internal://effect/gate", "Gate")
    if "auto filter" in merged or "autofilter" in merged:
        return ("internal://effect/auto-filter", "Auto Filter")
    if "phaser" in merged or "phasernew" in compact:
        return ("internal://effect/phaser", "Phaser")
    if "flanger" in merged:
        return ("internal://effect/flanger", "Flanger")
    if (
        "distortion" in merged
        or "overdrive" in merged
        or "pedal" in merged
        or "cabinet" in merged
        or "amp" in merged
        or "shaper" in merged
    ):
        return ("internal://effect/distortion", "Distortion")
    if "erosion" in merged or "transmute" in merged or "vocoder" in merged or "vinyl" in merged:
        return ("internal://effect/distortion", "Distortion")
    if "bitcrusher" in merged or "redux" in merged or "redux2" in compact:
        return ("internal://effect/bitcrusher", "Bitcrusher")
    return None


def find_all_plugin_bundles() -> dict[str, str]:
    roots = [
        Path("/Library/Audio/Plug-Ins/VST"),
        Path("/Library/Audio/Plug-Ins/VST3"),
        Path("/Library/Audio/Plug-Ins/Components"),
        Path.home() / "Library/Audio/Plug-Ins/VST",
        Path.home() / "Library/Audio/Plug-Ins/VST3",
        Path.home() / "Library/Audio/Plug-Ins/Components",
    ]
    result: dict[str, str] = {}
    for root in roots:
        if not root.exists() or not root.is_dir():
            continue
        for entry in root.iterdir():
            if entry.name.startswith("."):
                continue
            key = normalize_key(entry.stem)
            if key and key not in result:
                result[key] = str(entry)
    return result


def load_xml(path: Path) -> ET.Element:
    raw = path.read_bytes()
    try:
        data = gzip.decompress(raw)
    except OSError:
        data = raw
    return ET.fromstring(data)


def get_track_device_nodes(track_node: ET.Element) -> list[ET.Element]:
    out: list[ET.Element] = []
    for devices in track_node.iter("Devices"):
        for dev in list(devices):
            out.append(dev)
    return out


def resolve_plugin_device(node: ET.Element, installed: dict[str, str]) -> tuple[bool, str]:
    vst2_info = node.find("./PluginDesc/VstPluginInfo")
    vst3_info = node.find("./PluginDesc/Vst3PluginInfo")
    user_name = (node.findtext("./UserName") or "").strip()
    vst2_path = ""
    vst2_name = ""
    vst3_path = ""
    vst3_name = ""
    if vst2_info is not None:
        p = vst2_info.find("./Path")
        n = vst2_info.find("./PlugName")
        vst2_path = (p.get("Value") if p is not None else "") or ""
        vst2_name = (n.get("Value") if n is not None else "") or ""
    if vst3_info is not None:
        p = vst3_info.find("./Path")
        n = vst3_info.find("./Name")
        vst3_path = (p.get("Value") if p is not None else "") or ""
        vst3_name = (n.get("Value") if n is not None else "") or ""
    preferred = user_name or vst3_name or vst2_name or "Unknown Plugin"

    if vst2_path and Path(vst2_path).exists():
        return True, preferred
    if vst3_path and Path(vst3_path).exists():
        return True, preferred

    for candidate in [vst3_name, vst2_name, user_name, preferred]:
        key = normalize_key(candidate)
        if key and key in installed:
            return True, preferred
        # fuzzy
        if key:
            for k in installed:
                if key in k or k in key:
                    return True, preferred
    return False, preferred


@dataclass
class FileStats:
    file: str
    native_mapped: int = 0
    native_unmapped: int = 0
    vst_resolved: int = 0
    vst_missing: int = 0


def main() -> int:
    root = Path.cwd()
    als_files = sorted(root.rglob("*.als"))
    installed = find_all_plugin_bundles()

    files: list[FileStats] = []
    unknown_native: Counter[str] = Counter()
    missing_external: Counter[str] = Counter()
    mapped_native: Counter[str] = Counter()
    resolved_external: Counter[str] = Counter()

    for als in als_files:
        try:
            xml_root = load_xml(als)
        except Exception:
            continue

        st = FileStats(file=str(als.relative_to(root)))
        for track_tag in ["AudioTrack", "MidiTrack", "GroupTrack", "MainTrack"]:
            for track in xml_root.iter(track_tag):
                for dev in get_track_device_nodes(track):
                    tag = dev.tag
                    if tag in CONTAINER_TAGS:
                        continue
                    if tag == "PluginDevice":
                        ok, name = resolve_plugin_device(dev, installed)
                        if ok:
                            st.vst_resolved += 1
                            resolved_external[name] += 1
                        else:
                            st.vst_missing += 1
                            missing_external[name] += 1
                        continue
                    user_name = (dev.findtext("./UserName") or "").strip()
                    mapped = map_internal(tag, user_name)
                    if mapped is None:
                        st.native_unmapped += 1
                        unknown_native[tag] += 1
                    else:
                        st.native_mapped += 1
                        mapped_native[mapped[1]] += 1
        files.append(st)

    total = FileStats(file="TOTAL")
    for s in files:
        total.native_mapped += s.native_mapped
        total.native_unmapped += s.native_unmapped
        total.vst_resolved += s.vst_resolved
        total.vst_missing += s.vst_missing

    report_dir = root / "reports"
    report_dir.mkdir(parents=True, exist_ok=True)
    report = report_dir / "ableton-import-compat-report.md"

    lines: list[str] = []
    lines.append("# Ableton Import Compatibility Report")
    lines.append("")
    lines.append(f"- ALS files scanned: **{len(files)}**")
    lines.append(f"- Native mapped: **{total.native_mapped}**")
    lines.append(f"- Native unmapped: **{total.native_unmapped}**")
    lines.append(f"- External resolved: **{total.vst_resolved}**")
    lines.append(f"- External missing: **{total.vst_missing}**")
    lines.append("")

    lines.append("## Per File")
    lines.append("")
    lines.append("| File | Native mapped | Native unmapped | VST resolved | VST missing |")
    lines.append("|---|---:|---:|---:|---:|")
    for s in files:
        lines.append(
            f"| `{s.file}` | {s.native_mapped} | {s.native_unmapped} | {s.vst_resolved} | {s.vst_missing} |"
        )
    lines.append(
        f"| **TOTAL** | **{total.native_mapped}** | **{total.native_unmapped}** | **{total.vst_resolved}** | **{total.vst_missing}** |"
    )
    lines.append("")

    lines.append("## Top Missing External Plugins")
    lines.append("")
    if missing_external:
        for name, n in missing_external.most_common(50):
            lines.append(f"- {name}: {n}")
    else:
        lines.append("- none")
    lines.append("")

    lines.append("## Unmapped Native Ableton Device Tags")
    lines.append("")
    if unknown_native:
        for tag, n in unknown_native.most_common(50):
            lines.append(f"- {tag}: {n}")
    else:
        lines.append("- none")
    lines.append("")

    lines.append("## Top Mapped Native Targets")
    lines.append("")
    for name, n in mapped_native.most_common(30):
        lines.append(f"- {name}: {n}")
    lines.append("")

    report.write_text("\n".join(lines), encoding="utf-8")
    print(report)
    print(f"files={len(files)} native_mapped={total.native_mapped} native_unmapped={total.native_unmapped} vst_resolved={total.vst_resolved} vst_missing={total.vst_missing}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
