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
