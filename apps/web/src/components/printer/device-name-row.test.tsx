import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrinterWithLive } from '@/lib/api';
import { m } from '@/lib/i18n';
import { renderWithProviders } from '@/test/render';
import { DeviceNameRow } from './settings-form';

const { deviceName } = vi.hoisted(() => ({ deviceName: vi.fn() }));

vi.mock('@/lib/api', () => ({
    api: new Proxy({ control: { deviceName } } as Record<string, unknown>, {
        get: (target, key: string) => target[key] ?? new Proxy({}, { get: () => vi.fn().mockResolvedValue([]) }),
    }),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const printer = (live: Record<string, unknown> | null) =>
    ({ id: 'p1', name: 'Workshop', live: live && { connected: true, ...live } }) as unknown as PrinterWithLive;

beforeEach(() => {
    deviceName.mockReset().mockResolvedValue(undefined);
});

describe('DeviceNameRow', () => {
    it('shows the name on the printer and sends the new one', async () => {
        await renderWithProviders(
            <DeviceNameRow printer={printer({ deviceName: 'Anycubic Kobra 4' })} name=" Workshop " />,
        );
        expect(screen.getByText(m.settings_device_name({ name: 'Anycubic Kobra 4' }))).toBeTruthy();
        await userEvent.click(screen.getByRole('button', { name: m.settings_device_name_apply() }));
        await waitFor(() => expect(deviceName).toHaveBeenCalledWith('p1', { name: 'Workshop' }));
    });

    it('offers nothing to send when the names already match or the name is too long', async () => {
        const same = await renderWithProviders(
            <DeviceNameRow printer={printer({ deviceName: 'Workshop' })} name="Workshop" />,
        );
        expect(screen.queryByRole('button', { name: m.settings_device_name_apply() })).toBeNull();
        same.unmount();
        await renderWithProviders(<DeviceNameRow printer={printer({ deviceName: 'Kobra' })} name={'x'.repeat(31)} />);
        expect(screen.queryByRole('button', { name: m.settings_device_name_apply() })).toBeNull();
    });

    it('waits for the printer to report its name', async () => {
        const { container } = await renderWithProviders(
            <DeviceNameRow printer={printer({ deviceName: null })} name="Workshop" />,
        );
        expect(container.textContent).toBe('');
    });

    it('cannot send while the printer is offline', async () => {
        await renderWithProviders(
            <DeviceNameRow printer={printer({ deviceName: 'Kobra', connected: false })} name="Workshop" />,
        );
        const button = screen.getByRole('button', { name: m.settings_device_name_apply() }) as HTMLButtonElement;
        expect(button.disabled).toBe(true);
    });
});
