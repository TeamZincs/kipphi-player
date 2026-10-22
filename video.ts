import { WebDemuxer } from "web-demuxer";

let wasmPath: string | undefined;

/**
 * 设置 web-demuxer 的 wasm 路径
 *
 * 相对路径会按**页面**（`document.baseURI`）解析成绝对地址。
 * 必须这么做：wasm 是在 web-demuxer 自己的 worker 里加载的，
 * 相对路径会按那个 worker 的地址（blob: 或 `/assets/xxx.js`）去解析 → 必然 404。
 *
 * ```ts
 * setWasmPath("./web-demuxer.wasm");                  // 放在站点根目录（public/）
 * setWasmPath("https://cdn.jsdelivr.net/npm/web-demuxer@4/dist/wasm-files/web-demuxer.wasm");
 * ```
 */
export function setWasmPath(p: string | URL) {
    wasmPath = p instanceof URL ? p.href : p;
}

/** 相对路径按页面地址补全成绝对地址（worker 里加载 wasm 只认绝对地址） */
function absoluteWasmPath(path: string) {
    try {
        return new URL(path, document.baseURI).href;
    } catch {
        return path;
    }
}

const US = 1e-6;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** 转码多久没有任何新帧就算卡住（毫秒） */
const STALL_MS = 5000;
/** 回放解码队列满着、多久没有任何新帧就判定解码器死了（毫秒） */
const DECODER_STALL_MS = 2000;

/**
 * 转码队列：同一时刻只转一条视频
 *
 * 每条视频要占 1 个源解码器 + 2 个编码器（正向 / 反向），两条一起来就是 6 个硬件
 * 会话；实测（Designant.zip 的两条 BGA）会双双卡在十几二十秒处不动。
 */
let transcodeQueue: Promise<unknown> = Promise.resolve();
const clamp = (x: number, l: number, r: number) => x < l ? l : x > r ? r : x;

export interface VideoSourceOptions {
    /** 重编码的 GOP 大小（帧） @default 10 */
    gopSize?: number;
    /** 重编码宽度 @default 1280 */
    encodeWidth?: number;
    /** 重编码高度 @default 720 */
    encodeHeight?: number;
    /** 重编码码率 @default 4000000 */
    bitrate?: number;
    /**
     * 重编码用的 codec。默认优先 H.264 Baseline（桌面端普遍有硬编硬解，最快），
     * 不支持时依次退回其它 H.264 档位、最后退 VP8。
     */
    codec?: string;
    /** 每个方向最多保留多少帧 @default 12 */
    bufferSize?: number;
    /** 转码进度，percent 为 0~1 */
    onProgress?: (percent: number, stage: string) => void;
    /**
     * 视频比这个秒数长时，只转够这么多秒就先对外可用，剩下的后台接着转
     * @default 10
     */
    readySeconds?: number;
}

interface FrameNode {
    /** 原始帧号 */
    orig: number;
    val: VideoFrame;
    next: FrameNode | null;
}

/**
 * 单向的流：一条重编码出来的 chunk 序列 + 一个常驻解码器 + 一个帧链表。
 *
 * 链表只在尾部追加、头部丢弃 —— 因为**两条流内部都只往前解**。
 * 正向流与反向流唯一的区别是「流内下标 ↔ 原始帧号」的映射。
 */
class DirStream {
    /** 卡住时会整个换掉，所以不是 readonly */
    decoder: VideoDecoder;
    /** 上一次看到进展（喂进去 / 解出来）的时刻，判断解码器是不是卡死了 */
    private lastProgressAt = performance.now();
    private lastFed = -1;
    private lastCount = -1;
    head: FrameNode | null = null;
    tail: FrameNode | null = null;
    count = 0;
    /** 原始第 0 帧的副本，负时间时直接给这个（反向流里它在最后，转完才有） */
    first: VideoFrame | null = null;
    /** 下一个要喂给解码器的 chunk 下标 */
    fedUpTo = 0;
    /** 已经重新定位、但新帧还没到（此时不能再 reset，否则永远解不出帧） */
    pendingReset = false;
    /** 预解码的前瞻帧数 */
    readonly lookahead: number;

    constructor(
        readonly reverse: boolean,
        readonly chunks: EncodedVideoChunk[],
        readonly total: number,
        readonly gop: number,
        readonly fps: number,
        readonly window: number,
        private readonly config: VideoDecoderConfig,
        private readonly onError: (e: Error) => void
    ) {
        // 往前喂半个窗口就够了：喂得越深，每次重定位（拖进度条）要解的帧越多，
        // 手感越迟钝；而吞吐量只取决于解码器本身，喂得多并不会更快
        this.lookahead = Math.max(2, Math.floor(window / 2));
        this.decoder = new VideoDecoder({
            output: frame => this.receive(frame),
            error: e => this.onError(e instanceof Error ? e : new Error(String(e)))
        });
        this.decoder.configure(config);
    }

