import { Copy, GripVertical, Sparkles, Trash2, X } from 'lucide-react';

interface AssistantChatHeaderProps {
    model: string;
    setModel: (value: string) => void;
    models: Array<{ id: string; label: string }>;
    onCopyHistory: () => void;
    onClearHistory: () => void;
    onClose: () => void;
    onHeaderMouseDown: (e: React.MouseEvent) => void;
}

export function AssistantChatHeader({
    model,
    setModel,
    models,
    onCopyHistory,
    onClearHistory,
    onClose,
    onHeaderMouseDown,
}: AssistantChatHeaderProps) {
    return (
        <div className="assistant-header" onPointerDown={onHeaderMouseDown}>
            <div className="assistant-header-left">
                <GripVertical size={14} style={{ color: 'var(--color-text-tertiary)', marginRight: -4 }} />
                <div className="assistant-header-icon">
                    <Sparkles size={14} />
                </div>
                <span className="assistant-header-title">Dream AI</span>
            </div>

            <div className="assistant-header-actions">
                <select className="model-selector-dropdown" value={model} onChange={(e) => setModel(e.target.value)}>
                    {models.map((m) => (
                        <option key={m.id} value={m.id}>
                            {m.label}
                        </option>
                    ))}
                </select>
                <button className="assistant-mini-btn" onClick={onCopyHistory} title="Copy full history to clipboard">
                    <Copy size={14} />
                </button>
                <button className="assistant-mini-btn" onClick={onClearHistory} title="Clear history">
                    <Trash2 size={14} />
                </button>
                <button className="assistant-mini-btn" onClick={onClose} title="Close">
                    <X size={14} />
                </button>
            </div>
        </div>
    );
}
