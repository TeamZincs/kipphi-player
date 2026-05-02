if (window)
// @ts-expect-error
window.OffscreenCanvas = window.OffscreenCanvas ?? function (...argArray) {
    const canvas = document.createElement("canvas");
    canvas.width = argArray[0];
    canvas.height = argArray[1];
    return canvas;
}