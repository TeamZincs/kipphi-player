/**
 * context.ts —— AnyGPUContext2D
 *
 * 一个「延迟收集 + 合批 + 实例化绘制」的 GPU 2D 绘图上下文：
 *
 *  - 后端可选 WebGL 1 / WebGPU，对外 API 完全一致；
 *  - `AnyGPUContext2D` 向下派发 `LayerContext2D`（图层）；
 *  - 一个图层里画出来的东西默认共享同一个 z，可以随时手动改 `ctx.z` 指定别的 z；
 *  - 图层 API 与 `CanvasRenderingContext2D` 基本一致，另外多了状态机形式的 `tint`；
 *  - 所有绘制都不是即时的：先记录成实例，`flush()` 时统一按 z 排序、合批、实例化绘制；
 *  - z 的归一化完全在着色器里做（uniform 里只有 zMin 和 1/(zMax-zMin)），CPU 只写原始 z。
 *
 * 用法：
 * ```ts
 * const gpu = await AnyGPUContext2D.create({ canvas, backend: "webgl1", zRange: [0, 100] });
 *
 * const background = gpu.createLayer(0);
 * const notes = gpu.createLayer(50);
 *
 * function frame() {
 *     background.fillStyle = "#101018";
 *     background.fillRect(0, 0, gpu.width, gpu.height);
 *
 *     notes.tint = [255, 128, 128];
 *     notes.drawImage(noteImage, 10, 20, 64, 64);
 *     notes.z = 60;                       // 手动指定另一个 z
 *     notes.fillRect(0, 0, 10, 10);
 *
 *     gpu.flush();                        // 合批 + 实例化绘制，并清空各图层记录
 * }
 * ```
 *
 * 几何统一成「一个实例 = 一个四边形（或退化掉一个角的三角形）」：
 * 基础网格是一条 4 顶点 triangle-strip，实例里存 4 个角点坐标 / uv 矩形 / 颜色 / z / 混合模式，
 * 因此一次 drawArraysInstanced 就能画成千上万个图元，三角形只是把 BR 与 BL 重合。
 *
 * 已知取舍（为了在单文件里保持可维护）：
 *  - 不支持渐变 / pattern / 阴影 / clip / Path2D / 字体以外的文本排版；
 *  - 自相交多边形的填充按简单多边形三角化，可能有瑕疵；
 *  - 描边的拐角用「小方块补角」近似，半透明描边在重叠处会被叠加两次；
 *  - miterLimit 未实现，lineJoin 只区分 round / bevel / miter 的视觉效果差异不大。
 */

import { Matrix33, identity } from "./matrix";

/* ========================================================================= *
 * 公共类型
 * ========================================================================= */

export type RGB = readonly [number, number, number];
export type RGBA = readonly [number, number, number, number];
/** CSS 颜色字符串，或 0..255 的 RGB / RGBA 元组 */
export type ColorLike = string | RGB | RGBA;
export type BackendKind = "webgl1" | "webgpu";
export type Point = [number, number];

/** 混合模式（与 GPU 流水线一一对应，写进实例数据里） */
export const BLEND_SOURCE_OVER = 0;
export const BLEND_DESTINATION_OUT = 1;
export const BLEND_LIGHTER = 2;

export interface FlushStats {
    /** 这一帧提交的实例数 */
    instances: number;
    /** 拆出来的 draw call 数 */
    batches: number;
    /** 这一帧真正跑了的特效着色器趟数（blur 这种两趟的算 2；贴回画布不算） */
    effects: number;
}

/* ------------------------------------------------------------------ *
 * 特效（后处理着色器）
 *
 * 特效是「一整帧里某个 z 区间的内容画到离屏纹理后，再过一遍全屏着色器」。
 * 区间由调用方决定，因此「只影响谱面不影响 UI」这种事情只要让区间不含
 * UI 所在图层就行了（参考 Phira 的 effect.global）。
 * ------------------------------------------------------------------ */

/** uniform 的取值：标量、二元组或四元组 */
export type EffectUniformValue = number | readonly [number, number] | readonly [number, number, number, number];
export type EffectUniforms = Record<string, EffectUniformValue>;

/** 一次特效请求：用哪个着色器、uniform 当前取什么值 */
export interface EffectRequest {
    shader: string;
    uniforms?: EffectUniforms;
}

/** 注册到上下文里的着色器 */
export interface EffectShader {
    /** 唯一名字，Phira 里就是 effect.shader（内置名或 `/包内路径`） */
    name: string;
    /**
     * uniform 布局：名字 -> 分量数（1 = float，2 = vec2，4 = vec4）。
     *
     * **一般不用写**：会从源码里自动解析——
     * GLSL 看 `uniform float x; // %默认值%` 声明，
     * WGSL 看 `// @uniform float x = 0.5` 注释指令，
     * 两者都有时合并（同名以 WGSL 为准）。显式给出时则覆盖解析结果。
     */
    layout?: Record<string, 1 | 2 | 4>;
    /** WebGL 1 用的片元着色器（GLSL ES 1.00），可用内置的 uv / screenTexture / screenSize / time */
    glsl?: string;
    /** WebGPU 用的片元主体（WGSL，返回值 vec4f），变量名与 GLSL 版一致 */
    wgsl?: string;
    /**
     * WGSL 的模块级前导代码（辅助函数等）
     *
     * `wgsl` 主体会被塞进 `fn fs(...) {}` 里，所以函数声明不能写在里面，
     * 需要的话放这里。
     */
    wgslPrelude?: string;
}

/** 一个 z 区间上依次应用的特效链。区间是**左闭右开**的 `[from, to)` */
export interface EffectRange {
    from: number;
    to: number;
    chain: EffectRequest[];
}

export interface AnyGPUContext2DOptions {
    canvas: HTMLCanvasElement | OffscreenCanvas;
    /** 缺省 'auto'：优先 WebGPU，失败则回退 WebGL 1 */
    backend?: BackendKind | "auto";
    /** z 归一化范围，缺省 [0, 1] */
    zRange?: [number, number];
    /** 每帧开始时清屏的颜色，null 表示不清屏 */
    clearColor?: ColorLike | null;
    /** 复用外部创建好的 GPUDevice（仅 WebGPU） */
    device?: unknown;
}

/* ========================================================================= *
 * 实例布局
 *
 * 20 个 float / 80 字节：
 *   0..7   四个角点：TL.xy, TR.xy, BL.xy, BR.xy
 *   8..11  uv 矩形：u0, v0, u1, v1
 *   12..15 颜色：r, g, b, a（直通 alpha，着色器里再预乘）
 *   16     z（原始世界坐标，不做归一化）
 *   17     混合模式
 *   18..19 保留
 * ========================================================================= */

const INSTANCE_FLOATS = 20;
const INSTANCE_BYTES = INSTANCE_FLOATS * 4;
const OFFSET_UV = 8;
const OFFSET_COLOR = 12;
const OFFSET_Z = 16;
const OFFSET_BLEND = 17;

const EPS = 1e-6;

/** 文本纹理缓存的条数上限（LRU） */
const TEXT_CACHE_LIMIT = 512;

/** 一个 GPU 纹理，`handle` 是后端私有对象 */
export class Texture {
    constructor(
        readonly source: TexImageSource,
        readonly width: number,
        readonly height: number,
        readonly handle: unknown,
    ) { }
}

class InstanceBuffer {
    floats = new Float32Array(INSTANCE_FLOATS * 256);
    textures: (Texture | null)[] = [];
    count = 0;

    reset() {
        this.count = 0;
        this.textures.length = 0;
    }

    alloc(texture: Texture | null) {
        const needed = (this.count + 1) * INSTANCE_FLOATS;
        if (needed > this.floats.length) {
            const next = new Float32Array(Math.max(needed, this.floats.length * 2));
            next.set(this.floats.subarray(0, this.count * INSTANCE_FLOATS));
            this.floats = next;
        }
        const offset = this.count * INSTANCE_FLOATS;
        this.count++;
        this.textures.push(texture);
        return offset;
    }
}

/* ========================================================================= *
 * 颜色
 * ========================================================================= */

export type AnyCanvas2D = HTMLCanvasElement | OffscreenCanvas;
export type AnyCanvas2DContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** 从 canvas（可能是 OffscreenCanvas）拿 2D 上下文；两个重载的联合会把类型推成 RenderingContext，这里收窄一下 */
function getCanvas2D(canvas: AnyCanvas2D, options?: CanvasRenderingContext2DSettings): AnyCanvas2DContext {
    return canvas.getContext("2d", options) as AnyCanvas2DContext;
}

