import { Demuxer, Decoder } from "node-av/api";
import { AVMEDIA_TYPE_AUDIO, AV_SAMPLE_FMT_FLTP, AV_CHANNEL_LAYOUT_STEREO, AV_CHANNEL_LAYOUT_MONO } from "node-av/constants";
import { Frame } from "node-av/lib";

/**
 * 流式音频处理器
 * 功能：边解码背景音乐边混入音效，支持流式输出
 */
export class StreamAudioProcessor {
    private demuxer: any = null;
    private decoder: any = null;
    private audioStreamIndex = -1;

    private targetSampleRate = 44100;
    private targetChannels = 2;

    private bgmSampleOffset = 0; // 背景音乐已解码的采样数
    private outputSampleOffset = 0; // 已输出的采样数
    private buffer: Float32Array | null = null; // 音频缓冲区

    // 音效相关
    private mixSoundEffects: boolean = true; // 是否混入音效
    private soundEffects: Map<number, Float32Array> = new Map();
    private activeEffects: Array<{ type: number; startTime: number; mixedSamples: number }> = [];

    /**
     * 初始化音频处理器
     */
    async init(
        audioBuffer: Buffer,
        targetSampleRate: number = 44100,
        targetChannels: number = 2,
        mixSoundEffects: boolean = true
    ) {
        this.targetSampleRate = targetSampleRate;
        this.targetChannels = targetChannels;
        this.mixSoundEffects = mixSoundEffects;

        // 打开背景音乐
        this.demuxer = await Demuxer.open(audioBuffer);

        // 查找音频流
        for (let i = 0; i < this.demuxer.streams.length; i++) {
            if (this.demuxer.streams[i].codecpar.codecType === AVMEDIA_TYPE_AUDIO) {
                this.audioStreamIndex = i;
                this.decoder = await Decoder.create(this.demuxer.streams[i]);
                console.log(`🎵 背景音乐：${this.demuxer.streams[i].codecpar.sampleRate}Hz, ${this.demuxer.streams[i].codecpar.channels}ch`);
                break;
            }
        }

        if (this.audioStreamIndex === -1) {
            throw new Error('未找到音频流');
        }

        // 初始化缓冲区（预分配 1 秒的数据）
        this.buffer = new Float32Array(this.targetSampleRate * this.targetChannels);
    }

    /**
     * 加载音效
     */
    loadSoundEffect(type: number, data: Float32Array, sampleRate: number, channels: number) {
        // 如果采样率不同，需要重采样
        if (sampleRate !== this.targetSampleRate || channels !== this.targetChannels) {
            const resampledData = new Float32Array(
                Math.floor(data.length * this.targetSampleRate / sampleRate * this.targetChannels / channels)
            );

            for (let i = 0; i < resampledData.length; i++) {
                const srcPos = i * sampleRate / this.targetSampleRate * channels / this.targetChannels;
                const srcIndex = Math.floor(srcPos);
                if (srcIndex < data.length) {
                    resampledData[i] = data[srcIndex];
                }
            }

            this.soundEffects.set(type, resampledData);
        } else {
            this.soundEffects.set(type, data);
        }
    }

    /**
     * 触发音效
     */
    playSound(type: number, time: number) {
        if (!this.mixSoundEffects) return; // 不混入音效时直接忽略
        this.activeEffects.push({
            type,
            startTime: time,
            mixedSamples: 0
        });
    }

