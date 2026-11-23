import { describe, expect, it, mock } from 'bun:test';
import { deviceNameSchema } from '@farolprint/shared';
import { BadRequestException } from '@nestjs/common';
import type { BridgeRegistry } from '../src/bridge/bridge.registry';
import { type BridgePrinterConfig, PrinterBridge } from '../src/bridge/printer-bridge';
import { ZodPipe } from '../src/common/zod.pipe';
import { CoreController } from '../src/core/core.controller';
import type { GcodeService } from '../src/gcode/gcode.service';
import type { StatsService } from '../src/stats/stats.service';

function setup() {
    const config = {
        id: 'printer-1',
        name: 'Workshop',
        ip: '127.0.0.1',
        mqttPort: 9883,
        username: 'u',
        password: 'p',
        deviceId: 'd',
        modeId: '20028',
        httpPort: 7125,
        settings: {},
    } as unknown as BridgePrinterConfig;
    const bridge = new PrinterBridge(config, {} as GcodeService, { cert: Buffer.alloc(0), key: Buffer.alloc(0) });
    const lines: string[] = [];
    const setPrinterName = mock((_name: string) => undefined);
    const internals = bridge as unknown as {
        onReport: (suffix: string, payload: Record<string, unknown>) => void;
        ensureConnected: () => void;
        client: { setPrinterName: typeof setPrinterName };
        log: { log: (m: string) => void };
    };
    internals.log.log = (m: string) => {
        lines.push(m);
    };
    internals.ensureConnected = () => {};
    internals.client.setPrinterName = setPrinterName;
    const report = (suffix: string, data: Record<string, unknown>) =>
        internals.onReport(suffix, { action: 'query', state: 'done', code: 200, data });
    return { bridge, lines, report, setPrinterName };
}

const kobra4 = { camera: 1, mount_path: '/data/timelapse', multiColorBox: 0, ret_code: 0, udisk: 0, usb_path: '' };

describe('peripherals', () => {
    it('keeps what the printer reports as plugged in and logs it once', () => {
        const h = setup();
        h.report('peripherie/report', kobra4);
        h.report('peripherie/report', kobra4);
        expect(h.bridge.snapshot().peripherals).toEqual({ camera: true, usbDrive: false, ace: false });
        expect(h.lines.filter((l) => l.startsWith('Peripherals'))).toEqual([
            'Peripherals reported by the printer: {"camera":true,"usbDrive":false,"ace":false}',
        ]);
    });

    it('follows a USB drive plugged in later', () => {
        const h = setup();
        h.report('peripherie/report', kobra4);
        h.report('peripherie/report', { ...kobra4, udisk: 1 });
        expect(h.bridge.snapshot().peripherals?.usbDrive).toBe(true);
    });

    it('ignores an answer without any peripheral', () => {
        const h = setup();
        h.report('peripherie/report', { ret_code: 0 });
        expect(h.bridge.snapshot().peripherals).toBeNull();
    });
});

describe('the name on the printer', () => {
    it('is read from the info report', () => {
        const h = setup();
        expect(h.bridge.snapshot().deviceName).toBeNull();
        h.report('info/report', { printerName: 'Anycubic Kobra 4' });
        expect(h.bridge.snapshot().deviceName).toBe('Anycubic Kobra 4');
        expect(h.bridge.snapshot().printerName).toBe('Workshop');
    });

    it('is changed through info/setPrinterName', () => {
        const h = setup();
        h.bridge.renameOnPrinter('Workshop');
        expect(h.setPrinterName).toHaveBeenCalledWith('Workshop');
    });

    it('goes through the device-name endpoint with a trimmed name of 1 to 30 characters', () => {
        const renameOnPrinter = mock((_name: string) => undefined);
        const ctrl = new CoreController(
            { get: () => ({ renameOnPrinter }) } as unknown as BridgeRegistry,
            {} as GcodeService,
            {} as StatsService,
        );
        const pipe = new ZodPipe(deviceNameSchema);
        ctrl.deviceName('p1', pipe.transform({ name: '  Workshop  ' }));
        expect(renameOnPrinter).toHaveBeenCalledWith('Workshop');
        expect(() => pipe.transform({ name: '   ' })).toThrow(BadRequestException);
        expect(() => pipe.transform({ name: 'x'.repeat(31) })).toThrow(BadRequestException);
    });
});
