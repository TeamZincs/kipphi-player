import { 
    Chart,
    Note,
    type NNNOrTail,
    NodeType,
    TimeCalculator,
    NNNode,
    JudgeLine,
    type RGB,
    type NNOrTail,
    HNList,
    NNList,
    NoteNode,
    NoteType,
    TC,
    NNNodeLike,
    type TimeT,
    type EffectStartNode,
    Op,
    VideoScale
} from "kipphi";
/// #default
import { AudioProcessor } from "./audio";
/// #enddefault
import { Tinter } from "./tinter";
import { drawLine, innerProduct, rgb, rgba } from "./util";
import { Coordinate, identity, Matrix33 } from "./matrix";
import { drawNthFrame, Images } from "./image";
import { type Vector } from "./util";
import { NOTE_HEIGHT, NOTE_WIDTH } from "./constants";
import type { Respack } from "./respack";
import "./polyfill";
import type { VideoFrameSource } from "./video";

/*
#node {
import { Canvas, type CanvasRenderingContext2D, type Image, type ImageData } from "skia-canvas";
import { AudioProcessor } from "./audioProcessor";
}
*/
// #default
import { AnyGPUContext2D, type EffectRequest, type EffectShader, type EffectUniforms, type LayerContext2D } from "./context";
// #enddefault

/**
 * 绘图上下文：
 * - 浏览器：`LayerContext2D`（GPU 图层，合批 + 实例化绘制）
 * - Node：skia-canvas 的 `CanvasRenderingContext2D`
 */
type PlayContext2D = CanvasRenderingContext2D
// #default
    | LayerContext2D
// #enddefault
    ;

/**
 * GPU 上下文的类型。
 * 浏览器端就是 `AnyGPUContext2D`；Node 端没有 GPU 后端，占用一个 any 占位，
 * 这样共享代码里的 `this.gpu` 在浏览器端仍然是有类型的。
 */
// #default
type GPUContext2D = AnyGPUContext2D;
// #enddefault
/* #node {
type GPUContext2D = any;
} */

const HOLD_HE_SPEED = 2;
const HOLD_HE_INTERVAL = 1 / HOLD_HE_SPEED;

// 扩展JudgeLine，在上面缓存每帧的数据
declare module "kipphi" {
    interface JudgeLine {
        renderMatrix: Matrix33;
        moveX: number;
        moveY: number;
        rotate: number;
        alpha: number;
        transformedX: number;
        transformedY: number;
        optimized: boolean;
        color: [number, number, number];
        scaleX: number;
        scaleY: number;
    }
}

const ENABLE_PLAYER = true;
const DRAWS_NOTES = true;

const LINE_WIDTH = 6.75;
const HIT_EFFECT_SIZE = 200;

// 以原点为中心，渲染的半径
const RENDER_SCOPE = 1000;

const COMBO_TEXT = "KIPPHI";


const CURVE_NODE_SHAPE: [number, number][] = [[-5, -5], [-5, 5], [5, 5], [5, -5], [0, -14]];

const STANDARD_WIDTH =  1350;
const STANDARD_HEIGHT = 900;
const BASE_LINE_LENGTH = 4050;
const getVector = (theta: number): [Vector, Vector] => [[Math.cos(theta), Math.sin(theta)], [-Math.sin(theta), Math.cos(theta)]]
type HEX = number;

// #default
type ProcessedTexture = OffscreenCanvas | ImageBitmap;
const __IS_BROWSER = true;
// #enddefault
/*
#node {
type HTMLCanvasElement = Canvas;
type OffscreenCanvas = Canvas;
type ImageBitmap = Image;
type HTMLImageElement = Image;
type ProcessedTexture = Canvas;
const OffscreenCanvas = Canvas;
type OffscreenCanvasRenderingContext2D = CanvasRenderingContext2D;
const __IS_BROWSER = false;
const createImageBitmap = async <T>(img: T) => img;
}
*/

const HOLD_LAYER = 3;
const DRAG_LAYER = 4;
const TAP_LAYER = 5;
const FLICK_LAYER = 6;
const HIT_EFFECT_LAYER = 7;
const TEXTURE_BOUNDS_LAYER = 8;
const NOTE_TYPE_LAYER_MAP = [null, TAP_LAYER, HOLD_LAYER, FLICK_LAYER, DRAG_LAYER]
/**
 * GPU 模式：图层下标直接当 z 用。
 * 0 是底图/判定线，3~8 是音符层，9 是谱面自己的 UI（combo/进度条/曲名/线号/曲线），
 * 10 是只放帧率和时间的覆盖层 —— 它永远不进特效区间。
 */
const GPU_Z_BASE = 0;
const CHART_UI_LAYER = 9;
const GPU_Z_UI = CHART_UI_LAYER;
const GPU_Z_OVERLAY = 10;
const GPU_Z_MAX = 11;
const NO_LAYER_INDICES = [HOLD_LAYER, DRAG_LAYER, TAP_LAYER, FLICK_LAYER, HIT_EFFECT_LAYER, TEXTURE_BOUNDS_LAYER, CHART_UI_LAYER];

// #default

/**
 * 内置特效着色器（Phira 的 `effect.shader` 名字）。
 *
 * 注意：`chromatic` 的参数名（power / sampleCount）与 Phira 文档一致；
 * `blur` 的参数名是本项目自定的（Phira 文档没给内置清单），
 * 谱面里实际用到的内置名以 Phira 为准，加到这里就行。
 *
 * 自定义着色器（`shader` 以 `/` 开头，指向谱面包内文件）走
 * {@linkcode Player.receive} 的 `shaderFetcher`，只有 GLSL（WebGL 1）能用。
 */