    /**
     * 解码背景音乐到缓冲区
     */
    private async decodeBGM(samplesNeeded: number): Promise<number> {
        let decodedSamples = 0;
        const bufferSize = this.buffer!.length / this.targetChannels;

        while (decodedSamples < samplesNeeded && this.demuxer) {
            const packet = await this.demuxer.packets().next();
            if (packet.done || !packet.value) break;

            const p = packet.value;
            if (p.streamIndex !== this.audioStreamIndex) {
                p.free();
                continue;
            }

            for await (const frame of this.decoder.frames(p)) {
                if (frame === null) continue;

                const channelBuffers: Float32Array[] = [];
                if (Array.isArray(frame.data)) {
                    for (const buf of frame.data) {
                        channelBuffers.push(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
                    }
                } else {
                    const data = frame.data as Uint8Array;
                    channelBuffers.push(new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4));
                }

                const srcSampleRate = frame.sampleRate;
                const srcChannels = channelBuffers.length;
                const srcSamplesPerChannel = channelBuffers[0].length;

                // 重采样和混入
                let dstSamples = 0;
                if (srcSampleRate !== this.targetSampleRate || srcChannels !== this.targetChannels) {
                    const duration = srcSamplesPerChannel / srcSampleRate;
                    dstSamples = Math.floor(duration * this.targetSampleRate);

                    for (let i = 0; i < dstSamples; i++) {
                        const time = i / this.targetSampleRate;
                        const srcPos = time * srcSampleRate;
                        const srcIndex = Math.round(srcPos);

                        for (let ch = 0; ch < this.targetChannels; ch++) {
                            const srcCh = Math.min(ch, srcChannels - 1);
                            const value = srcIndex < srcSamplesPerChannel ? channelBuffers[srcCh][srcIndex] : 0;
                            const destIndex = (this.bgmSampleOffset + i) * this.targetChannels + ch;
                            if (this.buffer && destIndex < this.buffer.length) {
                                this.buffer[destIndex] = value;
                            }
                        }
                    }

                    this.bgmSampleOffset += dstSamples;
                } else {
                    dstSamples = srcSamplesPerChannel;
                    for (let i = 0; i < srcSamplesPerChannel; i++) {
                        for (let ch = 0; ch < srcChannels; ch++) {
                            const destIndex = (this.bgmSampleOffset + i) * this.targetChannels + ch;
                            if (this.buffer && destIndex < this.buffer.length) {
                                this.buffer[destIndex] = channelBuffers[ch][i];
                            }
                        }
                    }

                    this.bgmSampleOffset += srcSamplesPerChannel;
                }

                decodedSamples += dstSamples;
                frame.free();

                // 检查缓冲区是否已满
                const availableSpace = bufferSize - (this.bgmSampleOffset - this.outputSampleOffset);
                if (availableSpace <= 0) break;
            }

            p.free();
        }

        return decodedSamples;
    }

    /**
     * 混入音效
     */
    private mixEffects(startTime: number, samplesCount: number) {
        const VOLUME_SCALE = 0.5;

        // 过滤过期的音效
        this.activeEffects = this.activeEffects.filter(effect => {
            const effectData = this.soundEffects.get(effect.type);
            if (!effectData) return false;

            const effectSamples = effectData.length / this.targetChannels;
            const samplesRemaining = effectSamples - effect.mixedSamples;

            if (samplesRemaining <= 0) return false;

            // 计算音效在当前时间段的起始位置
            const timeSinceStart = startTime - effect.startTime;
            if (timeSinceStart < 0) return true; // 音效还未开始

            // 混入音效
            const samplesToMix = Math.min(samplesRemaining, samplesCount);
            for (let i = 0; i < samplesToMix; i++) {
                const effectIndex = (effect.mixedSamples + i) * this.targetChannels;
                const bufferIndex = i * this.targetChannels;

                for (let ch = 0; ch < this.targetChannels; ch++) {
                    if (effectIndex + ch < effectData.length && this.buffer && bufferIndex + ch < samplesCount * this.targetChannels) {
                        this.buffer[bufferIndex + ch] += effectData[effectIndex + ch] * VOLUME_SCALE;
                        // 限幅
                        this.buffer[bufferIndex + ch] = Math.max(-1, Math.min(1, this.buffer[bufferIndex + ch]));
                    }
                }
            }

            effect.mixedSamples += samplesToMix;
            return effect.mixedSamples < effectSamples;
        });
    }

