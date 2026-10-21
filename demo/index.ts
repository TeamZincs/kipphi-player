import { Player, AudioProcessor, Images, Respack, VideoFrameSource, setWasmPath, type RendererPreference } from "..";
import { Chart } from "kipphi";
import { unzip } from "./unzip";

// web-demuxer 的 wasm 跟静态资源一起放在 public/ 里，离线也能跑
setWasmPath("./web-demuxer.wasm");

// 方便在控制台里调试：Player.debugTiming = true / Player.gpuEnabled = false
(window as any).Player = Player;

const canvas = document.getElementById("canvas") as HTMLCanvasElement;

// 谱面字体（index.html 里 @font-face 声明）。等它真的加载完再开始画，
// 否则前几帧的文字会用兜底字体渲染
await Promise.all([
    Images.loadAndOptimize({
        anchor: "./Anchor.png",
        below: "./Below.png",
    }),
    document.fonts.load("64px phigros"),
]);

const respack = await Respack.loadFromPhira(async (name) => {
    return await fetch(`./default/${name}`).then(r => r.blob())
})


const audioProcessor = new AudioProcessor();
audioProcessor.init({
    tap: "./Tap.wav",
    drag: "./Drag.wav",
    flick: "./Flick.wav"
})





/*
eventCurveEditors.changeTarget({
    layerID: "0",
    judgeLine: chart.orphanLines[0],
})
    */




export function parseInfoTxt(infoTxt: string) {
    const lines = infoTxt.split("\n");
    const info: Record<string, string>= {};
    for (const line of lines) {
        // 第一行是#
        if (line.startsWith("#")) {
            continue;
        }
        if (line.trim() === "") {
            continue;
        }
        const [key, value] = line.split(":");
        if (!key || !value) {
            console.log(`Invalid line: '${line}'d`);
            continue;
        }
        info[key.trim()] = value.trim();
    }
    return info;
}



/**
 * 解析未解码的原始字节序列。
 * 
 * 先尝试UTF-8解码，如果失败，则尝试GBK解码。
 * 
 * 如果GBK解码失败，则抛出错误。
 * @param raw 
 * @returns 
 */
export function parseRawInfoTxt(raw: Uint8Array | ArrayBuffer) {
    let infoTxt: string;
    try {
        infoTxt = new TextDecoder("utf-8", {fatal: true}).decode(raw);
    } catch (error) {
        // https://developer.mozilla.org/zh-CN/docs/Web/API/TextDecoder/fatal
        if (!(error instanceof TypeError)) {
            throw error;
        }
        infoTxt = new TextDecoder("gbk", {fatal: true}).decode(raw);
    }
    return parseInfoTxt(infoTxt);
}


const fileInput = document.getElementById("fileInput") as HTMLInputElement;
fileInput.addEventListener("change", async (e) => {
    const file = fileInput.files[0];

    const unzipped = await unzip(file);

    // 谱面里的资源路径可能带 `/`（Phira 的自定义着色器就是 `/xxx.frag`）或 `./` 前缀，
    // 压缩包里的条目则不一定带，统一去掉前缀再比
    const normalizePath = (path: string) => path.replace(/^(\.\/|\/)+/, "");
    const findFile = (path: string) => {
        const target = normalizePath(path);
        return unzipped.files.find(file => normalizePath(file.name) === target);
    };

    const infoTxt = unzipped.files.find(file => file.name === "info.txt");
    if (!infoTxt) {
        return alert("No info.txt");
    }
    const info = parseRawInfoTxt(infoTxt.buffer);
    const chartFile = unzipped.files.find(file => file.name === info.Chart);
    const illustrationFile = unzipped.files.find(file => file.name === info.Picture);
    const audioFile = unzipped.files.find(file => file.name === info.Song);

    if (!chartFile || !illustrationFile || !audioFile) {
        return alert("Missing required files");
    }
    
    const audio = new Audio(URL.createObjectURL(new Blob([audioFile.buffer])));
    await new Promise((r) => {
        audio.oncanplay = r;
    })

    // Phira 的 extra.json：BPM、视频通道、特效（effects）都在里面，
    // 不传的话谱面就没有特效，scanAllShaders() 也会是空的
    const extraFile = findFile("extra.json");
    let extraJson: any = undefined;
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
        extraJson,
    );
    
    const background = await createImageBitmap(new Blob([illustrationFile.buffer]));

    // 可以用 ?renderer=webgl1 / canvas2d / webgpu 强制指定后端
    const requested = new URLSearchParams(location.search).get("renderer");
    const renderer = (["auto", "webgpu", "webgl1", "canvas2d"] as const).includes(requested as any)
        ? requested as RendererPreference
        : "auto";
    const player = await Player.create(canvas, audioProcessor, audio, background, respack, { renderer });
    console.log(`[demo] 渲染后端: ${player.rendererName}`);
    player.renderingOffset = -0.40;
    player.baseOffset = -0.017;
    player.showsRenderingBaseline = false;
    player.hitEffectNoFollows = true;
    // 贴图 / 视频 / 着色器都从压缩包里取，直接按名字在根目录找
    player.use({
        texture: async (name) => {
            const file = findFile(name);
            return file ? await createImageBitmap(new Blob([file.buffer])) : null;
        },
        video: async (name) => {
            const file = findFile(name);
            if (!file) {
                throw new Error(`压缩包里没有这个视频: ${name}`);
            }
            return await VideoFrameSource.from(new File([file.buffer], name));
        },
        shader: async (path) => {
            // Phira 的自定义着色器路径以 / 开头（如 /xxx.frag），包内条目一般不带
            const file = findFile(path);
            if (!file) {
                console.warn(`[demo] 压缩包里没有这个着色器: ${path}`);
                return null;
            }
            // 注册名必须和谱面里的 effect.shader 完全一致，所以这里用原始 path
            return { name: path, glsl: new TextDecoder().decode(file.buffer) };
        },
    });
    await player.receive(chart);
    window.addEventListener("keydown", (e) => {
        if (e.key !== " ") {
            return;
        }
        if (!player.playing) {
            player.play()
        } else {
            player.pause();
        }
    });
})
