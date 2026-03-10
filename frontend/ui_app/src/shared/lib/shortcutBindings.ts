export type ShortcutActionId =
    | 'toggle_track_automation_visibility'
    | 'create_envelope_last_touched'
    | 'glue_clips'
    | 'split_clips'
    | 'grid_double_size'
    | 'grid_half_size'
    | 'create_automation_item'
    | 'delete_automation_item'
    | 'pitch_plus_12'
    | 'pitch_minus_12'
    | 'panic_custom'
    | 'region_duplicate'
    | 'region_move_left'
    | 'region_move_right'
    | 'region_capture_a'
    | 'region_capture_b'
    | 'region_swap_a_b'
    | 'zoom_in'
    | 'zoom_out';

export interface ShortcutDefinition {
    id: ShortcutActionId;
    label: string;
    description: string;
    defaultCombo: string;
}

export const SHORTCUT_DEFINITIONS: ShortcutDefinition[] = [
    {
        id: 'toggle_track_automation_visibility',
        label: 'Automation: Toggle selected track',
        description: 'Show/hide all automation lanes for selected track',
        defaultCombo: 'Shift+A',
    },
    {
        id: 'create_envelope_last_touched',
        label: 'Automation: New envelope (last touched param)',
        description: 'Create/open envelope for last touched plugin parameter',
        defaultCombo: 'Alt+A',
    },
    {
        id: 'glue_clips',
        label: 'Glue',
        description: 'Merge selected clips on same track',
        defaultCombo: 'Cmd+J',
    },
    {
        id: 'split_clips',
        label: 'Split',
        description: 'Split clips at edit cursor/playhead',
        defaultCombo: 'Cmd+E',
    },
    {
        id: 'grid_double_size',
        label: 'Grid x2 (coarser)',
        description: 'Make grid cells 2x larger',
        defaultCombo: 'Cmd+1',
    },
    {
        id: 'grid_half_size',
        label: 'Grid /2 (finer)',
        description: 'Make grid cells 2x smaller',
        defaultCombo: 'Cmd+2',
    },
    {
        id: 'create_automation_item',
        label: 'Automation item: Create',
        description: 'Create loop-ready automation item at cursor',
        defaultCombo: 'Alt+Shift+A',
    },
    {
        id: 'delete_automation_item',
        label: 'Automation item: Delete',
        description: 'Delete nearest automation item at cursor',
        defaultCombo: 'Alt+Backspace',
    },
    {
        id: 'pitch_plus_12',
        label: 'Clip pitch +12',
        description: 'Transpose selected clips up one octave',
        defaultCombo: 'Shift+Up',
    },
    {
        id: 'pitch_minus_12',
        label: 'Clip pitch -12',
        description: 'Transpose selected clips down one octave',
        defaultCombo: 'Shift+Down',
    },
    {
        id: 'panic_custom',
        label: 'Panic (custom)',
        description: 'Close plugin windows, reset zoom, hide all automation',
        defaultCombo: 'Shift+Escape',
    },
    {
        id: 'region_duplicate',
        label: 'Region: Duplicate marquee',
        description: 'Duplicate selected timeline region (all clips in box)',
        defaultCombo: 'Alt+Shift+D',
    },
    {
        id: 'region_move_left',
        label: 'Region: Move left',
        description: 'Move selected timeline region left by its own length',
        defaultCombo: 'Alt+Shift+Left',
    },
    {
        id: 'region_move_right',
        label: 'Region: Move right',
        description: 'Move selected timeline region right by its own length',
        defaultCombo: 'Alt+Shift+Right',
    },
    {
        id: 'region_capture_a',
        label: 'Region: Capture A',
        description: 'Save current marquee as region A',
        defaultCombo: 'Alt+Shift+1',
    },
    {
        id: 'region_capture_b',
        label: 'Region: Capture B',
        description: 'Save current marquee as region B',
        defaultCombo: 'Alt+Shift+2',
    },
    {
        id: 'region_swap_a_b',
        label: 'Region: Swap A/B',
        description: 'Swap clips between captured region A and B',
        defaultCombo: 'Alt+Shift+3',
    },
    {
        id: 'zoom_in',
        label: 'Zoom In',
        description: 'Zoom in horizontally in the arrangement view',
        defaultCombo: 'Cmd+=',
    },
    {
        id: 'zoom_out',
        label: 'Zoom Out',
        description: 'Zoom out horizontally in the arrangement view',
        defaultCombo: 'Cmd+-',
    },
];