function createCanvas2D(width = 1, height = 1, readback = false): { canvas: AnyCanvas2D; ctx: AnyCanvas2DContext } {
    const options = readback ? { willReadFrequently: true } : undefined;
    if (typeof OffscreenCanvas !== "undefined") {
        const canvas = new OffscreenCanvas(width, height);
        return { canvas, ctx: getCanvas2D(canvas, options) };
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return { canvas, ctx: getCanvas2D(canvas, options) };
}

const colorCache = new Map<string, RGBA>();
let colorProbe: AnyCanvas2DContext | null = null;

function parseColorString(color: string): RGBA {
    const cached = colorCache.get(color);
    if (cached) return cached;

    if (!colorProbe) colorProbe = createCanvas2D(1, 1, true).ctx;
    const ctx = colorProbe;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "#000000";
    ctx.fillStyle = color;              // 交给浏览器解析，非法值会被忽略
    ctx.fillRect(0, 0, 1, 1);
    const data = ctx.getImageData(0, 0, 1, 1).data;
    const result: RGBA = [data[0] / 255, data[1] / 255, data[2] / 255, data[3] / 255];
    // 播放器每帧都会拼出新的 rgba(...) 字符串，缓存必须有上限
    if (colorCache.size > 4096) colorCache.clear();
    colorCache.set(color, result);
    return result;
}

/** 把 ColorLike 归一化到 0..1 的 RGBA */
export function parseColor(value: ColorLike): RGBA {
    if (typeof value === "string") return parseColorString(value);
    if (value.length === 4) {
        return [value[0] / 255, value[1] / 255, value[2] / 255, value[3] / 255];
    }
    return [value[0] / 255, value[1] / 255, value[2] / 255, 1];
}

/* ========================================================================= *
 * 几何：三角形化 / 折线化
 * ========================================================================= */

function cross(ax: number, ay: number, bx: number, by: number, cx: number, cy: number) {
    return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function pointInTriangle(px: number, py: number, ax: number, ay: number, bx: number, by: number, cx: number, cy: number) {
    const d1 = cross(ax, ay, bx, by, px, py);
    const d2 = cross(bx, by, cx, cy, px, py);
    const d3 = cross(cx, cy, ax, ay, px, py);
    const hasNeg = d1 < -EPS || d2 < -EPS || d3 < -EPS;
    const hasPos = d1 > EPS || d2 > EPS || d3 > EPS;
    return !(hasNeg && hasPos);
}

/** 耳切法三角化一个简单多边形 */
export function triangulate(points: Point[]): Point[][] {
    const poly: Point[] = [];
    for (const p of points) {
        const last = poly[poly.length - 1];
        if (!last || Math.abs(last[0] - p[0]) > EPS || Math.abs(last[1] - p[1]) > EPS) {
            poly.push([p[0], p[1]]);
        }
    }
    while (poly.length > 2) {
        const first = poly[0]!, last = poly[poly.length - 1]!;
        if (Math.abs(first[0] - last[0]) < EPS && Math.abs(first[1] - last[1]) < EPS) poly.pop();
        else break;
    }
    if (poly.length < 3) return [];

    let area = 0;
    for (let i = 0; i < poly.length; i++) {
        const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
        area += a[0] * b[1] - b[0] * a[1];
    }
    if (Math.abs(area) < EPS) return [];
    if (area < 0) poly.reverse();

    const indices = poly.map((_, i) => i);
    const triangles: Point[][] = [];
    let guard = poly.length * poly.length + 16;

    while (indices.length > 3 && guard-- > 0) {
        let clipped = false;
        for (let i = 0; i < indices.length; i++) {
            const i0 = indices[(i + indices.length - 1) % indices.length]!;
            const i1 = indices[i]!;
            const i2 = indices[(i + 1) % indices.length]!;
            const a = poly[i0]!, b = poly[i1]!, c = poly[i2]!;
            if (cross(a[0], a[1], b[0], b[1], c[0], c[1]) <= EPS) continue;

            let blocked = false;
            for (const j of indices) {
                if (j === i0 || j === i1 || j === i2) continue;
                const p = poly[j]!;
                if (pointInTriangle(p[0], p[1], a[0], a[1], b[0], b[1], c[0], c[1])) {
                    blocked = true;
                    break;
                }
            }
            if (blocked) continue;

            triangles.push([[a[0], a[1]], [b[0], b[1]], [c[0], c[1]]]);
            indices.splice(i, 1);
            clipped = true;
            break;
        }
        if (!clipped) break;      // 自相交等病态情况：剩下的一把扇出去
    }

    if (indices.length === 3) {
        const a = poly[indices[0]!]!, b = poly[indices[1]!]!, c = poly[indices[2]!]!;
        triangles.push([[a[0], a[1]], [b[0], b[1]], [c[0], c[1]]]);
    } else if (indices.length > 3) {
        const a = poly[indices[0]!]!;
        for (let i = 1; i < indices.length - 1; i++) {
            const b = poly[indices[i]!]!, c = poly[indices[i + 1]!]!;
            triangles.push([[a[0], a[1]], [b[0], b[1]], [c[0], c[1]]]);
        }
    }
    return triangles;
}

type QuadEmitter = (x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) => void;

/** 按虚线样式把折线切成若干「实线段」，用来在 CPU 侧实现 setLineDash */
function dashPolyline(pts: Point[], closed: boolean, pattern: number[], offset: number): Point[][] {
    const total = pattern.reduce((sum, value) => sum + value, 0);
    if (!(total > 0)) return [pts];

    let index = 0;
    let left = pattern[0]!;
    let skip = ((offset % total) + total) % total;
    while (skip >= left) {
        skip -= left;
        index = (index + 1) % pattern.length;
        left = pattern[index]!;
    }
    left -= skip;
    let on = index % 2 === 0;

    const runs: Point[][] = [];
    let current: Point[] = [];
    const source = closed ? [...pts, pts[0]!] : pts;

    for (let i = 0; i < source.length - 1; i++) {
        const a = source[i]!, b = source[i + 1]!;
        const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (length < EPS) continue;
        const ux = (b[0] - a[0]) / length;
        const uy = (b[1] - a[1]) / length;
        let ax = a[0], ay = a[1];
        let remaining = length;

        while (remaining > EPS) {
            const step = Math.min(remaining, left);
            if (on) {
                if (current.length === 0) current.push([ax, ay]);
                current.push([ax + ux * step, ay + uy * step]);
            }
            ax += ux * step;
            ay += uy * step;
            remaining -= step;
            left -= step;
            if (left <= EPS) {
                if (on && current.length > 1) {
                    runs.push(current);
                    current = [];
                }
                index = (index + 1) % pattern.length;
                left = pattern[index]!;
                on = index % 2 === 0;
            }
        }
    }
    if (on && current.length > 1) runs.push(current);
    return runs;
}

/**
 * 描边：每段一个四边形 + 每个拐点一个方补角。
 * 点已经是设备坐标，`halfWidth` 也是设备坐标下的半宽。
 */
function buildStroke(
    pts: Point[],
    closed: boolean,
    halfWidth: number,
    cap: CanvasLineCap,
    emit: QuadEmitter,
) {
    const n = pts.length;
    if (n === 0 || halfWidth <= 0) return;

    if (n === 1) {
        if (cap !== "butt") {
            const p = pts[0]!;
            emit(p[0] - halfWidth, p[1] - halfWidth, p[0] + halfWidth, p[1] - halfWidth,
                p[0] + halfWidth, p[1] + halfWidth, p[0] - halfWidth, p[1] + halfWidth);
        }
        return;
    }

    const segCount = closed ? n : n - 1;
    for (let i = 0; i < segCount; i++) {
        const a = pts[i]!, b = pts[(i + 1) % n]!;
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const len = Math.hypot(dx, dy);
        if (len < EPS) continue;
        const nx = (-dy / len) * halfWidth;
        const ny = (dx / len) * halfWidth;
        emit(a[0] + nx, a[1] + ny, b[0] + nx, b[1] + ny, b[0] - nx, b[1] - ny, a[0] - nx, a[1] - ny);
    }

    // 拐点补角
    const jointStart = closed ? 0 : 1;
    const jointEnd = closed ? n : n - 1;
    for (let i = jointStart; i < jointEnd; i++) {
        const p = pts[i]!;
        emit(p[0] - halfWidth, p[1] - halfWidth, p[0] + halfWidth, p[1] - halfWidth,
            p[0] + halfWidth, p[1] + halfWidth, p[0] - halfWidth, p[1] + halfWidth);
    }

    // 端点线帽（round 用方帽近似）
    if (!closed && cap !== "butt") {
        const extend = halfWidth;
        for (const [index, sign] of [[0, -1], [n - 1, 1]] as const) {
            const p = pts[index]!;
            const q = pts[index + sign]!;
            const dx = p[0] - q[0], dy = p[1] - q[1];
            const len = Math.hypot(dx, dy);
            if (len < EPS) continue;
            const ux = (dx / len) * extend, uy = (dy / len) * extend;
            const nx = (-dy / len) * halfWidth, ny = (dx / len) * halfWidth;
            emit(p[0] + nx, p[1] + ny, p[0] + nx + ux, p[1] + ny + uy,
                p[0] - nx + ux, p[1] - ny + uy, p[0] - nx, p[1] - ny);
        }
    }
}

/* ========================================================================= *
 * 后端接口
 * ========================================================================= */

/** 后端能接受的上传源：DOM 图像源，或已经是原始像素的白纹理 */
type TextureSource = TexImageSource | Uint8Array;

/** 后端编译好的特效着色器 */
interface CompiledEffect {
    /** uniform 名字 -> 分量数，顺序即打包顺序 */
    layout: Record<string, 1 | 2 | 4>;
}

interface RenderBackend {
    readonly kind: BackendKind;
    beginFrame(width: number, height: number, zRange: [number, number], clear: RGBA | null): void;
    createTexture(source: TextureSource, width: number, height: number): unknown;
    destroyTexture(handle: unknown): void;
    uploadInstances(data: Float32Array, count: number): void;
    /** 把 [first, first+count) 画进 target；target 为 null 表示画布 */
    drawInstances(texture: unknown, blend: number, first: number, count: number, target?: unknown): void;
    /** 跑一次全屏后处理：把 source 过一遍特效着色器，写进 target */
    runEffect(compiled: unknown, source: unknown, target: unknown, uniforms: EffectUniforms, width: number, height: number, time: number): void;
    /** 把离屏纹理原样贴到 target（null = 画布，预乘 alpha 直接拷贝） */
    blit(source: unknown, target: unknown): void;
    /** 空帧也要清一次画布 */
    clearFrame(): void;
    /** 把某块离屏纹理清成全透明 */
    clearRenderTarget(handle: unknown): void;
    /** 创建一块可渲染的离屏纹理（后处理用） */
    createRenderTarget(width: number, height: number): unknown;
    destroyRenderTarget(handle: unknown): void;
    /** 把 EffectShader 编译成当前后端能用的东西；当前后端没有对应源码时返回 null */
    compileEffect(shader: EffectShader): CompiledEffect | null;
    destroyEffect(compiled: unknown): void;
    endFrame(): void;
    destroy(): void;
}

/* ========================================================================= *
 * WebGL 1 后端
 * ========================================================================= */

const GL_VERTEX = `
precision highp float;

attribute vec2 a_corner;      // (0,0) (1,0) (0,1) (1,1)
attribute vec4 a_c01;         // TL, TR
attribute vec4 a_c23;         // BL, BR
attribute vec4 a_uv;          // u0, v0, u1, v1
attribute vec4 a_color;
attribute vec2 a_zblend;      // z, blend

uniform vec2 u_viewport;
uniform vec2 u_zRange;        // zMin, 1/(zMax-zMin)

varying vec2 v_uv;
varying vec4 v_color;

void main() {
    vec2 p = mix(mix(a_c01.xy, a_c01.zw, a_corner.x), mix(a_c23.xy, a_c23.zw, a_corner.x), a_corner.y);
    vec2 ndc = vec2(p.x / u_viewport.x * 2.0 - 1.0, 1.0 - p.y / u_viewport.y * 2.0);

    // z 的归一化在着色器里完成
    float z = clamp((a_zblend.x - u_zRange.x) * u_zRange.y, 0.0, 1.0);

    gl_Position = vec4(ndc, z * 2.0 - 1.0, 1.0);
    v_uv = mix(a_uv.xy, a_uv.zw, a_corner);
    v_color = a_color;
}
`;

/**
 * 所有纹理都按「预乘 alpha」上传（见 WebGL1Backend 里的 UNPACK_PREMULTIPLY_ALPHA_WEBGL
 * 和 WebGPU 的 premultipliedAlpha）。所以这里 texture.rgb 已经乘过 texture.a，
 * 只需要再乘上 图元颜色 × globalAlpha，**不能**再乘一次 texture.a，
 * 否则低 alpha 的像素会被压成黑色。
 */
const GL_FRAGMENT = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform sampler2D u_tex;
varying vec2 v_uv;
varying vec4 v_color;

void main() {
    vec4 t = texture2D(u_tex, v_uv);          // 预乘 alpha
    float alpha = t.a * v_color.a;
    gl_FragColor = vec4(t.rgb * v_color.rgb * v_color.a, alpha);
}
`;

const WHITE_PIXEL = new Uint8Array([255, 255, 255, 255]);

/** 后处理用的全屏四边形（NDC 位置 + uv） */
const GL_EFFECT_VERTEX = `
precision highp float;

attribute vec2 a_pos;

varying vec2 uv;

void main() {
    // 这里采样的是离屏渲染目标（GL 约定 v=0 在底边），所以不做上下翻转：
    // 每多翻一次，多趟特效链之后的整体方向就会错一次
    uv = a_pos * 0.5 + 0.5;
    gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

/** 内置「原样拷贝」特效，用于把离屏纹理贴回画布 */
const COPY_EFFECT_SHADER: EffectShader = {
    name: "#copy",
    glsl: `
    void main() {
        gl_FragColor = texture2D(screenTexture, uv);
    }
    `,
    wgsl: `
    return textureSample(screenTexture, samp, uv);
    `,
};

/** WebGL 1 的离屏渲染目标 */
interface WebGL1RenderTarget {
    texture: WebGLTexture;
    fbo: WebGLFramebuffer;
    width: number;
    height: number;
}

/** WebGL 1 编译好的特效着色器 */
interface WebGL1EffectProgram extends CompiledEffect {
    program: WebGLProgram;
    /** uniform 缺省值（从 `// %def%` 注释解析） */
    defaults: EffectUniforms;
    pos: number;
    screenTexture: WebGLUniformLocation | null;
    screenSize: WebGLUniformLocation | null;
    time: WebGLUniformLocation | null;
    userUniforms: Map<string, WebGLUniformLocation | null>;
}

/**
 * 拼出最终给 GL 的片元着色器源码。
 *
 * Phira 的自定义着色器是完整的 `#version 100` 片元着色器（自己声明 uv 等），
 * 而我们内置的几个只写了 `main`，所以这里：
 *  - 把 `#version` 摘到最前面（它必须在第一行）；
 *  - 用户没声明的内置变量（uv / screenTexture / screenSize / time）补上，
 *    已经声明过的就不重复声明，免得撞车。
 */
function buildEffectFragment(source: string): string {
    let code = source.replace(/^\uFEFF/, "").trim();
    code = code.replace(/^\s*#version[^\n]*\n?/, "");

    const declarations: string[] = [];
    const declared = (pattern: RegExp) => pattern.test(code);
    if (!declared(/\bvarying\b[^;]*\buv\b\s*;/)) declarations.push("varying vec2 uv;");
    if (!declared(/\buniform\b[^;]*\bscreenTexture\b\s*;/)) declarations.push("uniform sampler2D screenTexture;");
    if (!declared(/\buniform\b[^;]*\bscreenSize\b\s*;/)) declarations.push("uniform vec2 screenSize;");
    if (!declared(/\buniform\b[^;]*\btime\b\s*;/)) declarations.push("uniform float time;");

    return [
        "#version 100",
        "precision mediump float;",
        ...declarations,
        code,
    ].join("\n");
}

/**
 * 从 WGSL 主体里解析 uniform 声明。
 *
 * WGSL 不能在函数体里声明 uniform，所以用一个注释指令代替：
 *
 * ```wgsl
 * // @uniform float factor = 0.5
 * // @uniform vec2 offset
 * ```
 *
 * 类型写 GLSL 风格（float / vec2 / vec4）或 WGSL 风格（f32 / vec2f / vec4f）都行。
 * 有 `glsl` 版本时通常不用写这些，直接复用 GLSL 的 uniform 声明。
 */
function parseWGSLUniforms(source: string): { layout: Record<string, 1 | 2 | 4>; defaults: EffectUniforms } {
    const layout: Record<string, 1 | 2 | 4> = {};
    const defaults: EffectUniforms = {};
    const pattern = /\/\/\s*@uniform\s+(f32|float|vec2f|vec2|vec4f|vec4)\s+([A-Za-z_]\w*)(?:\s*=\s*([-\d.,\s]+))?/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
        const type = match[1]!;
        const name = match[2]!;
        layout[name] = type === "float" || type === "f32" ? 1 : type === "vec2" || type === "vec2f" ? 2 : 4;
        const raw = match[3]?.trim();
        if (raw === undefined || raw === "") continue;
        const parts = raw.split(/[\s,]+/).filter(Boolean).map(Number);
        if (parts.length && parts.every(item => Number.isFinite(item))) {
            defaults[name] = parts.length === 1 ? parts[0]! : parts as [number, number] | [number, number, number, number];
        }
    }
    return { layout, defaults };
}

/** 从 GLSL 源码里解析 uniform 声明（含 `// %默认值%`） */
function parseGLSLUniforms(source: string): { layout: Record<string, 1 | 2 | 4>; defaults: EffectUniforms } {
    const layout: Record<string, 1 | 2 | 4> = {};
    const defaults: EffectUniforms = {};
    const pattern = /uniform\s+(float|vec2|vec4)\s+(\w+)\s*;(?:\s*\/\/\s*%([^%]*)%)?/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
        const type = match[1]!;
        const name = match[2]!;
        if (name === "screenTexture" || name === "screenSize" || name === "time") continue;
        layout[name] = type === "float" ? 1 : type === "vec2" ? 2 : 4;
        if (match[3] !== undefined) {
            const raw = match[3].trim();
            const parts = raw.split(/[\s,]+/).filter(Boolean).map(Number);
            if (parts.length && parts.every(item => Number.isFinite(item))) {
                defaults[name] = parts.length === 1 ? parts[0]! : parts as [number, number] | [number, number, number, number];
            }
        }
    }
    return { layout, defaults };
}

/**
 * 解析着色器的 uniform 布局：GLSL 的 `uniform` 声明 + WGSL 的 `// @uniform` 注释，
 * 显式给了 `shader.layout` 的话以它为准（只覆盖同名项）。
 */
function resolveEffectLayout(shader: EffectShader): { layout: Record<string, 1 | 2 | 4>; defaults: EffectUniforms } {
    const glsl = shader.glsl ? parseGLSLUniforms(shader.glsl) : null;
    const wgsl = shader.wgsl ? parseWGSLUniforms(shader.wgsl) : null;
    return {
        layout: { ...glsl?.layout, ...wgsl?.layout, ...shader.layout },
        defaults: { ...glsl?.defaults, ...wgsl?.defaults },
    };
}

class WebGL1Backend implements RenderBackend {
    readonly kind: BackendKind = "webgl1";

    private readonly gl: WebGLRenderingContext;
    private readonly ext: ANGLE_instanced_arrays;
    private readonly program: WebGLProgram;
    private readonly uniforms: { viewport: WebGLUniformLocation | null; zRange: WebGLUniformLocation | null; tex: WebGLUniformLocation | null };
    private readonly attribs: number[] = [];
    private readonly quadBuffer: WebGLBuffer;
    private readonly instanceBuffer: WebGLBuffer;
    private readonly white: WebGLTexture;
    private readonly textures = new Set<WebGLTexture>();

    /** 后处理：全屏四边形缓冲（pos.xy + uv.xy） */
    private readonly effectQuad: WebGLBuffer;
    /** 离屏渲染目标 */
    private readonly targets = new Set<WebGL1RenderTarget>();
    private currentTarget: WebGL1RenderTarget | null = null;
    private frameWidth = 0;
    private frameHeight = 0;
    private clearColor: RGBA | null = null;
    private canvasCleared = false;
    /** 当前绑定的 program，特效 pass 和实例化绘制会来回切 */
    private programInUse: WebGLProgram | null = null;
    /** 贴回画布用的拷贝 program（缓存，别每帧新建） */
    private copyProgram: WebGL1EffectProgram | null = null;

    constructor(canvas: HTMLCanvasElement | OffscreenCanvas) {
        const gl = canvas.getContext("webgl", {
            alpha: true,
            premultipliedAlpha: true,
            antialias: false,
            depth: false,
            stencil: false,
            preserveDrawingBuffer: false,
        }) as WebGLRenderingContext | null;
        if (!gl) throw new Error("[AnyGPUContext2D] 无法创建 WebGL 1 上下文");
        this.gl = gl;

        const ext = gl.getExtension("ANGLE_instanced_arrays");
        if (!ext) throw new Error("[AnyGPUContext2D] 当前设备不支持 ANGLE_instanced_arrays");
        this.ext = ext;

        this.program = this.buildProgram(GL_VERTEX, GL_FRAGMENT);
        gl.useProgram(this.program);

        this.uniforms = {
            viewport: gl.getUniformLocation(this.program, "u_viewport"),
            zRange: gl.getUniformLocation(this.program, "u_zRange"),
            tex: gl.getUniformLocation(this.program, "u_tex"),
        };
        gl.uniform1i(this.uniforms.tex, 0);

        for (const name of ["a_corner", "a_c01", "a_c23", "a_uv", "a_color", "a_zblend"]) {
            this.attribs.push(gl.getAttribLocation(this.program, name));
        }
        for (const loc of this.attribs) gl.enableVertexAttribArray(loc);

        // 基础网格：triangle-strip 的四个角
        this.quadBuffer = gl.createBuffer()!;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);

        this.instanceBuffer = gl.createBuffer()!;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, INSTANCE_BYTES * 1024, gl.DYNAMIC_DRAW);

        // 纯色图元用一个 1x1 白纹理，避免额外流水线
        this.white = this.uploadTexture(WHITE_PIXEL, 1, 1) as WebGLTexture;
        this.textures.add(this.white);

        // 后处理全屏四边形：(-1,-1) (1,-1) (-1,1) (1,1)，交错存 pos.xy + uv.xy
        this.effectQuad = gl.createBuffer()!;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.effectQuad);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
            -1, -1, 0, 0,
            1, -1, 1, 0,
            -1, 1, 0, 1,
            1, 1, 1, 1,
        ]), gl.STATIC_DRAW);

        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.CULL_FACE);
        gl.enable(gl.BLEND);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
        // 统一按预乘 alpha 上传：着色器据此不再乘纹理自身的 alpha
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
    }

    private buildProgram(vsSource: string, fsSource: string): WebGLProgram {
        const gl = this.gl;
        const compile = (type: number, source: string) => {
            const shader = gl.createShader(type)!;
            gl.shaderSource(shader, source);
            gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
                throw new Error("[AnyGPUContext2D] 着色器编译失败: " + gl.getShaderInfoLog(shader));
            }
            return shader;
        };
        const program = gl.createProgram()!;
        gl.attachShader(program, compile(gl.VERTEX_SHADER, vsSource));
        gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fsSource));
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            throw new Error("[AnyGPUContext2D] 着色器链接失败: " + gl.getProgramInfoLog(program));
        }
        return program;
    }

    private uploadTexture(source: TextureSource, width: number, height: number): WebGLTexture {
        const gl = this.gl;
        const texture = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, texture);
        // 每次上传前都显式设置，避免被别处改掉的全局状态影响
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
        if (source instanceof Uint8Array) {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
        } else {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
        }
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return texture;
    }

    createTexture(source: TextureSource, width: number, height: number) {
        const texture = this.uploadTexture(source, width, height);
        this.textures.add(texture);
        return texture;
    }

    destroyTexture(handle: unknown) {
        if (!handle) return;
        this.textures.delete(handle as WebGLTexture);
        this.gl.deleteTexture(handle as WebGLTexture);
    }

    beginFrame(width: number, height: number, zRange: [number, number], clear: RGBA | null) {
        const gl = this.gl;
        this.frameWidth = width;
        this.frameHeight = height;
        this.clearColor = clear;
        this.currentTarget = null;
        // 画布的清除延迟到第一次往画布画的时候（有特效时整帧都画在离屏纹理上，最后才贴回来）
        this.canvasCleared = false;
        gl.viewport(0, 0, width, height);
        this.useProgram(this.program);
        gl.uniform2f(this.uniforms.viewport, width, height);
        const span = zRange[1] - zRange[0];
        gl.uniform2f(this.uniforms.zRange, zRange[0], span === 0 ? 0 : 1 / span);
        gl.activeTexture(gl.TEXTURE0);
    }

    /**
     * 切换渲染目标；null 表示画布。
     * **不清离屏目标** —— 需要清的时候走 {@linkcode clearRenderTarget}，
     * 否则整帧累积目标会在中途被误清（特效链跑完回到它的时候就全没了）。
     */
    private bindTarget(target: WebGL1RenderTarget | null) {
        if (this.currentTarget === target && (target !== null || this.canvasCleared)) return;
        const gl = this.gl;
        this.currentTarget = target;
        if (target) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
            gl.viewport(0, 0, target.width, target.height);
        } else {
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, this.frameWidth, this.frameHeight);
            if (!this.canvasCleared) {
                this.canvasCleared = true;
                if (this.clearColor) {
                    gl.clearColor(this.clearColor[0], this.clearColor[1], this.clearColor[2], this.clearColor[3]);
                    gl.clear(gl.COLOR_BUFFER_BIT);
                }
            }
        }
    }

    /** 把某块离屏纹理清成全透明（每段内容/每趟中间结果用之前调一次） */
    clearRenderTarget(handle: unknown) {
        const target = handle as WebGL1RenderTarget | null;
        if (!target) return;
        const gl = this.gl;
        this.currentTarget = target;
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
        gl.viewport(0, 0, target.width, target.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
    }

    /** 切换 program（重复设置同一个很廉价，记一下省得每帧刷状态） */
    private useProgram(program: WebGLProgram) {
        if (this.programInUse === program) return;
        this.programInUse = program;
        this.gl.useProgram(program);
    }

    uploadInstances(data: Float32Array, count: number) {
        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, count * INSTANCE_FLOATS), gl.DYNAMIC_DRAW);
    }

    drawInstances(texture: unknown, blend: number, first: number, count: number, target?: unknown) {
        const gl = this.gl;
        const ext = this.ext;
        this.bindTarget((target as WebGL1RenderTarget | null | undefined) ?? null);
        // 特效 pass 换过 program，回到实例化绘制时必须切回来（uniform 仍留在主 program 上）
        this.useProgram(this.program);

        switch (blend) {
            case BLEND_DESTINATION_OUT:
                gl.blendFunc(gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);
                break;
            case BLEND_LIGHTER:
                gl.blendFunc(gl.ONE, gl.ONE);
                break;
            default:
                gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
                break;
        }

        gl.bindTexture(gl.TEXTURE_2D, (texture as WebGLTexture | null) ?? this.white);

        const [corner, c01, c23, uv, color, zblend] = this.attribs;

        gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
        gl.vertexAttribPointer(corner!, 2, gl.FLOAT, false, 8, 0);
        ext.vertexAttribDivisorANGLE(corner!, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
        const offset = first * INSTANCE_BYTES;
        const stride = INSTANCE_BYTES;
        gl.vertexAttribPointer(c01!, 4, gl.FLOAT, false, stride, offset + 0);
        gl.vertexAttribPointer(c23!, 4, gl.FLOAT, false, stride, offset + 16);
        gl.vertexAttribPointer(uv!, 4, gl.FLOAT, false, stride, offset + (OFFSET_UV * 4));
        gl.vertexAttribPointer(color!, 4, gl.FLOAT, false, stride, offset + (OFFSET_COLOR * 4));
        gl.vertexAttribPointer(zblend!, 2, gl.FLOAT, false, stride, offset + (OFFSET_Z * 4));
        ext.vertexAttribDivisorANGLE(c01!, 1);
        ext.vertexAttribDivisorANGLE(c23!, 1);
        ext.vertexAttribDivisorANGLE(uv!, 1);
        ext.vertexAttribDivisorANGLE(color!, 1);
        ext.vertexAttribDivisorANGLE(zblend!, 1);

        ext.drawArraysInstancedANGLE(gl.TRIANGLE_STRIP, 0, 4, count);
    }

    createRenderTarget(width: number, height: number) {
        const gl = this.gl;
        const texture = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        const fbo = gl.createFramebuffer()!;
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);

        const target: WebGL1RenderTarget = { texture, fbo, width, height };
        this.targets.add(target);
        return target;
    }

    destroyRenderTarget(handle: unknown) {
        const target = handle as WebGL1RenderTarget;
        if (!target) return;
        this.targets.delete(target);
        if (this.currentTarget === target) this.currentTarget = null;
        this.gl.deleteFramebuffer(target.fbo);
        this.gl.deleteTexture(target.texture);
    }

    compileEffect(shader: EffectShader): CompiledEffect | null {
        if (!shader.glsl) return null;
        const gl = this.gl;
        const { layout, defaults } = resolveEffectLayout(shader);
        const program = this.buildProgram(GL_EFFECT_VERTEX, buildEffectFragment(shader.glsl));
        const compiled: WebGL1EffectProgram = {
            layout,
            defaults,
            program,
            pos: gl.getAttribLocation(program, "a_pos"),
            screenTexture: gl.getUniformLocation(program, "screenTexture"),
            screenSize: gl.getUniformLocation(program, "screenSize"),
            time: gl.getUniformLocation(program, "time"),
            userUniforms: new Map(),
        };
        this.useProgram(program);
        gl.uniform1i(compiled.screenTexture, 0);
        for (const name of Object.keys(layout)) {
            compiled.userUniforms.set(name, gl.getUniformLocation(program, name));
        }
        return compiled;
    }

    destroyEffect(compiled: unknown) {
        const effect = compiled as WebGL1EffectProgram;
        if (!effect) return;
        this.gl.deleteProgram(effect.program);
    }

    runEffect(compiled: unknown, source: unknown, target: unknown, uniforms: EffectUniforms, width: number, height: number, time: number) {
        const gl = this.gl;
        const effect = compiled as WebGL1EffectProgram;
        this.bindTarget((target as WebGL1RenderTarget | null | undefined) ?? null);
        // 特效不清目标：它要叠加在当前内容上面

        this.useProgram(effect.program);
        // source 是离屏渲染目标句柄，纹理在里面，不能直接 bind 句柄
        const sourceTexture = (source as WebGL1RenderTarget | null)?.texture;
        if (!sourceTexture) return;
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, sourceTexture);
        gl.uniform1i(effect.screenTexture, 0);
        gl.uniform2f(effect.screenSize, width, height);
        gl.uniform1f(effect.time, time);

        for (const [name, components] of Object.entries(effect.layout)) {
            const location = effect.userUniforms.get(name);
            if (!location) continue;
            const value = uniforms[name] ?? effect.defaults[name];
            if (value === undefined) continue;
            const numbers = typeof value === "number" ? [value] : value;
            if (components === 1) gl.uniform1f(location, numbers[0]!);
            else if (components === 2) gl.uniform2f(location, numbers[0]!, numbers[1]!);
            else gl.uniform4f(location, numbers[0]!, numbers[1]!, numbers[2]!, numbers[3]!);
        }

        gl.bindBuffer(gl.ARRAY_BUFFER, this.effectQuad);
        gl.vertexAttribPointer(effect.pos, 2, gl.FLOAT, false, 16, 0);
        gl.enableVertexAttribArray(effect.pos);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    /** 把离屏纹理原样贴到 target（画布会按 beginFrame 传的清屏色先清一次） */
    blit(source: unknown, target: unknown) {
        this.copyProgram ??= this.compileEffect(COPY_EFFECT_SHADER) as WebGL1EffectProgram | null;
        if (!this.copyProgram) return;
        this.runEffect(this.copyProgram, source, target, {}, this.frameWidth, this.frameHeight, 0);
    }

    /** 这一帧什么都没画时也要把画布清掉，否则会留着上一帧的画面 */
    clearFrame() {
        this.bindTarget(null);
    }

    endFrame() {
        this.currentTarget = null;
    }

    destroy() {
        const gl = this.gl;
        for (const texture of this.textures) gl.deleteTexture(texture);
        this.textures.clear();
        for (const target of this.targets) {
            gl.deleteFramebuffer(target.fbo);
            gl.deleteTexture(target.texture);
        }
        this.targets.clear();
        gl.deleteBuffer(this.quadBuffer);
        gl.deleteBuffer(this.instanceBuffer);
        gl.deleteBuffer(this.effectQuad);
        gl.deleteProgram(this.program);
    }
}