    /** 流内下标 → 原始帧号 */
    toOrig(pos: number) {
        return this.reverse ? this.total - 1 - pos : pos;
    }
    /** 原始帧号 → 流内下标 */
    toPos(orig: number) {
        return this.reverse ? this.total - 1 - orig : orig;
    }

    has(orig: number) {
        for (let n = this.head; n; n = n.next) {
            if (n.orig === orig) return true;
        }
        return false;
    }

    /**
     * 取最接近 orig 的那一帧
     *
     * 交出去的是**链表里那个 VideoFrame 本身**，不 close、也不克隆：
     * 画的地方（`drawImage` / `texImage2D` / `copyExternalImageToTexture`）
     * 都是在调用那一刻就把画面快照走了，返回之后这一帧就可以回收。
     */
    take(orig: number): VideoFrame | null {
        let best: FrameNode | null = null;
        let bestDelta = Infinity;
        for (let n = this.head; n; n = n.next) {
            const delta = Math.abs(n.orig - orig);
            if (delta < bestDelta) {
                bestDelta = delta;
                best = n;
            }
        }
        return best ? best.val : null;
    }

    /** 等「下一帧解出来」的挂起者 */
    private waiters: (() => void)[] = [];

    /**
     * 等新的一帧解出来（谁先到算谁）
     *
     * 比 `sleep(0)` 轮询快得多：定时器嵌套几层之后会被钳到 4ms，
     * 一帧等两轮就是 8ms —— 录制端一秒钟只能推十几帧，一半时间花在这上面。
     */
    onFrame(): Promise<void> {
        return new Promise<void>(resolve => { this.waiters.push(resolve); });
    }

    private notifyFrame() {
        if (this.waiters.length === 0) return;

        const waiting = this.waiters;

        this.waiters = [];

        for (const resolve of waiting) resolve();
    }

    /**
     * 是否需要重新定位。
     * 以「已解出的最新一帧」为基准判断：目标在它之后就继续往前解；
     * 在它之前但还在窗口内就直接用；只有落后超过一整个窗口才重定位。
     */
    needsReset(pos: number) {
        if (this.pendingReset) return false; // 已经定位过了，等帧到
        if (!this.tail) return true;
        const last = this.toPos(this.tail.orig);
        if (pos >= last) return false;
        return pos < last - this.window;
    }

    /**
     * 重新定位：从 pos 之前最近的那个关键帧开始解。
     * 不清空已有帧 —— 留着当「最近的帧」兜底，否则重定位期间会拿到 null。
     */
    resetTo(pos: number) {
        let start = 0;
        for (let i = Math.min(pos, this.chunks.length - 1); i >= 0; i--) {
            if (this.chunks[i]!.type === "key") { start = i; break; }
        }
        if (this.decoder.state !== "closed") this.decoder.reset();
        this.decoder.configure(this.config);
        this.fedUpTo = start;
        this.pendingReset = true;
    }

    /**
     * 解码器卡死了就换一个
     *
     * 实测症状：`decoder.state` 还是 `configured`、队列一直满着（12），但再也不吐帧，
     * 画面就定在开头几帧。`reset()` 救不回来（会话已经废了），只能 close 掉重建。
     * 常见诱因是硬件解码会话数量超限 —— Chrome 对同时存在的 H.264 解码器有上限，
     * 超出的那些不会报错，只是从此不出帧。
     */
    private checkStall(pos: number) {
        // 喂进去的块数、解出来的帧数，任何一个在变就说明还活着
        if (this.fedUpTo !== this.lastFed || this.count !== this.lastCount) {
            this.lastFed = this.fedUpTo;
            this.lastCount = this.count;
            this.lastProgressAt = performance.now();

            return;
        }

        // 队列没堵满，说明是我们在等位置，不算卡
        if (this.decoder.decodeQueueSize < this.window) return;
        if (performance.now() - this.lastProgressAt < DECODER_STALL_MS) return;

        let start = 0;
        for (let i = Math.min(pos, this.chunks.length - 1); i >= 0; i--) {
            if (this.chunks[i]!.type === "key") { start = i; break; }
        }

        console.warn(`[video] 回放解码器卡住了（队列 ${this.decoder.decodeQueueSize}，`
            + `已 ${((performance.now() - this.lastProgressAt) / 1000).toFixed(1)}s 没有进展），重建一个`);

        try { this.decoder.close(); } catch { }

        this.decoder = new VideoDecoder({
            output: frame => this.receive(frame),
            error: e => this.onError(e instanceof Error ? e : new Error(String(e)))
        });
        this.decoder.configure(this.config);
        this.fedUpTo = start;
        this.pendingReset = true;
        this.lastProgressAt = performance.now();
        this.lastFed = this.fedUpTo;
        this.lastCount = this.count;
    }

