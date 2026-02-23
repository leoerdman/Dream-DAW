import { Loader } from 'lucide-react';
import { DEFAULT_META, TOOL_META } from './agentActionMeta';
import { formatToolResult } from './agentResultFormatter';

interface AgentActionStepProps {
    toolName: string;
    args: Record<string, unknown>;
    result: string | null;
    isExecuting?: boolean;
}

export function AgentActionStep({ toolName, args, result, isExecuting }: AgentActionStepProps) {
    const meta = TOOL_META[toolName] || DEFAULT_META;
    const Icon = meta.icon;
    const resultText = result !== null ? formatToolResult(toolName, result) : null;

    return (
        <div className={`agent-step ${isExecuting ? 'executing' : ''}`}>
            <div className="agent-step-header">
                <div className="agent-step-icon" style={{ color: meta.categoryColor }}>
                    {isExecuting ? <Loader size={12} className="spin-icon" /> : <Icon size={12} />}
                </div>
                <span className="agent-step-name">{meta.describe(args)}</span>
                <span className="agent-step-badge" style={{ background: meta.categoryColor }}>
                    {meta.category}
                </span>
            </div>
            {resultText !== null && <div className="agent-step-result">{resultText}</div>}
        </div>
    );
}
