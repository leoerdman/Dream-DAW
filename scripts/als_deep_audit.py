#!/usr/bin/env python3
from __future__ import annotations

import argparse
import gzip
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
import xml.etree.ElementTree as ET


CONTAINER_TAGS = {
    "AudioEffectGroupDevice",
    "InstrumentGroupDevice",
    "DrumGroupDevice",
    "MidiEffectGroupDevice",
}


def norm_key(raw: str) -> str:
    return "".join(ch.lower() for ch in raw if ch.isalnum())


def map_internal(plugin_id: str, plugin_name: str) -> tuple[str, str] | None:
    merged = f"{plugin_id} {plugin_name}".lower()
    compact = norm_key(merged)

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


def load_xml(path: Path) -> ET.Element:
    raw = path.read_bytes()
    try:
        data = gzip.decompress(raw)
    except OSError:
        data = raw
    return ET.fromstring(data)


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
        if not root.exists() or not root.is_dir():
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


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--als-root", required=True)
    parser.add_argument("--user-folder", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    als_root = Path(args.als_root)
    user_folder = Path(args.user_folder)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)

    als_files = sorted(als_root.rglob("*.als"))
    installed = discover_installed_plugins()

    t = Totals(files=len(als_files))
    devices = Counter()
    mapped_targets = Counter()
    unknown_native = Counter()
    ext_missing = Counter()
    ext_resolved = Counter()
    vst3_names = Counter()
    vst2_names = Counter()
    per_file_rows: list[tuple[str, int, int, int, int, int, int]] = []

    for als in als_files:
        root = load_xml(als)
        f_native_mapped = f_native_unmapped = f_ext_resolved = f_ext_missing = 0
        f_audio = sum(1 for _ in root.iter("AudioClip"))
        f_midi = sum(1 for _ in root.iter("MidiClip"))
        t.audio_clips += f_audio
        t.midi_clips += f_midi
        t.float_events += sum(1 for _ in root.iter("FloatEvent"))
        t.sample_refs += sum(1 for _ in root.iter("SampleRef"))
        t.audio_tracks += sum(1 for _ in root.iter("AudioTrack"))
        t.midi_tracks += sum(1 for _ in root.iter("MidiTrack"))
        t.group_tracks += sum(1 for _ in root.iter("GroupTrack"))
        t.main_tracks += sum(1 for _ in root.iter("MainTrack"))

        for devices_node in root.iter("Devices"):
            for dev in list(devices_node):
                tag = dev.tag
                devices[tag] += 1
                if tag in CONTAINER_TAGS:
                    continue
                if tag == "PluginDevice":
                    user_name = (dev.findtext("./UserName") or "").strip()
                    v3 = dev.find("./PluginDesc/Vst3PluginInfo")
                    v2 = dev.find("./PluginDesc/VstPluginInfo")
                    v3n = (v3.find("./Name").get("Value") if (v3 is not None and v3.find("./Name") is not None) else "") or ""
                    v3p = (v3.find("./Path").get("Value") if (v3 is not None and v3.find("./Path") is not None) else "") or ""
                    v2n = (v2.find("./PlugName").get("Value") if (v2 is not None and v2.find("./PlugName") is not None) else "") or ""
                    v2p = (v2.find("./Path").get("Value") if (v2 is not None and v2.find("./Path") is not None) else "") or ""
                    if v3n:
                        vst3_names[v3n] += 1
                    if v2n:
                        vst2_names[v2n] += 1
                    preferred = user_name or v3n or v2n or "Unknown Plugin"
                    ok = resolve_external([v3n, v2n, user_name, preferred], [v2p, v3p], installed)
                    if ok:
                        f_ext_resolved += 1
                        ext_resolved[preferred] += 1
                    else:
                        f_ext_missing += 1
                        ext_missing[preferred] += 1
                    continue

                mapped = map_internal(tag, (dev.findtext("./UserName") or "").strip())
                if mapped is None:
                    f_native_unmapped += 1
                    unknown_native[tag] += 1
                else:
                    f_native_mapped += 1
                    mapped_targets[mapped[1]] += 1

        t.native_mapped += f_native_mapped
        t.native_unmapped += f_native_unmapped
        t.external_resolved += f_ext_resolved
        t.external_missing += f_ext_missing
        per_file_rows.append((
            str(als.relative_to(als_root)),
            f_native_mapped,
            f_native_unmapped,
            f_ext_resolved,
            f_ext_missing,
            f_audio,
            f_midi,
        ))

    # User folder inventory
    ext_counter = Counter()
    bucket_counter = Counter()
    for p in user_folder.rglob("*"):
        if not p.is_file():
            continue
        ext_counter[p.suffix.lower() or "<noext>"] += 1
        sp = str(p).lower()
        if "/presets/" in sp:
            bucket_counter["presets"] += 1
        if "/samples/" in sp:
            bucket_counter["samples"] += 1
        if "/defaults/" in sp:
            bucket_counter["defaults"] += 1
        if "/grooves/" in sp:
            bucket_counter["grooves"] += 1
        if "/clips/" in sp:
            bucket_counter["clips"] += 1
        if "/user library/" in sp:
            bucket_counter["user_library"] += 1

    lines: list[str] = []
    lines.append("# Deep Ableton Import Audit")
    lines.append("")
    lines.append("## Summary")
    lines.append("")
    lines.append(f"- ALS root: `{als_root}`")
    lines.append(f"- User folder: `{user_folder}`")
    lines.append(f"- ALS files: **{t.files}**")
    lines.append(f"- Tracks: audio **{t.audio_tracks}**, midi **{t.midi_tracks}**, group **{t.group_tracks}**, main **{t.main_tracks}**")
    lines.append(f"- Clips: audio **{t.audio_clips}**, midi **{t.midi_clips}**")
    lines.append(f"- Automation points (FloatEvent): **{t.float_events}**")
    lines.append(f"- Sample refs: **{t.sample_refs}**")
    lines.append(f"- Native mapped: **{t.native_mapped}**")
    lines.append(f"- Native unmapped: **{t.native_unmapped}**")
    lines.append(f"- External resolved: **{t.external_resolved}**")
    lines.append(f"- External missing: **{t.external_missing}**")
    lines.append("")

    lines.append("## Per File")
    lines.append("")
    lines.append("| File | Native mapped | Native unmapped | External resolved | External missing | Audio clips | MIDI clips |")
    lines.append("|---|---:|---:|---:|---:|---:|---:|")
    for row in per_file_rows:
        lines.append(f"| `{row[0]}` | {row[1]} | {row[2]} | {row[3]} | {row[4]} | {row[5]} | {row[6]} |")
    lines.append("")

    lines.append("## Top Ableton Device Tags")
    lines.append("")
    for k, v in devices.most_common(80):
        lines.append(f"- {k}: {v}")
    lines.append("")

    lines.append("## Top Mapped Internal Targets")
    lines.append("")
    for k, v in mapped_targets.most_common(40):
        lines.append(f"- {k}: {v}")
    lines.append("")

    lines.append("## Unmapped Native Tags")
    lines.append("")
    if unknown_native:
        for k, v in unknown_native.most_common(80):
            lines.append(f"- {k}: {v}")
    else:
        lines.append("- none")
    lines.append("")

    lines.append("## Top External VST3 Names")
    lines.append("")
    for k, v in vst3_names.most_common(50):
        lines.append(f"- {k}: {v}")
    lines.append("")

    lines.append("## Top External VST2 Names")
    lines.append("")
    for k, v in vst2_names.most_common(50):
        lines.append(f"- {k}: {v}")
    lines.append("")

    lines.append("## Missing External Plugins")
    lines.append("")
    if ext_missing:
        for k, v in ext_missing.most_common(80):
            lines.append(f"- {k}: {v}")
    else:
        lines.append("- none")
    lines.append("")

    lines.append("## User Folder Inventory")
    lines.append("")
    for k, v in bucket_counter.most_common():
        lines.append(f"- {k}: {v}")
    lines.append("")
    lines.append("### User Folder Extensions")
    lines.append("")
    for k, v in ext_counter.most_common(80):
        lines.append(f"- `{k}`: {v}")
    lines.append("")

    output.write_text("\n".join(lines), encoding="utf-8")
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
