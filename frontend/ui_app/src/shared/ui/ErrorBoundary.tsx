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
import * as engineApi from '@/shared/api/engine';

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
        void engineApi.logFrontendError(
            this.props.module,
            error.message || 'Unknown frontend error',
            `${error.stack ?? ''}\n${info.componentStack ?? ''}`.trim() || undefined,
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
                            (e.target as HTMLButtonElement).style.color = 'var(--token-color-hex-ffffff)';
                        }}
                        onMouseLeave={e => {
                            (e.target as HTMLButtonElement).style.background = 'var(--color-border-subtle)';
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
    background: 'color-mix(in srgb, var(--color-status-error) 4%, transparent)',
    borderRadius: 'var(--radius-xl)',
    border: 'var(--space-px) solid color-mix(in srgb, var(--color-status-error) 15%, transparent)',
    padding: 'var(--space-6) var(--space-4)',
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
    background: 'radial-gradient(circle, color-mix(in srgb, var(--color-status-error) 8%, transparent) 0%, transparent 70%)',
    pointerEvents: 'none',
};

const iconStyle: React.CSSProperties = {
    fontSize: 'var(--font-size-3xl)',
    lineHeight: 1,
    opacity: 0.7,
    filter: 'drop-shadow(0 0 var(--space-2) color-mix(in srgb, var(--color-status-error) 30%, transparent))',
};

const titleStyle: React.CSSProperties = {
    fontSize: 'var(--font-size-md)',
    fontWeight: 700,
    color: 'var(--color-status-error)', // BUG-48 FIX
    letterSpacing: '0.03em',
};

const moduleNameStyle: React.CSSProperties = {
    fontSize: 'var(--font-size-sm)',
    fontWeight: 600,
    color: 'var(--color-text-tertiary)',
    opacity: 0.7,
};

const errorMsgStyle: React.CSSProperties = {
    fontSize: 'var(--font-size-xs)',
    fontFamily: 'var(--font-role-data)',
    color: 'var(--color-text-tertiary)',
    maxWidth: 280,
    textAlign: 'center',
    wordBreak: 'break-word',
    opacity: 0.5,
    lineHeight: 1.4,
};

const retryBtnStyle: React.CSSProperties = {
    marginTop: 8,
    padding: 'var(--space-1-5) var(--space-4)',
    borderRadius: 'var(--radius-lg)',
    border: 'var(--space-px) solid var(--color-border-subtle)',
    background: 'var(--color-border-subtle)',
    color: 'var(--color-text-secondary)',
    fontSize: 'var(--font-size-sm)',
    fontWeight: 600,
    cursor: 'pointer',
    transition: `all var(--transition-normal)`,
    backdropFilter: 'blur(var(--space-1))',
};