/* ========================================================================= *
 * WebGPU 后端
 *
 * 注意：这一节里 GPUDevice / GPUTexture 等对象故意写成 any。
 * 项目没有引入 `@webgpu/types`（TS 自带的 lib.dom 里还没有 WebGPU 类型），
 * 这是缺类型，不是因为 Node 端兼容 —— 浏览器侧的公开 API 都是强类型的。
 * ========================================================================= */

const WGSL = `
struct Uniforms {
    viewport: vec2f,
    zRange: vec2f,      // zMin, 1/(zMax-zMin)
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var tex: texture_2d<f32>;

struct VSOut {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
    @location(1) color: vec4f,
};

@vertex
fn vs(
    @location(0) corner: vec2f,
    @location(1) c01: vec4f,
    @location(2) c23: vec4f,
    @location(3) uv: vec4f,
    @location(4) color: vec4f,
    @location(5) zblend: vec2f,
) -> VSOut {
    var result: VSOut;
    let p = mix(mix(c01.xy, c01.zw, corner.x), mix(c23.xy, c23.zw, corner.x), corner.y);
    let ndc = vec2f(p.x / u.viewport.x * 2.0 - 1.0, 1.0 - p.y / u.viewport.y * 2.0);
    let z = clamp((zblend.x - u.zRange.x) * u.zRange.y, 0.0, 1.0);
    result.position = vec4f(ndc, z, 1.0);
    result.uv = mix(uv.xy, uv.zw, corner);
    result.color = color;
    return result;
}

@fragment
fn fs(frag: VSOut) -> @location(0) vec4f {
    // 纹理已预乘 alpha，只需要再乘 图元颜色 × globalAlpha
    let t = textureSample(tex, samp, frag.uv);
    let alpha = t.a * frag.color.a;
    return vec4f(t.rgb * frag.color.rgb * frag.color.a, alpha);
}
`;

