import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

function processFile(content: string): string {
    // 先处理 /* #node { ... } */ 注释块
    // 使用正则匹配多行注释，提取内部内容
    content = content.replace(/\/\*\s*#node\s*\{([\s\S]*?)\}\s*\*\//g, (match, innerContent) => {
        // 返回注释内的内容
        return innerContent.trim();
    });

    // 再处理 //#default ... //#enddefault 块（按行处理，因为可能是多行）
    const lines = content.split('\n');
    const result: string[] = [];
    let i = 0;
    let inDefaultBlock = false;

    while (i < lines.length) {
        const trimmed = lines[i].trim();

        // 检查是否是 //#default 开始标记
        if (trimmed.startsWith('//') && trimmed.includes('#default')) {
            inDefaultBlock = true;
            i++;
            continue;
        }

        // 检查是否是 //#enddefault 结束标记
        if (trimmed.startsWith('//') && trimmed.includes('#enddefault')) {
            inDefaultBlock = false;
            i++;
            continue;
        }

        // 如果在 default 块中，跳过
        if (inDefaultBlock) {
            i++;
            continue;
        }

        // 普通行，保留
        result.push(lines[i]);
        i++;
    }

    return result.join('\n');
}

export function buildFile(inputFile: string): void {
    console.log(`Processing: ${inputFile}`);

    const sourceContent = readFileSync(inputFile, 'utf-8');
    const processedContent = processFile(sourceContent);

    const OUTPUT_DIR = join(__dirname, '../render');
    if (!existsSync(OUTPUT_DIR)) {
        mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    const fileName = inputFile.split('/').pop() || inputFile.split('\\').pop() || 'output.ts';
    const outputFile = join(OUTPUT_DIR, fileName);
    writeFileSync(outputFile, processedContent, 'utf-8');

    console.log(`✓ Output: ${outputFile}`);
}


if (import.meta.main) {

    const args = process.argv.slice(2);

    if (args.length === 0) {
        console.log('Usage: ts-node build/buildNode.ts <input-file>');
        console.log('Example: ts-node build/buildNode.ts player.ts');
        process.exit(1);
    }

    buildFile(args[0]);
}
