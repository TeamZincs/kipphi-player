import YAML from "yaml";


import { type PhiraRespackConfig } from "./respack-phira";
import { NoteType } from "kipphi";

// #default
const __IS_BROWSER = true;
type ProcessedTexture = ImageBitmap | OffscreenCanvas;
type FileBearer = Blob;
type Cropped = ImageBitmap;
type CanvasDrawSource = ImageBitmap | OffscreenCanvas;
const toText = (blob: Blob) => blob.text();
// #enddefault

type HEX = number;


/*
#node {
import { Image, Canvas, type CanvasRenderingContext2D } from "skia-canvas";
type ImageBitmap = Image;
type OffscreenCanvas = Canvas;
const OffscreenCanvas = Canvas;
type ProcessedTexture = Canvas;
const __IS_BROWSER = false;
type OffscreenCanvasRenderingContext2D = CanvasRenderingContext2D;
const createImageBitmap = async <T extends any>(a: T) => a;
type FileBearer = Buffer;
type Cropped = Canvas;
const toText = (buffer: Buffer) => buffer.toString();
type CanvasDrawSource = Canvas | Image;
}
*/

export class Respack {
    TAP: ImageBitmap;
    HOLD_HEAD: Cropped;
    HOLD_BODY: Cropped;
    HOLD_TAIL: Cropped;
    FLICK: ImageBitmap;
    DRAG: ImageBitmap;

    TAP_HL: ImageBitmap;
    HOLD_HEAD_HL: Cropped;
    HOLD_BODY_HL: Cropped;
    HOLD_TAIL_HL: Cropped;
    FLICK_HL: ImageBitmap;
    DRAG_HL: ImageBitmap;

    HIT_FX: CanvasDrawSource;


    
    tintNotesMapping: Map<HEX, ProcessedTexture> = new Map();
    tintEffectMapping: Map<HEX, ProcessedTexture> = new Map();


    holdKeepHead: boolean = false;
    holdRepeat: boolean = false;
    holdCompact: boolean = false;
    hitFxFrames: [number, number] = [4, 4];
    hitFxDuration: number = 0.5;

    colorPerfect: number = 0xe1ffec9f;

    constructor() {
    }
    hitDrawer: (
        ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
        cx: number,
        cy: number,
        width: number,
        timeOrBeats: number,
        tint?: HEX
    ) => void;
    spawnHitDrawer() {
        const frames = this.hitFxFrames;
        const duration = this.hitFxDuration;
        const totalFrames = frames[0] * frames[1];
        const fw = this.HIT_FX.width / frames[0];
        const fh = this.HIT_FX.height / frames[1];
        const asp = fh / fw;
        this.hitDrawer = (ctx, cx, cy, width, time, tint) => {
            const frame = Math.floor(time / duration * totalFrames);
            const fx = frame % frames[0];
            const fy = Math.floor(frame / frames[0]);
            const height = width * asp;
            ctx.drawImage(tint ? this.getTintHitEffect(tint) : this.HIT_FX, fx * fw, fy * fh, fw, fh,
                cx - width / 2, cy - height / 2, width, height);
        }
    }
    noteDrawer: (
        ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
        cx: number,
        cy: number,
        width: number,
        stdWidth: number,
        type: Exclude<NoteType, NoteType.hold>,
        chord: boolean,
        tint?: HEX
    ) => void;
    spawnNoteDrawer() {
        const arr = [null,
            // 1           2       3             4
            this.TAP   , null, this.FLICK   , this.DRAG,
            this.TAP_HL, null, this.FLICK_HL, this.DRAG_HL];
        const widths = arr.map(img => img ? img.width : 0);
        const heights = arr.map(img => img ? img.height : 0);
        const aspects = widths.map((w, i) => heights[i] / w);
        this.noteDrawer = (ctx, cx, cy, width, stdWidth, type, chord, tint) => {
            const index = type + (chord ? 4 : 0);
            const img = tint ? this.getTintNote(tint, type, chord) : arr[index];
            const asp = aspects[index];
            const height = stdWidth * asp
            ctx.drawImage(img, cx - width / 2, cy - height / 2, width, height);
        };
    }
    // holdDrawer: (
    //     ctx: CanvasRenderingContext2D,
    //     cx: number,
    //     yhead: number,
    //     ytail: number,
    //     width: number,
    //     type: NoteType.hold,
    //     chord: boolean
    // ) => void; 

