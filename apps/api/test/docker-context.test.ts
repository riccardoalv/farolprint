import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dir, '../../..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
const exists = (file: string) => fs.existsSync(path.join(root, file));

describe('Docker build context', () => {
    it('builds from the repository root with infra/Dockerfile everywhere', () => {
        expect(read('infra/docker-compose.yml')).toMatch(/context: \.\.\s+dockerfile: infra\/Dockerfile/);
        for (const workflow of ['.github/workflows/ci.yml', '.github/workflows/docker-image.yml']) {
            expect(read(workflow)).toMatch(/context: \.\s+file: infra\/Dockerfile/);
        }
    });

    it('keeps the ignore file where BuildKit reads it for that Dockerfile', () => {
        expect(exists('infra/Dockerfile.dockerignore')).toBe(true);
        expect(exists('infra/.dockerignore')).toBe(false);
        expect(exists('.dockerignore')).toBe(false);
    });

    it('keeps secrets, dev data and local builds out of the context', () => {
        const patterns = read('infra/Dockerfile.dockerignore')
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean);
        for (const pattern of ['**/.env', '**/.env.local', 'data', '**/node_modules', '**/dist', '.git']) {
            expect(patterns).toContain(pattern);
        }
    });
});