/** 按 WGSL 的 uniform 布局规则排布 screenSize / time / 用户 uniform */
function buildWGSLUniformLayout(user: { name: string; components: 1 | 2 | 4 }[]) {
    const alignOf = (components: number) => (components === 1 ? 4 : components === 2 ? 8 : 16);
    const sizeOf = (components: number) => (components === 1 ? 4 : components === 2 ? 8 : 16);
    const typeOf = (components: number) => (components === 1 ? "f32" : components === 2 ? "vec2f" : "vec4f");

    const fields = ["screenSize: vec2f", "time: f32"];
    const offsets: Record<string, number> = {};
    let offset = 12;                      // screenSize@0 + time@8
    let maxAlign = 8;

    for (const { name, components } of user) {
        const align = alignOf(components);
        maxAlign = Math.max(maxAlign, align);
        offset = Math.ceil(offset / align) * align;
        offsets[name] = offset;
        fields.push(`${name}: ${typeOf(components)}`);
        offset += sizeOf(components);
    }

    return { fields, offsets, size: Math.ceil(offset / maxAlign) * maxAlign };
}

/** 把用户的 WGSL 片元主体包进完整模块，并注入 Phira 约定的内置变量 */
function wrapWGSL(body: string, fields: string[], prelude = ""): string {
    const aliases = fields.slice(2).map(field => `    let ${field.split(":")[0]!.trim()} = u.${field.split(":")[0]!.trim()};`).join("\n");
    return `
${prelude}
struct EffectUniforms {
    ${fields.join(",\n    ")},
};

@group(0) @binding(0) var<uniform> u: EffectUniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var tex: texture_2d<f32>;

struct VSOut {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VSOut {
    var corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
    var out: VSOut;
    let p = corners[vi];
    out.position = vec4f(p, 0.0, 1.0);
    // 采样的是离屏渲染目标，v=0 在底边，不做上下翻转
    out.uv = p * 0.5 + 0.5;
    return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
    let screenSize = u.screenSize;
    let time = u.time;
    let screenTexture = tex;
${aliases}
${body}
}
`;
}

class WebGPUBackend implements RenderBackend {
    readonly kind: BackendKind = "webgpu";

    /** 一帧里可能有多个 render pass（画布 + 若干离屏纹理），最后一起 submit */
    private readonly frames: { encoder: any; pass: any }[] = [];
    private active: { encoder: any; pass: any } | null = null;
    private activeView: any = null;
    private canvasView: any = null;
    private canvasOpened = false;
    private clearColor: RGBA | null = null;
    private readonly instanceState = { buffer: null as any, capacity: 0 };
    private readonly textures = new Set<any>();
    private readonly targets = new Set<any>();
    /**
     * 被本轮 pass 引用过、但已经被替换掉的 buffer。
     * WebGPU 不允许在 submit 之前 destroy 掉 command buffer 里用到的资源，
     * 否则整次提交作废（表现为掉一帧、画面闪一下），所以统一推迟到下一帧开头再删。
     */
    private readonly retiredBuffers: any[] = [];
    private white: any = null;
    /** 特效管线（按 EffectShader 缓存） */
    private readonly effectPrograms = new Map<EffectShader, any>();

    private constructor(
        private readonly device: any,
        private readonly context: any,
        private readonly pipelines: any[],
        private readonly uniformBuffer: any,
        private readonly uniformData: Float32Array,
        private readonly quadBuffer: any,
        private readonly bindGroupLayout: any,
        private readonly sampler: any,
        private readonly format: any,
    ) { }

