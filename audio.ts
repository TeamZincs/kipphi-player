import { type NoteType } from "kipphi";
import type { Respack } from "./respack";
/**
 * 使用AudioBuffer加快播放
 */
export class AudioProcessor {
    audioContext: AudioContext;
    initialized: boolean;
    tap: AudioBuffer;
    drag: AudioBuffer;
    flick: AudioBuffer;
    private gainNode: GainNode;
    constructor() {
        this.audioContext = "AudioContext" in window ? new AudioContext() : new globalThis.webkitAudioContext();
    }
    static fromRespack(respack: Respack) {
        const instance = new AudioProcessor();
        instance.init({
            tap: respack.TAP_SE,
            drag: respack.DRAG_SE,
            flick: respack.FLICK_SE
        });
        return instance;
    }
    async init({ tap, drag, flick }: {tap: string | Blob, drag: string | Blob, flick: string | Blob}) {
        this.tap = await this.loadAudioBuffer(tap);
        this.drag = await this.loadAudioBuffer(drag);
        this.flick = await this.loadAudioBuffer(flick);
        this.gainNode = this.audioContext.createGain();
        this.gainNode.connect(this.audioContext.destination);
        this.volume = 3.5;
        this.initialized = true;
    }
    async loadAudioBuffer(src: string | Blob) {
        if (typeof src === "object" && src instanceof Blob) {
            return await this.audioContext.decodeAudioData(await src.arrayBuffer())
        }
        const res = await fetch(src);
        return await this.audioContext.decodeAudioData(await res.arrayBuffer())
    }
    play(buffer: AudioBuffer) {
        const source = this.audioContext.createBufferSource()
        source.buffer = buffer;

        source.connect(this.gainNode)
        source.start(0);
    }
    playNoteSound(type: NoteType) {
        if (!this.initialized) {
            return;
        }
        this.play([this.tap, this.tap, this.flick, this.drag][type - 1])
    }
    /**
     * 音量，默认值是3.5
     */
    set volume(value: number) {
        this.gainNode.gain.value = value;
    }
}
