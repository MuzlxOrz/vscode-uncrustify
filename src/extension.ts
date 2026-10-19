import * as fs from 'fs-extra';
import * as cp from 'child_process';
import * as vsc from 'vscode';
import * as logger from './logger';
import * as util from './util';
import Formatter from './formatter';

let extContext: vsc.ExtensionContext;

export function activate(context: vsc.ExtensionContext) {
    logger.dbg('extension started');
    extContext = context;
    util.setGlobalStoragePath(context.globalStorageUri.fsPath);

    const formatter = new Formatter();
    const modes = util.modes();
    context.subscriptions.push(vsc.languages.registerDocumentFormattingEditProvider(modes, formatter));
    context.subscriptions.push(vsc.languages.registerDocumentRangeFormattingEditProvider(modes, formatter));
    context.subscriptions.push(vsc.languages.registerOnTypeFormattingEditProvider(modes, formatter, ';', '}'));
    logger.dbg('registered formatter for modes: ' + modes);

    vsc.commands.registerCommand('uncrustify-plus.create', async () => {
        logger.dbg('command: create');

        const configPath = util.configPath();
        const workspaceInfo = util.getWorkspaceInfo();
        if (!configPath) {
            return;
        }

        if (fs.existsSync(configPath)) {
            const choice = await vsc.window.showQuickPick(
                [ 'Open', 'Upgrade', 'Overwrite', 'Cancel'],
                {
                    title: 'Configuration file already exists.Choose an action',
                    placeHolder: `${workspaceInfo.uri ? 'Workspace' : 'User storage'} config file: ${configPath}`
                }
            );
            if (!choice || choice === 'Cancel') {
                return;
            }
            if (choice === 'Overwrite') {
                await createConfigFile(configPath);
            } else if (choice === 'Upgrade') {
                await upgradeConfigFile(configPath);
            }
        } else {
            await createConfigFile(configPath);
        }

        openConfigFile(configPath);
        return;
    });


    vsc.commands.registerCommand('uncrustify-plus.open', async () => {
        logger.dbg('command: open');

        const configPath = util.configPath();
        const workspaceInfo = util.getWorkspaceInfo();
        if (!configPath) {
            return;
        }

        if (!fs.existsSync(configPath)) {
            const choice = await vsc.window.showQuickPick(
                ['Create', 'Cancel'],
                {
                    title: 'Configuration file does not exist.Choose an action',
                    placeHolder: `${workspaceInfo.uri ? 'Workspace' : 'User storage'} config file: ${configPath}`
                }
            );
            if (choice !== 'Create') {
                return;
            }

            if (!await createConfigFile(configPath)) {
                return;
            }
        }

        openConfigFile(configPath);
        return;
    });

    vsc.commands.registerCommand('uncrustify-plus.upgrade', async () => {
        logger.dbg('command: upgrade');

        const configPath = util.configPath();
        const workspaceInfo = util.getWorkspaceInfo();
        if (!configPath) {
            return;
        }

        if (!fs.existsSync(configPath)) {
            const choice = await vsc.window.showQuickPick(
                ['Create', 'Cancel'],
                {
                    title: 'Configuration file does not exist.Choose an action',
                    placeHolder: `${workspaceInfo.uri ? 'Workspace' : 'User storage'} config file: ${configPath}`
                }
            );
            if (choice !== 'Create') {
                return;
            }

            if (!await createConfigFile(configPath)) {
                return;
            }
        } else {
            if (!await upgradeConfigFile(configPath)) {
                return;
            }
        }
    });
}

export function deactivate() {
    // do nothing
}

async function createConfigFile(configPath: string) : Promise<boolean> {
    try {
        await fs.remove(configPath);
        await fs.ensureFile(configPath);
        return await upgradeConfigFile(configPath);
    } catch (e) {
        logger.dbg('error creating config file: ' + e);
        return false;
    }
}

async function upgradeConfigFile(configPath: string) : Promise<boolean> {
    try {
        let output = '';
        let errorOutput = '';

        const config = await new Promise<string>((resolve, reject) => {
            const child = cp.spawn(util.executablePath(), [
                '-c', configPath,
                '--update-config-with-doc'
            ]);
            child.stdout
                .on('data', data => output += data.toString());
            child.stderr
                .on('data', data => errorOutput += data.toString());
            child
                .on('error', reject)
                .on('close', () => {
                    if (errorOutput.length > 0) {
                        reject(new Error(errorOutput));
                        return;
                    }
                    resolve(output.replace(/\?\?\?:.*/g, ''));
                });
        });

        if (config.length > 0) {
            await fs.writeFile(configPath, config);
        } else {
            throw new Error('Empty configuration output');
        }

        return true;
    } catch (e) {
        logger.dbg('error upgrading config file: ' + e);

        vsc.window.showErrorMessage(`Configuration could not be upgraded. Check whether Uncrustify is correctly installed and configured.`);
        return false;
    }
}

function openConfigFile(configPath: string) {
    vsc.commands.executeCommand('vscode.open', vsc.Uri.file(configPath));
}

