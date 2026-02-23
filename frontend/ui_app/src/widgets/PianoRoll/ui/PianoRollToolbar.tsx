import { memo } from 'react';
import type { PianoRollToolbarProps } from '@/widgets/PianoRoll/model/pianoRollTypes';
import { PianoRollToolbarLeft, PianoRollToolbarRight } from '@/widgets/PianoRoll/ui/PianoRollToolbarSections';

export const PianoRollToolbar = memo(function PianoRollToolbar(props: PianoRollToolbarProps) {
    const { editorRootRef } = props;

    return (
        <div
            onMouseDown={(e) => {
                const target = e.target as HTMLElement;
                if (target.tagName !== 'SELECT') {
                    e.preventDefault();
                }
                requestAnimationFrame(() => editorRootRef.current?.focus());
            }}
            style={{
                height: 'var(--daw-transport-height)',
                display: 'flex',
                alignItems: 'center',
                padding: '0 var(--space-2)',
                gap: 'var(--space-1)',
                background: 'var(--color-bg-elevated)',
                borderBottom: 'var(--space-px) solid var(--color-divider)',
                flexShrink: 0,
            }}
        >
            <PianoRollToolbarLeft {...props} />
            <PianoRollToolbarRight {...props} />
        </div>
    );
});
