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
import { Player, AudioProcessor, Images, Respack, setWasmPath } from "kipphi-player";
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

// 后端异步初始化，所以用工厂方法而不是 new（详见下一节）
const player = await Player.create(canvas, audioProcessor, audio, background, respack, {
    renderer: "auto",
});

setWasmPath(...); // web-demuxer所用的WASM文件，如果不需要BGA功能无需设置。

await player.receive(chart, async (textureName) => {
    // 自行实现纹理加载逻辑（在前端，需要的是Blob）
    // 不需要纹理的话返回undefined或者null即可
    return ...
}, async (videoName) => {
    return ...
})
document.onclick = () => {
    player.play();
};

// 进度、音量等可自行控制

// 打击特效的音量
player.audioProcessor.volume = 2.0;

```

## 浏览器端的渲染后端

浏览器里默认走 GPU：每帧先把绘制记录成实例，`flush()` 时统一按 z 排序、合批，再实例化绘制。后端优先级是 **WebGPU → WebGL 1 → Canvas 2D**。

因为要 `await` 初始化（WebGPU 要拿 device），构造函数做不到，所以入口是静态工厂：

```typescript
const player = await Player.create(canvas, audioProcessor, audio, background, respack, {
    renderer: "auto",   // 默认
});

console.log(player.rendererName); // "WebGPU" / "WebGL 1" / "Canvas 2D"
```

`renderer` 可选：

| 值 | 行为 |
| --- | --- |
| `"auto"`（默认） | WebGPU → WebGL 1 → Canvas 2D |
| `"webgpu"` | 明确想要 WebGPU，拿不到时同样会往后退 |
| `"webgl1"` | 优先 WebGL 1，不会尝试 WebGPU |
| `"canvas2d"` | 只用 Canvas 2D（与旧版本行为一致） |

拿不到指定的后端不会抛错，只会在控制台 warn 然后降级。直接 `new Player(...)` 仍然能用，但只会得到 Canvas 2D。

GPU 模式下 FPS 那一行会多显示平均 draw call 数，例如：

```
45.0 (avg 18.20ms, max 42.10ms)(5 tex, 14.0 dc, 2 shader, WebGPU)
```

- `tex`：这帧用到的贴图数量
- `dc`：最近一秒平均每帧的 draw call 数
- `shader`：这帧实际跑过的特效着色器趟数（`blur` 这种两趟的算 2；没有特效就是 0）

排查卡顿可以打开 `Player.debugTiming = true`，每帧会打印 `记录 / 提交` 耗时和实例数。想整体关掉 GPU 就用 `Player.gpuEnabled = false`。

## 单独使用 GPU 2D 上下文

`context.ts` 里的 `AnyGPUContext2D` 不依赖 Player，可以单独用：

```typescript
import { AnyGPUContext2D } from "kipphi-player";

const gpu = await AnyGPUContext2D.create({ canvas, zRange: [0, 10] });

const background = gpu.createLayer(0);
const notes = gpu.createLayer(5);

background.fillStyle = "#101018";
background.fillRect(0, 0, gpu.width, gpu.height);

notes.tint = [255, 128, 128];   // 0..255 三元组，和 fillStyle 一样是状态机
notes.drawImage(noteBitmap, 10, 20, 64, 64);
notes.z = 6;                    // 手动指定另一个 z

gpu.flush();                    // 排序 + 合批 + 实例化绘制，并清空图层记录
```

- 图层的 API 与 `CanvasRenderingContext2D` 基本一致，另外多了 `tint` 和 `z`
- 绘制全部是延迟的，`flush()` 时才提交；同一帧内按 z **稳定排序**，z 相同则保持记录顺序
- z 的归一化完全在着色器里做：顶点着色器只收 `zMin` 和 `1/(zMax-zMin)`，CPU 侧不碰归一化后的值
- 每个图层、每个绘制实例都可以使用不同的纹理与混合模式（`source-over` / `destination-out` / `lighter`），连续的相同组合会被合成一次 draw call

已知取舍：不支持渐变、pattern、阴影、`clip`、`Path2D`；自相交多边形按简单多边形三角化；描边拐角用方补角近似，半透明描边重叠处会被叠加两次。

### 按 z 区间做后处理

`setEffect(from, to, chain)` 可以给某个 z 区间挂一条着色器链（区间**左闭右开**）：

```typescript
gpu.addShader({
    name: "invert",
    glsl: `
    uniform float factor; // %0.5%
    void main() {
        vec4 c = texture2D(screenTexture, uv);
        gl_FragColor = mix(c, vec4(1.0) - c, factor);
    }`,
    wgsl: `
    let c = textureSample(screenTexture, samp, in.uv);
    return mix(c, vec4f(1.0) - c, factor);`,
});

