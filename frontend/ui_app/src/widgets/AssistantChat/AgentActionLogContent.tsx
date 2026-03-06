import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { AgentActionStep } from './AgentActionStep';

/** Duration to show "Copied" confirmation (ms). */
const COPY_FEEDBACK_MS = 2000;

interface ActionLogContentProps {
    thinking: string;
    actions: { toolName: string; args: Record<string, unknown>; result: string | null }[];
    isLive?: boolean;
}

export function AgentActionLogContent({ thinking, actions, isLive }: ActionLogContentProps) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        if (isLive && scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [thinking, actions, isLive]);

    return (
        <div className="agent-log-scroll" ref={scrollRef}>
            {thinking && (
                <div className="agent-thinking">
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <span className="agent-thinking-label">💭 Reasoning</span>
                        <button
                            className="assistant-copy-btn"
                            title="Copy reasoning"
                            onClick={() => {
                                navigator.clipboard.writeText(thinking);
                                setCopied(true);
                                setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
                            }}
                            style={{ padding: 'var(--space-0-5) var(--space-1)', marginLeft: 4 }}
                        >
                            {copied ? <Check size={10} style={{ color: 'var(--color-status-success)' }} /> : <Copy size={10} />}
                        </button>
                    </div>
                    <p>
                        {thinking}
                        {isLive && <span className="streaming-cursor" />}
                    </p>
                </div>
            )}
            {actions.length > 0 && (
                <div className="agent-steps">
                    {actions.map((action, idx) => (
                        <AgentActionStep
                            key={idx}
                            toolName={action.toolName}
                            args={action.args}
                            result={action.result}
                            isExecuting={isLive && action.result === null}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}
