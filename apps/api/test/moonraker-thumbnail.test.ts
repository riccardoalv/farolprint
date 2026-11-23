import { describe, expect, it, mock } from 'bun:test';
import { NotFoundException } from '@nestjs/common';
import type { Response } from 'express';
import { type BridgePrinterConfig, PrinterBridge } from '../src/bridge/printer-bridge';
import type { GcodeService } from '../src/gcode/gcode.service';
import { MoonrakerController } from '../src/moonraker/moonraker.controller';
import { moonrakerThumbnails, pngFromBase64, thumbnailFilename, thumbnailPath } from '../src/moonraker/thumbnails';

function pngB64(width: number, height: number): string {
    const buf = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
    buf.writeUInt32BE(13, 8);
    buf.write('IHDR', 12, 'ascii');
    buf.writeUInt32BE(width, 16);
    buf.writeUInt32BE(height, 20);
    return buf.toString('base64');
}

const pathOf = (filename: string) => `.thumbs/${Buffer.from(filename).toString('base64url')}.png`;

function bridgeWith(stored: Record<string, string | null> = {}) {
    const gcode = {
        getByFilename: async (name: string) =>
            name in stored ? { thumbnail: stored[name], layerHeight: 0.2, firstLayerHeight: 0.2, sizeBytes: 10 } : null,
    } as unknown as GcodeService;
    const config = { id: 'p', name: 'Kobra 4', ip: '127.0.0.1', httpPort: 7125, settings: {} } as BridgePrinterConfig;
    const bridge = new PrinterBridge(config, gcode, { cert: Buffer.alloc(0), key: Buffer.alloc(0) });
    const internals = bridge as unknown as {
        s: { filename: string; thumbnail: string };
        printerThumbs: Map<string, string>;
    };
    return { bridge, internals };
}

describe('moonrakerThumbnails', () => {
    it('describes a PNG thumbnail with its size and a path next to the file', () => {
        expect(moonrakerThumbnails('cube.gcode', pngB64(300, 200))).toEqual([
            { width: 300, height: 200, size: 33, relative_path: pathOf('cube.gcode') },
        ]);
    });

    it('describes nothing for missing, non-PNG or truncated data, or without a file name', () => {
        expect(moonrakerThumbnails('cube.gcode', '')).toEqual([]);
        expect(moonrakerThumbnails('cube.gcode', null)).toEqual([]);
        expect(moonrakerThumbnails('cube.gcode', Buffer.from('not a png at all, really').toString('base64'))).toEqual(
            [],
        );
        expect(
            moonrakerThumbnails('cube.gcode', Buffer.from(pngB64(1, 1), 'base64').subarray(0, 20).toString('base64')),
        ).toEqual([]);
        const noHeader = Buffer.from(pngB64(4, 4), 'base64');
        noHeader.write('IDAT', 12, 'ascii');
        expect(moonrakerThumbnails('cube.gcode', noHeader.toString('base64'))).toEqual([]);
        expect(moonrakerThumbnails('', pngB64(4, 4))).toEqual([]);
    });
});

describe('thumbnail paths', () => {
    it('are URL-safe and decode back to any file name', () => {
        const filename = 'Benchy #2 ?50% é/x.gcode';
        const path = thumbnailPath(filename);
        expect(path).toMatch(/^\.thumbs\/[A-Za-z0-9_-]+\.png$/);
        expect(thumbnailFilename(path.slice('.thumbs/'.length))).toBe(filename);
    });

    it('reject names that are not a thumbnail of ours', () => {
        expect(thumbnailFilename('cube.gcode')).toBeNull();
        expect(thumbnailFilename('../secret.png')).toBeNull();
        expect(thumbnailFilename('a b.png')).toBeNull();
        expect(thumbnailFilename('.png')).toBeNull();
    });
});

describe('file metadata thumbnails', () => {
    it('come from the stored G-code', async () => {
        const { bridge } = bridgeWith({ 'cube.gcode': pngB64(64, 48) });
        const meta = await bridge.fileMetadata('cube.gcode');
        expect(meta.thumbnails).toEqual([{ width: 64, height: 48, size: 33, relative_path: pathOf('cube.gcode') }]);
        expect((await bridge.fileThumbnail('cube.gcode'))?.readUInt32BE(16)).toBe(64);
    });

    it('come from the running print when FarolPrint did not store the file', async () => {
        const { bridge, internals } = bridgeWith();
        internals.s.filename = 'screen.gcode';
        internals.s.thumbnail = pngB64(32, 32);
        expect((await bridge.fileMetadata('screen.gcode')).thumbnails).toHaveLength(1);
        expect((await bridge.fileThumbnail('screen.gcode'))?.readUInt32BE(20)).toBe(32);
    });

    it('come from the printer file details already fetched', async () => {
        const { bridge, internals } = bridgeWith();
        internals.printerThumbs.set('on-printer.gcode', pngB64(16, 16));
        expect((await bridge.fileMetadata('on-printer.gcode')).thumbnails).toHaveLength(1);
        expect(await bridge.fileThumbnail('on-printer.gcode')).not.toBeNull();
    });

    it('are empty when no PNG is known for the file', async () => {
        const { bridge, internals } = bridgeWith({
            'blank.gcode': null,
            'jpeg.gcode': Buffer.from('jpeg').toString('base64'),
        });
        internals.s.filename = 'jpeg.gcode';
        internals.s.thumbnail = Buffer.from('jpeg').toString('base64');
        expect((await bridge.fileMetadata('blank.gcode')).thumbnails).toEqual([]);
        expect((await bridge.fileMetadata('jpeg.gcode')).thumbnails).toEqual([]);
        expect(await bridge.fileThumbnail('blank.gcode')).toBeNull();
        expect(await bridge.fileThumbnail('jpeg.gcode')).toBeNull();
        expect(await bridge.fileThumbnail('unknown.gcode')).toBeNull();
        expect(await bridge.fileThumbnail('')).toBeNull();
    });
});

describe('thumbnail route', () => {
    const handler = MoonrakerController.prototype.thumbnail;

    function call(name: string, bridge: PrinterBridge) {
        const res = { type: mock(() => res), send: mock((_body: Buffer) => res) };
        const run = handler.call(
            { moon: { bridge } } as unknown as MoonrakerController,
            name,
            res as unknown as Response,
        );
        return { res, run };
    }

    it('serves the PNG under the path the metadata announces', async () => {
        const { bridge } = bridgeWith({ 'cube.gcode': pngB64(10, 10) });
        const { res, run } = call(pathOf('cube.gcode').slice('.thumbs/'.length), bridge);
        await run;
        expect(res.type).toHaveBeenCalledWith('png');
        const body = res.send.mock.calls[0]?.[0] as Buffer;
        expect(pngFromBase64(body.toString('base64'))?.readUInt32BE(16)).toBe(10);
    });

    it('answers 404 for an unknown file or a name that is not ours', async () => {
        const { bridge } = bridgeWith();
        await expect(call(pathOf('missing.gcode').slice('.thumbs/'.length), bridge).run).rejects.toBeInstanceOf(
            NotFoundException,
        );
        await expect(call('../etc.png', bridge).run).rejects.toBeInstanceOf(NotFoundException);
    });
});
