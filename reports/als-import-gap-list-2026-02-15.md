# ALS Import Gap List (Final 2026-02-15)

## Snapshot
- Enterprise audit: `reports/latest-als-enterprise.json`
- Virtual tests: `reports/als-virtual-tests-1000-fast.json`

### Metrics
- Files audited: **184**
- Native mapped/unmapped: **18968 / 0**
- External resolved/missing: **8978 / 0**
- Overall compatibility: **1.000000**
- Virtual tests: **1184 / 1184 pass**

## Closed
1. All previously remaining unresolved external names in corpus are covered by deterministic policy (effective missing = 0).
2. Rack macro mapping graph import is implemented (`PowerMacroControlIndex` + `PowerMacroMappingRange` -> `MacroControl.mappings`).
3. Extended sampler/synth static params are imported (detune/sub/LFO/pulse and related lanes).
4. Routing edge-case lanes improved (split stereo pan L/R lanes).
5. External parameter semantic alias lanes added (`plugin_semantic:*` + selected type-aware aliases).
6. External plugin metadata extraction includes state/preset blob persistence in project model.
7. Runtime hook path for imported state restore added to plugin host API and plugin open flow.

## Remaining technical note
- VST3 binary state injection via IBStream adapter is scaffolded but currently deferred in host implementation (non-failing warning path).
- Import compatibility is complete on current corpus metrics; deep sound-to-sound parity for all proprietary externals still depends on full host-side stream restore implementation.
