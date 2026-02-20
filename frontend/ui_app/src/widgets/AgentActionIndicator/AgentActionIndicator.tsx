/* ═══════════════════════════════════════════════════════════════════════════
 * Dream DAW — Agent Action Indicator Overlay
 *
 * Floating blue pulse indicators that appear when AI agent performs actions.
 * Each indicator shows the action name, pulses with a blue glow, and
 * fades out over 3 seconds.
 * ═══════════════════════════════════════════════════════════════════════════ */

import { useAgentActionStore, type AgentActionToast } from '@/shared/stores/useAgentActionStore';
import './AgentActionIndicator.css';

// ── Single Toast ─────────────────────────────────────────────────────────────

function ActionToast({ toast }: { toast: AgentActionToast }) {
    return (
        <div className="agent-action-toast" key={toast.id}>
            <div className="agent-action-orb" />
            <span className="agent-action-label">{toast.label}</span>
        </div>
    );
}

// ── Overlay ──────────────────────────────────────────────────────────────────

export function AgentActionIndicator() {
    const toasts = useAgentActionStore((s) => s.toasts);

    if (toasts.length === 0) return null;

    return (
        <div className="agent-action-overlay">
            {toasts.map((t) => (
                <ActionToast key={t.id} toast={t} />
            ))}
        </div>
    );
}
