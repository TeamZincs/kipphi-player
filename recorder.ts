import { Muxer as Mp4Muxer, ArrayBufferTarget as Mp4ArrayBufferTarget } from "mp4-muxer";
import { Muxer as WebmMuxer, ArrayBufferTarget as WebmArrayBufferTarget } from "webm-muxer";

import type { NoteType } from "kipphi";

import type { Player, RendererPreference } from "./player";

/** 容器格式 */
export type RecordContainer = "mp4" | "webm";

/**
 * 渲染目标
 *
 * - `canvas`：直接录用户看得见的那块画布（渲染过程也看得见，跟着主线程走）
 * - `offscreen`：另开一块 `OffscreenCanvas` 渲染，用户看不到，能跑多快跑多快
 */
export type RecordTarget = "canvas" | "offscreen";

export interface RecordVideoOptions {
    /** 覆盖自动挑的编码串，比如 `avc1.640028` */
    codec?: string;
    /** 目标码率，缺省按分辨率算 */
    bitrate?: number;
}

export interface RecordAudioOptions {
    /** 采样率，缺省 44100 */
    sampleRate?: number;
    /** 码率，缺省 128k */
    bitrate?: number;
    /** BGM 数据；不给就试着 fetch player.audio.src（blob: 也支持） */
    source?: Blob | ArrayBuffer;
    /** 是否混入打击音，缺省 true */
    hitSounds?: boolean;
    /** 打击音增益，缺省 1.0 */
    hitSoundGain?: number;
}

export interface RecordOptions {
    target?: RecordTarget;
    /** 输出尺寸，缺省沿用画布尺寸 */
    width?: number;
    height?: number;
    /** 帧率，缺省 60 */
    fps?: number;
    /** 要录的时间范围（秒），缺省整首 */
    range?: [number, number];
    /** 想用的容器；缺省按编码器支持情况在 mp4 / webm 里挑 */
    container?: RecordContainer;
    /** 离屏播放器用的渲染后端，缺省 `auto`（尽量和主播放器一致就手动传） */
    renderer?: RendererPreference;
    video?: RecordVideoOptions;
    /** 传 `false` 出无声视频 */
    audio?: false | RecordAudioOptions;
    /** 每过一小段回调一次，`frame` 从 0 开始 */
    onProgress?: (frame: number, total: number) => void;
    signal?: AbortSignal;
}

export interface RecordResult {
    blob: Blob;
    container: RecordContainer;
    videoCodec: string;
    audioCodec: string | null;
    width: number;
    height: number;
    fps: number;
    frames: number;
    duration: number;
}

/** 每个候选容器对应的编码器封装名（muxer 那边的叫法） */
interface VideoCandidate {
    container: RecordContainer;
    codec: string;
    muxerCodec: string;
    avc?: { format: "avc" | "annexb" };
}

/**
 * 视频编码候选，按顺序试
 *
 * 先试 MP4（H.264，兼容性最好），不行退 WebM（VP9 / VP8）。
 * `avc.format = "avc"` 是 mp4-muxer 要求的长度前缀格式。
 */
const VIDEO_CANDIDATES: VideoCandidate[] = [
    { container: "mp4", codec: "avc1.42001f", muxerCodec: "avc", avc: { format: "avc" } },
    { container: "mp4", codec: "avc1.4d002a", muxerCodec: "avc", avc: { format: "avc" } },
    { container: "webm", codec: "vp09.00.10.08", muxerCodec: "V_VP9" },
    { container: "webm", codec: "vp8", muxerCodec: "V_VP8" },
];

const AUDIO_CANDIDATES: Record<RecordContainer, { codec: string; muxerCodec: string }> = {
    mp4: { codec: "mp4a.40.2", muxerCodec: "aac" },
    webm: { codec: "opus", muxerCodec: "A_OPUS" },
};

const DEFAULT_FPS = 60;
const DEFAULT_SAMPLE_RATE = 44100;
const DEFAULT_AUDIO_BITRATE = 128_000;
/** 同时排队的帧数上限，超过就等编码器消化 */
const MAX_ENCODE_QUEUE = 8;
const AUDIO_CHUNK_FRAMES = 1024;

