import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as https from "https";
import { execSync } from "child_process";
import { ObsidianClient } from "./client";
import { EditorWatcher } from "./watcher";
import { PreviewPanel } from "./preview";
import { EditorDecorator } from "./decorator";
import { WikilinkHoverProvider } from "./hover";
import { WikilinkLinkProvider } from "./linkProvider";
import { WikilinkCompletionProvider } from "./completionProvider";
import { ImgurUploadHandler } from "./imgur";
import { logger, Logger } from "./logger";

/**
 * Protocol version — increment this when there's a breaking change in the
 * WebSocket message format between the Obsidian plugin and the Cursor extension.
 */
const PROTOCOL_VERSION = 2;
const GITHUB_RELEASES_URL = "https://github.com/px39n/obs_cursor/releases";

function getProtocolMismatchHtml(obsProtocol: number, cursorProtocol: number): string {
  return `<div style="margin-top:20px;padding:12px;border:1px solid #f0ad4e;border-radius:6px;background:#fff3cd;color:#856404;font-size:13px;">
    <strong>Protocol Mismatch</strong><br>
    Obsidian plugin protocol: <code>v${obsProtocol}</code> &nbsp;|&nbsp; Cursor extension protocol: <code>v${cursorProtocol}</code><br>
    Please update both plugins to the latest version.<br>
    <a href="${GITHUB_RELEASES_URL}" style="color:#0d6efd;">Download latest from GitHub</a>
  </div>`;
}

let client: ObsidianClient;
let watcher: EditorWatcher;
let decorator: EditorDecorator;
let hoverProvider: WikilinkHoverProvider;
let linkProvider: WikilinkLinkProvider;
let completionProvider: WikilinkCompletionProvider;
let imgurHandler: ImgurUploadHandler;
let hoverProviderDisposable: vscode.Disposable | undefined;
let linkProviderDisposable: vscode.Disposable | undefined;
let completionProviderDisposable: vscode.Disposable | undefined;
let previewPanel: PreviewPanel | undefined;
const backStack: string[] = [];
const forwardStack: string[] = [];

