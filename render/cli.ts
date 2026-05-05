import { Command, createCommand } from "commander";
import { renderChartFast, unpackResources, useFont, useRespack } from "./render";
import { readFile, writeFile } from "fs/promises";
import { ZipReader } from "./unzip";
import { Respack } from "./respack";

const command = createCommand()
    .name("kpprender")
    .usage("<file> --output <path> --font <path> --respack <path> [options]")
    .description("A high-performance yet light-weighted (lack functionality, lol) renderer for Re:PhiEdit PEZ chart projects. \n一个高性能但轻量（指没什么功能（ ）的 Re:PhiEdit PEZ 谱面渲染器。")
    .argument("<chart>", "The chart PEZ file to render.\n所需渲染的 PEZ 谱面文件")
    .option("-o, --output <path>", "Output file name (default: output.png)\n输出文件名（默认：output.png）", "output.png")
    .option("-w, --width [width]", "Output width (default: 1600)\n输出宽度（默认：1600）", parseInt, 1600)
    .option("-h, --height [height]", "Output height (default: 900)\n输出高度（默认：900）", parseInt, 900)
    .option("-r, --range [start,end]", "Render range (default: full chart)\n渲染范围（默认：整张谱面）", (range) => range.split(",").map(parseInt), [0, Infinity])
    .option("-f, --fps [fps]", "Output FPS (default: 60)\n输出帧率（默认：60）", parseInt, 60)
    .option("--font <path>", "Font file path\n字体文件路径")
    .option("--respack <path>", "Respack file path\n资源包文件路径")
    .option("--disable-sound-effects", "Disable sound effects\n禁用音效", false)
    .option("--crf [crf]", "CRF (default: 23)\nCRF（默认：23）", parseInt, 23)
    .option("--hardware", "Use hardware acceleration if available\n尽可能使用硬件加速", true)

if (import.meta.main) {
    command.parse(process.argv);
    const options = command.opts();
    const args = command.args;
    const resources = await unpackResources(await readFile(args[0]));
    useFont(options.font);
    const zipReader = new ZipReader(await readFile(options.respack));
    useRespack(await Respack.loadFromPhira((path) => zipReader.extractFile(path)));
    const result = await renderChartFast(resources, {
        fps: options.fps,
        soundEffect: !options.disableSoundEffects,
        crf: options.crf,
        useHardwareIfAvailable: options.hardware,
        width: options.width,
        height: options.height,
        timeRange: options.range,
    });
    console.log(`Rendering completed in ${result.costTime} seconds. Average FPS: ${result.averageFps}`)
    await writeFile(options.output, result.video);
}