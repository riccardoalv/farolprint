import { afterEach, describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
    fetchPrinterCredentials,
    type KobraMessage,
    KobraMqttClient,
    KobraProtocolError,
    readLight,
    uploadGcode,
} from '@farolprint/kobra-protocol';
import { printerSettingsSchema, readFeatures, readPeripherals } from '@farolprint/shared';
import {
    FAKE_PRINTER_FIRMWARE,
    FAKE_PRINTER_HOST,
    FAKE_PRINTER_IDENTITY,
    FAKE_PRINTER_PORTS,
    FakePrinter,
    type FakePrinterOptions,
    type FakePrinterPorts,
    fakePrinterOptionsFromEnv,
    topicMatches,
} from '../dev/fake-printer';
import { type BridgePrinterConfig, PrinterBridge } from '../src/bridge/printer-bridge';
import type { GcodeService } from '../src/gcode/gcode.service';

const API_DIR = path.resolve(__dirname, '..');
const certs = {
    cert: fs.readFileSync(path.join(API_DIR, 'certs/anycubic_slicer.crt')),
    key: fs.readFileSync(path.join(API_DIR, 'certs/anycubic_slicer.key')),
};
const MISSING_FFMPEG = path.join(os.tmpdir(), 'farolprint-no-such-ffmpeg');
const ACK = { code: 0, msgid: expect.any(String) };

interface Received {
    suffix: string;
    payload: KobraMessage<Record<string, unknown>>;
}

const printers: FakePrinter[] = [];
const clients: KobraMqttClient[] = [];
const bridges: PrinterBridge[] = [];

afterEach(async () => {
    for (const b of bridges.splice(0)) await b.stop();
    for (const c of clients.splice(0)) await c.disconnect();
    for (const p of printers.splice(0)) await p.stop();
});

async function fake(opts: FakePrinterOptions = {}) {
    const printer = new FakePrinter({
        httpPort: 0,
        mqttPort: 0,
        cameraPort: 0,
        tickMs: 0,
        ffmpeg: MISSING_FFMPEG,
        ...opts,
    });
    printers.push(printer);
    const ports = await printer.start();
    return { printer, ports };
}

function clientFor(ports: FakePrinterPorts, creds: { username: string; password: string; deviceId: string }) {
    const client = new KobraMqttClient({
        host: FAKE_PRINTER_HOST,
        port: ports.mqttPort,
        username: creds.username,
        password: creds.password,
        modeId: FAKE_PRINTER_IDENTITY.modeId,
        deviceId: creds.deviceId,
        cert: certs.cert,
        key: certs.key,
        connectTimeoutMs: 3000,
    });
    clients.push(client);
    return client;
}

async function connect(ports: FakePrinterPorts) {
    const creds = await fetchPrinterCredentials(FAKE_PRINTER_HOST, ports.httpPort);
    const client = clientFor(ports, creds);
    const reports: Received[] = [];
    client.on('report', (suffix, payload) =>
        reports.push({ suffix, payload: payload as KobraMessage<Record<string, unknown>> }),
    );
    await client.connect();
    return { client, reports };
}

function nextReport(
    client: KobraMqttClient,
    suffix: string,
    match: (p: KobraMessage<Record<string, unknown>>) => boolean = () => true,
    timeoutMs = 2000,
): Promise<KobraMessage<Record<string, unknown>>> {
    return new Promise((resolve, reject) => {
        const on = (s: string, payload: KobraMessage) => {
            const p = payload as KobraMessage<Record<string, unknown>>;
            if (s !== suffix || !match(p)) return;
            clearTimeout(timer);
            client.off('report', on);
            resolve(p);
        };
        const timer = setTimeout(() => {
            client.off('report', on);
            reject(new Error(`no ${suffix} report within ${timeoutMs} ms`));
        }, timeoutMs);
        client.on('report', on);
    });
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

function since(reports: Received[], from: number, suffix: string) {
    return reports.slice(from).filter((r) => r.suffix === suffix);
}

async function until(check: () => boolean, timeoutMs = 8000): Promise<void> {
    const end = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() > end) throw new Error('condition not met in time');
        await pause(20);
    }
}

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, FAKE_PRINTER_HOST, () => {
            const { port } = server.address() as net.AddressInfo;
            server.close(() => resolve(port));
        });
    });
}

function canListen(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.once('error', () => resolve(false));
        server.listen(port, FAKE_PRINTER_HOST, () => server.close(() => resolve(true)));
    });
}

function startPayload(filename: string, filepath: string | null, extra: Record<string, unknown> = {}) {
    return {
        taskid: '-1',
        url: '',
        filename,
        md5: '',
        filepath,
        filetype: 1,
        project_type: 1,
        filesize: 4,
        ams_settings: { use_ams: false, ams_box_mapping: [] },
        task_settings: {
            auto_leveling: 1,
            vibration_compensation: 0,
            flow_calibration: 1,
            dry_mode: 0,
            ai_settings: { status: 0, count: 0, type: 1 },
            timelapse: { status: 0, count: 0, type: 64 },
            drying_settings: { status: 0, target_temp: 0, duration: 0, remain_time: 0 },
            model_objects_skip_parts: [],
        },
        ...extra,
    };
}

