/**
 * Utility for color calculations and luminance-aware contrast.
 */

export function parseColorToRgb(color: string): { r: number; g: number; b: number } | null {
    const value = color.trim();
    if (!value) return null;

    if (value.startsWith('#')) {
        const hex = value.slice(1);
        if (hex.length === 3) {
            const r = parseInt(hex[0] + hex[0], 16);
            const g = parseInt(hex[1] + hex[1], 16);
            const b = parseInt(hex[2] + hex[2], 16);
            if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
            return { r, g, b };
        }
        if (hex.length === 6) {
            const r = parseInt(hex.slice(0, 2), 16);
            const g = parseInt(hex.slice(2, 4), 16);
            const b = parseInt(hex.slice(4, 6), 16);
            if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
            return { r, g, b };
        }
    }

    const rgbMatch = value.match(/rgba?\(([^)]+)\)/i);
    if (rgbMatch) {
        const [rRaw, gRaw, bRaw] = rgbMatch[1].split(',').map((part) => Number(part.trim()));
        if (Number.isNaN(rRaw) || Number.isNaN(gRaw) || Number.isNaN(bRaw)) return null;
        return {
            r: Math.max(0, Math.min(255, rRaw)),
            g: Math.max(0, Math.min(255, gRaw)),
            b: Math.max(0, Math.min(255, bRaw)),
        };
    }

    return null;
}

/**
 * Calculates the relative luminance of a color.
 * Formula: 0.299*R + 0.587*G + 0.114*B
 * @param color - Hex or rgb/rgba color string
 * @returns Luminance value between 0 and 255
 */
export function getLuminance(color: string): number {
    const rgb = parseColorToRgb(color);
    if (!rgb) return 0;
    return 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b;
}

/**
 * Returns either black or white depending on which has better contrast against the background.
 * Dark colors (dark blue, dark purple, dark red, etc.) get white text.
 * All other colors get black text.
 * @param hexColor - Background hex color
 * @returns 'black' | 'white'
 */
export function getContrastColor(hexColor: string): 'black' | 'white' {
    const rgb = parseColorToRgb(hexColor);
    if (!rgb) return 'black';

    const { r, g, b } = rgb;
    const luminance = 0.299 * r + 0.587 * g + 0.114 * b;

    if (luminance > 145) {
        return 'black';
    }

    if (luminance < 80) {
        return 'white';
    }

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const saturation = max === 0 ? 0 : (max - min) / max;

    if (luminance < 120 && saturation > 0.5) {
        return 'white';
    }

    return 'black';
}
