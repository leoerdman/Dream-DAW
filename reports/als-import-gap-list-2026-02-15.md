# ALS Import Gap List (2026-02-15)

## Snapshot
- Audit source: `reports/latest-als-enterprise.json`
- Virtual tests source: `reports/als-virtual-tests-1000-fast.json`
- Corpus: latest ALS per project from two roots (`0-160 BPM`, `160-200 BPM`)

### Metrics
- Files: **184**
- Native mapped/unmapped: **18968 / 0**
- External resolved/missing: **8967 / 11**
- Overall compatibility: **0.999606**
- Virtual tests: **1184/1184 passed** (requested iterations: 1000)

## Confirmed Imported (code + tests)
1. Grid/Snap project fields and persistence model.
2. Clip launch/follow/groove.
3. Audio warp state/mode/markers.
4. Clip envelopes.
5. Project markers/locators and scenes.
6. Scale/in-key import into project and clips.
7. Static fallback lanes for plugin params including external `PluginDevice` manual params (float/int/bool).

## Remaining Gaps (real)
1. Bit-perfect external plugin state restore
- Full VST/AU chunk/preset reconstruction is still not guaranteed 1:1 sound parity.

2. External plugin parameter semantics
- Automation lanes are imported, but not all params are mapped to stable human semantic IDs across all plugin ecosystems.

3. Rack macro destination graph
- Macro names/values imported; full macro->target mapping graph remains partial.

4. Full Live mixer/IO parity edge-cases
- Core routing imported; complete behavior parity for all monitor/IO permutations remains partial.

5. Full Simpler/Sampler parity
- Sample path and core values are imported; full Ableton-specific state is not yet complete.

6. Remaining unresolved external plugins (11 instances)
- reastream-standalone: 6
- Nectar 3: 3
- Synthesizer V Studio 2 Plugin: 2
- Current handling: metadata-rich missing placeholder, with imported fallback automation lanes.

## Prioritized Next Steps
1. External state bridge
- Add import path for plugin chunk blobs/preset blocks where possible and persist in project metadata.

2. Semantic param registry for externals
- Build deterministic mapping layer (`plugin vendor/name/version + param id/name -> canonical lane id`).

3. Rack macro mapping parser
- Parse macro mapping relations and serialize into rack model.

4. Substitution policy for unresolved external plugins
- Define deterministic replacement policy (internal equivalent or explicit `not found` stub) with full metadata retention.
