import type { AmsSlot } from '@farolprint/shared';
import { describe, expect, it } from 'vitest';
import { type Channel, defaultAssignments, filamentPalette } from './filament-assignments';

const slot = (globalIndex: number, type: string, color: [number, number, number]): AmsSlot => ({
    globalIndex,
    boxId: 0,
    index: globalIndex,
    status: 5,
    type,
    color,
    activity: '',
});

const channel = (paintIndex: number, colorHex: string, material = 'PLA', isUsed = true): Channel => ({
    paintIndex,
    colorHex,
    material,
    isUsed,
});

describe('defaultAssignments', () => {
    it('gives each channel the nearest compatible slot, once', () => {
        const slots = [slot(0, 'PLA', [255, 0, 0]), slot(1, 'PLA', [0, 0, 255]), slot(2, 'PETG', [0, 255, 0])];
        const channels = [channel(0, '#ff0000'), channel(1, '#0000ff'), channel(2, '#00ff00', 'PETG')];
        expect(defaultAssignments(channels, slots)).toEqual({ 0: 0, 1: 1, 2: 2 });
    });

    it('leaves a channel without a compatible slot unassigned', () => {
        expect(defaultAssignments([channel(0, '#ffffff', 'PETG')], [slot(0, 'PLA', [255, 255, 255])])).toEqual({
            0: -1,
        });
    });
});

describe('filamentPalette', () => {
    it('colors each tool with the slot that will print it', () => {
        const slots = [slot(0, 'PLA', [255, 0, 0]), slot(1, 'PLA', [0, 0, 255])];
        const channels = [channel(0, '#111111'), channel(1, '#222222')];
        expect(filamentPalette(channels, slots, { 0: 1, 1: 0 })).toEqual({
            byTool: ['#0000ff', '#ff0000'],
            main: '#0000ff',
        });
    });

    it('falls back to the slicer color when no slot is assigned', () => {
        const slots = [slot(0, 'PLA', [255, 0, 0])];
        const channels = [channel(0, '#111111'), channel(1, '#222222')];
        expect(filamentPalette(channels, slots, { 0: 0, 1: -1 })).toEqual({
            byTool: ['#ff0000', '#222222'],
            main: '#ff0000',
        });
        expect(filamentPalette(channels, [], {})).toEqual({ byTool: ['#111111', '#222222'], main: '#111111' });
    });

    it('takes the main color from the first channel the print uses', () => {
        const channels = [channel(0, '#111111', 'PLA', false), channel(2, '#333333')];
        expect(filamentPalette(channels, [], {})).toEqual({ byTool: ['#111111', '', '#333333'], main: '#333333' });
    });

    it('skips channels whose index cannot be a tool', () => {
        const channels = [channel(-1, '#111111'), channel(64, '#222222'), channel(1.5, '#333333')];
        expect(filamentPalette(channels, [], {}).byTool).toEqual([]);
    });

    it('is empty when the file names no filament', () => {
        expect(filamentPalette([], [], {})).toEqual({ byTool: [], main: '' });
    });
});
