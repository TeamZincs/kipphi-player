import { NoteType } from "kipphi";
import { NOTE_HEIGHT, NOTE_WIDTH } from "./constants";

// #default
const __IS_BROWSER = true;
// #enddefault


/* #node {
import { Canvas, Image, type CanvasRenderingContext2D } from "skia-canvas";
async function createImageBitmap(s) {
    return s;
} // do nothing

type ImageBitmap = Image;
type CanvasImageSource = Image | Canvas;
type HTMLImageElement = Image;
type OffscreenCanvas = Canvas;
const OffscreenCanvas = Canvas;

const __IS_BROWSER = false;
} */
const CELL_SIZE = 256;

type ImageSource = Blob | string/* #node{ | Buffer} */;
export class Images {
    // static readonly TAP: ImageBitmap
    // static readonly TAP_HL: ImageBitmap
    // static readonly HOLD_BODY: ImageBitmap
    // static readonly HOLD_HEAD: ImageBitmap
    // static readonly HOLD_HEAD_HL: ImageBitmap
    // static readonly DRAG: ImageBitmap
    // static readonly DRAG_HL: ImageBitmap
    // static readonly FLICK: ImageBitmap
    // static readonly FLICK_HL: ImageBitmap
    static readonly ANCHOR: ImageBitmap
    /** 多押 */
    static readonly CHORD: ImageBitmap
    static readonly BELOW: ImageBitmap
    // static readonly HIT_FX: ImageBitmap

    static async loadAndOptimize({
        // tap, holdBody, holdHead, drag, flick,
        anchor, chord, below, //hitFx,
        // holdHeadHl,
        // tapHl,
        // dragHl,
        // flickHl,
    }: {
        // tap: ImageSource,
        // holdBody: ImageSource,
        // holdHead: ImageSource,
        // drag: ImageSource,
        // flick: ImageSource,
        anchor: ImageSource,
        chord: ImageSource,
        below: ImageSource,
        // hitFx: ImageSource,

        // 它们是可选的，如果不提供就会使用那个chord叠加在未高亮的note上来产生高亮note
        holdHeadHl?: ImageSource, // HL: 高亮，与chord（多押）同义
        tapHl?: ImageSource,
        dragHl?: ImageSource,
        flickHl?: ImageSource,
    }) {
        // // @ts-expect-error 只读是对外的
        // Images.TAP = await createImageBitmap(await Images.loadNoteImage(tap));
        // // @ts-expect-error 只读是对外的
        // Images.HOLD_BODY = await createImageBitmap(await Images.loadHoldImage(holdBody));
        // // @ts-expect-error 只读是对外的
        // Images.HOLD_HEAD = await createImageBitmap(await Images.loadNoteImage(holdHead));
        // // @ts-expect-error 只读是对外的
        // Images.DRAG = await createImageBitmap(await Images.loadNoteImage(drag));
        // // @ts-expect-error 只读是对外的
        // Images.FLICK = await createImageBitmap(await Images.loadNoteImage(flick));
        // @ts-expect-error 只读是对外的
        Images.ANCHOR = await createImageBitmap(await Images.loadImage(anchor));
        // @ts-expect-error 只读是对外的
        Images.CHORD = await createImageBitmap(await Images.loadNoteImage(chord));
        // @ts-expect-error 只读是对外的
        Images.BELOW = await createImageBitmap(await Images.loadNoteImage(below));
        // // @ts-expect-error 只读是对外的
        // Images.HIT_FX = await createImageBitmap(await Images.loadImage(hitFx));

        // // @ts-expect-error 只读是对外的
        // Images.TAP_HL = await createImageBitmap(tapHl ? Images.loadNoteImage(tapHl) : Images.generateHL(Images.TAP));
        // // @ts-expect-error 只读是对外的
        // Images.HOLD_HEAD_HL = await createImageBitmap(holdHeadHl ? Images.loadNoteImage(holdHeadHl) :  Images.generateHL(Images.HOLD_HEAD));
        // // @ts-expect-error 只读是对外的
        // Images.DRAG_HL = await createImageBitmap(dragHl ? Images.loadNoteImage(dragHl) :  Images.generateHL(Images.DRAG));
        // // @ts-expect-error 只读是对外的
        // Images.FLICK_HL = await createImageBitmap(flickHl ? Images.loadNoteImage(flickHl) :  Images.generateHL(Images.FLICK));

    }
    static async loadImage(src: ImageSource) {
        src = src instanceof Blob ? URL.createObjectURL(src) : src;
        const img = new Image();
        return await new Promise<HTMLImageElement>((resolve, reject) => {
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = src;
        });
    }
    static async loadNoteImage(src: ImageSource) {
        const img = await Images.loadImage(src);
        const canvas = new OffscreenCanvas(NOTE_WIDTH, NOTE_HEIGHT);
        // #default
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        // #enddefault
        /* #node{
        const w = img.width;
        const h = img.height;
        } */
        canvas.getContext("2d")
            .drawImage(img, NOTE_WIDTH / 2 - w / 2, NOTE_HEIGHT / 2 - h / 2, w, h);
        return canvas
    }
    static async loadHoldImage(src: ImageSource) {
        const img = await Images.loadImage(src);
        // #default
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        // #enddefault
        /* #node{
        const w = img.width;
        const h = img.height;
        } */
        const canvas = new OffscreenCanvas(NOTE_WIDTH, h);
        canvas.getContext("2d")
            .drawImage(img, NOTE_WIDTH / 2 - w / 2, 0, w, h);
        return canvas
    }
    // static getImageFromType(type: NoteType, hightlighted?: boolean) {
    //     return [void 0, Images.TAP, Images.HOLD_HEAD, Images.FLICK, Images.DRAG,
    //         Images.TAP_HL, Images.HOLD_HEAD_HL, Images.FLICK_HL, Images.DRAG_HL
    //     ][type + (hightlighted ? 4 : 0)]
    // }

    protected static generateHL(unhighlighted: ImageBitmap) {
        const canvas = new OffscreenCanvas(NOTE_WIDTH, NOTE_HEIGHT);
        const context = canvas.getContext("2d");
        context.drawImage(unhighlighted, 0, 0);
        context.drawImage(Images.CHORD, 0, 0);
        return canvas;
    }
}

export const drawNthFrame = (context: CanvasRenderingContext2D, source: CanvasImageSource, ord: number, dx: number, dy: number, dw: number, dh: number) => {
    const x = ord % 4;
    const y = (ord - x) / 4
    context.drawImage(source, x * CELL_SIZE, y * CELL_SIZE, CELL_SIZE, CELL_SIZE, dx, dy, dw, dh)
}