describe('fake printer HTTP', () => {
    it('hands out the credentials FarolPrint decrypts from /ctrl', async () => {
        const { ports } = await fake();
        expect(await fetchPrinterCredentials(FAKE_PRINTER_HOST, ports.httpPort)).toEqual({
            printerIp: '127.0.0.1',
            username: 'fake-user',
            password: 'fake-password',
            deviceId: 'fake-kobra4-device',
            modeId: '20028',
            model: 'Anycubic Kobra 4',
        });
    });

    it('refuses a /ctrl request whose signature does not match the /info token', async () => {
        const { ports } = await fake();
        const base = `http://${FAKE_PRINTER_HOST}:${ports.httpPort}`;
        const info = await (await fetch(`${base}/info`)).json();
        expect(info.token).toHaveLength(32);
        const res = await fetch(`${base}/ctrl?ts=1&nonce=abcdef&sign=wrong&did=random`, { method: 'POST' });
        expect(res.status).toBe(403);
    });

    it('answers 404 for other paths and methods', async () => {
        const { ports } = await fake();
        const base = `http://${FAKE_PRINTER_HOST}:${ports.httpPort}`;
        expect((await fetch(`${base}/ctrl`)).status).toBe(404);
        expect((await fetch(`${base}/info`, { method: 'POST' })).status).toBe(404);
        expect((await fetch(`${base}/elsewhere`)).status).toBe(404);
    });

    it('takes an upload from the client and lists the file first', async () => {
        const { printer, ports } = await fake();
        const data = Buffer.from('G28\nG1 X10\n');
        const result = await uploadGcode(FAKE_PRINTER_HOST, printer.uploadUrl, 'cube.gcode', data, {
            port: ports.httpPort,
        });
        expect(result).toEqual({ code: 200, data: { gcode: 'cube.gcode' }, message: 'success' });
        const { client } = await connect(ports);
        const listed = nextReport(client, 'file/report', (p) => p.action === 'listLocal');
        client.listLocalFiles();
        const records = (await listed).data.records as { filename: string; size: number }[];
        expect(records[0]).toMatchObject({ filename: 'cube.gcode', size: data.length });
    });

    it('refuses an upload with another session token', async () => {
        const { printer, ports } = await fake();
        const url = printer.uploadUrl.replace(/s=.*/, 's=wrong');
        const error = await uploadGcode(FAKE_PRINTER_HOST, url, 'cube.gcode', Buffer.from('G28'), {
            port: ports.httpPort,
        }).catch((e) => e);
        expect(error).toBeInstanceOf(KobraProtocolError);
        expect(error.code).toBe('upload_refused');
        expect(error.params).toMatchObject({ code: 403 });
    });

    it('refuses an upload without a file name', async () => {
        const { printer, ports } = await fake();
        const error = await uploadGcode(FAKE_PRINTER_HOST, printer.uploadUrl, '', Buffer.from('G28'), {
            port: ports.httpPort,
        }).catch((e) => e);
        expect(error.code).toBe('upload_refused');
        expect(error.params).toMatchObject({ code: 19007 });
    });
});

describe('fake printer MQTT session', () => {
    it('acknowledges every request on the response topic and reports with its own msgid', async () => {
        const { client, reports } = await connect((await fake()).ports);
        const info = nextReport(client, 'info/report');
        const ack = await client.queryInfo();
        expect(ack).toEqual(ACK);
        const report = await info;
        expect(report.msgid).toBeString();
        expect(report.msgid).not.toBe(ack?.msgid);
        const acks = reports.filter((r) => r.suffix === `${FAKE_PRINTER_IDENTITY.deviceId}/response`);
        expect(acks.map((r) => r.payload)).toEqual([{ code: 0, msgid: ack?.msgid }] as never);
    });

    it('refuses a wrong password', async () => {
        const { ports } = await fake();
        const client = clientFor(ports, { ...FAKE_PRINTER_IDENTITY, password: 'wrong' });
        await expect(client.connect()).rejects.toThrow(/Not authorized/);
    });

    it('holds a single session until its client leaves', async () => {
        const { ports } = await fake();
        const { client } = await connect(ports);
        const second = clientFor(ports, FAKE_PRINTER_IDENTITY);
        await expect(second.connect()).rejects.toThrow();
        await client.disconnect();
        let connected = false;
        for (let i = 0; i < 20 && !connected; i++) {
            connected = await second.connect().then(
                () => true,
                () => false,
            );
            if (!connected) await pause(50);
        }
        expect(connected).toBe(true);
    });

    it('ignores requests for another device', async () => {
        const { printer, ports } = await fake();
        const client = clientFor(ports, { ...FAKE_PRINTER_IDENTITY, deviceId: 'another-device' });
        await client.connect();
        expect(await client.request('info', 'query', undefined, 300)).toBeNull();
        expect(printer.requests).toEqual([]);
    });
});

