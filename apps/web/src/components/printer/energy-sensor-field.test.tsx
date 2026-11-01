import { appSettingsSchema } from '@farolprint/shared';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { m } from '@/lib/i18n';
import { renderWithProviders, testQueryClient } from '@/test/render';
import { EnergySensorField } from './energy-sensor-field';

const { homeAssistant, settings } = vi.hoisted(() => ({
    homeAssistant: { energySensors: vi.fn() },
    settings: { get: vi.fn() },
}));

vi.mock('@/lib/api', () => ({
    api: new Proxy({ homeAssistant, settings } as Record<string, unknown>, {
        get: (target, key: string) => target[key] ?? new Proxy({}, { get: () => vi.fn().mockResolvedValue([]) }),
    }),
}));

function client(configured: boolean) {
    const qc = testQueryClient();
    qc.setQueryData(
        ['settings'],
        appSettingsSchema.parse(configured ? { homeAssistant: { url: 'http://ha.local:8123', token: 't' } } : {}),
    );
    return qc;
}

beforeEach(() => {
    homeAssistant.energySensors.mockReset().mockResolvedValue([
        { entityId: 'sensor.kobra_energy', name: 'Kobra plug', kwh: 12.345 },
        { entityId: 'sensor.attic', name: 'Attic', kwh: null },
    ]);
});

describe('EnergySensorField', () => {
    it('explains where to set up Home Assistant first', async () => {
        await renderWithProviders(<EnergySensorField value="" onChange={vi.fn()} />, { queryClient: client(false) });
        expect(screen.getByText(m.energy_sensor_setup())).toBeTruthy();
        expect(screen.queryByRole('combobox')).toBeNull();
        expect(homeAssistant.energySensors).not.toHaveBeenCalled();
    });

    it('lists the meters from Home Assistant with their reading and picks one', async () => {
        const onChange = vi.fn();
        await renderWithProviders(<EnergySensorField value="" onChange={onChange} />, { queryClient: client(true) });
        await userEvent.click(screen.getByRole('combobox', { name: m.energy_sensor() }));
        await userEvent.click(
            await screen.findByRole('option', { name: `Kobra plug · ${m.energy_kwh({ kwh: '12.35' })}` }),
        );
        expect(onChange).toHaveBeenCalledWith('sensor.kobra_energy');
    });

    it('goes back to the estimate', async () => {
        const onChange = vi.fn();
        await renderWithProviders(<EnergySensorField value="sensor.kobra_energy" onChange={onChange} />, {
            queryClient: client(true),
        });
        await userEvent.click(screen.getByRole('combobox', { name: m.energy_sensor() }));
        await userEvent.click(await screen.findByRole('option', { name: m.energy_sensor_none() }));
        expect(onChange).toHaveBeenCalledWith('');
    });

    it('keeps a saved meter that Home Assistant no longer lists and shows a listing error', async () => {
        homeAssistant.energySensors.mockRejectedValue(new Error('Home Assistant refused the token'));
        await renderWithProviders(<EnergySensorField value="sensor.old_plug" onChange={vi.fn()} />, {
            queryClient: client(true),
        });
        expect(screen.getByRole('combobox', { name: m.energy_sensor() }).textContent).toContain('sensor.old_plug');
        await waitFor(() => expect(screen.getByText('Home Assistant refused the token')).toBeTruthy());
    });
});
