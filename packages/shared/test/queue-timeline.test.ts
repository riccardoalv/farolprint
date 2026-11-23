import { describe, expect, it } from 'bun:test';
import { type QueueStartSettings, queueTimeline, type TimelinePrinter } from '../src/queue-timeline';

const NOW = Date.parse('2026-11-23T10:00:00.000Z');
const at = (sec: number) => new Date(NOW + sec * 1000).toISOString();

const auto: QueueStartSettings = {
    queueAutoStart: true,
    queueBedClearConfirm: false,
    queueAutoStartDelaySec: 30,
    lightTrigger: false,
};
const confirm: QueueStartSettings = { ...auto, queueBedClearConfirm: true };
const manual: QueueStartSettings = { ...auto, queueAutoStart: false };

function printer(over: Partial<TimelinePrinter> = {}): TimelinePrinter {
    return {
        id: 'p1',
        state: 'idle',
        remainSec: 0,
        awaitingBedClear: false,
        autoStartAt: null,
        settings: auto,
        ...over,
    };
}

describe('queueTimeline', () => {
    it('chains the start and end of each item after the current print and the wait between prints', () => {
        const timeline = queueTimeline([printer({ state: 'printing', remainSec: 600 })], NOW);
        expect(timeline.place(3600, ['p1'])).toEqual({
            printerId: 'p1',
            startAt: at(630),
            endAt: at(4230),
            wait: null,
        });
        expect(timeline.place(60, ['p1'])).toEqual({ printerId: 'p1', startAt: at(4260), endAt: at(4320), wait: null });
    });

    it('starts at the running countdown, never in the past', () => {
        expect(queueTimeline([printer({ autoStartAt: NOW + 10_000 })], NOW).place(100, ['p1'])).toEqual({
            printerId: 'p1',
            startAt: at(10),
            endAt: at(110),
            wait: null,
        });
        expect(queueTimeline([printer({ autoStartAt: NOW - 5000 })], NOW).place(100, ['p1'])?.startAt).toBe(at(0));
    });

    it('waits for the bed to be cleared after each print when the confirmation is on', () => {
        const timeline = queueTimeline([printer({ state: 'printing', remainSec: 600, settings: confirm })], NOW);
        const bedClear = { printerId: 'p1', startAt: null, endAt: null, wait: 'bed_clear' };
        expect(timeline.place(600, ['p1'])).toEqual(bedClear);
        expect(timeline.place(600, ['p1'])).toEqual(bedClear);
    });

    it('waits for a start by hand when auto-start is off', () => {
        const timeline = queueTimeline([printer({ state: 'printing', remainSec: 600, settings: manual })], NOW);
        const byHand = { printerId: 'p1', startAt: null, endAt: null, wait: 'manual' };
        expect(timeline.place(600, ['p1'])).toEqual(byHand);
        expect(timeline.place(600, ['p1'])).toEqual(byHand);
    });

    it('waits for the bed to be cleared on an idle printer, or for a start by hand without auto-start', () => {
        const awaiting = { awaitingBedClear: true };
        expect(queueTimeline([printer(awaiting)], NOW).place(600, ['p1'])?.wait).toBe('bed_clear');
        expect(queueTimeline([printer({ ...awaiting, settings: manual })], NOW).place(600, ['p1'])?.wait).toBe(
            'manual',
        );
    });

    it('waits for a start by hand on an idle printer with nothing counting down', () => {
        expect(queueTimeline([printer()], NOW).place(600, ['p1'])).toEqual({
            printerId: 'p1',
            startAt: null,
            endAt: null,
            wait: 'manual',
        });
    });

    it('gives an item without an estimate a start but no end, and no times to what follows', () => {
        const timeline = queueTimeline([printer({ autoStartAt: NOW })], NOW);
        expect(timeline.place(0, ['p1'])).toEqual({ printerId: 'p1', startAt: at(0), endAt: null, wait: null });
        expect(timeline.place(600, ['p1'])).toEqual({ printerId: 'p1', startAt: null, endAt: null, wait: null });
    });

    it('has no times after a paused print or a print without a remaining time', () => {
        const unknown = { printerId: 'p1', startAt: null, endAt: null, wait: null };
        expect(queueTimeline([printer({ state: 'paused', remainSec: 600 })], NOW).place(60, ['p1'])).toEqual(unknown);
        expect(queueTimeline([printer({ state: 'printing', remainSec: 0 })], NOW).place(60, ['p1'])).toEqual(unknown);
    });

    it('projects nothing when no listed printer can take the item', () => {
        const timeline = queueTimeline([printer()], NOW);
        expect(timeline.place(600, [])).toBeNull();
        expect(timeline.place(600, ['p9'])).toBeNull();
    });

    it('gives each item to the eligible printer that frees up first', () => {
        const timeline = queueTimeline(
            [
                printer({ id: 'p1', state: 'printing', remainSec: 3600 }),
                printer({ id: 'p2', state: 'printing', remainSec: 600 }),
            ],
            NOW,
        );
        expect(timeline.place(1200, ['p1', 'p2'])).toMatchObject({ printerId: 'p2', startAt: at(630) });
        expect(timeline.place(1200, ['p1'])).toMatchObject({ printerId: 'p1', startAt: at(3630) });
        expect(timeline.place(3600, ['p1', 'p2'])).toMatchObject({ printerId: 'p2', startAt: at(1860) });
        expect(timeline.place(1200, ['p1', 'p2'])).toMatchObject({ printerId: 'p1', startAt: at(4860) });
    });

    it('prefers the printer that starts by itself on a tie, then the first printer', () => {
        const tie = queueTimeline(
            [printer({ id: 'p1' }), printer({ id: 'p2', autoStartAt: NOW }), printer({ id: 'p3', autoStartAt: NOW })],
            NOW,
        );
        expect(tie.place(600, ['p3', 'p2', 'p1'])?.printerId).toBe('p2');
        expect(tie.place(600, ['p1', 'p3'])?.printerId).toBe('p3');
    });

    it('counts the earliest moment a bed can be cleared and started when choosing the printer', () => {
        const countdown = printer({ id: 'p2', autoStartAt: NOW + 10_000 });
        const withDelay = queueTimeline([printer({ awaitingBedClear: true }), countdown], NOW);
        expect(withDelay.place(600, ['p1', 'p2'])?.printerId).toBe('p2');
        const light = printer({ awaitingBedClear: true, settings: { ...auto, lightTrigger: true } });
        expect(queueTimeline([light, countdown], NOW).place(600, ['p1', 'p2'])).toEqual({
            printerId: 'p1',
            startAt: null,
            endAt: null,
            wait: 'bed_clear',
        });
    });
});
