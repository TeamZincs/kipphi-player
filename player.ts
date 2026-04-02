import { 
    Chart,
    Note,
    type NNNOrTail,
    NodeType,
    TimeCalculator,
    NNNode,
    JudgeLine,
    type RGB,
    type NNOrTail,
    HNList,
    NNList,
    NoteNode,
    NoteType,
    TC,
    NNNodeLike
} from "kipphi";
/// #default
import { AudioProcessor } from "./audio";
/// #enddefault
import { drawLine, innerProduct, rgb, rgba } from "./util";
import { Coordinate, identity, Matrix33 } from "./matrix";
import { drawNthFrame, Images } from "./image";
import { type Vector } from "./util";
import { NOTE_HEIGHT, NOTE_WIDTH } from "./constants";
import type { Respack } from "./respack";
/*
#node {
import { Canvas, type CanvasRenderingContext2D, type Image, type ImageData, Path2D } from "skia-canvas";
import { AudioProcessor } from "./audioProcessor";
}
*/

const HOLD_HE_SPEED = 2;
const HOLD_HE_INTERVAL = 1 / HOLD_HE_SPEED;

// 扩展JudgeLine，在上面缓存每帧的数据
declare module "kipphi" {
    interface JudgeLine {
        renderMatrix: Matrix33;
        moveX: number;
        moveY: number;
        rotate: number;
        alpha: number;
        transformedX: number;
        transformedY: number;
        optimized: boolean;
    }
}

const ENABLE_PLAYER = true;
const DRAWS_NOTES = true;

const DEFAULT_ASPECT_RATIO = 3 / 2
const LINE_WIDTH = 6.75;
const LINE_COLOR = "#CCCC77";
const HIT_EFFECT_SIZE = 200;
const HALF_HIT = HIT_EFFECT_SIZE / 2

// 以原点为中心，渲染的半径
const RENDER_SCOPE = 1000;

const COMBO_TEXT = "KIPPHI";


const CURVE_NODE_PATH = new Path2D();

CURVE_NODE_PATH.moveTo(-5, -5);
CURVE_NODE_PATH.lineTo(-5, 5);
CURVE_NODE_PATH.lineTo(5, 5);
CURVE_NODE_PATH.lineTo(5, -5);
CURVE_NODE_PATH.lineTo(0, -14);
CURVE_NODE_PATH.closePath();

const STANDARD_WIDTH =  1350;
const BASE_LINE_LENGTH = 4050;
const HIT_FX_SIZE = 1024;
const getVector = (theta: number): [Vector, Vector] => [[Math.cos(theta), Math.sin(theta)], [-Math.sin(theta), Math.cos(theta)]]
type HEX = number;

// #default
type ProcessedTexture = OffscreenCanvas | ImageBitmap;
const __IS_BROWSER = true;
// #enddefault
/*
#node {
type HTMLCanvasElement = Canvas;
type OffscreenCanvas = Canvas;
type ImageBitmap = Image;
type HTMLImageElement = Image;
type ProcessedTexture = Canvas;
const OffscreenCanvas = Canvas;
type OffscreenCanvasRenderingContext2D = CanvasRenderingContext2D;
const __IS_BROWSER = false;
const createImageBitmap = async <T>(img: T) => img;
}
*/

export class Player extends EventTarget {
    canvas: HTMLCanvasElement;
    hitCanvas: OffscreenCanvas;
    context: CanvasRenderingContext2D;
    hitContext: OffscreenCanvasRenderingContext2D;
    chart: Chart;
    // #default
    audio: HTMLAudioElement;
    // #enddefault
    private audioProcessor: AudioProcessor;
    playing: boolean;
    background: ImageBitmap;
    blurredBackground: ProcessedTexture;
    noteSize: number;
    noteHeight: number;
    // soundQueue: SoundEntity[];
    lastBeats: number;
    lastRenderingBeats: number;


    greenLine: number = 0;

    currentCombo: number = 0;
    lastUncountedNNN: NNNOrTail | null = null;
    lastUncountedTailNNN: NNNOrTail | null = null;
    lastCountedBeats: number = 0;
    // #default
    lastRenderingRealTime: number = 0;
    renderedFrames: number = 0;
    lastMeasuredFPSStr: string = "N/A (N/A)";
    collectedFrameTime: number = 0;
    // #enddefault
    showsInfo = true;
    showsLineID = false;
    showsRenderingBaseline = false;
    showsLineCurve = false;
    curveFPS = 15;
    curveMinDuration = 4;
    /** In Seconds */
    baseOffset = -0.017;
    /**
     * 为渲染部分采用不同的偏移值（比如蓝牙耳机延迟高，容易音画不同步）
     */
    renderingOffset = 0;
    /**
     * 若设为真，则打击特效产生后会留在原地，而不是跟着判定线移动。
     * 
     * 这是本家标准行为，但是如果追求性能，可以设为false。
     * 
     * 在浏览器端，这个值默认就是false。
     */
    hitEffectNoFollows = !__IS_BROWSER;

    readonly widthRatio: number;

    
    textureMapping: Map<string, ImageBitmap> = new Map();
    