export const BUILTIN_EFFECT_SHADERS: EffectShader[] = [
    {
        // 色差：R / B 通道沿「像素 → 屏幕中心」方向反向偏移
        name: "chromatic",
        glsl: `
        uniform float power;        // %0.05%
        uniform float sampleCount;  // %5% 谱面会传，这里只用于兼容

        void main() {
            vec2 dir = uv - vec2(0.5);
            float r = texture2D(screenTexture, uv + dir * power).r;
            float g = texture2D(screenTexture, uv).g;
            float b = texture2D(screenTexture, uv - dir * power).b;
            float a = texture2D(screenTexture, uv).a;
            gl_FragColor = vec4(r, g, b, a);
        }
        `,
        wgsl: `
        let dir = in.uv - vec2f(0.5, 0.5);
        let r = textureSample(screenTexture, samp, in.uv + dir * power).r;
        let g = textureSample(screenTexture, samp, in.uv).g;
        let b = textureSample(screenTexture, samp, in.uv - dir * power).b;
        let a = textureSample(screenTexture, samp, in.uv).a;
        return vec4f(r, g, b, a);
        `,
    },
    {
        // 高斯模糊（水平），与 #blur-y 串成两趟
        name: "#blur-x",
        glsl: `
        uniform float radius; // %0.01%

        void main() {
            vec2 texel = vec2(1.0) / screenSize;
            vec4 sum = vec4(0.0);
            float total = 0.0;
            for (int i = -4; i <= 4; i++) {
                float w = exp(-float(i * i) / 8.0);
                sum += texture2D(screenTexture, uv + vec2(float(i), 0.0) * radius * texel) * w;
                total += w;
            }
            gl_FragColor = sum / total;
        }
        `,
        wgsl: `
        let texel = vec2f(1.0, 1.0) / screenSize;
        var sum = vec4f(0.0, 0.0, 0.0, 0.0);
        var total = 0.0;
        for (var i = -4; i <= 4; i++) {
            let fi = f32(i);
            let w = exp(-fi * fi / 8.0);
            sum += textureSample(screenTexture, samp, in.uv + vec2f(fi, 0.0) * radius * texel) * w;
            total += w;
        }
        return sum / total;
        `,
    },
    {
        // 高斯模糊（垂直）
        name: "#blur-y",
        glsl: `
        uniform float radius; // %0.01%

        void main() {
            vec2 texel = vec2(1.0) / screenSize;
            vec4 sum = vec4(0.0);
            float total = 0.0;
            for (int i = -4; i <= 4; i++) {
                float w = exp(-float(i * i) / 8.0);
                sum += texture2D(screenTexture, uv + vec2(0.0, float(i)) * radius * texel) * w;
                total += w;
            }
            gl_FragColor = sum / total;
        }
        `,
        wgsl: `
        let texel = vec2f(1.0, 1.0) / screenSize;
        var sum = vec4f(0.0, 0.0, 0.0, 0.0);
        var total = 0.0;
        for (var i = -4; i <= 4; i++) {
            let fi = f32(i);
            let w = exp(-fi * fi / 8.0);
            sum += textureSample(screenTexture, samp, in.uv + vec2f(0.0, fi) * radius * texel) * w;
            total += w;
        }
        return sum / total;
        `,
    },
    {
        // 像素化：把画面量化成 size 像素一块（Phira: pixel / size 10.0）
        name: "pixel",
        glsl: `
        uniform float size; // %10.0%

        void main() {
            vec2 blocks = screenSize / max(size, 1.0);
            gl_FragColor = texture2D(screenTexture, (floor(uv * blocks) + 0.5) / blocks);
        }
        `,
        wgsl: `
        let blocks = screenSize / max(size, 1.0);
        return textureSample(screenTexture, samp, (floor(in.uv * blocks) + vec2f(0.5, 0.5)) / blocks);
        `,
    },
    {
        // 灰度：factor 0 = 原色，1 = 完全灰度（Phira: grayscale / factor 1.0）
        name: "grayscale",
        glsl: `
        uniform float factor; // %1.0%

        void main() {
            vec4 c = texture2D(screenTexture, uv);
            float gray = dot(c.rgb, vec3(0.299, 0.587, 0.114));
            gl_FragColor = vec4(mix(c.rgb, vec3(gray), factor), c.a);
        }
        `,
        wgsl: `
        let c = textureSample(screenTexture, samp, in.uv);
        let gray = dot(c.rgb, vec3f(0.299, 0.587, 0.114));
        return vec4f(mix(c.rgb, vec3f(gray), factor), c.a);
        `,
    },
    {
        // 暗角：边缘向 color 渐变。extend = 从边缘算起的深度，radius 越小影响范围越大
        // （Phira: vignette / color 黑、extend 0.25、radius 15.0）
        name: "vignette",
        glsl: `
        uniform vec4 color;   // %0 0 0 1%
        uniform float extend; // %0.25%
        uniform float radius; // %15.0%

        void main() {
            vec4 c = texture2D(screenTexture, uv);
            vec2 d = (uv - 0.5) * 2.0;
            float dist = length(d);
            float inner = 1.0 - clamp(extend, 0.0, 1.0);
            float t = smoothstep(inner, 1.0 + 1.0 / max(radius, 0.001), dist);
            // 预乘 alpha：目标色也要乘上原来的 alpha
            gl_FragColor = vec4(mix(c.rgb, color.rgb * c.a, t), c.a);
        }
        `,
        wgsl: `
        let c = textureSample(screenTexture, samp, in.uv);
        let d = (in.uv - vec2f(0.5, 0.5)) * 2.0;
        let dist = length(d);
        let inner = 1.0 - clamp(extend, 0.0, 1.0);
        let t = smoothstep(inner, 1.0 + 1.0 / max(radius, 0.001), dist);
        return vec4f(mix(c.rgb, color.rgb * c.a, t), c.a);
        `,
    },
    {
        // 圆形模糊：越靠近屏幕中心越糊，糊出来的那团会显得更亮
        // （Phira: circleBlur / size 10.0，单位像素）
        name: "circleBlur",
        glsl: `
        uniform float size; // %10.0%

        void main() {
            vec2 dir = uv - 0.5;
            float dist = length(dir * screenSize);
            float strength = clamp(size / max(dist, 1.0), 0.0, 1.0) * 0.02;
            vec4 sum = vec4(0.0);
            for (int i = 0; i < 8; i++) {
                sum += texture2D(screenTexture, uv + dir * (float(i) / 7.0 - 0.5) * strength);
            }
            gl_FragColor = sum / 8.0;
        }
        `,
        wgsl: `
        let dir = in.uv - vec2f(0.5, 0.5);
        let dist = length(dir * screenSize);
        let strength = clamp(size / max(dist, 1.0), 0.0, 1.0) * 0.02;
        var sum = vec4f(0.0, 0.0, 0.0, 0.0);
        for (var i = 0; i < 8; i++) {
            sum += textureSample(screenTexture, samp, in.uv + dir * (f32(i) / 7.0 - 0.5) * strength);
        }
        return sum / 8.0;
        `,
    },
    {
        // 冲击波：以 (centerX, centerY) 为圆心向外推一圈，progress 0 → 1 播放一次
        // （Phira: shockwave / progress 0.2、centerX/Y 0.5、width 0.1、distortion 0.8、expand 10.0）
        name: "shockwave",
        glsl: `
        uniform float progress;   // %0.2%
        uniform float centerX;    // %0.5%
        uniform float centerY;    // %0.5%
        uniform float width;      // %0.1%
        uniform float distortion; // %0.8%
        uniform float expand;     // %10.0%

        void main() {
            vec2 diff = uv - vec2(centerX, centerY);
            float dist = length(diff);
            float radius = progress * max(expand, 0.001) * 0.1;
            // smoothstep 要求 edge0 < edge1，这里反过来写再取补
            float band = 1.0 - smoothstep(0.0, max(width, 0.001), abs(dist - radius));
            vec2 dir = dist > 0.0001 ? diff / dist : vec2(0.0);
            float amount = band * distortion * 0.5 * (1.0 - progress) / max(expand, 0.001);
            gl_FragColor = texture2D(screenTexture, uv - dir * amount);
        }
        `,
        wgsl: `
        let diff = in.uv - vec2f(centerX, centerY);
        let dist = length(diff);
        let radius = progress * max(expand, 0.001) * 0.1;
        let band = 1.0 - smoothstep(0.0, max(width, 0.001), abs(dist - radius));
        let dir = select(vec2f(0.0, 0.0), diff / max(dist, 0.0001), dist > 0.0001);
        let amount = band * distortion * 0.5 * (1.0 - progress) / max(expand, 0.001);
        return textureSample(screenTexture, samp, in.uv - dir * amount);
        `,
    },
    {
        // 鱼眼：以屏幕中心为原点做径向缩放，power 为负时是「隧道」那种往里吸的效果
        // （Phira: fisheye / power -0.1）
        name: "fisheye",
        glsl: `
        uniform float power; // %-0.1%

        void main() {
            vec2 dir = uv - 0.5;
            float r = length(dir) * 2.0;          // 0 中心，1 边缘
            float scale = 1.0 - power * r * r;
            gl_FragColor = texture2D(screenTexture, vec2(0.5) + dir * scale);
        }
        `,
        wgsl: `
        let dir = in.uv - vec2f(0.5, 0.5);
        let r = length(dir) * 2.0;
        let scale = 1.0 - power * r * r;
        return textureSample(screenTexture, samp, vec2f(0.5, 0.5) + dir * scale);
        `,
    },
    {
        // 故障：按水平条带随机错位 + RGB 分离，rate 控制「这一帧是否闪烁」
        // （Phira: glitch / power 0.3、rate 0.6、speed 5.0、blockCount 30.5、colorRate 0.01）
        name: "glitch",
        glsl: `
        uniform float power;      // %0.3%
        uniform float rate;       // %0.6%
        uniform float speed;      // %5.0%
        uniform float blockCount; // %30.5%
        uniform float colorRate;  // %0.01%

        float rand(vec2 p) {
            return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
        }

        void main() {
            // 把时间切成 speed 帧/s 的格子：同一格内图案不变，跨格才重新掷骰子
            float t = floor(time * speed);
            float on = step(1.0 - rate, rand(vec2(t, 7.0)));
            float block = floor(uv.y * blockCount);
            float shift = (rand(vec2(block, t)) - 0.5) * power * 0.2 * on;
            vec2 sampleUv = vec2(uv.x + shift, uv.y);

            float d = colorRate * 0.1 * on;
            float r = texture2D(screenTexture, sampleUv + vec2(d, 0.0)).r;
            float g = texture2D(screenTexture, sampleUv).g;
            float b = texture2D(screenTexture, sampleUv - vec2(d, 0.0)).b;
            float a = texture2D(screenTexture, sampleUv).a;
            gl_FragColor = vec4(r, g, b, a);
        }
        `,
        wgslPrelude: `
fn rand(p: vec2f) -> f32 {
    return fract(sin(dot(p, vec2f(12.9898, 78.233))) * 43758.5453);
}
        `,
        wgsl: `
        let t = floor(time * speed);
        let on = step(1.0 - rate, rand(vec2f(t, 7.0)));
        let block = floor(in.uv.y * blockCount);
        let shift = (rand(vec2f(block, t)) - 0.5) * power * 0.2 * on;
        let sampleUv = vec2f(in.uv.x + shift, in.uv.y);

        let d = colorRate * 0.1 * on;
        let r = textureSample(screenTexture, samp, sampleUv + vec2f(d, 0.0)).r;
        let g = textureSample(screenTexture, samp, sampleUv).g;
        let b = textureSample(screenTexture, samp, sampleUv - vec2f(d, 0.0)).b;
        let a = textureSample(screenTexture, samp, sampleUv).a;
        return vec4f(r, g, b, a);
        `,
    },
    {
        // 噪点：按 uv + seed 生成平滑的伪随机偏移，seed 连续变化时图案也连续变化
        // （Phira: noise / seed 81.0、power 0.03）
        name: "noise",
        glsl: `
        uniform float seed;  // %81.0%
        uniform float power; // %0.03%

        vec2 noiseOffset(vec2 p, float s) {
            return vec2(
                sin(p.x * 97.0 + s) + sin(p.y * 133.0 - s * 1.3) + sin((p.x + p.y) * 61.0 + s * 0.7),
                cos(p.y * 89.0 - s * 1.1) + cos(p.x * 151.0 + s) + cos((p.x - p.y) * 73.0 - s * 0.9)
            ) / 3.0;
        }

        void main() {
            gl_FragColor = texture2D(screenTexture, uv + noiseOffset(uv, seed) * power);
        }
        `,
        wgslPrelude: `
fn noiseOffset(p: vec2f, s: f32) -> vec2f {
    return vec2f(
        sin(p.x * 97.0 + s) + sin(p.y * 133.0 - s * 1.3) + sin((p.x + p.y) * 61.0 + s * 0.7),
        cos(p.y * 89.0 - s * 1.1) + cos(p.x * 151.0 + s) + cos((p.x - p.y) * 73.0 - s * 0.9)
    ) / 3.0;
}
        `,
        wgsl: `
        return textureSample(screenTexture, samp, in.uv + noiseOffset(in.uv, seed) * power);
        `,
    },
    {
        // 放射模糊：从这个中心往外拉，sampleCount 越高越连贯（也越贵）
        // （Phira: radialBlur / centerX 0.5、centerY 0.5、power 0.01、sampleCount 3）
        name: "radialBlur",
        glsl: `
        uniform float centerX;     // %0.5%
        uniform float centerY;     // %0.5%
        uniform float power;       // %0.01%
        uniform float sampleCount; // %3%

        void main() {
            vec2 center = vec2(centerX, centerY);
            vec2 dir = uv - center;
            int count = int(clamp(sampleCount, 1.0, 64.0));
            float last = float(max(count, 2) - 1);
            vec4 sum = vec4(0.0);
            for (int i = 0; i < 64; i++) {
                if (i >= count) break;
                float t = float(i) / last;
                sum += texture2D(screenTexture, center + dir * (1.0 + power * t));
            }
            gl_FragColor = sum / float(count);
        }
        `,
        wgsl: `
        let center = vec2f(centerX, centerY);
        let dir = in.uv - center;
        let count = i32(clamp(sampleCount, 1.0, 64.0));
        let last = f32(max(count, 2) - 1);
        var sum = vec4f(0.0, 0.0, 0.0, 0.0);
        for (var i = 0; i < 64; i++) {
            if (i >= count) { break; }
            let t = f32(i) / last;
            sum += textureSample(screenTexture, samp, center + dir * (1.0 + power * t));
        }
        return sum / f32(count);
        `,
    },
];

/**
 * 特效在 `[start, end]` 内的进度（0 → 1）。
 *
 * Phira 的 `shockwave` 等效果靠 `progress` 推进动画：谱面通常自己写一条
 * 从 0 到 1 的 `progress` 事件；没写的时候（比如只写了个固定 duration 的
 * shockwave）就用这里按特效区间算出来的值兜底。
 */
function effectProgress(effect: EffectStartNode, beats: number): number {
    const end = effect.getEndTime();
    if (!end) return 0;
    const startBeats = TC.toBeats(effect.time);
    const endBeats = TC.toBeats(end);
    if (!(endBeats > startBeats)) return 0;
    return Math.min(1, Math.max(0, (beats - startBeats) / (endBeats - startBeats)));
}

/** 一个非 global 特效在 Z 轴上的作用范围 */
interface EffectWindow {
    from: number;
    to: number;
    /** 相交但不包含时是否「吞掉」交集 */
    exclusive: boolean;
    chain: EffectRequest[];
    /** 声明顺序：平局时后写的赢 */
    order: number;
}

/**
 * 挑出负责 `[from, to)` 这一段的特效。
 *
 * 同一段只能有一个特效（一个对象不能被两个着色器同时处理）：
 * - 区间互相包含 → 取更窄的（内层自己处理，外层负责剩下的部分）
 * - 只是相交、谁都不包含谁 → `exclusive` 的那个吞掉交集，否则取后声明的
 */
function pickWindow(windows: EffectWindow[], from: number, to: number): EffectWindow | null {
    const candidates = windows.filter(window => window.from <= from && window.to >= to);
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0]!;

    const swallowing = candidates.filter(window =>
        window.exclusive
        && candidates.some(other => other !== window && !(other.from >= window.from && other.to <= window.to)));
    if (swallowing.length > 0) {
        return swallowing.reduce((a, b) => (b.order > a.order ? b : a));
    }
    return candidates.reduce((a, b) => {
        const widthA = a.to - a.from;
        const widthB = b.to - b.from;
        if (widthB !== widthA) return widthB < widthA ? b : a;
        return b.order > a.order ? b : a;
    });
}

/**
 * 把 `[GPU_Z_BASE, GPU_Z_OVERLAY)` 按各特效的范围切成互不重叠的小段，
 * 每段带上负责它的特效（没有则为 `null`）。
 */
function splitZ(windows: EffectWindow[]): { from: number; to: number; window: EffectWindow | null }[] {
    const boundaries = new Set<number>([GPU_Z_BASE, GPU_Z_OVERLAY]);
    for (const window of windows) {
        if (window.from > GPU_Z_BASE && window.from < GPU_Z_OVERLAY) boundaries.add(window.from);
        if (window.to > GPU_Z_BASE && window.to < GPU_Z_OVERLAY) boundaries.add(window.to);
    }
    const sorted = [...boundaries].sort((a, b) => a - b);
    const segments: { from: number; to: number; window: EffectWindow | null }[] = [];
    for (let i = 0; i < sorted.length - 1; i++) {
        const from = sorted[i]!;
        const to = sorted[i + 1]!;
        if (!(to > from)) continue;
        segments.push({ from, to, window: pickWindow(windows, from, to) });
    }
    return segments;
}

/** 两条链是不是同一串请求（按对象身份比，够用且便宜） */
function sameChain(a: readonly EffectRequest[], b: readonly EffectRequest[]) {
    return a.length === b.length && a.every((item, i) => item === b[i]);
}

/** `blur` 展开成水平 + 垂直两趟（我们的特效链天然支持） */
const EFFECT_CHAINS: Record<string, (uniforms: EffectUniforms) => EffectRequest[]> = {
    // radius 缺省值写在这两个着色器自己的 `// %0.01%` 里
    blur: (uniforms) => [
        { shader: "#blur-x", uniforms },
        { shader: "#blur-y", uniforms },
    ],
};
// #enddefault

/** kipphi 的操作列表（`Op.OperationList`），编辑器的资源变更就是从它发出来的 */
type OperationList = Op.OperationList;

/** 渲染后端优先级 */
export type RendererPreference = "auto" | "webgpu" | "webgl1" | "canvas2d";

export interface PlayerOptions {
    /**
     * 渲染后端优先级：
     * - `auto`（默认）：WebGPU → WebGL 1 → Canvas 2D
     * - `webgpu`：明确想要 WebGPU（拿不到时同样会往后退）
     * - `webgl1`：优先 WebGL 1，不行再退 Canvas 2D
     * - `canvas2d`：只用 Canvas 2D
     */
    renderer?: RendererPreference;
    /** 复用外部创建好的 GPUDevice（仅 WebGPU 有效） */
    device?: unknown;
    /** GPU 图层的 z 范围，默认 `[0, 10]` */
    zRange?: [number, number];
    /**
     * 播放时是否**严格等背景视频解码**，默认 `false`
     *
     * 开了之后播放循环每帧先 `await prepareVideo()` 再画。代价很直接：
     * 拖进度条、暂停后逐帧看的时候，位置一直在变，解码永远追不上，于是每帧都要
     * 等满预算 —— 手感会明显变迟钝（实测拖条从跟手变成一卡一卡）。
     *
     * 所以默认关掉：实时预播放只要「尽快画出来」就够了，视频落后半帧没人看得出来。
     * 需要每帧都对得上（录制、导出）就走 {@linkcode Player.prepareVideo} 手动等，
     * 录制端本来就是这么干的。
     */
    strictVideoSync?: boolean;
}

