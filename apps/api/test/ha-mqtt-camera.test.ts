import { afterAll, afterEach, beforeEach, describe, expect, it, mock, setSystemTime } from 'bun:test';
import { EventEmitter } from 'node:events';
import { type AppSettings, appSettingsSchema } from '@farolprint/shared';
import type { PrinterBridge } from '../src/bridge/printer-bridge';
import type { SettingsService } from '../src/settings/settings.service';

interface Published {
    topic: string;
    payload: string;
    retain: boolean;
}

class FakeClient extends EventEmitter {
    connected = false;
    readonly published: Published[] = [];
    publish(topic: string, payload: string, opts?: { retain?: boolean }) {
        this.published.push({ topic, payload, retain: opts?.retain ?? false });
    }
    subscribe() {}
    end(_force: boolean, _opts: unknown, cb: () => void) {
        this.connected = false;
        cb();
    }
    goOnline() {
        this.connected = true;
        this.emit('connect');
    }
    camera() {
        return this.published.filter((p) => p.topic === 'farolprint/p1/camera');
    }
}

let client: FakeClient;
const realMqtt = { ...(await import('mqtt')) };
afterAll(() => {
    mock.module('mqtt', () => realMqtt);
});
mock.module('mqtt', () => ({
    default: {
        connect: () => {
            client = new FakeClient();
            return client;
        },
    },
}));

const { HaMqttService, CAMERA_MAX_AGE_MS } = await import('../src/ha/ha-mqtt.service');

const settingsWith = (haMqtt: Partial<AppSettings['haMqtt']>) => {
    const s = new EventEmitter() as EventEmitter & { get: () => AppSettings };
    const value = appSettingsSchema.parse({ haMqtt: { enabled: true, url: 'mqtt://broker.test', ...haMqtt } });
    s.get = () => value;
    return s as unknown as SettingsService;
};

function fakeBridge(printState = 'idle') {
    const b = new EventEmitter() as EventEmitter & Record<string, unknown>;
    b.id = 'p1';
    b.config = { name: 'Kobra 4' };
    b.modelName = 'Kobra 4';
    b.camera = { latestJpeg: null as Buffer | null, latestJpegAt: 0 };
    b.snapshot = () => ({ printState, kobraState: 'free', connected: true, firmwareVersion: '1.0' });
    return b as unknown as PrinterBridge & { camera: { latestJpeg: Buffer | null; latestJpegAt: number } };
}
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
let ticks: (() => void)[] = [];
let cleared = 0;

const NOW = new Date('2026-11-23T12:00:00Z').getTime();
const frame = (bridge: ReturnType<typeof fakeBridge>, text: string, at = Date.now()) => {
    bridge.camera.latestJpeg = Buffer.from(text);
    bridge.camera.latestJpegAt = at;
};
const tick = () => {
    for (const t of ticks) t();
};

async function connectedService(bridge: ReturnType<typeof fakeBridge>) {
    const svc = new HaMqttService(settingsWith({}));
    svc.onModuleInit();
    await Bun.sleep(0);
    svc.attach(bridge);
    client.goOnline();
    return svc;
}

beforeEach(() => {
    setSystemTime(NOW);
    ticks = [];
    cleared = 0;
    globalThis.setInterval = ((fn: () => void) => {
        ticks.push(fn);
        return ticks.length as unknown as NodeJS.Timeout;
    }) as unknown as typeof setInterval;
    globalThis.clearInterval = (() => {
        cleared += 1;
    }) as unknown as typeof clearInterval;
});

afterEach(() => {
    setSystemTime();
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
});