function tick() {
    return new Promise<void>(resolve => setTimeout(resolve, 0));
}

/** 按分辨率给个够用的默认码率（约 0.12 bpp @ 60fps） */
function defaultBitrate(width: number, height: number, fps: number) {
    return Math.round(width * height * fps * 0.12);
}

async function pickVideoCandidate(width: number, height: number, fps: number, options: RecordOptions) {
    const bitrate = options.video?.bitrate ?? defaultBitrate(width, height, fps);
    for (const candidate of VIDEO_CANDIDATES) {
        if (options.container && candidate.container !== options.container) continue;
        if (options.video?.codec && candidate.codec !== options.video.codec) continue;
        const config: VideoEncoderConfig = {
            codec: candidate.codec,
            width,
            height,
            bitrate,
            framerate: fps,
            ...(candidate.avc ? { avc: candidate.avc } : {}),
        };
        try {
            const support = await VideoEncoder.isConfigSupported(config);
            if (support.supported) return { candidate, config };
        } catch {
            // 某些浏览器对不认识的 codec 直接抛错，当不支持处理
        }
    }
    return null;
}

/**
 * 把播放器渲染成一段视频（浏览器端，WebCodecs）
 *
 * 渲染完全由这里手动驱动：每帧 `audioCurrentTime = t` → `render()` → 取一帧送编码器，
 * 不跟随音频时钟，也不管主线程是否流畅——唯一会等的地方是 `VideoEncoder` 的背压。
 *
 * ```ts
 * const { blob } = await recordPlayer(player, {
 *     target: "offscreen",          // 后台渲染，用户看不到
 *     range: [0, 30],
 *     audio: { source: songFile },
 * });
 * ```
 *
 * 音频走 `OfflineAudioContext` 离线混音（BGM + 打击音），再交给 `AudioEncoder`，
 * 和服务端录制一样合进同一个容器。
 */
