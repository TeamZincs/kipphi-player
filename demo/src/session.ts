import {
    AudioProcessor,
    Images,
    Player,
    Respack,
    VideoFrameSource,
    recordPlayer,
    setWasmPath,
    type RecordResult,
    type RendererPreference,
} from "../..";
import { Chart } from "kipphi";

import { unzip } from "./unzip";

export interface LoadedPack {
    player: Player;
    /** BGM 原始字节，录制时直接给，省得再 fetch 一遍 */
    audio: ArrayBuffer;
    duration: number;
}

/**
 * 解包之后、**还没建播放器**的中间态
 *
 * 录制页只用来录，画布藏在视口外没人看，所以播放器没必要在选包时就建出来
 * （建出来会挑一个后端、打印一行，点「录制」换后端时又打印一行，很容易让人以为
 * 后端被改过）。选包只做到这一步，点按钮时再 {@linkcode DemoSession.play}。
 */
export interface PreparedPack {
    chart: Chart;
    background: ImageBitmap;
    /** 已经加载好的 BGM 元素（播放器要用） */
    audioElement: HTMLAudioElement;
    /** BGM 原始字节，录制时直接给，省得再 fetch 一遍 */
    audio: ArrayBuffer;
    duration: number;
    /** `?renderer=` 指定的后端，`play()` 没给就用它 */
    renderer: RendererPreference;
    /** `?stats`：建好播放器后直接赋给 `player.showStats` */
    showStats: boolean;
    /** 谱面要求的所有贴图 / 视频 / 着色器都从这里取 */
    adapter: Parameters<Player["use"]>[0];
}

/** 谱面里的资源路径可能带 `/`（自定义着色器就是 `/xxx.frag`）或 `./` 前缀，包内条目则不一定带 */
const normalizePath = (path: string) => path.replace(/^(\.\/|\/)+/, "");

export function parseInfoTxt(infoTxt: string) {
    const lines = infoTxt.split("\n");
    const info: Record<string, string> = {};
    for (const line of lines) {
        // 第一行是 #
        if (line.startsWith("#")) continue;
        if (line.trim() === "") continue;
        const [key, value] = line.split(":");
        if (!key || !value) {
            console.log(`Invalid line: '${line}'`);
            continue;
        }
        info[key.trim()] = value.trim();
    }
    return info;
}

/**
 * 解析未解码的原始字节序列
 *
 * 先尝试 UTF-8，失败再试 GBK（老谱面包常见）。
 */
export function parseRawInfoTxt(raw: Uint8Array | ArrayBuffer) {
    let infoTxt: string;
    try {
        infoTxt = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        infoTxt = new TextDecoder("gbk", { fatal: true }).decode(raw);
    }
    return parseInfoTxt(infoTxt);
}

/**
 * demo 的一次「会话」：图片 / 字体 / 资源包 / 打击音这些只加载一次，
 * 之后换谱面只重建 Player。
 */
export class DemoSession {
    private constructor(
        readonly respack: Respack,
        readonly audioProcessor: AudioProcessor,
    ) { }

    /** 等静态资源就绪（字体没加载完就画的话，前几帧的文字会用兜底字体） */
    static async create(): Promise<DemoSession> {
        // public/ 里的东西一律按 **base** 取，不能用 `./`：
        // 多页模式下录制页的地址是 `/kipphi-player/record/`，`./Anchor.png`
        // 会被解析成 `/kipphi-player/record/Anchor.png` —— 那个路径不存在
        const asset = (path: string) => `${import.meta.env.BASE_URL}${path}`;

        setWasmPath(asset("web-demuxer.wasm"));
        await Promise.all([
            Images.loadAndOptimize({ anchor: asset("Anchor.png"), below: asset("Below.png") }),
            document.fonts.load("64px phigros"),
        ]);
        const respack = await Respack.loadFromPhira(async name => {
            const url = asset(`default/${name}`);
            const response = await fetch(url);

            // 404 的时候 fetch 不报错，拿到的是 HTML 错误页 —— 后面交给
            // `createImageBitmap` 只会得到一个没头没脑的 img error 事件
            if (!response.ok) {
                // 音效缺了不用管：`loadFromPhira` 已经按「可选」处理（读不到就留空），
                // 这里照样抛，让它自己 catch 掉
                throw new Error(`资源包缺文件：${url}（HTTP ${response.status}，页面地址 ${location.href}）`);
            }

            return await response.blob();
        });
        const audioProcessor = new AudioProcessor();
        await audioProcessor.init({
            tap: asset("Tap.wav"),
            drag: asset("Drag.wav"),
            flick: asset("Flick.wav"),
        });
        return new DemoSession(respack, audioProcessor);
    }