// #default
/**
 * 资源适配器：谱面用到的贴图 / 视频 / 着色器都从这里取。
 *
 * 三个方法都是可选的——只做纯音频预览的宿主可以一个都不实现，
 * 只做 2D 预览的宿主可以只实现 `texture`。
 *
 * ```ts
 * player.use({
 *     texture: name => fetchImage(name),
 *     video: name => fetchVideo(name),
 *     shader: path => fetchShader(path),
 * });
 * await player.receive(chart);
 * ```
 */
export interface ResourceAdapter {
    /** 取一张贴图（名字与 `chart.scanAllTextures()` 里的一致） */
    texture?(name: string): Promise<ImageBitmap | null>;
    /** 取一段视频（名字与 `chart.scanAllVideos()` 里的一致） */
    video?(name: string): Promise<VideoFrameSource | null>;
    /** 取一个自定义特效着色器（路径与 `chart.scanAllShaders()` 一致，以 `/` 开头） */
    shader?(path: string): Promise<EffectShader | null>;
}
// #enddefault
/* #node {
// 资源适配器：Node 端没有 GPU，不需要着色器
export interface ResourceAdapter {
    // 取一张贴图（名字与 chart.scanAllTextures() 里的一致）
    texture?(name: string): Promise<ImageBitmap | null>;
    // 取一段视频（名字与 chart.scanAllVideos() 里的一致）
    video?(name: string): Promise<VideoFrameSource | null>;
}
} */

/**
 * 监听 `OperationList`，把编辑过程中新引用到的资源同步给播放器。
 *
 * 直接按住「会引入资源的操作类」：`onOperation` 会穿透复合操作、`UnionOperation`
 * 和 `LazyOperation`，被 `rewrite` 合并掉的变更也会按 `do` 通知一次。
 * 撤销时不需要做任何事——已经加载的资源不卸载。
 */
class ResourceSyncWatcher {
    private readonly hooks: { klass: Op.OperationClass; listener: Op.OperationListener<Op.OperationClass> }[] = [];

    constructor(
        private readonly player: Player,
        private readonly operations: OperationList,
    ) { }

    attach() {
        // 判定线换纹理
        this.hook(Op.JudgeLinePropChangeOperation, (operation, direction) => {
            if (direction === "do" && operation.field === "texture") {
                void this.player.loadTexture(operation.value as string);
            }
        });

        // #default
        // 新增特效 / 换着色器
        this.hook(Op.EffectAddOperation, (operation, direction) => {
            if (direction === "do") void this.player.loadShader(operation.effect.shader);
        });
        this.hook(Op.EffectPropChangeOperation, (operation, direction) => {
            if (direction === "do" && operation.field === "shader") {
                void this.player.loadShader(operation.value as string);
            }
        });
        // #enddefault

        // 视频通道换片：插入一段新值，或改某一段的值
        const isVideoName = (sequence: unknown) => sequence !== undefined && sequence === this.player.chart?.video.name;
        this.hook(Op.EventNodePairInsertOperation, (operation, direction) => {
            if (direction === "do" && isVideoName(operation.sequence)) {
                // 插入操作的 `value` 不会同步，值在节点上
                void this.player.loadVideo(operation.node.value as unknown as string);
            }
        });
        this.hook(Op.EventNodeValueChangeOperation, (operation, direction) => {
            if (direction === "do" && isVideoName(operation.node?.parentSeq)) {
                void this.player.loadVideo(operation.value as string);
            }
        });
    }

    detach() {
        for (const { klass, listener } of this.hooks) this.operations.offOperation(klass, listener);
        this.hooks.length = 0;
    }

    private hook<C extends Op.OperationClass>(klass: C, listener: Op.OperationListener<C>) {
        this.operations.onOperation(klass, listener);
        this.hooks.push({ klass, listener: listener as Op.OperationListener<Op.OperationClass> });
    }
}

export class Player extends EventTarget {
    canvas: HTMLCanvasElement;
    context: PlayContext2D;
    /**
     * 谱面自己的 UI 层（combo、进度条、曲名、线号、曲线）。
     * 它属于谱面的一部分，会被非 global 的特效处理到。
     */
    chartUIContext: PlayContext2D;
    /**
     * 覆盖层，**只放帧率和时间**。
     * GPU 模式下 z 高于所有谱面图层，因此永远不会被特效区间覆盖。
     */
    overlayContext: PlayContext2D;
    /**
     * GPU 上下文（仅浏览器）。
     * 为 null 时退回 Canvas 2D —— Node 端恒为 null。
     */
    readonly gpu: GPUContext2D | null = null;
    /** 浏览器端是否尝试走 GPU 后端，失败会自动退回 Canvas 2D */
    static gpuEnabled = true;
    /** 打开后在控制台输出每帧的 记录/提交 耗时，用来找卡顿 */
    static debugTiming = false;
    tinter: Tinter = new Tinter('line');
    chart: Chart;
    // #default
    audio: HTMLAudioElement;
    // #enddefault
    audioProcessor: AudioProcessor;
    // #default
    /**
     * 离线渲染用的时钟（秒，未加 offset）
     *
     * 设上之后 `time` 就不再读 `audio.currentTime`，而是用这个值——
     * 录制时逐帧推它即可，不用去 seek `<audio>`。
     * 传 `null` 恢复成跟随音频。
     */
    offlineTime: number | null = null;
    // #enddefault
    playing: boolean;
    background: ImageBitmap;
    blurredBackground: ProcessedTexture;
    noteSize: number;
    noteHeight: number;
    hitEffectSize: number;
    // soundQueue: SoundEntity[];
    lastBeats: number;
    lastRenderingBeats: number;


    greenLine: number = 0;

    currentCombo: number = 0;
    lastUncountedNNN: NNNOrTail | null = null;
    lastUncountedTailNNN: NNNOrTail | null = null;
    lastCountedBeats: number = 0;
    // #default
    lastRenderingRealTime: number = 0;
    renderedFrames: number = 0;
    lastMeasuredFPSStr: string = "N/A (N/A, longest N/A)";
    collectedFrameTime: number = 0;
    longestFrameTime: number = 0;
    renderedTextures: number = 0;
    /** 上一帧的 draw call 数（GPU 模式；Canvas 2D 恒为 0） */
    lastDrawCalls: number = 0;
    /** 上一帧跑过的特效着色器趟数（blur 这种两趟的算 2） */
    lastEffectCount: number = 0;
    /** 最近一个统计窗口内平均每帧的 draw call 数，显示用 */
    averageDrawCalls: number = 0;
    private drawCallsInWindow: number = 0;
    // #enddefault
    showsInfo = true;
    showsLineID = false;
    showsRenderingBaseline = false;
    showsLineCurve = false;
    curveFPS = 15;
    curveMinDuration = 4;
    /** In Seconds */
    baseOffset = -0.017;
    /**
     * 为渲染部分采用不同的偏移值（比如蓝牙耳机延迟高，容易音画不同步）
     */
    renderingOffset = 0;
    /**
     * 若设为真，则打击特效产生后会留在原地，而不是跟着判定线移动。
     * 
     * 这是本家标准行为，但是如果追求性能，可以设为false。
     * 
     * 在浏览器端，这个值默认就是false。
     */
    hitEffectNoFollows = !__IS_BROWSER;

    /**
     * 播放循环里是否严格等背景视频解码，见 {@linkcode PlayerOptions.strictVideoSync}
     *
     * 默认关：开着的话拖进度条会明显变迟钝。整个生命周期固定，所以要改就重建播放器。
     */
    readonly strictVideoSync: boolean = false;

    /**
     * 画出帧率 / 帧时间 / 时间码的覆盖层，默认关
     *
     * 就一个 if，几乎没有开销，所以**不进 options**，直接赋值就行：
     *
     * ```ts
     * player.showStats = true;
     * ```
     *
     * 用屏幕坐标画（不跟着谱面变换）。注意它是画进画面里的，录制导出前记得关掉。
     */
    showStats = false;

    heightRatio: number;

    
    textureMapping: Map<string, ImageBitmap> = new Map();
    videoMapping: Map<string, VideoFrameSource> = new Map();

    /* ---------------------------- 资源加载 ---------------------------- */

    /** 资源适配器，由 {@linkcode use} 设置 */
    private adapter: ResourceAdapter | null = null;
    /** 编辑操作监听，由 {@linkcode watch} 设置 */
    private resourceWatcher: ResourceSyncWatcher | null = null;
    private syncingResources = false;
    private syncPending = false;
    /** 已经提醒过的资源问题，同一个 key 只提一次 */
    private readonly warnedResources = new Set<string>();

    rootMatrix: Matrix33;
    baseMatrix: Matrix33;
    ratio: number;

    // 不使用无法寻路SVG滤镜的OffscreenCanvas
    // GPU 模式下第一项为 null（不需要中间画布），第二项是 LayerContext2D
    layers: [HTMLCanvasElement | null, PlayContext2D][] = new Array(10);
    

    public height: number;

    /**
     * 直接用构造函数只会得到 Canvas 2D —— 浏览器端的 GPU 后端需要 await 初始化，
     * 而构造函数不能是异步的。请改用 `await Player.create(...)`。
     *
     * 这个构造函数保留下来是给 Node 渲染端（skia-canvas）和「我就是想用 2D」的场景用的。
     */
    constructor(
        canvas: HTMLCanvasElement,
        audioProcessor: AudioProcessor,
        // #default
        audio: HTMLAudioElement,
        // #enddefault
        background: ImageBitmap,
        public respack: Respack,
        options: PlayerOptions & { gpu?: GPUContext2D } = {},
    ) {
        super();
        this.canvas = canvas
        this.audioProcessor = audioProcessor;

        // #default
        this.gpu = options.gpu ?? null;
        // 严格等视频解码：见 PlayerOptions.strictVideoSync（默认关，开着拖条会迟钝）
        this.strictVideoSync = options.strictVideoSync ?? false;
        // #enddefault

        if (this.gpu) {
            // 图层直接就是 GPU 图层，按 z 排序，不再需要中间画布
            this.context = this.gpu.createLayer(GPU_Z_BASE);
            this.overlayContext = this.gpu.createLayer(GPU_Z_OVERLAY);
            for (const index of NO_LAYER_INDICES) {
                this.layers[index] = [null, this.gpu.createLayer(index)];
            }
            this.chartUIContext = this.layers[CHART_UI_LAYER]![1];
            this.gpu.addShaders(BUILTIN_EFFECT_SHADERS);
        } else {
            this.context = canvas.getContext("2d");
            this.overlayContext = this.context;
            const newLayer = () => {
                const cvs = document.createElement("canvas");
                cvs.width = canvas.width;
                cvs.height = canvas.height;
                return [cvs, cvs.getContext("2d")] as [HTMLCanvasElement, CanvasRenderingContext2D];
            }
            for (const index of NO_LAYER_INDICES) {
                this.layers[index] = newLayer();
            }
            this.chartUIContext = this.layers[CHART_UI_LAYER]![1];
        }
        this.background = background;

        this.blurringRadius = 50;

        this.useNewAspect();

        this.playing = false;
        this.noteSize = NOTE_WIDTH;
        this.noteHeight = NOTE_HEIGHT;
        this.hitEffectSize = this.noteSize * 1.3;
        // #default
        this.audio = audio;
        this.audio.addEventListener("ended", () => {
            this.playing = false;
        })
        // #enddefault
    }

    /**
     * 创建播放器的唯一推荐入口。
     *
     * 浏览器端按 `options.renderer` 选后端（默认 `auto`：WebGPU → WebGL 1 → Canvas 2D），
     * 失败会自动往后退，不会抛错；Node 端固定 Canvas 2D。
     *
     * ```ts
     * const player = await Player.create(canvas, audioProcessor, audio, background, respack, {
     *     renderer: "webgl1",
     * });
     * ```
     */
    static async create(
        canvas: HTMLCanvasElement,
        audioProcessor: AudioProcessor,
        // #default
        audio: HTMLAudioElement,
        // #enddefault
        background: ImageBitmap,
        respack: Respack,
        options: PlayerOptions = {},
    ): Promise<Player> {
        // #default
        const preference = options.renderer ?? "auto";
        if (Player.gpuEnabled && preference !== "canvas2d") {
            try {
                const gpu = await AnyGPUContext2D.create({
                    canvas,
                    // 'webgl1' 就只试 WebGL 1；其余交给 auto（WebGPU 失败会自动退 WebGL 1）
                    backend: preference === "webgl1" ? "webgl1" : "auto",
                    zRange: options.zRange ?? [0, GPU_Z_MAX],
                    clearColor: [0, 0, 0, 0],
                    device: options.device,
                });
                return new Player(canvas, audioProcessor, audio, background, respack, { ...options, gpu });
            } catch (error) {
                if (preference !== "auto") {
                    console.warn(`[Player] ${preference} 后端不可用，退回 Canvas 2D:`, error);
                }
            }
        }
        // #enddefault
        // #default
        return new Player(canvas, audioProcessor, audio, background, respack, { ...options, gpu: null });
        // #enddefault
        /* #node {
        return new Player(canvas, audioProcessor, background, respack, { ...options, gpu: null });
        } */
    }