export function activate(context: vscode.ExtensionContext): void {
  const config = vscode.workspace.getConfiguration("obsidianPreview");
  const port = config.get<number>("port") ?? 27123;

  client = new ObsidianClient(port);
  watcher = new EditorWatcher();
  decorator = new EditorDecorator();
  hoverProvider = new WikilinkHoverProvider();
  linkProvider = new WikilinkLinkProvider();
  completionProvider = new WikilinkCompletionProvider();
  imgurHandler = new ImgurUploadHandler(client);
  
  // Register hover provider for markdown files
  hoverProviderDisposable = vscode.languages.registerHoverProvider(
    { language: "markdown" },
    hoverProvider
  );
  context.subscriptions.push(hoverProviderDisposable);
  
  // Register link provider for Ctrl+Click navigation
  linkProviderDisposable = vscode.languages.registerDocumentLinkProvider(
    { language: "markdown" },
    linkProvider
  );
  context.subscriptions.push(linkProviderDisposable);

  // Register completion provider for [[wikilinks]]
  completionProviderDisposable = vscode.languages.registerCompletionItemProvider(
    { language: "markdown" },
    completionProvider,
    "[" // Trigger on [
  );
  context.subscriptions.push(completionProviderDisposable);

  // Handle render updates (pushed from server)
  client.onRenderUpdate((response) => {
    if (previewPanel && response.filePath) {
      const fileName = response.filePath.split(/[/\\]/).pop()?.replace(/\.md$/i, '') || '';
      previewPanel.updateContent(response.html, response.css, fileName);
      logger.debug(`Render update applied for: ${fileName}`);
    }
  });

  // Command: Connect to Obsidian
  const connectCommand = vscode.commands.registerCommand(
    "obsidian-preview.connect",
    async () => {
      try {
        await client.connect();
        vscode.window.showInformationMessage("Connected to Obsidian");
        // Enable editor decorations and hover provider when connected
        decorator.enable();
        hoverProvider.enable();
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to connect: ${err}`);
      }
    }
  );

  // Handle disconnection - disable decorations and hover
  client.onDisconnect(() => {
    decorator.disable();
    hoverProvider.disable();
  });

  // Command: Open preview panel
  const openCommand = vscode.commands.registerCommand(
    "obsidian-preview.open",
    async () => {
      await openPreviewPanel(context, false);
    }
  );

  // Command: Open debug preview panel
  const openDebugCommand = vscode.commands.registerCommand(
    "obsidian-preview.openDebug",
    async () => {
      await openPreviewPanel(context, true);
    }
  );

  // Command: Open log file
  const openLogCommand = vscode.commands.registerCommand(
    "obsidian-preview.openLog",
    async () => {
      const logPath = Logger.getLogFilePath();
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(logPath));
        await vscode.window.showTextDocument(doc);
      } catch {
        vscode.window.showWarningMessage(`Log file not found: ${logPath}`);
      }
    }
  );

  // Command: Clear log file
  const clearLogCommand = vscode.commands.registerCommand(
    "obsidian-preview.clearLog",
    () => {
      Logger.clearLog();
      vscode.window.showInformationMessage("Log file cleared");
    }
  );

  // Command: Navigate to wikilink (used by DocumentLinkProvider)
  const navigateToLinkCommand = vscode.commands.registerCommand(
    "obsidian-preview.navigateToLink",
    async (args: { target: string; sourcePath: string }) => {
      await navigateToWikilink(args.target, args.sourcePath);
    }
  );

  // Command: Upload image to Imgur (file picker)
  const uploadImgurCommand = vscode.commands.registerCommand(
    "obsidian-preview.uploadToImgur",
    async () => {
      if (!client.isConnected()) {
        try {
          await client.connect();
        } catch (err) {
          vscode.window.showErrorMessage(`Not connected to Obsidian: ${err}`);
          return;
        }
      }
      
      await imgurHandler.initialize();
      if (!imgurHandler.isAvailable()) {
        vscode.window.showWarningMessage(
          "Imgur not available. Make sure Obsidian Imgur plugin is installed and configured."
        );
        return;
      }
      
      await imgurHandler.insertImageLink();
    }
  );

  // Command: Paste image from clipboard → Imgur (Ctrl+Shift+V)
  const pasteImgurCommand = vscode.commands.registerCommand(
    "obsidian-preview.pasteImageToImgur",
    async () => {
      if (!client.isConnected()) {
        try {
          await client.connect();
        } catch (err) {
          // Fall back to normal paste
          await vscode.commands.executeCommand("editor.action.clipboardPasteAction");
          return;
        }
      }
      
      await imgurHandler.pasteImageFromClipboard();
    }
  );

  async function openPreviewPanel(ctx: vscode.ExtensionContext, debugMode: boolean) {
    // Capture the document to render BEFORE any async operations
    // Try: activeTextEditor → visibleTextEditors → active tab (Custom Editor like vditor)
    let initialDocument: vscode.TextDocument | undefined;
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor?.document.languageId === "markdown") {
      initialDocument = activeEditor.document;
    } else {
      const mdEditor = vscode.window.visibleTextEditors.find(e => e.document.languageId === "markdown");
      if (mdEditor) {
        initialDocument = mdEditor.document;
      } else {
        // Fallback: check active tab (handles Custom Editors like Office Viewer / vditor)
        const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
        const tabInput = activeTab?.input;
        if (tabInput && (tabInput instanceof vscode.TabInputText || tabInput instanceof vscode.TabInputCustom)) {
          if (tabInput.uri.fsPath.endsWith('.md')) {
            try {
              initialDocument = await vscode.workspace.openTextDocument(tabInput.uri);
            } catch {
              // Ignore — file may not be accessible
            }
          }
        }
      }
    }

    // Create panel first so we can show error in it
    if (previewPanel) {
      previewPanel.dispose();
    }
    backStack.length = 0;
    forwardStack.length = 0;
    const panel = PreviewPanel.create(ctx.extensionUri, debugMode);
    previewPanel = panel;
    
    // Handle panel dispose
    panel.onDispose(() => {
      if (previewPanel === panel) {
        previewPanel = undefined;
      }
    });

    // Handle link clicks
    previewPanel.onLinkClick(async (targetPath) => {
      await handleLinkClick(targetPath);
    });

    // Handle hover preview requests
    previewPanel.onHoverPreview(async (targetPath) => {
      return await getHoverPreview(targetPath);
    });

    // Handle back button click
    previewPanel.onNavigateBack(async () => {
      if (backStack.length === 0) return;

      const currentPath = previewPanel?.getCurrentFilePath();
      if (currentPath) {
        forwardStack.push(currentPath);
      }

      const prevPath = backStack.pop()!;
      previewPanel?.setCanGoBack(backStack.length > 0);
      previewPanel?.setCanGoForward(forwardStack.length > 0);

      try {
        const doc = await vscode.workspace.openTextDocument(prevPath);
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
        // Preview will update via onDidChangeActiveTextEditor
      } catch (err) {
        console.error("[Preview] Navigate back failed:", err);
      }
    });

    // Handle forward button click
    previewPanel.onNavigateForward(async () => {
      if (forwardStack.length === 0) return;

      const currentPath = previewPanel?.getCurrentFilePath();
      if (currentPath) {
        backStack.push(currentPath);
      }

      const nextPath = forwardStack.pop()!;
      previewPanel?.setCanGoBack(backStack.length > 0);
      previewPanel?.setCanGoForward(forwardStack.length > 0);

      try {
        const doc = await vscode.workspace.openTextDocument(nextPath);
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
        // Preview will update via onDidChangeActiveTextEditor
      } catch (err) {
        console.error("[Preview] Navigate forward failed:", err);
      }
    });

    // Handle "bring Obsidian to front" button click
    previewPanel.onFocusObsidian(async () => {
      logger.info("Focus Obsidian window requested");
      if (client.isConnected()) {
        await client.focusWindow();
      }
    });

    // Handle refresh button click
    previewPanel.onRefresh(async () => {
      logger.info("Refresh requested - restarting server");
      try {
        await client.restart();
        // Re-render current file
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document.languageId === "markdown") {
          await updatePreview(editor.document);
        }
      } catch (err) {
        logger.error(`Refresh failed: ${err}`);
        vscode.window.showErrorMessage(`Refresh failed: ${err}`);
      }
    });

    if (!client.isConnected()) {
      // First attempt to connect
      let connected = false;
      try {
        await client.connect();
        connected = true;
      } catch {
        // Connection failed — try to auto-launch Obsidian
        connected = await tryAutoLaunchObsidian();
      }

      if (!connected) {
        return; // Error already shown in preview by tryAutoLaunchObsidian
      }

      // Enable editor decorations and hover when connected
      decorator.enable();
      hoverProvider.enable();
    }

    // Protocol compatibility check
    const obsProtocol = client.getObsidianProtocolVersion();
    
    if (obsProtocol !== 0 && obsProtocol !== PROTOCOL_VERSION) {
      // Block preview — incompatible protocol
      previewPanel.updateContent(
        `<div style="text-align:center;padding:40px;">
          <h2 style="color:#d32f2f;">Protocol Incompatible</h2>
          <p style="color:#666;margin:20px 0;">
            Obsidian plugin protocol: <code>v${obsProtocol}</code><br>
            Cursor extension protocol: <code>v${PROTOCOL_VERSION}</code>
          </p>
          <p style="color:#666;">The Obsidian plugin and Cursor extension use different communication protocols. Please update both to the latest version.</p>
          <a href="${GITHUB_RELEASES_URL}" style="display:inline-block;margin-top:16px;padding:10px 24px;background:#0d6efd;color:#fff;border-radius:6px;text-decoration:none;font-weight:bold;">Download Latest Version</a>
        </div>`,
        ""
      );
      return;
    }

    // Initial render — use the document captured at the start (before auto-launch delay)
    await sleep(500);
    const docToRender = initialDocument
      ?? (vscode.window.activeTextEditor?.document.languageId === "markdown" ? vscode.window.activeTextEditor.document : undefined)
      ?? vscode.window.visibleTextEditors.find(e => e.document.languageId === "markdown")?.document;
    logger.info(`Initial render: doc=${docToRender?.uri.fsPath ?? 'none'}, connected=${client.isConnected()}`);
    if (docToRender) {
      await updatePreview(docToRender);
    }
  }

  // Watch for content changes
  watcher.onContentChange(async (filePath, content) => {
    if (previewPanel && client.isConnected()) {
      const fileName = filePath.split(/[/\\]/).pop() || '';
      logger.debug(`Render request for: ${fileName}`);
      try {
        const result = await renderDocumentContent(filePath, content);
        // Extract filename without extension for title
        const titleName = fileName.replace(/\.md$/i, '');
        previewPanel.updateContent(result.html, result.css, titleName);
        logger.debug(`Render complete for: ${fileName}`);
      } catch (err) {
        const errorMsg = String(err);
        const titleName = fileName.replace(/\.md$/i, '');
        logger.error(`Render failed for ${fileName}: ${errorMsg}`);
        const obsProto = client.getObsidianProtocolVersion();
        const protoHint = (obsProto !== 0 && obsProto !== PROTOCOL_VERSION)
          ? getProtocolMismatchHtml(obsProto, PROTOCOL_VERSION) : "";
        previewPanel.updateContent(
          `<div style="color:red;padding:20px;">Render failed: ${err}</div>${protoHint}
           <div style="text-align:center;margin-top:16px;">
             <p style="color:#999;font-size:12px;">Rendering may fail if Obsidian is in the background and being throttled by the OS.</p>
             <button onclick="vscode.postMessage({type:'focusObsidian'})" style="margin-top:8px;padding:8px 16px;background:#0d6efd;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;">Bring Obsidian to Front</button>
           </div>`,
          "",
          titleName
        );
      }
    }
  });
  watcher.start();

  // Watch for active editor changes
  const editorChangeDisposable = vscode.window.onDidChangeActiveTextEditor(
    async (editor) => {
      if (
        previewPanel &&
        editor &&
        editor.document.languageId === "markdown"
      ) {
        const currentPath = editor.document.uri.fsPath;
        
        if (currentPath === previewPanel.getCurrentFilePath()) return;

        const fileName = currentPath.split(/[/\\]/).pop()?.replace(/\.md$/i, '') || '';
        previewPanel.showLoading(fileName);
        await updatePreview(editor.document);
      }
    }
  );

  // Command: Open Obsidian vault
  const openObsidianCommand = vscode.commands.registerCommand(
    "obsidian-preview.openObsidian",
    async () => {
      await openObsidianVault();
    }
  );

  // Command: Update vault path
  const updateVaultPathCommand = vscode.commands.registerCommand(
    "obsidian-preview.updateVaultPath",
    async () => {
      await selectAndStoreVault(true); // force re-detect
    }
  );

  // Command: Update Obsidian plugin
  const updatePluginCommand = vscode.commands.registerCommand(
    "obsidian-preview.updateObsidianPlugin",
    async () => {
      const config = vscode.workspace.getConfiguration("obsidianPreview");
      let vaultPath = config.get<string>("vaultPath");
      if (!vaultPath) {
        vaultPath = await selectAndStoreVault();
      }
      if (vaultPath) {
        await checkAndUpdateObsidianPlugin(vaultPath);
      }
    }
  );

  context.subscriptions.push(
    connectCommand,
    openCommand,
    openDebugCommand,
    openLogCommand,
    clearLogCommand,
    navigateToLinkCommand,
    uploadImgurCommand,
    pasteImgurCommand,
    editorChangeDisposable,
    openObsidianCommand,
    updateVaultPathCommand,
    updatePluginCommand
  );

  // Auto-detect vault on activation if not stored
  autoDetectVault();

  logger.info("Extension activated");
}

async function renderDocumentContent(filePath: string, content: string): Promise<{ html: string; css: string }> {
  // Pre-convert markdown `![alt](data:image/...)` to HTML `<img src="..." alt="...">`
  const contentWithHtmlImages = content.replace(
    /!\[([^\]]*)\]\((data:image\/[a-zA-Z0-9+-]+;base64,[a-zA-Z0-9+/=]+)\)/g,
    (match, alt, dataUri) => `<img src="${dataUri}" alt="${alt}" />`
  );

  // Swap base64 data URIs with short placeholders before sending over WebSocket
  const dataUriMap = new Map<string, string>();
  let placeholderCount = 0;

  const sanitizedContent = contentWithHtmlImages.replace(
    /data:image\/[a-zA-Z0-9+-]+;base64,[a-zA-Z0-9+/=]+/g,
    (dataUri) => {
      const key = `__DATA_URI_PLACEHOLDER_${placeholderCount++}__`;
      dataUriMap.set(key, dataUri);
      return key;
    }
  );

  // Send lightweight content over WebSocket
  const result = await client.render(filePath, sanitizedContent);

  // Restore original base64 image strings into the rendered HTML
  let finalHtml = result.html;
  dataUriMap.forEach((dataUri, key) => {
    const found = finalHtml.includes(key);
    if (found) {
      const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      finalHtml = finalHtml.replace(new RegExp(escapedKey, 'g'), () => dataUri);
      const stillHasKey = finalHtml.includes(key);
    }
  });

  return { html: finalHtml, css: result.css };
}

async function updatePreview(document: vscode.TextDocument): Promise<void> {
  if (!previewPanel || !client.isConnected()) return;

  const filePath = document.uri.fsPath;
  previewPanel.setCurrentFilePath(filePath);
  const content = document.getText();
  // Extract filename without extension for title
  const fileName = filePath.split(/[/\\]/).pop()?.replace(/\.md$/i, '') || '';

  try {
    const result = await renderDocumentContent(filePath, content);
    previewPanel.updateContent(result.html, result.css, fileName);
  } catch (err) {
    console.error("[Preview] Render failed:", err);
    const obsProto = client.getObsidianProtocolVersion();
    const protoHint = (obsProto !== 0 && obsProto !== PROTOCOL_VERSION)
      ? getProtocolMismatchHtml(obsProto, PROTOCOL_VERSION) : "";
    previewPanel.updateContent(
      `<div style="color:red;padding:20px;">Render failed: ${err}</div>${protoHint}
       <div style="text-align:center;margin-top:16px;">
         <p style="color:#999;font-size:12px;">Rendering may fail if Obsidian is in the background and being throttled by the OS.</p>
         <button onclick="vscode.postMessage({type:'focusObsidian'})" style="margin-top:8px;padding:8px 16px;background:#0d6efd;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;">Bring Obsidian to Front</button>
       </div>`,
      "",
      fileName
    );
  }
}

async function getHoverPreview(targetPath: string): Promise<{ html: string; css: string } | null> {
  if (!client.isConnected()) return null;
  
  // Skip same-file anchors (e.g., "#Heading")
  if (targetPath.startsWith("#")) {
    return null;
  }
  
  try {
    // Parse the link - handle [[File#Heading]] format
    let filePart = targetPath;
    const hashIndex = targetPath.indexOf("#");
    if (hashIndex !== -1) {
      filePart = targetPath.substring(0, hashIndex);
    }
    
    // Add .md extension if not present
    let searchPath = filePart;
    if (!searchPath.endsWith(".md")) {
      searchPath = searchPath + ".md";
    }
    
    // Find the file
    let files = await vscode.workspace.findFiles(`**/${searchPath}`);
    if (files.length === 0) {
      const filename = searchPath.split("/").pop() || searchPath;
      files = await vscode.workspace.findFiles(`**/${filename}`);
    }
    
    if (files.length === 0) {
      return { html: `<p><em>File not found: ${targetPath}</em></p>`, css: "" };
    }
    
    // Read file content
    const doc = await vscode.workspace.openTextDocument(files[0]);
    const content = doc.getText();
    
    // Get first 50 lines for preview
    const lines = content.split("\n").slice(0, 50);
    const previewContent = lines.join("\n");
    
    // Render through Obsidian
    const result = await client.render(files[0].fsPath, previewContent);
    return result;
  } catch (err) {
    console.error("[Preview] Hover preview failed:", err);
    return null;
  }
}

/**
 * Navigate to a wikilink target, with option to create file if not found.
 * @param targetPath The link target (e.g., "File", "File#Heading", "Folder/File")
 * @param sourcePath The path of the source file containing the link
 */
async function navigateToWikilink(targetPath: string, sourcePath?: string): Promise<void> {
  if (!targetPath) return;

  console.log("[Navigate] target:", targetPath, "source:", sourcePath);

  // Parse the link - handle [[File#Heading]] format
  let filePart = targetPath;
  let anchorPart = "";
  
  const hashIndex = targetPath.indexOf("#");
  if (hashIndex !== -1) {
    filePart = targetPath.substring(0, hashIndex);
    anchorPart = targetPath.substring(hashIndex + 1);
  }
  
  // If only anchor (e.g., "#Code"), it's a link within the same file
  if (!filePart && anchorPart) {
    await navigateToAnchor(anchorPart);
    return;
  }
  
  // Add .md extension if not present
  let searchPath = filePart;
  if (!searchPath.endsWith(".md")) {
    searchPath = searchPath + ".md";
  }

  // Try to find the file
  let files = await vscode.workspace.findFiles(`**/${searchPath}`);
  
  // If not found, try without path (just filename)
  if (files.length === 0) {
    const filename = searchPath.split("/").pop() || searchPath;
    files = await vscode.workspace.findFiles(`**/${filename}`);
  }

  if (files.length > 0) {
    // File found - open it
    const doc = await vscode.workspace.openTextDocument(files[0]);
    const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
    
    // If there's an anchor, navigate to it
    if (anchorPart) {
      await navigateToAnchorInEditor(editor, anchorPart);
    }
  } else {
    // File not found - ask to create
    await promptCreateFile(searchPath, sourcePath);
  }
}

/**
 * Navigate to an anchor in the current editor.
 */
async function navigateToAnchor(anchor: string): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  
  await navigateToAnchorInEditor(editor, anchor);
}

/**
 * Navigate to an anchor (heading) in the given editor.
 */
async function navigateToAnchorInEditor(editor: vscode.TextEditor, anchor: string): Promise<void> {
  const doc = editor.document;
  const text = doc.getText();
  const lines = text.split("\n");
  
  const anchorLower = anchor.toLowerCase().replace(/-/g, " ");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headingMatch = line.match(/^#+\s+(.+)$/);
    if (headingMatch) {
      const headingText = headingMatch[1].toLowerCase().trim();
      if (headingText === anchorLower || headingText.replace(/\s+/g, "-") === anchor.toLowerCase()) {
        const position = new vscode.Position(i, 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.AtTop);
        break;
      }
    }
  }
}

/**
 * Prompt user to create a new file when link target doesn't exist.
 */
async function promptCreateFile(fileName: string, sourcePath?: string): Promise<void> {
  const choice = await vscode.window.showWarningMessage(
    `File "${fileName}" does not exist. Create it?`,
    "Yes",
    "No"
  );
  
  if (choice !== "Yes") return;
  
  // Determine target directory (same as source file, or workspace root)
  let targetDir: string;
  if (sourcePath) {
    targetDir = path.dirname(sourcePath);
  } else {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      vscode.window.showErrorMessage("No workspace folder open");
      return;
    }
    targetDir = workspaceFolder.uri.fsPath;
  }
  
  const newFilePath = path.join(targetDir, fileName);
  
  // Create the file with a basic template
  const fileNameWithoutExt = fileName.replace(/\.md$/, "");
  const content = `# ${fileNameWithoutExt}\n\n`;
  
  try {
    fs.writeFileSync(newFilePath, content, "utf8");
    const doc = await vscode.workspace.openTextDocument(newFilePath);
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
    vscode.window.showInformationMessage(`Created: ${fileName}`);
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to create file: ${err}`);
  }
}

async function handleLinkClick(targetPath: string): Promise<void> {
  const sourcePath = previewPanel?.getCurrentFilePath()
    || vscode.window.activeTextEditor?.document.uri.fsPath
    || vscode.window.visibleTextEditors.find(e => e.document.languageId === "markdown")?.document.uri.fsPath;

  if (sourcePath) {
    backStack.push(sourcePath);
    forwardStack.length = 0; // Clear forward history when following a new link
    previewPanel?.setCanGoBack(true);
    previewPanel?.setCanGoForward(false);
  }
  
  // Use shared navigation logic
  await navigateToWikilink(targetPath, sourcePath);
}

// ─── Auto-Launch Obsidian ───

/**
 * Generate a styled status HTML block for the preview panel.
 * Shows a step indicator with icon, title, subtitle, and optional detail.
 */
function statusHtml(icon: string, title: string, subtitle: string, detail?: string, showFocusButton?: boolean): string {
  const focusBtn = showFocusButton
    ? `<button onclick="vscode.postMessage({type:'focusObsidian'})" style="margin-top:16px;padding:8px 16px;background:#0d6efd;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;">Bring Obsidian to Front</button>`
    : "";
  return `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:#888;">
    <div style="font-size:32px;margin-bottom:16px;">${icon}</div>
    <div style="font-size:16px;font-weight:600;margin-bottom:8px;">${title}</div>
    <div style="font-size:13px;color:#aaa;">${subtitle}</div>
    ${detail ? `<div style="margin-top:20px;font-size:12px;color:#bbb;">${detail}</div>` : ""}
    ${focusBtn}
  </div>`;
}

/**
 * Generate a styled error HTML block for the preview panel.
 */
function errorHtml(title: string, message: string, hint?: string): string {
  return `<div style="text-align:center;padding:40px;">
    <h2 style="color:#d32f2f;">${title}</h2>
    <p style="color:#666;margin:20px 0;">${message}</p>
    ${hint ? `<p style="color:#999;font-size:12px;">${hint}</p>` : ""}
  </div>`;
}

/**
 * Check if Obsidian is currently running (Windows only).
 */
function isObsidianRunning(): boolean {
  try {
    const output = execSync('tasklist /FI "IMAGENAME eq Obsidian.exe" /NH', {
      encoding: "utf8",
      windowsHide: true,
    });
    return output.toLowerCase().includes("obsidian.exe");
  } catch {
    return false;
  }
}

/**
 * Kill all Obsidian processes (Windows only).
 * Returns true if kill was attempted.
 */
function killObsidian(): boolean {
  try {
    execSync("taskkill /F /IM Obsidian.exe", {
      encoding: "utf8",
      windowsHide: true,
    });
    logger.info("Obsidian processes killed");
    return true;
  } catch {
    // Process may not exist or already exited
    return false;
  }
}

/**
 * Check if the Obsidian plugin files (main.js, manifest.json) exist in the vault.
 */
function isPluginInstalled(vaultPath: string): boolean {
  const pluginDir = path.join(vaultPath, ".obsidian", "plugins", PLUGIN_FOLDER_NAME);
  const mainJs = path.join(pluginDir, "main.js");
  const manifest = path.join(pluginDir, "manifest.json");
  return fs.existsSync(mainJs) && fs.existsSync(manifest);
}

/**
 * Check if the plugin is enabled in community-plugins.json.
 */
function isPluginEnabled(vaultPath: string): boolean {
  const cpPath = path.join(vaultPath, ".obsidian", "community-plugins.json");
  if (!fs.existsSync(cpPath)) return false;
  try {
    const list: string[] = JSON.parse(fs.readFileSync(cpPath, "utf8"));
    return Array.isArray(list) && list.includes(PLUGIN_FOLDER_NAME);
  } catch {
    return false;
  }
}

/**
 * Enable the plugin by adding its ID to community-plugins.json.
 * Creates the file if it doesn't exist.
 * Should only be called when Obsidian is NOT running to avoid conflicts.
 */
function enablePluginInConfig(vaultPath: string): boolean {
  const cpPath = path.join(vaultPath, ".obsidian", "community-plugins.json");
  try {
    let list: string[] = [];
    if (fs.existsSync(cpPath)) {
      const raw = fs.readFileSync(cpPath, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        list = parsed;
      }
    }
    if (!list.includes(PLUGIN_FOLDER_NAME)) {
      list.push(PLUGIN_FOLDER_NAME);
      fs.writeFileSync(cpPath, JSON.stringify(list, null, 2), "utf8");
      logger.info(`Plugin "${PLUGIN_FOLDER_NAME}" added to community-plugins.json`);
    }
    return true;
  } catch (err) {
    logger.error(`Failed to enable plugin in config: ${err}`);
    return false;
  }
}

/**
 * Try to launch Obsidian and wait for the WebSocket connection.
 * Shows staged progress in the preview panel:
 *   1. Detect/validate vault
 *   2. Check if plugin is installed → if not, close Obsidian, install, enable
 *   3. Check if plugin is enabled → if not, close Obsidian, enable
 *   4. Launch Obsidian
 *   5. Wait for WebSocket connection
 *   6. On success, refresh preview with rendered content
 */
async function tryAutoLaunchObsidian(): Promise<boolean> {
  if (!previewPanel) return false;

  const config = vscode.workspace.getConfiguration("obsidianPreview");
  let vaultPath = config.get<string>("vaultPath");

  // ── Step 1: Detect / validate vault ──
  const detectedVaults = detectVaults();

  if (!vaultPath) {
    // No stored vault — auto-detect
    if (detectedVaults.length === 1) {
      vaultPath = detectedVaults[0];
      await config.update("vaultPath", vaultPath, vscode.ConfigurationTarget.Global);
    } else if (detectedVaults.length > 1) {
      vaultPath = await selectAndStoreVault(true);
    }
  } else if (detectedVaults.length > 0) {
    const normalizedStored = path.resolve(vaultPath).toLowerCase();
    const match = detectedVaults.some(
      (v) => path.resolve(v).toLowerCase() === normalizedStored
    );

    if (detectedVaults.length > 1) {
      // Multiple vaults in workspace — always ask user to choose
      const storedName = path.basename(vaultPath);
      const detectedNames = detectedVaults.map((v) => path.basename(v)).join(", ");
      const choice = await vscode.window.showInformationMessage(
        `Multiple vaults detected (${detectedNames}). Currently using "${storedName}". Switch?`,
        { modal: false },
        "Switch",
        "Keep Current"
      );

      if (choice === "Switch") {
        vaultPath = await selectAndStoreVault(true);
      }
      // "Keep Current" or dismissed → keep stored vaultPath
    } else if (!match) {
      // Single vault in workspace but doesn't match stored — ask user
      const storedName = path.basename(vaultPath);
      const detectedName = path.basename(detectedVaults[0]);
      const choice = await vscode.window.showInformationMessage(
        `Current vault "${storedName}" doesn't match this workspace (detected: ${detectedName}). Switch?`,
        { modal: false },
        "Switch",
        "Keep Current"
      );

      if (choice === "Switch") {
        vaultPath = detectedVaults[0];
        await config.update("vaultPath", vaultPath, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`Vault switched to: ${detectedName}`);
      }
    }
    // Single vault that matches stored → do nothing, proceed
  }

  if (!vaultPath) {
    previewPanel.updateContent(
      errorHtml(
        "No Vault Configured",
        "Cannot find an Obsidian vault in the workspace.",
        "Please select or enter your vault path..."
      ),
      ""
    );
    vaultPath = await selectAndStoreVault(true);
    if (!vaultPath) return false;
  }

  // Validate vault path exists on disk
  const obsidianDir = path.join(vaultPath, ".obsidian");
  if (!fs.existsSync(vaultPath) || !fs.existsSync(obsidianDir)) {
    previewPanel.updateContent(
      errorHtml(
        "Vault Path Invalid",
        `The configured vault does not exist or is not an Obsidian vault:`,
        `<code style="background:#f5f5f5;padding:4px 8px;border-radius:4px;font-size:12px;">${vaultPath}</code>`
      ),
      ""
    );
    await config.update("vaultPath", "", vscode.ConfigurationTarget.Global);
    vaultPath = await selectAndStoreVault(true);
    if (!vaultPath) return false;

    if (!fs.existsSync(vaultPath) || !fs.existsSync(path.join(vaultPath, ".obsidian"))) {
      previewPanel.updateContent(
        errorHtml(
          "Invalid Vault Path",
          "The path you entered is not a valid Obsidian vault (no .obsidian folder found):",
          `<code style="background:#f5f5f5;padding:4px 8px;border-radius:4px;font-size:12px;">${vaultPath}</code>`
        ),
        ""
      );
      await config.update("vaultPath", "", vscode.ConfigurationTarget.Global);
      return false;
    }
  }

  const vaultName = path.basename(vaultPath);

  // ── Step 2: Check if plugin is installed ──
  let freshInstall = false;
  if (!isPluginInstalled(vaultPath)) {
    // Plugin not installed — show status in preview
    previewPanel.updateContent(
      statusHtml("📦", "Plugin Not Installed", `Vault: ${vaultName}`, "The Cursor Integration plugin is not installed in this vault."),
      ""
    );

    // Close Obsidian first if running (to safely write files)
    if (isObsidianRunning()) {
      previewPanel.updateContent(
        statusHtml("⏳", "Closing Obsidian...", `Vault: ${vaultName}`, "Obsidian must be closed to install the plugin safely."),
        ""
      );
      killObsidian();
      await sleep(2000); // Wait for process to fully exit
    }

    // Install plugin (non-interactive — auto-download)
    previewPanel.updateContent(
      statusHtml("📥", "Installing Plugin...", `Vault: ${vaultName}`, "Downloading Cursor Integration plugin from GitHub..."),
      ""
    );

    const installed = await autoInstallPlugin(vaultPath);
    if (!installed) {
      previewPanel.updateContent(
        errorHtml(
          "Plugin Installation Failed",
          "Could not download the Cursor Integration plugin from GitHub.",
          "Check your network connection and try again."
        ),
        ""
      );
      return false;
    }
    freshInstall = true;
  }

  // ── Step 3: Check if plugin is enabled ──
  if (!isPluginEnabled(vaultPath)) {
    previewPanel.updateContent(
      statusHtml("🔧", "Enabling Plugin...", `Vault: ${vaultName}`, "Adding Cursor Integration to enabled plugins..."),
      ""
    );

    // Close Obsidian if running (to safely modify community-plugins.json)
    if (isObsidianRunning()) {
      previewPanel.updateContent(
        statusHtml("⏳", "Closing Obsidian...", `Vault: ${vaultName}`, "Obsidian must be closed to enable the plugin safely."),
        ""
      );
      killObsidian();
      await sleep(2000);
    }

    const enabled = enablePluginInConfig(vaultPath);
    if (!enabled) {
      previewPanel.updateContent(
        errorHtml(
          "Failed to Enable Plugin",
          "Could not update community-plugins.json.",
          "Please enable the Cursor Integration plugin manually in Obsidian Settings → Community Plugins."
        ),
        ""
      );
      return false;
    }

    previewPanel.updateContent(
      statusHtml("✅", "Plugin Enabled", `Vault: ${vaultName}`, "Cursor Integration plugin is now enabled."),
      ""
    );
    await sleep(1000);
  }

  // ── Step 4: Check for plugin updates (skip if just installed) ──
  if (!freshInstall) {
    await checkAndUpdateObsidianPlugin(vaultPath);
  }

  // ── Step 5: Launch Obsidian ──
  previewPanel.updateContent(
    statusHtml("🚀", "Opening Obsidian...", `Vault: ${vaultName}`, "Launching Obsidian and waiting for connection..."),
    ""
  );

  try {
    const uri = vscode.Uri.parse(
      `obsidian://open?vault=${encodeURIComponent(vaultName)}`
    );
    await vscode.env.openExternal(uri);
    logger.info(`Launched Obsidian vault: ${vaultName} (${vaultPath})`);
  } catch (err) {
    logger.error(`Failed to launch Obsidian: ${err}`);
    previewPanel.updateContent(
      errorHtml(
        "Failed to Launch Obsidian",
        `Vault: <code>${vaultPath}</code>`,
        `Error: ${err}<br><br>Check that the vault path is correct via <strong>Obsidian Preview: Update Vault Path</strong>`
      ),
      ""
    );
    return false;
  }

  // ── Step 6: Wait for WebSocket connection ──
  const maxRetries = 15;
  for (let i = 1; i <= maxRetries; i++) {
    await sleep(2000);

    try {
      await client.connect();
      logger.info(`Connected to Obsidian after ${i * 2}s`);

      // Connection succeeded — show brief success then return
      previewPanel.updateContent(
        statusHtml("✅", "Connected!", `Vault: ${vaultName}`, "Rendering preview..."),
        ""
      );
      return true;
    } catch {
      if (previewPanel) {
        previewPanel.updateContent(
          statusHtml("🚀", "Opening Obsidian...", `Vault: ${vaultName}`, `Waiting for connection... (${i * 2}s)`),
          ""
        );
      }
    }
  }

  // All retries exhausted
  if (previewPanel) {
    previewPanel.updateContent(
      `<div style="text-align:center;padding:40px;">
        <h2 style="color:#d32f2f;">Connection Timed Out</h2>
        <p style="color:#666;margin:20px 0;">Obsidian was launched but the plugin didn't respond within 30 seconds.</p>
        <p style="color:#666;">Please make sure:</p>
        <ul style="text-align:left;display:inline-block;color:#666;">
          <li>The <strong>Cursor Integration</strong> plugin is enabled in Obsidian</li>
          <li>Vault path is correct: <code>${vaultPath}</code></li>
          <li>Port 27123 is not blocked</li>
        </ul>
        <p style="color:#666;margin-top:16px;">
          Try <strong>Obsidian Preview: Update Vault Path</strong> if the vault is wrong.
        </p>
      </div>`,
      ""
    );
  }
  return false;
}

/**
 * Automatically download and install the Obsidian plugin (no user prompt).
 * Returns true if installation succeeded.
 */
async function autoInstallPlugin(vaultPath: string): Promise<boolean> {
  const pluginDir = path.join(vaultPath, ".obsidian", "plugins", PLUGIN_FOLDER_NAME);

  try {
    const json = await httpsGet(GITHUB_API_LATEST);
    const release = JSON.parse(json) as GitHubRelease;

    const mainAsset = release.assets.find((a) => a.name === "main.js");
    const manifestAsset = release.assets.find((a) => a.name === "manifest.json");

    if (!mainAsset || !manifestAsset) {
      logger.warn("Release assets not found (main.js or manifest.json missing)");
      return false;
    }

    if (!fs.existsSync(pluginDir)) {
      fs.mkdirSync(pluginDir, { recursive: true });
    }

    await downloadToFile(mainAsset.browser_download_url, path.join(pluginDir, "main.js"));
    await downloadToFile(manifestAsset.browser_download_url, path.join(pluginDir, "manifest.json"));

    const version = release.tag_name.replace(/^v/, "");
    logger.info(`Obsidian plugin v${version} installed automatically`);
    return true;
  } catch (err) {
    logger.error(`Auto-install plugin failed: ${err}`);
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Vault Detection & Management ───

/**
 * Scan all workspace folders for .obsidian directories.
 * Each folder containing .obsidian is a vault root.
 */
function detectVaults(): string[] {
  const vaults: string[] = [];
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) return vaults;

  for (const folder of workspaceFolders) {
    const obsidianDir = path.join(folder.uri.fsPath, ".obsidian");
    if (fs.existsSync(obsidianDir)) {
      vaults.push(folder.uri.fsPath);
    }
  }

  return vaults;
}

/**
 * Show a QuickPick to select a vault (or input manually), then store in settings.
 * @param forceRedetect If true, clear stored path and re-detect.
 */
async function selectAndStoreVault(forceRedetect = false): Promise<string | undefined> {
  const config = vscode.workspace.getConfiguration("obsidianPreview");

  if (!forceRedetect) {
    const stored = config.get<string>("vaultPath");
    if (stored) return stored;
  }

  const vaults = detectVaults();
  let selectedPath: string | undefined;

  if (vaults.length === 0) {
    // No vaults detected — ask user to input
    selectedPath = await vscode.window.showInputBox({
      prompt: "No Obsidian vault detected in workspace. Enter the vault path:",
      placeHolder: "D:\\path\\to\\your\\vault",
    });
  } else if (vaults.length === 1) {
    // Single vault — auto-select
    selectedPath = vaults[0];
    vscode.window.showInformationMessage(
      `Vault detected: ${path.basename(selectedPath)}`
    );
  } else {
    // Multiple vaults — let user choose
    const items = vaults.map((v) => ({
      label: path.basename(v),
      description: v,
      vaultPath: v,
    }));
    items.push({
      label: "$(edit) Enter custom path...",
      description: "",
      vaultPath: "",
    });

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: "Multiple vaults found. Select one:",
    });

    if (!selected) return undefined;

    if (selected.vaultPath === "") {
      selectedPath = await vscode.window.showInputBox({
        prompt: "Enter the vault path:",
        placeHolder: "D:\\path\\to\\your\\vault",
      });
    } else {
      selectedPath = selected.vaultPath;
    }
  }

  if (selectedPath) {
    await config.update("vaultPath", selectedPath, vscode.ConfigurationTarget.Global);
    logger.info(`Vault path stored: ${selectedPath}`);
    vscode.window.showInformationMessage(`Vault path saved: ${path.basename(selectedPath)}`);
  }

  return selectedPath;
}

