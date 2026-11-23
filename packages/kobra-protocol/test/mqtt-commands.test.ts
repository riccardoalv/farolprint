import { describe, expect, it } from 'bun:test';
import { KobraMqttClient } from '../src/mqtt-client';

function client() {
    const c = new KobraMqttClient({
        host: '127.0.0.1',
        username: 'u',
        password: 'p',
        deviceId: 'dev',
        modeId: '20028',
    } as unknown as ConstructorParameters<typeof KobraMqttClient>[0]);
    const sent: { topic: string; body: { type: string; action: string; data: unknown } }[] = [];
    (c as unknown as { client: unknown }).client = {
        connected: true,
        publish: (topic: string, payload: string) => sent.push({ topic, body: JSON.parse(payload) }),
    };
    return { c, sent };
}

describe('batch 7 commands', () => {
    it('asks for the peripherals on the slicer topic', () => {
        const h = client();
        h.c.queryPeripherals();
        expect(h.sent[0].topic).toBe('anycubic/anycubicCloud/v1/slicer/printer/20028/dev/peripherie');
        expect(h.sent[0].body).toMatchObject({ type: 'peripherie', action: 'query' });
    });

    it('renames the printer on the web topic, like the official client', () => {
        const h = client();
        h.c.setPrinterName('Workshop');
        expect(h.sent[0].topic).toBe('anycubic/anycubicCloud/v1/web/printer/20028/dev/info');
        expect(h.sent[0].body).toMatchObject({
            type: 'info',
            action: 'setPrinterName',
            data: { printerName: 'Workshop' },
        });
    });
});
