import { type RGB } from "kipphi";
import { rgb } from "./util";

/**
 * 能接受 tint 的绘图上下文。
 *
 * - 原生 Canvas 2D 上下文：用 SVG 的 feColorMatrix 滤镜实现；
 * - `context.ts` 的 LayerContext2D：本身就有 tint 状态机，直接赋值。
 */
export type TintableContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | { tint: readonly [number, number, number] };

const hasTintState = (ctx: unknown): ctx is { tint: readonly [number, number, number] } =>
    !!ctx && typeof ctx === "object" && "tint" in ctx;

export class Tinter {
    svg: SVGSVGElement;
    matrix: SVGFEColorMatrixElement;
    constructor(public id: string) {
        const svg = this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.innerHTML = `
            <defs>
                <filter id="multiply-filter-${id}">
                    <feColorMatrix type="matrix" values="
                    1 0 0 0 0
                    0 1 0 0 0
                    0 0 1 0 0
                    0 0 0 1 0
                    " id="colorMatrix-${id}"
                    color-interpolation-filters="sRGB">
                    </feColorMatrix>
                </filter>
            </defs>
        `;
        this.matrix = svg.querySelector(`#colorMatrix-${id}`) as SVGFEColorMatrixElement;

        // 添加到文档
        document.body.appendChild(svg);
        svg.style.display = 'none';
    }
    setTint(ctx: TintableContext, color: RGB) {
        if (hasTintState(ctx)) {
            // GPU 上下文：tint 是状态机的一部分，交给着色器相乘
            ctx.tint = color;
            return;
        }
        // 设置SVG滤镜颜色
        this.matrix.setAttribute('values', `
${color[0] / 255} 0 0 0 0
0 ${color[1] / 255} 0 0 0
0 0 ${color[2] / 255} 0 0
0 0 0 1 0
        `)
        
        // 应用滤镜
        ;(ctx as CanvasRenderingContext2D).filter = `url("#multiply-filter-${this.id}")`;
    }
    setDim(ctx: TintableContext, dim: number) {
        const ratio = 1 - dim;
        if (hasTintState(ctx)) {
            const value = Math.max(0, Math.min(255, ratio * 255));
            ctx.tint = [value, value, value];
            return;
        }
        this.matrix.setAttribute('values', `
${ratio} 0 0 0 0
0 ${ratio} 0 0 0
0 0 ${ratio} 0 0
0 0 0 1 0
        `)
        ;(ctx as CanvasRenderingContext2D).filter = `url("#multiply-filter-${this.id}")`;
    }
    /** 撤销 tint（相当于原生上下文的 filter = "none"） */
    clearTint(ctx: TintableContext) {
        if (hasTintState(ctx)) {
            ctx.tint = [255, 255, 255];
            return;
        }
        ;(ctx as CanvasRenderingContext2D).filter = "none";
    }
    destroy() {
        this.svg.remove();
    }
}
