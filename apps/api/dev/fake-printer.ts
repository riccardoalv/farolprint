import { type ChildProcess, spawn } from 'node:child_process';
import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo, Server, Socket } from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import { resolveFfmpeg } from '../src/bridge/camera';

export const FAKE_PRINTER_HOST = '127.0.0.1';

export const FAKE_PRINTER_IDENTITY = {
    username: 'fake-user',
    password: 'fake-password',
    deviceId: 'fake-kobra4-device',
    modeId: '20028',
    modelName: 'Anycubic Kobra 4',
} as const;

export const FAKE_PRINTER_PORTS = { httpPort: 18910, mqttPort: 9883, cameraPort: 18088 } as const;

export const FAKE_PRINTER_FIRMWARE = '0.0.0-fake';

const PRINT_SEC = 5400;
const TOTAL_LAYERS = 240;
const TOTAL_FILAMENT_MM = 12_400;
const PREPARE_STEP_SEC = 8;
const AMBIENT_C = 24;
const NOZZLE_C = 220;
const BED_C = 60;
const PRINT_FAN_PCT = 80;
const FILE_LIST_LIMIT = 256;
const MAX_ACE_UNITS = 4;
const RECORDED_REQUESTS = 500;
const CAMERA_LIGHT = 3;
const TEST_MODEL_FOLDER = 'test_model';
const CAMERA_ARGS =
    '-loglevel error -re -f lavfi -i testsrc=size=1280x720:rate=15 -c:v libx264 -preset ultrafast -tune zerolatency -pix_fmt yuv420p -g 15 -f flv -';
const QUIET_ACTIONS = new Set(['info/query', 'print/query', 'multiColorBox/getInfo']);

const CODE = {
    taskExists: 10101,
    noTask: 10102,
    downloadFailed: 10105,
    deviceBusy: 10301,
    userPause: 10401,
    userStop: 10601,
    nameRefused: 19007,
} as const;

const PRINT_STATUS: Record<string, number> = {
    printing: 1,
    finished: 2,
    failed: 3,
    preheating: 6,
    auto_leveling: 9,
    vibrating: 10,
    flow_calibrating: 11,
};

const KOBRA4_FEATURES = {
    auto_leveling_support: true,
    vibration_compensation_support: true,
    flow_calibration_support: true,
    drying_first_support: false,
    camera_timelapse_support: true,
    preheating_support: true,
    pre_cancel_support: true,
    keep_print_head_temp_support: true,
    fod_support: true,
    delete_batch_support: true,
    gcode_3mf_support: true,
    shengwang_rtc_support: true,
    shengwang_rdt_support: true,
};

const MQTT_CONNECT = 1;
const MQTT_CONNACK = 2;
const MQTT_PUBLISH = 3;
const MQTT_PUBACK = 4;
const MQTT_SUBSCRIBE = 8;
const MQTT_SUBACK = 9;
const MQTT_UNSUBSCRIBE = 10;
const MQTT_UNSUBACK = 11;
const MQTT_PINGREQ = 12;
const MQTT_PINGRESP = 13;
const MQTT_DISCONNECT = 14;
const CONNACK_ACCEPTED = 0;
const CONNACK_UNAVAILABLE = 3;
const CONNACK_NOT_AUTHORIZED = 5;

export interface FakePrinterOptions {
    httpPort?: number;
    mqttPort?: number;
    cameraPort?: number;
    aceUnits?: number;
    printSec?: number;
    printing?: boolean;
    tickMs?: number;
    ffmpeg?: string;
    now?: () => number;
    log?: (line: string) => void;
}

export interface FakePrinterPorts {
    httpPort: number;
    mqttPort: number;
    cameraPort: number;
}

interface PrintSettings {
    print_speed_mode?: number;
    target_nozzle_temp?: number;
    target_hotbed_temp?: number;
    fan_speed_pct?: number;
}

interface BoxChange {
    id?: number;
    auto_feed?: number;
    slots?: { index: number; type?: string; color?: number[] }[];
    feed_status?: { slot_index?: number; type?: number };
    drying_status?: { status?: number; target_temp?: number; duration?: number; remain_time?: number };
}

export interface FakePrinterRequestData {
    filename?: string;
    filepath?: string | null;
    path?: string;
    files?: { filename?: string; path?: string }[];
    printerName?: string;
    fan_speed_pct?: number;
    status?: number;
    brightness?: number;
    type?: number;
    target_nozzle_temp?: number;
    target_hotbed_temp?: number;
    settings?: PrintSettings;
    task_settings?: {
        auto_leveling?: number;
        vibration_compensation?: number;
        flow_calibration?: number;
        model_objects_skip_parts?: string[];
    };
    ams_settings?: { use_ams?: boolean; ams_box_mapping?: { ams_index?: number }[] };
    objects_skip_parts?: string[];
    multi_color_box?: BoxChange[];
    axis?: number;
    move_type?: number;
    distance?: number;
}

export interface FakePrinterRequest {
    channel: string;
    type: string;
    action: string;
    msgid: string;
    data: FakePrinterRequestData;
}

interface Reply {
    state?: string;
    code?: number;
    msg?: string;
    data?: unknown;
}

interface PrinterFile {
    filename: string;
    size: number;
    timestamp: number;
}

interface Job {
    filename: string;
    taskid: string;
    elapsedSec: number;
    steps: string[];
    stepSec: number;
    resumeTo: string;
}

interface Slot {
    index: number;
    status: number;
    type: string;
    color: number[];
    weight?: number;
    edit_status?: number;
}

interface Box {
    id: number;
    loaded_slot: number;
    auto_feed: number;
    feed_status: { slot_index: number; type: number; current_status: number };
    drying_status: {
        status: number;
        target_temp: number;
        duration: number;
        remain_time: number;
        humidity: number;
        current_temp: number;
    };
    slots: Slot[];
}

