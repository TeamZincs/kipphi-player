# Kipphi Player - An editor-friendly Phigros Chart Player

奇谱播放器为奇谱发生器的子项目，用于在编辑器中播放Phigros谱面（RPE或KPA格式）。基于[Kipphi](https://github.com/TeamZincs/Kipphi)。

Kipphi Player is a subproject of Kipphi, which is a Phigros chart player for editor. Based on [Kipphi](https://github.com/TeamZincs/Kipphi).

## 使用

```typescript
import { Player, AudioProcessor, Images } from "kipphi-player";
import { Chart } from "kipphi";

// 需自备资产文件

await Images.loadAndOptimize({
    tap: "Tap.png",
    holdBody: "HoldBody.png",
    holdHead: "HoldHead.png",
    drag: "Drag.png",
    flick: "Flick.png",
    anchor: "Anchor.png", // 标识判定线锚点，若不需要可用全透明图片
    chord: "Double.png", // 标识Note为多押
    below: "Below.png", // 标识一个Note为判定线下方，若不需要可用全透明图片
    hitFx: "hit_fx.png" // 目前是写死的，只能用1024x1024，4x4的精灵图做打击特效
});

// 仅打击音效用AudioContext控制，曲目播放仍然用<audio>标签播放
const audioProcessor = new AudioProcessor()
await audioProcessor.init({
    tap: "Tap.wav",
    drag: "Drag.wav",
    flick: "Flick.wav"
});

const name = "qualia";

const audio = new Audio(`charts/${name}/music.mp3`);
// Images.loadImage要load事件触发才会完成Promise，无需担心只加载一部分的问题
const background = await createImageBitmap(await Images.loadImage(`charts/${name}/illustration.jpg`));

const canvas = document.getElementById("canvas") as HTMLCanvasElement;

const chart = Chart.fromKPAJSON(await (await fetch(`charts/${name}/chart.json`)).json())

const player = new Player(canvas, audioProcessor, audio, background);

player.receive(chart, () => void 0)
document.onclick = () => {
    player.play()
};

// 进度、音量等可自行控制

// 打击特效的音量
player.audioProcessor.volume = 2.0;

```


