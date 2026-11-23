import type { QueueEta } from '@farolprint/shared';
import { describe, expect, it } from 'vitest';
import { formatEta } from '@/lib/format';
import { m } from '@/lib/i18n';
import { etaText, queueEnd } from './queue-eta';

const printers = [{ id: 'p1', name: 'Kobra 4' }];
const now = '2026-11-23T10:00:00';
const start = '2026-11-23T14:20:00';
const end = '2026-11-23T15:05:00';
const eta = (over: Partial<QueueEta> = {}): QueueEta => ({
    printerId: 'p1',
    startAt: null,
    endAt: null,
    wait: null,
    ...over,
});

describe('etaText', () => {
    it('names the printer with the expected start and end', () => {
        expect(etaText(eta({ startAt: start, endAt: end }), printers, now)).toBe(
            m.queue_eta_range({ printer: 'Kobra 4', start: formatEta(start, now), end: formatEta(end, now) }),
        );
    });

    it('gives only the start when the file has no estimate', () => {
        expect(etaText(eta({ startAt: start }), printers, now)).toBe(
            m.queue_eta_start({ printer: 'Kobra 4', start: formatEta(start, now) }),
        );
    });

    it('says what the start waits for instead of a time', () => {
        expect(etaText(eta({ wait: 'bed_clear' }), printers)).toBe(m.queue_eta_bed_clear({ printer: 'Kobra 4' }));
        expect(etaText(eta({ wait: 'manual' }), printers)).toBe(m.queue_eta_manual({ printer: 'Kobra 4' }));
    });

    it('says the time is unknown, and falls back to the printer id', () => {
        expect(etaText(eta(), printers)).toBe(m.queue_eta_unknown({ printer: 'Kobra 4' }));
        expect(etaText(eta({ printerId: 'gone' }), printers)).toBe(m.queue_eta_unknown({ printer: 'gone' }));
    });
});

describe('queueEnd', () => {
    it('is the end of the last item going to the printer', () => {
        const items = [
            { eta: eta({ startAt: start, endAt: end }) },
            { eta: eta({ printerId: 'p2', startAt: end, endAt: '2026-11-23T18:00:00' }) },
            { eta: null },
        ];
        expect(queueEnd(items, 'p1')).toBe(end);
    });

    it('is unknown when the last item has no end or nothing goes to the printer', () => {
        expect(queueEnd([{ eta: eta({ startAt: start, endAt: end }) }, { eta: eta({ wait: 'manual' }) }], 'p1')).toBe(
            null,
        );
        expect(queueEnd([{ eta: null }], 'p1')).toBeNull();
    });
});
