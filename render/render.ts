import fs from "fs/promises";

import { Canvas, FontLibrary } from "skia-canvas";
import { Demuxer, Decoder, Encoder } from "node-av/api";
import { AVMEDIA_TYPE_AUDIO, AV_SAMPLE_FMT_FLTP, AV_CHANNEL_LAYOUT_STEREO, AV_CHANNEL_LAYOUT_MONO, FF_ENCODER_AAC } from "node-av/constants";
import { Frame } from "node-av/lib";
import { Muxer, HardwareContext } from "node-av/api";
import { FF_ENCODER_LIBX264, AV_PIX_FMT_RGBA } from "node-av/constants";

import { Player } from "./player";
import { Images } from "./image"
import { Chart } from "kipphi";
import { AudioProcessor } from "./audioProcessor";
import type { Respack } from "./respack";



export function useFont(path: string) {
    FontLibrary.use("phigros", path)
}

let respack: Respack = null;
export function useRespack(resp: Respack) {
    respack = resp;
}

/**
 * 使用 node-av 进行硬件加速视频渲染（纯内存操作）
 * 特点：
 * - 零拷贝：使用 ArrayBuffer.transfer 避免数据复制
 * - 硬件加速：自动检测并使用 NVENC/AMF/VideoToolbox/QSV
 * - 内存池：复用 Buffer 减少 GC 压力
 * - 流水线：并行处理渲染和编码
 * - 纯内存：使用 MPEG-TS 格式，无需临时文件
 * - 音频合并：支持将背景音乐合并到输出视频中
 * - 实时音效消费：在渲染时消费音效条目，减少内存占用
 */