describe('fake printer reports', () => {
    it('reports a Kobra 4 in the middle of a print in info', async () => {
        const { printer, ports } = await fake();
        const { client } = await connect(ports);
        const next = nextReport(client, 'info/report');
        void client.queryInfo();
        const info = (await next).data;
        expect(info).toMatchObject({
            printerName: 'Fake Kobra 4',
            model: 'Anycubic Kobra 4',
            ip: '127.0.0.1',
            version: FAKE_PRINTER_FIRMWARE,
            state: 'busy',
            fan_speed_pct: 80,
            aux_fan_speed_pct: 0,
            print_speed_mode: 2,
            urls: { fileUploadurl: printer.uploadUrl, rtspUrl: printer.cameraUrl },
            project: {
                state: 'printing',
                print_status: 1,
                filename: 'Benchy_PLA_0.20mm_1h30m.gcode',
                progress: 42,
                total_layers: 240,
            },
        });
        const { token } = await (await fetch(`http://${FAKE_PRINTER_HOST}:${ports.httpPort}/info`)).json();
        expect(printer.uploadUrl).toBe(`http://127.0.0.1:${ports.httpPort}/gcode_upload?s=${token}`);
        expect(printer.cameraUrl).toBe(`http://127.0.0.1:${ports.cameraPort}/live/${token}`);
        expect(readFeatures(info.features)).toMatchObject({
            auto_leveling_support: true,
            vibration_compensation_support: true,
            flow_calibration_support: true,
            drying_first_support: false,
        });
        expect(info.temp).toEqual({
            curr_nozzle_temp: expect.any(Number),
            target_nozzle_temp: 220,
            curr_hotbed_temp: 60,
            target_hotbed_temp: 60,
        });
    });

    it('answers print/query while printing and stays silent when idle', async () => {
        const printing = await connect((await fake()).ports);
        const next = nextReport(printing.client, 'print/report');
        expect(await printing.client.queryPrint()).toEqual(ACK);
        expect((await next).data).toMatchObject({
            filename: 'Benchy_PLA_0.20mm_1h30m.gcode',
            taskid: 'fake-1',
            progress: 42,
            supplies_usage: expect.any(Number),
        });
        await printing.client.disconnect();

        const idle = await connect((await fake({ printing: false })).ports);
        const from = idle.reports.length;
        expect(await idle.client.queryPrint()).toEqual(ACK);
        await pause(150);
        expect(since(idle.reports, from, 'print/report')).toEqual([]);
    });

    it('answers status/query with a work report', async () => {
        const { client } = await connect((await fake()).ports);
        const next = nextReport(client, 'status/report');
        void client.queryStatus();
        expect(await next).toMatchObject({ action: 'workReport', state: 'busy', data: null });
    });

    it('answers the light query with two control messages listing the camera light', async () => {
        const { client, reports } = await connect((await fake()).ports);
        client.queryLight();
        await until(() => since(reports, 0, 'light/report').length === 2);
        for (const { payload } of since(reports, 0, 'light/report')) {
            expect(payload).toMatchObject({
                action: 'control',
                data: { lights: [{ type: 3, status: 1, brightness: 100 }] },
            });
            expect(readLight(payload.data)).toEqual({ on: true, brightness: 100 });
        }
    });

    it('answers a light command with the bare light', async () => {
        const { client } = await connect((await fake()).ports);
        const next = nextReport(client, 'light/report');
        client.setLight(false, 0);
        const report = await next;
        expect(report).toMatchObject({ action: 'control', data: { type: 3, status: 0, brightness: 0 } });
        expect(readLight(report.data)).toEqual({ on: false, brightness: 0 });
    });

    it('reports the camera, no USB drive and the ACE as peripherals', async () => {
        const { client } = await connect((await fake()).ports);
        const next = nextReport(client, 'peripherie/report');
        client.queryPeripherals();
        const report = await next;
        expect(report.data).toEqual({
            camera: 1,
            udisk: 0,
            multiColorBox: 1,
            mount_path: '/data/timelapse',
            usb_path: '',
            ret_code: 0,
        });
        expect(readPeripherals(report.data)).toEqual({ camera: true, usbDrive: false, ace: true });
    });

    it('reports no ACE and an empty box list without one', async () => {
        const { client } = await connect((await fake({ aceUnits: 0 })).ports);
        const peripherals = nextReport(client, 'peripherie/report');
        client.queryPeripherals();
        expect(readPeripherals((await peripherals).data)).toMatchObject({ ace: false });
        const boxes = nextReport(client, 'multiColorBox/report');
        void client.queryMultiColorBox();
        expect((await boxes).data).toEqual({ multi_color_box: [] });
    });

    it('reports the ACE slots and applies slot, refill, drying and feed commands', async () => {
        const { client } = await connect((await fake({ aceUnits: 2 })).ports);
        const box = async (send: () => unknown) => {
            const next = nextReport(client, 'multiColorBox/report');
            void send();
            const boxes = (await next).data.multi_color_box as Record<string, unknown>[];
            return boxes;
        };
        const initial = await box(() => client.queryMultiColorBox());
        expect(initial.map((b) => b.id)).toEqual([0, 1]);
        expect(initial[0]).toMatchObject({ loaded_slot: 0, auto_feed: 1 });
        expect(initial[0].slots).toHaveLength(4);

        const edited = await box(() => client.setAmsSlotInfo(0, 3, 'PETG', [1, 2, 3]));
        expect((edited[0].slots as unknown[])[3]).toMatchObject({
            type: 'PETG',
            color: [1, 2, 3],
            status: 5,
            edit_status: 1,
        });
        expect((await box(() => client.setAutoFeed(1, false)))[1]).toMatchObject({ auto_feed: 0 });
        const drying = await box(() =>
            client.setDry([0], { status: 1, target_temp: 45, duration: 240, remain_time: 240 }),
        );
        expect(drying[0].drying_status).toMatchObject({ status: 1, target_temp: 45, duration: 240, remain_time: 240 });
        const stopped = await box(() => client.setDry([0], { status: 0 }));
        expect(stopped[0].drying_status).toMatchObject({ status: 0, target_temp: 0, duration: 0, remain_time: 0 });

        const unloaded = await box(() => client.feedFilament(0, 0, 2));
        expect(unloaded[0]).toMatchObject({
            loaded_slot: -1,
            feed_status: { slot_index: 0, type: 2, current_status: 11 },
        });
        const loaded = await box(() => client.feedFilament(1, 2, 1));
        expect(loaded[1]).toMatchObject({
            loaded_slot: 2,
            feed_status: { slot_index: 2, type: 1, current_status: 10 },
        });
        const finished = await box(() => client.feedFilament(1, 2, 3));
        expect(finished[1]).toMatchObject({
            loaded_slot: 2,
            feed_status: { slot_index: -1, type: -1, current_status: -1 },
        });
    });

    it('lists the root and the test models, newest first, in every path form the client may send', async () => {
        const { client } = await connect((await fake()).ports);
        const list = async (p: string) => {
            const next = nextReport(client, 'file/report', (r) => r.action === 'listLocal');
            client.listLocalFiles(p);
            const report = await next;
            expect(report.code).toBe(200);
            return (report.data.records as { filename: string; timestamp: number }[]).map((r) => r.filename);
        };
        expect(await list('/')).toEqual(['Benchy_PLA_0.20mm_1h30m.gcode', 'Bracket_PETG_0.20mm_45m.gcode']);
        for (const p of ['/test_model', 'test_model', '/test_model/']) {
            expect(await list(p)).toEqual(['Fake_Test_Cube.gcode', 'Fake_Test_Boat.gcode']);
        }
        expect(await list('/elsewhere')).toEqual([]);
    });

    it('sends file details with a thumbnail for root files and test models', async () => {
        const { client } = await connect((await fake()).ports);
        const details = async (filename: string) => {
            const next = nextReport(client, 'file/report', (r) => r.action === 'fileDetails');
            client.requestFileDetails(filename);
            return (await next).data as { filename: string; file_details: { thumbnail?: string } };
        };
        for (const name of [
            'Benchy_PLA_0.20mm_1h30m.gcode',
            'test_model/Fake_Test_Cube.gcode',
            '/test_model/Fake_Test_Boat.gcode',
        ]) {
            const d = await details(name);
            expect(d.filename).toBe(name);
            expect(d.file_details.thumbnail?.length).toBeGreaterThan(100);
        }
        expect((await details('missing.gcode')).file_details.thumbnail).toBeUndefined();
    });

    it('deletes root files', async () => {
        const { client } = await connect((await fake()).ports);
        const deleted = nextReport(client, 'file/report', (r) => r.action === 'deleteBatch');
        client.deleteLocalFiles(['Bracket_PETG_0.20mm_45m.gcode']);
        expect(await deleted).toMatchObject({ state: 'success', code: 200 });
        const listed = nextReport(client, 'file/report', (r) => r.action === 'listLocal');
        client.listLocalFiles();
        const records = (await listed).data.records as { filename: string }[];
        expect(records.map((r) => r.filename)).toEqual(['Benchy_PLA_0.20mm_1h30m.gcode']);
    });

    it('keeps the skipped objects of the running print', async () => {
        const { client } = await connect((await fake()).ports);
        const empty = nextReport(client, 'skip/report');
        void client.querySkipObjects();
        expect((await empty).data).toEqual({ objects_skip_parts: [] });
        const skipped = nextReport(client, 'skip/report');
        expect(await client.skipObjects(['part_1', 'part_2'])).toEqual(ACK);
        expect((await skipped).data).toEqual({ objects_skip_parts: ['part_1', 'part_2'] });
    });

    it('answers a fan change with a fan report and, while printing, an updated print report', async () => {
        const { client } = await connect((await fake()).ports);
        const fan = nextReport(client, 'fan/report');
        const updated = nextReport(client, 'print/report', (p) => p.state === 'updated');
        client.setFan(55);
        expect((await fan).data).toEqual({ fan_speed_pct: 55 });
        expect((await updated).data.settings).toMatchObject({ fan_speed_pct: 55 });
    });

    it('acknowledges print/update on the web topic with an updated report carrying the settings', async () => {
        const { printer, ports } = await fake();
        const { client } = await connect(ports);
        const nozzle = nextReport(client, 'print/report', (p) => p.state === 'updated');
        client.setPrintingTemperature('fake-1', 230);
        const report = await nozzle;
        expect(report.action).toBe('update');
        expect(report.data).toMatchObject({
            filename: 'Benchy_PLA_0.20mm_1h30m.gcode',
            taskid: 'fake-1',
            settings: {
                target_nozzle_temp: 230,
                target_hotbed_temp: 60,
                print_speed_mode: 2,
                fan_speed_pct: 80,
                z_comp: 0,
            },
        });
        const speed = nextReport(client, 'print/report', (p) => p.state === 'updated');
        client.setPrintSpeedMode('fake-1', 3);
        expect((await speed).data.settings).toMatchObject({ print_speed_mode: 3 });
        const updates = printer.requests.filter((r) => r.type === 'print' && r.action === 'update');
        expect(updates.map((r) => r.channel)).toEqual(['web', 'web']);
    });

    it('refuses tempature/set during a print and applies it when idle', async () => {
        const busy = await connect((await fake()).ports);
        const refused = nextReport(busy.client, 'tempature/report');
        busy.client.setIdleTemperature(200);
        expect(await refused).toMatchObject({ state: 'failed', code: 10301 });
        await busy.client.disconnect();

        const idle = await connect((await fake({ printing: false })).ports);
        const both = nextReport(idle.client, 'tempature/report', (p) => p.action === 'set');
        idle.client.setIdleTemperature(200, 55);
        expect((await both).data).toMatchObject({ target_nozzle_temp: 200, target_hotbed_temp: 55 });
        const nozzle = nextReport(idle.client, 'tempature/report', (p) => p.action === 'set');
        idle.client.setIdleTemperature(180);
        expect((await nozzle).data).toMatchObject({ target_nozzle_temp: 180, target_hotbed_temp: 55 });
        const bed = nextReport(idle.client, 'tempature/report', (p) => p.action === 'set');
        idle.client.setIdleTemperature(undefined, 40);
        expect((await bed).data).toMatchObject({ target_nozzle_temp: 180, target_hotbed_temp: 40 });
    });

    it('moves the axes when idle and refuses while printing', async () => {
        const busy = await connect((await fake()).ports);
        expect(await busy.client.moveAxis(1, 1, 10)).toMatchObject({ state: 'failed', code: 10301 });
        await busy.client.disconnect();

        const idle = await connect((await fake({ printing: false })).ports);
        expect(await idle.client.moveAxis(5, 2)).toMatchObject({ action: 'move', state: 'done', code: 200 });
        const off = nextReport(idle.client, 'axis/report', (p) => p.action === 'turnOff');
        idle.client.disableSteppers();
        expect(await off).toMatchObject({ state: 'done' });
    });

    it('answers the camera commands with the cloud push states', async () => {
        const { client, reports } = await connect((await fake()).ports);
        expect(await client.startCamera()).toEqual(ACK);
        await until(() => since(reports, 0, 'video/report').length === 3);
        expect(since(reports, 0, 'video/report').map((r) => r.payload.state)).toEqual([
            'initSuccess',
            'joinSuccess',
            'pushStarted',
        ]);
        const stopped = nextReport(client, 'video/report', (p) => p.action === 'stopCapture');
        void client.stopCamera();
        expect((await stopped).state).toBe('pushStopped');
    });

    it('renames the printer from the web topic and answers with info', async () => {
        const { printer, ports } = await fake();
        const { client } = await connect(ports);
        const next = nextReport(client, 'info/report', (p) => p.action === 'setPrinterName');
        client.setPrinterName('Workshop');
        expect((await next).data.printerName).toBe('Workshop');
        expect(printer.requests.find((r) => r.action === 'setPrinterName')?.channel).toBe('web');
    });

    it('pushes temperatures as they change', async () => {
        let clock = Date.UTC(2026, 10, 23);
        const { printer, ports } = await fake({ printing: false, now: () => clock });
        const { client } = await connect(ports);
        const set = nextReport(client, 'tempature/report', (p) => p.action === 'set');
        client.setIdleTemperature(200);
        await set;
        const heating = nextReport(client, 'tempature/report', (p) => p.action === 'report');
        clock += 10_000;
        printer.tick();
        expect((await heating).data).toEqual({
            curr_nozzle_temp: 64,
            target_nozzle_temp: 200,
            curr_hotbed_temp: 24,
            target_hotbed_temp: 0,
        });
    });
});

