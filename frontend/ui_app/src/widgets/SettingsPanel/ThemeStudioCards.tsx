import { THEME_PRESETS, THEME_STUDIO_PREVIEWS } from './settingsPanelThemeStudio';

interface ThemeStudioCardsProps {
    selectedThemeOption: string;
    applyPreset: (preset: (typeof THEME_PRESETS)[number]) => void;
}

export function ThemeStudioCards({ selectedThemeOption, applyPreset }: ThemeStudioCardsProps) {
    return (
        <div style={{ padding: 'var(--space-2-5) 0 var(--space-3)', borderBottom: 'var(--space-px) solid var(--color-divider-light)' }}>
            <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-tertiary)', letterSpacing: 'normal', textTransform: 'none', marginBottom: 8 }}>
                Theme Studio
            </div>
            <div className="theme-studio-grid" style={{ display: 'grid', gap: 8 }}>
                {THEME_PRESETS.map((preset) => {
                    const preview = THEME_STUDIO_PREVIEWS[preset.label];
                    const active = selectedThemeOption === preset.label;
                    return (
                        <button
                            key={`studio-${preset.label}`}
                            onClick={() => applyPreset(preset)}
                            className={`theme-studio-card${active ? ' theme-studio-card--active' : ''}`}
                            style={{ border: active ? '1px solid var(--color-accent-primary)' : 'var(--space-px) solid var(--color-divider)', borderRadius: 'var(--radius-lg)', padding: 0, background: 'var(--color-bg-elevated)', overflow: 'hidden', cursor: 'pointer', textAlign: 'left' }}
                        >
                            <div
                                className="theme-studio-preview"
                                style={{ height: 56, background: [preview.motif ? `${preview.motif} center / cover no-repeat` : '', preview.bg].filter(Boolean).join(','), borderBottom: 'var(--space-px) solid color-mix(in srgb, var(--color-text-primary) 10%, transparent)', position: 'relative' }}
                            >
                                <div style={{ position: 'absolute', left: 8, top: 8, width: 8, height: 8, borderRadius: '50%', background: preview.accent, boxShadow: `0 0 10px ${preview.accent}` }} />
                            </div>
                            <div style={{ padding: 'var(--space-2)' }}>
                                <div style={{ fontSize: 'var(--font-size-sm)', fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-text-primary)' }}>
                                    {preset.label}
                                </div>
                                <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-tertiary)' }}>{preview.note}</div>
                            </div>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
