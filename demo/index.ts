import { Player, AudioProcessor, Images, Respack, VideoFrameSource, setWasmPath, type RendererPreference } from "..";
import { Chart } from "kipphi";
import { unzip } from "./unzip";

// web-demuxer 的 wasm：demo 直接用 CDN，省得往 dist 里拷静态文件
setWasmPath("https://cdn.jsdelivr.net/npm/web-demuxer@4/dist/wasm-files/web-demuxer.wasm");

// 方便在控制台里调试：Player.debugTiming = true / Player.gpuEnabled = false
(window as any).Player = Player;

const canvas = document.getElementById("canvas") as HTMLCanvasElement;

await Images.loadAndOptimize({
    anchor: "./Anchor.png",
    below: "./Below.png",
});

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
    const chart = Chart.fromRPEJSON(JSON.parse(new TextDecoder().decode(chartFile.buffer)), audio.duration);
    
    const background = await createImageBitmap(new Blob([illustrationFile.buffer]));

    // 可以用 ?renderer=webgl1 / canvas2d / webgpu 强制指定后端
    const requested = new URLSearchParams(location.search).get("renderer");
    const renderer = (["auto", "webgpu", "webgl1", "canvas2d"] as const).includes(requested as any)
        ? requested as RendererPreference
        : "auto";
    const player = await Player.create(canvas, audioProcessor, audio, background, respack, { renderer });
    console.log(`[demo] 渲染后端: ${player.rendererName}`);
    player.renderingOffset = -0.40;
    player.baseOffset = 0.20;
    player.showsRenderingBaseline = false;
    player.hitEffectNoFollows = true;
    player.receive(
        chart,
        async (name) => {
            const file = unzipped.files.find(file => file.name === name);
            if (!file) {
                return null;
            } else {
                return await createImageBitmap(new Blob([file.buffer]));
            }
        },
        async (name) => {
            // 和贴图一样，直接从压缩包根目录里找
            const file = unzipped.files.find(file => file.name === name);
            if (!file) {
                throw new Error(`压缩包里没有这个视频: ${name}`);
            }
            return await VideoFrameSource.from(new File([file.buffer], name));
        },
        async (path) => {
            // Phira 的着色器路径形如 /xxx.frag，包内文件名通常不带开头的斜杠
            const name = path.replace(/^\.?\//, "");
            const file = unzipped.files.find(file => file.name === name || file.name === `./${name}`);
            if (!file) {
                return null;
            }
            return { name: path, glsl: new TextDecoder().decode(file.buffer) };
        },
    );
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