    /** 补帧到 pos（含前瞻） */
    ensure(pos: number) {
        this.checkStall(pos);

        const target = Math.min(this.chunks.length - 1, pos + this.lookahead);
        let guard = 0;
        while (this.fedUpTo <= target && this.fedUpTo < this.chunks.length && guard++ < 128) {
            if (this.decoder.state !== "configured") break;
            // 队列太深就停手：解出来的帧会排成一长队，画面反而更滞后
            if (this.decoder.decodeQueueSize >= this.window) break;
            this.decoder.decode(this.chunks[this.fedUpTo++]!);
        }
    }

    /**
     * 换向时把别的链表里的帧收过来当种子，
     * 避免切换瞬间没有帧可用。
     */
    adopt(seeds: FrameNode[], pivotOrig: number) {
        this.dropAll();
        seeds.sort((a, b) => this.toPos(a.orig) - this.toPos(b.orig));
        for (const node of seeds) {
            node.next = null;
            if (this.tail) this.tail.next = node;
            else this.head = node;
            this.tail = node;
            this.count++;
        }
        this.resetTo(this.toPos(pivotOrig));
    }

    private receive(frame: VideoFrame) {
        const pos = Math.round(frame.timestamp * US * this.fps);
        const orig = this.toOrig(pos);
        // 只挡负数：正向流的 total 是「已转码的帧数」，会一直涨，不能拿它当上界
        if (orig < 0 || this.has(orig)) {
            frame.close();
            return;
        }
        this.pendingReset = false;
        if (orig === 0 && !this.first) this.first = frame.clone();
        const node: FrameNode = { orig, val: frame, next: null };
        if (this.tail) this.tail.next = node;
        else this.head = node;
        this.tail = node;
        this.count++;
        this.trim();
        this.notifyFrame();
    }

    /**
     * 只保留 window 帧：从头部（流内最旧）丢
     *
     * **必须无条件下手**。以前留了个「最近交出去的几帧先别关」的名单，一旦名单里的人
     * 正好是链表头，这里就 `break` 掉 —— 帧再也丢不出去，越堆越多，`has` / `take`
     * 每次遍历整个链表，解码器也会因为 VideoFrame 一直没还给系统而停止出帧。
     * 拖进度条时最明显：取到的「最接近的帧」恰好就是链表头。
     */
    private trim() {
        while (this.count > this.window && this.head) {
            const node = this.head;
            this.head = node.next;
            if (!this.head) this.tail = null;
            node.val.close();
            this.count--;
        }
    }

    dropAll() {
        for (let n = this.head; n;) {
            const next = n.next;
            n.val.close();
            n = next;
        }
        this.head = this.tail = null;
        this.count = 0;
    }

    /** 摘出新方向紧邻的那些帧（不 close，所有权转交） */
    harvest(dir: number, pivotOrig: number): FrameNode[] {
        const taken: FrameNode[] = [];
        let prev: FrameNode | null = null;
        let node = this.head;
        while (node) {
            const next = node.next;
            const keep = dir > 0 ? node.orig >= pivotOrig : node.orig <= pivotOrig;
            if (keep) {
                if (prev) prev.next = next;
                else this.head = next;
                if (this.tail === node) this.tail = prev;
                this.count--;
                node.next = null;
                taken.push(node);
            } else {
                prev = node;
            }
            node = next;
        }
        return taken;
    }

    close() {
        this.dropAll();
        try { this.first?.close(); } catch { }
        this.first = null;
        if (this.decoder.state !== "closed") this.decoder.close();
    }
}

/**
 * 渲染用的视频源：同步索取某一时刻的视频帧，正反两个方向都流畅。
 *
 * 加载时把整段视频**重编码成两条 10 帧小 GOP 的流**：
 *
 * - 正向流：第 i 个位置 ↔ 原始第 i 帧
 * - 反向流：第 i 个位置 ↔ 原始第 `N-1-i` 帧
 *
 * 于是**两个方向都变成「顺序往前解」**，反向播放 = 正向播放反向流。
 * 小 GOP 保证任何一帧最多只需解 10 帧就能拿到。
 *
 * 取到的 {@link VideoFrame} 归缓冲区所有：用完即画，不要 close，也不要跨 await 持有。
 */
