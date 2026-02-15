// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Solo/Mute Resolver
// ═══════════════════════════════════════════════════════════════════════════
//
// Resolves per-track effective gain multipliers from solo/mute flags.
//
// Logic (ported from Swift TrackMixer.swift):
//   1. If NO tracks are soloed → all non-muted tracks play at 1.0
//   2. If ANY track is soloed → only soloed tracks play at 1.0
//   3. Mute ALWAYS overrides solo (muted + soloed = silent)
//   4. Master track is ALWAYS audible (cannot be silenced by solo)
//
// This resolver runs on the UI thread when solo/mute state changes.
// The resulting effective_gain values are passed to each ChannelStrip.
//
// ═══════════════════════════════════════════════════════════════════════════

/// Per-track effective gain after solo/mute resolution.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ResolvedTrack {
    /// Track index in the project's track array.
    pub index: usize,

    /// Effective gain multiplier: 0.0 (silenced) or 1.0 (audible).
    pub effective_gain: f32,
}

/// Resolves solo/mute interactions across all tracks.
///
/// This is a stateless resolver — call `resolve()` whenever solo/mute
/// flags change, then apply the resulting gains to each `ChannelStrip`.
pub struct SoloResolver;

/// Input descriptor for a track's solo/mute state.
#[derive(Debug, Clone, Copy)]
pub struct TrackFlags {
    /// Whether this track is soloed.
    pub is_solo: bool,

    /// Whether this track is muted.
    pub is_mute: bool,

    /// Whether this track is the master track.
    pub is_master: bool,
}

impl SoloResolver {
    /// Resolves effective gain for all tracks based on their solo/mute flags.
    ///
    /// # Arguments
    /// - `tracks`: Slice of `TrackFlags` for each track (ordered by track index).
    ///
    /// # Returns
    /// A vector of `ResolvedTrack` with the effective gain for each track.
    ///
    /// # Logic
    /// 1. Scan for any non-master soloed track.
    /// 2. If ANY solo exists: silence all non-soloed, non-master tracks.
    /// 3. Muted tracks are always silenced, even if soloed.
    /// 4. Master track is never silenced by solo logic.
    pub fn resolve(tracks: &[TrackFlags]) -> Vec<ResolvedTrack> {
        let any_solo = tracks.iter().any(|t| t.is_solo && !t.is_master);

        tracks
            .iter()
            .enumerate()
            .map(|(index, flags)| {
                let effective_gain = Self::resolve_single(flags, any_solo);
                ResolvedTrack {
                    index,
                    effective_gain,
                }
            })
            .collect()
    }

    /// Resolves a single track's effective gain.
    #[inline]
    fn resolve_single(flags: &TrackFlags, any_solo: bool) -> f32 {
        // Rule 3: Mute ALWAYS wins
        if flags.is_mute {
            return 0.0;
        }

        // Rule 4: Master is always audible
        if flags.is_master {
            return 1.0;
        }

        // Rule 2: If any track is soloed, only soloed tracks play
        if any_solo && !flags.is_solo {
            return 0.0;
        }

        // Rule 1: Normal playback
        1.0
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    fn flags(is_solo: bool, is_mute: bool, is_master: bool) -> TrackFlags {
        TrackFlags {
            is_solo,
            is_mute,
            is_master,
        }
    }

    #[test]
    fn no_solo_no_mute_all_play() {
        let tracks = vec![
            flags(false, false, false),
            flags(false, false, false),
            flags(false, false, true), // Master
        ];

        let resolved = SoloResolver::resolve(&tracks);

        assert_eq!(resolved[0].effective_gain, 1.0);
        assert_eq!(resolved[1].effective_gain, 1.0);
        assert_eq!(resolved[2].effective_gain, 1.0);
    }

    #[test]
    fn solo_silences_non_soloed() {
        let tracks = vec![
            flags(true, false, false),  // Soloed
            flags(false, false, false), // Not soloed → silenced
            flags(false, false, false), // Not soloed → silenced
            flags(false, false, true),  // Master → always audible
        ];

        let resolved = SoloResolver::resolve(&tracks);

        assert_eq!(resolved[0].effective_gain, 1.0); // Soloed
        assert_eq!(resolved[1].effective_gain, 0.0); // Silenced
        assert_eq!(resolved[2].effective_gain, 0.0); // Silenced
        assert_eq!(resolved[3].effective_gain, 1.0); // Master always plays
    }

    #[test]
    fn multi_solo() {
        let tracks = vec![
            flags(true, false, false),  // Soloed
            flags(true, false, false),  // Also soloed
            flags(false, false, false), // Not soloed → silenced
        ];

        let resolved = SoloResolver::resolve(&tracks);

        assert_eq!(resolved[0].effective_gain, 1.0);
        assert_eq!(resolved[1].effective_gain, 1.0);
        assert_eq!(resolved[2].effective_gain, 0.0);
    }

    #[test]
    fn mute_overrides_solo() {
        let tracks = vec![
            flags(true, true, false),   // Soloed + Muted → MUTED wins
            flags(false, false, false), // Not soloed → silenced because solo exists
        ];

        let resolved = SoloResolver::resolve(&tracks);

        assert_eq!(resolved[0].effective_gain, 0.0); // Mute wins
        assert_eq!(resolved[1].effective_gain, 0.0); // Silenced by solo
    }

    #[test]
    fn mute_only() {
        let tracks = vec![
            flags(false, true, false),  // Muted
            flags(false, false, false), // Normal
        ];

        let resolved = SoloResolver::resolve(&tracks);

        assert_eq!(resolved[0].effective_gain, 0.0); // Muted
        assert_eq!(resolved[1].effective_gain, 1.0); // Normal
    }

    #[test]
    fn master_always_audible() {
        let tracks = vec![
            flags(true, false, false), // Soloed
            flags(false, false, true), // Master
        ];

        let resolved = SoloResolver::resolve(&tracks);

        assert_eq!(resolved[0].effective_gain, 1.0);
        assert_eq!(resolved[1].effective_gain, 1.0); // Master survives solo
    }

    #[test]
    fn master_can_be_muted() {
        // Even master respects explicit mute
        let tracks = vec![
            flags(false, false, false),
            flags(false, true, true), // Master + Muted
        ];

        let resolved = SoloResolver::resolve(&tracks);

        assert_eq!(resolved[0].effective_gain, 1.0);
        assert_eq!(resolved[1].effective_gain, 0.0); // Master muted
    }

    #[test]
    fn empty_tracks() {
        let resolved = SoloResolver::resolve(&[]);
        assert!(resolved.is_empty());
    }

    #[test]
    fn single_track_solo() {
        // Solo with only one track — should still play
        let tracks = vec![flags(true, false, false)];
        let resolved = SoloResolver::resolve(&tracks);
        assert_eq!(resolved[0].effective_gain, 1.0);
    }

    #[test]
    fn resolved_indices_are_correct() {
        let tracks = vec![
            flags(false, false, false),
            flags(true, false, false),
            flags(false, false, false),
        ];

        let resolved = SoloResolver::resolve(&tracks);

        assert_eq!(resolved[0].index, 0);
        assert_eq!(resolved[1].index, 1);
        assert_eq!(resolved[2].index, 2);
    }
}