/**
 * Auto-detect vault on activation (silent, no popup for single vault).
 */
function autoDetectVault(): void {
  const config = vscode.workspace.getConfiguration("obsidianPreview");
  const stored = config.get<string>("vaultPath");
  if (stored) {
    logger.info(`Using stored vault: ${stored}`);
    return;
  }

  const vaults = detectVaults();
  if (vaults.length === 1) {
    // Single vault — auto-store silently
    config.update("vaultPath", vaults[0], vscode.ConfigurationTarget.Global);
    logger.info(`Auto-detected vault: ${vaults[0]}`);
  } else if (vaults.length > 1) {
    // Multiple vaults — notify user
    vscode.window
      .showInformationMessage(
        `Found ${vaults.length} Obsidian vaults. Select one for the Open Obsidian command.`,
        "Select Vault"
      )
      .then((choice) => {
        if (choice === "Select Vault") {
          selectAndStoreVault(true);
        }
      });
  }
}

/**
 * Open Obsidian vault using the obsidian:// URI protocol.
 */
async function openObsidianVault(): Promise<void> {
  const config = vscode.workspace.getConfiguration("obsidianPreview");
  let vaultPath = config.get<string>("vaultPath");

  if (!vaultPath) {
    vaultPath = await selectAndStoreVault();
    if (!vaultPath) return;
  }

  const vaultName = path.basename(vaultPath);
  const uri = vscode.Uri.parse(
    `obsidian://open?vault=${encodeURIComponent(vaultName)}`
  );

  try {
    await vscode.env.openExternal(uri);
    vscode.window.showInformationMessage(`Opening Obsidian vault: ${vaultName}`);
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to open Obsidian: ${err}`);
  }
}

// ─── Obsidian Plugin Auto-Update ───

const GITHUB_API_LATEST = "https://api.github.com/repos/px39n/obs_cursor/releases/latest";
const PLUGIN_FOLDER_NAME = "cursor-integration";

interface GitHubRelease {
  tag_name: string;
  assets: { name: string; browser_download_url: string }[];
}

/**
 * HTTPS GET that follows redirects and returns the response body as string.
 */
function httpsGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "obs_cursor" } }, (res) => {
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        httpsGet(res.headers.location).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let data = "";
      res.on("data", (chunk: Buffer) => (data += chunk.toString()));
      res.on("end", () => resolve(data));
    }).on("error", reject);
  });
}

/**
 * Download a file from URL to a local path, following redirects.
 */
function downloadToFile(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "obs_cursor" } }, (res) => {
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        downloadToFile(res.headers.location, destPath).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const file = fs.createWriteStream(destPath);
      res.pipe(file);
      file.on("finish", () => {
        file.close();
        resolve();
      });
    }).on("error", reject);
  });
}

/**
 * Check if the Obsidian plugin is installed and up-to-date.
 * If missing or outdated, prompt the user to install/update from GitHub releases.
 */
async function checkAndUpdateObsidianPlugin(vaultPath: string): Promise<void> {
  const pluginDir = path.join(vaultPath, ".obsidian", "plugins", PLUGIN_FOLDER_NAME);
  const manifestPath = path.join(pluginDir, "manifest.json");

  // Read current installed version (if any)
  let installedVersion: string | null = null;
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      installedVersion = manifest.version || null;
    } catch {
      // Corrupted manifest
    }
  }

  // Fetch latest release from GitHub
  let release: GitHubRelease;
  try {
    const json = await httpsGet(GITHUB_API_LATEST);
    release = JSON.parse(json) as GitHubRelease;
  } catch (err) {
    logger.warn(`Failed to check for plugin updates: ${err}`);
    return; // Silently skip — don't block the user
  }

  const latestVersion = release.tag_name.replace(/^v/, "");

  // Compare versions
  if (installedVersion === latestVersion) {
    logger.info(`Obsidian plugin is up to date (v${installedVersion})`);
    return;
  }

  // Find download URLs for main.js and manifest.json
  const mainAsset = release.assets.find((a) => a.name === "main.js");
  const manifestAsset = release.assets.find((a) => a.name === "manifest.json");

  if (!mainAsset || !manifestAsset) {
    logger.warn("Release assets not found (main.js or manifest.json missing)");
    return;
  }

  // Ask user
  const action = installedVersion
    ? `Update Obsidian plugin: v${installedVersion} → v${latestVersion}?`
    : `Obsidian plugin not installed. Install v${latestVersion}?`;

  const choice = await vscode.window.showInformationMessage(
    action,
    "Yes",
    "No"
  );

  if (choice !== "Yes") return;

  // Install/update
  try {
    // Ensure plugin directory exists
    if (!fs.existsSync(pluginDir)) {
      fs.mkdirSync(pluginDir, { recursive: true });
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: installedVersion
          ? `Updating Obsidian plugin to v${latestVersion}...`
          : `Installing Obsidian plugin v${latestVersion}...`,
        cancellable: false,
      },
      async () => {
        await downloadToFile(mainAsset.browser_download_url, path.join(pluginDir, "main.js"));
        await downloadToFile(manifestAsset.browser_download_url, path.join(pluginDir, "manifest.json"));
      }
    );

    vscode.window.showInformationMessage(
      installedVersion
        ? `Obsidian plugin updated to v${latestVersion}. Restart Obsidian to apply.`
        : `Obsidian plugin v${latestVersion} installed. Enable it in Obsidian Settings → Community Plugins.`
    );
    logger.info(`Obsidian plugin ${installedVersion ? "updated" : "installed"}: v${latestVersion}`);
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to ${installedVersion ? "update" : "install"} plugin: ${err}`);
    logger.error(`Plugin install/update failed: ${err}`);
  }
}

export function deactivate(): void {
  client?.disconnect();
  watcher?.stop();
  decorator?.dispose();
  completionProvider?.dispose();
  previewPanel?.dispose();
}