export class VideoRenderingSource {
    readonly source: File | string;
    readonly demuxer: WebDemuxer;

    readonly gop: number;
    readonly window: number;
    readonly width: number;
    readonly height: number;
    readonly bitrate: number;
    readonly codec: string;

    fps = 60;
    duration = 0;
    /** 总帧数 */
    total = 0;

    /** 正向流：第一次取帧时才建（见 ensureForward） */
    forward: DirStream | null = null;
    /** 反向流：要等整段转完（它的开头来自视频最后那个 GOP），而且真的倒放时才建 */
    backward: DirStream | null = null;
    current: DirStream | null = null;
    direction = 1;
    private lastOrig = -1;
    error: Error | null = null;
    destroyed = false;

    private readonly onProgress?: (percent: number, stage: string) => void;
    /** 转码后台任务 */
    transcoding: Promise<unknown> | null = null;

    /** 正向流的 chunk（转码过程中会一直往里加，DirStream 直接持有这个引用） */
    private readonly forwardChunks: EncodedVideoChunk[] = [];

    /**
     * 每帧在**源视频**里的时间戳（秒）
     *
     * 容器里写的 `avg_frame_rate` / `r_frame_rate` 不一定可信（实测有 94 秒、1245 帧
     * 的 BGA 被标成 60fps），拿它换算「时间 → 帧号」会让视频播到第 20 秒就停住。
     * 所以按解码出来的帧自己的时间戳建表，用二分查。
     */
    private readonly frameTimes: number[] = [];
    /** 时间戳是否单调；有 B 帧（解码顺序 ≠ 显示顺序）时就不单调，退回按容器帧率算 */
    private framesMonotonic = true;
    private replayConfig: VideoDecoderConfig | null = null;
    /** 就绪所需帧数；视频比 readySeconds 短时等全部转完 */
    private readyFrames = 0;
    private markReady: () => void = () => { };
    private readonly readyPromise = new Promise<void>(resolve => { this.markReady = resolve; });
    private readonly readySeconds: number;

    private constructor(source: File | string, options: VideoSourceOptions = {}) {
        this.source = source;
        this.gop = Math.max(1, options.gopSize ?? 10);
        this.window = Math.max(2, options.bufferSize ?? 12);
        this.width = options.encodeWidth ?? 1280;
        this.height = options.encodeHeight ?? 720;
        this.bitrate = options.bitrate ?? 4_000_000;
        this.codec = options.codec ?? "";
        this.readySeconds = options.readySeconds ?? 10;
        this.onProgress = options.onProgress;
        this.demuxer = new WebDemuxer({
            wasmFilePath: wasmPath === undefined ? undefined : absoluteWasmPath(wasmPath)
        });
    }

    static async from(source: File | string, options: VideoSourceOptions = {}) {
        const instance = new this(source, options);
        await instance.init();
        return instance;
    }

    static async fromFile(source: File, options: VideoSourceOptions = {}) {
        return this.from(source, options);
    }

    async init() {
        await this.demuxer.load(this.source);
        const info = await this.demuxer.getMediaInfo();
        this.duration = info.duration;
        const stream = await this.demuxer.getMediaStream("video");
        const [num, den] = String(stream.avg_frame_rate || stream.r_frame_rate || "").split("/").map(Number);
        if (num > 0 && den > 0) this.fps = num / den;
        const sourceConfig = await this.demuxer.getDecoderConfig("video") as VideoDecoderConfig;

        // 视频比 readySeconds 长，就只等这么多帧先就绪，剩下的后台接着转
        this.readyFrames = this.duration > this.readySeconds
            ? Math.round(this.readySeconds * this.fps)
            : Infinity;

        // 转码排队：一条视频要占「1 个源解码器 + 正向/反向 2 个编码器」，
        // 两条视频同时开就是 6 个硬件会话，实测会把编码器池用光、双双卡死在半路
        const done = transcodeQueue.then(() => this.transcode(sourceConfig));

        transcodeQueue = done.catch(() => { });
        done.catch(e => {
            // 转码失败也要放行，否则 init 永远挂着
            this.error = e instanceof Error ? e : new Error(String(e));
            this.markReady();
        });
        await this.readyPromise;
        if (this.error) throw this.error;

        // 回放解码一旦出错，getFrame 就永远返回 null，画面会停在最后一帧 ——
        // 所以这里必须留个声响，不然只能看到"背景视频卡住"这种表象
        const onReplayError = (e: Error) => {
            console.error("[video] 回放解码失败，背景视频会停在当前帧:", e);
            this.error = e;
        };

        this.onReplayError = onReplayError;

        // 正向流按需创建（见 ensureForward）：硬件 H.264 解码会话有数量上限
        // （常见 3 个），两条视频各建正反向就是 4 个，多出来的会被静默丢弃 ——
        // 状态还是 `configured`，但队列再也不会前进，画面就定在开头几帧。

        // 整段转完后只把反向流的 chunk 留着，等真的需要倒放时再建解码器
        this.transcoding = done.then(({ backward }) => {
            if (this.destroyed) return;
            this.backwardChunks = backward;
            this.onProgress?.(1, "reverse-ready");
        }).catch(() => { }); // 错误已经由上面的 done.catch 处理了
    }

