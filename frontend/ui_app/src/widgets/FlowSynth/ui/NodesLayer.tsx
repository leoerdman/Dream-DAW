import { useEffect, useRef } from 'react';
import { useFlowSynthStore } from '../model/useFlowSynthStore';
import { viewportProxy } from '../lib/ViewportProxy';
import { SynthNodeComponent } from './SynthNodeComponent';

export function NodesLayer() {
    const nodes = useFlowSynthStore((state) => state.nodes);
    const layerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        return viewportProxy.subscribe((vp) => {
            if (layerRef.current) {
                layerRef.current.style.transform = `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})`;
            }
        });
    }, []);

    return (
        <div
            ref={layerRef}
            style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: 0,
                height: 0,
                transformOrigin: '0 0',
                willChange: 'transform',
                pointerEvents: 'none', // Let canvas handle raw pointer events, node body is 'auto'
                zIndex: 2,
            }}
        >
            {nodes.map((node) => (
                <SynthNodeComponent key={node.id} node={node} />
            ))}
        </div>
    );
}
