import { describe, expect, it } from 'vitest';
import { formatDuration, formatEta } from './format';
import { m } from './i18n';

describe('formatDuration', () => {
    const h = (n: number | string) => m.duration_hours({ n });
    const min = (n: number | string) => m.duration_minutes({ n });
    const s = (n: number | string) => m.duration_seconds({ n });

    it('shows the three largest units by default', () => {
        expect(formatDuration(65_300)).toBe(`${h(18)} ${min('08')} ${s(20)}`);
        expect(formatDuration(90)).toBe(`${min(1)} ${s(30)}`);
    });

    it('can show fewer units', () => {
        expect(formatDuration(65_300, { units: 2 })).toBe(`${h(18)} ${min('08')}`);
    });

    it('shows a dash for nothing unless zero is asked for', () => {
        expect(formatDuration(0)).toBe('—');
        expect(formatDuration(-1)).toBe('—');
        expect(formatDuration(0, { zero: true })).toBe(s(0));
    });
});

describe('formatEta', () => {
    const now = '2026-11-23T10:00:00';

    it('shows the time alone today', () => {
        expect(formatEta('2026-11-23T14:20:00', now)).toBe('2:20 PM');
    });

    it('adds the weekday within a week and the date beyond', () => {
        expect(formatEta('2026-11-24T03:10:00', now)).toBe('Tue 3:10 AM');
        expect(formatEta('2026-12-02T09:00:00', now)).toBe('12/02/2026 9:00 AM');
    });
});
