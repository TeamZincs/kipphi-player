// ===-=== Generated, do no edit. ===-===
import { NoteType } from "kipphi";
import { NOTE_HEIGHT, NOTE_WIDTH } from "./constants";



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
const CELL_SIZE = 256;

type ImageSource = Blob | string| Buffer;
export class Images {
    static readonly ANCHOR: ImageBitmap
    /** 多押 */
    static readonly CHORD: ImageBitmap
    static readonly BELOW: ImageBitmap
    // static readonly HIT_FX: ImageBitmap

    static async loadAndOptimize({
        anchor, below
    }: {
        anchor: ImageSource,
        below: ImageSource,
    }) {
        // @ts-expect-error 只读是对外的
        Images.ANCHOR = await createImageBitmap(await Images.loadImage(anchor));
        // @ts-expect-error 只读是对外的
        Images.BELOW = await createImageBitmap(await Images.loadNoteImage(below));
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
        const w = img.width;
        const h = img.height;
        canvas.getContext("2d")
            .drawImage(img, NOTE_WIDTH / 2 - w / 2, NOTE_HEIGHT / 2 - h / 2, w, h);
        return canvas
    }
    static async loadHoldImage(src: ImageSource) {
        const img = await Images.loadImage(src);
        const w = img.width;
        const h = img.height;
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