    useNewAspect() {
        const canvas = this.canvas;
        const height = this.height = canvas.height / canvas.width * STANDARD_WIDTH;
        this.heightRatio = height === STANDARD_HEIGHT ? 1 : height / STANDARD_HEIGHT;
        const ratio = this.ratio = canvas.width / STANDARD_WIDTH
        this.rootMatrix = this.baseMatrix = identity.scale(ratio, ratio);
        this.cameraRatio = this._cameraRatio; // 原地磕哒
        if (this.gpu) this.gpu.resize(canvas.width, canvas.height);
        for (const layer of this.layers) {
            if (!layer || !layer[0]) continue;
            layer[0].height = canvas.height;
            layer[0].width = canvas.width;
        }
    }
    override addEventListener(type: "drawn" | "play" | "pause", listener: (e: Event) => void, options?: EventListenerOptions): void {
        super.addEventListener(type, listener, options);
    }
    /** 当前渲染后端的展示名（Node 端恒为 Canvas 2D） */
    get rendererName(): string {
        if (!this.gpu) return "Canvas 2D";
        return this.gpu.kind === "webgpu" ? "WebGPU" : "WebGL 1";
    }
/* #node {

    audioCurrentTime: number = 0;
    playbackRate: number = 1;
} */
    get time(): number {
        // #default
        // 录制时走 offlineTime，正常播放时跟随音频
        const current = this.offlineTime ?? this.audio.currentTime ?? 0;
        return current - this.chart.offset / 1000 + this.baseOffset;
        // #enddefault
        /* #node {
        return this.audioCurrentTime - this.chart.offset / 1000 + this.baseOffset;
        } */
    }
    get beats(): number {
        return this.chart.timeCalculator.secondsToBeats(this.time)
    }
    set renderingBeats(value: number) {
        const renderingTime = this.chart.timeCalculator.toSeconds(value);
        const time = renderingTime - this.renderingOffset * this.audio.playbackRate;
        this.audio.currentTime = time + this.chart.offset / 1000 - this.baseOffset;
    }
    get renderingBeats(): number {
        // #default
        return this.chart.timeCalculator.secondsToBeats(this.renderingTime);
        // #enddefault
        /* #node {
        return this.chart.timeCalculator.secondsToBeats(this.time + this.renderingOffset * this.playbackRate)
        } */
    }
    get renderingTime(): number {
        // #default
        return this.time + this.renderingOffset * this.audio.playbackRate;
        // #enddefault
        /* #node {
        return this.time + this.renderingOffset * this.playbackRate;
        } */
    }
    _blurringRadius: number = 50;

    get blurringRadius() {
        return this._blurringRadius;
    }

    set blurringRadius(radius: number) {
        this._blurringRadius = radius;
        const { canvas, background } = this;
        const bgCanvas = new OffscreenCanvas(canvas.width, canvas.height);
        const bgContext = bgCanvas.getContext("2d");
        bgContext.filter = `blur(${radius}px)`
        bgContext.drawImage(background, 0, 0, canvas.width, canvas.height);
        this.blurredBackground = bgCanvas;
        createImageBitmap(bgCanvas).then(img => {
            this.blurredBackground = img;
        })
    }
    _cameraRatio = 1;
    set cameraRatio(ratio: number) { 
        this._cameraRatio = ratio;
        const hw = STANDARD_WIDTH / 2;
        const hh = this.height / 2;
        this.baseMatrix = identity.scale(this.ratio, this.ratio)
            .translate(hw * (1 - ratio), hh * (1 - ratio))
            .scale(ratio, ratio)
    }
    get cameraRatio() { return this._cameraRatio; }

    /**
     * 计算当前combo。
     * 
     * 这是少有的一个非无状态的方法。
     * @param renderingBeats 
     */
    computeCombo(renderingBeats: number) {
        const {chart} = this;
        const beats = renderingBeats;
        let lastUncountedNNN = this.lastUncountedNNN || chart.nnnList.head.next;
        let lastUncountedTailNNN = this.lastUncountedTailNNN || chart.nnnList.head.next
        let lastCountedBeats = this.lastCountedBeats || 0;
        let combo = this.currentCombo;
        if (!this.playing || this.time <= 1) {
            combo = 0;
            lastUncountedNNN = chart.nnnList.head.next;
            lastUncountedTailNNN = chart.nnnList.head.next;
            lastCountedBeats = 0;
        }
        const countUntil = chart.nnnList.getNodeAt(beats);
        if (!TC.lt(countUntil.startTime, lastUncountedNNN.startTime)) {
            for (let node: NNNOrTail = lastUncountedNNN; node.type !== NodeType.TAIL && node !== countUntil; node = node.next) {
                const nns = node.noteNodes;
                const nnsLength = nns.length;
                for (let i = 0; i < nnsLength; i++) {
                    const nn = nns[i];
                    combo += nn.notes.reduce((num: number, note: Note) => num + (note.isFake ? 0 : 1), 0);
                }
            }
            this.lastUncountedNNN = countUntil;
        }
        const countHoldTailUntil = chart.nnnList.getNodeAt(beats);
        if (!TC.lt(countHoldTailUntil.startTime, lastUncountedNNN.startTime)) {
            let uncounted = null;
            for (let node: NNNOrTail = lastUncountedTailNNN; node.type !== NodeType.TAIL && node !== countHoldTailUntil; node = node.next) {
                const hns = node.holdNodes;
                const len = hns.length;
                for (let i = 0; i < len; i++) {
                    const hn = hns[i];
                    const notes = hn.notes;
                    const l = notes.length;
                    let j = 0;
                    for (; j < l; j++) {
                        const note = notes[j];
                        if (TC.toBeats(note.endTime) > beats) {
                            if (!uncounted) {
                                uncounted = node;
                            }
                        } else {
                            break;
                        }
                    }
                    for (; j < l; j++) {
                        const note = notes[j];
                        if (note.isFake || TC.toBeats(note.endTime) < lastCountedBeats) {
                            continue;
                        }
                        combo++;
                    }
                }
            }
            this.lastUncountedTailNNN = uncounted || countHoldTailUntil;
            this.lastCountedBeats = beats;
        }
        this.currentCombo = combo;
    }
    private map: Map<string, JudgeLine[]>; 
    /**
     * 当前这一刻在放哪个背景视频
     *
     * @returns 视频源，以及它在**视频自己**时间轴上的位置（秒）
     */
    private videoAt(
        renderingBeats: number,
        renderingTime: number
    ): { source: VideoFrameSource; time: number } | null {
        const chart = this.chart;

        if (!chart?.video) return null;

        const node = chart.video.name.getNodeAt(renderingBeats);
        const name = node.value?.trim();

        if (!name) return null;

        const source = this.videoMapping.get(name);

        if (!source) return null;

        return { source, time: renderingTime - chart.timeCalculator.toSeconds(TC.toBeats(node.time)) };
    }

    /**
     * 等背景视频把 `time` 那一帧解出来
     *
     * 解码是异步的，而 {@linkcode render} 是同步的：不等的话那一帧只能拿到
     * 「已经解出来的帧」，常常就是第一帧 —— 背景视频看着像卡住了。
     *
     * - 播放循环在 `strictVideoSync` 下每帧都会调
     * - 录制端每帧手动调（`await player.prepareVideo()`）
     * - 没有背景视频、或者已经解好时立刻返回，几乎不花钱
     *
     * @param time 谱面时间轴上的秒数，缺省当前渲染时刻
     */
    async prepareVideo(time: number = this.renderingTime): Promise<void> {
        const chart = this.chart;

        if (!chart) return;

        const found = this.videoAt(chart.timeCalculator.secondsToBeats(time), time);

        if (!found) return;

        await found.source.prepare(found.time);
    }

    // #default
    /**
     * 帧率 / 帧时间 / 时间码的覆盖层
     *
     * 用**屏幕坐标**（identity 变换）画：画布比例变、相机怎么转，这两行字都待在
     * 左上角和正下方。以前是乘 `baseMatrix` 画的，跟着谱面一起缩放。
     */
    private drawStats(frameMs: number): void {
        const hud = this.overlayContext;
        const canvas = this.canvas;
        const now = performance.now();

        this.renderedFrames++;
        this.collectedFrameTime += frameMs;
        this.longestFrameTime = Math.max(this.longestFrameTime, frameMs);

        if (now - this.lastRenderingRealTime >= 1000) {
            const average = this.collectedFrameTime / this.renderedFrames;

            this.lastMeasuredFPSStr = `${(this.renderedFrames * 1000 / (now - this.lastRenderingRealTime)).toFixed(1)} fps`
                + ` (avg ${average.toFixed(2)}ms, max ${this.longestFrameTime.toFixed(2)}ms)`;
            this.averageDrawCalls = this.drawCallsInWindow / this.renderedFrames;
            this.lastRenderingRealTime = now;
            this.renderedFrames = 0;
            this.collectedFrameTime = 0;
            this.longestFrameTime = 0;
            this.drawCallsInWindow = 0;
        }

        // 文本每帧重画，但内容一秒才变一次，这样不会每帧都重新光栅化一张文字纹理
        const drawCallInfo = this.gpu ? `, ${this.averageDrawCalls.toFixed(1)} dc` : "";
        // 着色器趟数一般不会剧烈变化，这里直接用当帧的值，不做窗口平均
        const effectInfo = this.gpu ? `, ${this.lastEffectCount} shader` : "";

        hud.save();
        hud.setTransform(identity);
        hud.font = "20px phigros";
        hud.fillStyle = "#ddd";

        // 左上角：帧率 + 帧时间
        hud.textAlign = "left";
        hud.textBaseline = "top";
        hud.fillText(
            this.lastMeasuredFPSStr
            + `(${this.renderedTextures} tex${drawCallInfo}${effectInfo}, ${this.rendererName})`,
            16,
            16
        );

        // 正下方：时间码
        hud.textAlign = "center";
        hud.textBaseline = "bottom";
        hud.fillText(
            `${this.time.toFixed(2)}s ${this.renderingBeats.toFixed(2)}b`,
            canvas.width / 2,
            canvas.height - 16
        );
        hud.restore();
    }
    // #enddefault

