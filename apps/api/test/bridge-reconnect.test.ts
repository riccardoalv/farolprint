import { afterEach, describe, expect, it, setSystemTime } from 'bun:test';
import { type BridgePrinterConfig, PrinterBridge } from '../src/bridge/printer-bridge';
import type { GcodeService } from '../src/gcode/gcode.service';

const t0 = new Date('2026-11-23T13:24:00.000Z').getTime();
const at = (sec: number) => {
    setSystemTime(new Date(t0 + sec * 1000));
    return t0 + sec * 1000;
};

afterEach(() => setSystemTime());

function setup() {
    const config = { id: 'p1', name: 'Kobra 4', ip: '127.0.0.1', mqttPort: 9883, settings: {} } as BridgePrinterConfig;
    const bridge = new PrinterBridge(config, {} as GcodeService, { cert: Buffer.alloc(0), key: Buffer.alloc(0) });
    const lines: string[] = [];
    const internals = bridge as unknown as {
        openReconnectWindow: () => void;
        connectionAttemptDue: (now: number) => boolean;
        connectionFailed: (now: number) => void;
        connectionSucceeded: () => void;
        log: { log: (m: string) => void };
    };
    internals.log.log = (m: string) => {
        lines.push(m);
    };
    return { internals, lines };
}

describe('reconnection after the printer goes away', () => {
    it('tries at every probe during the reconnection window', () => {
        const h = setup();
        at(0);
        h.internals.openReconnectWindow();
        h.internals.connectionFailed(at(5));
        expect(h.internals.connectionAttemptDue(at(10))).toBe(true);
        h.internals.connectionFailed(at(10));
        expect(h.internals.connectionAttemptDue(at(20))).toBe(true);
    });

    it('keeps trying after the window, with a delay that doubles up to five minutes', () => {
        const h = setup();
        at(0);
        h.internals.openReconnectWindow();
        expect(h.internals.connectionAttemptDue(at(31))).toBe(true);
        expect(h.lines).toContain('Reconnection window expired, retrying less often');
        h.internals.connectionFailed(at(31));
        expect(h.internals.connectionAttemptDue(at(41))).toBe(false);
        expect(h.internals.connectionAttemptDue(at(51))).toBe(true);
        h.internals.connectionFailed(at(51));
        expect(h.internals.connectionAttemptDue(at(81))).toBe(false);
        expect(h.internals.connectionAttemptDue(at(91))).toBe(true);
        let now = 91;
        for (let i = 0; i < 6; i++) {
            h.internals.connectionFailed(at(now));
            now += 300;
        }
        expect(h.lines.at(-1)).toBe('Next connection attempt in 300 s');
        expect(h.internals.connectionAttemptDue(at(now - 1))).toBe(false);
        expect(h.internals.connectionAttemptDue(at(now))).toBe(true);
    });

    it('tries right away when the session was lost without a window', () => {
        const h = setup();
        expect(h.internals.connectionAttemptDue(at(0))).toBe(true);
    });

    it('starts over after a success or a manual reconnection', () => {
        const h = setup();
        at(0);
        h.internals.connectionFailed(at(0));
        h.internals.connectionFailed(at(20));
        h.internals.connectionSucceeded();
        expect(h.internals.connectionAttemptDue(at(21))).toBe(true);
        h.internals.connectionFailed(at(21));
        expect(h.lines.at(-1)).toBe('Next connection attempt in 20 s');
        h.internals.openReconnectWindow();
        expect(h.internals.connectionAttemptDue(at(22))).toBe(true);
    });
});