    static async create(canvas: HTMLCanvasElement | OffscreenCanvas, device?: unknown): Promise<WebGPUBackend> {
        const gpu = (navigator as any).gpu;
        if (!gpu) throw new Error("[AnyGPUContext2D] 当前环境不支持 WebGPU");

        const dev = device ?? await (await gpu.requestAdapter()).requestDevice();
        const context = (canvas as any).getContext("webgpu");
        if (!context) throw new Error("[AnyGPUContext2D] 无法创建 WebGPU 画布上下文");

        const format = gpu.getPreferredCanvasFormat();
        context.configure({ device: dev, format, alphaMode: "premultiplied" });

        const module = dev.createShaderModule({ code: WGSL });

        const blendStates = [
            {   // source-over
                color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
                alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
            },
            {   // destination-out
                color: { srcFactor: "zero", dstFactor: "one-minus-src-alpha", operation: "add" },
                alpha: { srcFactor: "zero", dstFactor: "one-minus-src-alpha", operation: "add" },
            },
            {   // lighter
                color: { srcFactor: "one", dstFactor: "one", operation: "add" },
                alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
            },
        ];

        const pipelines = blendStates.map((blend) => dev.createRenderPipeline({
            layout: "auto",
            vertex: {
                module,
                entryPoint: "vs",
                buffers: [
                    {
                        arrayStride: 8,
                        stepMode: "vertex",
                        attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }],
                    },
                    {
                        arrayStride: INSTANCE_BYTES,
                        stepMode: "instance",
                        attributes: [
                            { shaderLocation: 1, offset: 0, format: "float32x4" },
                            { shaderLocation: 2, offset: 16, format: "float32x4" },
                            { shaderLocation: 3, offset: 32, format: "float32x4" },
                            { shaderLocation: 4, offset: 48, format: "float32x4" },
                            { shaderLocation: 5, offset: 64, format: "float32x2" },
                        ],
                    },
                ],
            },
            fragment: { module, entryPoint: "fs", targets: [{ format, blend }] },
            primitive: { topology: "triangle-strip" },
        }));

        const uniformBuffer = dev.createBuffer({ size: 16, usage: 0x40 | 0x8 }); // UNIFORM | COPY_DST
        const uniformData = new Float32Array(4);

        const quadBuffer = dev.createBuffer({
            size: 32,
            usage: 0x20 | 0x8,   // VERTEX | COPY_DST
        });
        dev.queue.writeBuffer(quadBuffer, 0, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]));

        const sampler = dev.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });
        const bindGroupLayout = pipelines[0]!.getBindGroupLayout(0);

        const backend = new WebGPUBackend(dev, context, pipelines, uniformBuffer, uniformData, quadBuffer, bindGroupLayout, sampler, format);

        // 1x1 白纹理
        const whiteTexture = dev.createTexture({
            size: [1, 1, 1],
            format: "rgba8unorm",
            usage: 0x10 | 0x4 | 0x2,   // TEXTURE_BINDING | COPY_DST | RENDER_ATTACHMENT
        });
        dev.queue.writeTexture({ texture: whiteTexture }, new Uint8Array([255, 255, 255, 255]), { bytesPerRow: 4 }, [1, 1, 1]);
        backend.white = {
            texture: whiteTexture,
            group: dev.createBindGroup({
                layout: bindGroupLayout,
                entries: [
                    { binding: 0, resource: { buffer: uniformBuffer } },
                    { binding: 1, resource: sampler },
                    { binding: 2, resource: whiteTexture.createView() },
                ],
            }),
        };
        backend.textures.add(whiteTexture);

        return backend;
    }

    createTexture(source: TextureSource, width: number, height: number) {
        const device = this.device;
        const texture = device.createTexture({
            size: [Math.max(1, width), Math.max(1, height), 1],
            format: "rgba8unorm",
            usage: 0x10 | 0x4 | 0x2,
        });
        // 与 WebGL 端保持一致：统一按预乘 alpha 上传
        device.queue.copyExternalImageToTexture(
            { source },
            { texture, premultipliedAlpha: true },
            [Math.max(1, width), Math.max(1, height)],
        );
        const group = device.createBindGroup({
            layout: this.bindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.uniformBuffer } },
                { binding: 1, resource: this.sampler },
                { binding: 2, resource: texture.createView() },
            ],
        });
        const handle = { texture, group };
        this.textures.add(handle);
        return handle;
    }

    destroyTexture(handle: unknown) {
        if (!handle) return;
        const textureHandle = handle as { texture: any };
        this.textures.delete(textureHandle);
        textureHandle.texture.destroy();
    }

    beginFrame(width: number, height: number, zRange: [number, number], clear: RGBA | null) {
        const device = this.device;

        // 上一帧已经 submit 完了，现在销毁退役的 buffer 才是安全的
        this.sweepRetiredBuffers();

        const span = zRange[1] - zRange[0];
        this.uniformData[0] = width;
        this.uniformData[1] = height;
        this.uniformData[2] = zRange[0];
        this.uniformData[3] = span === 0 ? 0 : 1 / span;
        device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);

        // pass 延迟到真正开始画的时候再开：有特效时整帧都画在离屏纹理上，
        // 最后才贴回画布，画布的 clear 也顺延到那一刻。
        this.frames.length = 0;
        this.active = null;
        this.activeView = null;
        this.canvasView = null;
        this.canvasOpened = false;
        this.clearColor = clear;
    }

    /** 结束当前 pass，开一个画到 view 上的新 pass */
    private openPass(view: any, clear: boolean) {
        if (this.active) this.active.pass.end();
        const encoder = this.device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
            colorAttachments: [{
                view,
                clearValue: this.clearColor
                    ? { r: this.clearColor[0], g: this.clearColor[1], b: this.clearColor[2], a: this.clearColor[3] }
                    : { r: 0, g: 0, b: 0, a: 0 },
                loadOp: clear ? "clear" : "load",
                storeOp: "store",
            }],
        });
        pass.setVertexBuffer(0, this.quadBuffer);
        if (this.instanceState.buffer) pass.setVertexBuffer(1, this.instanceState.buffer);
        this.frames.push({ encoder, pass });
        this.active = { encoder, pass };
        this.activeView = view;
    }

    /** 确保当前 pass 画在 target 上；target 为 null 表示画布 */
    private bindTarget(target: any) {
        if (target) {
            // 不清屏：需要清的时候走 clearRenderTarget，
            // 否则整帧累积目标会在特效链跑完回到它的时候被误清
            if (this.activeView !== target.view) this.openPass(target.view, false);
            return;
        }
        if (this.canvasOpened) return;
        this.canvasOpened = true;
        if (!this.canvasView) this.canvasView = this.context.getCurrentTexture().createView();
        this.openPass(this.canvasView, this.clearColor !== null);
    }

    /** 把某块离屏纹理清成全透明 */
    clearRenderTarget(handle: unknown) {
        const target = handle as { view: any } | null;
        if (!target) return;
        this.openPass(target.view, true);
    }

    uploadInstances(data: Float32Array, count: number) {
        const needed = Math.max(INSTANCE_BYTES * count, INSTANCE_BYTES * 64);
        if (!this.instanceState.buffer || this.instanceState.capacity < needed) {
            // 旧 buffer 可能已经被本帧的 pass 引用过，只能先退役，等下一帧开头再销毁
            if (this.instanceState.buffer) this.retiredBuffers.push(this.instanceState.buffer);
            // 留一倍余量，避免实例数一涨就重建
            const size = Math.max(needed * 2, INSTANCE_BYTES * 256);
            this.instanceState.buffer = this.device.createBuffer({ size, usage: 0x20 | 0x8 });
            this.instanceState.capacity = size;
            // 已经开出来的 pass 也要重新指向新 buffer
            for (const frame of this.frames) frame.pass.setVertexBuffer(1, this.instanceState.buffer);
        }
        this.device.queue.writeBuffer(this.instanceState.buffer, 0, data, 0, count * INSTANCE_FLOATS);
    }

    private sweepRetiredBuffers() {
        if (this.retiredBuffers.length === 0) return;
        for (const buffer of this.retiredBuffers) buffer.destroy();
        this.retiredBuffers.length = 0;
    }

    drawInstances(texture: unknown, blend: number, first: number, count: number, target?: unknown) {
        this.bindTarget(target ?? null);
        const pass = this.active!.pass;
        const handle = texture as { group: unknown } | null;
        pass.setPipeline(this.pipelines[blend] ?? this.pipelines[0]);
        pass.setBindGroup(0, handle ? handle.group : this.white.group);
        pass.draw(4, count, 0, first);
    }

    createRenderTarget(width: number, height: number) {
        const texture = this.device.createTexture({
            size: [Math.max(1, width), Math.max(1, height), 1],
            format: "rgba8unorm",
            usage: 0x10 | 0x4 | 0x2,   // TEXTURE_BINDING | RENDER_ATTACHMENT | COPY_DST
        });
        const handle = { texture, view: texture.createView(), width, height };
        this.targets.add(handle);
        return handle;
    }

    destroyRenderTarget(handle: unknown) {
        const target = handle as { texture: any };
        if (!target) return;
        this.targets.delete(target);
        target.texture.destroy();
    }

    compileEffect(shader: EffectShader): CompiledEffect | null {
        if (!shader.wgsl) return null;
        const cached = this.effectPrograms.get(shader);
        if (cached) return cached;

        const { layout, defaults } = resolveEffectLayout(shader);
        const names = Object.keys(layout);
        const { fields, offsets, size } = buildWGSLUniformLayout(names.map(name => ({ name, components: layout[name]! })));

        const module = this.device.createShaderModule({ code: wrapWGSL(shader.wgsl, fields, shader.wgslPrelude) });
        const pipeline = this.device.createRenderPipeline({
            layout: "auto",
            vertex: { module, entryPoint: "vs" },
            fragment: { module, entryPoint: "fs", targets: [{ format: this.format, blend: {
                color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
                alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
            } }] },
            primitive: { topology: "triangle-list" },
        });

        const compiled = {
            layout,
            defaults,
            offsets,
            size,
            data: new Float32Array(size / 4),
            pipeline,
            bindGroupLayout: pipeline.getBindGroupLayout(0),
            buffer: this.device.createBuffer({ size, usage: 0x40 | 0x8 }),   // UNIFORM | COPY_DST
        };
        this.effectPrograms.set(shader, compiled);
        return compiled;
    }

    destroyEffect(compiled: unknown) {
        const effect = compiled as { buffer: any };
        if (!effect) return;
        effect.buffer.destroy();
    }

    runEffect(compiled: unknown, source: unknown, target: unknown, uniforms: EffectUniforms, width: number, height: number, time: number) {
        const effect = compiled as {
            layout: Record<string, 1 | 2 | 4>;
            defaults: EffectUniforms;
            offsets: Record<string, number>;
            data: Float32Array;
            pipeline: any;
            bindGroupLayout: any;
            buffer: any;
        };
        const sourceHandle = source as { view: any };

        // uniform 打包：screenSize + time 在最前面，随后是用户 uniform（顺序同 layout）
        effect.data[0] = width;
        effect.data[1] = height;
        effect.data[2] = time;
        for (const [name, components] of Object.entries(effect.layout)) {
            // 谱面没给这个变量时用着色器里声明的默认值
            const value = uniforms[name] ?? effect.defaults[name];
            if (value === undefined) continue;
            const offset = effect.offsets[name]! / 4;
            const numbers = typeof value === "number" ? [value] : value;
            for (let i = 0; i < components; i++) effect.data[offset + i] = numbers[i] ?? 0;
        }
        this.device.queue.writeBuffer(effect.buffer, 0, effect.data);

        this.bindTarget(target ?? null);
        const pass = this.active!.pass;
        pass.setPipeline(effect.pipeline);
        pass.setBindGroup(0, this.device.createBindGroup({
            layout: effect.bindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: effect.buffer } },
                { binding: 1, resource: this.sampler },
                { binding: 2, resource: sourceHandle.view },
            ],
        }));
        pass.draw(3);
    }

    /** 把离屏纹理原样贴到 target（null = 画布） */
    blit(source: unknown, target: unknown) {
        const compiled = this.compileEffect(COPY_EFFECT_SHADER);
        if (compiled) {
            this.runEffect(compiled, source, target, {}, this.uniformData[0], this.uniformData[1], 0);
        }
    }

    clearFrame() {
        this.bindTarget(null);
    }

    endFrame() {
        if (this.active) {
            this.active.pass.end();
            this.active = null;
            this.activeView = null;
        }
        if (this.frames.length === 0) return;
        const encoders = this.frames.map(frame => frame.encoder.finish());
        this.frames.length = 0;
        this.device.queue.submit(encoders);
    }

    destroy() {
        this.sweepRetiredBuffers();
        for (const handle of this.textures) handle.texture?.destroy();
        this.textures.clear();
        for (const target of this.targets) target.texture.destroy();
        this.targets.clear();
        for (const effect of this.effectPrograms.values()) effect.buffer.destroy();
        this.effectPrograms.clear();
        this.instanceState.buffer?.destroy();
        this.uniformBuffer.destroy?.();
        this.quadBuffer.destroy?.();
    }
}

/* ========================================================================= *
 * 图层
 * ========================================================================= */

interface LayerState {
    m: Matrix33;
    z: number;
    tint: RGB;
    alpha: number;
    fill: RGBA;
    stroke: RGBA;
    lineWidth: number;
    lineCap: CanvasLineCap;
    lineJoin: CanvasLineJoin;
    lineDash: number[];
    lineDashOffset: number;
    composite: string;
    blend: number;
    font: string;
    textAlign: CanvasTextAlign;
    textBaseline: CanvasTextBaseline;
}

/**
 * 一个图层。所有绘制先被记录成实例，z 默认等于图层创建时给的 z，
 * 也可以随时通过 `ctx.z = ...` 改成别的 z（改完之后的绘制才生效）。
 */
export class LayerContext2D {
    /** @internal */
    readonly buffer = new InstanceBuffer();

    private state: LayerState;
    private stack: LayerState[] = [];

    private path: { pts: Point[]; closed: boolean }[] = [];
    private cur: Point | null = null;
    private start: Point | null = null;

    constructor(private readonly owner: AnyGPUContext2D, z = 0) {
        this.state = {
            m: identity,
            z,
            tint: [255, 255, 255],
            alpha: 1,
            fill: [0, 0, 0, 1],
            stroke: [0, 0, 0, 1],
            lineWidth: 1,
            lineCap: "butt",
            lineJoin: "miter",
            lineDash: [],
            lineDashOffset: 0,
            composite: "source-over",
            blend: BLEND_SOURCE_OVER,
            font: "10px sans-serif",
            textAlign: "start",
            textBaseline: "alphabetic",
        };
    }

    /* ------------------------------ 状态 ------------------------------ */

    get z(): number { return this.state.z; }
    set z(value: number) { this.state.z = value; }

    /** 0..255 的三元组，和纹理颜色相乘 */
    get tint(): RGB { return this.state.tint; }
    set tint(value: RGB) { this.state.tint = value; }

    get globalAlpha(): number { return this.state.alpha; }
    set globalAlpha(value: number) { this.state.alpha = Math.min(1, Math.max(0, value)); }

    get globalCompositeOperation(): string { return this.state.composite; }
    set globalCompositeOperation(value: string) {
        this.state.composite = value;
        this.state.blend = value === "destination-out" ? BLEND_DESTINATION_OUT
            : value === "lighter" ? BLEND_LIGHTER
                : BLEND_SOURCE_OVER;
    }

    get fillStyle(): RGBA { return this.state.fill; }
    set fillStyle(value: ColorLike) { this.state.fill = parseColor(value); }

    get strokeStyle(): RGBA { return this.state.stroke; }
    set strokeStyle(value: ColorLike) { this.state.stroke = parseColor(value); }

    get lineWidth(): number { return this.state.lineWidth; }
    set lineWidth(value: number) { this.state.lineWidth = value; }

    get lineCap(): CanvasLineCap { return this.state.lineCap; }
    set lineCap(value: CanvasLineCap) { this.state.lineCap = value; }

    get lineJoin(): CanvasLineJoin { return this.state.lineJoin; }
    set lineJoin(value: CanvasLineJoin) { this.state.lineJoin = value; }

    setLineDash(segments: number[]) {
        this.state.lineDash = segments.length ? [...segments] : [];
    }

    getLineDash(): number[] {
        return [...this.state.lineDash];
    }

    get lineDashOffset(): number { return this.state.lineDashOffset; }
    set lineDashOffset(value: number) { this.state.lineDashOffset = value; }

    get font(): string { return this.state.font; }
    set font(value: string) { this.state.font = value; }

    get textAlign(): CanvasTextAlign { return this.state.textAlign; }
    set textAlign(value: CanvasTextAlign) { this.state.textAlign = value; }

    get textBaseline(): CanvasTextBaseline { return this.state.textBaseline; }
    set textBaseline(value: CanvasTextBaseline) { this.state.textBaseline = value; }

    save() {
        const s = this.state;
        this.stack.push({
            ...s,
            tint: [s.tint[0], s.tint[1], s.tint[2]],
            lineDash: [...s.lineDash],
            m: s.m,
        });
    }

    restore() {
        const previous = this.stack.pop();
        if (previous) this.state = previous;
    }

    /* ----------------------------- 变换 ------------------------------ */

    getTransform(): Matrix33 { return this.state.m; }
    setTransform(m: Matrix33) { this.state.m = m; }
    resetTransform() { this.state.m = identity; }

    translate(x: number, y: number) { this.state.m = this.state.m.translate(x, y); }
    rotate(angle: number) { this.state.m = this.state.m.rotate(angle); }
    scale(x: number, y: number) { this.state.m = this.state.m.scale(x, y); }
    transform(m: Matrix33) { this.state.m = this.state.m.transform(m); }

    /** 当前变换的平均缩放，用来把线宽 / 半径换算到设备空间 */
    private scaleFactor() {
        const m = this.state.m;
        return Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1;
    }

    /* ------------------------------ 路径 ------------------------------ */

    beginPath() {
        this.path = [];
        this.cur = null;
        this.start = null;
    }

    closePath() {
        if (this.cur) {
            const sub = this.subPath();
            sub.closed = true;
            this.cur = this.start;
        }
    }

    moveTo(x: number, y: number) {
        const p = this.toDevice(x, y);
        const sub = { pts: [p], closed: false };
        this.path.push(sub);
        this.cur = p;
        this.start = p;
    }

    lineTo(x: number, y: number) {
        const p = this.toDevice(x, y);
        if (!this.cur) { this.moveTo(x, y); return; }
        this.subPath().pts.push(p);
        this.cur = p;
    }

    quadraticCurveTo(cx: number, cy: number, x: number, y: number) {
        const c = this.toDevice(cx, cy);
        const p = this.toDevice(x, y);
        const from = this.cur;
        if (!from) { this.moveTo(x, y); return; }
        const c1: Point = [from[0] + (2 / 3) * (c[0] - from[0]), from[1] + (2 / 3) * (c[1] - from[1])];
        const c2: Point = [p[0] + (2 / 3) * (c[0] - p[0]), p[1] + (2 / 3) * (c[1] - p[1])];
        this.cubicTo(from, c1, c2, p);
    }

    bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number) {
        const from = this.cur;
        if (!from) { this.moveTo(x, y); return; }
        const c1 = this.toDevice(c1x, c1y);
        const c2 = this.toDevice(c2x, c2y);
        const p = this.toDevice(x, y);
        this.cubicTo(from, c1, c2, p);
    }

    private cubicTo(p0: Point, c1: Point, c2: Point, p3: Point) {
        const length = Math.hypot(c1[0] - p0[0], c1[1] - p0[1])
            + Math.hypot(c2[0] - c1[0], c2[1] - c1[1])
            + Math.hypot(p3[0] - c2[0], p3[1] - c2[1]);
        const segments = Math.min(96, Math.max(4, Math.ceil(length / 4)));
        const pts = this.subPath().pts;
        for (let i = 1; i <= segments; i++) {
            const t = i / segments;
            const mt = 1 - t;
            const a = mt * mt * mt;
            const b = 3 * mt * mt * t;
            const c = 3 * mt * t * t;
            const d = t * t * t;
            pts.push([
                a * p0[0] + b * c1[0] + c * c2[0] + d * p3[0],
                a * p0[1] + b * c1[1] + c * c2[1] + d * p3[1],
            ]);
        }
        this.cur = p3;
    }

    arc(x: number, y: number, radius: number, startAngle: number, endAngle: number, counterclockwise = false) {
        this.ellipse(x, y, radius, radius, 0, startAngle, endAngle, counterclockwise);
    }

    ellipse(x: number, y: number, radiusX: number, radiusY: number, rotation: number, startAngle: number, endAngle: number, counterclockwise = false) {
        const full = Math.abs(endAngle - startAngle) >= Math.PI * 2 - EPS;
        let from = startAngle;
        let to = endAngle;
        if (full) {
            to = from + (counterclockwise ? -1 : 1) * Math.PI * 2;
        } else if (counterclockwise && to > from) {
            to -= Math.PI * 2;
        } else if (!counterclockwise && to < from) {
            to += Math.PI * 2;
        }

        const segments = Math.min(256, Math.max(4,
            Math.ceil(Math.abs(to - from) * Math.max(radiusX, radiusY) * this.scaleFactor() / 4)));
        const cos = Math.cos(rotation);
        const sin = Math.sin(rotation);

        const hasCurrent = this.cur !== null;
        for (let i = 0; i <= segments; i++) {
            const t = from + (to - from) * (i / segments);
            const ex = radiusX * Math.cos(t);
            const ey = radiusY * Math.sin(t);
            const lx = x + ex * cos - ey * sin;
            const ly = y + ex * sin + ey * cos;
            const p = this.toDevice(lx, ly);
            if (i === 0 && !hasCurrent) {
                this.path.push({ pts: [p], closed: false });
                this.start = p;
            } else {
                this.subPath().pts.push(p);
            }
            this.cur = p;
        }
    }

    arcTo(x1: number, y1: number, x2: number, y2: number, radius: number) {
        const p0 = this.cur;
        if (!p0) { this.moveTo(x1, y1); return; }

        const corner = this.toDevice(x1, y1);
        const next = this.toDevice(x2, y2);
        const r = radius * this.scaleFactor();

        const d1x = p0[0] - corner[0], d1y = p0[1] - corner[1];
        const d2x = next[0] - corner[0], d2y = next[1] - corner[1];
        const l1 = Math.hypot(d1x, d1y);
        const l2 = Math.hypot(d2x, d2y);
        if (l1 < EPS || l2 < EPS || r < EPS) { this.lineTo(x1, y1); return; }

        const u1x = d1x / l1, u1y = d1y / l1;
        const u2x = d2x / l2, u2y = d2y / l2;
        const theta = Math.acos(Math.max(-1, Math.min(1, u1x * u2x + u1y * u2y)));
        if (theta < EPS || Math.abs(theta - Math.PI) < EPS) { this.lineTo(x1, y1); return; }

        const dist = Math.min(r / Math.tan(theta / 2), l1 * 0.5, l2 * 0.5);
        const tangent1: Point = [corner[0] + u1x * dist, corner[1] + u1y * dist];
        const tangent2: Point = [corner[0] + u2x * dist, corner[1] + u2y * dist];

        // 圆心在角平分线上
        const bx = u1x + u2x, by = u1y + u2y;
        const bl = Math.hypot(bx, by) || 1;
        const centerDist = Math.hypot(r, dist);
        const center: Point = [corner[0] + (bx / bl) * centerDist, corner[1] + (by / bl) * centerDist];

        let a0 = Math.atan2(tangent1[1] - center[1], tangent1[0] - center[0]);
        let a1 = Math.atan2(tangent2[1] - center[1], tangent2[0] - center[0]);
        let delta = a1 - a0;
        while (delta > Math.PI) delta -= Math.PI * 2;
        while (delta < -Math.PI) delta += Math.PI * 2;

        const segments = Math.min(64, Math.max(4, Math.ceil(Math.abs(delta) * r / 4)));
        const pts = this.subPath().pts;
        for (let i = 0; i <= segments; i++) {
            const a = a0 + delta * (i / segments);
            pts.push([center[0] + Math.cos(a) * r, center[1] + Math.sin(a) * r]);
        }
        this.cur = tangent2;
    }

    rect(x: number, y: number, width: number, height: number) {
        const a = this.toDevice(x, y);
        const b = this.toDevice(x + width, y);
        const c = this.toDevice(x + width, y + height);
        const d = this.toDevice(x, y + height);
        this.path.push({ pts: [a, b, c, d], closed: true });
        this.cur = a;
        this.start = a;
    }

    roundRect(x: number, y: number, width: number, height: number, radii: number | number[] = 0) {
        const values = Array.isArray(radii) ? radii : [radii];
        const pick = (i: number) => Math.max(0, Math.min(
            Math.abs(width) / 2,
            Math.abs(height) / 2,
            values[Math.min(i, values.length - 1)] ?? 0,
        ));
        const [tl, tr, br, bl] = [pick(0), pick(1), pick(2), pick(3)];
        // 统一成正方向的矩形
        const nx = width < 0 ? x + width : x;
        const ny = height < 0 ? y + height : y;
        const w = Math.abs(width), h = Math.abs(height);

        const pts: Point[] = [];
        const corner = (cx: number, cy: number, radius: number, from: number) => {
            const segments = radius > EPS ? Math.max(2, Math.ceil(radius / 2)) : 1;
            for (let i = 0; i <= segments; i++) {
                const a = from + (Math.PI / 2) * (i / segments);
                pts.push(this.toDevice(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius));
            }
        };

        corner(nx + w - tr, ny + tr, tr, -Math.PI / 2);
        corner(nx + w - br, ny + h - br, br, 0);
        corner(nx + bl, ny + h - bl, bl, Math.PI / 2);
        corner(nx + tl, ny + tl, tl, Math.PI);

        this.path.push({ pts, closed: true });
        this.cur = pts[0] ?? null;
        this.start = this.cur;
    }

    private subPath() {
        let sub = this.path[this.path.length - 1];
        if (!sub) {
            sub = { pts: [], closed: false };
            this.path.push(sub);
        }
        return sub;
    }

    private toDevice(x: number, y: number): Point {
        const m = this.state.m;
        return [m.xmul(x, y), m.ymul(x, y)];
    }

    /* ------------------------------ 绘制 ------------------------------ */

    private paint(color: RGBA): RGBA {
        const t = this.state.tint;
        const a = this.state.alpha;
        return [
            color[0] * (t[0] / 255),
            color[1] * (t[1] / 255),
            color[2] * (t[2] / 255),
            color[3] * a,
        ];
    }

    /** 写一个实例（TL, TR, BR, BL） */
    private emitQuad(
        x0: number, y0: number, x1: number, y1: number,
        x2: number, y2: number, x3: number, y3: number,
        u0: number, v0: number, u1: number, v1: number,
        color: RGBA, texture: Texture | null,
    ) {
        const buffer = this.buffer;
        const offset = buffer.alloc(texture);
        const f = buffer.floats;
        f[offset + 0] = x0; f[offset + 1] = y0;
        f[offset + 2] = x1; f[offset + 3] = y1;
        f[offset + 4] = x3; f[offset + 5] = y3;
        f[offset + 6] = x2; f[offset + 7] = y2;
        f[offset + OFFSET_UV + 0] = u0; f[offset + OFFSET_UV + 1] = v0;
        f[offset + OFFSET_UV + 2] = u1; f[offset + OFFSET_UV + 3] = v1;
        f[offset + OFFSET_COLOR + 0] = color[0];
        f[offset + OFFSET_COLOR + 1] = color[1];
        f[offset + OFFSET_COLOR + 2] = color[2];
        f[offset + OFFSET_COLOR + 3] = color[3];
        f[offset + OFFSET_Z] = this.state.z;
        f[offset + OFFSET_BLEND] = this.state.blend;
    }

    /** 三角形等于「BR 与 BL 重合」的四边形 */
    private emitTriangle(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, color: RGBA) {
        this.emitQuad(x0, y0, x1, y1, x2, y2, x2, y2, 0.5, 0.5, 0.5, 0.5, color, null);
    }

    fill() {
        const color = this.paint(this.state.fill);
        for (const sub of this.path) {
            if (sub.pts.length < 3) continue;
            for (const tri of triangulate(sub.pts)) {
                this.emitTriangle(tri[0]![0], tri[0]![1], tri[1]![0], tri[1]![1], tri[2]![0], tri[2]![1], color);
            }
        }
    }

    /** 描一条折线（设备坐标），带虚线处理 */
    private strokePolyline(points: Point[], closed: boolean, color: RGBA, halfWidth: number) {
        const emit: QuadEmitter = (x0, y0, x1, y1, x2, y2, x3, y3) => {
            this.emitQuad(x0, y0, x1, y1, x2, y2, x3, y3, 0.5, 0.5, 0.5, 0.5, color, null);
        };
        const dash = this.state.lineDash;
        if (dash.length > 0) {
            for (const run of dashPolyline(points, closed, dash, this.state.lineDashOffset)) {
                buildStroke(run, false, halfWidth, "butt", emit);
            }
        } else {
            buildStroke(points, closed, halfWidth, this.state.lineCap, emit);
        }
    }

    stroke() {
        const color = this.paint(this.state.stroke);
        const halfWidth = Math.max(this.state.lineWidth * this.scaleFactor(), 0) / 2;
        if (halfWidth <= 0) return;
        for (const sub of this.path) {
            if (sub.pts.length === 0) continue;
            this.strokePolyline(sub.pts, sub.closed, color, halfWidth);
        }
    }

    fillRect(x: number, y: number, width: number, height: number) {
        const m = this.state.m;
        const x0 = x, y0 = y, x1 = x + width, y1 = y + height;
        const color = this.paint(this.state.fill);
        this.emitQuad(
            m.xmul(x0, y0), m.ymul(x0, y0),
            m.xmul(x1, y0), m.ymul(x1, y0),
            m.xmul(x1, y1), m.ymul(x1, y1),
            m.xmul(x0, y1), m.ymul(x0, y1),
            0.5, 0.5, 0.5, 0.5, color, null,
        );
    }

    strokeRect(x: number, y: number, width: number, height: number) {
        const a = this.toDevice(x, y);
        const b = this.toDevice(x + width, y);
        const c = this.toDevice(x + width, y + height);
        const d = this.toDevice(x, y + height);
        const color = this.paint(this.state.stroke);
        const halfWidth = Math.max(this.state.lineWidth * this.scaleFactor(), 0) / 2;
        if (halfWidth <= 0) return;
        this.strokePolyline([a, b, c, d], true, color, halfWidth);
    }

    clearRect(x: number, y: number, width: number, height: number) {
        const m = this.state.m;
        const x0 = x, y0 = y, x1 = x + width, y1 = y + height;
        const savedBlend = this.state.blend;
        this.state.blend = BLEND_DESTINATION_OUT;   // dst *= 1 - src.a
        this.emitQuad(
            m.xmul(x0, y0), m.ymul(x0, y0),
            m.xmul(x1, y0), m.ymul(x1, y0),
            m.xmul(x1, y1), m.ymul(x1, y1),
            m.xmul(x0, y1), m.ymul(x0, y1),
            0.5, 0.5, 0.5, 0.5, [1, 1, 1, 1], null,
        );
        this.state.blend = savedBlend;
    }

    drawImage(image: TexImageSource, ...args: number[]) {
        const texture = this.owner.getTexture(image);
        let sx = 0, sy = 0, sw = texture.width, sh = texture.height;
        let dx = 0, dy = 0, dw = sw, dh = sh;

        if (args.length === 2) {
            [dx, dy] = args as [number, number];
        } else if (args.length === 4) {
            [dx, dy, dw, dh] = args as [number, number, number, number];
        } else if (args.length === 8) {
            [sx, sy, sw, sh, dx, dy, dw, dh] = args as [number, number, number, number, number, number, number, number];
        } else {
            return;
        }

        const tw = texture.width || 1;
        const th = texture.height || 1;
        const u0 = sx / tw, v0 = sy / th;
        const u1 = (sx + sw) / tw, v1 = (sy + sh) / th;

        const m = this.state.m;
        const color = this.paint([1, 1, 1, 1]);
        this.emitQuad(
            m.xmul(dx, dy), m.ymul(dx, dy),
            m.xmul(dx + dw, dy), m.ymul(dx + dw, dy),
            m.xmul(dx + dw, dy + dh), m.ymul(dx + dw, dy + dh),
            m.xmul(dx, dy + dh), m.ymul(dx, dy + dh),
            u0, v0, u1, v1, color, texture,
        );
    }

    measureText(text: string) {
        return this.owner.measureText(text, this.state.font);
    }

    fillText(text: string, x: number, y: number, maxWidth?: number) {
        this.drawText(text, x, y, false, maxWidth);
    }

    strokeText(text: string, x: number, y: number, maxWidth?: number) {
        this.drawText(text, x, y, true, maxWidth);
    }

    private drawText(text: string, x: number, y: number, stroke: boolean, maxWidth?: number) {
        if (!text) return;
        if (maxWidth !== undefined && maxWidth > 0) {
            const width = this.measureText(text).width;
            if (width > maxWidth) text = this.fitText(text, maxWidth);
        }

        const layout = this.owner.layoutText(
            text, this.state.font, stroke, this.state.lineWidth, this.scaleFactor(),
        );
        const color = this.paint(stroke ? this.state.stroke : this.state.fill);
        const scale = layout.scale;
        const align = this.state.textAlign;
        const baseline = this.state.textBaseline;

        const alignShift = align === "center" ? layout.width / 2
            : (align === "right" || align === "end") ? layout.width
                : 0;
        const ascentShift = baseline === "top" || baseline === "hanging" ? 0
            : baseline === "middle" ? (layout.ascent + layout.descent) / 2
                : baseline === "bottom" || baseline === "ideographic" ? layout.ascent + layout.descent
                    : layout.ascent;

        const left = x - alignShift - layout.pad / scale;
        const top = y - layout.pad / scale - ascentShift;
        const width = layout.textureWidth / scale;
        const height = layout.textureHeight / scale;

        const m = this.state.m;
        this.emitQuad(
            m.xmul(left, top), m.ymul(left, top),
            m.xmul(left + width, top), m.ymul(left + width, top),
            m.xmul(left + width, top + height), m.ymul(left + width, top + height),
            m.xmul(left, top + height), m.ymul(left, top + height),
            0, 0, 1, 1, color, layout.texture,
        );
    }

    private fitText(text: string, maxWidth: number): string {
        let current = text;
        while (current.length > 1 && this.measureText(current).width > maxWidth) {
            current = current.slice(0, -1);
        }
        return current;
    }

    /* ------------------------------ 管理 ------------------------------ */

    /** 丢弃本帧记录到的绘制（不影响状态机） */
    reset() {
        this.buffer.reset();
        this.path = [];
        this.cur = null;
        this.start = null;
    }
}