    /** 回放解码器：真正要用的时候才建 */
    private readonly replayError = (e: Error) => this.onReplayError?.(e);
    private onReplayError: ((e: Error) => void) | null = null;
    private backwardChunks: EncodedVideoChunk[] | null = null;

    /** 需要正向流时才创建（省一个硬件解码会话） */
    private ensureForward(): DirStream | null {
        // 还没就绪（replayConfig 没有）就没法配置解码器
        if (!this.replayConfig) return null;
        if (!this.forward) {
            this.forward = new DirStream(false, this.forwardChunks, this.total, this.gop, this.fps,
                this.window, this.replayConfig, this.replayError);
        }
        if (!this.current) this.current = this.forward;

        return this.forward;
    }

    /** 需要反向流时才创建（反向数据转码完才有） */
    private ensureBackward(): DirStream | null {
        if (this.backward) return this.backward;
        if (!this.backwardChunks) return null;

        this.backward = new DirStream(true, this.backwardChunks, this.total, this.gop, this.fps,
            this.window, this.replayConfig!, this.replayError);

        return this.backward;
    }

    /** 检查是否够帧数可以对外可用了 */
    private checkReady() {
        if (!this.replayConfig) return;
        this.total = this.forwardChunks.length;
        if (this.forwardChunks.length >= this.readyFrames) this.markReady();
    }

    // ==== 转码 ====

