import { type NoteType } from "kipphi";
import type { Respack } from "./respack";
/**
 * 使用AudioBuffer加快播放
 */
export class AudioProcessor {
    audioContext: AudioContext;
    initialized: boolean;
    /** 资源包里没有对应音效时是 null（那类音符就没声音） */
    tap: AudioBuffer | null;
    drag: AudioBuffer | null;
    flick: AudioBuffer | null;
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
    /**
     * 加载打击音
     *
     * 三个都可以不给：资源包里的音效本来就是可选的，缺了就是那类音符没声音，
     * 不该连带整个播放器起不来。
     */
    async init({ tap, drag, flick }: {
        tap?: string | Blob;
        drag?: string | Blob;
        flick?: string | Blob;
    }) {
        this.tap = tap ? await this.loadAudioBuffer(tap) : null;
        this.drag = drag ? await this.loadAudioBuffer(drag) : null;
        this.flick = flick ? await this.loadAudioBuffer(flick) : null;
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
    /**
     * 录制时设上它：只记录打击音事件，不真的发声
     *
     * `beats` 是这个音在谱面上的拍数（按**渲染**时间轴），录制端需要它来算准确时间，
     * 不能直接拿当前帧的时间，否则会差一个 `renderingOffset`。
     *
     * 录制结束后记得还原。
     */
    captureNoteSound?: (type: NoteType, beats: number) => void;
    /** 取某个音符类型对应的打击音 */
    getNoteSound(type: NoteType): AudioBuffer | undefined {
        return [this.tap, this.tap, this.flick, this.drag][type - 1] ?? undefined;
    }
    playNoteSound(type: NoteType, beats: number = 0) {
        if (!this.initialized) {
            return;
        }
        if (this.captureNoteSound) {
            this.captureNoteSound(type, beats);
            return;
        }
        // 没有这个音效就不发声音（资源包里的音效是可选的）
        const sound = [this.tap, this.tap, this.flick, this.drag][type - 1];

        if (sound) this.play(sound);
    }
    /**
     * 音量，默认值是3.5
     */
    set volume(value: number) {
        this.gainNode.gain.value = value;
    }
}