    /** 画一帧（同步）。背景视频要提前用 {@linkcode prepareVideo} 等解码 */
    render() {
        if (!ENABLE_PLAYER) {
            return;
        }

        // #default
        this.map = new Map();
        const start = performance.now();
        this.renderedTextures = 0;
        // #enddefault
        const context = this.context;
        const chart = this.chart;
        const renderingBeats = this.renderingBeats;
        const renderingTime = this.renderingTime;

        const height = this.height;
        const hh = height / 2;
        context.setTransform(this.baseMatrix)
        context.translate(STANDARD_WIDTH / 2, hh);
        context.save();
        if (!this.gpu) {
            // GPU 模式下每帧 flush 时会自动重新开始，不需要手动清图层
            for (const layer of this.layers) {
                if (!layer) continue;
                const ctx = layer[1];
                ctx.setTransform(this.rootMatrix);
                ctx.clearRect(0, 0, STANDARD_WIDTH, height);
            }
            // 虽然还要加个图片，但是如果不clear，在Node环境下，会泄漏很多内存
            context.clearRect(-STANDARD_WIDTH, -height, STANDARD_WIDTH * 2, height * 2);
        }
        context.drawImage(this.blurredBackground, -STANDARD_WIDTH / 2, -hh, STANDARD_WIDTH, height);
        // 涂灰色（背景变暗）
        context.fillStyle = "#0008";
        context.fillRect(-27000, -18000, 54000, 36000);

        // 注意这里是同步的：视频帧要在这之前用 prepareVideo() 等好
        (() => {
            if (!chart.video) {
                return;
            }
            const tinter = this.tinter;
            const timeCalculator = this.chart.timeCalculator;
            const videoNode = chart.video.name.getNodeAt(renderingBeats);
            const video = videoNode.value;
            const videoScale = videoNode.scale;
            const dim = chart.video.dim.getValueAt(renderingBeats);
            const alpha = chart.video.alpha.getValueAt(renderingBeats);
            const name = video.trim();
            if (name === "" || !this.videoMapping.has(name)) {
                return;
            }
            const videoEle = this.videoMapping.get(name);
            const videoTime = renderingTime - timeCalculator.toSeconds(TC.toBeats(videoNode.time));
            const fr = videoEle.getFrame(videoTime);
            if (!fr) {
                return;
            }
            // 注意 save/restore 必须配对：GPU 模式下 tint 也在状态机里，
            // 提前 return 会把 dim/alpha 泄漏到后面的判定线和音符上
            context.save()
            context.globalAlpha = alpha; // 不用除以255
            tinter.setDim(context, dim);
            const origWidth = fr.displayWidth;
            const origHeight = fr.displayHeight;
            switch (videoScale) {
                case VideoScale.cropCenter:{
                    const ratio = (origWidth / origHeight) > (STANDARD_WIDTH / height) ? (height / origHeight) : (STANDARD_WIDTH / origWidth);
                    const h = origHeight * ratio;
                    const w = origWidth * ratio;
                    context.drawImage(fr, -w / 2, -h / 2, w, h);
                    break;
                }
                case VideoScale.fit:{
                    context.drawImage(fr, -STANDARD_WIDTH / 2, -height / 2, STANDARD_WIDTH, height);
                    break;
                }
                case VideoScale.inside:{
                    const ratio = (origWidth / origHeight) < (STANDARD_WIDTH / height) ? (height / origHeight) : (STANDARD_WIDTH / origWidth);
                    const h = origHeight * ratio;
                    const w = origWidth * ratio;
                    context.drawImage(fr, -w / 2, -h / 2, w, h);
                }
            }
            
            context.restore()
        })();


        // 画出渲染范围圆
        context.strokeStyle = "#66ccff";
        context.beginPath();
        context.arc(0, 0, RENDER_SCOPE, 0, 2 * Math.PI);
        context.stroke()
        context.restore()

        // 打击特效图层在渲染中从不改变变换矩阵，而Note图层的矩阵一直与判定线的同步
        this.layers[HIT_EFFECT_LAYER][1].setTransform(this.baseMatrix);

        context.save()

        context.strokeStyle = "#FFFFFF"
        // drawLine(context, -1350, 0, 1350, 0)
        // drawLine(context, 0, 900, 0, -900);
        context.restore();

        
        // console.log("rendering")
        const lineQueue = [...chart.judgeLines].sort((a, b) => (a.zOrder ?? 0) - (b.zOrder ?? 0));
        for (let line of this.chart.orphanLines) {
            this.precalculate(identity.translate(STANDARD_WIDTH / 2, hh).scale(1, -this.heightRatio), line, renderingBeats, renderingTime);
        }
        for (let line of lineQueue) {
            if (line.optimized) {
                continue;
            }
            context.save();
            this.renderLine(line, renderingBeats, renderingTime);
            context.restore();
        }
        context.save()
        // drawLine(hitContext, 0, 900, 1350, 0);

        if (!this.gpu) {
            // GPU 模式下图层各自带 z，交给 GPU 排序，不需要手动合成
            context.resetTransform();
            for (const layer of this.layers) {
                if (!layer) continue;
                context.drawImage(layer[0], 0, 0, this.canvas.width, this.canvas.height);
            }
        }
        context.restore()

        if (this.showsLineCurve) {
            this.renderLineCurve(renderingBeats);
        }
        if (this.showsLineID) {
            this.renderLineIDs();
        }

        // 谱面自己的 UI（combo/进度条/曲名…）：归在谱面图层里，会被非 global 的特效处理到
        const chartUI = this.chartUIContext;
        if (this.showsInfo) {
            chartUI.save()
            const setTransformAlphaScaleColor = (lineOrNull: JudgeLine | null, fill: RGB, transform: Matrix33 = identity) => {
                if (!lineOrNull) {
                    chartUI.setTransform(this.baseMatrix.transform(transform).translate(STANDARD_WIDTH / 2, hh));
                } else {
                    chartUI.setTransform(this.baseMatrix.transform(transform).transform(lineOrNull.renderMatrix).scale(lineOrNull.scaleX, lineOrNull.scaleY));
                    chartUI.scale(1, -1);
                    chartUI.globalAlpha = lineOrNull.alpha / 255;
                }
                setColor(lineOrNull, fill)
            }
            const setColor = (lineOrNull: JudgeLine | null, fill: RGB) => {
                if (!lineOrNull) {
                    chartUI.fillStyle = rgb(fill[0], fill[1], fill[2]);
                } else {
                    const color = lineOrNull.color;
                    chartUI.fillStyle = rgb(fill[0] * color[0] / 255, fill[1] * color[1] / 255, fill[2] * color[2] / 255);
                }
            }
            this.computeCombo(renderingBeats);
            const WHITE = [255, 255, 255] as RGB;
            chartUI.font = "32px phigros"
            chartUI.textAlign = "left";

            const title = chart.name;
            const level = chart.level;
            const combo = this.currentCombo;
            const hw = STANDARD_WIDTH / 2;

            // name
            setTransformAlphaScaleColor(chart.nameAttach, WHITE, identity.translate(-hw + 43, hh - 34))
            chartUI.fillText(title, 0, 0);

            // level
            chartUI.textAlign = "right";
            setTransformAlphaScaleColor(chart.levelAttach, WHITE, identity.translate(hw - 43, hh - 34))
            chartUI.fillText(level, 0, 0);

            chartUI.font = "40px phigros";
            // score
            const score = combo / chart.maxCombo * 100_0000;
            const text = score.toFixed(0).padStart(7, "0")
            chartUI.textBaseline = "top";
            setTransformAlphaScaleColor(chart.scoreAttach, WHITE, identity.translate(hw - 39, -hh + 30))
            chartUI.fillText(text, 0, 0);

            // pause
            setTransformAlphaScaleColor(chart.pauseAttach, WHITE, identity.translate(-hw + 39, -hh + 30))
            chartUI.fillRect(0, 2, 8, 30)
            chartUI.fillRect(16, 2, 8, 30)

            // bar
            const progress = this.time / chart.duration;
            const barWidth = progress * STANDARD_WIDTH;
            setTransformAlphaScaleColor(chart.barAttach, [170, 170, 170], identity.translate(-hw, -hh));
            chartUI.fillRect(0, 0, barWidth, 8)
            chartUI.fillStyle = "#fff"

            chartUI.fillRect(barWidth, 0, 2, 8)

            if (combo >= 3) { // combo(number)
                chartUI.textAlign = "center";
                chartUI.textBaseline = "alphabetic";

                chartUI.font = "64px phigros"
                setTransformAlphaScaleColor(chart.combonumberAttach, WHITE, identity.translate(0, -hh + 50))
                chartUI.fillText(combo.toString(), 0, 20);

                chartUI.font = "24px phigros";
                setTransformAlphaScaleColor(chart.comboAttach, WHITE, identity.translate(0, -hh + 95))
                chartUI.fillText(COMBO_TEXT, 0, 0);


            }
            chartUI.restore();
        }
        // 真正的覆盖层：只放帧率和时间，z 高于所有谱面图层，永远不受特效影响
        // #default
        if (this.showStats) this.drawStats(performance.now() - start);
        // #enddefault

        // #default
        // 收集到的绘制在这里一次性排序、合批、实例化绘制，然后清空图层记录
        // 特效要在 flush 前设置好：区间内的图层会先进离屏纹理再过着色器
        this.applyEffects(renderingBeats);
        const flushStart = performance.now();
        const stats = this.gpu?.flush();
        // draw call 数每帧都记（flush 本来就为了合批算过一遍，这里是白拿的）
        this.lastDrawCalls = stats?.batches ?? 0;
        this.lastEffectCount = stats?.effects ?? 0;
        this.drawCallsInWindow += this.lastDrawCalls;
        if (Player.debugTiming) {
            const end = performance.now();
            console.log(`[player] 帧 ${(end - start).toFixed(1)}ms`
                + `（记录 ${(flushStart - start).toFixed(1)}ms / 提交 ${(end - flushStart).toFixed(1)}ms，`
                + `实例 ${stats?.instances ?? 0}，批次 ${stats?.batches ?? 0}）`);
        }
        // #enddefault

        this.dispatchEvent(new Event("drawn"));

        // this.soundQueue = [];
        
        // console.timeEnd("render")
    }
    precalculate(matrix: Matrix33, judgeLine: JudgeLine, beats: number, seconds: number) {
        
        const timeCalculator = this.chart.timeCalculator
        const alpha = judgeLine.getStackedValueBySeconds("alpha", beats, seconds, timeCalculator);
        if (judgeLine.nnLists.size === 0 && judgeLine.hnLists.size === 0 && alpha <= 0 && judgeLine.children.size === 0 && !judgeLine.hasAttachUI) {
            judgeLine.optimized = true;
            return;
        } else {
            judgeLine.optimized = false;
        }
        const x = judgeLine.getStackedValueBySeconds("moveX", beats, seconds, timeCalculator);
        const y = judgeLine.getStackedValueBySeconds("moveY", beats, seconds, timeCalculator);
        const theta = judgeLine.getStackedValueBySeconds("rotate", beats, seconds, timeCalculator) * Math.PI / 180;
        judgeLine.moveX = x;
        judgeLine.moveY = y;
        judgeLine.rotate = theta;
        judgeLine.alpha = alpha;
        const {x: transformedX, y: transformedY} = new Coordinate(x, y).mul(matrix);

        
        const ratio = this.heightRatio;
        judgeLine.transformedX = transformedX;
        judgeLine.transformedY = transformedY;
        if (this.showsLineID) {
            const map = this.map;
            const k = Math.round(transformedX) + "," + Math.round(transformedY);
            if (map.has(k)) {
                map.get(k)!.push(judgeLine);
            } else {
                map.set(k, [judgeLine]);
            }
        }
        const renderMatrix = judgeLine.rotatesWithFather
            ? matrix
                .translate(x, y)
                .rotate(-theta)
            : identity
                .translate(transformedX, transformedY)
                .scale(1, -1)
                .rotate(-theta);
        //console.log( judgeLine.id, transformedX, transformedY, matrix)
        // Cache a matrix
        judgeLine.renderMatrix = renderMatrix;
        const forChildren = renderMatrix.scale(1, ratio);
        if (judgeLine.children.size !== 0) {
            for (let line of judgeLine.children) {
                this.precalculate(forChildren, line, beats, seconds);
            }
        }
    }
    /**
     * 计算判定线在某时刻的矩阵。特别适用于过去时。
     * 
     * 在当前代码，这个方法仅用在开启打击特效滞留时。
     * 
     * （KPP尽可能遵守“无状态渲染”，不会缓存打击特效在之前的位置。）
     * @param judgeLine 
     * @param beats 
     */
    calculateLineMatrix(judgeLine: JudgeLine, beatsOrSeconds: number, useSeconds: boolean = false) {
        const seconds = useSeconds ? beatsOrSeconds : this.chart.timeCalculator.toSeconds(beatsOrSeconds);
        const beats = useSeconds ? this.chart.timeCalculator.secondsToBeats(seconds) : beatsOrSeconds;
        return this._calculateLineMatrix(judgeLine, beats, seconds).scale(1, 1 / this.heightRatio);
    }
    _calculateLineMatrix(judgeLine: JudgeLine, beats: number, seconds: number) {
        const hw = STANDARD_WIDTH / 2;
        const hh = this.height / 2;
        const ratio = this.heightRatio;
        const x = judgeLine.getStackedValue("moveX", beats);
        const y = judgeLine.getStackedValue("moveY", beats);
        const theta = judgeLine.getStackedValue("rotate", beats) * Math.PI / 180;
        const father = judgeLine.father;
        const parentMatrix = father ? this._calculateLineMatrix(father, beats, seconds) : identity.translate(hw, hh).scale(1, -ratio);
        if (judgeLine.rotatesWithFather) {
            return parentMatrix.translate(x, y).rotate(-theta).scale(1, ratio);
        } else {
            const {x: tx, y: ty} = new Coordinate(x, y).mul(parentMatrix);
            return identity.translate(tx, ty).scale(1, -1).rotate(-theta).scale(1, ratio);
        }
    }
    renderLineCurve(beats: number) {
        // 属于谱面 UI，跟着谱面一起被特效处理
        const context = this.chartUIContext;
        const timeCalculator = this.chart.timeCalculator;
        const curveFPS = this.curveFPS;
        const line = this.chart.judgeLines[this.greenLine];
        const curveMinDuration = this.curveMinDuration;
        // const beatss: number[] = [];
        // const beatss2: number[] = [];
        // const layers = line.eventLayers;
        // const len = layers.length;
        // for (const type of ["moveX", "moveY"] as const) {
        //     for (let i = 0; i < len; i++) {
        //         const layer = layers[i];
        //         if (!layer) {
        //             continue;
        //         }
        //         const seq = layer[type];
        //         if (!seq) {
        //             continue;
        //         }
        //         const node = seq.getNodeAt(beats);
        //         if (node) {
        //             beatss.push(TC.toBeats(node.time));
        //             const endNode = node.next;
        //             if (endNode.type !== NodeType.TAIL) {
        //                 beatss2.push(TC.toBeats(endNode.time));
        //             }
        //         }
        //     }
        // }
        // const toStartAt = Math.min(Math.max(...beatss), Math.floor(beats) - curveMinDuration / 2);
        // const toEndAt =  Math.max(Math.min(...beatss2), Math.floor(beats) + curveMinDuration / 2);
        const toStartAt = Math.max(Math.floor(beats) - curveMinDuration / 2, 0);
        const toEndAt = Math.min(Math.ceil(beats) + curveMinDuration / 2, this.chart.effectiveBeats);
        const startSecs = Math.round(timeCalculator.toSeconds(toStartAt) * curveFPS) / curveFPS;
        const endSecs = timeCalculator.toSeconds(toEndAt);
        const duration = endSecs - startSecs;
        const frames = Math.round(duration * curveFPS);
        context.save();
        for (let i = 0; i < frames; i++) {
            const secs = startSecs + i / curveFPS;
            const matrix = this.calculateLineMatrix(line, secs, true);
            context.setTransform(this.baseMatrix.transform(matrix));
            context.fillStyle = `hsl(${i / frames * 360}, 100%, 50%)`;
            context.beginPath();
            context.moveTo(CURVE_NODE_SHAPE[0][0], CURVE_NODE_SHAPE[0][1]);
            for (let p = 1; p < CURVE_NODE_SHAPE.length; p++) {
                context.lineTo(CURVE_NODE_SHAPE[p][0], CURVE_NODE_SHAPE[p][1]);
            }
            context.closePath();
            context.fill();
        }
        context.restore();
    }
    renderLineIDs() {
        const context = this.chartUIContext;
        const map = this.map;
        context.save();
        context.setTransform(this.baseMatrix);
        context.font = "30px phigros"
        context.fillStyle = "white";
        for (const [_, lines] of map) {
            const x = lines[0].transformedX;
            const y = lines[0].transformedY;
            const ids = lines.map(line => line.id);
            ids.sort((a, b) => a - b);
            const len = ids.length;
            const segs: string[] = [];
            let prev = ids[0];
            let starting = prev;
            for (let i = 1; i < len; i++) {
                const cur = ids[i];
                if (cur !== prev + 1) {
                    segs.push(prev === starting ? starting.toString() : `${starting}~${prev}`);
                    starting = cur;
                }
                prev = cur;
            }
            segs.push(prev === starting ? prev.toString() : `${starting}~${prev}`);
            context.fillText(segs.join(", "), x, y + 40);
        }
    }
    renderLine(judgeLine: JudgeLine, beats: number, seconds: number) {
        const context = this.context;
        const respack = this.respack;
        const timeCalculator = this.chart.timeCalculator;
        const alpha = judgeLine.alpha;
        const theta = judgeLine.rotate;
        const myMatrix = judgeLine.renderMatrix;
        const transformedX = judgeLine.transformedX;
        const transformedY = judgeLine.transformedY;
        const mat = this.baseMatrix.transform(myMatrix).scale(1, -1)
        context.setTransform(mat);
        this.layers[HOLD_LAYER][1].setTransform(mat);
        this.layers[DRAG_LAYER][1].setTransform(mat);
        this.layers[TAP_LAYER][1].setTransform(mat);
        this.layers[FLICK_LAYER][1].setTransform(mat);
        this.layers[TEXTURE_BOUNDS_LAYER][1].setTransform(mat);

        // Draw Line
        const scaleX = judgeLine.extendedLayer.scaleX.getValueAtBySecs(beats, seconds, timeCalculator);
        const scaleY = judgeLine.extendedLayer.scaleY.getValueAtBySecs(beats, seconds, timeCalculator);
        judgeLine.scaleX = scaleX;
        judgeLine.scaleY = scaleY;
        const anchor = judgeLine.anchor;
        // console.log(scaleX, scaleY, anchor)

        let textureName = judgeLine.texture;
        if (textureName !== "line.png" && !this.textureMapping.get(textureName)) {
            textureName = "line.png";
        }

        const hasText = !!judgeLine.extendedLayer.text;
        const hasUIAttached = judgeLine.hasAttachUI;


        if (hasText && alpha > 0) {
            const textContent = judgeLine.extendedLayer.text.getValueAtBySecs(beats, seconds, timeCalculator) as string;
            context.save();
            context.fillStyle = rgba(...judgeLine.extendedLayer.color?.getValueAtBySecs(beats, seconds, timeCalculator) ?? [255, 255, 255], alpha);
            context.globalAlpha = alpha / 255;
            context.font = "54px phigros";
            context.scale(scaleX, scaleY);
            context.textAlign = "center";
            context.textBaseline = "middle";
            const metrics = context.measureText(textContent);
            const height = metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent;
            const width = metrics.width;
            context.fillText(textContent, width * (-anchor[0] + 0.5), height * (anchor[1] - 0.5));
            context.restore();
        }
        if (!hasText && !hasUIAttached && alpha > 0) {
            if (textureName === "line.png") {
                const lineColor: RGB = judgeLine.color = judgeLine.extendedLayer.color?.getValueAtBySecs(beats, seconds, timeCalculator) ?? [200, 200, 120];
                context.fillStyle = rgba(...(this.greenLine === judgeLine.id ? ([100, 255, 100] as RGB) : lineColor), alpha / 255)
                const scaledWidth = BASE_LINE_LENGTH * scaleX;
                const scaledHeight = LINE_WIDTH * scaleY;
                context.fillRect(-scaledWidth * anchor[0], -scaledHeight * anchor[1], scaledWidth, scaledHeight)
                // Fixes #1 on "kipphiApparatusLegacy"
            } else {
                context.save();
                context.scale(scaleX, scaleY);
                this.renderedTextures++;
                const lineColor: RGB = judgeLine.extendedLayer.color?.getValueAtBySecs(beats, seconds, timeCalculator) ?? [255, 255, 255];
                context.globalAlpha = alpha / 255;
                const bitmap = this.textureMapping.get(textureName);
                let texture: ImageBitmap | OffscreenCanvas = bitmap;
                // if (lineColor.some(x => x !== 255)) {
                //     texture = this.tintLineTexture(bitmap, lineColor);
                // }
                const width = bitmap.width;
                const height = bitmap.height;
                this.tinter.setTint(context, lineColor);
                context.drawImage(texture,
                    -width * anchor[0], -height * anchor[1], width, height);
                if (this.showsLineID || this.greenLine === judgeLine.id) {
                    const context = this.layers[TEXTURE_BOUNDS_LAYER][1];
                    context.strokeStyle = this.greenLine === judgeLine.id ? "rgb(100, 255, 100)" : "#FFF4";
                    context.lineWidth = 3;
                    context.setLineDash([20, 10, 5, 10]);
                    context.strokeRect(-width * anchor[0] * scaleX, -height * anchor[1] * scaleY, width * scaleX, height * scaleY);
                    context.setLineDash([10, 35])
                    drawLine(context, 0, 0, width * -anchor[0] * scaleX, height * -anchor[1] * scaleY)
                    drawLine(context, 0, 0, width * -anchor[0] * scaleX, height * (1-anchor[1]) * scaleY)
                    drawLine(context, 0, 0, width * (1-anchor[0]) * scaleX, height * -anchor[1] * scaleY)
                    drawLine(context, 0, 0, width * (1-anchor[0]) * scaleX, height * (1-anchor[1]) * scaleY)
                }
                context.restore();
            }
        } else if (hasUIAttached) {
            judgeLine.color = judgeLine.extendedLayer.color?.getValueAtBySecs(beats, seconds, timeCalculator) ?? [255, 255, 255];
        }

        // Draw Anchor

        // #default
        context.drawImage(Images.ANCHOR, -10, -10);
        // #enddefault
        // if (this.showsLineID) {
        //     context.save();
        //     context.fillStyle = "white";
        //     context.font = "40px phigros";
                
        //     context.fillText(`#${judgeLine.id} ${judgeLine.name.toLowerCase() === "untitled" ? "" : judgeLine.name}`, 10, 50);
        //     context.restore();
        // }

        judgeLine.computeCurrentFloorPosition(beats, timeCalculator);

        /** 判定线的法向量 */
        const nVector: Vector = getVector(theta)[1] // 奇变偶不变，符号看象限(
        const toCenter: Vector = [675 - transformedX, 450 - transformedY];
        // 法向量是单位向量，分母是1，不写
        /** the distance between the center and the line */
        const innerProd = innerProduct(toCenter, nVector);
        // 法向量朝向判定线正面
        // 现在法向量和内积的结果：如果正面对着中心点，内积为正，反之为负
        // 因此，innerProd的正负是重要的。如果offset为负，note在更低的地方被判定，“实际判定线”距离圆心更远
        // 所以distance要变大。因此，是innerProd - offset的绝对值。
        // （这是KPA家族代码中不可逾越的一座史山）
        const judgeLineCover = judgeLine.cover;
        const getYs = judgeLineCover ? (offset: number) => {
            
            const distance: number = Math.abs(innerProd - offset);
            let startY = distance - RENDER_SCOPE;
            const endY = distance + RENDER_SCOPE;
            if (startY < 0) startY = 0;
            return [startY, endY]
        } : (offset: number) => {
            
            const distance: number = Math.abs(innerProd - offset);
            const startY = distance - RENDER_SCOPE; // 显示线下音符
            const endY = distance + RENDER_SCOPE;
            return [startY, endY]
        }
        
        const drawScope = (endY: number, startY: number) => {
            if (endY<=1e-6) return
            context.save()
            context.font = "80px phigros";
            context.textBaseline = "middle";
            context.strokeStyle = "#66ccff"
            context.fillStyle = "#66ccff";
            context.lineWidth = 2
            drawLine(context, -1350, +endY, 1350, +endY)
            context.fillText(`${endY.toFixed(2)}e`, 0, +endY)
            drawLine(context, -1350, -endY, 1350, -endY)
            context.fillText(`${endY.toFixed(2)}e`, 0, -endY)
            context.strokeStyle = "#ffcc66";
            context.fillStyle = "#ffcc66";
            drawLine(context, -1350, +startY, 1350, +startY)
            context.fillText(`${startY.toFixed(2)}s`, 0, +startY);
            drawLine(context, -1350, -startY, 1350, -startY)
            context.fillText(`${startY.toFixed(2)}s`, 0, -startY);
            context.restore()
        }
        
        const hitFxDuration = respack.hitFxDuration;
        const hitRenderLimitSecs = this.renderingTime > hitFxDuration ? this.renderingTime - hitFxDuration : 0;
        const hitRenderLimitBeats = timeCalculator.secondsToBeats(hitRenderLimitSecs); // 渲染 ? 秒内的打击特效
        const holdTrees = judgeLine.hnLists;
        const noteTrees = judgeLine.nnLists;

        const showsRenderingBaseline = this.showsRenderingBaseline;
        // console.time("Updating integral");
        
        // console.timeEnd("Updating integral");
        
        for (let trees of [holdTrees, noteTrees]) {
            for (const [_, list] of trees) {
                const speedVal: number = list.speed;
                if (DRAWS_NOTES && alpha >= 0) {
                    // 渲染音符
                    // console.time("computeTimeRange")
                    const [startY, endY] = getYs(list.medianYOffset)
                    if (showsRenderingBaseline) {
                        drawScope(endY, startY);
                    }
                    const timeRanges = speedVal !== 0 ? judgeLine.computeTimeRange(beats, timeCalculator, startY / speedVal, endY / speedVal) : [[0, Infinity] as [number, number]];
                    list.timeRanges = timeRanges;

                    let lastTime: TimeT = [-1, 0, 0];
                    
                    // console.timeEnd("computeTimeRange");
                    // console.time("Rendering notes");
                    // console.log(timeRanges, startY, endY);
                    for (let range of timeRanges) {
                        const start = range[0];
                        const end = range[1];
                        // drawScope(judgeLine.getStackedIntegral(start, timeCalculator))
                        // drawScope(judgeLine.getStackedIntegral(end, timeCalculator))
                        
                        let noteNode: NNOrTail = list.getNodeAt(start, true);
                        while (noteNode.type !== NodeType.TAIL
                            && !TC.gt(noteNode.startTime, lastTime)) {
                            noteNode = noteNode.next;
                        }
                        // console.log(noteNode)
                        let startBeats: number;
                        // console.log(noteNode, end, start);
                        
                        while (!(noteNode.type === NodeType.TAIL)
                            && (startBeats = TC.toBeats(noteNode.startTime)) <= end
                        ) {
                            // 判断是否为多押
                            const isChord = noteNode.notes.length > 1
                                || noteNode.totalNode.noteNodes.some(node => node !== noteNode && node.notes.length)
                                || noteNode.totalNode.holdNodes.some(node => node !== noteNode && node.notes.length);
                            this.renderSameTimeNotes(noteNode, isChord, judgeLine, judgeLineCover, timeCalculator, beats);
                            lastTime = noteNode.startTime;
                            noteNode = noteNode.next;
                        }
                        
                    }
                    // console.timeEnd("Rendering notes");
                }
                // console.time("Rendering hit effects");
                // 打击特效
                if (beats > 0) {
                    if (list instanceof HNList) {
                        this.renderHoldHitEffects(myMatrix, list, beats, hitRenderLimitBeats, beats, timeCalculator)
                    } else {
                        this.renderHitEffects(myMatrix, list, hitRenderLimitBeats, beats, timeCalculator)
                    }
                }
                // console.timeEnd("Rendering hit effects");

            }

        }

        this.playSounds();
    }
    lastUnplayedNNNode: NNNode | NNNodeLike<NodeType.TAIL>;
    /**
     * 这个不一样，在低帧率情况下，由于帧与帧时间间隔过长，中间有些Note播放不了。
     * 
     * 我们把播放放到每条判定线的渲染里面来减少这种情况。
     * 
     * 因此这里才需要实时获取beats
     * @returns 
     */
    playSounds() {
        // #default
        if (!this.playing) {
            return;
        }
        // #enddefault
        const beats = this.beats;
        const timeCalculator = this.chart.timeCalculator;
        const lastNNN: NNNOrTail = this.lastUnplayedNNNode;
        const startingFrom = lastNNN.type === NodeType.TAIL ? Infinity : TC.toBeats(lastNNN.startTime);
        const needsReset = startingFrom >= beats || timeCalculator.segmentToSeconds(startingFrom, beats) > 0.05;
        // 超过0.05秒就会认为是快进过来的，这个时候，如果播放会很吵
        if (needsReset) {
            this.lastUnplayedNNNode = this.chart.nnnList.getNodeAt(beats)
            return;
        }
        let node: NNNOrTail = lastNNN;
        for (; node.type !== NodeType.TAIL && TC.toBeats(node.startTime) < beats; node = node.next) {
            // 内层循环会遮蔽 node，先把这一拍的拍数取出来
            const noteBeats = TC.toBeats(node.startTime);
            const nns = node.noteNodes;
            const hns = node.holdNodes;
            const nnl = nns.length;
            for (let i = 0; i < nnl; i++) {
                const node: NoteNode = nns[i];
                const nl = node.notes.length;
                for (let j = 0; j < nl; j++) {
                    const note = node.notes[j];
                    if (note.isFake) {
                        continue;
                    }
                    this.audioProcessor.playNoteSound(note.type, noteBeats);
                }
            }
            const hnl = hns.length;
            for (let i = 0; i < hnl; i++) {
                const node: NoteNode = hns[i];
                const nl = node.notes.length;
                for (let j = 0; j < nl; j++) {
                    const note: Note = node.notes[j];
                    if (note.isFake) {
                        continue;
                    }
                    this.audioProcessor.playNoteSound(NoteType.hold, noteBeats);
                }
            }
        }
        this.lastUnplayedNNNode = node;
    }
    renderHitEffects(matrix: Matrix33, tree: NNList, startBeats: number, endBeats: number, timeCalculator: TimeCalculator) {
        let noteNode = tree.getNodeAt(startBeats, true);
        const { respack, renderingTime, hitEffectNoFollows } = this;
        const hitContext = this.layers[HIT_EFFECT_LAYER][1];
        const line = tree.parentLine
        // console.log(hitContext.getTransform())
        const end = tree.getNodeAt(endBeats);
        const heSize = this.hitEffectSize;
        if (noteNode.type === NodeType.TAIL) {
            return;
        }
        while (noteNode !== end) {
            const beats = TC.toBeats(noteNode.startTime);
            const notes = noteNode.notes
            , len = notes.length
            for (let i = 0; i < len; i++) {
                const note = notes[i];
                if (note.isFake) {
                    continue;
                }
                const posX = note.positionX;
                const yo = note.yOffset * (note.above ? 1 : -1);
                const {x, y} = new Coordinate(posX, yo).mul(hitEffectNoFollows ? this.calculateLineMatrix(line, beats) : matrix);
                // console.log("he", x, y);
                const he = note.tintHitEffects;
                respack.hitDrawer(hitContext, x, y, heSize, renderingTime - timeCalculator.toSeconds(beats), he)
            }

            noteNode = <NoteNode>noteNode.next
        } 
    }
    /**
     * 
     * @param judgeLine 
     * @param tree 
     * @param beats 当前拍数
     * @param startBeats 
     * @param endBeats 截止拍数
     * @param timeCalculator 
     * @returns 
     */
    renderHoldHitEffects(matrix: Matrix33, tree: HNList, beats: number, startBeats: number, endBeats: number, timeCalculator: TimeCalculator) {
        const start = tree.getNodeAt(startBeats, true);
        const { respack, renderingTime, hitEffectNoFollows } = this;
        const hitContext = this.layers[HIT_EFFECT_LAYER][1];
        const line = tree.parentLine
        let noteNode = start;
        const end = tree.getNodeAt(endBeats);
        const hitEffectDuration = respack.hitFxDuration;
        const heSize = this.hitEffectSize;
        if (noteNode.type === NodeType.TAIL) {
            return;
        }
        // if (noteNode !== end)
        // console.log("start", start, startBeats, endBeats)
        while (noteNode !== end) {
            const notes = noteNode.notes
            , len = notes.length
            for (let i = 0; i < len; i++) {
                const note = notes[i];
                if (note.isFake) {
                    continue;
                }
                if (hitEffectNoFollows) {
                    const endTimeSecs = timeCalculator.toSeconds(Math.floor(TC.toBeats(note.endTime) * 2) / 2);
                    if (renderingTime > endTimeSecs + hitEffectDuration) {
                        continue;
                    }
                } else if (startBeats > TC.toBeats(note.endTime)) {
                    continue;
                }
                const posX = note.positionX;
                const yo = note.yOffset * (note.above ? 1 : -1);
                const noteStartBeats = TC.toBeats(note.startTime);
                let beatsToRender = Math.floor((Math.min(beats, TC.toBeats(note.endTime)) - noteStartBeats - 0.01) * HOLD_HE_SPEED) / HOLD_HE_SPEED + noteStartBeats;
                while (beatsToRender >= Math.max(startBeats, TC.toBeats(note.startTime))) {
                    const {x, y} = new Coordinate(posX, yo).mul(hitEffectNoFollows ? this.calculateLineMatrix(line, beatsToRender) : matrix);
                    const tintHE = note.tintHitEffects;
                    respack.hitDrawer(hitContext, x, y, heSize, renderingTime - timeCalculator.toSeconds(beatsToRender), tintHE);
                    beatsToRender -= HOLD_HE_INTERVAL;
                }
            }
            noteNode = <NoteNode>noteNode.next
        }
    }
    /**
     * 
     */
    // 能只在外面拿一遍cover就绝对不在这里面拿10遍cover（
    renderSameTimeNotes(noteNode: NoteNode, chord: boolean, judgeLine: JudgeLine, cover: boolean, timeCalculator: TimeCalculator, beats: number) {
        
        if (noteNode.isHold) {
            const startY = judgeLine.getRelativeFloorPositionAt(TC.toBeats(noteNode.startTime), timeCalculator) * noteNode.parentSeq.speed;
            const notes = noteNode.notes
                , len = notes.length
            for (let i = 0; i < len; i++) {
                const note = notes[i]
                this.renderNote(
                    note,
                    chord,
                    startY,
                    beats,
                    cover,
                    judgeLine.getRelativeFloorPositionAt(TC.toBeats(note.endTime), timeCalculator) * note.speed
                    )
            }
        } else {
            // console.log("renderSameTimeNotes", noteNode)
            const notes = noteNode.notes
            , len = notes.length
            for (let i = 0; i < len; i++) {
                const note = notes[i];
                
                this.renderNote(
                    note,
                    chord,
                    judgeLine.getRelativeFloorPositionAt(TC.toBeats(note.startTime), timeCalculator) * note.speed,
                    beats,
                    cover
                )

            }
        }
    }
    renderNote(note: Note, chord: boolean, positionY: number, beats: number, cover: boolean, endpositionY?: number) {
        // console.log("hyw?");
        // console.log(note, this.beats)
        if (TC.toBeats(note.endTime) < beats) {
            return;
        }
        if (TC.toBeats(note.startTime) - note.visibleBeats > beats) {
            return;
        }
        const isJudging = TC.toBeats(note.startTime) <= beats
        if (positionY < 0 && (!endpositionY || endpositionY < 0) && cover && !isJudging) {
            return;
        }
        if (cover && note.type === NoteType.hold && positionY < 0) {
            positionY = 0;
        }
        const ratio = this.heightRatio;
        const context = this.layers[NOTE_TYPE_LAYER_MAP[note.type]][1];
        const respack = this.respack;
        let zero = 0;
        const positionX = note.positionX;
        
        if (note.yOffset) {
            positionY += note.yOffset;
            endpositionY += note.yOffset;
            zero = note.yOffset;
        }


        positionY = -positionY;
        endpositionY = -endpositionY
        zero = -zero;
        
        let length = endpositionY - positionY
        const size = this.noteSize * note.size;
        const half = size / 2;
        const opac = note.alpha < 255
        context.save();
        if (!note.above) {
            context.scale(1, -1);
        }
        if (opac) {
            context.globalAlpha = note.alpha / 255;
        }
        if (note.type === NoteType.hold) {
            positionY = isJudging ? zero : positionY;
            length = isJudging ? (endpositionY - zero) : length;
            length = -length
            const HOLD_BODY = chord ? respack.HOLD_BODY_HL : respack.HOLD_BODY;
            const HOLD_HEAD = chord ? respack.HOLD_HEAD_HL : respack.HOLD_HEAD;
            const HOLD_TAIL = chord ? respack.HOLD_TAIL_HL : respack.HOLD_TAIL;

            const holdSize = chord ? respack.holdHlRatio * size : size;
            const holdHalf = holdSize / 2;
            context.drawImage(HOLD_BODY, positionX - holdHalf, (positionY - length) * ratio, holdSize, length * ratio);
            if (!isJudging || respack.holdKeepHead) {
                const h = holdSize * (HOLD_HEAD.height / HOLD_HEAD.width)
                context.drawImage(HOLD_HEAD, positionX - holdHalf, (positionY * ratio - (respack.holdCompact ? h / 2 : 0)) ,
                    holdSize, h);
            }
            const tailHeight = holdSize * (HOLD_TAIL.height / HOLD_TAIL.width)
            context.drawImage(HOLD_TAIL, positionX - holdHalf, (positionY - length) * ratio - (respack.holdCompact ? tailHeight / 2 : tailHeight),
                holdSize, tailHeight);
        } else {
            respack.noteDrawer(context, positionX, positionY * ratio, size, this.noteSize, note.type, chord, note.tint);
        }
        
        // 不再使用叠加的方法
        // #default
        if (!note.above) {
            context.drawImage(Images.BELOW, positionX - half, (positionY * ratio - NOTE_HEIGHT / 2), size, NOTE_HEIGHT);
        }
        // #enddefault
        context.restore()
        
    }
    tintLineTexture(bitmap: ImageBitmap, color: RGB): OffscreenCanvas {
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext('2d');
        context.drawImage(bitmap, 0, 0);
        context.globalCompositeOperation = "source-in";
        context.fillStyle = rgb(...color);
        context.fillRect(0, 0, bitmap.width, bitmap.height);
        context.globalCompositeOperation = "multiply";
        context.drawImage(bitmap, 0, 0);
        return canvas;
    }
    // #default