/* ========================================================================= *
 * 上下文
 * ========================================================================= */

export class AnyGPUContext2D {
    private readonly backend: RenderBackend;
    private readonly textureCache = new WeakMap<object, Texture>();
    private readonly ownedTextures = new Set<Texture>();
    private readonly textCache = new Map<string, TextLayout>();
    private readonly textureGraveyard: Texture[] = [];
    private readonly layerList: LayerContext2D[] = [];

    private combinedScratch: Float32Array = new Float32Array(0);
    private sortedScratch: Float32Array = new Float32Array(0);
    /** 与 sortedScratch 一一对应的纹理引用 */
    private sortedTextures: (Texture | null)[] = [];

    private textCanvas: AnyCanvas2D | null = null;
    private textContext: AnyCanvas2DContext | null = null;
    /** VideoFrame → canvas 的复用缓冲（WebGL 1 用） */
    private videoScratch: { canvas: AnyCanvas2D; ctx: AnyCanvas2DContext } | null = null;

    /* ------------------------------ 特效 ------------------------------ */

    /** 已注册的着色器，按名字索引 */
    private readonly shaderRegistry = new Map<string, EffectShader>();
    /** 已编译的着色器（按 EffectShader 对象缓存，避免每帧重新编译） */
    private readonly compiledShaders = new Map<EffectShader, CompiledEffect>();
    /** 本帧的特效区间，按 from 升序、互不重叠 */
    private effectRanges: EffectRange[] = [];
    /** 后处理用的离屏纹理：[0] 是整帧的累积目标，其余是特效链的中间结果 */
    private scratchTargets: unknown[] | null = null;
    /** 本帧跑过的特效着色器趟数 */
    private effectPasses = 0;

    private constructor(
        readonly canvas: HTMLCanvasElement | OffscreenCanvas,
        backend: RenderBackend,
        private range: [number, number],
        public clearColor: RGBA | null,
    ) {
        this.backend = backend;
    }

    static async create(options: AnyGPUContext2DOptions): Promise<AnyGPUContext2D> {
        const canvas = options.canvas;
        const preferred = options.backend ?? "auto";
        const range: [number, number] = options.zRange ?? [0, 1];
        const clear = options.clearColor === undefined ? [0, 0, 0, 0] as RGBA
            : options.clearColor === null ? null
                : parseColor(options.clearColor);

        let backend: RenderBackend | null = null;

        if (preferred === "webgpu" || preferred === "auto") {
            try {
                backend = await WebGPUBackend.create(canvas, options.device);
            } catch (error) {
                if (preferred === "webgpu") throw error;
                backend = null;
            }
        }
        if (!backend) backend = new WebGL1Backend(canvas);

        return new AnyGPUContext2D(canvas, backend, range, clear);
    }

    /**
     * 同步创建 WebGL 1 上下文。
     * WebGPU 需要 await 拿 device，所以只能走 `create()`。
     */
    static createWebGL1(options: AnyGPUContext2DOptions): AnyGPUContext2D {
        const canvas = options.canvas;
        const range: [number, number] = options.zRange ?? [0, 1];
        const clear = options.clearColor === undefined ? [0, 0, 0, 0] as RGBA
            : options.clearColor === null ? null
                : parseColor(options.clearColor);
        return new AnyGPUContext2D(canvas, new WebGL1Backend(canvas), range, clear);
    }

    get kind(): BackendKind { return this.backend.kind; }
    get width() { return this.canvas.width; }
    get height() { return this.canvas.height; }

    get zRange(): [number, number] { return this.range; }
    set zRange(value: [number, number]) { this.range = [value[0], value[1]]; }

    get layers(): readonly LayerContext2D[] { return this.layerList; }

    resize(width: number, height: number) {
        this.canvas.width = width;
        this.canvas.height = height;
    }

    createLayer(z = 0): LayerContext2D {
        const layer = new LayerContext2D(this, z);
        this.layerList.push(layer);
        return layer;
    }

    removeLayer(layer: LayerContext2D) {
        const index = this.layerList.indexOf(layer);
        if (index >= 0) this.layerList.splice(index, 1);
    }

    /* ------------------------- 特效：注册与区间 ------------------------- */

    /** 注册一个特效着色器（同名会覆盖） */
    addShader(shader: EffectShader) {
        const previous = this.shaderRegistry.get(shader.name);
        if (previous && previous !== shader) {
            const compiled = this.compiledShaders.get(previous);
            if (compiled) {
                this.backend.destroyEffect(compiled);
                this.compiledShaders.delete(previous);
            }
        }
        this.shaderRegistry.set(shader.name, shader);
    }

    addShaders(shaders: readonly EffectShader[]) {
        for (const shader of shaders) this.addShader(shader);
    }

    /** 取已注册的着色器 */
    getShader(name: string): EffectShader | undefined {
        return this.shaderRegistry.get(name);
    }

    /** 反注册着色器（会连编译结果一起释放） */
    removeShader(name: string) {
        const shader = this.shaderRegistry.get(name);
        if (!shader) return;
        this.shaderRegistry.delete(name);
        const compiled = this.compiledShaders.get(shader);
        if (compiled) {
            this.backend.destroyEffect(compiled);
            this.compiledShaders.delete(shader);
        }
    }

    /**
     * 设置某个 z 区间上依次应用的特效链。
     *
     * 区间是**左闭右开**的 `[from, to)`，同一区间重复设置会覆盖。
     * 特效在每帧 flush 时才真正执行，因此这里只记录请求，uniform 的值随取随用。
     *
     * ```ts
     * // 只让 [0, 9) 的谱面图层过一遍模糊，UI（z=9）不受影响
     * gpu.setEffect(0, 9, [{ shader: "blur", uniforms: { radius: 4 } }]);
     * ```
     */
    setEffect(from: number, to: number, chain: readonly EffectRequest[]) {
        if (!(to > from) || chain.length === 0) {
            this.clearEffect(from, to);
            return;
        }
        // 区间不允许重叠：后来设置的会顶掉重叠的旧区间
        this.effectRanges = this.effectRanges.filter(range => range.to <= from || range.from >= to);
        const range: EffectRange = { from, to, chain: [...chain] };
        const index = this.effectRanges.findIndex(item => item.from >= from);
        this.effectRanges.splice(Math.max(index, 0), 0, range);
    }

    /** 清除某个 z 区间上的特效 */
    clearEffect(from: number, to: number) {
        this.effectRanges = this.effectRanges.filter(range => range.to <= from || range.from >= to);
    }

    /** 清掉所有特效区间（每帧重新设置即可） */
    clearEffects() {
        this.effectRanges = [];
    }

    /** 当前设置的特效区间（调试用） */
    get effects(): readonly EffectRange[] {
        return this.effectRanges;
    }

    /** 把着色器编译成当前后端能用的东西；当前后端没有对应源码 / 编译失败时返回 null */
    private compileEffectFor(shader: EffectShader): CompiledEffect | null {
        const cached = this.compiledShaders.get(shader);
        if (cached) return cached;
        let compiled: CompiledEffect | null = null;
        try {
            compiled = this.backend.compileEffect(shader);
        } catch (error) {
            // 谱面自带的自定义着色器可能有语法错误，别让它把整帧带崩
            console.warn(`[AnyGPUContext2D] 特效着色器编译失败，已跳过: ${shader.name}`, error);
            compiled = null;
        }
        if (compiled) this.compiledShaders.set(shader, compiled);
        return compiled;
    }

    /** 特效着色器里的 `time`（秒） */
    time = 0;

    /** 取（并按需上传）一张图片对应的纹理 */
    getTexture(image: TexImageSource): Texture {
        // 视频帧每帧都是新对象，缓存没有意义，用完即弃
        if (isVideoFrame(image)) {
            const source = this.normalizeSource(image);
            const [width, height] = imageSize(source);
            const texture = new Texture(source, width, height, this.backend.createTexture(source, width, height));
            this.textureGraveyard.push(texture);   // 这一帧画完就回收
            return texture;
        }

        const key = image as unknown as object;
        const cached = this.textureCache.get(key);
        if (cached) return cached;

        const source = this.normalizeSource(image);
        const [width, height] = imageSize(source);
        const texture = new Texture(source, width, height, this.backend.createTexture(source, width, height));
        this.textureCache.set(key, texture);
        this.ownedTextures.add(texture);
        return texture;
    }

    /**
     * 把源归一化成后端能直接上传的东西：
     * - HTMLImageElement → canvas（WebGPU 的 copyExternalImageToTexture 不接受 <img>）
     * - VideoFrame → canvas（WebGL 1 的 texImage2D 不保证接受 VideoFrame）
     *
     * 注意：VideoFrame 走的是复用的 canvas，所以**必须在同一次同步调用里上传完**，
     * 中间不能 await。
     */
    private normalizeSource(image: TexImageSource): TexImageSource | AnyCanvas2D {
        if (isVideoFrame(image)) {
            if (this.backend.kind !== "webgl1") return image;   // WebGPU 原生支持 VideoFrame
            const width = Math.max(1, image.displayWidth | 0);
            const height = Math.max(1, image.displayHeight | 0);
            let scratch = this.videoScratch;
            if (!scratch) {
                scratch = this.videoScratch = createCanvas2D(width, height);
            } else if (scratch.canvas.width !== width || scratch.canvas.height !== height) {
                scratch.canvas.width = width;
                scratch.canvas.height = height;
            }
            scratch.ctx.drawImage(image, 0, 0, width, height);
            return scratch.canvas;
        }
        if (typeof HTMLImageElement !== "undefined" && image instanceof HTMLImageElement) {
            const canvas = createCanvas2D(image.naturalWidth || image.width, image.naturalHeight || image.height);
            canvas.ctx.drawImage(image, 0, 0);
            return canvas.canvas;
        }
        return image;
    }

    /** 画布内容变了（比如视频帧 / 手绘 canvas）时手动丢弃缓存 */
    invalidateTexture(image: TexImageSource) {
        const key = image as unknown as object;
        const cached = this.textureCache.get(key);
        if (!cached) return;
        this.textureCache.delete(key);
        this.ownedTextures.delete(cached);
        // 本帧可能还有实例引用着它，等这一帧画完再真正释放
        this.textureGraveyard.push(cached);
    }

    measureText(text: string, font: string): TextMetrics {
        const ctx = this.textRaster();
        ctx.font = font;
        return ctx.measureText(text);
    }

