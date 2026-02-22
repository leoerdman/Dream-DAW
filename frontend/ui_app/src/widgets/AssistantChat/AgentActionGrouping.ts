import type { ChatMessage } from '@/shared/api/assistantService';

export interface ActionGroup {
    thinking: string;
    actions: {
        toolName: string;
        args: Record<string, unknown>;
        result: string;
    }[];
    finalResponse: string;
}

export function groupMessagesIntoActions(messages: ChatMessage[]): (ChatMessage | ActionGroup)[] {
    const result: (ChatMessage | ActionGroup)[] = [];
    let i = 0;

    while (i < messages.length) {
        const msg = messages[i];

        if (msg.role === 'user') {
            result.push(msg);
            i++;
            continue;
        }

        if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
            const group: ActionGroup = {
                thinking: msg.content || '',
                actions: [],
                finalResponse: '',
            };

            for (const tc of msg.tool_calls) {
                let args: Record<string, unknown> = {};
                try { args = JSON.parse(tc.function.arguments); } catch { /* empty */ }
                group.actions.push({ toolName: tc.function.name, args, result: '' });
            }

            let j = i + 1;
            while (j < messages.length && messages[j].role === 'tool') {
                const toolMsg = messages[j];
                const matchAction = group.actions.find(
                    (a) => !a.result && a.toolName === toolMsg.name,
                );
                if (matchAction) matchAction.result = toolMsg.content;
                j++;
            }

            while (j < messages.length) {
                const nextMsg = messages[j];
                if (nextMsg.role === 'assistant' && nextMsg.tool_calls && nextMsg.tool_calls.length > 0) {
                    if (nextMsg.content) group.thinking += '\n' + nextMsg.content;
                    for (const tc of nextMsg.tool_calls) {
                        let args: Record<string, unknown> = {};
                        try { args = JSON.parse(tc.function.arguments); } catch { /* empty */ }
                        group.actions.push({ toolName: tc.function.name, args, result: '' });
                    }
                    j++;
                    while (j < messages.length && messages[j].role === 'tool') {
                        const toolMsg = messages[j];
                        const matchAction = group.actions.find(
                            (a) => !a.result && a.toolName === toolMsg.name,
                        );
                        if (matchAction) matchAction.result = toolMsg.content;
                        j++;
                    }
                } else if (nextMsg.role === 'assistant' && !nextMsg.tool_calls) {
                    group.finalResponse = nextMsg.content;
                    j++;
                    break;
                } else {
                    break;
                }
            }

            result.push(group);
            i = j;
            continue;
        }

        if (msg.role === 'assistant') {
            result.push(msg);
            i++;
            continue;
        }

        i++;
    }

    return result;
}

export function isActionGroup(item: ChatMessage | ActionGroup): item is ActionGroup {
    return 'actions' in item && Array.isArray((item as ActionGroup).actions);
}
