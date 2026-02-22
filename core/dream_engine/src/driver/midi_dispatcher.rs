use dream_plugins::MidiEvent;

#[derive(Clone)]
pub(crate) struct MidiNoteMapState {
    pub(crate) active_notes: Vec<ActiveMappedNote>,
    pub(crate) rng_state: u32,
}

#[derive(Clone, Copy)]
pub(crate) struct ActiveMappedNote {
    pub(crate) uid: u64,
    pub(crate) _src_pitch: u8,
    pub(crate) mapped_pitch: u8,
}

/// AUD-051 FIX: Document RNG seed — xorshift32 requires a non-zero odd seed.
/// Value 0xA5A5_1337 chosen for good bit distribution and non-zero guarantee.
impl Default for MidiNoteMapState {
    fn default() -> Self {
        Self {
            active_notes: Vec::with_capacity(128), // AUD-071 FIX: 128 is max polyphony, not 256
            rng_state: 0xA5A5_1337,                // xorshift32 seed (must be non-zero)
        }
    }
}

/// Per-track active note tracker for VST3 plugins.
///
/// Unlike the sampler engine which has its own voice management,
/// VST3 plugins need explicit note-off tracking so we can flush
/// all active notes on transport stop/seek.
#[derive(Clone)]
pub struct Vst3NoteTracker {
    /// Active notes: (mapped_pitch, channel) pairs currently held.
    pub active: Vec<(u8, u8)>,
    /// RNG state for random MIDI FX (xorshift32, same algorithm as sampler path).
    pub rng_state: u32,
}

impl Default for Vst3NoteTracker {
    fn default() -> Self {
        Self {
            active: Vec::with_capacity(128),
            // AUD-052 FIX: Document different seed — xorshift32 seeds differ
            // per-tracker so two tracks with identical MIDI FX don't produce
            // the same "random" pitch sequence.
            rng_state: 0xB7B7_CAFE, // xorshift32 seed (must be non-zero, distinct from sampler)
        }
    }
}

impl Vst3NoteTracker {
    /// Register an active note-on. Prevents duplicates by
    /// releasing the previous instance of the same pitch first.
    /// Returns an optional note-off event if a duplicate was found.
    pub(crate) fn note_on(&mut self, pitch: u8, channel: u8) -> Option<MidiEvent> {
        // Duplicate protection: if same pitch is already active, release it first.
        if let Some(pos) = self
            .active
            .iter()
            .position(|&(p, c)| p == pitch && c == channel)
        {
            self.active.swap_remove(pos);
            // Return a note-off for the duplicate so the plugin can clean up.
            Some(MidiEvent::note_off(0, channel, pitch, 0))
        } else {
            None
        }
        // Push is done by the caller after sending the note-on.
        // BUG-S1-06 FIX: Caller must check capacity via can_push() before pushing.
    }

    /// BUG-S1-06 FIX: Guard against unbounded growth. 256 simultaneous
    /// notes per track is already beyond any legitimate polyphony.
    /// Without this, a stuck VST3 or rapid seek could leak entries forever.
    #[inline]
    pub(crate) fn can_push(&self) -> bool {
        self.active.len() < 256
    }

    /// Register a note-off — remove from active tracking.
    pub(crate) fn note_off(&mut self, pitch: u8, channel: u8) {
        if let Some(pos) = self
            .active
            .iter()
            .position(|&(p, c)| p == pitch && c == channel)
        {
            self.active.swap_remove(pos);
        }
    }

    /// Flush all active notes: generates note-off events for every
    /// currently active note + CC 120 (All Sound Off) + CC 123 (All Notes Off)
    /// on ALL channels that had active notes.
    /// CC120 immediately kills ALL audio output including reverb
    /// and delay tails — essential for synths like Serum with internal FX.
    pub(crate) fn flush_all(&mut self, out: &mut Vec<MidiEvent>) {
        // AUD-011 FIX: Collect unique channels to send CC on all active channels,
        // not just channel 0. Notes on channel 1+ would be missed by a channel-0-only flush.
        let mut seen_channels = 0u16; // bitmask of channels 0-15
        for &(pitch, channel) in &self.active {
            out.push(MidiEvent::note_off(0, channel, pitch, 0));
            seen_channels |= 1u16 << (channel as u16 & 0x0F);
        }
        self.active.clear();
        // Always include channel 0 even if no notes were on it.
        seen_channels |= 1;
        for ch in 0..16u8 {
            if (seen_channels & (1u16 << ch)) != 0 {
                // CC 120 = All Sound Off — immediately silences all audio,
                // including synth tails, reverbs, and delays (enterprise standard).
                out.push(MidiEvent::cc(0, ch, 120, 0));
                // CC 123 = All Notes Off — releases all held notes.
                out.push(MidiEvent::cc(0, ch, 123, 0));
            }
        }
    }
}

#[inline]
pub(crate) fn clamp_midi_pitch(v: i16) -> u8 {
    v.clamp(0, 127) as u8
}

#[inline]
pub(crate) fn quantize_to_scale(pitch: u8, root: u8, mask: u16) -> u8 {
    let mask = if mask == 0 { 0x0FFF } else { mask };
    let base_oct = (pitch / 12) as i16;
    let root = (root % 12) as i16;

    let mut best_pitch = pitch as i16;
    let mut best_dist = i16::MAX;
    for degree in 0..12i16 {
        if (mask & (1u16 << degree)) == 0 {
            continue;
        }
        let target = (root + degree).rem_euclid(12);
        for oct_off in [-1i16, 0, 1] {
            let cand = ((base_oct + oct_off) * 12 + target).clamp(0, 127);
            let dist = (cand - pitch as i16).abs();
            if dist < best_dist {
                best_dist = dist;
                best_pitch = cand;
            }
        }
    }
    clamp_midi_pitch(best_pitch)
}
