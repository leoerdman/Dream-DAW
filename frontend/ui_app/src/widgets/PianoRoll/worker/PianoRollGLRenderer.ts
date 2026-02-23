import { createProgram } from './PianoRollGLProgram';
import { GRID_FS, GRID_VS, NOTE_FS, NOTE_VS, PLAYHEAD_FS, PLAYHEAD_VS } from './PianoRollGLShaders';

export interface NoteInstanceData {
    startBeat: number;
    pitch: number;
    durationBeats: number;
    velocity: number;
    flags: number;
}

export interface GridStyle {
    whiteRowColor: [number, number, number];
    blackRowColor: [number, number, number];
    rootRowColor: [number, number, number];
    barLineColor: [number, number, number];
    beatLineColor: [number, number, number];
    subLineColor: [number, number, number];
    cLineColor: [number, number, number];
    noteColor: [number, number, number];
}

export interface ViewState {
    pixelsPerBeat: number;
    noteHeight: number;
    scrollX: number;
    scrollY: number;
    canvasWidth: number;
    canvasHeight: number;
    beatsPerBar: number;
    gridInterval: number;
    totalBeats: number;
    totalPitches: number;
    highlightScale: boolean;
    scaleRoot: number;
    playheadX: number;
}

const DEFAULT_STYLE: GridStyle = {
    whiteRowColor: [0.12, 0.12, 0.14],
    blackRowColor: [0.08, 0.08, 0.10],
    rootRowColor: [0.15, 0.12, 0.18],
    barLineColor: [0.40, 0.40, 0.45],
    beatLineColor: [0.28, 0.28, 0.32],
    subLineColor: [0.18, 0.18, 0.20],
    cLineColor: [0.45, 0.45, 0.50],
    noteColor: [0.35, 0.55, 0.90],
};

export class PianoRollGLRenderer {
    private gl: WebGL2RenderingContext;
    private gridProgram: WebGLProgram;
    private noteProgram: WebGLProgram;
    private playheadProgram: WebGLProgram;
    private gridUniforms: Record<string, WebGLUniformLocation | null> = {};
    private noteUniforms: Record<string, WebGLUniformLocation | null> = {};
    private playheadUniforms: Record<string, WebGLUniformLocation | null> = {};
    private noteVAO: WebGLVertexArrayObject;
    private quadVBO!: WebGLBuffer;
    private instanceVBO!: WebGLBuffer;
    private playheadVAO: WebGLVertexArrayObject;
    private playheadVBO!: WebGLBuffer;
    private instanceCount = 0;
    private style: GridStyle = { ...DEFAULT_STYLE };
    private view: ViewState = {
        pixelsPerBeat: 40,
        noteHeight: 14,
        scrollX: 0,
        scrollY: 0,
        canvasWidth: 800,
        canvasHeight: 600,
        beatsPerBar: 4,
        gridInterval: 0.25,
        totalBeats: 32,
        totalPitches: 128,
        highlightScale: false,
        scaleRoot: 0,
        playheadX: -1,
    };

    constructor(gl: WebGL2RenderingContext) {
        this.gl = gl;
        this.gridProgram = createProgram(gl, GRID_VS, GRID_FS);
        this.noteProgram = createProgram(gl, NOTE_VS, NOTE_FS);
        this.playheadProgram = createProgram(gl, PLAYHEAD_VS, PLAYHEAD_FS);
        this.cacheUniforms();
        this.noteVAO = this.createNoteVao();
        this.playheadVAO = this.createPlayheadVao();
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    }

    setStyle(style: Partial<GridStyle>): void {
        Object.assign(this.style, style);
    }

    setView(view: Partial<ViewState>): void {
        Object.assign(this.view, view);
    }