gpu.setEffect(0, 9, [{ shader: "invert", uniforms: { factor: 1 } }]);   // 只影响 z < 9 的图层
```

- 区间内的图层先画到离屏纹理，再过着色器链，最后叠加回整帧；整帧画完一次性贴回画布
- 着色器里可用 `uv`、`screenTexture`、`screenSize`、`time`，自定义 uniform 用 `uniform float x; // %默认值%` 声明
- **uniform 布局是自动解析的**，不用手写 `layout`：GLSL 看 `uniform` 声明，WGSL 看 `// @uniform float x = 0.5` 注释指令，两者都有时合并（同名以 WGSL 为准）；只有想覆盖解析结果时才需要显式写 `layout`
- 谱面没给某个 uniform 时用声明的默认值
- WebGL 1 用 `glsl`，WebGPU 用 `wgsl`，两边都给了才能跨后端
- 没有设置任何特效时走原来的快路径，不产生额外 pass

## 特效（Phira Effects）

谱面自带的 `effects` 会自动接入这套机制：每帧把当前激活的特效转成着色器链，再按 `global` 决定作用范围。

图层 z 的划分（GPU 模式）：

| z | 内容 |
| --- | --- |
| `0` | 背景、视频、判定线、渲染范围圆 |
| `3`~`8` | hold / drag / tap / flick / 打击特效 / 贴图边框 |
| `9` | 谱面自己的 UI：combo、分数、曲名、等级、进度条、线号、曲线 |
| `10` | 覆盖层，**只放帧率和时间** |

- `global: false`（默认）：只作用于谱面图层 `[0, 9)`，谱面 UI 和覆盖层都不受影响
- `global: true`：作用于 `[0, 10)`，即谱面 + 谱面 UI，但**永远不含**只放帧率/时间的覆盖层

内置着色器：

| 名字 | 参数（默认值） | 说明 |
| --- | --- | --- |
| `chromatic` | `power` (0.05)、`sampleCount` (5) | 色差，R/B 通道沿「像素 → 屏幕中心」反向偏移 |
| `blur` | `radius` (0.01) | 高斯模糊，`radius` 以 uv 为单位；内部展开成水平 + 垂直两趟 |
| `circleBlur` | `size` (10.0) | 点状模糊，越靠近屏幕中心越糊，糊出来的一团会更亮 |
| `grayscale` | `factor` (1.0) | 去色，0 = 原色，1 = 完全灰度 |
| `pixel` | `size` (10.0) | 像素化，`size` 是像素块边长（屏幕像素） |
| `shockwave` | `progress` (0.2)、`centerX`/`centerY` (0.5)、`width` (0.1)、`distortion` (0.8)、`expand` (10.0) | 冲击波，`progress` 从 0 推到 1 播一次 |
| `vignette` | `color` (黑)、`extend` (0.25)、`radius` (15.0) | 暗角，边缘向 `color` 渐变 |

参数名与默认值对齐 Phira 文档。`progress` 是唯一一个会兜底的：谱面自己写了就按谱面的，没写时按特效的 `[start, end]` 自动算 0→1。

自定义着色器（`shader` 以 `/` 开头，指向谱面包里的文件）通过 `receive()` 的第 4 个参数索取：

```typescript
await player.receive(chart, textureFetcher, videoFetcher, async (path) => {
    const glsl = await loadTextFromPack(path);   // path 形如 "/xxx.frag"
    return { name: path, glsl };                 // 有 WGSL 版本的话再加 wgsl
});
```

要提前知道谱面引用了哪些文件，用 `chart.scanAllShaders()`（返回 `Set<string>`，保留开头的 `/`，和 `effect.shader` 一致；内置着色器不在其中）。`receive()` 内部就是用它在加载阶段一次性把着色器取回来并注册的，没提供 `shaderFetcher` 时只会 warn 并跳过这些特效。

自定义着色器遵循 Phira 约定：`#version 100` 的片元着色器，可用 `uv` / `screenTexture` / `screenSize` / `time`，自定义 uniform 用 `uniform float factor; // %0.5%` 声明默认值。拼装时会：

- 把 `#version` 挪到第一行（它必须在最前面），重复的会被去掉
- 只补你没声明的内置变量，已经声明过的不再重复声明
- 从 `// %值%` 注释里解析 uniform 默认值，谱面没给这个变量时用它

目前只有 GLSL（WebGL 1）一路，WebGPU 后端下会被跳过并在控制台 warn；想两端通用请同时提供 `wgsl`。

也可以不用谱面的 effects，直接 `player.addEffectShader()` / `gpu.addShader()` 手工注册再 `setEffect()`。

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

## 许可
本项目基于MIT许可发布。如果您需要背景视频，请在 `web-demuxer` 项目下获得由 FFMPEG 源码编译而来的、按照 LGPL 许可发布的 WASM 文件。