describe('fake printer print lifecycle', () => {
    it('pauses with the user pause code and resumes', async () => {
        const { client, reports } = await connect((await fake()).ports);
        const paused = nextReport(client, 'print/report', (p) => p.state === 'paused');
        expect(await client.pausePrint('fake-1')).toEqual(ACK);
        expect(await paused).toMatchObject({ code: 10401, msg: expect.any(String) });
        expect(since(reports, 0, 'print/report').map((r) => r.payload.state)).toEqual(['pausing', 'paused']);

        const again = nextReport(client, 'print/report');
        void client.queryPrint();
        expect(await again).toMatchObject({ state: 'paused', code: 10401 });

        const updated = nextReport(client, 'print/report', (p) => p.state === 'updated');
        client.setPrintingTemperature('fake-1', 225);
        expect((await updated).data.settings).toMatchObject({ target_nozzle_temp: 225 });

        const from = reports.length;
        const printing = nextReport(client, 'print/report', (p) => p.state === 'printing');
        void client.resumePrint('fake-1');
        expect(await printing).toMatchObject({ code: 200 });
        expect(since(reports, from, 'print/report').map((r) => r.payload.state)).toEqual(['resuming', 'printing']);
    });

    it('stops with the user stop code, then acknowledges the cleared targets and goes idle', async () => {
        const { printer, ports } = await fake();
        const { client, reports } = await connect(ports);
        const updated = nextReport(client, 'print/report', (p) => p.state === 'updated');
        void client.stopPrint('fake-1');
        expect((await updated).data.settings).toMatchObject({ target_nozzle_temp: 0, target_hotbed_temp: 0 });
        const states = since(reports, 0, 'print/report').map((r) => [r.payload.state, r.payload.code]);
        expect(states).toEqual([
            ['stopping', 200],
            ['stoped', 10601],
            ['updated', 200],
        ]);
        expect(printer.printState).toBe('free');
        const info = nextReport(client, 'info/report');
        void client.queryInfo();
        const data = (await info).data;
        expect(data.state).toBe('free');
        expect(data.project).toBeUndefined();
        expect(data.last_project).toMatchObject({ state: 'stoped', filename: 'Benchy_PLA_0.20mm_1h30m.gcode' });
    });

    it('refuses the print commands that need a print when idle', async () => {
        const { client } = await connect((await fake({ printing: false })).ports);
        const commands: [string, () => unknown][] = [
            ['print/report', () => client.pausePrint()],
            ['print/report', () => client.resumePrint()],
            ['print/report', () => client.stopPrint()],
            ['print/report', () => client.setPrintSpeedMode('-1', 3)],
            ['skip/report', () => client.skipObjects(['part_1'])],
        ];
        for (const [suffix, send] of commands) {
            const refused = nextReport(client, suffix);
            void send();
            expect(await refused).toMatchObject({ state: 'failed', code: 10102 });
        }
    });

    it('refuses to start a second print or a file it does not have', async () => {
        const busy = await connect((await fake()).ports);
        const exists = nextReport(busy.client, 'print/report', (p) => p.state === 'failed');
        void busy.client.startPrint(startPayload('Bracket_PETG_0.20mm_45m.gcode', null));
        expect(await exists).toMatchObject({ code: 10101 });
        await busy.client.disconnect();

        const idle = await connect((await fake({ printing: false })).ports);
        const missing = nextReport(idle.client, 'print/report', (p) => p.state === 'failed');
        void idle.client.startPrint(startPayload('missing.gcode', null));
        expect(await missing).toMatchObject({ code: 10105 });
    });

    it('runs an uploaded file through the calibrations it was asked for, prints it and finishes', async () => {
        let clock = Date.UTC(2026, 10, 23);
        const { printer, ports } = await fake({ printing: false, printSec: 600, now: () => clock });
        await uploadGcode(FAKE_PRINTER_HOST, printer.uploadUrl, 'cube.gcode', Buffer.from('G28'), {
            port: ports.httpPort,
        });
        const { client, reports } = await connect(ports);
        const step = async (ms: number) => {
            clock += ms;
            printer.tick();
            await pause(30);
        };
        expect(await client.startPrint(startPayload('cube.gcode', null))).toEqual(ACK);
        await until(() => since(reports, 0, 'print/report').length === 1);
        await step(30_000);
        await step(30_000);
        await step(8_000);
        await step(8_000);
        await step(120_000);
        await step(600_000);
        const states = since(reports, 0, 'print/report').map((r) => r.payload.state);
        expect(states).toEqual(['preheating', 'auto_leveling', 'flow_calibrating', 'printing', 'printing', 'finished']);
        const prints = since(reports, 0, 'print/report').map((r) => r.payload.data);
        expect(prints[0]).toMatchObject({ filename: 'cube.gcode', progress: 0, curr_layer: 0, taskid: 'fake-2' });
        expect(prints[4]).toMatchObject({ progress: 20, print_time: 2, remain_time: 8, curr_layer: 48 });
        expect(prints[5]).toMatchObject({ progress: 100 });
        expect(since(reports, 0, 'tempature/report').length).toBeGreaterThan(1);
        expect(printer.printState).toBe('free');
    });

    it('starts a test model by its folder path and loads the slot of the first mapping', async () => {
        const { client } = await connect((await fake({ printing: false })).ports);
        const started = nextReport(client, 'print/report', (p) => p.state === 'preheating');
        void client.startPrint(
            startPayload('Fake_Test_Cube.gcode', '/test_model/Fake_Test_Cube.gcode', {
                ams_settings: { use_ams: true, ams_box_mapping: [{ ams_index: 2 }] },
            }),
        );
        expect((await started).data).toMatchObject({ filename: 'Fake_Test_Cube.gcode' });
        const boxes = nextReport(client, 'multiColorBox/report');
        void client.queryMultiColorBox();
        expect(((await boxes).data.multi_color_box as { loaded_slot: number }[])[0].loaded_slot).toBe(2);
    });
});

