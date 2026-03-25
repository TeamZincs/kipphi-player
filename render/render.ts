

import { Canvas, FontLibrary, Window } from "skia-canvas";
import { Demuxer, Decoder, Encoder } from "node-av/api";
import { AVMEDIA_TYPE_AUDIO, AV_SAMPLE_FMT_FLTP, AV_CHANNEL_LAYOUT_STEREO, AV_CHANNEL_LAYOUT_MONO, FF_ENCODER_AAC } from "node-av/constants";
import { Frame } from "node-av/lib";
import { Muxer, HardwareContext } from "node-av/api";
import { FF_ENCODER_LIBX264, AV_PIX_FMT_RGBA } from "node-av/constants";

import { Player } from "./player";
import { Images } from "./image"
import { Chart } from "kipphi";
import { AudioProcessor } from "./audioProcessor";
import { Respack } from "./respack";
import { readFile } from "fs/promises";



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
    width = 1600,
    range?: [number, number]
): Promise<{
    out: Buffer;
    duration: number;
    fps: number;
}> {
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
        loadPromises.push(audioProcessor.loadSoundEffect('tap', await readFile('./assets/tap.mp3')));
        loadPromises.push(audioProcessor.loadSoundEffect('flick', await readFile('./assets/flick.mp3')));
        loadPromises.push(audioProcessor.loadSoundEffect('drag', await readFile('./assets/drag.mp3')));

        await Promise.all(loadPromises);
        audioProcessor.init();
        console.log(`✅ 音效加载完成`);
    } catch (err) {
        console.error(`⚠️  音效加载失败:`, err);
    }

    // 初始化 canvas 和 player
    const canvas = new Canvas(width, height);
    const illustration = await Images.loadImage(illustrationBlobOrBuffer);
    const player = new Player(canvas, audioProcessor, illustration, respack);
    player.greenLine = -1;
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
            r: `${fps}`,            // 帧率
            crf: '18',
            qp: '18',
            bf: '0',              // 禁用B帧，确保解码顺序=显示顺序，避免画面抖动
            // 输出 Annex B 格式（MPEG-TS 需要的格式）
            h264_profile: 'high',
            h264_level: '41',
        }
    });

    // ========== 临时文件方案 ==========
    const fs = await import('fs');
    const path = await import('path');
    const { execSync } = await import('child_process');

    const outputDir = path.join(process.cwd(), 'test_output');
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    // 使用固定的临时文件名（Node.js 单线程，无竞争）
    const tempPath = path.join(outputDir, '.temp_output.mp4');
    const finalPath = path.join(outputDir, 'output.mp4');

    // 先写入临时文件（不使用 faststart）
    const mp4Muxer = await Muxer.open(tempPath, {
        format: "mp4"
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

    // 开始渲染流水线
    const startTime = performance.now();

    // 音频配置
    const targetSampleRate = 44100;
    const targetChannels = 2;
    
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

    // ========== 同时编码视频和音频 ==========
    console.log("🎬 开始同时编码视频和音频到 MP4...");

    async function* generateMixedFrames() {
        // 视频参数
        const videoFrameCount = totalFrames;

        // 音频参数
        const blockSize = 1024;
        const blockSizeWithChannels = blockSize * targetChannels;
        const totalAudioBlocks = Math.ceil(mixedAudioBuffer.length / blockSizeWithChannels);

        let videoFrameIndex = 0;
        let audioBlockIndex = 0;
        let audioCumulativeSamples = 0;

        const startTime = performance.now();

        // 交替产生视频帧和音频帧
        while (videoFrameIndex < videoFrameCount || audioBlockIndex < totalAudioBlocks) {
        // 生成视频帧
        if (videoFrameIndex < videoFrameCount) {
            const currentTime = left + videoFrameIndex / fps;
            
            // 更新播放器状态
            player.audioCurrentTime = currentTime;
            player.render();

            // 在渲染时消费该时间点的音效条目
            const frameStartTime = currentTime;
            const frameEndTime = left + (videoFrameIndex + 1) / fps;
            
            // 获取并消费该时间段内的音效
            const soundEntries = audioProcessor.getSoundEffects();
            if (soundEntries.length > 0) {
                //console.log(`[Render] Frame ${videoFrameIndex}: Got ${soundEntries.length} sound entries, time=${currentTime.toFixed(3)}`);
                
                // 计算该帧对应的音频采样范围
                const startSample = Math.floor(frameStartTime * targetSampleRate) * targetChannels;
                
                // 混入音效
                for (const entry of soundEntries) {
                    const sound = audioProcessor.getSoundEffect(entry.type);
                    if (!sound) continue;

                    const effectData = sound.data;
                    const effectChannels = sound.channels;
                    const effectSampleRate = sound.sampleRate;
                    const effectSamplesPerChannel = Math.floor(effectData.length / effectChannels);

                    // 使用已跟踪的混入采样数，避免浮点误差和重复混入
                    let effectSampleOffset = entry.mixedSamples ?? 0;

                    // 只混入剩余的样本（音效已结束则 samplesRemaining <= 0）
                    const samplesRemaining = effectSamplesPerChannel - effectSampleOffset;
                    if (samplesRemaining <= 0) {
                        // 音效已结束，跳过
                        continue;
                    }

                    // 将音效采样率下的样本数转换为目标采样率下的样本数
                    const targetSamplesRemaining = Math.floor(samplesRemaining * targetSampleRate / effectSampleRate);
                    
                    // 计算该帧可用的采样数
                    const startSampleInFrame = startSample;
                    const availableSamples = Math.floor((mixedAudioBuffer.length - startSampleInFrame) / targetChannels);

                    // 计算实际要混入的样本数
                    const samplesToMix = Math.min(targetSamplesRemaining, availableSamples);
                    if (samplesToMix <= 0) {
                        continue;
                    }

                    // 交错格式混入：需要按目标采样率读取音效数据
                    const VOLUME_SCALE = 0.5; // 音效音量衰减系数，防止多音效叠加导致削波

                    for (let i = 0; i < samplesToMix; i++) {
                        // 计算在音效原始数据中的位置（需要按比例采样）
                        const effectPos = effectSampleOffset + (i * effectSampleRate / targetSampleRate);
                        const effectSampleIndex = Math.floor(effectPos);
                        const effectSampleFrac = effectPos - effectSampleIndex;

                        for (let ch = 0; ch < targetChannels && ch < effectChannels; ch++) {
                            const destIndex = startSampleInFrame + i * targetChannels + ch;

                            // 使用线性插值获取更平滑的采样值
                            const effectIndex0 = effectSampleIndex * effectChannels + ch;
                            const effectIndex1 = (effectSampleIndex + 1) * effectChannels + ch;

                            let sampleValue: number;
                            if (effectIndex1 < effectData.length) {
                                // 线性插值
                                const s0 = effectData[effectIndex0];
                                const s1 = effectData[effectIndex1];
                                sampleValue = s0 + (s1 - s0) * effectSampleFrac;
                            } else {
                                // 边界处使用最近邻
                                sampleValue = effectData[effectIndex0];
                            }

                            // 应用音量衰减并叠加
                            mixedAudioBuffer[destIndex] += sampleValue * VOLUME_SCALE;

                            // 限制输出范围防止削波
                            mixedAudioBuffer[destIndex] = Math.max(-1, Math.min(1, mixedAudioBuffer[destIndex]));
                        }
                    }

                    // 更新已混入的采样数（防止重复混入）
                    const mixedInSamples = Math.floor(samplesToMix * effectSampleRate / targetSampleRate);
                    entry.mixedSamples = (entry.mixedSamples ?? 0) + mixedInSamples;
                }
            }

            // 获取原始 RGBA 数据（零拷贝引用）
            const rgbaBuffer = canvas.toBufferSync("raw");

            // 创建 Frame - 使用时间戳而不是帧索引
            // 视频 PTS = (视频帧索引 * 音频采样率 / fps)
            // 这样视频和音频使用相同的时间基准（1/44100）
            const videoPTS = Math.floor(videoFrameIndex * targetSampleRate / fps);
            const frame = Frame.fromVideoBuffer(rgbaBuffer, {
                format: AV_PIX_FMT_RGBA,
                width,
                height,
                pts: BigInt(videoPTS),
                timeBase: { num: 1, den: targetSampleRate }
            });

            const progress = ((videoFrameIndex / videoFrameCount) * 100).toFixed(1);
            const elapsed = (performance.now() - startTime) / 1000;
            const fps_current = videoFrameIndex / elapsed;

            if (videoFrameIndex % 60 === 0) {
                console.log(`📊 进度：${progress}% | 已编码：${videoFrameIndex} | 速度：${fps_current.toFixed(1)} fps`);
            }

            yield { type: 'video', frame };
            videoFrameIndex++;
        }

            // 生成音频帧（确保不超前于视频渲染进度）
            // 音频块每块 1024 采样点，约 23.2ms，视频每帧 16.67ms
            // 音频块生成进度必须与视频帧进度匹配，避免读取未混入音效的数据
            const audioBlocksPerVideo = 7 / 5;
            
            // 计算当前视频进度允许生成的最大音频块索引
            // 确保音频块不会"跑太快"，读取到尚未混入音效的区域
            const videoTime = left + videoFrameIndex / fps;
            const maxAudioBlockIndex = Math.floor(videoTime * targetSampleRate / blockSize);
            
            // 限制音频块生成数量不超过视频进度
            const allowedAudioBlocks = Math.min(
                Math.floor(audioBlocksPerVideo),
                Math.max(0, maxAudioBlockIndex - audioBlockIndex)
            );

            for (let i = 0; i < allowedAudioBlocks && audioBlockIndex < totalAudioBlocks; i++) {
                const start = audioBlockIndex * blockSizeWithChannels;
                const end = Math.min(start + blockSizeWithChannels, mixedAudioBuffer.length);
                const chunk = mixedAudioBuffer.subarray(start, end);

                const actualSamples = Math.ceil(chunk.length / targetChannels);

                const pts = BigInt(audioCumulativeSamples);
                audioCumulativeSamples += actualSamples;

                const channelBuffers = [];
                for (let ch = 0; ch < targetChannels; ch++) {
                    const channelData = new Float32Array(actualSamples);
                    for (let j = 0; j < actualSamples; j++) {
                        channelData[j] = chunk[j * targetChannels + ch];
                    }
                    channelBuffers.push(channelData);
                }

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

                const audioFrame = Frame.fromAudioBuffer(
                    combinedBuffer,
                    {
                        nbSamples: actualSamples,
                        format: AV_SAMPLE_FMT_FLTP,
                        sampleRate: targetSampleRate,
                        channelLayout: targetChannels === 2 ? AV_CHANNEL_LAYOUT_STEREO : AV_CHANNEL_LAYOUT_MONO,
                        pts: pts,
                        timeBase: { num: 1, den: targetSampleRate }
                    }
                );

                yield { type: 'audio', frame: audioFrame };
                audioBlockIndex++;
            }
        }

        // 发送 EOF
        yield { type: 'video', frame: null };
        yield { type: 'audio', frame: null };
    }

    let encodedPacketCount = 0;

    try {
        for await (const item of generateMixedFrames()) {
            if (item.type === 'video') {
                for await (const packet of encoder.packets(item.frame)) {
                    if (packet === null) break;
                    await using p = packet;
                    await mp4Muxer.writePacket(p, videoStreamIndex);
                    encodedPacketCount++;
                }
            } else {
                if (audioEncoder && item.frame !== null) {
                    for await (const packet of audioEncoder.packets(item.frame)) {
                        if (packet === null) continue;
                        await using p = packet;
                        await mp4Muxer.writePacket(p, audioStreamIndex);
                        encodedPacketCount++;
                    }
                }
            }
        }

        // 刷新编码器
        console.log("🔄 刷新视频编码器...");
        for await (const packet of encoder.packets(null)) {
            if (packet === null) break;
            await using p = packet;
            await mp4Muxer.writePacket(p, videoStreamIndex);
        }

        if (audioEncoder) {
            console.log("🔄 刷新音频编码器...");
            for await (const packet of audioEncoder.packets(null)) {
                if (packet === null) continue;
                await using p = packet;
                await mp4Muxer.writePacket(p, audioStreamIndex);
            }
        }

        console.log(`✅ 编码完成，共 ${encodedPacketCount} 个包`);
    } catch (err) {
        console.error('编码过程中出错:', err);
        throw err;
    }

    encoder.close();
    if (audioEncoder) audioEncoder.close();

    // ========== 关闭 MP4 Muxer ==========
    console.log("📝 完成 MP4 封装...");
    await mp4Muxer.close();

    // ========== 使用 FFmpeg 处理 faststart ==========
    console.log("🔄 使用 FFmpeg 处理 faststart (移动 moov atom 到开头)...");
    try {
        execSync(`ffmpeg -y -i "${tempPath}" -c copy -movflags faststart "${finalPath}"`, { stdio: 'inherit' });
        console.log(`✅ faststart 处理完成`);
    } catch (err) {
        console.error(`⚠️  FFmpeg faststart 处理失败，使用原始文件:`, err);
        // 如果 FFmpeg 处理失败，直接重命名临时文件
        if (fs.existsSync(tempPath)) {
            fs.renameSync(tempPath, finalPath);
        }
    }

    // 清理临时文件
    if (fs.existsSync(tempPath)) {
        try {
            fs.unlinkSync(tempPath);
        } catch (e) {
            // 忽略清理错误
        }
    }

    // 读取最终文件到内存
    const mp4Buffer = fs.readFileSync(finalPath);
    console.log(`💾 最终输出: ${finalPath} (${(mp4Buffer.byteLength / 1024 / 1024).toFixed(2)} MB)`);

    const totalTime = (performance.now() - startTime) / 1000;
    console.log(`✅ 渲染完成！总耗时：${totalTime.toFixed(2)}s | 平均：${(totalFrames/totalTime).toFixed(1)} fps`);

    // 返回标准 mp4
    return {
        out: Buffer.from(mp4Buffer),
        duration: totalTime,
        fps: totalFrames / totalTime
    };
}

export async function dryRunRender(
    chart: Chart,
    illustrationBlobOrBuffer: Blob | Buffer,
    textureFetcher: (name: string) => Promise<Buffer>,
    audioBuffer: Buffer,
    range?: [number, number]
) {
    const canvas = new Canvas(1350, 900);
    
    // 初始化音频处理器
    const audioProcessor = new AudioProcessor();

    // 加载音效（tap 和 hold 使用同一音效）
    console.log("🔊 加载音效...");
    try {
        const loadPromises: Promise<void>[] = [];
        loadPromises.push(audioProcessor.loadSoundEffect('tap', await readFile('./assets/tap.mp3')));
        loadPromises.push(audioProcessor.loadSoundEffect('flick', await readFile('./assets/flick.mp3')));
        loadPromises.push(audioProcessor.loadSoundEffect('drag', await readFile('./assets/drag.mp3')));

        await Promise.all(loadPromises);
        audioProcessor.init();
        console.log(`✅ 音效加载完成`);
    } catch (err) {
        console.error(`⚠️  音效加载失败:`, err);
    }
    const player = new Player(canvas, audioProcessor, await Respack.loadImage(illustrationBlobOrBuffer as Buffer),
        respack);
    audioProcessor.linkPlayer(player);
    player.receive(chart, async (str) => await Respack.loadImage(await textureFetcher(str)));
    const fps = 60;
    const frames = Math.ceil(fps * (range ? range[1] : chart.duration));
    const firstFrame = fps * (range ? range[0] : 0);
    const delta = frames - firstFrame;
    let lastTime = performance.now();
    const startTime = performance.now();
    console.log("starting dry run", firstFrame, frames)
    for (let i = firstFrame; i < frames; i++) {
        player.audioCurrentTime = i / fps;
        player.render();
        if (i % 100 === 99) {
            console.log(`Progress: ${Math.round(i / delta * 100)}%, Rendering speed: ${(100 / ((performance.now() - lastTime) / 1000)).toFixed(1)} fps`);
            console.log("Memory usage:", process.memoryUsage())
            lastTime = performance.now();
        }
    }
    console.log("dry run finished, total time:", (performance.now() - startTime) / 1000, "s")
}

