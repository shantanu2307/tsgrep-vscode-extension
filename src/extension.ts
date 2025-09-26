import vscode from 'vscode';
import path from 'path';
import fs from 'fs';

// API
import { search, getQueryCache, getWorkerPool } from 'tsgrep';

// Stores
import objectStore from './ObjectStore';

interface SearchResult {
  file: string;
  line: number;
  content: string;
}

const PREVIEW_PANEL_KEY = 'previewPanel';
const OUTPUT_CHANNEL_KEY = 'outputChannel';
const LAST_QUERY_KEY = 'lastQuery';
const GIT_IGNORE_KEY = 'gitIgnore';
const EXTENIONS_KEY = 'extenstion';
const DIRECTORY_KEY = 'directory';
const IGNORES_KEY = 'ignores';
const QUICK_PICK_KEY = 'quickPick';

const generateCustomFolderPaths = (folders: string[]): string[] => {
  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  const workspacePaths = workspaceFolders.map((wf) => wf.uri.fsPath);

  const finalPaths: string[] = [];

  workspacePaths.forEach((workspacePath) => {
    folders.forEach((folder) => {
      // If folder is absolute, use it directly
      if (path.isAbsolute(folder)) {
        finalPaths.push(folder);
      } else {
        // Otherwise, resolve relative to the workspace folder
        finalPaths.push(path.join(workspacePath, folder));
      }
    });
  });

  // Remove duplicates
  return Array.from(new Set(finalPaths));
};

export function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel('Extension tsgrep Debug');
  objectStore.set<vscode.OutputChannel>(OUTPUT_CHANNEL_KEY, outputChannel);

  const disposable = vscode.commands.registerCommand('tsgrep.search', () => {
    showSearchMenu();
  });

  context.subscriptions.push(disposable);
  context.subscriptions.push(outputChannel);
}

const getSearchResults = async (query: string): Promise<SearchResult[]> => {
  const results: SearchResult[] = [];

  if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
    vscode.window.showErrorMessage('No workspace folder open');
    return results;
  }

  // Read settings
  const ignorePatterns = objectStore.get<string[]>(IGNORES_KEY) ?? [];
  const userDirectories = objectStore.get<string[]>(DIRECTORY_KEY) ?? [];
  const shouldUseGitignore = objectStore.get<boolean>(GIT_IGNORE_KEY) ?? true;
  const extensions = objectStore.get<string[]>(EXTENIONS_KEY) ?? ['js', 'jsx', 'ts', 'tsx'];

  const foldersToSearch =
    userDirectories.length > 0
      ? generateCustomFolderPaths(userDirectories)
      : vscode.workspace.workspaceFolders.map((f) => f.uri.fsPath);

  const searchResults = await search(query, foldersToSearch, {
    gitignore: shouldUseGitignore,
    ignore: ignorePatterns,
    ext: extensions,
  });

  return searchResults;
};