interface Connection {
    socket: tls.TLSSocket;
    connected: boolean;
    filters: string[];
}

const SLOT_PRESETS: Omit<Slot, 'index'>[][] = [
    [
        { status: 5, type: 'PLA', color: [240, 90, 60], weight: 72, edit_status: 0 },
        { status: 5, type: 'PETG', color: [40, 120, 220], weight: 35, edit_status: 1 },
        { status: 5, type: 'PLA', color: [245, 245, 245], weight: 8, edit_status: 0 },
        { status: 4, type: '', color: [0, 0, 0] },
    ],
    [
        { status: 5, type: 'PLA', color: [200, 30, 35], weight: 90, edit_status: 0 },
        { status: 5, type: 'PLA', color: [40, 170, 70], weight: 55, edit_status: 0 },
        { status: 5, type: 'PLA', color: [230, 200, 40], weight: 20, edit_status: 0 },
        { status: 5, type: 'PLA', color: [170, 170, 175], weight: 64, edit_status: 0 },
    ],
];

function packet(head: number, body: Buffer): Buffer {
    const length: number[] = [];
    let n = body.length;
    do {
        length.push((n % 128) | (n > 127 ? 128 : 0));
        n = Math.floor(n / 128);
    } while (n > 0);
    return Buffer.concat([Buffer.from([head, ...length]), body]);
}

function publishPacket(topic: string, payload: string): Buffer {
    const name = Buffer.from(topic);
    const size = Buffer.alloc(2);
    size.writeUInt16BE(name.length);
    return packet(MQTT_PUBLISH << 4, Buffer.concat([size, name, Buffer.from(payload)]));
}

function readPacket(buf: Buffer): { head: number; body: Buffer; rest: Buffer } | null {
    let length = 0;
    for (let i = 1; i < buf.length && i <= 4; i++) {
        length += (buf[i] & 127) * 128 ** (i - 1);
        if (buf[i] & 128) continue;
        const start = i + 1;
        if (buf.length < start + length) return null;
        return { head: buf[0], body: buf.subarray(start, start + length), rest: buf.subarray(start + length) };
    }
    return null;
}

function readCredentials(body: Buffer): { username: string; password: string } {
    let off = 0;
    const field = () => {
        const n = body.readUInt16BE(off);
        const value = body.subarray(off + 2, off + 2 + n);
        off += 2 + n;
        return value;
    };
    field();
    const flags = body[off + 1];
    off += 4;
    field();
    if (flags & 0x04) {
        field();
        field();
    }
    const username = flags & 0x80 ? field().toString('utf8') : '';
    const password = flags & 0x40 ? field().toString('utf8') : '';
    return { username, password };
}

function readFilters(body: Buffer, withQos: boolean): string[] {
    const filters: string[] = [];
    let off = 2;
    while (off + 2 <= body.length) {
        const n = body.readUInt16BE(off);
        filters.push(body.subarray(off + 2, off + 2 + n).toString('utf8'));
        off += 2 + n + (withQos ? 1 : 0);
    }
    return filters;
}

export function topicMatches(filter: string, topic: string): boolean {
    const f = filter.split('/');
    const t = topic.split('/');
    for (let i = 0; i < f.length; i++) {
        if (f[i] === '#') return true;
        if (i >= t.length || (f[i] !== '+' && f[i] !== t[i])) return false;
    }
    return f.length === t.length;
}

function md5(s: string): string {
    return createHash('md5').update(s).digest('hex');
}

function multipart(body: Buffer, boundary: string): Map<string, { filename: string; data: Buffer }> {
    const parts = new Map<string, { filename: string; data: Buffer }>();
    const delimiter = Buffer.from(`--${boundary}`);
    let start = body.indexOf(delimiter);
    while (start !== -1) {
        const headStart = start + delimiter.length + 2;
        const next = body.indexOf(delimiter, headStart);
        if (next === -1) break;
        const headEnd = body.indexOf('\r\n\r\n', headStart);
        if (headEnd !== -1 && headEnd < next) {
            const head = body.subarray(headStart, headEnd).toString('utf8');
            const name = /[;\s]name="([^"]*)"/.exec(head)?.[1];
            const filename = /filename="([^"]*)"/.exec(head)?.[1] ?? '';
            if (name) parts.set(name, { filename, data: body.subarray(headEnd + 4, Math.max(headEnd + 4, next - 2)) });
        }
        start = next;
    }
    return parts;
}

function folderOf(value: string | null | undefined): { folder: string; filename: string } {
    const parts = String(value ?? '')
        .replace(/^\/+|\/+$/g, '')
        .split('/');
    if (parts.length > 1) return { folder: parts.slice(0, -1).join('/'), filename: parts[parts.length - 1] };
    return { folder: '', filename: parts[0] };
}

function closeServer(server: Server): Promise<void> {
    return new Promise((resolve) => server.close(() => resolve()));
}

export class FakePrinter {
    readonly requests: FakePrinterRequest[] = [];
    readonly unhandled: string[] = [];
    private readonly token = randomBytes(16).toString('hex');
    private readonly sockets = new Set<Socket>();
    private readonly cameraProcs = new Set<ChildProcess>();
    private readonly now: () => number;
    private readonly log: (line: string) => void;
    private readonly ffmpeg: string;
    private readonly printSec: number;
    private readonly http: http.Server;
    private readonly camera: http.Server;
    private readonly mqtt: tls.Server;
    private readonly publicTopic =
        `anycubic/anycubicCloud/v1/printer/public/${FAKE_PRINTER_IDENTITY.modeId}/${FAKE_PRINTER_IDENTITY.deviceId}`;
    private ports: FakePrinterPorts;
    private session: Connection | null = null;
    private timer: NodeJS.Timeout | null = null;
    private lastTick: number;
    private thumbnailCache: string | null = null;
    private taskCount = 1;