export async function recordPlayer(player: Player, options: RecordOptions = {}): Promise<RecordResult> {
    if (typeof VideoEncoder === "undefined") {
        throw new Error("[recorder] 当前环境不支持 WebCodecs（VideoEncoder）");
    }
    const chart = player.chart;
    if (!chart) {
        throw new Error("[recorder] 播放器还没有 receive() 过谱面");
    }

    const fps = options.fps ?? DEFAULT_FPS;
    const range = options.range ?? [0, chart.duration];
    const duration = Math.max(0, range[1] - range[0]);
    if (duration <= 0) {
        throw new Error("[recorder] 要录的时间范围是空的");
    }
    const totalFrames = Math.max(1, Math.ceil(duration * fps));
    const width = options.width ?? player.canvas.width;
    const height = options.height ?? player.canvas.height;
    const target = options.target ?? "offscreen";

    const picked = await pickVideoCandidate(width, height, fps, options);
    if (!picked) {
        throw new Error("[recorder] 没有可用的视频编码器（试过 H.264 / VP9 / VP8）");
    }
    const { candidate: videoCandidate, config: videoConfig } = picked;
    const container = videoCandidate.container;

    // 音频：先算配置，具体数据等画面渲完再混（混音不依赖画面，但它要用到渲染时收集的打击音）
    const audioOptions = options.audio === false ? null : (options.audio ?? {});
    const sampleRate = audioOptions?.sampleRate ?? DEFAULT_SAMPLE_RATE;
    const audioCandidate = audioOptions ? AUDIO_CANDIDATES[container] : null;
    let audioConfig: AudioEncoderConfig | null = null;
    if (audioCandidate) {
        const config: AudioEncoderConfig = {
            codec: audioCandidate.codec,
            sampleRate,
            numberOfChannels: 2,
            bitrate: audioOptions?.bitrate ?? DEFAULT_AUDIO_BITRATE,
        };
        try {
            const support = await AudioEncoder.isConfigSupported(config);
            audioConfig = support.supported ? config : null;
        } catch {
            audioConfig = null;
        }
        if (!audioConfig) {
            console.warn("[recorder] 当前环境不支持这个音频编码器，这次出无声视频");
        }
    }

    // 1. 选画布：可见的那块，或另开一块离屏的
    let renderer = player;
    let canvas: HTMLCanvasElement | OffscreenCanvas = player.canvas;
    let ownsRenderer = false;
    if (target === "offscreen") {
        const offscreen = await createOffscreenPlayer(player, width, height, options.renderer);
        renderer = offscreen.player;
        canvas = offscreen.canvas;
        ownsRenderer = true;
    }

    // 2. muxer
    const target_ = container === "mp4" ? new Mp4ArrayBufferTarget() : new WebmArrayBufferTarget();
    const muxer = container === "mp4"
        ? new Mp4Muxer({
            target: target_ as Mp4ArrayBufferTarget,
            video: { codec: videoCandidate.muxerCodec as "avc", width, height },
            ...(audioConfig && audioCandidate
                ? { audio: { codec: audioCandidate.muxerCodec as "aac", numberOfChannels: 2, sampleRate } }
                : {}),
            fastStart: "in-memory",
        })
        : new WebmMuxer({
            target: target_ as WebmArrayBufferTarget,
            video: { codec: videoCandidate.muxerCodec as "V_VP9", width, height, frameRate: fps },
            ...(audioConfig && audioCandidate
                ? { audio: { codec: audioCandidate.muxerCodec as "A_OPUS", numberOfChannels: 2, sampleRate } }
                : {}),
        });

    let encodeError: unknown = null;
    const videoEncoder = new VideoEncoder({
        output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
        error: error => { encodeError = error; },
    });
    videoEncoder.configure(videoConfig);

    // 3. 逐帧渲染
    const capturedSounds: { type: NoteType; beats: number }[] = [];
    const audioProcessor = renderer.audioProcessor;
    const previousCapture = audioProcessor.captureNoteSound;
    // 记的是谱面上的拍数，具体时间等混音时再按同一套偏移换到音频时间轴上
    audioProcessor.captureNoteSound = (type, beats) => {
        capturedSounds.push({ type, beats });
    };

    const wasPlaying = renderer.playing;
    renderer.pause();
    // render() 末尾的 playSounds() 只在 playing 为真时跑；这里不调用 play()，避免拉起 rAF
    renderer.playing = true;

    try {
        for (let i = 0; i < totalFrames; i++) {
            if (options.signal?.aborted) {
                throw new DOMException("录制已取消", "AbortError");
            }
            if (encodeError) {
                throw encodeError;
            }

            renderer.offlineTime = range[0] + i / fps;
            renderer.render();

            const frame = new VideoFrame(canvas, {
                timestamp: Math.round((i * 1e6) / fps),
                duration: Math.round(1e6 / fps),
            });
            // 两秒一个关键帧，方便拖进度条
            videoEncoder.encode(frame, { keyFrame: i % (fps * 2) === 0 });
            frame.close();

            // 唯一需要等的地方：编码器排队太长就让它先消化
            while (videoEncoder.encodeQueueSize > MAX_ENCODE_QUEUE) {
                await tick();
                if (encodeError) throw encodeError;
            }

            if (options.onProgress && (i % 5 === 0 || i === totalFrames - 1)) {
                options.onProgress(i + 1, totalFrames);
            }
        }
        await videoEncoder.flush();
        if (encodeError) throw encodeError;

        // 4. 混音 + 编码音频（放在画面之后：打击音是渲染过程中收集的）
        let audioCodec: string | null = null;
        if (audioConfig && audioCandidate && audioOptions) {
            const mixed = await mixAudio(renderer, range, duration, capturedSounds, {
                sampleRate,
                hitSounds: audioOptions.hitSounds ?? true,
                hitSoundGain: audioOptions.hitSoundGain ?? 1.0,
                source: audioOptions.source,
            });
            if (mixed) {
                const audioEncoder = new AudioEncoder({
                    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
                    error: error => { encodeError = error; },
                });
                audioEncoder.configure(audioConfig);
                await encodeAudio(audioEncoder, mixed, sampleRate);
                await audioEncoder.flush();
                audioEncoder.close();
                if (encodeError) throw encodeError;
                audioCodec = audioCandidate.codec;
            } else {
                console.warn("[recorder] 拿不到 BGM 数据，这次出无声视频");
            }
        }

        muxer.finalize();
        const buffer = (target_ as Mp4ArrayBufferTarget | WebmArrayBufferTarget).buffer;
        return {
            blob: new Blob([buffer], { type: container === "mp4" ? "video/mp4" : "video/webm" }),
            container,
            videoCodec: videoCandidate.codec,
            audioCodec,
            width,
            height,
            fps,
            frames: totalFrames,
            duration,
        };
    } finally {
        audioProcessor.captureNoteSound = previousCapture;
        videoEncoder.close();
        // 恢复成跟随音频
        renderer.offlineTime = null;
        if (ownsRenderer) {
            renderer.destroy();
        } else if (wasPlaying) {
            // 录制前在播的话，录完接着播
            renderer.play();
        } else {
            // 录制期间临时置真的，这里要复原，不然 playSounds 会一直跑
            renderer.playing = false;
        }
    }
}