describe('HaMqttService camera', () => {
    it('publishes a fresh frame while the printer is idle, base64 and retained', async () => {
        const bridge = fakeBridge('idle');
        await connectedService(bridge);
        frame(bridge, 'jpeg-1');
        tick();
        expect(client.camera()).toEqual([
            { topic: 'farolprint/p1/camera', payload: Buffer.from('jpeg-1').toString('base64'), retain: true },
        ]);
    });

    it('also publishes while printing', async () => {
        const bridge = fakeBridge('printing');
        await connectedService(bridge);
        frame(bridge, 'jpeg-1');
        tick();
        expect(client.camera()).toHaveLength(1);
    });

    it('does not send the same frame twice, and sends the next one', async () => {
        const bridge = fakeBridge();
        await connectedService(bridge);
        frame(bridge, 'jpeg-1');
        tick();
        tick();
        expect(client.camera()).toHaveLength(1);
        setSystemTime(NOW + 1000);
        frame(bridge, 'jpeg-2');
        tick();
        expect(client.camera().map((p) => Buffer.from(p.payload, 'base64').toString())).toEqual(['jpeg-1', 'jpeg-2']);
    });

    it('skips a stale frame (the camera stopped)', async () => {
        const bridge = fakeBridge();
        await connectedService(bridge);
        frame(bridge, 'old', NOW - CAMERA_MAX_AGE_MS);
        tick();
        expect(client.camera()).toEqual([]);
    });

    it('sends nothing when the camera never produced a frame', async () => {
        const bridge = fakeBridge();
        await connectedService(bridge);
        tick();
        expect(client.camera()).toEqual([]);
    });

    it('waits for the broker, then sends the latest frame on connect', async () => {
        const bridge = fakeBridge();
        const svc = new HaMqttService(settingsWith({}));
        svc.onModuleInit();
        await Bun.sleep(0);
        svc.attach(bridge);
        frame(bridge, 'jpeg-1');
        tick();
        expect(client.camera()).toEqual([]);
        client.goOnline();
        expect(client.camera()).toHaveLength(1);
    });

    it('sends the frame of a printer attached while already connected', async () => {
        const svc = new HaMqttService(settingsWith({}));
        svc.onModuleInit();
        await Bun.sleep(0);
        client.goOnline();
        const bridge = fakeBridge();
        frame(bridge, 'jpeg-1');
        svc.attach(bridge);
        expect(client.camera()).toHaveLength(1);
    });

    it('resends the retained frame after a reconnect', async () => {
        const bridge = fakeBridge();
        await connectedService(bridge);
        frame(bridge, 'jpeg-1');
        tick();
        client.goOnline();
        expect(client.camera()).toHaveLength(2);
    });

    it('stops publishing once the printer is detached', async () => {
        const bridge = fakeBridge();
        const svc = await connectedService(bridge);
        svc.detach('p1');
        expect(cleared).toBe(1);
    });

    it('clears the camera timers on shutdown', async () => {
        const bridge = fakeBridge();
        const svc = await connectedService(bridge);
        await svc.onModuleDestroy();
        expect(cleared).toBe(1);
    });

    it('keeps the state topic free of camera frames', async () => {
        const bridge = fakeBridge();
        frame(bridge, 'jpeg-1');
        await connectedService(bridge);
        const state = client.published.filter((p) => p.topic === 'farolprint/p1/state');
        expect(state.length).toBeGreaterThan(0);
        expect(state.every((p) => !p.payload.includes(Buffer.from('jpeg-1').toString('base64')))).toBe(true);
    });

    it('announces the camera entity with base64 encoding and no state topic', async () => {
        const bridge = fakeBridge();
        await connectedService(bridge);
        const cfg = client.published.find((p) => p.topic === 'homeassistant/camera/farolprint_p1/camera/config');
        expect(cfg?.retain).toBe(true);
        const payload = JSON.parse(cfg?.payload ?? '{}');
        expect(payload.topic).toBe('farolprint/p1/camera');
        expect(payload.image_encoding).toBe('b64');
        expect(payload.state_topic).toBeUndefined();
    });
});

function pngB64(side: number): string {
    const buf = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
    buf.writeUInt32BE(13, 8);
    buf.write('IHDR', 12, 'ascii');
    buf.writeUInt32BE(side, 16);
    buf.writeUInt32BE(side, 20);
    return buf.toString('base64');
}

function withThumbnail(bridge: ReturnType<typeof fakeBridge>, thumbnail: string) {
    const snap = bridge.snapshot.bind(bridge);
    (bridge as unknown as { snapshot: () => unknown }).snapshot = () => ({ ...snap(), thumbnail });
    return bridge;
}

const thumbnails = () => client.published.filter((p) => p.topic === 'farolprint/p1/thumbnail');
const publishState = (svc: InstanceType<typeof HaMqttService>, bridge: PrinterBridge, thumbnail: string) =>
    (svc as unknown as { publishState: (b: PrinterBridge, s: unknown) => void }).publishState(bridge, {
        ...bridge.snapshot(),
        thumbnail,
    });

describe('HaMqttService print thumbnail', () => {
    it('announces an image entity with base64 PNG payloads and no state topic', async () => {
        await connectedService(fakeBridge());
        const cfg = client.published.find((p) => p.topic === 'homeassistant/image/farolprint_p1/thumbnail/config');
        expect(cfg?.retain).toBe(true);
        const payload = JSON.parse(cfg?.payload ?? '{}');
        expect(payload).toMatchObject({
            image_topic: 'farolprint/p1/thumbnail',
            image_encoding: 'b64',
            content_type: 'image/png',
        });
        expect(payload.state_topic).toBeUndefined();
    });

    it('publishes the thumbnail retained, once per change', async () => {
        const first = pngB64(8);
        const bridge = withThumbnail(fakeBridge('printing'), first);
        const svc = await connectedService(bridge);
        publishState(svc, bridge, first);
        expect(thumbnails()).toEqual([{ topic: 'farolprint/p1/thumbnail', payload: first, retain: true }]);
        const next = pngB64(16);
        publishState(svc, bridge, next);
        expect(thumbnails().map((p) => p.payload)).toEqual([first, next]);
    });

    it('keeps the last thumbnail when the print ends and ignores data that is not a PNG', async () => {
        const first = pngB64(8);
        const bridge = withThumbnail(fakeBridge('printing'), first);
        const svc = await connectedService(bridge);
        publishState(svc, bridge, '');
        publishState(svc, bridge, Buffer.from('jpeg').toString('base64'));
        expect(thumbnails().map((p) => p.payload)).toEqual([first]);
    });

    it('publishes it again after a reconnection to the broker', async () => {
        const first = pngB64(8);
        const bridge = withThumbnail(fakeBridge('printing'), first);
        await connectedService(bridge);
        client.goOnline();
        expect(thumbnails().map((p) => p.payload)).toEqual([first, first]);
    });
});
