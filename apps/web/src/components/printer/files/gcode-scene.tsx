import { Grid } from '@react-three/drei/core/Grid';
import { OrbitControls } from '@react-three/drei/core/OrbitControls';
import { Canvas, useThree } from '@react-three/fiber';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { BoxGeometry, BufferAttribute, BufferGeometry, Color, InstancedMesh, MOUSE, Object3D, TOUCH } from 'three';
import { type ThemeColors, useThemeColors } from '@/hooks/use-theme-colors';
import type { FilamentColors } from '@/lib/filament-assignments';
import { type ParsedGcode, SEGMENT_STRIDE as STRIDE } from '@/lib/gcode-parse';
import { fitCamera } from '@/lib/scene-fit';

export type SceneMode = 'lines' | 'solid';

const MIN_TINT_LIGHTNESS = 0.24;
const TOP_LAYER_LIFT = 0.08;
const FILAMENT_AREA = Math.PI * 0.875 ** 2;

function visibleTint(tint: string | undefined): string | undefined {
    if (!tint) return undefined;
    const color = new Color(tint);
    const hsl = { h: 0, s: 0, l: 0 };
    color.getHSL(hsl);
    if (hsl.l < MIN_TINT_LIGHTNESS) color.setHSL(hsl.h, hsl.s, MIN_TINT_LIGHTNESS);
    return `#${color.getHexString()}`;
}

export type Painter = { tinted: boolean; color: (tool: number, top: boolean) => Color };

export function makePainter(filament: FilamentColors | undefined, colors: ThemeColors): Painter {
    const main = visibleTint(filament?.main || undefined);
    const byTool = (filament?.byTool ?? []).map((c) => visibleTint(c || undefined) ?? main);
    const tinted = Boolean(main || byTool.some(Boolean));
    const cache = new Map<string, Color>();
    const color = (tool: number, top: boolean) => {
        const own = (tool >= 0 ? byTool[tool] : undefined) ?? main;
        const key = `${own ?? ''}|${top}`;
        let c = cache.get(key);
        if (!c) {
            if (own) c = top ? new Color(own).offsetHSL(0, 0, TOP_LAYER_LIFT) : new Color(own);
            else c = new Color(top ? colors.primary : colors.muted);
            cache.set(key, c);
        }
        return c;
    };
    return { tinted, color };
}

export function buildLines(data: ParsedGcode) {
    const { layers, minX, maxX, minY, maxY } = data;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    let points = 0;
    for (const l of layers) points += (l.segs.length / STRIDE) * 2;
    const positions = new Float32Array(points * 3);
    const tools = new Int8Array(points / 2);
    const ends: number[] = [];
    let o = 0;
    let t = 0;
    for (const l of layers) {
        const s = l.segs;
        for (let k = 0; k < s.length; k += STRIDE) {
            positions[o++] = s[k] - cx;
            positions[o++] = l.z;
            positions[o++] = -(s[k + 1] - cy);
            positions[o++] = s[k + 2] - cx;
            positions[o++] = l.z;
            positions[o++] = -(s[k + 3] - cy);
            tools[t++] = s[k + 5];
        }
        ends.push(o / 3);
    }
    const attribute = new BufferAttribute(positions, 3);
    const colorAttribute = new BufferAttribute(new Float32Array(points * 3), 3);
    const base = new BufferGeometry();
    base.setAttribute('position', attribute);
    base.setAttribute('color', colorAttribute);
    const top = new BufferGeometry();
    top.setAttribute('position', attribute);
    top.setAttribute('color', colorAttribute);
    return { base, top, ends, tools, colorAttribute };
}

export function paintLines(built: ReturnType<typeof buildLines>, painter: Painter): void {
    const { tools, colorAttribute } = built;
    const out = colorAttribute.array as Float32Array;
    for (let i = 0; i < tools.length; i++) {
        const c = painter.color(tools[i], false);
        const j = i * 6;
        out[j] = c.r;
        out[j + 1] = c.g;
        out[j + 2] = c.b;
        out[j + 3] = c.r;
        out[j + 4] = c.g;
        out[j + 5] = c.b;
    }
    colorAttribute.needsUpdate = true;
}

