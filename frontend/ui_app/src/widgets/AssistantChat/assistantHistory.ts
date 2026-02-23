import type { ChatMessage } from '@/shared/api/assistantService';

export function buildHistoryText(messages: ChatMessage[]): string {
    return messages
        .map((m) => {
            let text = `[${m.role.toUpperCase()}${m.role === 'tool' && m.name ? `: ${m.name}` : ''}]\n`;
            if (m.content) text += `${m.content}\n`;
            if (m.thinking) text += `[THINKING]\n${m.thinking}\n`;
            if (m.actions && m.actions.length > 0) {
                text += '[ACTIONS]\n';
                m.actions.forEach((a) => {
                    text += ` - ${a.toolName}(${JSON.stringify(a.args)})\n   Result: ${a.result}\n`;
                });
            }
            return `${text}\n============================\n`;
        })
        .join('\n');
}