    private name = 'Fake Kobra 4';
    private state = 'free';
    private job: Job | null = null;
    private lastProject: Record<string, unknown> | null = null;
    private pauseReason: { code: number; msg: string } | null = null;
    private temp = { nozzle: AMBIENT_C, nozzleTarget: 0, bed: AMBIENT_C, bedTarget: 0 };
    private fan = 0;
    private speedMode = 2;
    private light = { type: CAMERA_LIGHT, status: 1, brightness: 100 };
    private skipped: string[] = [];
    private pushedTemp = '';
    private pushedPrint = '';
    private files: PrinterFile[];
    private readonly testModels: PrinterFile[];
    private readonly boxes: Box[];

    constructor(private readonly opts: FakePrinterOptions = {}) {
        this.now = opts.now ?? Date.now;
        this.log = opts.log ?? (() => {});
        this.ffmpeg = opts.ffmpeg ?? resolveFfmpeg();
        this.printSec = Math.max(1, opts.printSec ?? PRINT_SEC);
        this.lastTick = this.now();
        this.ports = {
            httpPort: opts.httpPort ?? FAKE_PRINTER_PORTS.httpPort,
            mqttPort: opts.mqttPort ?? FAKE_PRINTER_PORTS.mqttPort,
            cameraPort: opts.cameraPort ?? FAKE_PRINTER_PORTS.cameraPort,
        };
        const seconds = Math.floor(this.now() / 1000);
        this.files = [
            { filename: 'Benchy_PLA_0.20mm_1h30m.gcode', size: 4_812_330, timestamp: seconds - 3600 },
            { filename: 'Bracket_PETG_0.20mm_45m.gcode', size: 1_903_112, timestamp: seconds - 86_400 },
        ];
        this.testModels = [
            { filename: 'Fake_Test_Cube.gcode', size: 812_004, timestamp: seconds - 864_000 },
            { filename: 'Fake_Test_Boat.gcode', size: 2_204_816, timestamp: seconds - 950_400 },
        ];
        const units = Math.min(MAX_ACE_UNITS, Math.max(0, Math.floor(opts.aceUnits ?? 1)));
        this.boxes = Array.from({ length: units }, (_, id) => this.box(id));
        if (opts.printing ?? true) this.resumeDefaultPrint();
        this.pushedTemp = JSON.stringify(this.roundedTemp());
        this.pushedPrint = this.printKey();
        this.http = http.createServer((req, res) => this.onHttp(req, res));
        this.camera = http.createServer((req, res) => this.onCamera(req, res));
        this.mqtt = tls.createServer(
            {
                cert: fs.readFileSync(path.resolve(__dirname, '../certs/anycubic_slicer.crt')),
                key: fs.readFileSync(path.resolve(__dirname, '../certs/anycubic_slicer.key')),
            },
            (socket) => this.onSocket(socket),
        );
        this.mqtt.on('tlsClientError', () => {});
        this.mqtt.on('connection', (socket: Socket) => this.track(socket));
        this.http.on('connection', (socket: Socket) => this.track(socket));
        this.camera.on('connection', (socket: Socket) => this.track(socket));
    }

    get uploadUrl(): string {
        return `http://${FAKE_PRINTER_HOST}:${this.ports.httpPort}/gcode_upload?s=${this.token}`;
    }

    get cameraUrl(): string {
        return `http://${FAKE_PRINTER_HOST}:${this.ports.cameraPort}/live/${this.token}`;
    }

    get printState(): string {
        return this.state;
    }

    async start(): Promise<FakePrinterPorts> {
        const listen = (server: Server, port: number) =>
            new Promise<number>((resolve, reject) => {
                server.once('error', reject);
                server.listen(port, FAKE_PRINTER_HOST, () => {
                    server.off('error', reject);
                    resolve((server.address() as AddressInfo).port);
                });
            });
        try {
            this.ports = {
                httpPort: await listen(this.http, this.ports.httpPort),
                mqttPort: await listen(this.mqtt, this.ports.mqttPort),
                cameraPort: await listen(this.camera, this.ports.cameraPort),
            };
        } catch (e) {
            await this.stop();
            throw e;
        }
        const tickMs = this.opts.tickMs ?? 1000;
        if (tickMs > 0) {
            this.timer = setInterval(() => this.tick(), tickMs);
            this.timer.unref();
        }
        return { ...this.ports };
    }

    async stop(): Promise<void> {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        for (const proc of this.cameraProcs) proc.kill('SIGKILL');
        for (const socket of this.sockets) socket.destroy();
        this.session = null;
        await Promise.all([closeServer(this.http), closeServer(this.mqtt), closeServer(this.camera)]);
    }

    tick(): void {
        const now = this.now();
        const dt = Math.max(0, (now - this.lastTick) / 1000);
        this.lastTick = now;
        this.heat(dt);
        this.advance(dt);
        this.pushChanges();
    }

    private track(socket: Socket): void {
        this.sockets.add(socket);
        socket.once('close', () => this.sockets.delete(socket));
    }

    private resumeDefaultPrint(): void {
        this.job = {
            filename: this.files[0].filename,
            taskid: `fake-${this.taskCount}`,
            elapsedSec: this.printSec * 0.42,
            steps: [],
            stepSec: 0,
            resumeTo: 'printing',
        };
        this.state = 'printing';
        this.temp = { nozzle: NOZZLE_C, nozzleTarget: NOZZLE_C, bed: BED_C, bedTarget: BED_C };
        this.fan = PRINT_FAN_PCT;
        if (this.boxes.length) this.boxes[0].loaded_slot = 0;
    }

