if (window)
// @ts-expect-error
window.OffscreenCanvas = window.OffscreenCanvas ?? new Proxy({}, {
    construct(target, argArray, newTarget) {
        const canvas = document.createElement("canvas");
        canvas.width = argArray[0];
        canvas.height = argArray[1];
        return canvas;
    },
    get(target, prop) {
        return HTMLCanvasElement[prop];
    }
})
