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
import { drawLine, innerProduct, rgba } from "./util";
import { Coordinate, identity, Matrix33 } from "./matrix";
import { drawNthFrame, Images } from "./image";
import { type Vector } from "./util";
import { NOTE_HEIGHT, NOTE_WIDTH } from "./constants";
/*
#node {
import { Canvas, type CanvasRenderingContext2D, type Image, type ImageData } from "skia-canvas";
import { AudioProcessor } from "./audioProcessor";
}
*/


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
const RENDER_SCOPE = 900;

const COMBO_TEXT = "KIPPHI"

const BASE_LINE_LENGTH = 4050;
const HIT_FX_SIZE = 1024;
const getVector = (theta: number): [Vector, Vector] => [[Math.cos(theta), Math.sin(theta)], [-Math.sin(theta), Math.cos(theta)]]
type HEX = number;

// #default
type ProcessedTexture = OffscreenCanvas | ImageBitmap;
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
    aspect: number;
    noteSize: number;
    noteHeight: number;
    // soundQueue: SoundEntity[];
    lastBeats: number;
    lastRenderingBeats: number;

    tintNotesMapping: Map<HEX, ProcessedTexture> = new Map();
    tintEffectMapping: Map<HEX, ProcessedTexture> = new Map();

    greenLine: number = 0;

    currentCombo: number = 0;
    lastUncountedNNN: NNNOrTail | null = null;
    lastUncountedTailNNN: NNNOrTail | null = null;
    lastCountedBeats: number = 0;

    showsInfo = true;
    showsLineID = false;
    showsRenderingBaseline = false;
    /** In Seconds */
    baseOffset = -0.017;
    /**
     * 为渲染部分采用不同的偏移值（比如蓝牙耳机延迟高，容易音画不同步）
     */
    renderingOffset = 0;

    
    textureMapping: Map<string, ImageBitmap> = new Map();
    
    constructor(
        canvas: HTMLCanvasElement,
        audioProcessor: AudioProcessor,
        // #default
        audio: HTMLAudioElement,
        // #enddefault
        background: ImageBitmap) {
        super();
        this.canvas = canvas
        this.context = canvas.getContext("2d");
        this.audioProcessor = audioProcessor;
        this.hitCanvas = new OffscreenCanvas(canvas.width, canvas.height);
        this.hitContext = this.hitCanvas.getContext("2d");
        this.background = background;
        this.playing = false;
        this.aspect = DEFAULT_ASPECT_RATIO;
        this.noteSize = NOTE_WIDTH;
        this.noteHeight = NOTE_HEIGHT;
        this.initCoordinate();
        // #default
        this.audio = audio;
        this.audio.addEventListener("ended", () => {
            this.playing = false;
        })
        // #enddefault
        this.initGreyScreen();
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
        return this.chart.timeCalculator.secondsToBeats(this.time + this.renderingOffset * this.audio.playbackRate)
        // #enddefault
        /* #node {
        return this.chart.timeCalculator.secondsToBeats(this.time + this.renderingOffset * this.playbackRate)
        } */
    }
    initCoordinate() {
        let {canvas, context, hitCanvas, hitContext} = this;
        
        // console.log(context.getTransform())
        const height = 900;
        const width = 1350;
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
    renderDropScreen() {
        const {canvas, context} = this;
        context.fillStyle = "#6cf"
        context.fillRect(-675, -450, 1350, 900);
        context.fillStyle = "#444"
        context.font = "100px phigros"
        const metrics = context.measureText("松手释放");
        context.fillText("松手释放", -metrics.width/2, 0)
        context.restore();
        context.save();
    }
    renderGreyScreen() {
        const {canvas, context} = this;
        context.fillStyle = "#AAA"
        context.fillRect(-675, -450, 1350, 900);
        context.fillStyle = "#444"
        context.font = "100px phigros"
        const metrics = context.measureText("放入文件");
        context.fillText("放入文件", -metrics.width/2, 0)
        context.restore();
        context.save();
    }
    initGreyScreen() {
        const {canvas, context} = this;
        this.renderGreyScreen()
    }
    computeCombo(renderingBeats: number) {
        const {chart} = this;
        const beats = renderingBeats;
        const timeCalculator = chart.timeCalculator;
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
    render() {
        if (!ENABLE_PLAYER) {
            return;
        }
        // console.time("render")
        const context = this.context;


        context.setTransform(1, 0, 0, 1, 675, 450);
        context.save();
        const hitContext = this.hitContext;
        hitContext.clearRect(0, 0, 1350, 900);
        context.drawImage(this.background, -675, -450, 1350, 900);
        // 涂灰色（背景变暗）
        context.fillStyle = "#222c";
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
        
        // console.log("rendering")
        const lineQueue = [...this.chart.judgeLines].sort((a, b) => (a.zOrder ?? 0) - (b.zOrder ?? 0));
        for (let line of this.chart.orphanLines) {
            this.precalculate(identity.translate(675, 450).scale(1, -1), line, renderingBeats);
        }
        for (let line of lineQueue) {
            if (line.optimized) {
                continue;
            }
            context.save();
            this.renderLine(line, renderingBeats);
            context.restore();
        }
        context.save()
        hitContext.strokeStyle = "#66ccff";
        hitContext.lineWidth = 5;
        // drawLine(hitContext, 0, 900, 1350, 0);
        
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.drawImage(this.hitCanvas, 0, 0, 1350, 900)
        context.restore()



        if (this.showsInfo) {
            context.save()
            const setTransform = (lineOrNull: JudgeLine | null) => {
                if (!lineOrNull) {
                    context.setTransform(identity.translate(675, 450));
                } else {
                    context.setTransform(lineOrNull.renderMatrix);
                    context.scale(1, -1)
                }
            }
            this.computeCombo(renderingBeats);
            context.fillStyle = "#ddd"
            context.font = "40px phigros"
            context.textAlign = "left";


            const chart = this.chart;
            const title = chart.name;
            const level = chart.level;
            const combo = this.currentCombo;
            setTransform(chart.nameAttach)
            context.fillText(title, -600, 400);

            const metrics = context.measureText(level)
            setTransform(chart.levelAttach)
            context.fillText(level, 600 - metrics.width, 400);

            const score = combo / chart.maxCombo * 100_0000;
            const text = score.toFixed(0).padStart(7, "0")
            setTransform(chart.scoreAttach)
            context.textAlign = "right";
            context.fillText(text, 600, -400);

            if (combo >= 3) {
                context.textAlign = "center";
                
                context.font = "60px phigros"
                setTransform(chart.combonumberAttach)
                context.fillText(combo.toString(), 0, -400);

                context.font = "20px phigros";
                const h = 32;
                setTransform(chart.comboAttach)
                context.fillText(COMBO_TEXT, 0, -400 + h);


            }
            context.restore();
        }
        context.resetTransform();
        context.textAlign = "center";
        context.font = "20px phigros";
        context.fillText(this.time.toFixed(2) + " " + renderingBeats.toFixed(2), 675, 900)

        this.dispatchEvent(new Event("drawn"));

        // this.soundQueue = [];
        
        // console.timeEnd("render")
    }
    precalculate(matrix: Matrix33, judgeLine: JudgeLine, beats: number) {
        
        // const timeCalculator = this.chart.timeCalculator
        const alpha = judgeLine.getStackedValue("alpha", beats);
        if (judgeLine.nnLists.size === 0 && judgeLine.hnLists.size === 0 && alpha <= 0 && judgeLine.children.size === 0 && !judgeLine.hasAttachUI) {
            judgeLine.optimized = true;
            return;
        } else {
            judgeLine.optimized = false;
        }
        const x = judgeLine.getStackedValue("moveX", beats);
        const y = judgeLine.getStackedValue("moveY", beats);
        const theta = judgeLine.getStackedValue("rotate", beats) * Math.PI / 180;
        judgeLine.moveX = x;
        judgeLine.moveY = y;
        judgeLine.rotate = theta;
        judgeLine.alpha = alpha;
        const {x: transformedX, y: transformedY} = new Coordinate(x, y).mul(matrix);
        judgeLine.transformedX = transformedX;
        judgeLine.transformedY = transformedY;
        const myMatrix = judgeLine.rotatesWithFather ? matrix.translate(x, y).rotate(-theta) : identity.translate(transformedX, transformedY).rotate(-theta).scale(1, -1);
        
        // Cache a matrix
        judgeLine.renderMatrix = myMatrix;
        if (judgeLine.children.size !== 0) {
            for (let line of judgeLine.children) {
                this.precalculate(myMatrix, line, beats);
            }
        }
    }
    renderLine(judgeLine: JudgeLine, beats: number) {
        const context = this.context;
        const timeCalculator = this.chart.timeCalculator;
        const alpha = judgeLine.alpha;
        const theta = judgeLine.rotate;
        const myMatrix = judgeLine.renderMatrix;
        const transformedX = judgeLine.transformedX;
        const transformedY = judgeLine.transformedY;
        context.setTransform(myMatrix);



        // Draw Line
        const scaleX = judgeLine.extendedLayer.scaleX.getValueAt(beats);
        const scaleY = judgeLine.extendedLayer.scaleY.getValueAt(beats);
        const anchor = judgeLine.anchor;
        // console.log(scaleX, scaleY, anchor)

        let textureName = judgeLine.texture;
        if (textureName !== "line.png" && !this.textureMapping.get(textureName)) {
            textureName = "line.png";
        }
        context.scale(1, -1);

        const hasText = !!judgeLine.extendedLayer.text;

        if (hasText) {
            const textContent = judgeLine.extendedLayer.text.getValueAt(beats) as string;
            context.save();
            context.fillStyle = rgba(...judgeLine.extendedLayer.color?.getValueAt(beats) ?? [255, 255, 255], alpha);
            context.font = "54px phigros";
            context.scale(scaleX, scaleY);
            context.textAlign = "center";
            context.textBaseline = "middle";
            const metrics = context.measureText(textContent);
            const height = metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent;
            const width = metrics.width;
            context.fillText(textContent, width * (anchor[0] - 0.5), height * (anchor[1] - 0.5));
            context.restore();
        } else if (textureName === "line.png") {
            const lineColor: RGB = judgeLine.extendedLayer.color?.getValueAt(beats) ?? [200, 200, 120];
            context.fillStyle = rgba(...(this.greenLine === judgeLine.id ? ([100, 255, 100] as RGB) : lineColor), alpha / 255)
            const scaledWidth = BASE_LINE_LENGTH * scaleX;
            const scaledHeight = LINE_WIDTH * scaleY;
            context.fillRect(-scaledWidth * anchor[0], -scaledHeight * anchor[1], scaledWidth, scaledHeight)
            // Fixes #1 on "kipphiApparatusLegacy"
        } else {
            context.globalAlpha = alpha / 255;
            const bitmap = this.textureMapping.get(textureName);
            const width = bitmap.width;
            const height = bitmap.height;
            const scaledWidth = width * scaleX;
            const scaledHeight = height * scaleY;
            context.drawImage(this.textureMapping.get(textureName),
                -scaledWidth * anchor[0], -scaledHeight * anchor[1], scaledWidth, scaledHeight)
            context.globalAlpha = 1;
        }
        context.scale(1, -1)

        // Draw Anchor


        context.drawImage(Images.ANCHOR, -10, -10)
        if (this.showsLineID) {
            context.save();
            context.scale(1, -1);
            context.fillStyle = "white";
            context.font = "40px phigros";
                
            context.fillText(`#${judgeLine.id} ${judgeLine.name.toLowerCase() === "untitled" ? "" : judgeLine.name}`, 10, 50);
            context.restore();
        }

        judgeLine.computeCurrentFloorPosition(beats, timeCalculator);

        /** 判定线的法向量 */
        const nVector: Vector = getVector(theta)[1] // 奇变偶不变，符号看象限(
        const toCenter: Vector = [675 - transformedX, 450 - transformedY];
        // 法向量是单位向量，分母是1，不写
        /** the distance between the center and the line */
        const innerProd = innerProduct(toCenter, nVector);
        const judgeLineCover = judgeLine.cover;
        const getYs = judgeLineCover ? (offset: number) => {
            
            const distance: number = Math.abs(innerProd + offset);
            let startY = distance - RENDER_SCOPE + offset;
            const endY = distance + RENDER_SCOPE + offset;
            if (startY < 0) startY = 0;
            return [startY, endY]
        } : (offset: number) => {
            
            const distance: number = Math.abs(innerProd + offset);
            const startY = distance - RENDER_SCOPE + offset; // 显示线下音符
            const endY = distance + RENDER_SCOPE + offset;
            return [startY, endY]
        }
        
        const drawScope = (endY: number, startY: number) => {
            if (endY<=1e-6) return
            context.save()
            context.scale(1, -1)
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
        

        const hitRenderLimit = beats > 0.66 ? beats - 0.66 : 0 // 渲染 0.66秒内的打击特效
        const holdTrees = judgeLine.hnLists;
        const noteTrees = judgeLine.nnLists;

        const showsRenderingBaseline = this.showsRenderingBaseline;
        // console.time("Updating integral");
        
        // console.timeEnd("Updating integral");
        
        for (let trees of [holdTrees, noteTrees]) {
            for (const [_, list] of trees) {
                const speedVal: number = list.speed;
                if (DRAWS_NOTES) {
                    // debugger
                    // 渲染音符
                    // console.time("computeTimeRange")
                    const [startY, endY] = getYs(list.medianYOffset)
                    if (showsRenderingBaseline) {
                        drawScope(endY, startY);
                    }
                    const timeRanges = speedVal !== 0 ? judgeLine.computeTimeRange(beats, timeCalculator, startY / speedVal, endY / speedVal) : [[0, Infinity] as [number, number]];
                    list.timeRanges = timeRanges
                    
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
                        this.renderHoldHitEffects(myMatrix, list, beats, hitRenderLimit, beats, timeCalculator)
                    } else {
                        this.renderHitEffects(myMatrix, list, hitRenderLimit, beats, timeCalculator)
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
        const {hitContext} = this;
        // console.log(hitContext.getTransform())
        const end = tree.getNodeAt(endBeats);
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
                const posX = note.positionX;
                const yo = note.yOffset * (note.above ? 1 : -1);
                const {x, y} = new Coordinate(posX, yo).mul(matrix);
                // console.log("he", x, y);
                const he = note.tintHitEffects;
                const nth = Math.floor((this.time - timeCalculator.toSeconds(beats)) * 16);
                drawNthFrame(hitContext, he !== undefined ? this.getTintHitEffect(he) : Images.HIT_FX, nth,x - HALF_HIT, y - HALF_HIT, HIT_EFFECT_SIZE, HIT_EFFECT_SIZE)
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
        const {hitContext} = this;
        let noteNode = start;
        const end = tree.getNodeAt(endBeats);
        if (noteNode.type === NodeType.TAIL) {
            return;
        }
        if (noteNode !== end)
        // console.log("start", start, startBeats, endBeats)
        while (noteNode !== end) {
            const notes = noteNode.notes
            , len = notes.length
            for (let i = 0; i < len; i++) {
                const note = notes[i];
                if (note.isFake) {
                    continue;
                }
                if (startBeats > TC.toBeats(note.endTime)) {
                    continue;
                }
                const posX = note.positionX;
                const yo = note.yOffset * (note.above ? 1 : -1);
                const {x, y} = new Coordinate(posX, yo).mul(matrix);
                const nth = Math.floor((beats - Math.floor(beats)) * 16);
                const he = note.tintHitEffects;
                
                drawNthFrame(hitContext, he !== undefined ? this.getTintHitEffect(he) : Images.HIT_FX, nth,
                x - HALF_HIT, y - HALF_HIT, HIT_EFFECT_SIZE, HIT_EFFECT_SIZE)
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
        let image: HTMLImageElement | OffscreenCanvas | ImageBitmap = note.tint ? this.getTintNote(note.tint, note.type, chord) : Images.getImageFromType(note.type, chord);
        const context = this.context;
        let zero = 0;
        
        if (note.yOffset) {
            positionY += note.yOffset;
            endpositionY += note.yOffset;
            zero = note.yOffset;
        }
        if (!note.above) {
            positionY = -positionY;
            endpositionY = -endpositionY
            zero = -zero;
        }
        let length = endpositionY - positionY
        const size = this.noteSize * note.size;
        const half = size / 2;
        const height = this.noteHeight;
        // console.log(NoteType[note.type])
        const opac = note.alpha < 255
        if (opac) {
            context.save();
            context.globalAlpha = note.alpha / 255;
        }
        if (note.type === NoteType.hold) {
            const isJudging = TC.toBeats(note.startTime) <= beats
            positionY = isJudging ? zero : positionY;
            length = isJudging ? (endpositionY - zero) : length;
            context.drawImage(Images.HOLD_BODY, note.positionX - half, positionY - 10, size, length);
        }
            
        context.drawImage(image, note.positionX - half, positionY - 10, size, height)
        
        // 不再使用叠加的方法
        
        if (!note.above) {
            context.drawImage(Images.BELOW, note.positionX - half, positionY - 10, size, height);
        }
        if (opac) {
            context.restore()
        }
    }
    getTintNote(tint: HEX, type: NoteType, chord: boolean): ProcessedTexture {
        const map = this.tintNotesMapping;
        const key = tint | type << 24 | (chord ? 1 : 0) << 25; // 26位整形表示一个类型的Note贴图
        const canBeSource = map.get(key);
        if (canBeSource) {
            return canBeSource;
        }
        const source = new OffscreenCanvas(NOTE_WIDTH, NOTE_HEIGHT);
        const context = source.getContext('2d');
        context.drawImage(Images.getImageFromType(type, chord), 0, 0, NOTE_WIDTH, NOTE_HEIGHT);
        context.globalCompositeOperation = 'multiply';
        context.fillStyle = "#" + tint.toString(16).padStart(6, "0");
        context.fillRect(0, 0, NOTE_WIDTH, NOTE_HEIGHT);
        map.set(key, source); // 在ImageBitmap创建完成之前，先使用Canvas临时代替
        // #default
        createImageBitmap(source).then((bmp: ImageBitmap) => {
            map.set(key, bmp);
        });
        // #enddefault
        return source;
    }
    getTintHitEffect(tint: HEX): ProcessedTexture {
        const map = this.tintEffectMapping;
        const key = tint;
        const canBeSource = map.get(key);
        if (canBeSource) {
            return canBeSource;
        }
        const HIT_FX = Images.HIT_FX;
        const source = new OffscreenCanvas(HIT_FX_SIZE, HIT_FX_SIZE);
        const context = source.getContext('2d');
        context.clearRect(0, 0, HIT_FX_SIZE, HIT_FX_SIZE);
        context.drawImage(HIT_FX, 0, 0, HIT_FX_SIZE, HIT_FX_SIZE);

        context.globalCompositeOperation = 'source-in';
        context.fillStyle = "#" + tint.toString(16);
        context.fillRect(0, 0, HIT_FX_SIZE, HIT_FX_SIZE);

        context.globalCompositeOperation = 'multiply';
        context.drawImage(HIT_FX, 0, 0, HIT_FX_SIZE, HIT_FX_SIZE);
        map.set(key, source);
// #default
        createImageBitmap(source).then((bmp: ImageBitmap) => {
            map.set(key, bmp);
        });
        // #enddefault
        return source;
    }
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



