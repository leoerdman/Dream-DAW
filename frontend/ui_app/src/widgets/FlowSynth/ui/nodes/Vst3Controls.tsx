import { nodeControlsContainerStyle } from './FlowNodeControlStyles';
import { ControlRow, NodeSelect } from './shared';
import type { SynthNode } from '../../model/useFlowSynthStore';
import { useFlowSynthStore } from '../../model/useFlowSynthStore';

interface Props {
    node: SynthNode;
}

/**
 * VST3 Controls — Plugin Selector (UI Shell)
 *
 * Full audio integration is a separate scope.
 * For now, shows a dropdown to select from available scanned plugins.
 */
export function Vst3Controls({ node }: Props) {
    const updateNodeData = useFlowSynthStore((s) => s.updateNodeData);
    const pluginName = (node.data?.pluginName as string) ?? '';

    return (
        <div style={nodeControlsContainerStyle}>
            <ControlRow label="Plugin">
                <NodeSelect
                    value={pluginName}
                    options={[
                        { value: '', label: '— Select —' },
                        { value: '(scanned)', label: '(Scanned plugins)' },
                    ]}
                    onChange={(v) => updateNodeData(node.id, { pluginName: v })}
                />
            </ControlRow>
        </div>
    );
}

