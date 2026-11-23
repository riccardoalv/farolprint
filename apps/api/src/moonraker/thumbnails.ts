const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export const THUMBNAIL_DIR = '.thumbs';

export interface MoonrakerThumbnail {
    width: number;
    height: number;
    size: number;
    relative_path: string;
}

export function pngFromBase64(b64: string | null | undefined): Buffer | null {
    if (!b64) return null;
    const png = Buffer.from(b64, 'base64');
    if (png.length < 24 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
    if (png.toString('ascii', 12, 16) !== 'IHDR') return null;
    return png;
}

export function thumbnailPath(filename: string): string {
    return `${THUMBNAIL_DIR}/${Buffer.from(filename).toString('base64url')}.png`;
}

export function thumbnailFilename(name: string): string | null {
    const match = /^([A-Za-z0-9_-]+)\.png$/i.exec(name);
    if (!match) return null;
    const filename = Buffer.from(match[1], 'base64url').toString();
    return filename || null;
}

export function moonrakerThumbnails(filename: string, b64: string | null | undefined): MoonrakerThumbnail[] {
    const png = pngFromBase64(b64);
    if (!png || !filename) return [];
    return [
        {
            width: png.readUInt32BE(16),
            height: png.readUInt32BE(20),
            size: png.length,
            relative_path: thumbnailPath(filename),
        },
    ];
}