export async function renderChartFast(
    chart: Chart,
    illustrationBlobOrBuffer: Blob | Buffer,
    textureFetcher: (name: string) => Promise<Buffer>,
    audioBuffer: Buffer,
    range?: [number, number]
): Promise<{
    out: Buffer;
    duration: number;
    fps: number;
}> {
    const width = 1350;
    const height = 900;
    const fps = 60;
    const left = range && range[0] || 0;
    const right = range && range[1] ? Math.min(range[1], chart.duration) : chart.duration;
    const duration = right - left;
    const totalFrames = Math.ceil(duration * fps);

    console.log(`🎬 开始快速渲染：${totalFrames} 帧 @ ${fps}fps, 包含音频`);

    // 初始化音频处理器
    const audioProcessor = new AudioProcessor();

    // 加载音效（tap 和 hold 使用同一音效）
    console.log("🔊 加载音效...");
    try {
        const loadPromises: Promise<void>[] = [];
        loadPromises.push(audioProcessor.loadSoundEffect('tap', './assets/tap.mp3'));
        loadPromises.push(audioProcessor.loadSoundEffect('hold', './assets/tap.mp3')); // hold 使用 tap 音效
        loadPromises.push(audioProcessor.loadSoundEffect('flick', './assets/flick.mp3'));
        loadPromises.push(audioProcessor.loadSoundEffect('drag', './assets/drag.mp3'));

        await Promise.all(loadPromises);
        console.log(`✅ 音效加载完成`);
    } catch (err) {
        console.error(`⚠️  音效加载失败:`, err);
    }

    // 初始化 canvas 和 player
    const canvas = new Canvas(width, height);
    const illustration = await Images.loadImage(illustrationBlobOrBuffer);
    const player = new Player(canvas, audioProcessor, illustration, respack);
    audioProcessor.linkPlayer(player);
    player.receive(chart, async (name) => {
        const texture = await textureFetcher(name);
        return Images.loadImage(texture);
    });

    // 检测最佳硬件加速
    const hw = HardwareContext.auto();
    const hwCodec = hw?.getEncoderCodec('h264');
    const encoderCodec = hwCodec || FF_ENCODER_LIBX264;
    console.log(`🎯 编码器: ${encoderCodec}${hw ? `, 硬件加速: ${hw.deviceTypeName}` : ' (软件编码)'}`);

    // 初始化编码器 - CRF 质量模式
    const encoder = await Encoder.create(encoderCodec, {
        gopSize: fps * 2,
        threadCount: 1, // 单线程避免硬件编码器缓冲区问题
        options: {
            crf: '18',
            qp: '18',
            // 输出 Annex B 格式（MPEG-TS 需要的格式）
            h264_profile: 'high',
            h264_level: '41',
            
        }
    });

    // 创建 MP4 临时文件（MP4 格式需要可寻址）
    const tempMp4Path = `./temp_output_${Date.now()}.mp4`;
    console.log("📝 创建 MP4 muxer...");

    // 直接使用 MP4 格式封装（写入临时文件，支持 seek）
    const mp4Muxer = await Muxer.open(tempMp4Path, {
        format: "mp4",
        maxMuxingQueueSize: 1024,  // 增加最大缓冲包数量（默认 128）
        muxingQueueDataThreshold: 100 * 1024 * 1024  // 增加数据阈值到 100MB（默认 50MB）
    });

    // 添加视频流
    const videoStreamIndex = mp4Muxer.addStream(encoder);

    // 添加音频流：转码为 AAC
    const audioDemuxer = await Demuxer.open(audioBuffer);
    const streams = audioDemuxer.streams;
    let audioStreamIndex: number = -1;
    let audioDecoder: any = null;

    for (let i = 0; i < streams.length; i++) {
        if (streams[i].codecpar.codecType === AVMEDIA_TYPE_AUDIO) {
            console.log(`🎵 原始音频: ${streams[i].codecpar.codecId}, ${streams[i].codecpar.channels}ch, ${streams[i].codecpar.sampleRate}Hz`);

            // 创建解码器
            try {
                audioDecoder = await Decoder.create(streams[i]);
                console.log(`🎵 音频解码器创建成功`);
            } catch (err) {
                console.error(`⚠️  音频解码器创建失败:`, err);
            }
            break;
        }
    }

    // 创建 AAC 编码器
    let audioEncoder: any = null;
    if (audioDecoder) {
        try {
            audioEncoder = await Encoder.create(FF_ENCODER_AAC);
            audioStreamIndex = mp4Muxer.addStream(audioEncoder);
            console.log(`🎵 AAC 编码器成功`);
        } catch (err) {
            console.error(`⚠️  AAC 编码器失败:`, err);
        }
    }

    // 编码计数
    let encodedFrameCount = 0;

    // 开始渲染流水线
    const startTime = performance.now();

    // 音频配置
    const targetSampleRate = 44100;
    const targetChannels = 2;
    const samplesPerFrame = Math.ceil(targetSampleRate / fps);
    const samplesPerFrameWithChannels = samplesPerFrame * targetChannels;
    
    // 创建累积音频缓冲区，用于在渲染时混合音效
    const totalAudioSamples = Math.ceil(duration * targetSampleRate) * targetChannels;
    const mixedAudioBuffer = new Float32Array(totalAudioSamples);

    // 先解码背景音乐到混合缓冲区（带重采样）
    console.log("📥 解码背景音乐到混合缓冲区...");

    let bgmSampleOffset = 0;
    let originalSampleRate = 44100;
    let originalChannels = 2;

    // 重新打开 demuxer 进行解码（因为 demuxer 是流式的，只能读一次）
    const bgmDemuxer = await Demuxer.open(audioBuffer);

    // 在 bgmDemuxer 中重新查找音频流索引（可能与第一个 demuxer 不同）
    let bgmAudioStreamIndex = -1;
    for (let i = 0; i < bgmDemuxer.streams.length; i++) {
        if (bgmDemuxer.streams[i].codecpar.codecType === AVMEDIA_TYPE_AUDIO) {
            bgmAudioStreamIndex = i;
            break;
        }
    }
    
    if (bgmAudioStreamIndex === -1) {
        console.error('❌ 在 bgmDemuxer 中未找到音频流！');
    } else {
        console.log(`🎵 bgmDemuxer 音频流索引：${bgmAudioStreamIndex}`);
    }
    
    const bgmDecoder = await Decoder.create(bgmDemuxer.streams[bgmAudioStreamIndex]);
    
    console.log(`🔍 开始处理音频包，bgmAudioStreamIndex = ${bgmAudioStreamIndex}`);
    let packetCount = 0;
    let frameCount = 0;

    for await (const packet of bgmDemuxer.packets()) {
        if (packet === null) break;
        
        packetCount++;
        
        // 如果指定了音频流索引，只处理该流的包
        if (bgmAudioStreamIndex !== -1 && packet.streamIndex !== bgmAudioStreamIndex) {
            continue;
        }

        await using p = packet;
        for await (const frame of bgmDecoder.frames(p)) {
            if (frame === null) continue;
            
            frameCount++;
            
            // FLTP 格式：frame.data 是一个数组，每个元素是一个声道的 Uint8Array
            const channelBuffers: Float32Array[] = [];
            
            if (Array.isArray(frame.data)) {
                // FLTP: 平面格式，每个声道分开存储
                for (let ch = 0; ch < frame.data.length; ch++) {
                    const buf = frame.data[ch];
                    channelBuffers.push(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
                }
            } else {
                // 单声道或其他格式
                const data = frame.data as Uint8Array;
                channelBuffers.push(new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4));
            }
            
            const srcSamplesPerChannel = channelBuffers[0].length;
            originalSampleRate = frame.sampleRate;
            originalChannels = channelBuffers.length;
            
            // 输出第一个帧的详细信息用于调试
            if (frameCount === 0 && packetCount < 3) {
                console.log(`  📊 帧详情：采样率=${originalSampleRate}Hz, 声道数=${originalChannels}, ` +
                            `每声道采样数=${srcSamplesPerChannel}, 数据范围=[${channelBuffers[0][0]?.toFixed(4)}, ${channelBuffers[0][srcSamplesPerChannel-1]?.toFixed(4)}]`);
            }
            
            // 如果原始采样率与目标不同，需要重采样
            if (originalSampleRate !== targetSampleRate) {
                // 计算时间长度（秒）
                const duration = srcSamplesPerChannel / originalSampleRate;
                // 目标采样数 = 时间长度 × 目标采样率
                const dstSamples = Math.floor(duration * targetSampleRate);
                
                // 对每个声道进行重采样（使用最近邻插值，保持音质）
                const resampledChannels: Float32Array[] = [];
                for (let ch = 0; ch < originalChannels && ch < targetChannels; ch++) {
                    const srcData = channelBuffers[ch];
                    const dstData = new Float32Array(dstSamples);
                    
                    for (let i = 0; i < dstSamples; i++) {
                        // 计算当前目标采样点对应的时间
                        const time = i / targetSampleRate;
                        // 映射回源数据的位置
                        const srcPos = time * originalSampleRate;
                        const srcIndex = Math.round(srcPos);  // 使用最近邻，避免插值失真
                        
                        // 边界检查
                        if (srcIndex >= srcData.length) {
                            dstData[i] = srcData[srcData.length - 1];
                        } else if (srcIndex < 0) {
                            dstData[i] = srcData[0];
                        } else {
                            dstData[i] = srcData[srcIndex];  // 直接复制，不插值
                        }
                    }
                    resampledChannels.push(dstData);
                }
                
                // 将重采样后的数据交错写入混合缓冲区
                for (let i = 0; i < dstSamples; i++) {
                    for (let ch = 0; ch < targetChannels; ch++) {
                        const destIndex = bgmSampleOffset + i * targetChannels + ch;
                        if (destIndex < mixedAudioBuffer.length && ch < resampledChannels.length) {
                            mixedAudioBuffer[destIndex] = resampledChannels[ch][i];
                        }
                    }
                }
                
                bgmSampleOffset += dstSamples * targetChannels;
            } else {
                // 采样率相同，直接复制（注意 FLTP 到 Interleaved 的转换）
                const samplesPerChannel = channelBuffers[0].length;
                
                // 将平面格式转换为交错格式
                for (let i = 0; i < samplesPerChannel; i++) {
                    for (let ch = 0; ch < originalChannels && ch < targetChannels; ch++) {
                        const destIndex = bgmSampleOffset + i * targetChannels + ch;
                        if (destIndex < mixedAudioBuffer.length) {
                            mixedAudioBuffer[destIndex] = channelBuffers[ch][i];
                        }
                    }
                }
                
                bgmSampleOffset += samplesPerChannel * targetChannels;
            }
            frame.free();
        }
    }
    
    bgmDecoder.close();
    bgmDemuxer.close();
    
    console.log(`  ✅ 背景音乐解码完成：${bgmSampleOffset} 采样点 / ${(bgmSampleOffset / targetSampleRate / targetChannels).toFixed(2)} 秒`);
    console.log(`  📊 处理统计：${packetCount} 个包，${frameCount} 个帧`);
    
    if (bgmSampleOffset === 0) {
        console.error('  ⚠️  警告：没有解码到任何音频数据！');
    }

    // 使用 async function 生成帧
    async function* generateFrames() {
        for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
            // 更新播放器状态
            const currentTime = left + frameIndex / fps;
            player.audioCurrentTime = currentTime;
            player.render();

            // 在渲染时消费该时间点的音效条目
            // 消费当前帧时间范围内的所有音效
            const frameStartTime = currentTime;
            const frameEndTime = left + (frameIndex + 1) / fps;
            
            // 获取并消费该时间段内的音效
            const soundEntries = audioProcessor.getSoundEffectsInTimeRange(frameStartTime, frameEndTime);
            if (soundEntries.length > 0) {
                // 计算该帧对应的音频采样范围
                const startSample = Math.floor(frameStartTime * targetSampleRate) * targetChannels;
                
                // 混入音效
                for (const entry of soundEntries) {
                    const sound = audioProcessor.getSoundEffect(entry.type);
                    if (!sound) continue;

                    // 计算音效在帧内的相对开始位置
                    const effectStartOffset = (entry.time - frameStartTime) * targetSampleRate * targetChannels;
                    const startSampleInFrame = startSample + Math.floor(effectStartOffset);
                    
                    // 🔍 关键：sound.data 是平面格式（FLTP），需要正确转换为交错格式混合
                    const effectData = sound.data;
                    const effectChannels = sound.channels;
                    
                    // ✅ 计算每声道的样本数（不是总长度）
                    const effectSamplesPerChannel = Math.floor(effectData.length / effectChannels);
                    
                    // ✅ 计算可以混合的样本点数（基于交错格式的样本点数量）
                    const availableSamples = Math.floor((mixedAudioBuffer.length - startSampleInFrame) / targetChannels);
                    const samplesToMix = Math.min(effectSamplesPerChannel, availableSamples);
                    
                    // ✅ 正确的平面→交错转换混合
                    for (let i = 0; i < samplesToMix; i++) {
                        for (let ch = 0; ch < targetChannels && ch < effectChannels; ch++) {
                            // 目标位置：交错格式 [L0][R0][L1][R1]...
                            const destIndex = startSampleInFrame + i * targetChannels + ch;
                            
                            // 源位置：平面格式 [LLLL...][RRRR...]
                            const effectIndex = ch * effectSamplesPerChannel + i;
                            
                            mixedAudioBuffer[destIndex] = mixedAudioBuffer[destIndex] + effectData[effectIndex];
                        }
                    }
                }
                // console.log(`  🎵 帧 ${frameIndex}: 混合 ${soundEntries.length} 个音效`);
            }

            // 获取原始 RGBA 数据（零拷贝引用）
            const rgbaBuffer = canvas.toBufferSync("raw");

            // 创建 Frame
            const frame = Frame.fromVideoBuffer(rgbaBuffer, {
                format: AV_PIX_FMT_RGBA,
                width,
                height,
                pts: BigInt(frameIndex),
                timeBase: { num: 1, den: fps }
            });

            yield frame;

            encodedFrameCount++;

            // 进度报告
            if (frameIndex % 60 === 0) {
                const progress = ((frameIndex / totalFrames) * 100).toFixed(1);
                const elapsed = (performance.now() - startTime) / 1000;
                const fps_current = frameIndex / elapsed;
                console.log(`📊 进度：${progress}% | 已编码：${encodedFrameCount} | 速度：${fps_current.toFixed(1)} fps`);
            }
        }

        // 发送 null 触发编码器刷新
        yield null;
    }

    // 先处理视频编码（串行）
    console.log("🎬 开始编码视频...");
    try {
        for await (const packet of encoder.packets(generateFrames())) {
            if (packet === null) {
                break;
            }
            await using p = packet;
            await mp4Muxer.writePacket(p, videoStreamIndex);
        }
    } catch (err) {
        console.error('视频编码过程中出错:', err);
        throw err;
    }
    encoder.close();
    console.log("✅ 视频编码完成");

    // 处理音频转码（串行）
    console.log("🎵 开始处理音频...");
    try {
        let encodedPacketCount = 0;

        if (audioEncoder && bgmSampleOffset > 0) {
            console.log(`🎵 编码器状态：${audioEncoder ? '✅' : '❌'}, BGM 数据：${bgmSampleOffset} 采样点`);

            // 使用已混合的音频缓冲区（包含 BGM+音效）
            console.log("🎬 编码混合音频...");
            const blockSize = 1024;
            const blockSizeWithChannels = blockSize * targetChannels;
            const totalBlocks = Math.ceil(mixedAudioBuffer.length / blockSizeWithChannels);
            let audioFrameIndex = 0;
            let cumulativeSamples = 0;  // 累积采样数，用于计算正确的 PTS

            for (let blockIndex = 0; blockIndex < totalBlocks; blockIndex++) {
                const start = blockIndex * blockSizeWithChannels;
                const end = Math.min(start + blockSizeWithChannels, mixedAudioBuffer.length);
                const chunk = mixedAudioBuffer.subarray(start, end);

                const actualSamples = Math.ceil(chunk.length / targetChannels);

                // 计算正确的 PTS：基于实际时间和视频帧率同步
                // 音频的时间基准设为 targetSampleRate，PTS 表示从开始的采样数
                const pts = BigInt(cumulativeSamples);  // PTS = 从开始的采样数
                cumulativeSamples += actualSamples;      // 累加实际采样数

                // AAC 编码器需要 FLTP（平面格式），需要将交错数据转换为平面格式
                const channelBuffers = [];
                for (let ch = 0; ch < targetChannels; ch++) {
                    const channelData = new Float32Array(actualSamples);
                    for (let i = 0; i < actualSamples; i++) {
                        channelData[i] = chunk[i * targetChannels + ch];
                    }
                    channelBuffers.push(channelData);
                }

                // 对于 FLTP 格式，需要创建一个包含所有声道数据的单一 Buffer
                // 每个声道的数据连续存放
                const totalBytes = channelBuffers.reduce((sum, buf) => sum + buf.byteLength, 0);
                const combinedBuffer = Buffer.alloc(totalBytes);
                
                let offset = 0;
                for (let ch = 0; ch < targetChannels; ch++) {
                    const channelBytes = channelBuffers[ch].byteLength;
                    combinedBuffer.set(
                        Buffer.from(channelBuffers[ch].buffer, channelBuffers[ch].byteOffset, channelBytes),
                        offset
                    );
                    offset += channelBytes;
                }

                // 创建平面格式的音频帧
                await using frame = Frame.fromAudioBuffer(
                    combinedBuffer,
                    {
                        nbSamples: actualSamples,
                        format: AV_SAMPLE_FMT_FLTP,  // FLTP = 平面浮点格式（AAC 编码器要求）
                        sampleRate: targetSampleRate,
                        channelLayout: targetChannels === 2 ? AV_CHANNEL_LAYOUT_STEREO : AV_CHANNEL_LAYOUT_MONO,
                        pts: pts,
                        timeBase: { num: 1, den: targetSampleRate }  // 音频使用采样率作为时间基准
                    }
                );

                for await (const outPacket of audioEncoder.packets(frame)) {
                    if (outPacket === null) continue;
                    await using p = outPacket;
                    await mp4Muxer.writePacket(p, audioStreamIndex);
                    encodedPacketCount++;
                }

                audioFrameIndex++;

                if (audioFrameIndex % 100 === 0) {
                    console.log(`  📊 音频编码进度：${audioFrameIndex} 帧`);
                }
            }

            // 刷新音频编码器
            console.log(`🎵 刷新音频编码器...`);
            for await (const outPacket of audioEncoder.packets(null)) {
                if (outPacket === null) continue;
                await using p = outPacket;
                await mp4Muxer.writePacket(p, audioStreamIndex);
                encodedPacketCount++;
            }

            console.log(`✅ 音频处理完成：${audioFrameIndex} 帧，${encodedPacketCount} 包`);
        } else {
            // 无法转码，跳过音频
            console.log(`⚠️  跳过音频（编码器不可用或没有 BGM 数据）`);
            if (!audioEncoder) {
                console.log('  原因：audioEncoder 为 null');
            }
            if (bgmSampleOffset === 0) {
                console.log('  原因：bgmSampleOffset = 0 (没有解码到 BGM 数据)');
            }
        }

        // 清理资源
        if (audioDecoder) audioDecoder.close();
        if (audioEncoder) audioEncoder.close();
    } catch (err) {
        console.error('⚠️  音频处理失败:', err);
        if (audioDecoder) audioDecoder.close();
        if (audioEncoder) audioEncoder.close();
        throw err;
    }
    
    // 关闭 mp4 muxer
    console.log("📝 封装 MP4...");
    await mp4Muxer.close();

    // 读取生成的 MP4 文件
    const mp4Buffer = await Bun.file(tempMp4Path).arrayBuffer();
    console.log(`✅ MP4 生成完成：${(mp4Buffer.byteLength / 1024 / 1024).toFixed(2)} MB`);

    // 不再删除临时文件，避免文件占用问题
    console.log(`📁 临时文件保留：${tempMp4Path}`);

    const totalTime = (performance.now() - startTime) / 1000;
    console.log(`✅ 渲染完成！总耗时：${totalTime.toFixed(2)}s | 平均：${(totalFrames/totalTime).toFixed(1)} fps`);

    // 返回标准 mp4
    return {
        out: Buffer.from(mp4Buffer),
        duration: totalTime,
        fps: totalFrames / totalTime
    };
}
