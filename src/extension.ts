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

export function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel('Extension tsgrep Debug');
  objectStore.set<vscode.OutputChannel>(OUTPUT_CHANNEL_KEY, outputChannel);

  const disposable = vscode.commands.registerCommand('tsgrep.search', async () => {
    const query = await vscode.window.showInputBox({
      placeHolder: 'Enter your search query...',
      prompt: 'Search across workspace files',
      ignoreFocusOut: true,
    });

    if (!query) {
      return;
    }

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
  if (!fs.existsSync(file)) {
    return '';
  }
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');
  const totalLines = lines.length;
  if (line < 1 || line > totalLines) {
    return '';
  }
  const contentLines = lines[line - 1];
  return contentLines.trim();
};

const getSearchResults = async (query: string): Promise<SearchResult[]> => {
  const results: SearchResult[] = [];

  if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
    vscode.window.showErrorMessage('No workspace folder open');
    return results;
  }

  const cache: Record<string, Set<number>> = {};
  for (const folder of vscode.workspace.workspaceFolders) {
    // the folder path to search in
    const folderPath = folder.uri.fsPath;

    // respect gitignore for each folder.
    const searchResults = await search(query, folderPath, {
      gitignore: true,
    });

    for (const result of searchResults) {
      const content = readContent(result.file, result.line);
      cache[result.file] ??= new Set<number>();
      if (!cache[result.file].has(result.line)) {
        results.push({
          file: result.file,
          line: result.line,
          content: content,
        });
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

  // Handle selection change for preview
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
  const previewPanel = objectStore.get<vscode.WebviewPanel>(PREVIEW_PANEL_KEY);
  if (previewPanel) {
    previewPanel.dispose();
    objectStore.delete(PREVIEW_PANEL_KEY);
  }
  const panel = vscode.window.createWebviewPanel(
    'searchPreview',
    `Preview: ${path.basename(result.file)}:${result.line}`,
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: false,
    },
  );

  try {
    if (!fs.existsSync(result.file)) {
      panel.webview.html = `<p>File not found: ${result.file}</p>`;
      return;
    }
    const previewContent = result.content;
    panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Preview</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            padding: 10px;
            line-height: 1.4;
        }
        .line {
            display: flex;
            white-space: pre-wrap;
            margin: 2px 0;
            font-family: var(--vscode-editor-font-family);
        }
        .line-number {
            color: var(--vscode-descriptionForeground);
            min-width: 40px;
            text-align: right;
            padding-right: 10px;
            user-select: none;
        }
        .match-line {
            background-color: var(--vscode-textCodeBlock-background);
            font-weight: bold;
        }
        .header {
            margin-bottom: 10px;
            padding-bottom: 5px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
    </style>
</head>
<body>
    <div class="header">
        <h3>${path.basename(result.file)} (Line ${result.line})</h3>
    </div>
    <div class="code-preview">${previewContent}</div>
</body>
</html>`;
  } catch (error) {
    panel.webview.html = `<p>Error loading preview: ${escapeHtml(
      error instanceof Error ? error.message : String(error),
    )}</p>`;
  }

  // Update the panel reference
  objectStore.set<vscode.WebviewPanel>(PREVIEW_PANEL_KEY, panel);

  // Handle panel disposal
  panel.onDidDispose(() => {
    const previewPanel = objectStore.get<vscode.WebviewPanel>(PREVIEW_PANEL_KEY);
    if (previewPanel === panel) {
      objectStore.delete(PREVIEW_PANEL_KEY);
    }
  });
}

// Open file at specific line
function openFileAtLine(result: SearchResult) {
  const openPath = vscode.Uri.file(result.file);

  vscode.workspace.openTextDocument(openPath).then((doc) => {
    vscode.window.showTextDocument(doc).then((editor) => {
      // Reveal the line and select it
      const line = Math.max(0, result.line - 1); // Convert to 0-based index
      const range = editor.document.lineAt(line).range;
      editor.selection = new vscode.Selection(range.start, range.end);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);

      // Add highlight to the line
      const decorationType = vscode.window.createTextEditorDecorationType({
        backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
        isWholeLine: true,
      });

      editor.setDecorations(decorationType, [range]);

      // Remove highlight after 2 seconds
      setTimeout(() => {
        decorationType.dispose();
      }, 2000);
    });
  });
}

// Helper function to escape HTML
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
  if (outputChannel) {
    outputChannel.dispose();
  }
  objectStore.clear();
}
