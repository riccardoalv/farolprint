import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { m } from '@/lib/i18n';
import { renderWithProviders } from '@/test/render';
import { CameraCard } from './camera-card';

const { live, start } = vi.hoisted(() => ({
    live: { current: {} as Record<string, unknown> },
    start: vi.fn(),
}));

vi.mock('@/hooks/use-printers', () => ({
    useLiveState: () => live.current,
    usePrinter: () => ({ settings: { cameraAlwaysOn: true, cameraOnPrint: false } }),
}));

vi.mock('@/lib/api', () => ({
    api: new Proxy(
        { camera: { start, stop: vi.fn(), reset: vi.fn(), streamUrl: () => '/stream' } } as Record<string, unknown>,
        { get: (target, key: string) => target[key] ?? new Proxy({}, { get: () => vi.fn().mockResolvedValue(null) }) },
    ),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

beforeEach(() => {
    start.mockReset().mockResolvedValue(undefined);
});

describe('CameraCard', () => {
    it('says no camera is connected and does not start the stream', async () => {
        live.current = {
            connected: true,
            printState: 'standby',
            peripherals: { camera: false, usbDrive: false, ace: false },
        };
        await renderWithProviders(<CameraCard printerId="p1" />);
        expect(screen.getByText(m.camera_not_connected())).toBeTruthy();
        expect(start).not.toHaveBeenCalled();
    });

    it('starts the stream when the printer reports a camera', async () => {
        live.current = {
            connected: true,
            printState: 'standby',
            peripherals: { camera: true, usbDrive: false, ace: false },
        };
        await renderWithProviders(<CameraCard printerId="p1" />);
        expect(screen.queryByText(m.camera_not_connected())).toBeNull();
        await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    });

    it('starts the stream while the peripherals are unknown', async () => {
        live.current = { connected: true, printState: 'standby', peripherals: null };
        await renderWithProviders(<CameraCard printerId="p1" />);
        await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    });
});
