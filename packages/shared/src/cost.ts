import type { CostSettings } from './settings';

export interface JobCost {
    filament: number;
    energy: number;
    machine: number;
    total: number;
}

export function round2(v: number): number {
    return Math.round(v * 100) / 100;
}

export interface MachineCost {
    powerW?: number | null;
    depreciationPerHour?: number;
    measuresEnergy?: boolean;
}

export function jobCost(
    durationSec: number,
    filamentCost: number,
    costs: CostSettings,
    machineCost: MachineCost = {},
    energyKwh: number | null = null,
): JobCost {
    const hours = Math.max(0, durationSec) / 3600;
    const powerW = machineCost.powerW ?? costs.printerPowerW;
    const kwh = energyKwh ?? (powerW / 1000) * hours;
    const energy = kwh * costs.energyPricePerKwh;
    const machine = hours * (costs.hourlyRate + Math.max(0, machineCost.depreciationPerHour ?? 0));
    const filament = Math.max(0, filamentCost);
    return {
        filament: round2(filament),
        energy: round2(energy),
        machine: round2(machine),
        total: round2(filament + energy + machine),
    };
}