    private box(id: number): Box {
        const preset = SLOT_PRESETS[id % SLOT_PRESETS.length];
        return {
            id,
            loaded_slot: -1,
            auto_feed: 1,
            feed_status: { slot_index: -1, type: -1, current_status: -1 },
            drying_status: {
                status: 0,
                target_temp: 0,
                duration: 0,
                remain_time: 0,
                humidity: 28 + id * 4,
                current_temp: 24,
            },
            slots: preset.map((slot, index) => ({ index, ...slot, color: [...slot.color] })),
        };
    }

    private onHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
        const url = new URL(req.url ?? '/', `http://${FAKE_PRINTER_HOST}`);
        const json = (status: number, body: unknown) =>
            res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
        if (url.pathname === '/info' && req.method === 'GET') {
            json(200, { token: this.token, modelName: FAKE_PRINTER_IDENTITY.modelName, ctrlType: 'lan' });
        } else if (url.pathname === '/ctrl' && req.method === 'POST') {
            req.resume();
            const ts = url.searchParams.get('ts') ?? '';
            const nonce = url.searchParams.get('nonce') ?? '';
            const sign = md5(md5(this.token.slice(0, 16)) + ts + nonce);
            if (!ts || !nonce || url.searchParams.get('sign') !== sign) {
                json(403, { code: 403, message: 'invalid signature', data: null });
                return;
            }
            const iv = randomBytes(8).toString('hex');
            const cipher = createCipheriv('aes-128-cbc', Buffer.from(this.token.slice(16, 32)), Buffer.from(iv));
            const bundle = JSON.stringify({ ip: FAKE_PRINTER_HOST, ...FAKE_PRINTER_IDENTITY });
            const info = Buffer.concat([cipher.update(bundle, 'utf8'), cipher.final()]).toString('base64');
            json(200, { code: 200, message: 'success', data: { token: iv, info } });
        } else if (url.pathname === '/gcode_upload' && req.method === 'POST') {
            this.onUpload(req, url, json);
        } else {
            req.resume();
            json(404, { code: 404, message: 'not found' });
        }
    }

    private onUpload(req: http.IncomingMessage, url: URL, json: (status: number, body: unknown) => void): void {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
            if (url.searchParams.get('s') !== this.token) {
                json(403, { code: 403, message: 'invalid session' });
                return;
            }
            const type = String(req.headers['content-type'] ?? '');
            const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(type);
            const parts = boundary ? multipart(Buffer.concat(chunks), boundary[1] ?? boundary[2]) : new Map();
            const gcode = parts.get('gcode');
            const filename = (parts.get('filename')?.data.toString('utf8') || gcode?.filename || '').trim();
            if (!filename || !gcode) {
                json(200, { code: CODE.nameRefused, message: 'file name or type refused' });
                return;
            }
            const file = { filename, size: gcode.data.length, timestamp: Math.floor(this.now() / 1000) };
            this.files = [file, ...this.files.filter((f) => f.filename !== filename)];
            this.log(`Upload: ${filename} (${file.size} B)`);
            json(200, { code: 200, data: { gcode: filename }, message: 'success' });
        });
    }

    private onCamera(req: http.IncomingMessage, res: http.ServerResponse): void {
        req.resume();
        if (req.url !== `/live/${this.token}`) {
            res.writeHead(404).end();
            return;
        }
        const args = CAMERA_ARGS.split(' ');
        const unavailable = () =>
            res.writeHead(503, { 'Content-Type': 'text/plain' }).end('camera unavailable: ffmpeg did not start');
        let proc: ChildProcess;
        try {
            proc = spawn(this.ffmpeg, args, { stdio: ['ignore', 'pipe', 'ignore'] });
        } catch (e) {
            this.log(`Camera: ffmpeg unavailable (${(e as Error).message})`);
            unavailable();
            return;
        }
        this.cameraProcs.add(proc);
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            this.cameraProcs.delete(proc);
            if (res.headersSent) res.end();
            else unavailable();
        };
        proc.once('error', (e) => {
            this.log(`Camera: ffmpeg unavailable (${e.message})`);
            finish();
        });
        proc.once('close', finish);
        res.once('close', () => proc.kill('SIGKILL'));
        res.setHeader('Content-Type', 'video/x-flv');
        proc.stdout?.pipe(res, { end: false });
    }

    private onSocket(socket: tls.TLSSocket): void {
        const conn: Connection = { socket, connected: false, filters: [] };
        socket.on('error', () => socket.destroy());
        socket.once('close', () => {
            if (this.session === conn) this.session = null;
        });
        let pending = Buffer.alloc(0);
        socket.on('data', (chunk: Buffer) => {
            pending = Buffer.concat([pending, chunk]);
            try {
                for (let p = readPacket(pending); p; p = readPacket(pending)) {
                    pending = Buffer.from(p.rest);
                    this.onPacket(conn, p.head, p.body);
                }
            } catch (e) {
                this.log(`MQTT: malformed packet (${(e as Error).message})`);
                socket.destroy();
            }
        });
    }

    private onPacket(conn: Connection, head: number, body: Buffer): void {
        const type = head >> 4;
        const { socket } = conn;
        if (type === MQTT_CONNECT) {
            this.onConnect(conn, body);
            return;
        }
        if (!conn.connected) {
            socket.destroy();
            return;
        }
        if (type === MQTT_SUBSCRIBE) {
            const filters = readFilters(body, true);
            conn.filters.push(...filters);
            socket.write(packet(MQTT_SUBACK << 4, Buffer.from([body[0], body[1], ...filters.map(() => 0)])));
        } else if (type === MQTT_UNSUBSCRIBE) {
            const filters = readFilters(body, false);
            conn.filters = conn.filters.filter((f) => !filters.includes(f));
            socket.write(packet(MQTT_UNSUBACK << 4, Buffer.from([body[0], body[1]])));
        } else if (type === MQTT_PINGREQ) {
            socket.write(packet(MQTT_PINGRESP << 4, Buffer.alloc(0)));
        } else if (type === MQTT_DISCONNECT) {
            socket.end();
        } else if (type === MQTT_PUBLISH) {
            const qos = (head >> 1) & 3;
            const topicLength = body.readUInt16BE(0);
            const topic = body.subarray(2, 2 + topicLength).toString('utf8');
            let off = 2 + topicLength;
            if (qos > 0) {
                if (qos === 1) socket.write(packet(MQTT_PUBACK << 4, body.subarray(off, off + 2)));
                off += 2;
            }
            this.onPublish(topic, body.subarray(off));
        }
    }

    private onConnect(conn: Connection, body: Buffer): void {
        const connack = (code: number) => conn.socket.write(packet(MQTT_CONNACK << 4, Buffer.from([0, code])));
        let creds: { username: string; password: string };
        try {
            creds = readCredentials(body);
        } catch {
            creds = { username: '', password: '' };
        }
        if (creds.username !== FAKE_PRINTER_IDENTITY.username || creds.password !== FAKE_PRINTER_IDENTITY.password) {
            this.log('MQTT: session refused, wrong username or password');
            connack(CONNACK_NOT_AUTHORIZED);
            conn.socket.end();
            return;
        }
        if (this.session && this.session !== conn && !this.session.socket.destroyed) {
            this.log('MQTT: session refused, another client holds the single session');
            connack(CONNACK_UNAVAILABLE);
            conn.socket.end();
            return;
        }
        conn.connected = true;
        this.session = conn;
        connack(CONNACK_ACCEPTED);
        this.log('MQTT: session opened');
    }

    private onPublish(topic: string, payload: Buffer): void {
        const match = /^anycubic\/anycubicCloud\/v1\/(slicer|web)\/printer\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(topic);
        if (!match || match[2] !== FAKE_PRINTER_IDENTITY.modeId || match[3] !== FAKE_PRINTER_IDENTITY.deviceId) return;
        let body: { type?: unknown; action?: unknown; msgid?: unknown; data?: unknown };
        try {
            body = JSON.parse(payload.toString('utf8'));
        } catch {
            return;
        }
        if (!body || typeof body !== 'object') return;
        const request: FakePrinterRequest = {
            channel: match[1],
            type: String(body.type ?? match[4]),
            action: String(body.action ?? ''),
            msgid: String(body.msgid ?? ''),
            data: (body.data && typeof body.data === 'object' ? body.data : {}) as FakePrinterRequestData,
        };
        this.requests.push(request);
        if (this.requests.length > RECORDED_REQUESTS) this.requests.shift();
        const key = `${request.type}/${request.action}`;
        if (!QUIET_ACTIONS.has(key)) this.log(`RX ${request.channel} ${key} ${JSON.stringify(request.data)}`);
        this.publish(`${this.publicTopic}/response`, { code: 0, msgid: request.msgid });
        this.tick();
        if (!this.handle(request)) {
            if (!this.unhandled.includes(key)) this.unhandled.push(key);
            this.log(`No answer for ${key}: the fake printer does not know it`);
        }
    }

    private publish(topic: string, message: object): void {
        const conn = this.session;
        if (!conn?.connected || conn.socket.destroyed) return;
        if (!conn.filters.some((f) => topicMatches(f, topic))) return;
        conn.socket.write(publishPacket(topic, JSON.stringify(message)));
    }

    private report(type: string, action: string, reply: Reply = {}): void {
        this.publish(`${this.publicTopic}/${type}/report`, {
            type,
            action,
            msgid: randomUUID(),
            timestamp: this.now(),
            state: 'done',
            code: 200,
            msg: 'done',
            data: null,
            ...reply,
        });
    }

    private refuse(type: string, action: string, code: number, msg: string): void {
        this.report(type, action, { state: 'failed', code, msg, data: null });
    }

    private handle(req: FakePrinterRequest): boolean {
        const { type, action, data: d } = req;
        switch (`${type}/${action}`) {
            case 'info/query':
                this.report('info', action, { data: this.info() });
                return true;
            case 'info/setPrinterName':
                if (typeof d.printerName === 'string' && d.printerName.trim()) this.name = d.printerName.trim();
                this.report('info', action, { data: this.info() });
                return true;
            case 'status/query':
                this.report('status', 'workReport', { state: this.job ? 'busy' : 'free', data: null });
                return true;
            case 'print/query':
                if (this.job) this.report('print', action, this.printReply());
                return true;
            case 'print/start':
                this.startPrint(d);
                return true;
            case 'print/pause':
                this.pause();
                return true;
            case 'print/resume':
                this.resume();
                return true;
            case 'print/stop':
                this.stopPrint();
                return true;
            case 'print/update':
                this.updatePrint(d.settings ?? {});
                return true;
            case 'tempature/set':
                this.setIdleTemperature(d);
                return true;
            case 'fan/setSpeed':
                this.fan = Math.min(100, Math.max(0, Math.round(Number(d.fan_speed_pct) || 0)));
                this.report('fan', action, { data: { fan_speed_pct: this.fan } });
                if (this.job) this.reportUpdated();
                return true;
            case 'fan/query':
                this.report('fan', action, { data: { fan_speed_pct: this.fan } });
                return true;
            case 'light/query':
                this.report('light', 'control', { data: { lights: [{ ...this.light }] } });
                this.report('light', 'control', { data: { lights: [{ ...this.light }] } });
                return true;
            case 'light/control':
                if (d.type === undefined || d.type === CAMERA_LIGHT) {
                    this.light = {
                        type: CAMERA_LIGHT,
                        status: Number(d.status ?? 0),
                        brightness: Number(d.brightness ?? 0),
                    };
                }
                this.report('light', action, { data: { ...this.light } });
                return true;
            case 'peripherie/query':
                this.report('peripherie', action, {
                    data: {
                        camera: 1,
                        udisk: 0,
                        multiColorBox: this.boxes.length ? 1 : 0,
                        mount_path: '/data/timelapse',
                        usb_path: '',
                        ret_code: 0,
                    },
                });
                return true;
            case 'multiColorBox/getInfo':
                this.reportBoxes(action);
                return true;
            case 'multiColorBox/setInfo':
            case 'multiColorBox/setAutoFeed':
            case 'multiColorBox/setDry':
            case 'multiColorBox/feedFilament':
                for (const change of d.multi_color_box ?? []) this.changeBox(change);
                this.reportBoxes(action);
                return true;
            case 'file/listLocal':
                this.report('file', action, { data: { records: this.listFiles(d.path) } });
                return true;
            case 'file/deleteBatch': {
                const names = (d.files ?? []).map((f) => String(f.filename ?? ''));
                this.files = this.files.filter((f) => !names.includes(f.filename));
                this.report('file', action, { state: 'success', data: null });
                return true;
            }
            case 'file/fileDetails':
                this.reportFileDetails(String(d.filename ?? ''));
                return true;
            case 'skip/query_obj':
                this.report('skip', action, { data: { objects_skip_parts: [...this.skipped] } });
                return true;
            case 'skip/start':
                if (!this.job) {
                    this.refuse('skip', action, CODE.noTask, 'no print task');
                    return true;
                }
                this.skipped = [...new Set((d.objects_skip_parts ?? []).map(String))];
                this.report('skip', action, { data: { objects_skip_parts: [...this.skipped] } });
                return true;
            case 'axis/move':
                if (this.job) this.refuse('axis', action, CODE.deviceBusy, 'device busy');
                else
                    this.report('axis', action, {
                        data: { axis: d.axis, move_type: d.move_type, distance: d.distance },
                    });
                return true;
            case 'axis/query':
                this.report('axis', action, { data: { x: 0, y: 0, z: 0 } });
                return true;
            case 'axis/turnOff':
                this.report('axis', action, { data: null });
                return true;
            case 'video/startCapture':
                for (const state of ['initSuccess', 'joinSuccess', 'pushStarted'])
                    this.report('video', action, { state });
                return true;
            case 'video/stopCapture':
                this.report('video', action, { state: 'pushStopped' });
                return true;
            default:
                return false;
        }
    }

    private startPrint(d: FakePrinterRequestData): void {
        if (this.job) {
            this.refuse('print', 'start', CODE.taskExists, 'a print task already exists');
            return;
        }
        const target = folderOf(d.filepath || d.filename);
        const storage = target.folder === TEST_MODEL_FOLDER ? this.testModels : target.folder ? [] : this.files;
        const file = storage.find((f) => f.filename === target.filename);
        if (!file) {
            this.refuse('print', 'start', CODE.downloadFailed, 'file not found on the printer');
            return;
        }
        const ts = d.task_settings ?? {};
        this.job = {
            filename: String(d.filename || file.filename),
            taskid: `fake-${++this.taskCount}`,
            elapsedSec: 0,
            steps: [
                'preheating',
                ...(ts.auto_leveling ? ['auto_leveling'] : []),
                ...(ts.vibration_compensation ? ['vibrating'] : []),
                ...(ts.flow_calibration ? ['flow_calibrating'] : []),
            ],
            stepSec: 0,
            resumeTo: 'preheating',
        };
        this.lastProject = null;
        this.pauseReason = null;
        this.skipped = [...(ts.model_objects_skip_parts ?? [])];
        this.temp.nozzleTarget = NOZZLE_C;
        this.temp.bedTarget = BED_C;
        this.loadSlotFor(d.ams_settings);
        this.setState('preheating', 'start');
    }

    private loadSlotFor(ams: FakePrinterRequestData['ams_settings']): void {
        const index = ams?.use_ams ? Number(ams.ams_box_mapping?.[0]?.ams_index) : Number.NaN;
        if (!Number.isInteger(index) || index < 0) return;
        const box = this.boxes.find((b) => b.id === Math.floor(index / 4));
        if (!box) return;
        for (const b of this.boxes) b.loaded_slot = -1;
        box.loaded_slot = index % 4;
    }

    private pause(): void {
        const job = this.job;
        if (!job) {
            this.refuse('print', 'pause', CODE.noTask, 'no print task');
            return;
        }
        if (this.state === 'paused') {
            this.report('print', 'pause', this.printReply());
            return;
        }
        job.resumeTo = this.state;
        this.setState('pausing', 'pause');
        this.pauseReason = { code: CODE.userPause, msg: 'paused by the user' };
        this.setState('paused', 'pause');
    }

    private resume(): void {
        const job = this.job;
        if (!job) {
            this.refuse('print', 'resume', CODE.noTask, 'no print task');
            return;
        }
        if (this.state !== 'paused') {
            this.report('print', 'resume', this.printReply());
            return;
        }
        this.pauseReason = null;
        this.setState('resuming', 'resume');
        this.setState(job.resumeTo, 'resume');
    }

    private stopPrint(): void {
        if (!this.job) {
            this.refuse('print', 'stop', CODE.noTask, 'no print task');
            return;
        }
        this.pauseReason = null;
        this.setState('stopping', 'stop');
        this.report('print', 'stop', {
            state: 'stoped',
            code: CODE.userStop,
            msg: 'stopped by the user',
            data: { filename: this.job.filename, taskid: this.job.taskid },
        });
        this.temp.nozzleTarget = 0;
        this.temp.bedTarget = 0;
        this.fan = 0;
        this.reportUpdated();
        this.goIdle('stoped');
    }

    private updatePrint(settings: PrintSettings): void {
        if (!this.job) {
            this.refuse('print', 'update', CODE.noTask, 'no print task');
            return;
        }
        if (settings.print_speed_mode !== undefined) this.speedMode = Number(settings.print_speed_mode);
        if (settings.fan_speed_pct !== undefined) this.fan = Number(settings.fan_speed_pct);
        if (settings.target_nozzle_temp !== undefined) this.temp.nozzleTarget = Number(settings.target_nozzle_temp);
        if (settings.target_hotbed_temp !== undefined) this.temp.bedTarget = Number(settings.target_hotbed_temp);
        this.reportUpdated();
    }

    private setIdleTemperature(d: FakePrinterRequestData): void {
        if (this.job) {
            this.refuse('tempature', 'set', CODE.deviceBusy, 'device busy');
            return;
        }
        if (d.type !== 1) this.temp.nozzleTarget = Number(d.target_nozzle_temp ?? 0);
        if (d.type !== 0) this.temp.bedTarget = Number(d.target_hotbed_temp ?? 0);
        this.report('tempature', 'set', { data: this.roundedTemp() });
    }

    private setState(state: string, action: string): void {
        this.state = state;
        this.report('print', action, this.printReply());
        this.pushedPrint = this.printKey();
    }

    private goIdle(last: string): void {
        this.lastProject = { ...this.project(), state: last };
        this.job = null;
        this.state = 'free';
        this.pauseReason = null;
        this.skipped = [];
        this.temp.nozzleTarget = 0;
        this.temp.bedTarget = 0;
        this.fan = 0;
        this.pushedPrint = '';
    }

    private heat(dt: number): void {
        const approach = (current: number, target: number, rate: number) => {
            const gap = (target || AMBIENT_C) - current;
            return current + Math.sign(gap) * Math.min(Math.abs(gap), rate * dt);
        };
        this.temp.nozzle = approach(this.temp.nozzle, this.temp.nozzleTarget, 4);
        this.temp.bed = approach(this.temp.bed, this.temp.bedTarget, 1);
    }

    private advance(dt: number): void {
        const job = this.job;
        if (!job || this.state === 'paused') return;
        if (this.state === 'printing') {
            job.elapsedSec = Math.min(this.printSec, job.elapsedSec + dt);
            if (job.elapsedSec < this.printSec) return;
            this.report('print', 'report', { state: 'finished', data: { ...this.printFields(), progress: 100 } });
            this.goIdle('finished');
            return;
        }
        const index = job.steps.indexOf(this.state);
        if (index < 0) return;
        if (this.state === 'preheating') {
            const heated =
                Math.abs(this.temp.nozzle - this.temp.nozzleTarget) <= 2 &&
                Math.abs(this.temp.bed - this.temp.bedTarget) <= 1;
            if (!heated) return;
        } else {
            job.stepSec += dt;
            if (job.stepSec < PREPARE_STEP_SEC) return;
        }
        job.stepSec = 0;
        const next = job.steps[index + 1] ?? 'printing';
        if (next === 'printing') this.fan = PRINT_FAN_PCT;
        this.setState(next, 'report');
    }

    private pushChanges(): void {
        const temp = JSON.stringify(this.roundedTemp());
        if (temp !== this.pushedTemp) {
            this.pushedTemp = temp;
            this.report('tempature', 'report', { data: this.roundedTemp() });
        }
        if (!this.job || this.state === 'paused') return;
        const key = this.printKey();
        if (key === this.pushedPrint) return;
        this.pushedPrint = key;
        this.report('print', 'report', this.printReply());
    }

    private printKey(): string {
        if (!this.job) return '';
        const f = this.printFields();
        return [this.state, f.progress, f.curr_layer, f.print_time, f.remain_time].join('|');
    }

    private printFields() {
        const job = this.job;
        const started = job ? job.elapsedSec > 0 || this.state === 'printing' : false;
        const elapsed = job?.elapsedSec ?? 0;
        const done = elapsed / this.printSec;
        return {
            filename: job?.filename ?? '',
            taskid: job?.taskid ?? '-1',
            progress: Math.floor(done * 100),
            print_time: Math.floor(elapsed / 60),
            remain_time: Math.ceil((this.printSec - elapsed) / 60),
            curr_layer: started ? Math.max(1, Math.floor(done * TOTAL_LAYERS)) : 0,
            total_layers: TOTAL_LAYERS,
            supplies_usage: Math.round(done * TOTAL_FILAMENT_MM),
        };
    }

    private project() {
        const status = PRINT_STATUS[this.state];
        return { ...this.printFields(), state: this.state, ...(status ? { print_status: status } : {}) };
    }

    private printReply(): Reply {
        const reason = this.state === 'paused' ? this.pauseReason : null;
        return { state: this.state, ...(reason ?? {}), data: this.printFields() };
    }

    private reportUpdated(): void {
        this.report('print', 'update', {
            state: 'updated',
            data: {
                ...this.printFields(),
                settings: {
                    fan_speed_pct: this.fan,
                    print_speed_mode: this.speedMode,
                    target_hotbed_temp: this.temp.bedTarget,
                    target_nozzle_temp: this.temp.nozzleTarget,
                    z_comp: 0,
                },
            },
        });
    }

    private reportBoxes(action: string): void {
        this.report('multiColorBox', action, { data: { multi_color_box: this.boxes } });
    }

    private changeBox(change: BoxChange): void {
        const box = this.boxes.find((b) => b.id === (change.id ?? 0));
        if (!box) return;
        if (change.auto_feed !== undefined) box.auto_feed = Number(change.auto_feed);
        for (const edit of change.slots ?? []) {
            const slot = box.slots[edit.index];
            if (!slot) continue;
            if (edit.type !== undefined) slot.type = edit.type;
            if (edit.color) slot.color = [...edit.color];
            slot.edit_status = 1;
            if (slot.type) slot.status = 5;
        }
        const feed = change.feed_status;
        if (feed) {
            const slotIndex = Number(feed.slot_index ?? -1);
            if (feed.type === 1) {
                for (const b of this.boxes) b.loaded_slot = -1;
                box.loaded_slot = slotIndex;
                box.feed_status = { slot_index: slotIndex, type: 1, current_status: 10 };
            } else if (feed.type === 2) {
                for (const b of this.boxes) b.loaded_slot = -1;
                box.feed_status = { slot_index: slotIndex, type: 2, current_status: 11 };
            } else {
                box.feed_status = { slot_index: -1, type: -1, current_status: -1 };
            }
        }
        if (change.drying_status) {
            const off = { target_temp: 0, duration: 0, remain_time: 0 };
            box.drying_status = { ...box.drying_status, ...off, ...change.drying_status } as Box['drying_status'];
        }
    }

    private listFiles(folder: string | undefined) {
        const name = String(folder ?? '/').replace(/^\/+|\/+$/g, '');
        const files = name === '' ? this.files : name === TEST_MODEL_FOLDER ? this.testModels : [];
        return [...files]
            .sort((a, b) => b.timestamp - a.timestamp)
            .slice(0, FILE_LIST_LIMIT)
            .map((f) => ({ ...f }));
    }

    private reportFileDetails(requested: string): void {
        const target = folderOf(requested);
        const storage = target.folder === TEST_MODEL_FOLDER ? this.testModels : target.folder ? [] : this.files;
        const file = storage.find((f) => f.filename === target.filename);
        const details = file ? { filename: file.filename, thumbnail: this.thumbnail() } : { filename: target.filename };
        this.report('file', 'fileDetails', { data: { filename: requested, file_details: details } });
    }

    private thumbnail(): string {
        if (this.thumbnailCache === null) {
            try {
                const logo = path.resolve(__dirname, '../../web/public/logo-1024.png');
                this.thumbnailCache = fs.readFileSync(logo).toString('base64');
            } catch {
                this.thumbnailCache = '';
            }
        }
        return this.thumbnailCache;
    }

    private roundedTemp() {
        return {
            curr_nozzle_temp: Math.round(this.temp.nozzle),
            target_nozzle_temp: Math.round(this.temp.nozzleTarget),
            curr_hotbed_temp: Math.round(this.temp.bed),
            target_hotbed_temp: Math.round(this.temp.bedTarget),
        };
    }

    private info() {
        return {
            printerName: this.name,
            model: FAKE_PRINTER_IDENTITY.modelName,
            ip: FAKE_PRINTER_HOST,
            version: FAKE_PRINTER_FIRMWARE,
            state: this.job ? 'busy' : 'free',
            temp: this.roundedTemp(),
            urls: { fileUploadurl: this.uploadUrl, rtspUrl: this.cameraUrl },
            fan_speed_pct: this.fan,
            aux_fan_speed_pct: 0,
            print_speed_mode: this.speedMode,
            features: { ...KOBRA4_FEATURES },
            ...(this.job ? { project: this.project() } : {}),
            ...(this.lastProject ? { last_project: this.lastProject } : {}),
        };
    }
}

