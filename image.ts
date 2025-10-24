import { NoteType } from "kipphi";

const CELL_SIZE = 256;

type ImageSource = Blob | string;
export class Images {
    static readonly TAP: ImageBitmap
    static readonly HOLD_BODY: ImageBitmap
    static readonly HOLD_HEAD: ImageBitmap
    static readonly DRAG: ImageBitmap
    static readonly FLICK: ImageBitmap
    static readonly ANCHOR: ImageBitmap
    /** 多押 */
    static readonly CHORD: ImageBitmap
    static readonly BELOW: ImageBitmap
    static readonly HIT_FX: ImageBitmap

    static async loadAndOptimize({
        tap, holdBody, holdHead, drag, flick,
        anchor, chord, below, hitFx
    }: {
        tap: ImageSource,
        holdBody: ImageSource,
        holdHead: ImageSource,
        drag: ImageSource,
        flick: ImageSource,
        anchor: ImageSource,
        chord: ImageSource,
        below: ImageSource,
        hitFx: ImageSource
    }) {
        // @ts-expect-error 只读是对外的
        Images.TAP = await createImageBitmap(await Images.loadImage(tap));
        // @ts-expect-error 只读是对外的
        Images.HOLD_BODY = await createImageBitmap(await Images.loadImage(holdBody));
        // @ts-expect-error 只读是对外的
        Images.HOLD_HEAD = await createImageBitmap(await Images.loadImage(holdHead));
        // @ts-expect-error 只读是对外的
        Images.DRAG = await createImageBitmap(await Images.loadImage(drag));
        // @ts-expect-error 只读是对外的
        Images.FLICK = await createImageBitmap(await Images.loadImage(flick));
        // @ts-expect-error 只读是对外的
        Images.ANCHOR = await createImageBitmap(await Images.loadImage(anchor));
        // @ts-expect-error 只读是对外的
        Images.CHORD = await createImageBitmap(await Images.loadImage(chord));
        // @ts-expect-error 只读是对外的
        Images.BELOW = await createImageBitmap(await Images.loadImage(below));
        // @ts-expect-error 只读是对外的
        Images.HIT_FX = await createImageBitmap(await Images.loadImage(hitFx));
    }
    static loadImage(src: string | Blob) {
        src = src instanceof Blob ? URL.createObjectURL(src) : src;
        return new Promise<HTMLImageElement>((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = src;
        });
    }
    static getImageFromType(type: NoteType) {
        return [void 0, Images.TAP, Images.HOLD_HEAD, Images.FLICK, Images.DRAG][type]
    }
}

export const drawNthFrame = (context: CanvasRenderingContext2D, source: CanvasImageSource, ord: number, dx: number, dy: number, dw: number, dh: number) => {
    const x = ord % 4;
    const y = (ord - x) / 4
    context.drawImage(source, x * CELL_SIZE, y * CELL_SIZE, CELL_SIZE, CELL_SIZE, dx, dy, dw, dh)
}