// New function to handle the QuickPick settings menu
async function showSearchMenu() {
  const existingQuickPick = objectStore.get<vscode.QuickPick<vscode.QuickPickItem>>(QUICK_PICK_KEY);
  if (existingQuickPick) {
    existingQuickPick.dispose();
  }
  const quickPick = vscode.window.createQuickPick();
  objectStore.set<vscode.QuickPick<vscode.QuickPickItem>>(QUICK_PICK_KEY, quickPick);

  const updateQuickPickItems = () => {
    const ignores = objectStore.get<string[]>(IGNORES_KEY) ?? [];
    const directories = objectStore.get<string[]>(DIRECTORY_KEY) ?? [];
    const gitIgnore = objectStore.get<boolean>(GIT_IGNORE_KEY) ?? true;
    const extensions = objectStore.get<string[]>(EXTENIONS_KEY) ?? ['js', 'jsx', 'ts', 'tsx'];

    quickPick.items = [
      {
        label: `$(search) Enter Search Query...`,
        description: 'Start a new search with the current settings',
        alwaysShow: true,
      },
      {
        label: `$(git-commit) Git Ignore: ${gitIgnore ? 'on' : 'off'}`,
        description: 'Toggle ignoring files specified in .gitignore',
      },
      {
        label: `$(extensions) Extensions: ${extensions.join(',')}`,
        description: 'Configure file extensions to search',
      },
      {
        label: `$(folder) Directories: ${directories.join(',')}`,
        description: 'Configure custom directory patterns to search',
      },
      {
        label: `$(eye-closed) Ignores: ${ignores.join(',')}`,
        description: 'Configure custom ignore patterns',
      },
    ];
  };

  quickPick.title = 'TSgrep Search Settings';
  quickPick.placeholder = 'Use arrow keys or click to configure search options...';
  quickPick.ignoreFocusOut = true;
  updateQuickPickItems();

  quickPick.onDidAccept(async () => {
    const selectedItem = quickPick.activeItems[0];
    if (!selectedItem) return;

    if (selectedItem.label.includes('Enter Search Query')) {
      // User is ready to search
      const lastQuery = objectStore.get<string>(LAST_QUERY_KEY);
      const query = await vscode.window.showInputBox({
        value: lastQuery,
        placeHolder: 'Enter your search query...',
        prompt: 'Search across workspace files',
        ignoreFocusOut: true,
      });

      if (!query) {
        quickPick.show(); // If user cancels, show the menu again
        return;
      }

      objectStore.set<string>(LAST_QUERY_KEY, query);
      quickPick.hide();

      try {
        const searchResults = await getSearchResults(query);
        if (searchResults.length === 0) {
          vscode.window.showInformationMessage(`No results found for "${query}"`);
          return;
        }
        showResultsQuickPick(searchResults, query);
      } catch (error) {
        const outputChannel = objectStore.get<vscode.OutputChannel>(OUTPUT_CHANNEL_KEY);
        if (outputChannel) {
          outputChannel.appendLine(`Search error: ${error}`);
        }

        vscode.window.showErrorMessage(
          `Search failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else if (selectedItem.label.includes('Git Ignore')) {
      const gitIgnore = objectStore.get<boolean>(GIT_IGNORE_KEY) ?? true;
      const shouldUseGitignore = !gitIgnore;
      objectStore.set<boolean>(GIT_IGNORE_KEY, shouldUseGitignore);
      updateQuickPickItems();
    } else if (selectedItem.label.includes('Extensions')) {
      const extensions = objectStore.get<string[]>(EXTENIONS_KEY) ?? ['js', 'jsx', 'ts', 'tsx'];
      const newExtensions = await vscode.window.showInputBox({
        value: extensions.join(', '),
        placeHolder: 'Enter comma-separated extensions (e.g., js,ts,jsx,tsx)',
        ignoreFocusOut: true,
      });
      if (newExtensions !== undefined) {
        const updatedExtensions = newExtensions.split(',').map((ext) => ext.trim());
        objectStore.set<string[]>(EXTENIONS_KEY, updatedExtensions);
        updateQuickPickItems();
      }
      quickPick.show();
    } else if (selectedItem.label.includes('Directories')) {
      const directories = objectStore.get<string[]>(DIRECTORY_KEY) ?? [];
      const newDirectories = await vscode.window.showInputBox({
        value: directories.join(', '),
        placeHolder: 'Enter comma-separated directories',
        ignoreFocusOut: true,
      });
      if (newDirectories !== undefined) {
        const updatedDirectories = newDirectories.split(',').map((dir) => dir.trim());
        objectStore.set<string[]>(DIRECTORY_KEY, updatedDirectories);
        updateQuickPickItems();
      }
      quickPick.show();
    } else if (selectedItem.label.includes('Ignores')) {
      const ignores = objectStore.get<string[]>(IGNORES_KEY) ?? [];
      const newIgnores = await vscode.window.showInputBox({
        value: ignores.join(', '),
        placeHolder: 'Enter comma-separated glob patterns for ignores',
        ignoreFocusOut: true,
      });
      if (newIgnores !== undefined) {
        const updatedIgnores = newIgnores.split(',').map((ig) => ig.trim());
        objectStore.set<string[]>(IGNORES_KEY, updatedIgnores);
        updateQuickPickItems();
      }
      quickPick.show();
    }
  });

  quickPick.show();
}

function showResultsQuickPick(results: SearchResult[], query: string) {
  const items = results.map((result, index) => {
    const relativePath = vscode.workspace.asRelativePath(result.file);
    const displayContent =
      result.content.length > 100 ? result.content.substring(0, 100) + '...' : result.content;
    return {
      label: `Line ${result.line}: ${displayContent}`,
      description: relativePath,
      detail: `Result ${index + 1} of ${results.length}`,
      result,
    };
  });

  const quickPick = vscode.window.createQuickPick();
  quickPick.items = items;
  quickPick.placeholder = `Search results for "${query}" - Use arrow keys to preview, Enter to navigate`;
  quickPick.matchOnDescription = true;

  quickPick.onDidChangeSelection((selection) => {
    if (selection.length > 0) {
      const selected = selection[0] as any;
      showPreview(selected.result);
    }
  });

  quickPick.onDidAccept(() => {
    const selection = quickPick.activeItems[0] as any;
    if (selection && selection.result) {
      openFileAtLine(selection.result);
      quickPick.hide();
      const previewPanel = objectStore.get<vscode.WebviewPanel>(PREVIEW_PANEL_KEY);
      if (previewPanel) {
        previewPanel.dispose();
        objectStore.delete(PREVIEW_PANEL_KEY);
      }
    }
  });

  quickPick.onDidHide(() => {
    quickPick.dispose();
    const previewPanel = objectStore.get<vscode.WebviewPanel>(PREVIEW_PANEL_KEY);
    if (previewPanel) {
      previewPanel.dispose();
      objectStore.delete(PREVIEW_PANEL_KEY);
    }
  });

  quickPick.show();
}

function showPreview(result: SearchResult) {
  const existingPanel = objectStore.get<vscode.WebviewPanel>(PREVIEW_PANEL_KEY);
  if (existingPanel) {
    existingPanel.dispose();
    objectStore.delete(PREVIEW_PANEL_KEY);
  }

  const panel = vscode.window.createWebviewPanel(
    'searchPreview',
    `Preview: ${path.basename(result.file)}:${result.line}`,
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: false },
  );

  try {
    if (!fs.existsSync(result.file)) {
      panel.webview.html = `<p>File not found: ${result.file}</p>`;
      return;
    }

    const previewContent = escapeHtml(result.content);
    panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Preview</title>
<style>
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background-color: var(--vscode-editor-background); padding: 10px; line-height: 1.4; }
.line { display: flex; white-space: pre-wrap; margin: 2px 0; font-family: var(--vscode-editor-font-family); }
.line-number { color: var(--vscode-descriptionForeground); min-width: 40px; text-align: right; padding-right: 10px; user-select: none; }
.match-line { background-color: var(--vscode-textCodeBlock-background); font-weight: bold; }
.header { margin-bottom: 10px; padding-bottom: 5px; border-bottom: 1px solid var(--vscode-panel-border); }
</style>
</head>
<body>
<div class="header"><h3>${path.basename(result.file)} (Line ${result.line})</h3></div>
<div class="code-preview"><pre>${previewContent}</pre></div>
</body>
</html>`;
  } catch (error) {
    panel.webview.html = `<p>Error loading preview: ${escapeHtml(
      error instanceof Error ? error.message : String(error),
    )}</p>`;
  }

  objectStore.set<vscode.WebviewPanel>(PREVIEW_PANEL_KEY, panel);
  panel.onDidDispose(() => {
    const previewPanel = objectStore.get<vscode.WebviewPanel>(PREVIEW_PANEL_KEY);
    if (previewPanel === panel) objectStore.delete(PREVIEW_PANEL_KEY);
  });
}

function openFileAtLine(result: SearchResult) {
  const openPath = vscode.Uri.file(result.file);

  vscode.workspace.openTextDocument(openPath).then((doc) => {
    vscode.window.showTextDocument(doc).then((editor) => {
      const line = Math.max(0, result.line - 1);
      const range = editor.document.lineAt(line).range;
      editor.selection = new vscode.Selection(range.start, range.end);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);

      const decorationType = vscode.window.createTextEditorDecorationType({
        backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
        isWholeLine: true,
      });

      editor.setDecorations(decorationType, [range]);
      setTimeout(() => decorationType.dispose(), 2000);
    });
  });
}

function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function deactivate() {
  const outputChannel = objectStore.get<vscode.OutputChannel>(OUTPUT_CHANNEL_KEY);
  const workerPool = getWorkerPool();
  const queryCache = getQueryCache();
  const quickPick = objectStore.get<vscode.QuickPick<vscode.QuickPickItem>>(QUICK_PICK_KEY);
  if (quickPick) quickPick.dispose();
  if (outputChannel) outputChannel.dispose();
  workerPool.destroy();
  queryCache.clear();
  objectStore.clear();
}
