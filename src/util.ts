import * as path from 'path';
import * as fs from 'fs';
import * as vsc from 'vscode';

const DEFAULT_CONFIG_FILE_NAME = 'uncrustify.cfg';
const DEFAULT_PATH = 'uncrustify';
const DEFAULT_MODES = [
    'c',
    'cpp',
    'csharp',
    'd',
    'java',
    'objective-c',
    'pawn',
    'pde',
    'vala'
];
const DEFAULT_LANGUAGE_MAP: Record<string, string> = {
    c: 'C',
    cpp: 'CPP',
    csharp: 'CS',
    d: 'D',
    java: 'JAVA',
    'objective-c': 'OC',
    pawn: 'PAWN',
    pde: 'JAVA',
    vala: 'VALA'
};
const SUPPORTED_PLATFORM_NAMES = {
    'linux': '.linux',
    'darwin': '.osx',
    'win32': '.windows'
};
let globalStoragePath: string = 'C:';

interface WorkspaceInfo {
    uri: vsc.Uri | undefined;
    languageId: string | undefined;
}

class ExtensionConfig {
    private readonly section = 'uncrustify-plus';
    private readonly config: vsc.WorkspaceConfiguration;
    private readonly workspaceUri?: vsc.Uri;

    constructor(folderUri?: vsc.Uri) {
        this.workspaceUri = getWorkspaceInfo().uri;
        this.config = vsc.workspace.getConfiguration(this.section, folderUri ?? this.workspaceUri);
    }

    get<T>(section: string): T | undefined;
    get<T>(section: string, defaultValue: T): T;
    
    get<T>(section: string, defaultValue?: T): T | undefined {
        if (this.workspaceUri || section === 'debug') {
            return defaultValue === undefined
                ? this.config.get<T>(section)
                : this.config.get<T>(section, defaultValue);
        }

        const inspected = this.config.inspect<T>(section);
        return inspected?.globalValue ?? inspected?.defaultValue ?? defaultValue;
    }
}

/**
 * Retrieves the uncrustify language settings.
 *
 * @return Array of default language modes and any configured overrides.
 */
export function modes() : Array<string> {
    const config = getExtensionConfig();
    const overrides = config.get<Record<string, unknown>>('langOverrides', {});

    return DEFAULT_MODES.concat(Object.getOwnPropertyNames(overrides));
}

/**
 * Builds the mapping from language IDs to uncrustify language names.
 * Reads the configuration on every call; built-in defaults are never mutated.
 *
 * @returns The merged language map.
 */
export function languageMap() : Record<string, string> {
    const config = getExtensionConfig();
    const overrides = config.get<Record<string, string>>('langOverrides', {});

    return { ...DEFAULT_LANGUAGE_MAP, ...overrides };
}

/**
 * Retrieves the configured path to the `uncrustify` configuration file.
 *
 * @return An absolute path to an `uncrustify` configuration file.
 */
export function configPath(checkExists: boolean = false) : string {
    const workspaceInfo = getWorkspaceInfo();
    const config = getExtensionConfig(workspaceInfo.uri);

    // get the default configuration path
    const defaultConfigPath = config.get<string>(`configPath${getPlatformSuffix()}`, DEFAULT_CONFIG_FILE_NAME);

    // override the configuration path for the current language
    const configPathOverrides = config.get<Record<string, string>>('configPathOverrides', {});
    const paths = workspaceInfo.languageId && configPathOverrides[workspaceInfo.languageId]
        ? [configPathOverrides[workspaceInfo.languageId], defaultConfigPath]
        : [defaultConfigPath];

    for (const [i, originalPath] of paths.entries()) {
        let p = originalPath;
        // interpret environment variables: %Var% or $Var
        p = p.replace(/(%\w+%)|(\$\w+)/g, variable => {
            return process.env[variable.startsWith('%') ? variable.slice(1, -1) : variable.slice(1)] ?? variable;
        });

        // interpret ${workspaceFolder} variable
        p = p.replace(/\$\{workspaceFolder\}/, () => {
            return workspaceInfo.uri?.fsPath ?? '${workspaceFolder}';
        });

        // interpret ${workspaceFolder:<folder>} variables
        p = p.replace(/\$\{workspaceFolder:(.*?)\}/, (_, name) => {
            return vsc.workspace.workspaceFolders?.find(wf => wf.name == name)?.uri.fsPath ?? '${workspaceFolder:${name}}';
        });

        // prefix relative paths with the detected workspace folder
        if (!path.isAbsolute(p)) {
            p = path.join(workspaceInfo.uri?.fsPath ?? globalStoragePath, p);
        }

        // check whether the configuration file exists
        if (i === paths.length - 1) {
            return p;
        }
        if (!checkExists || fs.existsSync(p) ) {
            return p;
        }
    }
    return defaultConfigPath;
}

/**
 * Retrieves the configured `uncrustify` executable path.
 *
 * @return The path or name of the `uncrustify` executable.
 */
export function executablePath() : string {
    const config = getExtensionConfig();

    return config.get<string>(`executablePath${getPlatformSuffix()}`, DEFAULT_PATH);
}

/**
 * Gets workspace information based on the currently open documents.
 *
 * Determines the workspace folder and language ID from the active editor
 * or visible editors. If no editor belongs to a workspace, falls back to
 * the first workspace folder.
 *
 * @returns The workspace URI and language ID, or undefined values if no
 *          workspace is available.
 */
export function getWorkspaceInfo() : WorkspaceInfo {
    const textEditors = [vsc.window.activeTextEditor];
    textEditors.push(...vsc.window.visibleTextEditors);
    // if there is a document open in the editor, use its workspace folder
    for (const textEditor of textEditors.filter((e) : e is vsc.TextEditor => !!e)) {
        return { uri: vsc.workspace.getWorkspaceFolder(textEditor.document.uri)?.uri,
            languageId: textEditor.document.languageId };
    }

    const workspaces = vsc.workspace.workspaceFolders || [];
    if (workspaces.length === 0) {
        return { uri: undefined, languageId: undefined };
    }
    return { uri: workspaces[0].uri, languageId: undefined };
}

/**
 * Retrieves the extension configuration object for the `uncrustify` extension
 *
 * @param folderUri A scope for which the configuration is asked for.
 *
 * @return The `uncrustify` extension configuration object
 */
export function getExtensionConfig(folderUri?: vsc.Uri) {
    return new ExtensionConfig(folderUri);
}

/**
 * Retrieves the configuration suffix for the current platform
 *
 * @param platform The platform to retrieve the platform suffix for
 *
 * @return The platform configuration suffix
 */
export function getPlatformSuffix(platform?: string) : string {
    return (SUPPORTED_PLATFORM_NAMES as Record<string, string>)[platform ?? process.platform] ?? (platform ? `.${platform}` : '');
}

/**
 * Sets the global storage path for the extension.
 * @param path The global storage path to set.
 */
export function setGlobalStoragePath(path: string) {
    globalStoragePath = path;
}