import type { GcodeFileDto } from '@farolprint/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FilamentColors } from '@/lib/filament-assignments';
import { m } from '@/lib/i18n';
import { GcodePreview } from './gcode-preview';

const mocks = vi.hoisted(() => ({
    live: null as Record<string, unknown> | null,
    scene: [] as { shown: number; filament?: FilamentColors }[],
    parsed: {
        kind: 'ready',
        data: {
            layers: [1, 2, 3, 4, 5].map((n) => ({ z: n * 0.2, segs: new Float32Array(6) })),
            minX: 0,
            maxX: 10,
            minY: 0,
            maxY: 10,
        },
    },
}));

vi.mock('./gcode-scene', () => ({
    GcodeScene: (props: { shown: number; filament?: FilamentColors }) => {
        mocks.scene.push(props);
        return <div data-testid="scene" data-shown={props.shown} />;
    },
}));

vi.mock('./cost-estimate', () => ({ CostEstimateCard: () => null }));

vi.mock('@/hooks/use-cost-estimate', () => ({
    useCostEstimate: () => ({ estimate: () => null, currency: 'EUR' }),
}));

vi.mock('@/hooks/use-printers', () => ({
    usePrinter: () => (mocks.live ? { live: mocks.live } : undefined),
}));

vi.mock('@/hooks/use-parsed-gcode', () => ({ useParsedGcode: () => mocks.parsed }));

const file = {
    id: 'f1',
    filename: 'cube.gcode',
    filaments: [
        { slotIndex: 0, material: 'PLA', colorHex: '#111111', isUsed: true },
        { slotIndex: 1, material: 'PLA', colorHex: '#222222', isUsed: true },
    ],
} as unknown as GcodeFileDto;

const aceSlot = (globalIndex: number, color: [number, number, number]) => ({
    globalIndex,
    boxId: 0,
    index: globalIndex,
    status: 5,
    type: 'PLA',
    color,
    activity: '',
});

const lastScene = () => mocks.scene[mocks.scene.length - 1];
const layerText = (n: number) => screen.getByText(m.preview_layer({ n, total: 5 }));

beforeEach(() => {
    mocks.scene = [];
    mocks.live = { amsSlots: [], filamentMode: 'toolhead', printState: 'standby', filename: '', currLayer: 0 };
});

describe('GcodePreview filament colors', () => {
    it('paints each tool with the ACE slot that will print it', async () => {
        mocks.live = {
            ...mocks.live,
            filamentMode: 'ace_hub',
            amsSlots: [aceSlot(0, [255, 0, 0]), aceSlot(1, [0, 0, 255])],
        };
        render(<GcodePreview printerId="p1" file={file} />);
        await screen.findByTestId('scene');
        expect(lastScene().filament).toEqual({ byTool: ['#ff0000', '#0000ff'], main: '#ff0000' });
    });

    it('uses the slicer colors when no slot can print the file', async () => {
        render(<GcodePreview printerId="p1" file={file} />);
        await screen.findByTestId('scene');
        expect(lastScene().filament).toEqual({ byTool: ['#111111', '#222222'], main: '#111111' });
    });
});

describe('GcodePreview layer follow', () => {
    beforeEach(() => {
        mocks.live = { ...mocks.live, printState: 'printing', filename: 'cube.gcode', currLayer: 3 };
    });

    it('follows the layer the printer is on while it prints this file', async () => {
        render(<GcodePreview printerId="p1" file={file} />);
        await waitFor(() => expect(layerText(3)).toBeTruthy());
        expect(screen.getByRole('switch', { name: m.preview_follow() }).getAttribute('aria-checked')).toBe('true');
    });

    it('stops following when the slider moves, and shows the chosen layer', async () => {
        render(<GcodePreview printerId="p1" file={file} />);
        await waitFor(() => expect(layerText(3)).toBeTruthy());
        fireEvent.keyDown(screen.getByRole('slider'), { key: 'ArrowLeft' });
        await waitFor(() => expect(layerText(2)).toBeTruthy());
        expect(screen.getByRole('switch', { name: m.preview_follow() }).getAttribute('aria-checked')).toBe('false');
    });

    it('stays on the layer it showed when following is turned off', async () => {
        render(<GcodePreview printerId="p1" file={file} />);
        await waitFor(() => expect(layerText(3)).toBeTruthy());
        fireEvent.click(screen.getByRole('switch', { name: m.preview_follow() }));
        await waitFor(() =>
            expect(screen.getByRole('switch', { name: m.preview_follow() }).getAttribute('aria-checked')).toBe('false'),
        );
        expect(layerText(3)).toBeTruthy();
        expect(lastScene().shown).toBe(3);
    });
});