    uploadNotes(data: Float32Array): void {
        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceVBO);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
        this.instanceCount = data.length / 5;
    }

    render(): void {
        const gl = this.gl;
        const v = this.view;
        const s = this.style;
        gl.viewport(0, 0, v.canvasWidth, v.canvasHeight);
        gl.clearColor(0.08, 0.08, 0.10, 1.0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        this.renderGrid(v, s);
        this.renderNotes(v, s);
        this.renderPlayhead(v);
    }

    destroy(): void {
        const gl = this.gl;
        gl.deleteProgram(this.gridProgram);
        gl.deleteProgram(this.noteProgram);
        gl.deleteProgram(this.playheadProgram);
        gl.deleteBuffer(this.quadVBO);
        gl.deleteBuffer(this.instanceVBO);
        gl.deleteBuffer(this.playheadVBO);
        gl.deleteVertexArray(this.noteVAO);
        gl.deleteVertexArray(this.playheadVAO);
    }

    private cacheUniforms(): void {
        const gl = this.gl;
        for (const name of ['u_resolution', 'u_scroll', 'u_pixelsPerBeat', 'u_noteHeight', 'u_beatsPerBar', 'u_gridInterval', 'u_totalPitches', 'u_whiteRowColor', 'u_blackRowColor', 'u_rootRowColor', 'u_barLineColor', 'u_beatLineColor', 'u_subLineColor', 'u_cLineColor', 'u_highlightScale', 'u_scaleRoot']) {
            this.gridUniforms[name] = gl.getUniformLocation(this.gridProgram, name);
        }
        for (const name of ['u_resolution', 'u_scroll', 'u_pixelsPerBeat', 'u_noteHeight', 'u_totalPitches', 'u_noteColor']) {
            this.noteUniforms[name] = gl.getUniformLocation(this.noteProgram, name);
        }
        this.playheadUniforms.u_playheadX = gl.getUniformLocation(this.playheadProgram, 'u_playheadX');
        this.playheadUniforms.u_resolution = gl.getUniformLocation(this.playheadProgram, 'u_resolution');
    }

    private createNoteVao(): WebGLVertexArrayObject {
        const gl = this.gl;
        const vao = gl.createVertexArray()!;
        gl.bindVertexArray(vao);
        const quadData = new Float32Array([0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1]);
        this.quadVBO = gl.createBuffer()!;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVBO);
        gl.bufferData(gl.ARRAY_BUFFER, quadData, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        this.instanceVBO = gl.createBuffer()!;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceVBO);
        gl.bufferData(gl.ARRAY_BUFFER, 0, gl.DYNAMIC_DRAW);
        const stride = 20;
        const fields: [number, number][] = [[1, 0], [2, 4], [3, 8], [4, 12], [5, 16]];
        for (const [idx, offset] of fields) {
            gl.enableVertexAttribArray(idx);
            gl.vertexAttribPointer(idx, 1, gl.FLOAT, false, stride, offset);
            gl.vertexAttribDivisor(idx, 1);
        }
        gl.bindVertexArray(null);
        return vao;
    }

    private createPlayheadVao(): WebGLVertexArrayObject {
        const gl = this.gl;
        const vao = gl.createVertexArray()!;
        gl.bindVertexArray(vao);
        this.playheadVBO = gl.createBuffer()!;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.playheadVBO);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1]), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        gl.bindVertexArray(null);
        return vao;
    }

    private renderGrid(v: ViewState, s: GridStyle): void {
        const gl = this.gl;
        gl.useProgram(this.gridProgram);
        gl.uniform2f(this.gridUniforms.u_resolution!, v.canvasWidth, v.canvasHeight);
        gl.uniform2f(this.gridUniforms.u_scroll!, v.scrollX, v.scrollY);
        gl.uniform1f(this.gridUniforms.u_pixelsPerBeat!, v.pixelsPerBeat);
        gl.uniform1f(this.gridUniforms.u_noteHeight!, v.noteHeight);
        gl.uniform1f(this.gridUniforms.u_beatsPerBar!, v.beatsPerBar);
        gl.uniform1f(this.gridUniforms.u_gridInterval!, v.gridInterval);
        gl.uniform1f(this.gridUniforms.u_totalPitches!, v.totalPitches);
        gl.uniform3fv(this.gridUniforms.u_whiteRowColor!, s.whiteRowColor);
        gl.uniform3fv(this.gridUniforms.u_blackRowColor!, s.blackRowColor);
        gl.uniform3fv(this.gridUniforms.u_rootRowColor!, s.rootRowColor);
        gl.uniform3fv(this.gridUniforms.u_barLineColor!, s.barLineColor);
        gl.uniform3fv(this.gridUniforms.u_beatLineColor!, s.beatLineColor);
        gl.uniform3fv(this.gridUniforms.u_subLineColor!, s.subLineColor);
        gl.uniform3fv(this.gridUniforms.u_cLineColor!, s.cLineColor);
        gl.uniform1f(this.gridUniforms.u_highlightScale!, v.highlightScale ? 1 : 0);
        gl.uniform1f(this.gridUniforms.u_scaleRoot!, v.scaleRoot);
        gl.drawArrays(this.gl.TRIANGLES, 0, 3);
    }

    private renderNotes(v: ViewState, s: GridStyle): void {
        if (this.instanceCount <= 0) return;
        const gl = this.gl;
        gl.useProgram(this.noteProgram);
        gl.uniform2f(this.noteUniforms.u_resolution!, v.canvasWidth, v.canvasHeight);
        gl.uniform2f(this.noteUniforms.u_scroll!, v.scrollX, v.scrollY);
        gl.uniform1f(this.noteUniforms.u_pixelsPerBeat!, v.pixelsPerBeat);
        gl.uniform1f(this.noteUniforms.u_noteHeight!, v.noteHeight);
        gl.uniform1f(this.noteUniforms.u_totalPitches!, v.totalPitches);
        gl.uniform3fv(this.noteUniforms.u_noteColor!, s.noteColor);
        gl.bindVertexArray(this.noteVAO);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.instanceCount);
        gl.bindVertexArray(null);
    }

    private renderPlayhead(v: ViewState): void {
        if (v.playheadX < 0) return;
        const gl = this.gl;
        gl.useProgram(this.playheadProgram);
        gl.uniform1f(this.playheadUniforms.u_playheadX!, v.playheadX - v.scrollX);
        gl.uniform2f(this.playheadUniforms.u_resolution!, v.canvasWidth, v.canvasHeight);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.playheadVBO);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 2, 0, 0, v.canvasHeight, 2, 0, 2, v.canvasHeight, 0, v.canvasHeight]), gl.DYNAMIC_DRAW);
        gl.bindVertexArray(this.playheadVAO);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        gl.bindVertexArray(null);
    }
}
