import { type ParsedGcode, parseGcode } from './gcode-parse';

export type { ParsedGcode, ParsedLayer } from './gcode-parse';

export type WorkerRequest = { text: string };
export type WorkerResponse = { ok: true; data: ParsedGcode } | { ok: false; error: string } | { progress: number };

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
    try {
        const data = parseGcode(ev.data.text, (progress) => self.postMessage({ progress } satisfies WorkerResponse));
        const buffers = data.layers.map((l) => l.segs.buffer);
        (self as unknown as { postMessage: (m: WorkerResponse, t: Transferable[]) => void }).postMessage(
            { ok: true, data },
            buffers,
        );
    } catch (e) {
        self.postMessage({ ok: false, error: (e as Error).message } satisfies WorkerResponse);
    }
};