    private async transcode(sourceConfig: VideoDecoderConfig) {
        const gop = this.gop;
        const fps = this.fps;
        const { width, height, bitrate } = this;

        // H.264 Baseline（42E0）优先：桌面端普遍有硬件编码 + 硬件解码，编解都最快；
        // 而且 Baseline 没有 B 帧，天然没有重排延迟。不支持再退其它档位、最后退 VP8。
        // 注意 level 要够：720p 是 3600 宏块，Level 3.0（1E）只有 1620，会被直接拒
        const codecs = [...new Set([
            this.codec,
            "avc1.42E028", // Baseline L4.0
            "avc1.42E01F", // Baseline L3.1
            "avc1.4D4028", // Main L4.0
            "avc1.640028", // High L4.0
            "vp8"
        ])].filter(Boolean) as string[];

        let encoderConfig: VideoEncoderConfig | null = null;
        for (const codec of codecs) {
            const candidate: VideoEncoderConfig = {
                codec,
                width,
                height,
                bitrate,
                framerate: fps,
                latencyMode: "quality"
            };
            if (codec.startsWith("avc")) {
                (candidate as VideoEncoderConfig & { avc?: { format: string } }).avc = { format: "avc" };
            }
            const support = await VideoEncoder.isConfigSupported(candidate);
            if (support.supported) {
                encoderConfig = support.config ?? candidate;
                break;
            }
        }
        if (!encoderConfig) {
            throw new Error("没有可用的视频编码器");
        }

        let replayConfig: VideoDecoderConfig = {
            codec: encoderConfig.codec,
            codedWidth: width,
            codedHeight: height
        };
        // 反向流按 GOP 分桶，最后按 GOP 倒序拼接。
        // 分桶依据是 chunk 继承的帧时间戳（= 原始帧号），不依赖「一帧恰好一个 chunk」。
        const reverseGops: EncodedVideoChunk[][] = [];

        const canvas = typeof OffscreenCanvas !== "undefined"
            ? new OffscreenCanvas(width, height)
            : Object.assign(document.createElement("canvas"), { width, height });
        const context = canvas.getContext("2d") as CanvasRenderingContext2D;

        let gopBuffer: VideoFrame[] = [];
        let index = 0;
        let estimated = Math.max(1, Math.round(this.duration * fps));

        const pushReverseGop = () => {
            // 倒序编码：最后一个帧做关键帧，其余做 P 帧
            for (let i = gopBuffer.length - 1; i >= 0; i--) {
                reverseEncoder.encode(gopBuffer[i]!, { keyFrame: i === gopBuffer.length - 1 });
            }
            for (const frame of gopBuffer) frame.close();
            gopBuffer = [];
        };

        const forwardEncoder = new VideoEncoder({
            output: (chunk, meta) => {
                if (meta?.decoderConfig) {
                    replayConfig = meta.decoderConfig;
                    this.replayConfig = meta.decoderConfig;
                }
                this.forwardChunks.push(chunk);
                this.checkReady();
            },
            error: e => { this.error = e instanceof Error ? e : new Error(String(e)); }
        });
        const reverseEncoder = new VideoEncoder({
            output: chunk => {
                const origIndex = Math.round(chunk.timestamp * US * fps);
                const g = Math.floor(origIndex / gop);
                while (reverseGops.length <= g) reverseGops.push([]);
                reverseGops[g]!.push(chunk);
            },
            error: e => { this.error = e instanceof Error ? e : new Error(String(e)); }
        });
        forwardEncoder.configure(encoderConfig);
        reverseEncoder.configure(encoderConfig);

        const decoder = new VideoDecoder({
            output: source => {
                const i = index++;
                // 记下源帧的真实时间戳：换算「时间 → 帧号」用得上
                const pts = source.timestamp * US;
                const last = this.frameTimes[this.frameTimes.length - 1];

                if (last !== undefined && pts < last) this.framesMonotonic = false;
                this.frameTimes.push(pts);

                context.drawImage(source, 0, 0, width, height);
                source.close(); // 立刻还给源解码器
                const scaled = new VideoFrame(canvas as CanvasImageSource, {
                    timestamp: Math.round(i * 1e6 / fps),
                    duration: Math.round(1e6 / fps)
                });
                forwardEncoder.encode(scaled, { keyFrame: i % gop === 0 });
                gopBuffer.push(scaled);
                if (gopBuffer.length >= gop) pushReverseGop();
                if (this.onProgress && (i & 31) === 0) {
                    this.onProgress(Math.min(1, i / estimated), "transcode");
                }
            },
            error: e => { this.error = e instanceof Error ? e : new Error(String(e)); }
        });
        decoder.configure(sourceConfig);

        // 背压必须把两个编码器也算上：解码比编码快得多，
        // 只压解码器的话帧会堆在编码器队列里（每帧一张完整图像，几 GB 很轻松）
        const backlogged = () => decoder.decodeQueueSize > 8
            || forwardEncoder.encodeQueueSize > 12
            || reverseEncoder.encodeQueueSize > 12;

        const startedAt = performance.now();
        const reader = this.demuxer.read("video", 0, this.duration || undefined).getReader();

        /**
         * 看门狗：一段时间没有任何新帧就当卡住了，用已经转好的部分收尾
         *
         * 实测（Designant.zip）里 94 秒的 BGA 只能读到 20.7 秒，之后
         * `reader.read()` 永远不返回 —— 没有这层保护的话整个转码挂在那儿，
         * `total` 不再增长，`transcoding` 也永远不 resolve，反向流永远建不出来。
         */
        let lastIndex = -1;
        let lastProgressAt = performance.now();
        let stalled = false;
        let wake: (() => void) | null = null;
        const stall = new Promise<void>(resolve => { wake = resolve; });

        const watchdog = setInterval(() => {
            if (index !== lastIndex) {
                lastIndex = index;
                lastProgressAt = performance.now();

                return;
            }
            if (performance.now() - lastProgressAt > STALL_MS && !stalled) {
                stalled = true;
                console.warn(`[video] 转码卡住了（已解 ${index} 帧、到 ${(this.frameTimes[index - 1] ?? 0).toFixed(2)}s，`
                    + `容器说 ${this.duration.toFixed(2)}s；队列 解码=${decoder.decodeQueueSize}`
                    + ` 正向=${forwardEncoder.encodeQueueSize} 反向=${reverseEncoder.encodeQueueSize}），`
                    + `用已经转好的部分继续`);
                wake?.();
            }
        }, 500);

        try {
            while (!this.error && !this.destroyed) {
                const next = await Promise.race([reader.read(), stall.then(() => null)]);

                // 卡住了
                if (!next) break;
                if (next.done) break;

                lastProgressAt = performance.now();
                decoder.decode(next.value as EncodedVideoChunk);

                while (backlogged() && !this.error && !stalled) {
                    await this.nextDequeue(decoder);
                }
                if (stalled) break;
            }
        } finally {
            clearInterval(watchdog);
        }

        try { await reader.cancel(); } catch { }

        if (gopBuffer.length) pushReverseGop();

        // flush 也可能卡住（解码器已经不动了），都带超时
        const settle = async (promise: Promise<void>, ms: number, label: string) => {
            try {
                await Promise.race([promise, sleep(ms)]);
            } catch (error) {
                console.warn(`[video] ${label} 失败`, error);
            }
        };

        await settle(decoder.flush(), STALL_MS, "decoder.flush");
        await settle(forwardEncoder.flush(), STALL_MS, "forwardEncoder.flush");
        await settle(reverseEncoder.flush(), STALL_MS, "reverseEncoder.flush");
        this.total = index;
        this.onProgress?.(1, "transcode");
        const seconds = (performance.now() - startedAt) / 1000;
        const span = (this.frameTimes[this.frameTimes.length - 1] ?? 0).toFixed(2);
        console.log(`[video] 转码完成: ${encoderConfig.codec} ${width}x${height} ${this.total} 帧,`
            + ` 源时间戳 0~${span}s (有效 ${(this.total / Math.max(Number(span), 0.01)).toFixed(1)} fps,`
            + ` 容器声明 ${this.fps.toFixed(2)} fps),`
            + ` 耗时 ${seconds.toFixed(1)}s (${(this.total / Math.max(seconds, 0.001)).toFixed(1)} fps)`);

        decoder.close();
        forwardEncoder.close();
        reverseEncoder.close();

        // 每个桶里是「该 GOP 的帧倒序」，把桶按 GOP 倒序拼起来，
        // 才是从最后一帧往前放的流
        const expectedGops = Math.ceil(this.total / gop);
        if (reverseGops.length !== expectedGops) {
            // 分桶靠 chunk 继承帧时间戳，万一编码器没保留时间戳就会走这里
            console.warn("[video] 反向流分桶数不符:", reverseGops.length, "应为", expectedGops);
        }
        const backwardChunks: EncodedVideoChunk[] = [];
        for (let g = reverseGops.length - 1; g >= 0; g--) {
            for (const chunk of reverseGops[g]!) backwardChunks.push(chunk);
        }

        this.total = this.forwardChunks.length;
        this.markReady(); // 短视频（readyFrames = Infinity）全靠这里放行
        return { backward: this.retimestamp(backwardChunks) };
    }