    constructor(
        canvas: HTMLCanvasElement,
        audioProcessor: AudioProcessor,
        // #default
        audio: HTMLAudioElement,
        // #enddefault
        background: ImageBitmap,
        public respack: Respack
    ) {
        super();
        this.canvas = canvas
        this.context = canvas.getContext("2d");
        this.audioProcessor = audioProcessor;
        this.hitCanvas = new OffscreenCanvas(canvas.width, canvas.height);
        this.hitContext = this.hitCanvas.getContext("2d");
        this.background = background;

        this.blurringRadius = 50;


        this.playing = false;
        this.noteSize = NOTE_WIDTH;
        this.noteHeight = NOTE_HEIGHT;
        this.widthRatio = canvas.width === STANDARD_WIDTH ? 1 : canvas.width / STANDARD_WIDTH;
        this.initCoordinate();
        // #default
        this.audio = audio;
        this.audio.addEventListener("ended", () => {
            this.playing = false;
        })
        // #enddefault
    }
    override addEventListener(type: "drawn" | "play" | "pause", listener: (e: Event) => void, options?: EventListenerOptions): void {
        super.addEventListener(type, listener, options);
    }
/* #node {

    audioCurrentTime: number = 0;
    playbackRate: number = 1;
} */
    get time(): number {
        // #default
        return (this.audio.currentTime || 0) - this.chart.offset / 1000 + this.baseOffset;
        // #enddefault
        /* #node {
        return this.audioCurrentTime - this.chart.offset / 1000 + this.baseOffset;
        } */
    }
    get beats(): number {
        return this.chart.timeCalculator.secondsToBeats(this.time)
    }
    get renderingBeats(): number {
        // #default
        return this.chart.timeCalculator.secondsToBeats(this.renderingTime);
        // #enddefault
        /* #node {
        return this.chart.timeCalculator.secondsToBeats(this.time + this.renderingOffset * this.playbackRate)
        } */
    }
    get renderingTime(): number {
        // #default
        return this.time + this.renderingOffset * this.audio.playbackRate;
        // #enddefault
        /* #node {
        return this.time + this.renderingOffset * this.playbackRate;
        } */
    }
    initCoordinate() {
        let {canvas, context, hitCanvas, hitContext} = this;
        
        // console.log(context.getTransform())
        const height = 900;
        const width = this.canvas.width;
        canvas.height = height;
        canvas.width = width;
        hitCanvas.height = height;
        hitCanvas.width = width
        
        const RATIO = 1.0
        // 计算最终的变换矩阵
        const tx = width / 2;
        const ty = height / 2;

        // 设置变换矩阵
        context.setTransform(RATIO, 0, 0, RATIO, tx, ty);
        //hitContext.scale(0.5, 0.5)
        context.save()
        hitContext.save()
        // console.log(context.getTransform())
    }
    _blurringRadius: number = 50;

    get blurringRadius() {
        return this._blurringRadius;
    }

    set blurringRadius(radius: number) {
        this._blurringRadius = radius;
        const { canvas, background } = this;
        const bgCanvas = new OffscreenCanvas(canvas.width, canvas.height);
        const bgContext = bgCanvas.getContext("2d");
        bgContext.filter = `blur(${radius}px)`
        bgContext.drawImage(background, 0, 0, canvas.width, canvas.height);
        this.blurredBackground = bgCanvas;
        createImageBitmap(bgCanvas).then(img => {
            this.blurredBackground = img;
        })
    }

