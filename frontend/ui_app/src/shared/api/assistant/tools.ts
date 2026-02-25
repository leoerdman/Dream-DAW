import type { AssistantToolDefinition } from '@/shared/api/assistant/tools.types';
import { TOOL_DEFS_CORE_A } from '@/shared/api/assistant/toolsRegistry.coreA';
import { TOOL_DEFS_CORE_B } from '@/shared/api/assistant/toolsRegistry.coreB';
import { TOOL_DEFS_ADV_A } from '@/shared/api/assistant/toolsRegistry.advancedA';
import { TOOL_DEFS_ADV_B } from '@/shared/api/assistant/toolsRegistry.advancedB';
import { TOOL_DEFS_EXT_A } from '@/shared/api/assistant/toolsRegistry.extendedA';
import { TOOL_DEFS_EXT_B } from '@/shared/api/assistant/toolsRegistry.extendedB';

export const TOOLS: AssistantToolDefinition[] = [
    ...TOOL_DEFS_CORE_A,
    ...TOOL_DEFS_CORE_B,
    ...TOOL_DEFS_ADV_A,
    ...TOOL_DEFS_ADV_B,
    ...TOOL_DEFS_EXT_A,
    ...TOOL_DEFS_EXT_B,
];
