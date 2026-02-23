/* ═══════════════════════════════════════════════════════════════════════════
 * Dream DAW — AI Assistant Service (Enterprise)
 *
 * OpenRouter API ▸ Streaming ▸ 22 DAW tools ▸ Chain-of-Thought loop
 *
 * CRITICAL FIX: tool_calls are now included in assistant messages and
 * properly serialized for the API. This fixes Claude/Anthropic 400 errors
 * where tool_result blocks couldn't find matching tool_use blocks.
 * ═══════════════════════════════════════════════════════════════════════════ */

import { TOOLS } from '@/shared/api/assistant/tools';
import {
    type ChatMessage,
    type ToolCall,
} from '@/shared/api/assistant/types';
export type { ChatMessage } from '@/shared/api/assistant/types';

import { buildSystemPrompt, executeTool } from '@/shared/api/assistant/toolExecutor';
// ─── Prepare messages for API ───────────────────────────────────────────────

/**
 * Converts internal ChatMessage[] to the OpenRouter/OpenAI API format.
 *
 * CRITICAL: Assistant messages that triggered tool calls MUST include
 * the `tool_calls` array. Without this, Claude/Anthropic returns a 400
 * because tool_result blocks can't find matching tool_use blocks.
 */
function toApiMessages(
    conversation: ChatMessage[],
    systemPrompt: string,
): Record<string, unknown>[] {
    const msgs: Record<string, unknown>[] = [
        { role: 'system', content: systemPrompt },
    ];

    for (const m of conversation) {
        if (m.role === 'tool') {
            msgs.push({
                role: 'tool',
                content: m.content,
                tool_call_id: m.tool_call_id,
            });
        } else if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
            // Assistant message WITH tool calls — must include tool_calls for API
            msgs.push({
                role: 'assistant',
                content: m.content || null,
                tool_calls: m.tool_calls,
            });
        } else {
            msgs.push({ role: m.role, content: m.content });
        }
    }

    return msgs;
}

// ─── Stream event types ─────────────────────────────────────────────────────

/** Structured events emitted during agent streaming for real-time UI. */
export type StreamEvent =
    | { type: 'thinking'; text: string }
    | { type: 'tool-start'; toolName: string; args: Record<string, unknown>; index: number }
    | { type: 'tool-end'; toolName: string; result: string; index: number }
    | { type: 'delta'; text: string }
    | { type: 'done'; conversation: ChatMessage[] }
    | { type: 'error'; message: string };

// ─── Streaming chat (event-driven) ──────────────────────────────────────────

export async function streamChat(
    messages: ChatMessage[],
    apiKey: string,
    model: string,
    onEvent: (event: StreamEvent) => void,
    onSelectClips?: (ids: string[]) => void,
    signal?: AbortSignal,
): Promise<ChatMessage[]> {
    const MAX_TOOL_DEPTH = 25; // BUG-14 FIX: Raised from 15 for complex multi-track sessions
    let depth = 0;
    const conversation = [...messages];
    let globalToolIndex = 0;

    while (depth < MAX_TOOL_DEPTH) {
        depth++;

        const systemPrompt = buildSystemPrompt();
        const apiMessages = toApiMessages(conversation, systemPrompt);

        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://dreamdaw.app',
                'X-Title': 'Dream DAW AI Assistant',
            },
            body: JSON.stringify({
                model,
                messages: apiMessages,
                tools: TOOLS,
                tool_choice: 'auto',
                stream: true,
                max_tokens: 4096,
            }),
            signal,
        });

        if (!response.ok) {
            const errText = await response.text().catch(() => 'Unknown error');
            let humanError = `API error (${response.status})`;
            try {
                const parsed = JSON.parse(errText);
                if (parsed.error?.message) {
                    humanError = parsed.error.message;
                } else if (parsed.error?.metadata?.raw) {
                    const raw = JSON.parse(parsed.error.metadata.raw);
                    humanError = raw.error?.message || humanError;
                }
            } catch { /* use default */ }
            onEvent({ type: 'error', message: humanError });
            throw new Error(humanError);
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error('No response stream');

        const decoder = new TextDecoder();
        let assistantContent = '';
        let toolCalls: ToolCall[] = [];
        let buffer = '';
        let hasEmittedContent = false;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6).trim();
                if (data === '[DONE]') continue;

                try {
                    const parsed = JSON.parse(data);
                    const delta = parsed.choices?.[0]?.delta;
                    if (!delta) continue;

                    if (delta.content) {
                        assistantContent += delta.content;
                        // Content that arrives WITH tool_calls (in same response) is thinking.
                        // Content in the FINAL response (no tool_calls) is the user-facing answer.
                        // We can't know for sure during streaming, but tool_calls almost always
                        // appear before content stops. We'll emit as 'delta' and let the
                        // tool-start event signal the UI to reclassify if needed.
                        if (toolCalls.length > 0) {
                            // Already have tool_calls in this chunk — this is thinking
                            onEvent({ type: 'thinking', text: delta.content });
                        } else {
                            if (!hasEmittedContent) {
                                hasEmittedContent = true;
                            }
                            onEvent({ type: 'delta', text: delta.content });
                        }
                    }

                    if (delta.tool_calls) {
                        for (const tc of delta.tool_calls) {
                            const idx = tc.index ?? 0;
                            if (!toolCalls[idx]) {
                                toolCalls[idx] = {
                                    id: tc.id || `tc_${idx}`,
                                    type: 'function',
                                    function: { name: '', arguments: '' },
                                };
                            }
                            if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
                            if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
                            if (tc.id) toolCalls[idx].id = tc.id;
                        }
                    }
                } catch {
                    /* skip malformed SSE chunk */
                }
            }
        }

        // Filter out empty tool calls
        toolCalls = toolCalls.filter((tc) => tc.function.name);

        // No tool calls → conversation ends with final response
        if (toolCalls.length === 0) {
            conversation.push({ role: 'assistant', content: assistantContent });
            onEvent({ type: 'done', conversation });
            return conversation;
        }

        // If we emitted deltas for content that turned out to be thinking
        // (because tool_calls appeared), the UI already received 'delta' events.
        // Re-classify: emit a 'thinking' retroactive signal is not needed because
        // the UI will see the subsequent tool-start events and understand.

        // Push assistant message WITH tool_calls to conversation
        conversation.push({
            role: 'assistant',
            content: assistantContent,
            tool_calls: toolCalls,
        });

        // Execute each tool call — emit events for each step
        for (const tc of toolCalls) {
            let args: Record<string, unknown> = {};
            try { args = JSON.parse(tc.function.arguments); } catch { /* empty */ }

            // 🔴 LIVE: Emit tool-start so UI shows the action beginning
            onEvent({
                type: 'tool-start',
                toolName: tc.function.name,
                args,
                index: globalToolIndex,
            });

            const result = await executeTool(tc.function.name, args, onSelectClips);

            conversation.push({
                role: 'tool',
                content: result,
                name: tc.function.name,
                tool_call_id: tc.id,
            });

            // 🟢 LIVE: Emit tool-end so UI shows the result
            onEvent({
                type: 'tool-end',
                toolName: tc.function.name,
                result,
                index: globalToolIndex,
            });

            globalToolIndex++;

            // BUG-15 FIX: Check abort signal between tool calls
            if (signal?.aborted) {
                onEvent({ type: 'done', conversation });
                return conversation;
            }
        }

        // Reset for next loop iteration
        assistantContent = '';
        toolCalls = [];
    }

    onEvent({ type: 'done', conversation });
    return conversation;
}