function envInt(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
    return n;
}

export function fakePrinterOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): FakePrinterOptions {
    return {
        httpPort: envInt(env, 'FAROLPRINT_FAKE_HTTP_PORT', FAKE_PRINTER_PORTS.httpPort, 0, 65535),
        mqttPort: envInt(env, 'FAROLPRINT_FAKE_MQTT_PORT', FAKE_PRINTER_PORTS.mqttPort, 0, 65535),
        cameraPort: envInt(env, 'FAROLPRINT_FAKE_CAMERA_PORT', FAKE_PRINTER_PORTS.cameraPort, 0, 65535),
        aceUnits: envInt(env, 'FAROLPRINT_FAKE_ACE_UNITS', 1, 0, MAX_ACE_UNITS),
        printSec: envInt(env, 'FAROLPRINT_FAKE_PRINT_SEC', PRINT_SEC, 1, 7 * 24 * 3600),
    };
}

async function main(): Promise<void> {
    const printer = new FakePrinter({ ...fakePrinterOptionsFromEnv(), log: (line) => console.log(line) });
    const ports = await printer.start();
    console.log(
        `Fake printer ready on ${FAKE_PRINTER_HOST}: HTTP ${ports.httpPort}, MQTT ${ports.mqttPort}, camera ${ports.cameraPort}`,
    );
    const defaults = ports.httpPort === FAKE_PRINTER_PORTS.httpPort && ports.mqttPort === FAKE_PRINTER_PORTS.mqttPort;
    console.log(
        defaults
            ? `Add a printer with the IP ${FAKE_PRINTER_HOST} in the dashboard`
            : `FarolPrint connects to printers on HTTP ${FAKE_PRINTER_PORTS.httpPort} and MQTT ${FAKE_PRINTER_PORTS.mqttPort}: the dashboard cannot add this one`,
    );
    const shutdown = () => {
        void printer.stop().then(() => process.exit(0));
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
}

if (require.main === module) {
    main().catch((e: Error) => {
        console.error(e.message);
        process.exit(1);
    });
}