    /** 把 chunk 的时间戳按流内顺序重写成严格升序 */
    private retimestamp(chunks: EncodedVideoChunk[]) {
        const step = Math.round(1e6 / this.fps);
        return chunks.map((chunk, i) => {
            // EncodedVideoChunk 没有 data 属性，只能用 copyTo 取数据
            const data = new Uint8Array(chunk.byteLength);
            chunk.copyTo(data);
            return new EncodedVideoChunk({
                type: chunk.type,
                timestamp: i * step,
                duration: step,
                data
            });
        });
    }

    /**
     * 等解码器消化一点（最多等 `ms` 毫秒）
     *
     * 必须带超时并且**一定把监听摘掉**：以前用 `Promise.race([等待, sleep(4)])`，
     * 走 sleep 那条路时监听器永远不会被移除，几千帧下来堆成几万个，
     * 之后每次 dequeue 都要把它们全跑一遍 —— 转码就是这么被拖死的。
     */
    private nextDequeue(decoder: VideoDecoder, ms = 8): Promise<void> {
        return new Promise<void>(resolve => {
            const target = decoder as unknown as EventTarget;
            let done = false;

            const finish = () => {
                if (done) return;
                done = true;
                target.removeEventListener("dequeue", handler);
                clearTimeout(timer);
                resolve();
            };
            const handler = () => finish();
            const timer = setTimeout(finish, ms);

            target.addEventListener("dequeue", handler);
        });
    }

    // ==== 对外接口 ====