const CLIENT_INFRASTRUCTURE = new Set([
    'constructor',
    'connected',
    'topic',
    'subscribeTopic',
    'connect',
    'onClientError',
    'disconnect',
    'failAllPending',
    'onMessage',
    'settle',
    'buildPayload',
    'request',
    'send',
    'publishWeb',
]);

const CLIENT_COMMANDS: Record<string, (c: KobraMqttClient) => unknown> = {
    queryInfo: (c) => c.queryInfo(),
    queryStatus: (c) => c.queryStatus(),
    queryPrint: (c) => c.queryPrint(),
    queryMultiColorBox: (c) => c.queryMultiColorBox(),
    queryLight: (c) => c.queryLight(),
    queryPeripherals: (c) => c.queryPeripherals(),
    setPrinterName: (c) => c.setPrinterName('Fake Kobra 4'),
    setPrintSpeedMode: (c) => c.setPrintSpeedMode('fake-1', 2),
    setPrintingTemperature: (c) => c.setPrintingTemperature('fake-1', 220, 60),
    setIdleTemperature: (c) => c.setIdleTemperature(200),
    setFan: (c) => c.setFan(80),
    setLight: (c) => c.setLight(true, 100),
    querySkipObjects: (c) => c.querySkipObjects(),
    skipObjects: (c) => c.skipObjects(['part_1']),
    requestFileDetails: (c) => c.requestFileDetails('Benchy_PLA_0.20mm_1h30m.gcode'),
    listLocalFiles: (c) => c.listLocalFiles(),
    deleteLocalFiles: (c) => c.deleteLocalFiles(['Bracket_PETG_0.20mm_45m.gcode']),
    setAmsSlotInfo: (c) => c.setAmsSlotInfo(0, 1, 'PLA', [10, 20, 30]),
    feedFilament: (c) => c.feedFilament(0, 1, 1),
    setAutoFeed: (c) => c.setAutoFeed(0, true),
    setDry: (c) => c.setDry([0], { status: 0 }),
    startCamera: (c) => c.startCamera(),
    stopCamera: (c) => c.stopCamera(),
    moveAxis: (c) => c.moveAxis(1, 1, 10),
    disableSteppers: (c) => c.disableSteppers(),
    pausePrint: (c) => c.pausePrint('fake-1'),
    resumePrint: (c) => c.resumePrint('fake-1'),
    stopPrint: (c) => c.stopPrint('fake-1'),
    startPrint: (c) => c.startPrint(startPayload('Benchy_PLA_0.20mm_1h30m.gcode', null)),
};