    /** @internal 文本光栅化，返回纹理与度量信息 */
    layoutText(text: string, font: string, stroke: boolean, lineWidth: number, requestedScale: number): TextLayout {
        const scale = Math.min(4, Math.max(1, Math.round(requestedScale * 2) / 2));
        const key = `${stroke ? 1 : 0}|${lineWidth}|${scale}|${font}|${text}`;
        const cached = this.textCache.get(key);
        if (cached) {
            // 命中就挪到队尾（LRU）
            this.textCache.delete(key);
            this.textCache.set(key, cached);
            return cached;
        }

        const canvas = this.textRasterCanvas();
        const ctx = this.textRaster();
        ctx.font = font;
        const metrics = ctx.measureText(text);

        const fontSizeMatch = /(\d+(?:\.\d+)?)px/.exec(font);
        const fontSize = fontSizeMatch ? parseFloat(fontSizeMatch[1]!) : 10;
        const ascent = metrics.actualBoundingBoxAscent ?? fontSize * 0.8;
        const descent = metrics.actualBoundingBoxDescent ?? fontSize * 0.25;
        const width = metrics.width;

        const pad = Math.ceil((stroke ? lineWidth * scale : 1) + 2);
        const textureWidth = Math.max(1, Math.ceil(width * scale) + pad * 2);
        const textureHeight = Math.max(1, Math.ceil((ascent + descent) * scale) + pad * 2);

        canvas.width = textureWidth;
        canvas.height = textureHeight;
        // 改尺寸会重置 2D 状态，重新设置
        const raster = getCanvas2D(canvas);
        raster.setTransform(scale, 0, 0, scale, 0, 0);
        raster.font = font;
        raster.textAlign = "left";
        raster.textBaseline = "alphabetic";
        if (stroke) {
            raster.strokeStyle = "#ffffff";
            raster.lineWidth = lineWidth;
            raster.strokeText(text, pad / scale, pad / scale + ascent);
        } else {
            raster.fillStyle = "#ffffff";
            raster.fillText(text, pad / scale, pad / scale + ascent);
        }

        const texture = new Texture(canvas, textureWidth, textureHeight, this.backend.createTexture(canvas, textureWidth, textureHeight));
        this.ownedTextures.add(texture);

        const layout: TextLayout = { texture, width, ascent, descent, scale, pad, textureWidth, textureHeight };
        this.textCache.set(key, layout);
        // 只淘汰最久没用的那一条。被淘汰的纹理要等这一帧画完才能删，
        // 因为本帧可能还有实例引用着它（见 flush 末尾的 sweepTextures）。
        if (this.textCache.size > TEXT_CACHE_LIMIT) {
            const oldest = this.textCache.keys().next().value;
            if (oldest !== undefined) {
                const evicted = this.textCache.get(oldest);
                this.textCache.delete(oldest);
                if (evicted) {
                    this.ownedTextures.delete(evicted.texture);
                    this.textureGraveyard.push(evicted.texture);
                }
            }
        }
        return layout;
    }

    private textRasterCanvas(): AnyCanvas2D {
        if (!this.textCanvas) this.textCanvas = createCanvas2D(1, 1).canvas;
        return this.textCanvas;
    }

    private textRaster(): AnyCanvas2DContext {
        if (!this.textContext) this.textContext = getCanvas2D(this.textRasterCanvas());
        return this.textContext;
    }

    /**
     * 汇总所有图层 → 按 z 稳定排序 → 合批 → 实例化绘制。
     * 默认绘制完清空图层记录（适合每帧重画的场景）。
     */
    flush(options: { reset?: boolean } = {}): FlushStats {
        const reset = options.reset !== false;
        const width = Math.max(1, this.canvas.width);
        const height = Math.max(1, this.canvas.height);

        this.backend.beginFrame(width, height, this.range, this.clearColor);
        this.effectPasses = 0;

        let total = 0;
        let batches = 0;
        for (const layer of this.layerList) total += layer.buffer.count;

        if (total > 0) {
            const combined = this.ensure(this.combinedScratch, total * INSTANCE_FLOATS);
            this.combinedScratch = combined;

            const textures: (Texture | null)[] = new Array(total);
            let index = 0;
            for (const layer of this.layerList) {
                const count = layer.buffer.count;
                if (count === 0) continue;
                combined.set(layer.buffer.floats.subarray(0, count * INSTANCE_FLOATS), index * INSTANCE_FLOATS);
                for (let i = 0; i < count; i++) textures[index + i] = layer.buffer.textures[i] ?? null;
                index += count;
            }

            // z 稳定排序：同 z 的绘制保持记录顺序
            const order = new Array<number>(total);
            for (let i = 0; i < total; i++) order[i] = i;
            order.sort((a, b) => combined[a * INSTANCE_FLOATS + OFFSET_Z]! - combined[b * INSTANCE_FLOATS + OFFSET_Z]!);

            const sorted = this.ensure(this.sortedScratch, total * INSTANCE_FLOATS);
            this.sortedScratch = sorted;
            const sortedTextures = this.ensureTextures(total);
            this.sortedTextures = sortedTextures;

            for (let k = 0; k < total; k++) {
                const source = order[k]!;
                const offset = source * INSTANCE_FLOATS;
                sorted.set(combined.subarray(offset, offset + INSTANCE_FLOATS), k * INSTANCE_FLOATS);
                sortedTextures[k] = textures[source] ?? null;
            }

            this.backend.uploadInstances(sorted, total);

            const ranges = this.activeEffectRanges();
            if (ranges.length === 0) {
                // 快路径：没有任何特效，直接画到画布上
                batches = this.renderSegments(0, total, null);
            } else {
                batches = this.renderWithEffects(total, ranges);
            }
        } else {
            // 空帧也要清一次画布，否则会留着上一帧的内容
            this.backend.clearFrame();
        }

        this.backend.endFrame();

        if (reset) for (const layer of this.layerList) layer.reset();

        // 这一帧的绘制已经提交，被淘汰的纹理（文字 LRU、视频帧、invalidate）现在才真正删掉。
        // 必须在 endFrame 之后：本帧可能还有实例引用着它们。
        this.sweepTextures();

        return { instances: total, batches, effects: this.effectPasses };
    }

    /** 只留下链非空的区间，并按起点排序 */
    private activeEffectRanges(): EffectRange[] {
        const ranges: EffectRange[] = [];
        for (const range of this.effectRanges) {
            if (range.chain.length > 0) ranges.push(range);
        }
        ranges.sort((a, b) => a.from - b.from);
        return ranges;
    }

    /** 把 [first, first + count) 按「纹理 + 混合模式」切批，画进 target */
    private renderSegments(first: number, count: number, target: unknown): number {
        const sorted = this.sortedScratch;
        const batchFirst: number[] = [];
        const batchCount: number[] = [];
        const batchTexture: (Texture | null)[] = [];
        const batchBlend: number[] = [];

        let previousTexture: Texture | null | undefined;
        let previousBlend = -1;

        for (let k = first; k < first + count; k++) {
            // 注意：纯色图元（fillRect 之类）的 texture 是 null，也必须 push，
            // 否则后面的 batch 会和纹理数组错位，整帧贴图全乱
            const texture = this.sortedTextures[k] ?? null;
            const blend = sorted[k * INSTANCE_FLOATS + OFFSET_BLEND]!;
            if (k === first || texture !== previousTexture || blend !== previousBlend) {
                batchFirst.push(k);
                batchCount.push(1);
                batchTexture.push(texture);
                batchBlend.push(blend);
            } else {
                batchCount[batchCount.length - 1]!++;
            }
            previousTexture = texture;
            previousBlend = blend;
        }

        for (let i = 0; i < batchFirst.length; i++) {
            const texture = batchTexture[i];
            this.backend.drawInstances(
                texture ? texture.handle : null,
                batchBlend[i]!,
                batchFirst[i]!,
                batchCount[i]!,
                target,
            );
        }
        return batchFirst.length;
    }

    /**
     * 有特效时的渲染流程：
     *   每个区间的内容先画到离屏纹理，再依次过特效链，最后叠加到整帧累积目标上；
     *   整帧画完后一次性贴回画布。
     * 这样「只影响谱面、不影响 UI」只要让特效区间不含 UI 图层即可。
     */
    private renderWithEffects(total: number, ranges: EffectRange[]): number {
        const width = Math.max(1, this.canvas.width);
        const height = Math.max(1, this.canvas.height);

        // [0] 整帧累积目标，[1] 区间内容，[2..] 特效链中间结果
        const longest = ranges.reduce((max, range) => Math.max(max, range.chain.length), 0);
        const needed = 1 + Math.max(1, longest);
        if (!this.scratchTargets || this.scratchTargets.length < needed) {
            this.releaseScratchTargets();
            this.scratchTargets = [];
            for (let i = 0; i < needed; i++) {
                this.scratchTargets.push(this.backend.createRenderTarget(width, height));
            }
        }

        const frame = this.scratchTargets[0]!;
        const content = this.scratchTargets[1]!;
        let batches = 0;

        // 整帧累积目标每帧开始清一次
        this.backend.clearRenderTarget(frame);

        let index = 0;
        let rangeIndex = 0;
        while (index < total) {
            const chain = this.chainAt(ranges, rangeIndex, this.sortedScratch[index * INSTANCE_FLOATS + OFFSET_Z]!);
            // 同步推进区间游标
            while (rangeIndex < ranges.length && ranges[rangeIndex]!.to < this.sortedScratch[index * INSTANCE_FLOATS + OFFSET_Z]!) rangeIndex++;

            let end = index + 1;
            while (end < total) {
                const next = this.chainAt(ranges, rangeIndex, this.sortedScratch[end * INSTANCE_FLOATS + OFFSET_Z]!);
                if (next !== chain) break;
                end++;
            }

            const count = end - index;
            if (!chain) {
                batches += this.renderSegments(index, count, frame);
            } else {
                // 区间内容每次都从干净的纹理开始
                this.backend.clearRenderTarget(content);
                batches += this.renderSegments(index, count, content);

                // 先把能用上的着色器挑出来：不存在 / 编译失败的直接跳过，
                // 一个都不剩时原样把内容贴回去，绝不能让它消失
                const usable: { effect: CompiledEffect; request: EffectRequest }[] = [];
                for (const request of chain) {
                    const shader = this.shaderRegistry.get(request.shader);
                    if (!shader) continue;
                    const effect = this.compileEffectFor(shader);
                    if (!effect) continue;
                    usable.push({ effect, request });
                }

                if (usable.length === 0) {
                    // 静默降级：这个区间的着色器一个都用不了，就当作没有特效
                    this.backend.blit(content, frame);
                } else {
                    let source = content;
                    for (let i = 0; i < usable.length; i++) {
                        const { effect, request } = usable[i]!;
                        const last = i === usable.length - 1;
                        const destination = last ? frame : this.scratchTargets[2 + i]!;
                        // 中间结果整屏覆盖，先清掉残留
                        if (!last) this.backend.clearRenderTarget(destination);
                        this.backend.runEffect(
                            effect,
                            source,
                            destination,
                            request.uniforms ?? {},
                            width, height, this.time,
                        );
                        this.effectPasses++;
                        source = destination;
                    }
                }
            }
            index = end;
        }

        this.backend.blit(frame, null);
        return batches;
    }

    /** z 处覆盖的特效链；区间左闭右开，没有则返回 null */
    private chainAt(ranges: EffectRange[], from: number, z: number): EffectRequest[] | null {
        for (let i = from; i < ranges.length; i++) {
            const range = ranges[i]!;
            if (range.to <= z) continue;
            if (range.from > z) return null;
            return range.chain;
        }
        return null;
    }

    private releaseScratchTargets() {
        if (!this.scratchTargets) return;
        for (const target of this.scratchTargets) this.backend.destroyRenderTarget(target);
        this.scratchTargets = null;
    }

    /** 回收已淘汰且本帧不再被引用的纹理 */
    private sweepTextures() {
        if (this.textureGraveyard.length === 0) return;
        for (const texture of this.textureGraveyard) this.backend.destroyTexture(texture.handle);
        this.textureGraveyard.length = 0;
    }

    private ensure(buffer: Float32Array, length: number): Float32Array {
        if (buffer.length >= length) return buffer;
        let size = buffer.length || INSTANCE_FLOATS * 256;
        while (size < length) size *= 2;
        return new Float32Array(size);
    }

    private ensureTextures(count: number): (Texture | null)[] {
        if (this.sortedTextures.length >= count) return this.sortedTextures;
        return new Array<(Texture | null)>(Math.max(count, this.sortedTextures.length * 2, 256));
    }

    destroy() {
        this.sweepTextures();
        this.releaseScratchTargets();
        for (const texture of this.ownedTextures) this.backend.destroyTexture(texture.handle);
        this.ownedTextures.clear();
        this.textCache.clear();
        for (const compiled of this.compiledShaders.values()) this.backend.destroyEffect(compiled);
        this.compiledShaders.clear();
        this.shaderRegistry.clear();
        this.effectRanges = [];
        this.layerList.length = 0;
        this.backend.destroy();
    }
}

interface TextLayout {
    texture: Texture;
    width: number;
    ascent: number;
    descent: number;
    scale: number;
    pad: number;
    textureWidth: number;
    textureHeight: number;
}

/* ========================================================================= *
 * 工具
 * ========================================================================= */

/** 视频帧：每帧都是新对象，纹理只能存活一帧 */
function isVideoFrame(source: unknown): source is VideoFrame {
    return typeof VideoFrame !== "undefined" && source instanceof VideoFrame;
}

/** 各种源里表示尺寸的字段不一样，这里只挑用得到的几个 */
interface SizedImageSource {
    width?: number;
    height?: number;
    naturalWidth?: number;
    naturalHeight?: number;
    videoWidth?: number;
    videoHeight?: number;
    displayWidth?: number;
    displayHeight?: number;
}

function imageSize(source: TexImageSource): [number, number] {
    const sized = source as SizedImageSource;
    const width = sized.displayWidth ?? sized.naturalWidth ?? sized.videoWidth ?? sized.width ?? 0;
    const height = sized.displayHeight ?? sized.naturalHeight ?? sized.videoHeight ?? sized.height ?? 0;
    return [Math.max(1, Math.floor(width)), Math.max(1, Math.floor(height))];
}
