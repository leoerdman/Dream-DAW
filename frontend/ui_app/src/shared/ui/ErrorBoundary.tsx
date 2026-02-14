// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Enterprise Error Boundary
// ═══════════════════════════════════════════════════════════════════════════
//
// React class component that catches render/lifecycle errors from children,
// preventing a single widget crash from white-screening the entire DAW.
//
// Usage:
//   <ErrorBoundary module="Asset Browser">
//     <AssetBrowser />
//   </ErrorBoundary>
//
// On error, shows a premium "Module Crashed" fallback panel with:
//   - Module name
//   - Retry button (resets error state → re-mounts children)
//   - Truncated error message for debugging
//
// ═══════════════════════════════════════════════════════════════════════════

import React from 'react';

// ── Types ────────────────────────────────────────────────────────────────

interface ErrorBoundaryProps {
    /** Display name of the module being wrapped (e.g. "Timeline"). */
    module: string;

    /** Children to render when no error has occurred. */
    children: React.ReactNode;
}

interface ErrorBoundaryState {
    hasError: boolean;
    error: Error | null;
}

// ── Component ────────────────────────────────────────────────────────────

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
    constructor(props: ErrorBoundaryProps) {
        super(props);
        this.state = { hasError: false, error: null };
    }

    static getDerivedStateFromError(error: Error): ErrorBoundaryState {
        return { hasError: true, error };
    }

    componentDidCatch(error: Error, info: React.ErrorInfo) {
        console.error(
            `[ErrorBoundary] "${this.props.module}" crashed:`,
            error,
            '\nComponent stack:',
            info.componentStack,
        );
    }

    private handleRetry = () => {
        this.setState({ hasError: false, error: null });
    };

    render() {
        if (this.state.hasError) {
            return (
                <div style={containerStyle}>
                    {/* Glow ring */}
                    <div style={glowRingStyle} />

                    {/* Icon */}
                    <div style={iconStyle}>⚠</div>

                    {/* Title */}
                    <div style={titleStyle}>
                        Module Crashed
                    </div>

                    {/* Module name */}
                    <div style={moduleNameStyle}>
                        {this.props.module}
                    </div>

                    {/* Error message (truncated) */}
                    {this.state.error && (
                        <div style={errorMsgStyle}>
                            {this.state.error.message.slice(0, 200)}
                        </div>
                    )}

                    {/* Retry button */}
                    <button
                        onClick={this.handleRetry}
                        style={retryBtnStyle}
                        onMouseEnter={e => {
                            (e.target as HTMLButtonElement).style.background = 'var(--color-accent-primary)';
                            (e.target as HTMLButtonElement).style.color = '#fff';
                        }}
                        onMouseLeave={e => {
                            (e.target as HTMLButtonElement).style.background = 'rgba(255,255,255,0.08)';
                            (e.target as HTMLButtonElement).style.color = 'var(--color-text-secondary)';
                        }}
                    >
                        ↻ Retry
                    </button>
                </div>
            );
        }

        return this.props.children;
    }
}

// ── Styles (Liquid Glass design tokens) ──────────────────────────────────

const containerStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    height: '100%',
    minHeight: 120,
    background: 'rgba(220, 38, 38, 0.04)',
    borderRadius: 8,
    border: '1px solid rgba(220, 38, 38, 0.15)',
    padding: '24px 16px',
    gap: 8,
    position: 'relative',
    overflow: 'hidden',
};

const glowRingStyle: React.CSSProperties = {
    position: 'absolute',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    width: 160,
    height: 160,
    borderRadius: '50%',
    background: 'radial-gradient(circle, rgba(220, 38, 38, 0.08) 0%, transparent 70%)',
    pointerEvents: 'none',
};

const iconStyle: React.CSSProperties = {
    fontSize: 28,
    lineHeight: 1,
    opacity: 0.7,
    filter: 'drop-shadow(0 0 8px rgba(220, 38, 38, 0.3))',
};

const titleStyle: React.CSSProperties = {
    fontSize: 13,
    fontWeight: 700,
    color: '#e53e3e',
    letterSpacing: '0.03em',
};

const moduleNameStyle: React.CSSProperties = {
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--color-text-tertiary)',
    opacity: 0.7,
};

const errorMsgStyle: React.CSSProperties = {
    fontSize: 10,
    fontFamily: 'var(--font-mono)',
    color: 'var(--color-text-tertiary)',
    maxWidth: 280,
    textAlign: 'center',
    wordBreak: 'break-word',
    opacity: 0.5,
    lineHeight: 1.4,
};

const retryBtnStyle: React.CSSProperties = {
    marginTop: 8,
    padding: '6px 16px',
    borderRadius: 6,
    border: '1px solid rgba(255,255,255,0.1)',
    background: 'rgba(255,255,255,0.08)',
    color: 'var(--color-text-secondary)',
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'all 0.2s ease',
    backdropFilter: 'blur(4px)',
};
