import type { ProjectTrack } from '../stores/useEngineStore';

/**
 * Replicates the Rust audio engine's hierarchical solo/mute routing algorithm.
 * 
 * Determines if a track is "active" (audible / participating in the mix).
 * A track is active if:
 * 1. It is not explicitly muted.
 * 2. If ANY track in the project is soloed, this track must be:
 *    a) Explicitly soloed, OR
 *    b) An ancestor of an explicitly soloed track (UP propagation - group carries child signal), OR
 *    c) A descendant of an explicitly soloed track (DOWN propagation - soloing group solos its children).
 */
export function isTrackActive(
    trackIndex: number,
    tracks: ProjectTrack[]
): boolean {
    const track = tracks[trackIndex];
    if (!track) return false;

    // 1. Explicit Mute always wins
    if (track.is_mute) {
        return false;
    }

    // Determine if any track is explicitly soloed (ignoring the Master track)
    const anySoloed = tracks.some(t => t.is_solo && t.track_type?.toLowerCase() !== 'master');
    if (!anySoloed) {
        return true;
    }

    // 2. If explicitly soloed itself
    if (track.is_solo) {
        return true;
    }

    // 3. Check if any DESCENDANT is explicitly soloed (UP propagation)
    // A track is an ancestor if we can reach it by following `output` from a soloed track.
    const isAncestorOfSoloed = tracks.some((childTrack) => {
        if (!childTrack.is_solo) return false;

        let current = childTrack.output;
        const visited = new Set<string>();

        while (current && current !== 'master') {
            if (visited.has(current)) break; // Prevent infinite loop on cycles
            visited.add(current);

            // Reached the track we are testing?
            if (current === track.id) {
                return true;
            }

            // Move up
            const parent = tracks.find(t => t.id === current);
            if (!parent) break;
            current = parent.output;
        }
        return false;
    });

    if (isAncestorOfSoloed) {
        return true;
    }

    // 4. Check if any ANCESTOR is explicitly soloed (DOWN propagation)
    // We walk up from trackIndex and check if any parent is soloed.
    let current = track.output;
    const visited = new Set<string>();

    while (current && current !== 'master') {
        if (visited.has(current)) break; // Prevent infinite loop
        visited.add(current);

        const parent = tracks.find(t => t.id === current);
        if (!parent) break;

        if (parent.is_solo) {
            return true;
        }

        current = parent.output;
    }

    // Not soloed, no soloed children, no soloed parents -> dimmed
    return false;
}
