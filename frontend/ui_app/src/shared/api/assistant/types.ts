export interface ToolCall {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
}

export interface ChatMessage {
    role: 'user' | 'assistant' | 'tool';
    content: string;
    name?: string;
    tool_call_id?: string;
    thinking?: string;
    actions?: Array<{
        toolName: string;
        args: Record<string, unknown>;
        result: string | null;
        index: number;
    }>;
    tool_calls?: ToolCall[];
}

export interface MidiNoteLike {
    pitch: number;
    startBeat: number;
    durationBeats: number;
    velocity: number;
}

export const getOptionalStringField = (value: object, key: string): string | undefined => {
    const raw = (value as Record<string, unknown>)[key];
    return typeof raw === 'string' ? raw : undefined;
};
