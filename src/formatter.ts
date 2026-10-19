import * as fs from 'fs';
import * as crypto from 'crypto';
import * as path from 'path';
import * as cp from 'child_process';
import * as u from 'util';
import * as temp from 'temp';
import { minimatch } from 'minimatch';
import * as vsc from 'vscode';
import * as logger from './logger';
import * as util from './util';

temp.track();

export default class Formatter implements vsc.DocumentFormattingEditProvider,
    vsc.DocumentRangeFormattingEditProvider,
    vsc.OnTypeFormattingEditProvider {
    private tempDir: string | undefined;

    public provideDocumentFormattingEdits(
        document: vsc.TextDocument,
        options: vsc.FormattingOptions,
        token: vsc.CancellationToken
    ) {
        return this.format(document, null, null, null, options, token);
    }

    public provideDocumentRangeFormattingEdits(
        document: vsc.TextDocument,
        range: vsc.Range,
        options: vsc.FormattingOptions,
        token: vsc.CancellationToken
    ) {
        return this.format(document, range, null, null, options, token);
    }

    public provideOnTypeFormattingEdits(document: vsc.TextDocument,
        position: vsc.Position,
        ch: string,
        options: vsc.FormattingOptions,
        token: vsc.CancellationToken
    ) {
        return this.format(document, null, position, ch, options, token);
    }

    private async format(
        document: vsc.TextDocument,
        range: vsc.Range | null,
        position: vsc.Position | null,
        ch: string | null,
        options: vsc.FormattingOptions,
        token: vsc.CancellationToken
    ): Promise<vsc.TextEdit[]> {
        const config = util.getExtensionConfig(document.uri);
        const useTempFile = config.get('useTempFile');
        let formatRange : vsc.Range;
        let tempFileName: string;

        try {
            // Only format files included by the configuration.
            if (document.uri.scheme !== 'file') {
                return [];
            }

            const filePath = path.resolve(document.uri.fsPath);
            const workspaceFolder = vsc.workspace.getWorkspaceFolder(document.uri);
            const basePath = workspaceFolder?.uri.fsPath ?? path.dirname(filePath);

            const include = config.get<string[]>('include', ['**/*']);
            const exclude = config.get<string[]>('exclude', []);

            const matchesPath = (patterns: string[]): boolean => {
                const relativeFilePath = path.relative(basePath, filePath)
                    .split(path.sep)
                    .join('/');
                return patterns.some(pattern => {
                    // Normalize the pattern to use forward slashes.
                    const normalizedPattern = pattern
                        .replace(/\\/g, '/')
                        .replace(/\/+/g, '/') || '.';
                    logger.dbg(`normalizedPattern:${normalizedPattern} relativeFilePath:${relativeFilePath}`);
                    // Patterns containing glob characters use glob matching.
                    if (/[*?[\]{}()!+@]/.test(normalizedPattern)) {
                        return minimatch(relativeFilePath, normalizedPattern, {dot: true});
                    }

                    // A trailing slash indicates a directory.
                    if (normalizedPattern.endsWith('/')) {
                        return relativeFilePath.startsWith(`${normalizedPattern}`);
                    }

                    // Otherwise, match the exact file path.
                    return relativeFilePath === normalizedPattern;
                });
            };

            // Include is checked first.
            if (!matchesPath(include)) {
                return [];
            }

            // Exclude takes precedence over include.
            if (matchesPath(exclude)) {
                return [];
            }

            formatRange = this.getRange(document, range, position, ch);
            logger.dbg(`formatRange: ${JSON.stringify(formatRange)}`);

            if (useTempFile) {
                if (!this.tempDir) {
                    this.tempDir = await temp.mkdir(`${vsc.env.appName}.uncrustify`);
                    logger.dbg('temporary directory: ' + this.tempDir);
                }
                tempFileName = path.join(this.tempDir,  `${crypto.randomUUID()}-${path.basename(document.fileName)}`);
                logger.dbg('temporary file: ' + tempFileName);
                await u.promisify(fs.writeFile)(tempFileName, document.getText(formatRange));
            }
        } catch (e) {
            logger.dbg('format error: ' + e);
            throw e;
        }

        return await new Promise((resolve, reject) => {
            token.onCancellationRequested(reject);
            const configPath = util.configPath(true);
            logger.dbg('config path: ' + configPath);

            try {
                fs.accessSync(configPath);
            } catch (e) {
                logger.dbg('error accessing config file: ' + e);
                reject(e);
                return;
            }

            const args = ['-l', util.languageMap()[document.languageId], '-c', configPath];
            let output = Buffer.alloc(0);
            let errorOutput = '';

            if (formatRange.start.line !== 0 || formatRange.end.line !== document.lineCount - 1) {
                args.push('--frag');
            }

            // This option helps you if the document saved as UTF8 with BOM, though not able to format it partially.
            if (useTempFile) {
                args.push('--replace');
                args.push('--no-backup');
                args.push(tempFileName);
            }

            const uncrustify = cp.spawn(util.executablePath(), args);
            const text = document.getText(formatRange);
            logger.dbg(`launched: ${util.executablePath()} ${args.join(' ')}`);

            uncrustify.on('error', reject);
            uncrustify.on('exit', async code => {
                logger.dbg('uncrustify exited with status: ' + code);

                if (code === null || code < 0) {
                    vsc.window.showErrorMessage('Uncrustify exited with error code: ' + code);
                    reject(code);
                } else if (useTempFile) {
                    const result = await u.promisify(fs.readFile)(tempFileName);
                    resolve([new vsc.TextEdit(formatRange, result.toString())]);
                }
            });

            uncrustify.stdout.on('data', data => output = Buffer.concat([output, Buffer.from(data)]));
            uncrustify.stdout.on('close', () => {
                if (useTempFile) {
                    return;
                }

                const result = output.toString();

                if (result.length == 0 && text.length > 0) {
                    reject();
                } else {
                    resolve([new vsc.TextEdit(formatRange, result)]);
                }
            });

            uncrustify.stderr.on('data', data => errorOutput += data.toString());
            uncrustify.stderr.on('close', () => logger.dbg('uncrustify exited with error: ' + errorOutput));

            if (!useTempFile) {
                uncrustify.stdin.end(text);
            }
        });
    }

    private getRange(
        document: vsc.TextDocument,
        range: vsc.Range | null,
        position: vsc.Position | null,
        ch: string | null
    ): vsc.Range {
        let startLine: number = 0;
        let endLine: number = document.lineCount - 1;
        if (range !== null) {
            startLine = range.start.line;
            endLine = range.end.line;

            if (range.end.character === 0 && endLine > startLine) {
                endLine--;
            }
        } else if (position !== null && ch !== null) {
            if (ch === ';') {
                startLine = position.line;
                endLine = position.line;
            } else if (ch === '}') {
                startLine = this.findMatchingBraceLine(document, position);
                endLine = position.line;
            }
        }
        return new vsc.Range(startLine, 0, endLine, document.lineAt(endLine).text.length);
    }

    private findMatchingBraceLine(
        document: vsc.TextDocument,
        position: vsc.Position
    ): number {
        let depth = 0;

        for (let line = position.line; line >= 0; line--) {
            const text = document.lineAt(line).text;
            const startChar = line === position.line
                ? position.character
                : text.length - 1;

            for (let character = startChar; character >= 0; character--) {
                const ch = text[character];

                if (ch === '}') {
                    depth++;
                } else if (ch === '{') {
                    depth--;

                    if (depth === 0) {
                        return line;
                    }
                }
            }
        }

        return position.line;
    }
}
