# ALS Import Gap List (Updated 2026-02-15, pass 5->1)

## Current Snapshot
- Enterprise audit: `reports/latest-als-enterprise.json`
- Virtual tests: `reports/als-virtual-tests-1000-fast.json`

### Metrics
- Files audited: **184**
- Native mapped/unmapped: **18968 / 0**
- External resolved/missing: **8969 / 9**
- Overall compatibility: **0.99967795**
- Virtual tests: **1184 / 1184 pass**

## Closed in this pass
1. `#5` unresolved external reduction (policy substitution)
- Added deterministic substitution coverage for `Synthesizer V Studio 2 Plugin` -> internal Wave Synth.
- Audit missing reduced from 11 to **9**.

2. `#4` sampler/synth parity improved
- Imported additional sampler/synth params: detune, sub level, LFO rate/depth/target, pulse width.

3. `#3` routing/monitoring edge coverage improved
- Added mixer split stereo pan import lanes: `mixer.pan_left`, `mixer.pan_right`.

4. `#2` external parameter semantic aliases
- Added semantic alias lanes for external plugin params (`plugin_semantic:*`) plus type-aware compressor/synth utility aliases.

5. Rack macro mapping graph import (already added earlier in this cycle)
- `PowerMacroControlIndex` + `PowerMacroMappingRange` now imported into `MacroControl.mappings`.

## Remaining gaps
1. `#1` runtime bit-perfect external state restore
- External state/preset blobs are extracted and persisted in model metadata.
- Full runtime application back into loaded external plugin instances is still pending host-side state injection API path.

2. Remaining unresolved external plugins in corpus (9)
- `reastream-standalone`: 6
- `Nectar 3`: 3

## Key files
- Importer: `apps/desktop_host/src/commands/sections/project_management.rs`
- Compat suite policy: `scripts/als_compat_suite.py`