    /**
     * 把所有已知纹理事先传到 GPU。
     *
     * 不预热的话，播放第一帧会在录制阶段集中做几十次 texImage2D
     * （canvas 源还要在 CPU 上做一次预乘），很容易出现一次几百毫秒到几秒的卡顿，
     * 表现就是「刚开始播放卡住不动」。
     */
    warmup() {
        const gpu = this.gpu;
        if (!gpu) return;

        const upload = (source: TexImageSource | null | undefined) => {
            if (!source) return;
            try {
                gpu.getTexture(source);
            } catch (error) {
                console.warn("[Player] 纹理预热失败，将在用到时再上传:", error);
            }
        };

        for (const texture of this.textureMapping.values()) upload(texture);
        upload(Images.ANCHOR);
        upload(Images.BELOW);
        upload(this.background);
        upload(this.blurredBackground);
        const respack = this.respack;
        for (const source of [
            respack.TAP, respack.DRAG, respack.FLICK,
            respack.TAP_HL, respack.FLICK_HL, respack.DRAG_HL,
            respack.HOLD_BODY, respack.HOLD_HEAD, respack.HOLD_TAIL,
            respack.HOLD_BODY_HL, respack.HOLD_HEAD_HL, respack.HOLD_TAIL_HL,
            respack.HIT_FX,
        ]) {
            upload(source);
        }

        // 再跑一次空提交：让着色器首次使用、实例缓冲分配、交换链初始化的开销也发生在这里。
        // 播放中重新 receive 的话就不做了，免得闪一帧空白。
        if (!this.playing) {
            const base = this.context;
            base.save();
            base.globalAlpha = 0;      // 完全透明，屏幕上什么都看不到
            base.fillRect(0, 0, 1, 1);
            base.restore();
            gpu.flush();
        }
    }

