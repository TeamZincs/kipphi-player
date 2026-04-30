
export class Coordinate {
    constructor(public readonly x: number, public readonly y: number) {
    }
    mul(matrix: Matrix33) {
        const {x, y} = this;
        return new Coordinate(x * matrix.a + y * matrix.c + matrix.e, x * matrix.b + y * matrix.d + matrix.f);
    }
    static from([x, y]: [number, number]) {
        return new Coordinate(x, y);
    }
}

/**
 * @immutable
 */
export class Matrix33 {
    constructor(public readonly a: number, public readonly b: number,
                public readonly c: number, public readonly d: number,
                public readonly e: number, public readonly f: number) {}
    rotate(angle: number) {
        const {a, b, c, d, e, f} = this;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        return new Matrix33(a *  cos + c * sin, b *  cos + d * sin,
                          a * -sin + c * cos, b * -sin + d * cos,
                                           e,                  f);
    }
    translate(x: number, y: number) {
        const {a, b, c, d, e, f} = this;
        return new Matrix33(a, b, c, d, a * x + c * y + e, b * x + d * y + f);
    }
    transform(matrix: Matrix33) {
        const {a, b, c, d, e, f} = this;
        return new Matrix33(a * matrix.a + c * matrix.b, b * matrix.a + d * matrix.b,
                          a * matrix.c + c * matrix.d, b * matrix.c + d * matrix.d,
                          a * matrix.e + c * matrix.f + e, b * matrix.e + d * matrix.f + f);
    }
    scale(x: number, y: number) {
        const {a, b, c, d, e, f} = this;
        // 今天是4月23日，杨哲思在适配SulphrDXD的谱面《琪露诺的算数学院》时怎么改都改不对
        // 然后发现这里写错了，火冒三丈
        // 特此留念
        // 记住，矩阵变换是右乘一个矩阵（列变换），a和b在同一列，乘同一个数
        return new Matrix33(a * x, b * x, c * y, d * y, e, f);
    }
    invert() {
        const {a, b, c, d, e, f} = this;
        const det = a * d - b * c;
        return new Matrix33(d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det);
    }
    xmul(x: number, y: number) {
        return x * this.a + y * this.c + this.e;
    }
    ymul(x: number, y: number) {
        return x * this.b + y * this.d + this.f;
    }
    static fromDOMMatrix({a, b, c, d, e, f}: DOMMatrix) {
        return new Matrix33(a, b, c, d, e, f)
    }
}

export const identity = new Matrix33(1, 0, 0, 1, 0, 0);