const DEFINITION_BY_ID: Record<ShortcutActionId, ShortcutDefinition> = SHORTCUT_DEFINITIONS.reduce((acc, def) => {
    acc[def.id] = def;
    return acc;
}, {} as Record<ShortcutActionId, ShortcutDefinition>);

export const DEFAULT_SHORTCUT_BINDINGS: Record<ShortcutActionId, string> = SHORTCUT_DEFINITIONS.reduce((acc, def) => {
    acc[def.id] = def.defaultCombo;
    return acc;
}, {} as Record<ShortcutActionId, string>);

export function getShortcutDefinition(actionId: ShortcutActionId): ShortcutDefinition {
    return DEFINITION_BY_ID[actionId];
}

const ORDERED_MODS = ['Cmd', 'Ctrl', 'Alt', 'Shift'] as const;

function normalizeKeyToken(token: string): string {
    const raw = token.trim();
    if (!raw) return '';
    const lowered = raw.toLowerCase();

    if (lowered === 'cmd' || lowered === 'meta' || lowered === 'mod') return 'Cmd';
    if (lowered === 'ctrl' || lowered === 'control') return 'Ctrl';
    if (lowered === 'alt' || lowered === 'option') return 'Alt';
    if (lowered === 'shift') return 'Shift';

    if (lowered === 'space' || lowered === 'spacebar') return 'Space';
    if (lowered === 'escape' || lowered === 'esc') return 'Escape';
    if (lowered === 'enter' || lowered === 'return') return 'Enter';
    if (lowered === 'backspace' || lowered === 'delete') return 'Backspace';

    if (lowered === 'arrowup' || lowered === 'up') return 'Up';
    if (lowered === 'arrowdown' || lowered === 'down') return 'Down';
    if (lowered === 'arrowleft' || lowered === 'left') return 'Left';
    if (lowered === 'arrowright' || lowered === 'right') return 'Right';

    if (/^f\d{1,2}$/i.test(raw)) return raw.toUpperCase();
    if (/^[a-z]$/i.test(raw)) return raw.toUpperCase();
    if (/^\d$/.test(raw)) return raw;

    return raw;
}

export function normalizeShortcutCombo(combo: string): string {
    const rawTokens = combo
        .split('+')
        .map((t) => normalizeKeyToken(t))
        .filter(Boolean);

    if (rawTokens.length === 0) return '';

    const mods = new Set<string>();
    let key = '';
    for (const token of rawTokens) {
        if (ORDERED_MODS.includes(token as (typeof ORDERED_MODS)[number])) {
            mods.add(token);
        } else {
            key = token;
        }
    }

    if (!key) {
        key = rawTokens[rawTokens.length - 1];
    }

    const orderedMods = ORDERED_MODS.filter((mod) => mods.has(mod));
    return [...orderedMods, key].join('+');
}

function keyFromEvent(e: KeyboardEvent): string {
    const { code, key } = e;
    if (code.startsWith('Key')) return code.slice(3).toUpperCase();
    if (code.startsWith('Digit')) return code.slice(5);
    if (code.startsWith('Numpad')) {
        const value = code.slice(6);
        if (/^\d$/.test(value)) return value;
    }

    if (key === ' ') return 'Space';
    if (key === 'Escape') return 'Escape';
    if (key === 'Enter') return 'Enter';
    if (key === 'Backspace' || key === 'Delete') return 'Backspace';
    if (key === 'ArrowUp') return 'Up';
    if (key === 'ArrowDown') return 'Down';
    if (key === 'ArrowLeft') return 'Left';
    if (key === 'ArrowRight') return 'Right';
    if (/^F\d{1,2}$/i.test(key)) return key.toUpperCase();
    if (/^[a-z]$/i.test(key)) return key.toUpperCase();
    if (/^\d$/.test(key)) return key;

    return normalizeKeyToken(key);
}

export function comboFromKeyboardEvent(e: KeyboardEvent): string {
    const parts: string[] = [];
    if (e.metaKey) parts.push('Cmd');
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    parts.push(keyFromEvent(e));
    return normalizeShortcutCombo(parts.join('+'));
}

export function isShortcutMatch(e: KeyboardEvent, combo: string): boolean {
    const normalized = normalizeShortcutCombo(combo);
    if (!normalized) return false;
    return comboFromKeyboardEvent(e) === normalized;
}
