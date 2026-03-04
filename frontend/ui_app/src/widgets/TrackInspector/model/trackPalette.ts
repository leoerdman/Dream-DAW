/* eslint-disable no-restricted-syntax */

/**
 * Dream DAW — Track/Clip Color Palette (Ableton Live 12 compatible)
 *
 * Layout: 5 rows (light → dark) × 14 hue columns.
 * Each column is a hue family; each row darkens progressively.
 * Exact hex values from Ableton Live 12's stock palette (indices 0-69).
 */
export const TRACK_PALETTE = [
    // Row 1 — Bright / Pastel
    { name: 'Pastel Rose', hex: '#FE9AAA' },
    { name: 'Pastel Orange', hex: '#FEA741' },
    { name: 'Pastel Gold', hex: '#D19D3A' },
    { name: 'Pastel Yellow', hex: '#F7F58C' },
    { name: 'Pastel Lime', hex: '#C1FC40' },
    { name: 'Pastel Green', hex: '#2DFE50' },
    { name: 'Pastel Teal', hex: '#34FEAF' },
    { name: 'Pastel Cyan', hex: '#65FFEA' },
    { name: 'Pastel Sky', hex: '#90C7FC' },
    { name: 'Pastel Blue', hex: '#5C86E1' },
    { name: 'Pastel Indigo', hex: '#97ABFB' },
    { name: 'Pastel Purple', hex: '#D975E2' },
    { name: 'Pastel Pink', hex: '#E55CA2' },
    { name: 'White', hex: '#FFFFFF' },

    // Row 2 — Saturated
    { name: 'Red', hex: '#FE3E40' },
    { name: 'Orange', hex: '#F76F23' },
    { name: 'Brown', hex: '#9F7752' },
    { name: 'Yellow', hex: '#FFF054' },
    { name: 'Lime Green', hex: '#8DFF79' },
    { name: 'Green', hex: '#42C52E' },
    { name: 'Teal', hex: '#11C2B2' },
    { name: 'Cyan', hex: '#28E9FD' },
    { name: 'Azure', hex: '#1AA6EB' },
    { name: 'Blue', hex: '#5C86E1' },
    { name: 'Indigo', hex: '#8E74E2' },
    { name: 'Lavender', hex: '#BA81C7' },
    { name: 'Hot Pink', hex: '#FE41D1' },
    { name: 'Light Gray', hex: '#D9D9D9' },

    // Row 3 — Muted / Soft
    { name: 'Muted Coral', hex: '#E26F64' },
    { name: 'Peach', hex: '#FEA67E' },
    { name: 'Tan', hex: '#D6B27F' },
    { name: 'Pale Yellow', hex: '#EEFFB7' },
    { name: 'Sage', hex: '#D6E6A6' },
    { name: 'Olive', hex: '#BFD383' },
    { name: 'Muted Green', hex: '#A4C99A' },
    { name: 'Mint', hex: '#D9FDE5' },
    { name: 'Ice Blue', hex: '#D2F3F9' },
    { name: 'Muted Lavender', hex: '#C2C9E6' },
    { name: 'Muted Purple', hex: '#D3C4E5' },
    { name: 'Wisteria', hex: '#B5A1E4' },
    { name: 'Blush', hex: '#EAE3E7' },
    { name: 'Gray', hex: '#B3B3B3' },

    // Row 4 — Desaturated
    { name: 'Dusty Rose', hex: '#CB9B96' },
    { name: 'Sienna', hex: '#BB8862' },
    { name: 'Khaki', hex: '#9F8A75' },
    { name: 'Mustard', hex: '#C3BE78' },
    { name: 'Olive Green', hex: '#A9C12F' },
    { name: 'Forest', hex: '#84B45D' },
    { name: 'Sage Teal', hex: '#93C7C0' },
    { name: 'Steel Blue', hex: '#A5BBC9' },
    { name: 'Powder Blue', hex: '#8FACC5' },
    { name: 'Muted Blue', hex: '#8D9CCD' },
    { name: 'Mauve', hex: '#AE9FBB' },
    { name: 'Soft Lavender', hex: '#C6A9C4' },
    { name: 'Muted Magenta', hex: '#BF7A9C' },
    { name: 'Medium Gray', hex: '#838383' },

    // Row 5 — Dark
    { name: 'Dark Red', hex: '#B53637' },
    { name: 'Burnt Orange', hex: '#AE5437' },
    { name: 'Dark Brown', hex: '#775345' },
    { name: 'Dark Yellow', hex: '#DEC633' },
    { name: 'Dark Olive', hex: '#899B31' },
    { name: 'Dark Green', hex: '#57A53F' },
    { name: 'Dark Teal', hex: '#139F91' },
    { name: 'Navy', hex: '#256686' },
    { name: 'Dark Navy', hex: '#1A3096' },
    { name: 'Dark Indigo', hex: '#3155A4' },
    { name: 'Dark Purple', hex: '#6751AE' },
    { name: 'Dark Magenta', hex: '#A752AF' },
    { name: 'Dark Pink', hex: '#CE3571' },
    { name: 'Dark Gray', hex: '#3F3F3F' },
] as const;

/** Number of hue columns in the palette grid. */
export const PALETTE_COLUMNS = 14;
