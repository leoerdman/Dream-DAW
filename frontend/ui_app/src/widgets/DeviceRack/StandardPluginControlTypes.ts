export interface PluginParam {
    name: string;
    value: number;
    min: number;
    max: number;
    suffix: string;
    step?: number;
    defaultValue?: number;
}