    /**
     * 计算当前combo。
     * 
     * 这是少有的一个非无状态的方法。
     * @param renderingBeats 
     */
    computeCombo(renderingBeats: number) {
        const {chart} = this;
        const beats = renderingBeats;
        let lastUncountedNNN = this.lastUncountedNNN || chart.nnnList.head.next;
        let lastUncountedTailNNN = this.lastUncountedTailNNN || chart.nnnList.head.next
        let lastCountedBeats = this.lastCountedBeats || 0;
        let combo = this.currentCombo;
        if (!this.playing || this.time <= 1) {
            combo = 0;
            lastUncountedNNN = chart.nnnList.head.next;
            lastUncountedTailNNN = chart.nnnList.head.next;
            lastCountedBeats = 0;
        }
        const countUntil = chart.nnnList.getNodeAt(beats);
        if (!TC.lt(countUntil.startTime, lastUncountedNNN.startTime)) {
            for (let node: NNNOrTail = lastUncountedNNN; node.type !== NodeType.TAIL && node !== countUntil; node = node.next) {
                const nns = node.noteNodes;
                const nnsLength = nns.length;
                for (let i = 0; i < nnsLength; i++) {
                    const nn = nns[i];
                    combo += nn.notes.reduce((num: number, note: Note) => num + (note.isFake ? 0 : 1), 0);
                }
            }
            this.lastUncountedNNN = countUntil;
        }
        const countHoldTailUntil = chart.nnnList.getNodeAt(beats);
        if (!TC.lt(countHoldTailUntil.startTime, lastUncountedNNN.startTime)) {
            let uncounted = null;
            for (let node: NNNOrTail = lastUncountedTailNNN; node.type !== NodeType.TAIL && node !== countHoldTailUntil; node = node.next) {
                const hns = node.holdNodes;
                const len = hns.length;
                for (let i = 0; i < len; i++) {
                    const hn = hns[i];
                    const notes = hn.notes;
                    const l = notes.length;
                    let j = 0;
                    for (; j < l; j++) {
                        const note = notes[j];
                        if (TC.toBeats(note.endTime) > beats) {
                            if (!uncounted) {
                                uncounted = node;
                            }
                        } else {
                            break;
                        }
                    }
                    for (; j < l; j++) {
                        const note = notes[j];
                        if (note.isFake || TC.toBeats(note.endTime) < lastCountedBeats) {
                            continue;
                        }
                        combo++;
                    }
                }
            }
            this.lastUncountedTailNNN = uncounted || countHoldTailUntil;
            this.lastCountedBeats = beats;
        }
        this.currentCombo = combo;
    }
    private map: Map<string, JudgeLine[]>; 
    render() {
        if (!ENABLE_PLAYER) {
            return;
        }
        // #default
        this.map = new Map();
        const start = performance.now();
        // #enddefault
        // console.time("render")
        const context = this.context;

        const width = this.canvas.width;
        const hw = width / 2
        context.setTransform(1, 0, 0, 1, hw, 450);
        context.save();
        const hitContext = this.hitContext;
        hitContext.clearRect(0, 0, width, 900);
        // 虽然还要加个图片，但是如果不clear，在Node环境下，会泄漏很多内存
        context.clearRect(-width, -900, width * 2, 1800);
        context.drawImage(this.blurredBackground, -hw, -450, width, 900);
        // 涂灰色（背景变暗）
        context.fillStyle = "#0008";
        context.fillRect(-27000, -18000, 54000, 36000)
        // 画出渲染范围圆
        context.strokeStyle = "#66ccff";
        context.beginPath();
        context.arc(0, 0, RENDER_SCOPE, 0, 2 * Math.PI);
        context.stroke()
        context.restore()


        context.save()

        context.strokeStyle = "#FFFFFF"
        // drawLine(context, -1350, 0, 1350, 0)
        // drawLine(context, 0, 900, 0, -900);
        context.restore();
        const renderingBeats = this.renderingBeats;
        const renderingTime = this.renderingTime;
        
        // console.log("rendering")
        const chart = this.chart;
        const lineQueue = [...chart.judgeLines].sort((a, b) => (a.zOrder ?? 0) - (b.zOrder ?? 0));
        for (let line of this.chart.orphanLines) {
            this.precalculate(identity.translate(hw, 450).scale(this.widthRatio, -1), line, renderingBeats, renderingTime);
        }
        for (let line of lineQueue) {
            if (line.optimized) {
                continue;
            }
            context.save();
            this.renderLine(line, renderingBeats, renderingTime);
            context.restore();
        }
        context.save()
        hitContext.strokeStyle = "#66ccff";
        hitContext.lineWidth = 5;
        // drawLine(hitContext, 0, 900, 1350, 0);
        
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.drawImage(this.hitCanvas, 0, 0, width, 900)
        context.restore()

        if (this.showsLineCurve) {
            this.renderLineCurve(renderingBeats);
        }
        if (this.showsLineID) {
            this.renderLineIDs();
        }
        if (this.showsInfo) {
            context.save()
            const setTransformAndAlpha = (lineOrNull: JudgeLine | null) => {
                if (!lineOrNull) {
                    context.setTransform(identity.translate(hw, 450));
                } else {
                    context.setTransform(lineOrNull.renderMatrix);
                    context.scale(1, -1);
                    context.globalAlpha = lineOrNull.alpha;
                }
            }
            this.computeCombo(renderingBeats);
            context.fillStyle = "#ddd"
            context.font = "32px phigros"
            context.textAlign = "left";

            const title = chart.name;
            const level = chart.level;
            const combo = this.currentCombo;

            // name
            setTransformAndAlpha(chart.nameAttach)
            context.fillText(title, -hw + 35, 420);

            // level
            context.textAlign = "right";
            setTransformAndAlpha(chart.levelAttach)
            context.fillText(level, hw - 35, 420);

            context.font = "40px phigros";
            // score
            const score = combo / chart.maxCombo * 100_0000;
            const text = score.toFixed(0).padStart(7, "0")
            setTransformAndAlpha(chart.scoreAttach)
            context.fillText(text, hw - 40, -392);

            // pause
            setTransformAndAlpha(chart.pauseAttach)
            context.fillRect(-hw + 30, -418, 8, 30)
            context.fillRect(-hw + 48, -418, 8, 30)

            // bar
            const progress = this.time / chart.duration;
            const barWidth = progress * width;
            setTransformAndAlpha(chart.barAttach)
            context.fillStyle = "#aaa"
            context.fillRect(-hw, -450, barWidth, 8)
            context.fillStyle = "#fff"

            context.fillRect(-hw + barWidth, -450, 2, 8)

            if (combo >= 3) { // combo(number)
                context.textAlign = "center";
                
                context.font = "64px phigros"
                setTransformAndAlpha(chart.combonumberAttach)
                context.fillText(combo.toString(), 0, -384);

                context.font = "24px phigros";
                setTransformAndAlpha(chart.comboAttach)
                context.fillText(COMBO_TEXT, 0, -356);


            }
            context.restore();
        }
        context.resetTransform();
        // #default
        context.font = "20px phigros";
        context.fillStyle = "#ddd";
        const now = performance.now();
        this.renderedFrames++;
        this.collectedFrameTime += now - start;
        if (now - this.lastRenderingRealTime >= 1000) {
            const averageFrameTime = this.collectedFrameTime / this.renderedFrames;
            this.lastMeasuredFPSStr = (this.renderedFrames * 1000 / (now - this.lastRenderingRealTime)).toFixed(1) + ` (${averageFrameTime.toFixed(1)}ms)`;
            this.lastRenderingRealTime = now;
            this.renderedFrames = 0;
            this.collectedFrameTime = 0;
        }
        context.textAlign = "left";
        context.fillText(this.lastMeasuredFPSStr, 30, 25);
        context.textAlign = "center";
        context.fillText(this.time.toFixed(2) + " " + renderingBeats.toFixed(2), hw, 900)
        // #enddefault

        this.dispatchEvent(new Event("drawn"));

        // this.soundQueue = [];
        
        // console.timeEnd("render")
    }
    precalculate(matrix: Matrix33, judgeLine: JudgeLine, beats: number, seconds: number) {
        
        const timeCalculator = this.chart.timeCalculator
        const alpha = judgeLine.getStackedValueBySeconds("alpha", beats, seconds, timeCalculator);
        if (judgeLine.nnLists.size === 0 && judgeLine.hnLists.size === 0 && alpha <= 0 && judgeLine.children.size === 0 && !judgeLine.hasAttachUI) {
            judgeLine.optimized = true;
            return;
        } else {
            judgeLine.optimized = false;
        }
        const x = judgeLine.getStackedValueBySeconds("moveX", beats, seconds, timeCalculator);
        const y = judgeLine.getStackedValueBySeconds("moveY", beats, seconds, timeCalculator);
        const theta = judgeLine.getStackedValueBySeconds("rotate", beats, seconds, timeCalculator) * Math.PI / 180;
        judgeLine.moveX = x;
        judgeLine.moveY = y;
        judgeLine.rotate = theta;
        judgeLine.alpha = alpha;
        const {x: transformedX, y: transformedY} = new Coordinate(x, y).mul(matrix);

        
        const ratio = this.widthRatio;
        judgeLine.transformedX = transformedX;
        judgeLine.transformedY = transformedY;
        if (this.showsLineID) {
            const map = this.map;
            const k = Math.round(transformedX) + "," + Math.round(transformedY);
            if (map.has(k)) {
                map.get(k)!.push(judgeLine);
            } else {
                map.set(k, [judgeLine]);
            }
        }
        const myMatrix = judgeLine.rotatesWithFather ? matrix.translate(x, y).rotate(-theta) : identity.translate(transformedX, transformedY).rotate(-theta).scale(ratio, -1);
        
        // Cache a matrix
        judgeLine.renderMatrix = myMatrix.scale(1 / ratio, 1);
        if (judgeLine.children.size !== 0) {
            for (let line of judgeLine.children) {
                this.precalculate(myMatrix, line, beats, seconds);
            }
        }
    }
    /**
     * 计算判定线在某时刻的矩阵。特别适用于过去时。
     * 
     * 在当前代码，这个方法仅用在开启打击特效滞留时。
     * 
     * （KPP尽可能遵守“无状态渲染”，不会缓存打击特效在之前的位置。）
     * @param judgeLine 
     * @param beats 
     */
    calculateLineMatrix(judgeLine: JudgeLine, beatsOrSeconds: number, useSeconds: boolean = false) {
        const seconds = useSeconds ? beatsOrSeconds : this.chart.timeCalculator.toSeconds(beatsOrSeconds);
        const beats = useSeconds ? this.chart.timeCalculator.secondsToBeats(seconds) : beatsOrSeconds;
        return this._calculateLineMatrix(judgeLine, beats, seconds).scale(1 / this.widthRatio, 1);
    }
    _calculateLineMatrix(judgeLine: JudgeLine, beats: number, seconds: number) {
        const hw = this.canvas.width / 2;
        const x = judgeLine.getStackedValue("moveX", beats);
        const y = judgeLine.getStackedValue("moveY", beats);
        const theta = judgeLine.getStackedValue("rotate", beats) * Math.PI / 180;
        const father = judgeLine.father;
        const parentMatrix = father ? this._calculateLineMatrix(father, beats, seconds) : identity.translate(hw, 450).scale(this.widthRatio, -1);
        if (judgeLine.rotatesWithFather) {
            return parentMatrix.translate(x, y).rotate(-theta);
        } else {
            const {x: tx, y: ty} = new Coordinate(x, y).mul(parentMatrix);
            return identity.translate(tx, ty).rotate(-theta).scale(this.widthRatio, -1);
        }
    }
    renderLineCurve(beats: number) {
        const context = this.context;
        const timeCalculator = this.chart.timeCalculator;
        const curveFPS = this.curveFPS;
        const line = this.chart.judgeLines[this.greenLine];
        const curveMinDuration = this.curveMinDuration;
        // const beatss: number[] = [];
        // const beatss2: number[] = [];
        // const layers = line.eventLayers;
        // const len = layers.length;
        // for (const type of ["moveX", "moveY"] as const) {
        //     for (let i = 0; i < len; i++) {
        //         const layer = layers[i];
        //         if (!layer) {
        //             continue;
        //         }
        //         const seq = layer[type];
        //         if (!seq) {
        //             continue;
        //         }
        //         const node = seq.getNodeAt(beats);
        //         if (node) {
        //             beatss.push(TC.toBeats(node.time));
        //             const endNode = node.next;
        //             if (endNode.type !== NodeType.TAIL) {
        //                 beatss2.push(TC.toBeats(endNode.time));
        //             }
        //         }
        //     }
        // }
        // const toStartAt = Math.min(Math.max(...beatss), Math.floor(beats) - curveMinDuration / 2);
        // const toEndAt =  Math.max(Math.min(...beatss2), Math.floor(beats) + curveMinDuration / 2);
        const toStartAt = Math.max(Math.floor(beats) - curveMinDuration / 2, 0);
        const toEndAt = Math.min(Math.ceil(beats) + curveMinDuration / 2, this.chart.effectiveBeats);
        const startSecs = Math.round(timeCalculator.toSeconds(toStartAt) * curveFPS) / curveFPS;
        const endSecs = timeCalculator.toSeconds(toEndAt);
        const duration = endSecs - startSecs;
        const frames = Math.round(duration * curveFPS);
        context.save();
        for (let i = 0; i < frames; i++) {
            const secs = startSecs + i / curveFPS;
            const matrix = this.calculateLineMatrix(line, secs, true);
            context.setTransform(matrix);
            context.fillStyle = `hsl(${i / frames * 360}, 100%, 50%)`;
            context.fill(CURVE_NODE_PATH);
        }
        context.restore();
    }
    renderLineIDs() {
        const context = this.context;
        const map = this.map;
        context.save();
        context.resetTransform();
        context.font = "30px phigros"
        for (const [_, lines] of map) {
            const x = lines[0].transformedX;
            const y = lines[0].transformedY;
            const ids = lines.map(line => line.id);
            ids.sort((a, b) => a - b);
            const len = ids.length;
            const segs: string[] = [];
            let prev = ids[0];
            let starting = prev;
            for (let i = 1; i < len; i++) {
                const cur = ids[i];
                if (cur !== prev + 1) {
                    segs.push(prev === starting ? starting.toString() : `${starting}~${prev}`);
                    starting = cur;
                }
                prev = cur;
            }
            segs.push(prev === starting ? prev.toString() : `${starting}~${prev}`);
            context.fillText(segs.join(", "), x, y + 40);
        }
    }
    renderLine(judgeLine: JudgeLine, beats: number, seconds: number) {
        const context = this.context;
        const respack = this.respack;
        const timeCalculator = this.chart.timeCalculator;
        const alpha = judgeLine.alpha;
        const theta = judgeLine.rotate;
        const myMatrix = judgeLine.renderMatrix;
        const transformedX = judgeLine.transformedX;
        const transformedY = judgeLine.transformedY;
        context.setTransform(myMatrix/*.scale(1 / this.widthRatio, 1)*/);



        // Draw Line
        const scaleX = judgeLine.extendedLayer.scaleX.getValueAtBySecs(beats, seconds, timeCalculator);
        const scaleY = judgeLine.extendedLayer.scaleY.getValueAtBySecs(beats, seconds, timeCalculator);
        const anchor = judgeLine.anchor;
        // console.log(scaleX, scaleY, anchor)

        let textureName = judgeLine.texture;
        if (textureName !== "line.png" && !this.textureMapping.get(textureName)) {
            textureName = "line.png";
        }
        context.scale(1, -1);

        const hasText = !!judgeLine.extendedLayer.text;
        const hasUIAttached = judgeLine.hasAttachUI;

        if (hasText) {
            const textContent = judgeLine.extendedLayer.text.getValueAtBySecs(beats, seconds, timeCalculator) as string;
            context.save();
            context.fillStyle = rgba(...judgeLine.extendedLayer.color?.getValueAtBySecs(beats, seconds, timeCalculator) ?? [255, 255, 255], alpha);
            context.font = "54px phigros";
            context.scale(scaleX, scaleY);
            context.textAlign = "center";
            context.textBaseline = "middle";
            const metrics = context.measureText(textContent);
            const height = metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent;
            const width = metrics.width;
            context.fillText(textContent, width * (anchor[0] - 0.5), height * (anchor[1] - 0.5));
            context.restore();
        }
        if (!hasText && !hasUIAttached) {
            if (textureName === "line.png") {
                const lineColor: RGB = judgeLine.extendedLayer.color?.getValueAtBySecs(beats, seconds, timeCalculator) ?? [200, 200, 120];
                context.fillStyle = rgba(...(this.greenLine === judgeLine.id ? ([100, 255, 100] as RGB) : lineColor), alpha / 255)
                const scaledWidth = BASE_LINE_LENGTH * scaleX;
                const scaledHeight = LINE_WIDTH * scaleY;
                context.fillRect(-scaledWidth * anchor[0], -scaledHeight * anchor[1], scaledWidth, scaledHeight)
                // Fixes #1 on "kipphiApparatusLegacy"
            } else {
                const lineColor: RGB = judgeLine.extendedLayer.color?.getValueAtBySecs(beats, seconds, timeCalculator) ?? [255, 255, 255];
                context.globalAlpha = alpha / 255;
                const bitmap = this.textureMapping.get(textureName);
                let texture: ImageBitmap | OffscreenCanvas = bitmap;
                if (lineColor.some(x => x !== 255)) {
                    texture = this.tintLineTexture(bitmap, lineColor);
                }
                const width = bitmap.width;
                const height = bitmap.height;
                const scaledWidth = width * scaleX;
                const scaledHeight = height * scaleY;
                context.drawImage(texture,
                    -scaledWidth * anchor[0], -scaledHeight * anchor[1], scaledWidth, scaledHeight)
                context.globalAlpha = 1;
            }
        }

        // Draw Anchor

        // #default
        context.drawImage(Images.ANCHOR, -10, -10);
        // #enddefault
        // if (this.showsLineID) {
        //     context.save();
        //     context.fillStyle = "white";
        //     context.font = "40px phigros";
                
        //     context.fillText(`#${judgeLine.id} ${judgeLine.name.toLowerCase() === "untitled" ? "" : judgeLine.name}`, 10, 50);
        //     context.restore();
        // }

        judgeLine.computeCurrentFloorPosition(beats, timeCalculator);

        /** 判定线的法向量 */
        const nVector: Vector = getVector(theta)[1] // 奇变偶不变，符号看象限(
        const toCenter: Vector = [675 - transformedX, 450 - transformedY];
        // 法向量是单位向量，分母是1，不写
        /** the distance between the center and the line */
        const innerProd = innerProduct(toCenter, nVector);
        // 法向量朝向判定线正面
        // 现在法向量和内积的结果：如果正面对着中心点，内积为正，反之为负
        // 因此，innerProd的正负是重要的。如果offset为负，note在更低的地方被判定，“实际判定线”距离圆心更远
        // 所以distance要变大。因此，是innerProd - offset的绝对值。
        // （这是KPA家族代码中不可逾越的一座史山）
        const judgeLineCover = judgeLine.cover;
        const getYs = judgeLineCover ? (offset: number) => {
            
            const distance: number = Math.abs(innerProd - offset);
            let startY = distance - RENDER_SCOPE;
            const endY = distance + RENDER_SCOPE;
            if (startY < 0) startY = 0;
            return [startY, endY]
        } : (offset: number) => {
            
            const distance: number = Math.abs(innerProd - offset);
            const startY = distance - RENDER_SCOPE; // 显示线下音符
            const endY = distance + RENDER_SCOPE;
            return [startY, endY]
        }
        
        const drawScope = (endY: number, startY: number) => {
            if (endY<=1e-6) return
            context.save()
            context.font = "80px phigros";
            context.textBaseline = "middle";
            context.strokeStyle = "#66ccff"
            context.fillStyle = "#66ccff";
            context.lineWidth = 2
            drawLine(context, -1350, +endY, 1350, +endY)
            context.fillText(`${endY.toFixed(2)}e`, 0, +endY)
            drawLine(context, -1350, -endY, 1350, -endY)
            context.fillText(`${endY.toFixed(2)}e`, 0, -endY)
            context.strokeStyle = "#ffcc66";
            context.fillStyle = "#ffcc66";
            drawLine(context, -1350, +startY, 1350, +startY)
            context.fillText(`${startY.toFixed(2)}s`, 0, +startY);
            drawLine(context, -1350, -startY, 1350, -startY)
            context.fillText(`${startY.toFixed(2)}s`, 0, -startY);
            context.restore()
        }
        
        const hitFxDuration = respack.hitFxDuration;
        const hitRenderLimitSecs = this.renderingTime > hitFxDuration ? this.renderingTime - hitFxDuration : 0;
        const hitRenderLimitBeats = timeCalculator.secondsToBeats(hitRenderLimitSecs); // 渲染 ? 秒内的打击特效
        const holdTrees = judgeLine.hnLists;
        const noteTrees = judgeLine.nnLists;

        const showsRenderingBaseline = this.showsRenderingBaseline;
        // console.time("Updating integral");
        
        // console.timeEnd("Updating integral");
        
        for (let trees of [holdTrees, noteTrees]) {
            for (const [_, list] of trees) {
                const speedVal: number = list.speed;
                if (DRAWS_NOTES && alpha >= 0) {
                    // debugger
                    // 渲染音符
                    // console.time("computeTimeRange")
                    const [startY, endY] = getYs(list.medianYOffset)
                    if (showsRenderingBaseline) {
                        drawScope(endY, startY);
                    }
                    const timeRanges = speedVal !== 0 ? judgeLine.computeTimeRange(beats, timeCalculator, startY / speedVal, endY / speedVal) : [[0, Infinity] as [number, number]];
                    list.timeRanges = timeRanges;
                    if (timeRanges.length === 0 && judgeLine.id === 5 && beats >= 186) {
                        debugger;
                    }
                    
                    // console.timeEnd("computeTimeRange");
                    // console.time("Rendering notes");
                    // console.log(timeRanges, startY, endY);
                    for (let range of timeRanges) {
                        const start = range[0];
                        const end = range[1];
                        // drawScope(judgeLine.getStackedIntegral(start, timeCalculator))
                        // drawScope(judgeLine.getStackedIntegral(end, timeCalculator))
                        
                        let noteNode: NNOrTail = list.getNodeAt(start, true);
                        // console.log(noteNode)
                        let startBeats: number;
                        // console.log(noteNode, end, start);
                        
                        while (!(noteNode.type === NodeType.TAIL)
                            && (startBeats = TC.toBeats(noteNode.startTime)) < end
                        ) {
                            // 判断是否为多押
                            const isChord = noteNode.notes.length > 1
                                || noteNode.totalNode.noteNodes.some(node => node !== noteNode && node.notes.length)
                                || noteNode.totalNode.holdNodes.some(node => node !== noteNode && node.notes.length);
                            this.renderSameTimeNotes(noteNode, isChord, judgeLine, judgeLineCover, timeCalculator, beats);
                            noteNode = noteNode.next;
                        }
                        
                    }
                    // console.timeEnd("Rendering notes");
                }
                // console.time("Rendering hit effects");
                // 打击特效
                if (beats > 0) {
                    if (list instanceof HNList) {
                        this.renderHoldHitEffects(myMatrix, list, beats, hitRenderLimitBeats, beats, timeCalculator)
                    } else {
                        this.renderHitEffects(myMatrix, list, hitRenderLimitBeats, beats, timeCalculator)
                    }
                }
                // console.timeEnd("Rendering hit effects");

            }

        }

        this.playSounds();
    }
    lastUnplayedNNNode: NNNode | NNNodeLike<NodeType.TAIL>;
    /**
     * 这个不一样，在低帧率情况下，由于帧与帧时间间隔过长，中间有些Note播放不了。
     * 
     * 我们把播放放到每条判定线的渲染里面来减少这种情况。
     * 
     * 因此这里才需要实时获取beats
     * @returns 
     */
    playSounds() {
        // #default
        if (!this.playing) {
            return;
        }
        // #enddefault
        const beats = this.beats;
        const timeCalculator = this.chart.timeCalculator;
        const lastNNN: NNNOrTail = this.lastUnplayedNNNode;
        const startingFrom = lastNNN.type === NodeType.TAIL ? Infinity : TC.toBeats(lastNNN.startTime);
        const needsReset = startingFrom >= beats || timeCalculator.segmentToSeconds(startingFrom, beats) > 0.05;
        // 超过0.05秒就会认为是快进过来的，这个时候，如果播放会很吵
        if (needsReset) {
            this.lastUnplayedNNNode = this.chart.nnnList.getNodeAt(beats)
            return;
        }
        let node: NNNOrTail = lastNNN;
        for (; node.type !== NodeType.TAIL && TC.toBeats(node.startTime) < beats; node = node.next) {
            const nns = node.noteNodes;
            const hns = node.holdNodes;
            const nnl = nns.length;
            for (let i = 0; i < nnl; i++) {
                const node: NoteNode = nns[i];
                const nl = node.notes.length;
                for (let j = 0; j < nl; j++) {
                    const note = node.notes[j];
                    if (note.isFake) {
                        continue;
                    }
                    this.audioProcessor.playNoteSound(note.type);
                }
            }
            const hnl = hns.length;
            for (let i = 0; i < hnl; i++) {
                const node: NoteNode = hns[i];
                const nl = node.notes.length;
                for (let j = 0; j < nl; j++) {
                    const note: Note = node.notes[j];
                    if (note.isFake) {
                        continue;
                    }
                    this.audioProcessor.playNoteSound(NoteType.hold);
                }
            }
        }
        this.lastUnplayedNNNode = node;
    }
    renderHitEffects(matrix: Matrix33, tree: NNList, startBeats: number, endBeats: number, timeCalculator: TimeCalculator) {
        let noteNode = tree.getNodeAt(startBeats, true);
        const { hitContext, respack, renderingTime, hitEffectNoFollows } = this;
        const line = tree.parentLine
        // console.log(hitContext.getTransform())
        const end = tree.getNodeAt(endBeats);
        const ratio = this.widthRatio;
        if (noteNode.type === NodeType.TAIL) {
            return;
        }
        while (noteNode !== end) {
            const beats = TC.toBeats(noteNode.startTime);
            const notes = noteNode.notes
            , len = notes.length
            for (let i = 0; i < len; i++) {
                const note = notes[i];
                if (note.isFake) {
                    continue;
                }
                const posX = note.positionX * ratio;
                const yo = note.yOffset * (note.above ? 1 : -1);
                const {x, y} = new Coordinate(posX, yo).mul(hitEffectNoFollows ? this.calculateLineMatrix(line, beats) : matrix);
                // console.log("he", x, y);
                const he = note.tintHitEffects;
                respack.hitDrawer(hitContext, x, y, HIT_EFFECT_SIZE, renderingTime - timeCalculator.toSeconds(beats), he)
            }

            noteNode = <NoteNode>noteNode.next
        } 
    }
    /**
     * 
     * @param judgeLine 
     * @param tree 
     * @param beats 当前拍数
     * @param startBeats 
     * @param endBeats 截止拍数
     * @param timeCalculator 
     * @returns 
     */
    renderHoldHitEffects(matrix: Matrix33, tree: HNList, beats: number, startBeats: number, endBeats: number, timeCalculator: TimeCalculator) {
        const start = tree.getNodeAt(startBeats, true);
        const { hitContext, respack, renderingTime, hitEffectNoFollows } = this;
        const line = tree.parentLine
        let noteNode = start;
        const end = tree.getNodeAt(endBeats);
        const hitEffectDuration = respack.hitFxDuration;
        const ratio = this.widthRatio;
        if (noteNode.type === NodeType.TAIL) {
            return;
        }
        // if (noteNode !== end)
        // console.log("start", start, startBeats, endBeats)
        while (noteNode !== end) {
            const notes = noteNode.notes
            , len = notes.length
            for (let i = 0; i < len; i++) {
                const note = notes[i];
                if (note.isFake) {
                    continue;
                }
                if (hitEffectNoFollows) {
                    const endTimeSecs = timeCalculator.toSeconds(Math.floor(TC.toBeats(note.endTime) * 2) / 2);
                    if (renderingTime > endTimeSecs + hitEffectDuration) {
                        continue;
                    }
                } else if (startBeats > TC.toBeats(note.endTime)) {
                    continue;
                }
                const posX = note.positionX * ratio;
                const yo = note.yOffset * (note.above ? 1 : -1);
                const noteStartBeats = TC.toBeats(note.startTime);
                let beatsToRender = Math.floor((Math.min(beats, TC.toBeats(note.endTime)) - noteStartBeats - 0.01) * HOLD_HE_SPEED) / HOLD_HE_SPEED + noteStartBeats;
                while (beatsToRender >= Math.max(startBeats, TC.toBeats(note.startTime))) {
                    const {x, y} = new Coordinate(posX, yo).mul(hitEffectNoFollows ? this.calculateLineMatrix(line, beatsToRender) : matrix);
                    const tintHE = note.tintHitEffects;
                    respack.hitDrawer(hitContext, x, y, HIT_EFFECT_SIZE, renderingTime - timeCalculator.toSeconds(beatsToRender), tintHE);
                    beatsToRender -= HOLD_HE_INTERVAL;
                }
            }
            noteNode = <NoteNode>noteNode.next
        }
    }
    /**
     * 
     */
    // 能只在外面拿一遍cover就绝对不在这里面拿10遍cover（
    renderSameTimeNotes(noteNode: NoteNode, chord: boolean, judgeLine: JudgeLine, cover: boolean, timeCalculator: TimeCalculator, beats: number) {
        
        if (noteNode.isHold) {
            const startY = judgeLine.getRelativeFloorPositionAt(TC.toBeats(noteNode.startTime), timeCalculator) * noteNode.parentSeq.speed;
            const notes = noteNode.notes
                , len = notes.length
            for (let i = 0; i < len; i++) {
                const note = notes[i]
                this.renderNote(
                    note,
                    chord,
                    startY < 0 ? 0 : startY,
                    beats,
                    cover,
                    judgeLine.getRelativeFloorPositionAt(TC.toBeats(note.endTime), timeCalculator) * note.speed
                    )
            }
        } else {
            // console.log("renderSameTimeNotes", noteNode)
            const notes = noteNode.notes
            , len = notes.length
            for (let i = 0; i < len; i++) {
                const note = notes[i];
                
                this.renderNote(
                    note,
                    chord,
                    judgeLine.getRelativeFloorPositionAt(TC.toBeats(note.startTime), timeCalculator) * note.speed,
                    beats,
                    cover
                )

            }
        }
    }
    renderNote(note: Note, chord: boolean, positionY: number, beats: number, cover: boolean, endpositionY?: number) {
        // console.log("hyw?");
        // console.log(note, this.beats)
        if (TC.toBeats(note.endTime) < beats) {
            return;
        }
        if (TC.toBeats(note.startTime) - note.visibleBeats > beats) {
            return;
        }
        if (positionY < 0 && cover) {
            return;
        }
        const context = this.context;
        const respack = this.respack;
        let zero = 0;
        const positionX = note.positionX * this.widthRatio;
        
        if (note.yOffset) {
            positionY += note.yOffset;
            endpositionY += note.yOffset;
            zero = note.yOffset;
        }


        positionY = -positionY;
        endpositionY = -endpositionY
        zero = -zero;
        
        let length = endpositionY - positionY
        const size = this.noteSize * note.size;
        const half = size / 2;
        const opac = note.alpha < 255
        context.save();
        if (!note.above) {
            context.scale(1, -1);
        }
        if (opac) {
            context.globalAlpha = note.alpha / 255;
        }
        if (note.type === NoteType.hold) {
            const isJudging = TC.toBeats(note.startTime) <= beats
            positionY = isJudging ? zero : positionY;
            length = isJudging ? (endpositionY - zero) : length;
            length = -length
            const HOLD_BODY = chord ? respack.HOLD_BODY_HL : respack.HOLD_BODY;
            const HOLD_HEAD = chord ? respack.HOLD_HEAD_HL : respack.HOLD_HEAD;
            const HOLD_TAIL = chord ? respack.HOLD_TAIL_HL : respack.HOLD_TAIL;
            context.drawImage(HOLD_BODY, positionX - half, positionY - length, size, length);
            if (!isJudging || respack.holdKeepHead) {
                const h = size * (HOLD_HEAD.height / HOLD_HEAD.width)
                context.drawImage(HOLD_HEAD, positionX - half, positionY - (respack.holdCompact ? h / 2 : 0),
                    size, h);
            }
            const tailHeight = size * (HOLD_TAIL.height / HOLD_TAIL.width)
            context.drawImage(HOLD_TAIL, positionX - half, positionY - length - (respack.holdCompact ? tailHeight / 2 : tailHeight),
                size, tailHeight);
        } else {
            respack.noteDrawer(context, positionX, positionY, size, this.noteSize, note.type, chord, note.tint);
        }
        
        // 不再使用叠加的方法
        // #default
        if (!note.above) {
            context.drawImage(Images.BELOW, positionX - half, positionY - NOTE_HEIGHT / 2, size, NOTE_HEIGHT);
        }
        // #enddefault
        context.restore()
        
    }
    tintLineTexture(bitmap: ImageBitmap, color: RGB): OffscreenCanvas {
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext('2d');
        context.drawImage(bitmap, 0, 0);
        context.globalCompositeOperation = "source-in";
        context.fillStyle = rgb(...color);
        context.fillRect(0, 0, bitmap.width, bitmap.height);
        context.globalCompositeOperation = "multiply";
        context.drawImage(bitmap, 0, 0);
        return canvas;
    }
    // #default

    // #default
    private update() {
        if (!this.playing) {
            return;
        }
        // console.log("anifr")
        requestAnimationFrame(() => {
            // console.log("render")
            this.render();
            this.update();
        })
        this.lastBeats = this.beats
    }
    play() {
        this.audio.play()
        this.playing = true;
        this.update();
        this.dispatchEvent(new Event("play"));
    }
    pause() {
        this.audio.pause()
        this.playing = false
        this.dispatchEvent(new Event("pause"));
    }
    // #enddefault

    receive(chart: Chart, textureFetcher: (name: string) => Promise<ImageBitmap>) {
        this.chart = chart;
        // 还是播放器适合处理纹理请求这事（

        const textures = chart.scanAllTextures();
        textures.delete("line.png");
        for (const texture of textures) {
            textureFetcher(texture).then((bmp: ImageBitmap) => {
                this.textureMapping.set(texture, bmp);
            })
        }
        this.lastUnplayedNNNode = chart.nnnList.head.next;
    }
}