    /**
     * 解包 + 解析谱面（**不建播放器**，见 {@linkcode PreparedPack}）
     *
     * `sequential` 会跳过视频重编码（只 demux）：录制 / 离线导出用得上，
     * 预览不行 —— 往回拖进度条要靠重编码出来的小 GOP 才跟手。
     */
    async load(
        file: File,
        log: (s: string) => void = () => { },
        options: { sequential?: boolean } = {},
    ): Promise<PreparedPack> {
        const unzipped = await unzip(file);
        const findFile = (path: string) => {
            const target = normalizePath(path);
            log(`[demo] 查找文件 ${target}`);
            return unzipped.files.find(item => normalizePath(item.name) === target);
        };

        const infoTxt = unzipped.files.find(item => item.name === "info.txt");
        if (!infoTxt) throw new Error("压缩包里没有 info.txt");
        const info = parseRawInfoTxt(infoTxt.buffer);
        const chartFile = unzipped.files.find(item => item.name === info.Chart);
        const illustrationFile = unzipped.files.find(item => item.name === info.Picture);
        const audioFile = unzipped.files.find(item => item.name === info.Song);
        if (!chartFile || !illustrationFile || !audioFile) {
            throw new Error("压缩包缺少谱面 / 曲绘 / 音频");
        }

        const audio = new Audio(URL.createObjectURL(new Blob([audioFile.buffer as ArrayBuffer])));
        await new Promise<void>(resolve => { audio.oncanplay = () => resolve(); });

        // Phira 的 extra.json：BPM、视频通道、特效都在里面，不传的话就没有特效，
        // scanAllShaders() 也是空的
        const extraFile = findFile("extra.json");
        let extraJson: unknown = undefined;
        if (extraFile) {
            try {
                const text = new TextDecoder().decode(extraFile.buffer).replace(/^\uFEFF/, "");
                extraJson = JSON.parse(text);
            } catch (error) {
                console.warn("[demo] extra.json 解析失败，忽略:", error);
            }
        } else {
            console.warn("[demo] 压缩包里没有 extra.json，特效和 BGA 都不会有");
        }

        const chart = Chart.fromRPEJSON(
            JSON.parse(new TextDecoder().decode(chartFile.buffer)),
            audio.duration,
            extraJson as never,
        );
        const background = await createImageBitmap(new Blob([illustrationFile.buffer as ArrayBuffer]));

        // 可以用 ?renderer=webgl1 / canvas2d / webgpu 强制指定后端
        const requested = new URLSearchParams(location.search).get("renderer");
        const renderer = (["auto", "webgpu", "webgl1", "canvas2d"] as const).includes(requested as never)
            ? requested as RendererPreference
            : "auto";

        return {
            chart,
            background,
            audioElement: audio,
            audio: audioFile.buffer.slice(0),
            duration: chart.duration,
            renderer,
            // ?stats 打开帧率/帧时间覆盖层（离屏录制的播放器不带这个，免得录进画面）
            showStats: new URLSearchParams(location.search).has("stats"),
            adapter: {
                texture: async (name) => {
                    const file = findFile(name);
                    return file ? await createImageBitmap(new Blob([file.buffer as ArrayBuffer])) : null;
                },
                video: async (name) => {
                    const file = findFile(name);
                    if (!file) throw new Error(`压缩包里没有这个视频: ${name}`);
                    return await VideoFrameSource.from(
                        new File([file.buffer as ArrayBuffer], name),
                        { sequential: options.sequential ?? false },
                    );
                },
                shader: async (path) => {
                    const file = findFile(path);
                    if (!file) {
                        console.warn(`[demo] 压缩包里没有这个着色器: ${path}`);
                        return null;
                    }
                    // 注册名必须和谱面里的 effect.shader 完全一致，所以用原始 path
                    return { name: path, glsl: new TextDecoder().decode(file.buffer) };
                },
            },
        };
    }

    /**
     * 建播放器并把资源灌进去
     *
     * 录制页点按钮时才调 —— 那时才知道用户要哪个后端。
     */
    async play(
        prepared: PreparedPack,
        canvas: HTMLCanvasElement,
        renderer?: RendererPreference,
    ): Promise<LoadedPack> {
        const player = await Player.create(
            canvas,
            this.audioProcessor,
            prepared.audioElement,
            prepared.background,
            this.respack,
            { renderer: renderer ?? prepared.renderer },
        );

        // 覆盖层就是个 if，直接赋值就行（不进 options）
        player.showStats = prepared.showStats;

        console.log(`[demo] 渲染后端: ${player.rendererName}`);
        // 实时预览用的显示延迟补偿；录制时 recorder 会临时归零
        player.renderingOffset = -0.40;
        player.baseOffset = -0.017;
        player.showsRenderingBaseline = false;
        player.hitEffectNoFollows = true;

        player.use(prepared.adapter);
        await player.receive(prepared.chart);

        return { player, audio: prepared.audio, duration: prepared.duration };
    }

    /**
     * 录一段
     *
     * `range` 是秒数区间 `[起, 止)`；止为 `null` 或超出时长就到结尾。
     * `renderer` 不给就用 `?renderer=`（或者 auto）—— 也就在这一刻才建播放器。
     */
    async record(
        pack: LoadedPack | PreparedPack,
        canvas: HTMLCanvasElement,
        target: "canvas" | "offscreen",
        range: [number, number | null],
        onProgress: (frame: number, total: number) => void,
        renderer?: RendererPreference,
    ): Promise<RecordResult> {
        const end = range[1] === null ? pack.duration : Math.min(pack.duration, range[1]);
        // 还没建播放器（录制页就是这样）就先建一个，后端按这次录制的要求来
        const loaded = "player" in pack ? pack : await this.play(pack, canvas, renderer);

        return await recordPlayer(loaded.player, {
            target,
            fps: 60,
            range: [range[0], end],
            renderer,
            audio: { source: loaded.audio },
            onProgress,
        });
    }
}

/** 把录好的文件塞给浏览器下载 */
export function downloadResult(result: RecordResult, name: string) {
    const url = URL.createObjectURL(result.blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${name}.${result.container}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

let singleton: Promise<DemoSession> | null = null;

/**
 * 两个路由共用一个会话：图片 / 字体 / 资源包 / 打击音只加载一次。
 *
 * 每个页面自己建播放器（各有一块 canvas），但底层资源是共享的。
 */
export function getSession(): Promise<DemoSession> {
    singleton ??= DemoSession.create();

    return singleton;
}
