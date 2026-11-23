import { type AmsSlot, materialFamily } from '@farolprint/shared';
import { hexToRgb, rgbToHex } from '@/lib/color';
import { MAX_TOOLS } from '@/lib/gcode-parse';

export interface Channel {
    paintIndex: number;
    colorHex: string;
    material: string;
    isUsed: boolean;
}

function colorDistance(a: string, b: string): number {
    const [r1, g1, b1] = hexToRgb(a);
    const [r2, g2, b2] = hexToRgb(b);
    return (r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2;
}

export function compatibleSlots(channel: Channel, slots: AmsSlot[]): AmsSlot[] {
    const fam = materialFamily(channel.material);
    if (!fam) return slots;
    return slots.filter((s) => materialFamily(s.type) === fam);
}

export function defaultAssignments(channels: Channel[], slots: AmsSlot[]): Record<number, number> {
    const out: Record<number, number> = {};
    const taken = new Set<number>();
    for (const ch of channels) {
        const ranked = compatibleSlots(ch, slots).sort((a, b) => {
            const da = Math.abs(a.globalIndex - ch.paintIndex);
            const db = Math.abs(b.globalIndex - ch.paintIndex);
            if (da !== db) return da - db;
            const ca = colorDistance(ch.colorHex, rgbToHex(a.color));
            const cb = colorDistance(ch.colorHex, rgbToHex(b.color));
            if (ca !== cb) return ca - cb;
            return a.globalIndex - b.globalIndex;
        });
        const chosen = ranked.find((s) => !taken.has(s.globalIndex)) ?? ranked[0];
        out[ch.paintIndex] = chosen ? chosen.globalIndex : -1;
        if (chosen) taken.add(chosen.globalIndex);
    }
    return out;
}

export interface FilamentColors {
    byTool: string[];
    main: string;
}

export function filamentPalette(
    channels: Pick<Channel, 'paintIndex' | 'colorHex' | 'isUsed'>[],
    slots: AmsSlot[],
    assignments: Record<number, number>,
): FilamentColors {
    const colorOf = (ch: Pick<Channel, 'paintIndex' | 'colorHex'>) => {
        const slot = slots.find((s) => s.globalIndex === assignments[ch.paintIndex]);
        return slot ? rgbToHex(slot.color) : ch.colorHex;
    };
    const byTool: string[] = [];
    for (const ch of channels) {
        if (!Number.isInteger(ch.paintIndex) || ch.paintIndex < 0 || ch.paintIndex >= MAX_TOOLS) continue;
        byTool[ch.paintIndex] = colorOf(ch);
    }
    const first = channels.find((ch) => ch.isUsed) ?? channels[0];
    return { byTool: Array.from(byTool, (color) => color ?? ''), main: first ? colorOf(first) : '' };
}
