import vscode from 'vscode';
import path from 'path';
import fs from 'fs';

// API
import { search } from 'tsgrep/dist';

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

  const disposable = vscode.commands.registerCommand('tsgrep.search', async () => {
    const lastQuery = objectStore.get<string>(LAST_QUERY_KEY);

    const query = await vscode.window.showInputBox({
      value: lastQuery, // Set the initial value
      placeHolder: 'Enter your search query...',
      prompt: 'Search across workspace files',
      ignoreFocusOut: true,
    });

    if (!query) return;

    objectStore.set<string>(LAST_QUERY_KEY, query);

    try {
      const searchResults = await getSearchResults(query);
      if (searchResults.length === 0) {
        vscode.window.showInformationMessage(`No results found for "${query}"`);
        return;
      }
      showResultsQuickPick(searchResults, query);
    } catch (error) {
      outputChannel.appendLine(`Search error: ${error}`);
      vscode.window.showErrorMessage(
        `Search failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  context.subscriptions.push(disposable);
  context.subscriptions.push(outputChannel);
}

const readContent = (file: string, line: number): string => {
  if (!fs.existsSync(file)) return '';
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');
  if (line < 1 || line > lines.length) return '';
  return lines[line - 1].trim();
};

const getSearchResults = async (query: string): Promise<SearchResult[]> => {
  const results: SearchResult[] = [];

  if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
    vscode.window.showErrorMessage('No workspace folder open');
    return results;
  }

  // Read settings
  const config = vscode.workspace.getConfiguration('tsgrep');
  const ignorePatterns = config.get<string[]>('ignorePatterns') ?? [];
  const shouldUseGitignore = config.get<boolean>('gitignore') ?? true;
  const extensions = config.get<string[]>('extensions') || ['js', 'ts', 'jsx', 'tsx'];
  const userDirectories = config.get<string[]>('directories') || [];

  const foldersToSearch =
    userDirectories.length > 0
      ? generateCustomFolderPaths(userDirectories)
      : vscode.workspace.workspaceFolders.map((f) => f.uri.fsPath);

  const cache: Record<string, Set<number>> = {};

  for (const folderPath of foldersToSearch) {
    const searchResults = await search(query, folderPath, {
      gitignore: shouldUseGitignore,
      ignore: ignorePatterns,
      ext: extensions,
    });

    for (const result of searchResults) {
      const content = readContent(result.file, result.line);
      cache[result.file] ??= new Set<number>();
      if (!cache[result.file].has(result.line)) {
        results.push({ file: result.file, line: result.line, content });
        cache[result.file].add(result.line);
      }
    }
  }

  return results;
};

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
  if (outputChannel) outputChannel.dispose();
  objectStore.clear();
}
