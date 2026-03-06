import React from 'react';
import {
    controlRowStyle,
    controlRowLabelStyle,
    controlRowContentStyle,
    nodeSelectStyle,
    nodeSliderStyle,
    nodeValueStyle,
    nodeValueUnitStyle,
} from './FlowNodeControlStyles';

// ── Control Row ──────────────────────────────────────────────────────────

interface ControlRowProps {
    label: string;
    children: React.ReactNode;
}

export function ControlRow({ label, children }: ControlRowProps) {
    return (
        <div style={controlRowStyle}>
            <span style={controlRowLabelStyle}>{label}</span>
            <div style={controlRowContentStyle}>{children}</div>
        </div>
    );
}

// ── Select (Dropdown) ────────────────────────────────────────────────────

interface NodeSelectProps {
    value: string;
    options: { value: string; label: string }[];
    onChange: (value: string) => void;
}

export function NodeSelect({ value, options, onChange }: NodeSelectProps) {
    return (
        <select
            value={value}
            onChange={(e) => { e.stopPropagation(); onChange(e.target.value); }}
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            style={nodeSelectStyle}
        >
            {options.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
        </select>
    );
}

// ── Slider (Range Input) ─────────────────────────────────────────────────

interface NodeSliderProps {
    value: number;
    min: number;
    max: number;
    step: number;
    onChange: (value: number) => void;
}

export function NodeSlider({ value, min, max, step, onChange }: NodeSliderProps) {
    return (
        <input
            type="range"
            min={min}
            max={max}
            step={step}
            value={value}
            onChange={(e) => onChange(Number(e.target.value))}
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            style={nodeSliderStyle}
        />
    );
}

// ── Value Display ────────────────────────────────────────────────────────

interface NodeValueProps {
    value: string | number;
    unit?: string;
}

export function NodeValue({ value, unit }: NodeValueProps) {
    return (
        <span style={nodeValueStyle}>
            {value}{unit && <span style={nodeValueUnitStyle}>{unit}</span>}
        </span>
    );
}
