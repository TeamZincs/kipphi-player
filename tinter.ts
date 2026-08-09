import { type RGB } from "kipphi";
import { rgb } from "./util";

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
    setTint(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, color: RGB) {
        // 设置SVG滤镜颜色
        this.matrix.setAttribute('values', `
${color[0] / 255} 0 0 0 0
0 ${color[1] / 255} 0 0 0
0 0 ${color[2] / 255} 0 0
0 0 0 1 0
        `)
        
        // 应用滤镜
        ctx.filter = `url("#multiply-filter-${this.id}")`;
    }
    destroy() {
        this.svg.remove();
    }
}
