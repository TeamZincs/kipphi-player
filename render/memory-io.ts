/**
 * 支持重新打开的内存 IO 实现
 *
 * 设计思路：
 * - 使用分块存储（chunks）管理大文件，避免连续分配大内存
 * - 支持写入、读取、seek、截断等操作
 * - 追踪实际写入大小（totalSize），而非分配的容量
 * - 同步读写位置，支持重新打开文件场景
 *
 * 适用场景：
 * - FFmpeg faststart（需要重新打开文件移动 moov atom）
 * - 需要多次读写同一数据流的场景
 * - 纯内存操作，避免磁盘 I/O
 */

const CHUNK_SIZE = 1024 * 1024; // 1MB chunks

export interface MemoryIO {
    write: (buffer: Buffer) => number;
    read: (buffer: Buffer, offset: number) => number;
    seek: (offset: bigint, whence: number) => bigint;
    toBuffer: () => Buffer;
    truncate?: (size: number) => void;
    reset?: () => void;
}

export class MemoryIOImpl {
    private chunks: Buffer[] = [];
    private writePos: number = 0;
    private readPos: number = 0;
    private totalSize: number = 0;

    /**
     * 写入数据到内存
     */
    write = (buffer: Buffer): number => {
        const buf = Buffer.from(buffer); // 拷贝，避免 FFmpeg 重用
        const startChunk = Math.floor(this.writePos / CHUNK_SIZE);
        const offset = this.writePos % CHUNK_SIZE;

        let written = 0;
        while (written < buf.length) {
            const chunkIdx = startChunk + Math.floor((offset + written) / CHUNK_SIZE);
            const chunkOffset = (offset + written) % CHUNK_SIZE;

            // 扩展 chunks
            while (this.chunks.length <= chunkIdx) {
                this.chunks.push(Buffer.alloc(CHUNK_SIZE));
            }

            const toWrite = Math.min(buf.length - written, CHUNK_SIZE - chunkOffset);
            buf.copy(this.chunks[chunkIdx], chunkOffset, written, written + toWrite);
            written += toWrite;
        }

        this.writePos += buf.length;
        if (this.writePos > this.totalSize) {
            this.totalSize = this.writePos;
        }
        return buf.length;
    };

    /**
     * 从内存读取数据
     */
    read = (buffer: Buffer, offset: number): number => {
        const startChunk = Math.floor(offset / CHUNK_SIZE);
        const chunkOffset = offset % CHUNK_SIZE;
        let read = 0;

        while (read < buffer.length && offset + read < this.totalSize) {
            const chunkIdx = startChunk + Math.floor((chunkOffset + read) / CHUNK_SIZE);
            const currentChunkOffset = (chunkOffset + read) % CHUNK_SIZE;

            if (chunkIdx >= this.chunks.length) break;

            const toRead = Math.min(
                buffer.length - read,
                CHUNK_SIZE - currentChunkOffset,
                this.totalSize - offset - read
            );

            this.chunks[chunkIdx].copy(buffer, read, currentChunkOffset, currentChunkOffset + toRead);
            read += toRead;
        }

        return read;
    };

    /**
     * Seek 操作
     * whence: 0=SEEK_SET, 1=SEEK_CUR, 2=SEEK_END, 0x10000=AVSEEK_SIZE
     */
    seek = (offset: bigint, whence: number): bigint => {
        const off = Number(offset);
        let newPos: number;

        switch (whence) {
            case 0: newPos = off; break;                    // SEEK_SET
            case 1: newPos = this.writePos + off; break;    // SEEK_CUR
            case 2: newPos = this.totalSize + off; break;   // SEEK_END
            case 0x10000: return BigInt(this.totalSize);    // AVSEEK_SIZE
            default: return -1n;
        }

        newPos = Math.max(0, newPos);
        this.writePos = newPos;
        this.readPos = newPos;
        return BigInt(newPos);
    };

