import { Color } from 'three';
import { describe, expect, it } from 'vitest';
import type { ParsedGcode } from '@/lib/gcode-parse';
import { buildLines, buildSolid, makePainter, paintLines } from './gcode-scene';

const theme = { primary: '#3355ff', muted: '#888888', border: '#444444' };
const hex = (c: Color) => `#${c.getHexString()}`;

const data: ParsedGcode = {
    layers: [
        { z: 0.2, segs: Float32Array.from([0, 0, 10, 0, 1, -1, 10, 0, 10, 10, 1, 0]) },
        { z: 0.4, segs: Float32Array.from([0, 0, 10, 0, 1, 1]) },
    ],
    minX: 0,
    maxX: 10,
    minY: 0,
    maxY: 10,
};

describe('makePainter', () => {
    it('keeps the theme colors when the file names no filament', () => {
        const p = makePainter(undefined, theme);
        expect(p.tinted).toBe(false);
        expect(hex(p.color(0, false))).toBe('#888888');
        expect(hex(p.color(0, true))).toBe('#3355ff');
    });

    it('paints each tool with its filament and lifts the shown layer', () => {
        const p = makePainter({ byTool: ['#ff0000', '#00ff00'], main: '#ff0000' }, theme);
        expect(p.tinted).toBe(true);
        expect(hex(p.color(0, false))).toBe('#ff0000');
        expect(hex(p.color(1, false))).toBe('#00ff00');
        expect(hex(p.color(1, true))).toBe(hex(new Color('#00ff00').offsetHSL(0, 0, 0.08)));
    });

    it('uses the main filament before any tool change and for tools it does not know', () => {
        const p = makePainter({ byTool: ['#ff0000', ''], main: '#0000ff' }, theme);
        expect(hex(p.color(-1, false))).toBe('#0000ff');
        expect(hex(p.color(1, false))).toBe('#0000ff');
        expect(hex(p.color(9, false))).toBe('#0000ff');
    });

    it('lightens a filament too dark to see on the bed', () => {
        const p = makePainter({ byTool: [], main: '#000000' }, theme);
        const hsl = { h: 0, s: 0, l: 0 };
        p.color(-1, false).getHSL(hsl);
        expect(hsl.l).toBeCloseTo(0.24, 2);
    });
});

describe('scene geometry', () => {
    it('keeps the tool of every segment for both views', () => {
        expect(Array.from(buildLines(data).tools)).toEqual([-1, 0, 1]);
        expect(Array.from(buildSolid(data).tools)).toEqual([-1, 0, 1]);
        expect(buildSolid(data).ends).toEqual([2, 3]);
    });

    it('writes one color per line vertex from the painter', () => {
        const built = buildLines(data);
        paintLines(built, makePainter({ byTool: ['#ff0000', '#0000ff'], main: '#00ff00' }, theme));
        const colors = Array.from(built.colorAttribute.array as Float32Array).map((v) => Math.round(v * 255));
        expect(colors).toEqual([0, 255, 0, 0, 255, 0, 255, 0, 0, 255, 0, 0, 0, 0, 255, 0, 0, 255]);
    });
});
