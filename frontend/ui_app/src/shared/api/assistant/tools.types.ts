export interface AssistantToolParameters {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
}

export interface AssistantToolDefinition {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: AssistantToolParameters;
    };
}