export function buildSolid(data: ParsedGcode) {
    const { layers, minX, maxX, minY, maxY } = data;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    let count = 0;
    for (const l of layers) count += l.segs.length / STRIDE;
    const geometry = new BoxGeometry(1, 1, 1);
    const mesh = new InstancedMesh(geometry, undefined, count);
    const dummy = new Object3D();
    const tools = new Int8Array(count);
    const ends: number[] = [];
    let i = 0;
    let prevZ = 0;
    for (const l of layers) {
        const h = Math.min(1, Math.max(0.05, l.z - prevZ));
        prevZ = l.z;
        const s = l.segs;
        for (let k = 0; k < s.length; k += STRIDE) {
            const x0 = s[k] - cx;
            const y0 = s[k + 1] - cy;
            const x1 = s[k + 2] - cx;
            const y1 = s[k + 3] - cy;
            const dx = x1 - x0;
            const dy = y1 - y0;
            const len = Math.hypot(dx, dy);
            const w = Math.min(1.5, Math.max(0.2, (s[k + 4] * FILAMENT_AREA) / (len * h)));
            dummy.position.set((x0 + x1) / 2, l.z - h / 2, -(y0 + y1) / 2);
            dummy.rotation.set(0, Math.atan2(dy, dx), 0);
            dummy.scale.set(len + w, h, w);
            dummy.updateMatrix();
            tools[i] = s[k + 5];
            mesh.setMatrixAt(i++, dummy.matrix);
        }
        ends.push(i);
    }
    mesh.instanceMatrix.needsUpdate = true;
    return { mesh, geometry, ends, tools };
}

function Lines({
    data,
    shown,
    colors,
    filament,
}: {
    data: ParsedGcode;
    shown: number;
    colors: ThemeColors;
    filament?: FilamentColors;
}) {
    const built = useMemo(() => buildLines(data), [data]);
    const painter = useMemo(() => makePainter(filament, colors), [filament, colors]);
    useEffect(() => {
        const { base, top } = built;
        return () => {
            base.dispose();
            top.dispose();
        };
    }, [built]);
    useLayoutEffect(() => {
        if (painter.tinted) paintLines(built, painter);
    }, [built, painter]);
    useLayoutEffect(() => {
        const { base, top, ends } = built;
        if (!ends.length) return;
        const index = Math.min(Math.max(shown, 1), ends.length) - 1;
        const end = ends[index];
        const start = index > 0 ? ends[index - 1] : 0;
        base.setDrawRange(0, start);
        top.setDrawRange(start, end - start);
    }, [built, shown]);

    const tinted = painter.tinted;
    return (
        <group>
            <lineSegments geometry={built.base}>
                <lineBasicMaterial
                    key={`base-${tinted}`}
                    vertexColors={tinted}
                    color={tinted ? '#ffffff' : colors.muted}
                    transparent
                    opacity={tinted ? 0.85 : 0.35}
                />
            </lineSegments>
            <lineSegments geometry={built.top}>
                <lineBasicMaterial
                    key={`top-${tinted}`}
                    vertexColors={tinted}
                    color={tinted ? '#ffffff' : colors.primary}
                />
            </lineSegments>
        </group>
    );
}

function Solid({
    data,
    shown,
    colors,
    filament,
}: {
    data: ParsedGcode;
    shown: number;
    colors: ThemeColors;
    filament?: FilamentColors;
}) {
    const built = useMemo(() => buildSolid(data), [data]);
    const painter = useMemo(() => makePainter(filament, colors), [filament, colors]);
    const painted = useRef(-1);
    const paintedWith = useRef<Painter | null>(null);
    useEffect(() => {
        const { mesh, geometry } = built;
        painted.current = -1;
        return () => {
            geometry.dispose();
            mesh.dispose();
        };
    }, [built]);
    useLayoutEffect(() => {
        const { mesh, ends, tools } = built;
        if (!ends.length) return;
        const index = Math.min(Math.max(shown, 1), ends.length) - 1;
        if (paintedWith.current !== painter) {
            paintedWith.current = painter;
            painted.current = -1;
        }
        const prev = painted.current;
        const from = prev < 0 ? 0 : Math.min(prev, index) > 0 ? ends[Math.min(prev, index) - 1] : 0;
        const to = ends[Math.max(prev < 0 ? index : prev, index)];
        const topStart = index > 0 ? ends[index - 1] : 0;
        for (let i = from; i < to; i++) mesh.setColorAt(i, painter.color(tools[i], i >= topStart));
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.count = ends[index];
        painted.current = index;
    }, [built, shown, painter]);

    return (
        <primitive object={built.mesh}>
            <meshStandardMaterial roughness={0.6} metalness={0.05} />
        </primitive>
    );
}