    // #default

    /** 已经提醒过「未注册」的着色器名 */
    private readonly warnedShaders = new Set<string>();

    /** 注册一个特效着色器（谱面带的自定义着色器，或应用自备的） */
    addEffectShader(shader: EffectShader) {
        this.gpu?.addShader(shader);
    }

    /**
     * 把谱面的 Phira 特效应用到这个帧上。
     *
     * 每个特效的作用范围（Z 轴）：
     *
     * - `global: true` → `[0, GPU_Z_OVERLAY)`，即谱面 + 谱面 UI，
     *   但**永远不含**只放帧率/时间的覆盖层；此时 `targetRange` 无效；
     * - 带 `targetRange`（PhiZone Player 的扩展）→ `[minZIndex, maxZIndex)`，
     *   并夹到 `[0, GPU_Z_UI)`，不会伸进覆盖层；
     * - 都没有 → `[0, GPU_Z_UI)`，谱面自己的 UI 不受影响。
     *
     * 同一时刻可能有多个特效的范围交叠，这里把 Z 轴切成互不重叠的小段，
     * 每段只跑一条链（一个对象不会被两个着色器同时处理）；global 链追加在每段末尾，
     * 相当于最后再整屏过一遍。
     *
     * 每帧调用一次即可（内部会先清掉上一帧的设置）。
     */
    applyEffects(beats: number) {
        const gpu = this.gpu;
        if (!gpu) return;

        gpu.clearEffects();
        gpu.time = this.renderingTime;

        const effects = this.chart.getActiveEffects(beats);
        if (effects.length === 0) return;

        const windows: EffectWindow[] = [];
        const globalChain: EffectRequest[] = [];
        const missing: string[] = [];

        for (let i = 0; i < effects.length; i++) {
            const effect = effects[i]!;
            // 谱面自己写了 progress 就以谱面为准（spread 在后面覆盖），没写才用按区间算的
            const uniforms = { progress: effectProgress(effect, beats), ...effect.evalVars(beats) };
            const chain = EFFECT_CHAINS[effect.value]?.(uniforms) ?? [{ shader: effect.value, uniforms }];
            for (const request of chain) {
                if (!gpu.getShader(request.shader) && !missing.includes(request.shader)) missing.push(request.shader);
            }

            if (effect.global) {
                globalChain.push(...chain);
                continue;
            }

            // 没写 targetRange 就是「整个谱面」，不碰谱面 UI；
            // 写了的按谱面的来，但仍然不允许伸进只放帧率/时间的覆盖层
            const range = effect.targetRange;
            const from = Math.max(GPU_Z_BASE, range ? range.minZIndex : GPU_Z_BASE);
            const to = Math.min(range ? GPU_Z_OVERLAY : GPU_Z_UI, range ? range.maxZIndex : GPU_Z_UI);
            // 整段都在覆盖层上就直接忽略
            if (!(to > from)) continue;
            windows.push({ from, to, exclusive: range?.exclusive === true, chain, order: i });
        }

        for (const name of missing) {
            // 每个没注册的着色器只提醒一次，别每帧刷屏
            if (this.warnedShaders.has(name)) continue;
            this.warnedShaders.add(name);
            console.warn(`[Player] 特效着色器未注册，已跳过: ${name}`
                + "（自定义着色器请通过 receive() 的 shaderFetcher 或 addEffectShader() 注册）");
        }

        // 相邻且链相同的段合并，少开几趟 pass
        const applied: { from: number; to: number; chain: EffectRequest[] }[] = [];
        for (const segment of splitZ(windows)) {
            const chain = segment.window ? [...segment.window.chain, ...globalChain] : globalChain;
            if (chain.length === 0) continue;
            const last = applied[applied.length - 1];
            if (last && last.to === segment.from && sameChain(last.chain, chain)) {
                last.to = segment.to;
            } else {
                applied.push({ from: segment.from, to: segment.to, chain });
            }
        }
        for (const range of applied) {
            gpu.setEffect(range.from, range.to, range.chain);
        }
    }

