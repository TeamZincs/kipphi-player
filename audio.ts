import { type NoteType } from "kipphi";
/**
 * 使用AudioBuffer加快播放
 */


export class AudioProcessor {
    instance?: AudioProcessor;
    audioContext: AudioContext;
    initialized: boolean;
    tap: AudioBuffer;
    drag: AudioBuffer;
    flick: AudioBuffer;
    private gainNode: GainNode;
    constructor() {
        if (this.instance) {
            return this.instance;
        }
        this.audioContext = "AudioContext" in window ? new AudioContext() : new globalThis.webkitAudioContext();
    }
    async init({ tap, drag, flick }: {tap: string, drag: string, flick: string}) {
        
        this.tap = await this.fetchAudioBuffer(tap);
        this.drag = await this.fetchAudioBuffer(drag);
        this.flick = await this.fetchAudioBuffer(flick);
        this.gainNode = this.audioContext.createGain();
        this.gainNode.connect(this.audioContext.destination);
        this.volume = 3.5;
        this.initialized = true;
        this.instance = this;
    }
    async fetchAudioBuffer(src: string) {
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
    set volume(value: number) {
        this.gainNode.gain.value = value;
    }
}