/** 离屏渲染用的那对（画布 + 播放器） */
interface OffscreenRenderTarget {
    canvas: OffscreenCanvas;
    player: Player;
}

/**
 * 造一块离屏画布上的播放器，共用原播放器已经加载好的资源
 *
 * 原播放器没有 adapter 的话，离屏这份也拿不到谱面里的自定义着色器。
 */
async function createOffscreenPlayer(
    player: Player,
    width: number,
    height: number,
    renderer: RendererPreference = "auto",
): Promise<OffscreenRenderTarget> {
    if (typeof OffscreenCanvas === "undefined") {
        throw new Error("[recorder] 当前环境不支持 OffscreenCanvas，只能录可见画布（target: \"canvas\"）");
    }
    // 播放器只用到 width / height / getContext，OffscreenCanvas 够用
    const canvas = new OffscreenCanvas(width, height);
    const { Player } = await import("./player");
    const offscreen = await Player.create(
        canvas as unknown as HTMLCanvasElement,
        player.audioProcessor,
        player.audio,
        player.background,
        player.respack,
        { renderer },
    );
    player.copyResourcesTo(offscreen);
    await offscreen.receive(player.chart!);

    // 把和画面相关的可调项抄过去，保证录出来和肉眼看到的一致
    offscreen.renderingOffset = player.renderingOffset;
    offscreen.baseOffset = player.baseOffset;
    offscreen.showsRenderingBaseline = player.showsRenderingBaseline;
    offscreen.showsInfo = player.showsInfo;
    offscreen.hitEffectNoFollows = player.hitEffectNoFollows;
    offscreen.noteSize = player.noteSize;
    offscreen.noteHeight = player.noteHeight;
    offscreen.hitEffectSize = player.hitEffectSize;

    return { canvas, player: offscreen };
}

interface MixAudioOptions {
    sampleRate: number;
    hitSounds: boolean;
    hitSoundGain: number;
    source?: Blob | ArrayBuffer;
}

/**
 * 把 BGM 和打击音离线混成一条 2 声道缓冲
 *
 * - BGM 直接从 `player.audio.src` 取（`blob:` 也能 fetch），或者用参数里给的
 * - 打击音按渲染时收集到的时间点排进 `OfflineAudioContext`，交给浏览器自己混，
 *   不需要像服务端那样手写重采样和削波
 */