    // spawnHoldDrawer() {
    //     const holdKeepHead = this.holdKeepHead;
    //     const holdCompact = this.holdCompact;
    //     const HOLD_BODY = this.HOLD_BODY;
    //     const HOLD_HEAD = this.HOLD_HEAD;
    //     const HOLD_TAIL = this.HOLD_TAIL;
    //     this.holdDrawer = holdKeepHead
    //     ? (ctx, cx, yhead, ytail, width, type, chord) => {
    //         ctx.drawImage()
    //     }
    // }
    static async loadFromPhira(readFile: (path: string) => Promise<FileBearer>) {
        const pack = new Respack();


        const meta = YAML.parse(await toText(await readFile("info.yml"))) as PhiraRespackConfig;
        pack.holdKeepHead = meta.holdKeepHead;
        pack.holdRepeat = meta.holdRepeat;
        pack.holdCompact = meta.holdCompact;
        pack.hitFxFrames = meta.hitFx;
        pack.colorPerfect = meta.colorPerfect ?? 0xe1ffec9f;

        pack.HIT_FX = await Respack.loadImage(await readFile(`hit_fx.png`));
        pack.HIT_FX = await Respack.tintImage(pack.HIT_FX, pack.colorPerfect);

        pack.TAP = await Respack.loadImage(await readFile("click.png"));
        pack.FLICK = await Respack.loadImage(await readFile("flick.png"));
        pack.DRAG = await Respack.loadImage(await readFile("drag.png"));

        pack.TAP_HL = await Respack.loadImage(await readFile("click_mh.png"));
        pack.FLICK_HL = await Respack.loadImage(await readFile("flick_mh.png"));
        pack.DRAG_HL = await Respack.loadImage(await readFile("drag_mh.png"));

        const hold = await Respack.loadImage(await readFile("hold.png"));
        const hold_hl = await Respack.loadImage(await readFile("hold_mh.png"));

        pack.HOLD_TAIL = await pack.cropImage(hold, 0, 0, hold.width, meta.holdAtlas[0]);
        pack.HOLD_BODY = await pack.cropImage(hold, 0, meta.holdAtlas[0], hold.width, hold.height - meta.holdAtlas[1] - meta.holdAtlas[0]);
        pack.HOLD_HEAD = await pack.cropImage(hold, 0, hold.height - meta.holdAtlas[1], hold.width, meta.holdAtlas[1]);
        
        pack.HOLD_TAIL_HL = await pack.cropImage(hold_hl, 0, 0, hold_hl.width, meta.holdAtlas[0]);
        pack.HOLD_BODY_HL = await pack.cropImage(hold_hl, 0, meta.holdAtlas[0], hold_hl.width, hold.height - meta.holdAtlas[1] - meta.holdAtlas[0]);
        pack.HOLD_HEAD_HL = await pack.cropImage(hold_hl, 0, hold.height - meta.holdAtlas[1], hold_hl.width, meta.holdAtlas[1]);

        pack.spawnHitDrawer();
        pack.spawnNoteDrawer();
        return pack;
    }
    // #default
    static async loadImage(blob: Blob) {
        return await createImageBitmap(blob);
    }
    // #enddefault
    /* #node{
    static async loadImage(buffer: Buffer) {
        if (!buffer) {
            throw new Error("Buffer is null or undefined");
        }
        const img = new Image();
        
        return await new Promise<Image>((resolve, reject) => {
            img.src = buffer;
            if (img.complete) { // 血的教训
                resolve(img);
            }
            img.onload = () => resolve(img);
            img.onerror = () => reject(img);
        });
    }
}
    */
    async cropImage(image: ImageBitmap, x: number, y: number, width: number, height: number, tint?: number) {
        const canvas = new OffscreenCanvas(width, height);
        const context = canvas.getContext("2d");
        context.drawImage(image, x, y, width, height, 0, 0, width, height);
        return await createImageBitmap(canvas);
    }
    static async tintImage(image: ImageBitmap, tint: number) {
        const canvas = new OffscreenCanvas(image.width, image.height);
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0);
        context.globalCompositeOperation = "source-in";
        context.fillStyle = `#${tint.toString(16).padStart(8, "0")}`;
        context.fillRect(0, 0, image.width, image.height);
        context.globalCompositeOperation = "multiply";
        context.drawImage(image, 0, 0);
        return await createImageBitmap(canvas);
    }

    static tintImageNonAlpha(image: CanvasDrawSource, tint: number): [OffscreenCanvas, Promise<ProcessedTexture>] {
        const canvas = new OffscreenCanvas(image.width, image.height);
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0);
        context.globalCompositeOperation = "source-in";
        context.fillStyle = `#${tint.toString(16).padStart(6, "0")}`;
        context.fillRect(0, 0, image.width, image.height);
        context.globalCompositeOperation = "multiply";
        context.drawImage(image, 0, 0);
        return [canvas, createImageBitmap(canvas)];
    }
    
    getTintNote(tint: HEX, type: NoteType, chord: boolean): ProcessedTexture {
        const map = this.tintNotesMapping;
        const key = tint | type << 24 | (chord ? 1 : 0) << 25; // 26位整形表示一个类型的Note贴图
        const canBeSource = map.get(key);
        if (canBeSource) {
            return canBeSource;
        }
        const arr = [null,
            // 1           2       3             4
            this.TAP   , null, this.FLICK   , this.DRAG,
            this.TAP_HL, null, this.FLICK_HL, this.DRAG_HL];
        const original = arr[type + (chord ? 4 : 0)];
        let [source, promisedBmp] = Respack.tintImageNonAlpha(original, tint);
        map.set(key, source); // 在ImageBitmap创建完成之前，先使用Canvas临时代替
        // #default
        promisedBmp.then((bmp: ImageBitmap) => {
            source = null;
            map.set(key, bmp);
        });
        // #enddefault
        return source;
    }
    getNoteFromType(type: NoteType) {
        const arr = [null,
            // 1           2                 3             4
            this.TAP   , this.HOLD_HEAD, this.FLICK   , this.DRAG];
        return arr[type];
    }
    getTintHitEffect(tint: HEX): ProcessedTexture {
        const map = this.tintEffectMapping;
        const key = tint;
        const canBeSource = map.get(key);
        if (canBeSource) {
            return canBeSource;
        }
        const HIT_FX = this.HIT_FX;
        let [source, promisedBmp] = Respack.tintImageNonAlpha(HIT_FX, tint);
        map.set(key, source);
// #default
        promisedBmp.then((bmp: ImageBitmap) => {
            source = null;
            map.set(key, bmp);
        });
        // #enddefault
        return source;
    }
}