import { NoteType } from "kipphi";
import { Demuxer, Decoder } from "node-av/api";
import { AVMEDIA_TYPE_AUDIO } from "node-av/constants";
import type { Player } from "./player";

interface SoundEntry { time: number, type: number }

const SOUND_QUEUE_SIZE = 4096;

/**
 * 音频处理器 - 用于缓存音效
 */
export class AudioProcessor {
    private player: Player;
    private soundEffects: AudioBuffer[] = new Array(5);
    private soundQueue: Array<SoundEntry> = new Array(SOUND_QUEUE_SIZE); // 定长数组，用完从头又开始用
    private soundQueueIndex = 0;
    private MAX_SOUND_DURATION = 0; 

    init() {
        this.soundEffects[NoteType.hold] = this.soundEffects[NoteType.tap];
        const durations = this.soundEffects.filter(e => e).map(e => e ? e.duration : 0)
        this.MAX_SOUND_DURATION = Math.max(...durations);
        console.log(this.MAX_SOUND_DURATION, durations)
    }

    /**
     * 初始化音频处理器
     * @param player 播放器（用于采集时间）
     */
    linkPlayer(player: Player) {
        this.player = player;
    }


    /**
     * 加载音效文件
     * @param name 音效名称
     * @param filePath 音效文件路径
     * @returns AudioBuffer 格式的音效数据
     */
    async loadSoundEffect(name: string, fileBuffer: Buffer): Promise<void> {
        // 读取文件

        // 解封装
        const demuxer = await Demuxer.open(fileBuffer);

        // 找到音频流
        let audioStreamIndex = -1;
        let audioSampleRate = 0;
        let audioChannels = 0;

        for (let i = 0; i < demuxer.streams.length; i++) {
            if (demuxer.streams[i].codecpar.codecType === AVMEDIA_TYPE_AUDIO) {
                audioStreamIndex = i;
                audioSampleRate = demuxer.streams[i].codecpar.sampleRate;
                audioChannels = demuxer.streams[i].codecpar.channels;
                break;
            }
        }

        if (audioStreamIndex === -1) {
            throw new Error(`未找到音频流: ${name}`);
        }

        console.log(`  📂 加载音效 ${name}: ${audioSampleRate}Hz, ${audioChannels}ch`);

        // 创建解码器
        const decoder = await Decoder.create(demuxer.streams[audioStreamIndex]);

        // 收集所有音频帧
        const allFrames: any[] = [];
        for await (const packet of demuxer.packets()) {
            if (!packet) {
                break;
            }
            if (packet.streamIndex !== audioStreamIndex) {
                packet.free();
                continue;
            }

            for await (const frame of decoder.frames(packet)) {
                if (frame === null) continue;

                allFrames.push(frame);
            }
            packet.free();
        }

        // 计算总采样数
        let totalSamples = 0;
        for (const frame of allFrames) {
            // frame.data 是 Buffer[]，每个 buffer 是一个声道的采样数据
            const dataArray = Array.isArray(frame.data) ? frame.data : [frame.data];
            for (const buf of dataArray) {
                totalSamples += buf.length / 4; // Float32 每个样本 4 字节
            }
        }

        // 合并所有采样数据
        const buffer = new Float32Array(totalSamples);
        let offset = 0;

        for (const frame of allFrames) {
            const dataArray = Array.isArray(frame.data) ? frame.data : [frame.data];
            for (const buf of dataArray) {
                const frameData = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
                buffer.set(frameData, offset);
                offset += frameData.length;
            }
            frame.free();
        }

        decoder.close();
        demuxer.close();

        // 缓存音效
        this.soundEffects[NoteType[name]] = {
            data: buffer,
            sampleRate: audioSampleRate,
            channels: audioChannels,
            length: buffer.length / audioChannels,
            duration: buffer.length / audioChannels / audioSampleRate
        };
    }

    /**
     * 获取缓存的音效
     * @param type 音符类型 (1=tap, 2=hold, 3=flick, 4=drag)
     */
    getSoundEffect(type: NoteType): AudioBuffer | null {
        return this.soundEffects[type] || null;
    }

    /**
     * 记录音效条目（由 Player 调用）
     * @param time 音符时间（秒）
     * @param type 音符类型
     */
    playNoteSound(type: NoteType) {
        this.soundQueue[this.soundQueueIndex++] = { time: this.player.audioCurrentTime, type }
        this.soundQueueIndex %= SOUND_QUEUE_SIZE;
    }

    /**
     * 
     */
    getSoundEffects(): SoundEntry[] {
        // 从当前位置开始向前（索引减小方向）遍历队列数组，过期条目不管，遇到直接结束
        const expiry = this.player.audioCurrentTime - this.MAX_SOUND_DURATION;
        const entries: SoundEntry[] = [];
        let index = this.soundQueueIndex;
        while (true) {
            index--;
            if (index < 0) {
                index = SOUND_QUEUE_SIZE - 1;
            }
            const entry = this.soundQueue[index];
            if (!entry || entry.time < expiry) {
                break;
            }
            entries.push(entry);
        }
        return entries;
    }

}

/**
 * 音频缓冲区接口
 */
export interface AudioBuffer {
    data: Float32Array;
    sampleRate: number;
    channels: number;
    length: number;  // 样本数（帧数）
    duration: number; // 时长（秒）
}
