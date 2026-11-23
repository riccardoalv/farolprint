import { describe, expect, it } from 'vitest';
import { MAX_TOOLS, parseGcode, SEGMENT_STRIDE } from './gcode-parse';

const toolsOf = (text: string) =>
    parseGcode(text).layers.flatMap((l) => {
        const out: number[] = [];
        for (let k = 0; k < l.segs.length; k += SEGMENT_STRIDE) out.push(l.segs[k + 5]);
        return out;
    });

describe('parseGcode', () => {
    it('stores each extrusion as x0, y0, x1, y1, extruded length and tool', () => {
        const { layers } = parseGcode(
            ['G90', 'M82', 'G1 Z0.2', 'G1 X0 Y0', 'G1 X10 Y0 E1', 'T1', 'G1 X10 Y10 E2'].join('\n'),
        );
        expect(layers).toHaveLength(1);
        expect(Array.from(layers[0].segs)).toEqual([0, 0, 10, 0, 1, -1, 10, 0, 10, 10, 1, 1]);
    });

    it('marks the moves before any tool change as tool -1 and follows each T<n>', () => {
        const text = ['G1 Z0.2', 'G1 X1 E1', 'T0', 'G1 X2 E2', 'T2 ; purge', 'G1 X3 E3', 't1', 'G1 X4 E4'].join('\n');
        expect(toolsOf(text)).toEqual([-1, 0, 2, 1]);
    });

    it('accepts a tool change with arguments and ignores commands that only start with T', () => {
        const text = ['G1 Z0.2', 'T3 S1', 'G1 X1 E1', 'TIMELAPSE_TAKE_FRAME', 'G1 X2 E2', 'T', 'G1 X3 E3'].join('\n');
        expect(toolsOf(text)).toEqual([3, 3, 3]);
    });

    it(`ignores tool numbers from ${MAX_TOOLS} up, such as an unload`, () => {
        const text = ['G1 Z0.2', 'T1', 'G1 X1 E1', 'T255', 'G1 X2 E2', `T${MAX_TOOLS}`, 'G1 X3 E3'].join('\n');
        expect(toolsOf(text)).toEqual([1, 1, 1]);
    });

    it('keeps travel moves and retractions out of the segments', () => {
        const text = ['G1 Z0.2', 'G1 X5 Y5', 'G1 E-1', 'G1 E0', 'G1 X7 E1'].join('\n');
        expect(toolsOf(text)).toEqual([-1]);
    });

    it('sorts layers by height and reports the bounds', () => {
        const text = ['G1 Z0.4', 'G1 X1 Y1 E1', 'G1 Z0.2', 'G1 X5 Y3 E2'].join('\n');
        const out = parseGcode(text);
        expect(out.layers.map((l) => l.z)).toEqual([0.2, 0.4]);
        expect([out.minX, out.maxX, out.minY, out.maxY]).toEqual([0, 5, 0, 3]);
    });
});