    /**
     * 截断文件（faststart 需要）
     */
    truncate = (size: number): void => {
        this.totalSize = size;
        if (this.writePos > size) this.writePos = size;

        // 清理多余的 chunks
        const neededChunks = Math.ceil(size / CHUNK_SIZE);
        this.chunks = this.chunks.slice(0, neededChunks);
    };

    /**
     * 重置读写位置（模拟重新打开文件）
     */
    reset = (): void => {
        this.writePos = 0;
        this.readPos = 0;
        // 数据保留
    };

    /**
     * 导出为 Buffer
     */
    toBuffer = (): Buffer => {
        const result = Buffer.alloc(this.totalSize);
        let offset = 0;
        for (let i = 0; i < this.chunks.length && offset < this.totalSize; i++) {
            const toCopy = Math.min(this.chunks[i].length, this.totalSize - offset);
            this.chunks[i].copy(result, offset, 0, toCopy);
            offset += toCopy;
        }
        return result;
    };

    /**
     * 获取实际大小
     */
    getSize = (): number => {
        return this.totalSize;
    };

    /**
     * 获取当前读写位置
     */
    getPos = (): number => {
        return this.writePos;
    };
}

/**
 * 创建内存 IO 实例（函数式风格）
 */
export function createMemoryIO(): MemoryIO {
    const chunks: Buffer[] = [];
    let writePos = 0;
    let readPos = 0;
    let totalSize = 0;

    return {
        write: (buffer: Buffer) => {
            const buf = Buffer.from(buffer);
            const startChunk = Math.floor(writePos / CHUNK_SIZE);
            const offset = writePos % CHUNK_SIZE;

            let written = 0;
            while (written < buf.length) {
                const chunkIdx = startChunk + Math.floor((offset + written) / CHUNK_SIZE);
                const chunkOffset = (offset + written) % CHUNK_SIZE;

                while (chunks.length <= chunkIdx) {
                    chunks.push(Buffer.alloc(CHUNK_SIZE));
                }

                const toWrite = Math.min(buf.length - written, CHUNK_SIZE - chunkOffset);
                buf.copy(chunks[chunkIdx], chunkOffset, written, written + toWrite);
                written += toWrite;
            }

            writePos += buf.length;
            if (writePos > totalSize) {
                totalSize = writePos;
            }
            return buf.length;
        },

        read: (buffer: Buffer, offset: number) => {
            const startChunk = Math.floor(offset / CHUNK_SIZE);
            const chunkOffset = offset % CHUNK_SIZE;
            let read = 0;

            while (read < buffer.length && offset + read < totalSize) {
                const chunkIdx = startChunk + Math.floor((chunkOffset + read) / CHUNK_SIZE);
                const currentChunkOffset = (chunkOffset + read) % CHUNK_SIZE;

                if (chunkIdx >= chunks.length) break;

                const toRead = Math.min(
                    buffer.length - read,
                    CHUNK_SIZE - currentChunkOffset,
                    totalSize - offset - read
                );

                chunks[chunkIdx].copy(buffer, read, currentChunkOffset, currentChunkOffset + toRead);
                read += toRead;
            }

            return read;
        },

        seek: (offset: bigint, whence: number) => {
            const off = Number(offset);
            let newPos: number;

            switch (whence) {
                case 0: newPos = off; break;
                case 1: newPos = writePos + off; break;
                case 2: newPos = totalSize + off; break;
                case 0x10000: return BigInt(totalSize);
                default: return -1n;
            }

            newPos = Math.max(0, newPos);
            writePos = newPos;
            readPos = newPos;
            return BigInt(newPos);
        },

        toBuffer: () => {
            const result = Buffer.alloc(totalSize);
            let offset = 0;
            for (let i = 0; i < chunks.length && offset < totalSize; i++) {
                const toCopy = Math.min(chunks[i].length, totalSize - offset);
                chunks[i].copy(result, offset, 0, toCopy);
                offset += toCopy;
            }
            return result;
        }
    };
}