async function mixAudio(
    player: Player,
    range: [number, number],
    duration: number,
    soundEvents: { type: NoteType; beats: number }[],
    options: MixAudioOptions,
): Promise<AudioBuffer | null> {
    const bytes = await loadAudioBytes(player, options.source);
    if (!bytes) return null;

    const { sampleRate } = options;
    const length = Math.max(1, Math.ceil(duration * sampleRate));

    // 先解码：用 OfflineAudioContext 就够了（decodeAudioData 属于 BaseAudioContext）
    const decodeContext = new OfflineAudioContext(2, 1, sampleRate);
    let bgm: AudioBuffer;
    try {
        bgm = await decodeContext.decodeAudioData(bytes.slice(0));
    } catch (error) {
        console.warn("[recorder] BGM 解码失败，这次出无声视频", error);
        return null;
    }

    const context = new OfflineAudioContext(2, length, sampleRate);
    const bgmSource = context.createBufferSource();
    bgmSource.buffer = bgm;
    bgmSource.connect(context.destination);
    // 直接按范围截取，不用手动裁剪采样
    bgmSource.start(0, Math.max(0, range[0]), duration);

    if (options.hitSounds && soundEvents.length > 0) {
        const gain = context.createGain();
        gain.gain.value = options.hitSoundGain;
        gain.connect(context.destination);

        // 拍数 → 音频时间轴（秒）
        //
        //   renderingTime = audioTime - offset/1000 + baseOffset + renderingOffset * rate
        //
        // 谱面里的 note 是画在渲染时间轴上的，直接拿 renderingTime 当音频时间去排，
        // 会整整差一个 (renderingOffset - offset/1000 + baseOffset)。
        const playbackRate = player.audio.playbackRate || 1;
        const toAudioTime = (beats: number) =>
            player.chart!.timeCalculator.toSeconds(beats)
            + player.chart!.offset / 1000
            - player.baseOffset
            - player.renderingOffset * playbackRate;

        for (const event of soundEvents) {
            const buffer = player.audioProcessor.getNoteSound(event.type);
            if (!buffer) continue;
            const at = toAudioTime(event.beats) - range[0];
            if (at < 0 || at > duration) continue;
            const source = context.createBufferSource();
            source.buffer = buffer;
            source.connect(gain);
            source.start(at);
        }
    }

    return await context.startRendering();
}

/** 取 BGM 的原始字节：优先用参数给的，否则 fetch 播放器里那条音轨 */
async function loadAudioBytes(player: Player, provided?: Blob | ArrayBuffer) {
    try {
        if (provided) {
            return provided instanceof Blob ? await provided.arrayBuffer() : provided.slice(0);
        }
        const src = player.audio?.src;
        if (!src) return null;
        const response = await fetch(src);
        if (!response.ok) return null;
        return await response.arrayBuffer();
    } catch (error) {
        console.warn("[recorder] 取 BGM 失败", error);
        return null;
    }
}

/** 把混好的音频切成 AudioData 喂给编码器，同样只看背压 */
async function encodeAudio(encoder: AudioEncoder, buffer: AudioBuffer, sampleRate: number) {
    const channels = Math.min(2, buffer.numberOfChannels);
    const total = buffer.length;
    const channelData: Float32Array[] = [];
    for (let channel = 0; channel < channels; channel++) {
        channelData.push(buffer.getChannelData(channel));
    }

    for (let offset = 0; offset < total; offset += AUDIO_CHUNK_FRAMES) {
        const frames = Math.min(AUDIO_CHUNK_FRAMES, total - offset);
        // f32-planar：先把每个声道摆平，再拼成一段
        const planar = new Float32Array(frames * 2);
        for (let channel = 0; channel < 2; channel++) {
            const data = channelData[Math.min(channel, channels - 1)]!;
            planar.set(data.subarray(offset, offset + frames), channel * frames);
        }

        const audioData = new AudioData({
            format: "f32-planar",
            sampleRate,
            numberOfFrames: frames,
            numberOfChannels: 2,
            timestamp: Math.round((offset * 1e6) / sampleRate),
            data: planar,
        });
        encoder.encode(audioData);
        audioData.close();

        while (encoder.encodeQueueSize > MAX_ENCODE_QUEUE) {
            await tick();
        }
    }
}
