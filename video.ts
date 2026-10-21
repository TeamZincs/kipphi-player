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
    readonly decoder: VideoDecoder;
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
        this.lookahead = Math.max(1, Math.floor(window / 2));
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

    /** 取最接近 orig 的那一帧 */
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

    /** 补帧到 pos（含前瞻） */
    ensure(pos: number) {
        const target = Math.min(this.chunks.length - 1, pos + this.lookahead);
        let guard = 0;
        while (this.fedUpTo <= target && this.fedUpTo < this.chunks.length && guard++ < 128) {
            if (this.decoder.state !== "configured") break;
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
    }

    /** 只保留 window 帧：从头部（流内最旧）丢 */
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

    forward!: DirStream;
    /** 反向流要等整段转完才能建（它的开头来自视频最后那个 GOP） */
    backward: DirStream | null = null;
    current!: DirStream;
    direction = 1;
    private lastOrig = -1;
    error: Error | null = null;
    destroyed = false;

    private readonly onProgress?: (percent: number, stage: string) => void;
    /** 转码后台任务 */
    transcoding: Promise<unknown> | null = null;

    /** 正向流的 chunk（转码过程中会一直往里加，DirStream 直接持有这个引用） */
    private readonly forwardChunks: EncodedVideoChunk[] = [];
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

        const done = this.transcode(sourceConfig);
        done.catch(e => {
            // 转码失败也要放行，否则 init 永远挂着
            this.error = e instanceof Error ? e : new Error(String(e));
            this.markReady();
        });
        await this.readyPromise;
        if (this.error) throw this.error;

        this.forward = new DirStream(false, this.forwardChunks, this.total, this.gop, this.fps,
            this.window, this.replayConfig!, e => this.error = e);
        this.current = this.forward;

        // 整段转完后补上反向流（它的开头来自最后一个 GOP，必须等转完）
        this.transcoding = done.then(({ backward }) => {
            if (this.destroyed) return;
            this.backward = new DirStream(true, backward, this.total, this.gop, this.fps,
                this.window, this.replayConfig!, e => this.error = e);
            this.onProgress?.(1, "reverse-ready");
        }).catch(() => { }); // 错误已经由上面的 done.catch 处理了
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
        while (!this.error && !this.destroyed) {
            const { done, value } = await reader.read();
            if (done) break;
            decoder.decode(value as EncodedVideoChunk);
            while (backlogged()) {
                await Promise.race([this.nextDequeue(decoder), sleep(4)]);
            }
        }
        if (gopBuffer.length) pushReverseGop();
        await decoder.flush();
        await forwardEncoder.flush();
        await reverseEncoder.flush();
        this.total = index;
        this.onProgress?.(1, "transcode");
        const seconds = (performance.now() - startedAt) / 1000;
        console.log(`[video] 转码完成: ${encoderConfig.codec} ${width}x${height} ${this.total} 帧,`
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

    private nextDequeue(decoder: VideoDecoder): Promise<void> {
        return new Promise<void>(resolve => {
            const target = decoder as unknown as EventTarget;
            const handler = () => {
                target.removeEventListener("dequeue", handler);
                resolve();
            };
            target.addEventListener("dequeue", handler);
        });
    }

    // ==== 对外接口 ====

    /** 同步索取 time（秒）时刻的帧 */
    getFrame(time: number): VideoFrame | null {
        if (this.error || !this.current) return null;
        const orig = clamp(Math.round(time * this.fps), 0, Math.max(0, this.total - 1));
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

    /** 让出事件循环，等后台解码追上 */
    async prepare(time: number): Promise<void> {
        const orig = clamp(Math.round(time * this.fps), 0, Math.max(0, this.total - 1));
        for (let i = 0; i < 64 && !this.current?.has(orig); i++) {
            await sleep(0);
        }
    }

    private switchDirection(dir: number, pivotOrig: number) {
        const next = dir > 0 ? this.forward : this.backward;
        // 反向流还没准备好就先继续用正向流（会退化成「给最近的帧」）
        if (!next || next === this.current) {
            this.direction = dir;
            return;
        }
        // 1. 收获当前链表里、新方向紧邻的那几帧
        const seeds = this.current.harvest(dir, pivotOrig);
        // 2. 旧方向剩下的全释放，停掉它的补帧
        this.current.dropAll();
        this.current.resetTo(this.current.toPos(pivotOrig));
        this.current.pendingReset = false; // 它已经空了，下次用要重新定位
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