    /**
     * 时间（秒，源视频时间轴）→ 帧号
     *
     * 优先查真实的帧时间戳表（容器里的帧率常常不靠谱）；表还不可用时退回按帧率算。
     */
    private indexAt(time: number): number {
        const times = this.frameTimes;

        if (!this.framesMonotonic || times.length < 2) {
            return Math.max(0, Math.round(time * this.fps));
        }

        if (time <= times[0]!) return 0;

        let low = 0;
        let high = times.length - 1;
        let best = 0;

        while (low <= high) {
            const mid = (low + high) >> 1;

            if (times[mid]! <= time) {
                best = mid;
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }

        return best;
    }

    /** 同步索取 time（秒）时刻的帧 */
    getFrame(time: number): VideoFrame | null {
        if (this.error) return null;

        // 正向流按需建；还没这个函数的时候 current 是空的
        this.ensureForward();

        if (!this.current) return null;

        const orig = clamp(this.indexAt(time), 0, Math.max(0, this.total - 1));
        if (this.lastOrig >= 0 && orig !== this.lastOrig) {
            const dir = orig > this.lastOrig ? 1 : -1;
            if (dir !== this.direction) this.switchDirection(dir, this.lastOrig);
        }
        this.lastOrig = orig;

        const stream = this.current;
        const pos = stream.toPos(orig);
        // 链表覆盖不到：要么往前继续解，要么重新定位
        if (stream.needsReset(pos)) stream.resetTo(pos);
        stream.ensure(pos);
        // 负时间（以及 time 很小）一律给第一帧
        if (orig <= 0 && stream.first) return stream.first;
        return stream.take(orig);
    }

    /**
     * 当前解码状态（排查「背景视频不动」用）
     *
     * 直接打在录制日志里，一眼能看出是「没转完 / 解不出来 / 取错了帧」哪一种。
     */
    debugState() {
        const stream = this.current;

        return {
            total: this.total,
            frameTimes: this.frameTimes.length,
            lastTs: +(this.frameTimes[this.frameTimes.length - 1] ?? 0).toFixed(2),
            ask: this.lastOrig,
            dir: this.direction,
            list: stream ? `${stream.head?.orig ?? "-"}..${stream.tail?.orig ?? "-"}` : "-",
            count: stream?.count ?? -1,
            fed: stream?.fedUpTo ?? -1,
            decoder: stream?.decoder.state ?? "-",
            queue: stream?.decoder.decodeQueueSize ?? -1,
            error: this.error ? String(this.error) : null
        };
    }

    /**
     * 等整段转码（含反向流）结束
     *
     * 录制 / 离线渲染前值得先等一下：转码自己占一个解码器 + 两个编码器，
     * 和录制抢的话两边都慢（实测后台渲染只剩十几帧）。
     */
    async ready(): Promise<void> {
        if (this.transcoding) await this.transcoding;
        else await this.readyPromise;
    }

    /**
     * 等后台解码把 `time`（秒）那一帧解出来
     *
     * 解码是异步的，而取帧是同步的：不等的话 `getFrame` 只能给到「已经解出来的帧」，
     * 通常是第一帧 —— 背景视频看着就像卡住了。所以渲染前先 await 这个。
     *
     * - `budget`：最多等多少毫秒。超时就拿着现有帧凑合，卡一帧比整帧不画好
     * - 还没转到那一帧（转码还在追）时立刻返回，等也没用
     */
    async prepare(time: number, budget = 50): Promise<void> {
        if (this.error) return;

        this.ensureForward();

        const stream = this.current;

        if (!stream) return;

        // 想要哪一帧（还没截到范围内）
        const wanted = this.indexAt(time);

        // 转码还没转到这儿，等也等不到
        if (wanted >= this.total) return;

        const orig = clamp(wanted, 0, Math.max(0, this.total - 1));
        const deadline = performance.now() + budget;

        for (let i = 0; i < 512; i++) {
            const current = this.current;

            if (!current) return;
            if (current.has(orig)) return;

            // 解码已经越过这个位置了：`take` 会给最接近的一帧，差一两帧看不出来，
            // 再等下去就是每帧白等一个 budget
            if (current.tail && current.toPos(current.tail.orig) >= current.toPos(orig)) return;

            if (performance.now() >= deadline) return;

            // 重新定位一次：这一轮 await 期间可能换了方向或者重定位过
            this.getFrame(time);

            // 等下一帧解出来（不是睡固定时间：定时器会被钳到 4ms，白等）
            await Promise.race([current.onFrame(), sleep(8)]);
        }
    }

    private switchDirection(dir: number, pivotOrig: number) {
        const current = this.current ?? this.ensureForward();

        if (!current) return;

        const next = dir > 0 ? this.forward : this.ensureBackward();

        // 反向流还没准备好就先继续用正向流（会退化成「给最近的帧」）
        if (!next || next === current) {
            this.direction = dir;
            return;
        }
        // 1. 收获当前链表里、新方向紧邻的那几帧
        const seeds = current.harvest(dir, pivotOrig);
        // 2. 旧方向剩下的全释放，停掉它的补帧
        current.dropAll();
        current.resetTo(current.toPos(pivotOrig));
        current.pendingReset = false; // 它已经空了，下次用要重新定位
        // 3. 新方向：拿这批帧做种子，从 pivot 所在 GOP 重新开始解
        next.adopt(seeds, pivotOrig);
        this.current = next;
        this.direction = dir;
    }

    destroy() {
        this.destroyed = true;
        this.forward?.close();
        this.backward?.close();
        this.markReady();
        try { this.demuxer.destroy(); } catch { }
    }
}

export { VideoRenderingSource as VideoFrameSource };