type Controls = {
    target: { set: (x: number, y: number, z: number) => void };
    update: () => void;
    saveState: () => void;
    reset?: () => void;
};

function FitView({ size }: { size: { x: number; y: number; z: number } }) {
    const camera = useThree((s) => s.camera);
    const controls = useThree((s) => s.controls) as Controls | null;
    const width = useThree((s) => s.size.width);
    const height = useThree((s) => s.size.height);
    const fitted = useRef('');
    useLayoutEffect(() => {
        if (!controls || !width || !height) return;
        const key = `${size.x}|${size.y}|${size.z}`;
        if (fitted.current === key) return;
        fitted.current = key;
        const fov = 'fov' in camera ? (camera.fov as number) : 45;
        const fit = fitCamera(size, fov, width / height);
        camera.position.set(...fit.position);
        controls.target.set(...fit.target);
        controls.update();
        controls.saveState();
    }, [camera, controls, width, height, size]);
    return null;
}

function ResetView({ signal }: { signal: number }) {
    const controls = useThree((s) => s.controls) as { reset?: () => void } | null;
    const last = useRef(signal);
    useEffect(() => {
        if (last.current === signal) return;
        last.current = signal;
        controls?.reset?.();
    }, [signal, controls]);
    return null;
}

export function GcodeScene({
    data,
    shown,
    mode,
    pan,
    resetSignal,
    filament,
}: {
    data: ParsedGcode;
    shown: number;
    mode: SceneMode;
    pan: boolean;
    resetSignal: number;
    filament?: FilamentColors;
}) {
    const colors = useThemeColors();
    const span = Math.max(1, data.maxX - data.minX, data.maxY - data.minY);
    const height = data.layers.length ? data.layers[data.layers.length - 1].z : 1;
    const bed = Math.max(Math.ceil((span * 1.6) / 10) * 10, 40);
    const size = useMemo(
        () => ({ x: Math.max(1, data.maxX - data.minX), y: Math.max(1, data.maxY - data.minY), z: height }),
        [data.maxX, data.minX, data.maxY, data.minY, height],
    );
    const distance = fitCamera(size, 45).distance;

    return (
        <Canvas
            dpr={[1, 2]}
            camera={{ position: [distance * 0.7, distance * 0.6, distance * 0.7], fov: 45, near: 0.1, far: 10000 }}
        >
            <ambientLight intensity={mode === 'solid' ? 0.9 : 1} />
            {mode === 'solid' && <hemisphereLight args={['#ffffff', '#444444', 0.6]} />}
            {mode === 'solid' && (
                <>
                    <directionalLight position={[distance, distance * 1.5, distance * 0.5]} intensity={1.6} />
                    <directionalLight position={[-distance, distance * 0.5, -distance]} intensity={0.5} />
                </>
            )}
            <Grid
                args={[bed, bed]}
                cellSize={10}
                cellThickness={0.6}
                cellColor={colors.border}
                sectionSize={50}
                sectionThickness={1}
                sectionColor={colors.muted}
                fadeDistance={distance * 4}
                fadeStrength={1}
            />
            {mode === 'solid' ? (
                <Solid data={data} shown={shown} colors={colors} filament={filament} />
            ) : (
                <Lines data={data} shown={shown} colors={colors} filament={filament} />
            )}
            <OrbitControls
                makeDefault
                target={[0, height / 2, 0]}
                enableDamping
                dampingFactor={0.12}
                enablePan
                panSpeed={1}
                mouseButtons={{ LEFT: pan ? MOUSE.PAN : MOUSE.ROTATE, MIDDLE: MOUSE.PAN, RIGHT: MOUSE.PAN }}
                touches={{ ONE: pan ? TOUCH.PAN : TOUCH.ROTATE, TWO: TOUCH.DOLLY_PAN }}
                minDistance={5}
                maxDistance={distance * 6}
                maxPolarAngle={Math.PI / 2}
            />
            <FitView size={size} />
            <ResetView signal={resetSignal} />
        </Canvas>
    );
}