    /**
     * 生成音频帧（流式）
     * @param blockSize 每块的采样数（通常 1024）
     * @returns 音频帧或 null（表示结束）
     */
    async *generateAudioFrames(blockSize: number = 1024): AsyncGenerator<Frame | null> {
        let cumulativeSamples = 0;
        let eof = false;
        let frameCount = 0;

        while (true) {
            // 确保缓冲区有足够的数据（只在未结束时解码）
            if (!eof) {
                const decoded = await this.decodeBGM(blockSize);
                if (decoded === 0 && this.bgmSampleOffset - this.outputSampleOffset === 0) {
                    // 解码完成且缓冲区为空
                    eof = true;
                    console.log(`🔊 音频解码完成，共 ${cumulativeSamples} 采样`);
                }
            }

            // 检查是否还有数据
            const availableSamples = this.bgmSampleOffset - this.outputSampleOffset;
            if (availableSamples <= 0) {
                // 没有数据了，发送 EOF
                console.log(`🔊 音频帧生成完成，共 ${frameCount} 帧`);
                yield null;
                break;
            }

            const samplesToOutput = Math.min(blockSize, availableSamples);
            const outputTime = this.outputSampleOffset / this.targetSampleRate;

            // 混入音效
            this.mixEffects(outputTime, samplesToOutput);

            // 提取输出数据
            const chunkData = this.buffer!.subarray(
                this.outputSampleOffset * this.targetChannels,
                (this.outputSampleOffset + samplesToOutput) * this.targetChannels
            );

            // 转换为平面格式（FLTP）
            const channelBuffers: Float32Array[] = [];
            for (let ch = 0; ch < this.targetChannels; ch++) {
                const channelData = new Float32Array(samplesToOutput);
                for (let i = 0; i < samplesToOutput; i++) {
                    channelData[i] = chunkData[i * this.targetChannels + ch];
                }
                channelBuffers.push(channelData);
            }

            // 合并为平面格式的 Buffer
            const totalBytes = channelBuffers.reduce((sum, buf) => sum + buf.byteLength, 0);
            const combinedBuffer = Buffer.alloc(totalBytes);
            let offset = 0;
            for (const chBuf of channelBuffers) {
                combinedBuffer.set(Buffer.from(chBuf.buffer, chBuf.byteOffset, chBuf.byteLength), offset);
                offset += chBuf.byteLength;
            }

            // 创建音频帧
            const frame = Frame.fromAudioBuffer(combinedBuffer, {
                nbSamples: samplesToOutput,
                format: AV_SAMPLE_FMT_FLTP,
                sampleRate: this.targetSampleRate,
                channelLayout: this.targetChannels === 2 ? AV_CHANNEL_LAYOUT_STEREO : AV_CHANNEL_LAYOUT_MONO,
                pts: BigInt(cumulativeSamples),
                timeBase: { num: 1, den: this.targetSampleRate }
            });

            this.outputSampleOffset += samplesToOutput;
            cumulativeSamples += samplesToOutput;

            // 旋转缓冲区（已输出的数据移到前面）
            const remainingSamples = this.bgmSampleOffset - this.outputSampleOffset;
            if (remainingSamples > 0) {
                this.buffer!.copyWithin(
                    0,
                    this.outputSampleOffset * this.targetChannels,
                    this.bgmSampleOffset * this.targetChannels
                );
            }
            this.bgmSampleOffset = remainingSamples;
            this.outputSampleOffset = 0;

            frameCount++;
            if (frameCount % 100 === 0) {
                console.log(`🔊 已生成 ${frameCount} 音频帧，累积 ${cumulativeSamples} 采样`);
            }

            yield frame;
        }
    }

    /**
     * 关闭资源
     */
    close() {
        if (this.decoder) this.decoder.close();
        if (this.demuxer) this.demuxer.close();
    }
}
