import type { PrinterSettings } from './printer';

export type QueueEtaWait = 'bed_clear' | 'manual';

export interface QueueEta {
    printerId: string;
    startAt: string | null;
    endAt: string | null;
    wait: QueueEtaWait | null;
}

export type QueueStartSettings = Pick<
    PrinterSettings,
    'queueAutoStart' | 'queueBedClearConfirm' | 'queueAutoStartDelaySec' | 'lightTrigger'
>;

export interface TimelinePrinter {
    id: string;
    state: 'idle' | 'printing' | 'paused';
    remainSec: number;
    awaitingBedClear: boolean;
    autoStartAt: number | null;
    settings: QueueStartSettings;
}

export interface QueueTimeline {
    place(estPrintTimeSec: number, printerIds: readonly string[]): QueueEta | null;
}

interface Lane {
    id: string;
    order: number;
    at: number;
    exact: boolean;
    wait: QueueEtaWait | null;
    settings: QueueStartSettings;
}

function delayMs(s: QueueStartSettings): number {
    return Math.max(0, s.queueAutoStartDelaySec) * 1000;
}

function afterBedClear(s: QueueStartSettings): { wait: QueueEtaWait; delay: number } {
    if (!s.queueAutoStart) return { wait: 'manual', delay: 0 };
    return { wait: 'bed_clear', delay: s.lightTrigger ? 0 : delayMs(s) };
}

function afterPrint(s: QueueStartSettings): { wait: QueueEtaWait | null; delay: number } {
    if (!s.queueAutoStart || s.queueBedClearConfirm) return afterBedClear(s);
    return { wait: null, delay: delayMs(s) };
}

function seconds(value: number): number {
    return Number.isFinite(value) && value > 0 ? value : 0;
}

function startLane(p: TimelinePrinter, order: number, now: number): Lane {
    const base = { id: p.id, order, settings: p.settings };
    const freeAt = p.state === 'idle' ? now : now + seconds(p.remainSec) * 1000;
    if (p.awaitingBedClear) {
        const next = afterBedClear(p.settings);
        return { ...base, at: freeAt + next.delay, exact: false, wait: next.wait };
    }
    if (p.state === 'idle') {
        if (p.autoStartAt !== null) return { ...base, at: Math.max(now, p.autoStartAt), exact: true, wait: null };
        return { ...base, at: now, exact: false, wait: 'manual' };
    }
    const next = afterPrint(p.settings);
    const known = p.state === 'printing' && seconds(p.remainSec) > 0;
    return { ...base, at: freeAt + next.delay, exact: known && next.wait === null, wait: next.wait };
}

function earlier(a: Lane, b: Lane): boolean {
    if (a.at !== b.at) return a.at < b.at;
    if (a.exact !== b.exact) return a.exact;
    return a.order < b.order;
}

export function queueTimeline(printers: readonly TimelinePrinter[], now: number): QueueTimeline {
    const lanes = printers.map((p, i) => startLane(p, i, now));
    return {
        place(estPrintTimeSec, printerIds) {
            let lane: Lane | undefined;
            for (const candidate of lanes) {
                if (printerIds.includes(candidate.id) && (!lane || earlier(candidate, lane))) lane = candidate;
            }
            if (!lane) return null;
            const duration = seconds(estPrintTimeSec) * 1000;
            const eta: QueueEta = {
                printerId: lane.id,
                startAt: lane.exact ? new Date(lane.at).toISOString() : null,
                endAt: lane.exact && duration > 0 ? new Date(lane.at + duration).toISOString() : null,
                wait: lane.wait,
            };
            const next = afterPrint(lane.settings);
            lane.exact = lane.exact && duration > 0 && next.wait === null;
            lane.at += duration + next.delay;
            lane.wait = next.wait;
            return eta;
        },
    };
}
