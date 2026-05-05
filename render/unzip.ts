import yauzl from 'yauzl';

export interface ZipEntry {
    path: string;
    content: Buffer;
}

export interface UnzipOptions {
    maxFiles?: number;
    maxEntrySize?: number;
    maxTotalSize?: number;
}

interface ZipCacheEntry {
    entries: Map<string, yauzl.Entry>;
    zipfile: yauzl.ZipFile;
}

/**
 * 防zip炸弹配置
 */
const DEFAULT_OPTIONS: Required<UnzipOptions> = {
    maxFiles: 200,
    maxEntrySize: 128 * 1024 * 1024, // 100MB per file
    maxTotalSize: 128 * 1024 * 1024, // 1GB total
};

/**
 * zip缓存，避免重复解析同一个buffer
 */
const zipCache = new WeakMap<Buffer, ZipCacheEntry>();

/**
 * ZipReader类：缓存解析结果，支持多次提取
 */
export class ZipReader {
    private cacheEntry: ZipCacheEntry | null = null;
    private opts: Required<UnzipOptions>;

    constructor(
        private buffer: Buffer,
        options: UnzipOptions = {}
    ) {
        this.opts = { ...DEFAULT_OPTIONS, ...options };

        // 检查缓存
        if (zipCache.has(buffer)) {
            this.cacheEntry = zipCache.get(buffer)!;
        }
    }

    /**
     * 初始化（如果没缓存则解析zip结构）
     */
    private async init(): Promise<void> {
        if (this.cacheEntry) return;

        return new Promise((resolve, reject) => {
            const entries = new Map<string, yauzl.Entry>();
            let fileCount = 0;

            yauzl.fromBuffer(this.buffer, {
                validateEntrySizes: true,
                lazyEntries: false,
            }, (err, zipfile) => {
                if (err) return reject(err);
                if (!zipfile) return reject(new Error('Invalid zip file'));

                zipfile.on('entry', (entry) => {
                    fileCount++;
                    if (fileCount > this.opts.maxFiles) {
                        zipfile.close();
                        return reject(new Error(`Too many files (limit: ${this.opts.maxFiles})`));
                    }

                    if (!entry.isDirectory) {
                        entries.set(entry.fileName, entry);
                    }
                });

                zipfile.on('end', () => {
                    this.cacheEntry = { entries, zipfile };
                    zipCache.set(this.buffer, this.cacheEntry);
                    resolve();
                });

                zipfile.on('error', reject);
            });
        });
    }

    /**
     * 获取文件列表
     */
    async listFiles(): Promise<string[]> {
        await this.init();
        return Array.from(this.cacheEntry!.entries.keys());
    }

    /**
     * 提取单个文件（复用缓存的zipfile）
     */
    async extractFile(filePath: string): Promise<Buffer | null> {
        await this.init();

        const entry = this.cacheEntry!.entries.get(filePath);
        if (!entry) return null;

        // 检查压缩比
        const compressionRatio = entry.compressedSize > 0
            ? entry.uncompressedSize / entry.compressedSize
            : 1;

        if (compressionRatio > 1000) {
            throw new Error(`Zip bomb detected: suspicious compression ratio`);
        }

        // 检查大小
        if (entry.uncompressedSize > this.opts.maxEntrySize) {
            throw new Error(`File too large: ${filePath}`);
        }

        return new Promise((resolve, reject) => {
            this.cacheEntry!.zipfile.openReadStream(entry, (err, readStream) => {
                if (err) return reject(err);

                const chunks: Buffer[] = [];

                readStream!.on('data', (chunk: Buffer) => {
                    //console.log(chunk.length)
                    chunks.push(chunk);
                });

                readStream!.on('end', () => {
                    console.log("Completed")
                    resolve(Buffer.concat(chunks));
                });

                readStream!.on('error', reject);
            });
        });
    }

    /**
     * 提取多个文件
     */
    async extractFiles(filePaths: string[]): Promise<Map<string, Buffer>> {
        const result = new Map<string, Buffer>();
        let totalSize = 0;

        await this.init();

        for (const filePath of filePaths) {
            const entry = this.cacheEntry!.entries.get(filePath);
            if (!entry) continue;

            if (entry.uncompressedSize > this.opts.maxEntrySize) {
                throw new Error(`File too large: ${filePath}`);
            }

            if (totalSize + entry.uncompressedSize > this.opts.maxTotalSize) {
                throw new Error(`Total size exceeded`);
            }

            const content = await this.extractFile(filePath);
            if (content) {
                result.set(filePath, content);
                totalSize += content.length;
            }
        }

        return result;
    }

    /**
     * 解压所有文件
     */
    async extractAll(): Promise<ZipEntry[]> {
        await this.init();

        const results: ZipEntry[] = [];
        let totalSize = 0;

        for (const [path, entry] of this.cacheEntry!.entries) {
            if (totalSize + entry.uncompressedSize > this.opts.maxTotalSize) {
                throw new Error(`Total size exceeded`);
            }

            const content = await this.extractFile(path);
            if (content) {
                results.push({ path, content });
                totalSize += content.length;
            }
        }

        return results;
    }

}


