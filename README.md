# Kipphi Player - An editor-friendly Phigros Chart Player

奇谱播放器为奇谱发生器的子项目，用于在编辑器中播放Phigros谱面（RPE或KPA格式）。基于[Kipphi](https://github.com/TeamZincs/Kipphi)。该播放器秉持“无状态渲染”的原则，这是其编辑器友好性的核心。

Kipphi Player is a subproject of Kipphi, which is a Phigros chart player for editor. Based on [Kipphi](https://github.com/TeamZincs/Kipphi). This player adopts the principle of "stateless rendering", which is the core of its editor-friendliness.

## 真的是“无状态渲染”吗？
奇谱播放器的渲染大体上是无状态的，但其计算完判定线的位置等属性后会将数值缓存到判定线对象上（注意奇谱上面并没有这些属性，它们是奇谱播放器扩展上去的）。不过这些属性并不会延续到下一帧使用。

此外，计算 combo 和播放音效时会使用游标优化顺序读取。但对于 Note 渲染、事件定位，由于使用了近乎 O(1) 复杂度的容器（参考奇谱发生器/性能优化策略），因此并不需要游标优化。因此，可以说奇谱播放器几乎就是无状态渲染的。 

## Is it really "stateless rendering"?
Kipphi Player's rendering is almost stateless, but it will cache some values to the judgeline objects after calculating their positions and other attributes (note that these attributes do not exist in the original Kipphi, but they are added by Kipphi Player). However, these attributes will not be carried over to be used in the next frame.

In addition, when calculating combos and playing sounds, the cursor optimization is used to optimize the order of reading. However, for note rendering and event positioning, because of the nearly O(1) complexity of the container (see Kipphi Generator/performance optimization strategy), no cursor optimization is needed. Therefore, it can be said that Kipphi Player is almost stateless rendering.

## 使用

最简单用例：
```typescript
import { Player, AudioProcessor, Images, Respack } from "kipphi-player";
import { Chart } from "kipphi";

await Images.loadAndOptimize({
    anchor: "Anchor.png", // 标识判定线锚点，若不需要可用全透明图片
    below: "Below.png", // 标识一个Note为判定线下方，若不需要可用全透明图片
});

// 需自备Phira格式的资源包
const respack = Respack.loadFromPhira(async (filename) => {
    // 自行实现获得资源包内文件的逻辑
    // 最简单的方法是，直接把解压好的资源包放在一个文件夹内，然后在此函数中用fetch获得它们
    return ...
})

// AudioProcessor，包装了AudioContext的对象。
// 仅打击音效用AudioContext控制，曲目播放仍然用<audio>标签播放
const audioProcessor = new AudioProcessor()
await audioProcessor.init({
    tap: "Tap.wav",
    drag: "Drag.wav",
    flick: "Flick.wav"
});
// 如果资源包里已经有音效了，可以用这个方法直接创建
const audioProcessor = AudioProcessor.fromRespack(respack);

const name = "qualia";

const audio = new Audio(`charts/${name}/music.mp3`);
// Images.loadImage要load事件触发才会完成Promise，无需担心只加载一部分的问题
const background = await createImageBitmap(await Images.loadImage(`charts/${name}/illustration.jpg`));

const canvas = document.getElementById("canvas") as HTMLCanvasElement;

// 也可以渲染RPE谱面，自己选择
const chart = Chart.fromKPAJSON(await (await fetch(`charts/${name}/chart.json`)).json());

const player = new Player(canvas, audioProcessor, audio, background);

player.receive(chart, async (textureName) => {
    // 自行实现纹理加载逻辑（在前端，需要的是Blob）
    // 不需要纹理的话返回undefined或者null即可
    return ...
})
document.onclick = () => {
    player.play();
};

// 进度、音量等可自行控制

// 打击特效的音量
player.audioProcessor.volume = 2.0;

```

## 用于后端
得益于 `skia-canvas`，奇谱播放器也可用于Node.js或Bun等后端运行环境。

安装后端版本：`npm install kpp-render` 或 `bun add kpp-render`。（其实我还没上传这个包）

在拯救者Y7000P（i7 14650，GeForce 5060）上的测试，干跑物量1000左右谱面的渲染，速度平均能有1000多fps。渲染Sildild的Singularity谱面（物量84488），平均速度30多fps。峰值内存占用约2GiB。

但是以上是干跑渲染。如果使用ffmpeg（为了在单进程中尽量零拷贝，本项目使用了 `node-av`）收集并合成视频，则会受到编码及封装的速度限制。本人不太会玩视频合成，无法尽可能压榨 ffmpeg 性能，欢迎优化。

```ts
export async function renderChartFast(
    chart: Chart,
    illustrationBlobOrBuffer: Blob | Buffer,
    textureFetcher: (name: string) => Promise<Buffer>,
    audioBuffer: Buffer,
    range?: [number, number]
): Promise<{
    out: Buffer;
    duration: number;
    fps: number;
}>;
```