describe('fake printer drift guard', () => {
    it('covers every command of the protocol client', () => {
        const commands = Object.getOwnPropertyNames(KobraMqttClient.prototype).filter(
            (name) => !CLIENT_INFRASTRUCTURE.has(name),
        );
        expect(commands.sort()).toEqual(Object.keys(CLIENT_COMMANDS).sort());
    });

    it('acknowledges and answers every command the client sends', async () => {
        const { printer, ports } = await fake();
        const { client, reports } = await connect(ports);
        for (const send of Object.values(CLIENT_COMMANDS)) await send(client);
        await pause(200);
        expect(printer.unhandled).toEqual([]);
        const acks = reports.filter((r) => r.suffix === `${FAKE_PRINTER_IDENTITY.deviceId}/response`);
        expect(acks).toHaveLength(printer.requests.length);
        const answered = new Set(reports.map((r) => r.suffix.split('/')[0]));
        for (const request of printer.requests) expect(answered.has(request.type)).toBe(true);
    });
});

function gcodeFake() {
    const jobs = { started: [] as string[], finished: [] as string[] };
    const gcode = {
        getByFilename: async () => null,
        findOpenJob: async () => null,
        setJobPaused: async () => undefined,
        startJob: async (_printerId: string, filename: string) => {
            jobs.started.push(filename);
            return `job-${jobs.started.length}`;
        },
        closeOpenJobs: async () => 0,
        finishJob: async (_jobId: string, status: string) => {
            jobs.finished.push(status);
        },
        updateObjects: async () => undefined,
    } as unknown as GcodeService;
    return { gcode, jobs };
}

