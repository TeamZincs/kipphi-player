/* #node{import type { CanvasRenderingContext2D } from "skia-canvas";} */

export type Vector = [number, number];

/**
 * to compute the length of a vector
 * @param v 
 * @returns length
 */
export const absVector = (v: Vector) => {
    return Math.sqrt(Math.pow(v[0], 2) + Math.pow(v[1], 2));
}
/**
 * 
 * @param v1 
 * @param v2 
 * @returns 
 */
export const innerProduct = (v1: Vector, v2: Vector) => {
    return v1[0] * v2[0] + v1[1] * v2[1];
}

export const rgba = (r: number, g: number, b: number, a: number) => `rgba(${r}, ${g}, ${b}, ${a})`
export const rgb = (r: number, g: number, b: number) => `rgba(${r}, ${g}, ${b})`


/** 只用到这四个方法，所以原生 Canvas 2D 和 LayerContext2D 都能传 */
export type Path2DLike = {
    beginPath(): void;
    moveTo(x: number, y: number): void;
    lineTo(x: number, y: number): void;
    stroke(): void;
};

export function drawLine(context: Path2DLike, startX: number, startY: number, endX: number, endY: number) {
    context.beginPath()
    context.moveTo(startX, startY);
    context.lineTo(endX, endY);
    context.stroke()
}