    // #default
    private update() {
        if (!this.playing) {
            return;
        }
        // 严格模式：先等视频解码跟上这一帧再画；等多久有上限，追不上就先用现有的帧
        requestAnimationFrame(() => {
            const frame = this.strictVideoSync
                ? this.prepareVideo().then(() => this.render())
                : Promise.resolve(this.render());

            frame.catch(error => console.error("[Player] 渲染失败", error)).finally(() => this.update());
        })
        this.lastBeats = this.beats
    }
    play() {
        this.audio.play()
        this.playing = true;
        this.update();
        this.dispatchEvent(new Event("play"));
    }
    pause() {
        this.audio.pause()
        this.playing = false
        this.dispatchEvent(new Event("pause"));
    }
    // #enddefault

    /**
     * 设置资源适配器。
     *
     * 谱面引用的贴图 / 视频 / 着色器都由它提供，可以在 {@linkcode receive} 之前或之后调用；
     * 已经有谱面的话会立刻补一次缺的资源。
     *
     * ```ts
     * player.use({
     *     texture: name => fetchImage(name),
     *     video: name => fetchVideo(name),
     *     shader: path => fetchShader(path),
     * });
     * ```
     */
    use(adapter: ResourceAdapter) {
        this.adapter = adapter;
        if (this.chart) void this.syncResources();
        return this;
    }

    /**
     * 监听编辑器的操作列表，编辑过程中新引用到的资源会自动补齐。
     *
     * 每次 `do` / `undo` / `redo` 后立刻对齐一次（扫描很便宜，已有的资源直接跳过），
     * 连续操作由 {@linkcode syncResources} 自己合并。引用被删掉时不做任何处理——
     * 已经加载的资源留着，不卸载。
     *
     * 不接编辑器（纯播放器）就不用调。重复调用会换掉上一个监听。
     *
     * ```ts
     * player.watch(new Op.OperationList(chart));
     * ```
     */
    watch(operations: OperationList) {
        this.resourceWatcher?.detach();
        this.resourceWatcher = new ResourceSyncWatcher(this, operations);
        this.resourceWatcher.attach();
        return this;
    }

    /** 停止监听操作列表 */
    unwatch() {
        this.resourceWatcher?.detach();
        this.resourceWatcher = null;
    }

    /**
     * 把已经加载好的资源交给另一个播放器（离屏录制用）
     *
     * 贴图 / 视频直接共用，适配器也一起带过去，这样对方 `receive()` 时不会重复取。
     * @internal
     */
    copyResourcesTo(target: Player) {
        target.textureMapping = new Map(this.textureMapping);
        target.videoMapping = new Map(this.videoMapping);
        target.adapter = this.adapter;
    }

    /**
     * 接收一张谱面。
     *
     * 贴图 / 视频 / 着色器都从 {@linkcode use} 设置的适配器取；再 {@linkcode watch}
     * 上编辑器的操作列表，之后编辑过程中新加的资源也会自动补。
     *
     * 重复调用可以换谱面，已经加载过的资源会保留。
     */
    async receive(chart: Chart) {
        this.chart = chart;
        this.lastUnplayedNNNode = chart.nnnList.head.next;
        await this.syncResources();
        // #default
        // 纹理已经全部解码好，趁现在（加载阶段）就传到 GPU，别留到播放第一帧
        this.warmup();
        // #enddefault
    }

    /**
     * 把谱面当前引用到的资源补齐（已经加载过的跳过）。
     *
     * `receive()` 会调一次；编辑期由 {@linkcode watch} 按操作类型精准补，
     * 这里留作兜底（比如批量操作、或宿主自己改了谱面结构）。
     * @internal
     */
    async syncResources() {
        const chart = this.chart;
        if (!chart) return;
        if (!this.adapter) return this.warnNoAdapter();
        if (this.syncingResources) {
            // 正在同步时又被叫了一次，等这一轮跑完再补一遍
            this.syncPending = true;
            return;
        }
        this.syncingResources = true;
        try {
            for (const name of chart.scanAllTextures()) await this.loadTexture(name);
            for (const name of chart.scanAllVideos()) await this.loadVideo(name);
            // #default
            for (const path of chart.scanAllShaders()) await this.loadShader(path);
            // #enddefault
        } finally {
            this.syncingResources = false;
            if (this.syncPending) {
                this.syncPending = false;
                void this.syncResources();
            }
        }
    }

    /**
     * 取一张贴图（已有则跳过）
     * @internal
     */
    async loadTexture(name: string) {
        // line.png 是播放器自带的默认线纹理，谱面包里没有这个文件
        if (!name || name === "line.png" || this.textureMapping.has(name)) return;
        const adapter = this.adapter;
        if (!adapter) return this.warnNoAdapter();
        const texture = await this.fetchResource("texture", name, adapter.texture?.(name));
        if (texture) this.textureMapping.set(name, texture);
    }

    /**
     * 取一段视频（已有则跳过）
     * @internal
     */
    async loadVideo(name: string) {
        if (!name || this.videoMapping.has(name)) return;
        const adapter = this.adapter;
        if (!adapter) return this.warnNoAdapter();
        const video = await this.fetchResource("video", name, adapter.video?.(name));
        if (video) this.videoMapping.set(name, video);
    }

    // #default
    /**
     * 取一个自定义特效着色器并注册（已有则跳过）
     * @internal
     */
    async loadShader(path: string) {
        const gpu = this.gpu;
        if (!gpu || !path || gpu.getShader(path)) return;
        const adapter = this.adapter;
        if (!adapter) return this.warnNoAdapter();
        const shader = await this.fetchResource("shader", path, adapter.shader?.(path));
        if (!shader) return;
        // 注册名必须和谱面里的 effect.shader 完全一致，否则查不到
        if (!shader.name) shader.name = path;
        if (gpu.kind === "webgpu" && !shader.wgsl) {
            this.warnResourceOnce(`wgsl:${path}`, `[Player] ${path} 只有 GLSL 版本，WebGPU 后端下会被跳过`);
            return;
        }
        gpu.addShader(shader);
    }
    // #enddefault

    private warnNoAdapter() {
        this.warnResourceOnce("no-adapter",
            "[Player] 还没有设置资源适配器，贴图/视频/着色器都拿不到；"
            + "请先 player.use({ texture, video, shader })");
    }

    /** 取一个资源；适配器没实现或失败都只 warn 一次，返回 null */
    private async fetchResource<T>(kind: string, name: string, job: Promise<T | null> | undefined): Promise<T | null> {
        if (!job) {
            this.warnResourceOnce(`missing:${kind}`,
                `[Player] 资源适配器没有实现 ${kind}()，相关资源会被跳过（谱面里用到的第一个是 ${name}）`);
            return null;
        }
        try {
            return await job;
        } catch (error) {
            this.warnResourceOnce(`fail:${kind}:${name}`, `[Player] ${kind} 加载失败: ${name}`, error);
            return null;
        }
    }

    /** 同一类问题只提醒一次 */
    private warnResourceOnce(key: string, message: string, error?: unknown) {
        if (this.warnedResources.has(key)) return;
        this.warnedResources.add(key);
        if (error === undefined) console.warn(message);
        else console.warn(message, error);
    }

    destroy() {
        this.unwatch();
        this.tinter.destroy();
    }
}