async function bridgeOn(printer: FakePrinter, ports: FakePrinterPorts) {
    const creds = await fetchPrinterCredentials(FAKE_PRINTER_HOST, ports.httpPort);
    const config: BridgePrinterConfig = {
        id: 'fake-printer',
        name: 'Fake',
        ip: creds.printerIp,
        mqttPort: ports.mqttPort,
        username: creds.username,
        password: creds.password,
        deviceId: creds.deviceId,
        modeId: creds.modeId,
        model: creds.model,
        httpPort: 7125,
        settings: printerSettingsSchema.parse({ cameraAlwaysOn: false, pollIntervalSec: 1 }),
    };
    const { gcode, jobs } = gcodeFake();
    const bridge = new PrinterBridge(config, gcode, certs);
    bridges.push(bridge);
    const warnings: string[] = [];
    const errors: string[] = [];
    const log = (bridge as unknown as { log: Record<string, (msg: string) => void> }).log;
    log.log = () => undefined;
    log.debug = () => undefined;
    log.warn = (msg) => warnings.push(msg);
    log.error = (msg) => errors.push(msg);
    const refused: unknown[] = [];
    bridge.on('refused', (r) => refused.push(r));
    let lightTriggers = 0;
    bridge.on('light_trigger', () => {
        lightTriggers += 1;
    });
    bridge.start();
    await until(() => {
        const s = bridge.snapshot();
        return s.connected && s.peripherals !== null && s.features !== null;
    });
    return { bridge, jobs, warnings, errors, refused, printer, lightTriggers: () => lightTriggers };
}

describe('PrinterBridge on the fake printer', () => {
    it('shows the print, the printer and the ACE the way the dashboard reads them', async () => {
        const { printer, ports } = await fake();
        const h = await bridgeOn(printer, ports);
        await until(() => h.bridge.snapshot().amsSlots.length === 4 && h.bridge.snapshot().deviceName !== null);
        const s = h.bridge.snapshot();
        expect(s).toMatchObject({
            connected: true,
            printState: 'printing',
            kobraState: 'printing',
            filename: 'Benchy_PLA_0.20mm_1h30m.gcode',
            firmwareVersion: FAKE_PRINTER_FIRMWARE,
            deviceName: 'Fake Kobra 4',
            cameraUrl: printer.cameraUrl,
            peripherals: { camera: true, usbDrive: false, ace: true },
            filamentMode: 'ace_direct',
            amsLoadedSlot: 0,
            lightOn: true,
            totalLayers: 240,
        });
        expect(s.progress).toBeCloseTo(0.42, 2);
        expect(s.features).toMatchObject({ flow_calibration_support: true, drying_first_support: false });
        expect(h.jobs.started).toEqual(['Benchy_PLA_0.20mm_1h30m.gcode']);
        const onConnect = printer.requests.filter(
            (r) => r.action === 'query' && ['light', 'peripherie'].includes(r.type),
        );
        expect(onConnect.map((r) => `${r.channel} ${r.type}`)).toEqual(['web light', 'slicer peripherie']);
        expect(h.lightTriggers()).toBe(0);
        expect(h.refused).toEqual([]);
        expect(h.warnings).toEqual([]);
        expect(h.errors).toEqual([]);
    }, 15_000);

    it('lists the printer files and the test models and reads a thumbnail', async () => {
        const { printer, ports } = await fake();
        const h = await bridgeOn(printer, ports);
        const list = await h.bridge.listPrinterFiles();
        expect(list.files.map((f) => f.filename)).toEqual([
            'Benchy_PLA_0.20mm_1h30m.gcode',
            'Bracket_PETG_0.20mm_45m.gcode',
        ]);
        expect(list.testModels.map((f) => [f.folder, f.filename])).toEqual([
            ['test_model', 'Fake_Test_Cube.gcode'],
            ['test_model', 'Fake_Test_Boat.gcode'],
        ]);
        expect(list.truncated).toBe(false);
        expect((await h.bridge.printerFileThumbnail('test_model/Fake_Test_Cube.gcode')).length).toBeGreaterThan(100);
        expect(h.refused).toEqual([]);
        expect(h.warnings).toEqual([]);
    }, 15_000);

    it('pauses, resumes and cancels, and the updated report after the cancel leaves it cancelled', async () => {
        const { printer, ports } = await fake();
        const h = await bridgeOn(printer, ports);
        await h.bridge.pause();
        await until(() => h.bridge.snapshot().printState === 'paused');
        expect(h.bridge.snapshot().errorCode).toBe(10401);
        await h.bridge.resume();
        await until(() => h.bridge.snapshot().kobraState === 'printing');
        expect(h.bridge.snapshot().errorCode).toBe(0);
        h.bridge.setTemperature(230, 65);
        const temperatures = () =>
            printer.requests.filter((r) => r.type === 'tempature' || (r.type === 'print' && r.action === 'update'));
        await until(() => temperatures().length >= 2);
        await pause(50);
        expect(temperatures().map((r) => `${r.channel} ${r.type}/${r.action}`)).toEqual([
            'web print/update',
            'web print/update',
        ]);
        await h.bridge.cancel();
        await until(() => h.bridge.snapshot().kobraState === 'stoped');
        await pause(200);
        expect(h.bridge.snapshot()).toMatchObject({ printState: 'standby', filename: '', progress: 0 });
        expect(h.jobs.finished).toEqual(['cancelled']);
        await until(() => h.bridge.snapshot().kobraState === 'free');
        expect(h.bridge.snapshot().printState).toBe('standby');
        expect(h.refused).toEqual([]);
        expect(h.warnings.length).toBeGreaterThan(0);
        for (const warning of h.warnings) expect(warning).toStartWith('Printer paused: [10401]');
        expect(h.errors).toEqual([]);
    }, 15_000);

    it('starts a test model and follows it from the calibrations to the first layer', async () => {
        let clock = Date.UTC(2026, 10, 23);
        const { printer, ports } = await fake({ printing: false, now: () => clock });
        const h = await bridgeOn(printer, ports);
        await until(() => h.bridge.snapshot().kobraState === 'free');
        await h.bridge.printPrinterFile('test_model/Fake_Test_Cube.gcode', 812_004);
        await until(() => h.bridge.snapshot().kobraState === 'preheating');
        expect(h.bridge.snapshot()).toMatchObject({ printState: 'printing', progress: 0 });
        const start = printer.requests.find((r) => r.type === 'print' && r.action === 'start');
        expect(start?.data).toMatchObject({
            filename: 'Fake_Test_Cube.gcode',
            filepath: '/test_model/Fake_Test_Cube.gcode',
            task_settings: { auto_leveling: 1, vibration_compensation: 0, flow_calibration: 1 },
        });
        const seen: string[] = [];
        h.bridge.on('state', (s) => {
            if (seen[seen.length - 1] !== s.kobraState) seen.push(s.kobraState);
        });
        for (const ms of [60_000, 8_000, 8_000, 30_000]) {
            clock += ms;
            printer.tick();
            await pause(50);
        }
        await until(() => h.bridge.snapshot().currLayer > 0);
        expect(seen).toEqual(expect.arrayContaining(['auto_leveling', 'flow_calibrating', 'printing']));
        expect(h.bridge.snapshot().printState).toBe('printing');
        expect(h.jobs.started).toEqual(['/test_model/Fake_Test_Cube.gcode']);
        expect(h.refused).toEqual([]);
        expect(h.warnings).toEqual([]);
    }, 15_000);
});

