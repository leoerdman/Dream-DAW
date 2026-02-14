# Again V115 Detailed Import Audit

- Generated: 2026-02-15T02:51:32
- Source ALS: `/Users/leoerdman/ABLETON - Main Folder/ABLETON - Projects/160-200 BPM/9. Again/Leo Erdman - Again V115.als`
- ALS size: **3,909,682 bytes** compressed, **40,758,020 bytes** XML

## Project Structure

- AudioTrack: **51**
- MidiTrack: **20**
- GroupTrack: **7**
- MainTrack: **1**
- audio_clips: **710**
- midi_clips: **417**
- float_events: **815**
- sample_refs: **1193**

## Top Device Tags (<Devices>)

- PluginDevice: 127
- StereoGain: 61
- Eq8: 54
- Reverb: 23
- AutoFilter2: 15
- AutoPan: 13
- MidiPitcher: 11
- AudioEffectGroupDevice: 11
- Saturator: 8
- AutoFilter: 7
- Erosion: 7
- InstrumentGroupDevice: 7
- OriginalSimpler: 6
- Delay: 6
- MultiSampler: 6
- MidiNoteLength: 5
- MidiRandom: 4
- MxDeviceAudioEffect: 3
- Roar: 2
- Hybrid: 2
- Shifter: 2
- ChannelEq: 2
- Tube: 2
- Limiter: 2
- MultibandDynamics: 1
- Compressor2: 1
- AutoPan2: 1
- Chorus2: 1
- InstrumentVector: 1
- Operator: 1
- Amp: 1
- Redux2: 1

## Top VST3 Plugins

- Pro-Q 3: 35
- ShaperBox 3: 13
- Serum 2: 11
- Ozone 11 Imager: 8
- ValhallaShimmer: 8
- kHs Clipper: 7
- Pro-L 2: 3
- kHs Transient Shaper: 2
- ValhallaRoom: 1
- kHs Haas: 1
- MWaveShaper: 1
- Pro-Q 4: 1
- MusePlugin: 1
- ADPTR MetricAB: 1

## Top VST2 Plugins

- kHs Transient Shaper: 9
- FabFilter Pro-Q 4: 8
- kHs Haas: 5
- FabFilter Pro-Q 3: 4
- Voxengo SPAN: 2
- kHs Pitch Shifter: 2
- ValhallaShimmer: 2
- soothe2: 1
- FabFilter Pro-DS: 1

## User Folder Inventory (Focused)

- samples: 360
- remote_scripts: 208
- presets: 57
- templates: 19
- defaults: 9

### Extensions

- `.asd`: 179
- `.wav`: 157
- `.py`: 56
- `.adg`: 37
- `.amxd`: 35
- `.pyc`: 33
- `.als`: 25
- `<noext>`: 21
- `.aif`: 18
- `.ini`: 17
- `.ico`: 14
- `.sample`: 14
- `.adv`: 12
- `.maxpat`: 10
- `.xmp`: 9
- `.aiff`: 6
- `.vstpreset`: 3
- `.appc`: 3
- `.md`: 3
- `.cfg`: 3
- `.idx`: 2
- `.toe`: 2
- `.log`: 1
- `.rev`: 1
- `.pack`: 1

## Applied Import Improvements

- Expanded native mapping for modern Ableton tags seen in V115 (MultiSampler, InstrumentVector, Hybrid, Roar/Tube, MIDI random/note-length aliases).
- Improved external plugin resolution by normalized/fuzzy name matching and strict path-exists checks before accepting ALS paths.
- Preserved fallback behavior: unresolved external devices become explicit `Plugin Not Found` placeholders with source plugin name.