describe('fake printer camera', () => {
    it('answers 503 without ffmpeg and keeps answering the rest', async () => {
        const { printer, ports } = await fake();
        const res = await fetch(printer.cameraUrl);
        expect(res.status).toBe(503);
        expect((await fetch(`http://${FAKE_PRINTER_HOST}:${ports.httpPort}/info`)).status).toBe(200);
    });

    it('answers 404 outside its stream path', async () => {
        const { ports } = await fake();
        expect((await fetch(`http://${FAKE_PRINTER_HOST}:${ports.cameraPort}/live/wrong`)).status).toBe(404);
    });
});

describe('fake printer ports and command line', () => {
    it('uses the printer ports by default and reads overrides from the environment', () => {
        expect(fakePrinterOptionsFromEnv({})).toEqual({
            httpPort: 18910,
            mqttPort: 9883,
            cameraPort: 18088,
            aceUnits: 1,
            printSec: 5400,
        });
        expect(FAKE_PRINTER_PORTS).toEqual({ httpPort: 18910, mqttPort: 9883, cameraPort: 18088 });
        expect(
            fakePrinterOptionsFromEnv({
                FAROLPRINT_FAKE_HTTP_PORT: '0',
                FAROLPRINT_FAKE_MQTT_PORT: ' 19883 ',
                FAROLPRINT_FAKE_CAMERA_PORT: '28088',
                FAROLPRINT_FAKE_ACE_UNITS: '0',
                FAROLPRINT_FAKE_PRINT_SEC: '120',
            }),
        ).toEqual({ httpPort: 0, mqttPort: 19883, cameraPort: 28088, aceUnits: 0, printSec: 120 });
        for (const env of [
            { FAROLPRINT_FAKE_HTTP_PORT: 'abc' },
            { FAROLPRINT_FAKE_MQTT_PORT: '70000' },
            { FAROLPRINT_FAKE_CAMERA_PORT: '-1' },
            { FAROLPRINT_FAKE_ACE_UNITS: '5' },
            { FAROLPRINT_FAKE_PRINT_SEC: '0' },
        ]) {
            expect(() => fakePrinterOptionsFromEnv(env)).toThrow();
        }
    });

    it('frees every port on stop', async () => {
        const { printer, ports } = await fake();
        await connect(ports);
        await printer.stop();
        for (const port of Object.values(ports)) expect(await canListen(port)).toBe(true);
        const again = await fake(ports);
        expect(again.ports).toEqual(ports);
    });

    it('fails to start on a taken port and frees the ones it opened', async () => {
        const httpPort = await freePort();
        const taken = net.createServer();
        await new Promise<void>((resolve) => taken.listen(0, FAKE_PRINTER_HOST, resolve));
        const mqttPort = (taken.address() as net.AddressInfo).port;
        try {
            await expect(fake({ httpPort, mqttPort })).rejects.toThrow();
            expect(await canListen(httpPort)).toBe(true);
        } finally {
            await new Promise((resolve) => taken.close(resolve));
        }
    });

    it('runs as a script and stops on SIGTERM', async () => {
        const child = spawn(process.execPath, ['dev/fake-printer.ts'], {
            cwd: API_DIR,
            env: {
                ...process.env,
                FAROLPRINT_FAKE_HTTP_PORT: '0',
                FAROLPRINT_FAKE_MQTT_PORT: '0',
                FAROLPRINT_FAKE_CAMERA_PORT: '0',
                FAROLPRINT_FFMPEG: MISSING_FFMPEG,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
        try {
            const httpPort = await new Promise<number>((resolve, reject) => {
                let out = '';
                child.stdout.on('data', (chunk: Buffer) => {
                    out += chunk.toString();
                    const port = /HTTP (\d+)/.exec(out)?.[1];
                    if (port) resolve(Number(port));
                });
                child.once('exit', () => reject(new Error(`script exited: ${out}`)));
            });
            const info = await (await fetch(`http://${FAKE_PRINTER_HOST}:${httpPort}/info`)).json();
            expect(info.token).toHaveLength(32);
        } finally {
            child.kill('SIGTERM');
        }
        expect(await exited).toBe(0);
    }, 15_000);
});

describe('topicMatches', () => {
    it('follows the MQTT wildcards', () => {
        expect(topicMatches('a/b/#', 'a/b/c/d')).toBe(true);
        expect(topicMatches('a/+/c', 'a/b/c')).toBe(true);
        expect(topicMatches('a/b/c', 'a/b/c')).toBe(true);
        expect(topicMatches('a/b', 'a/b/c')).toBe(false);
        expect(topicMatches('a/b/c', 'a/b')).toBe(false);
        expect(topicMatches('a/+/c', 'a/b/d')).toBe(false);
    });
});
