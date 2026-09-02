import * as vscode from "vscode";

type LinkClickCallback = (targetPath: string) => void;
type HoverPreviewCallback = (targetPath: string) => Promise<{ html: string; css: string } | null>;
type RefreshCallback = () => void;
type NavigateBackCallback = () => void;
type FocusObsidianCallback = () => void;

export class PreviewPanel {
  private static readonly viewType = "obsidianPreview";
  private readonly panel: vscode.WebviewPanel;
  private linkClickCallbacks: LinkClickCallback[] = [];
  private hoverPreviewCallback: HoverPreviewCallback | null = null;
  private refreshCallbacks: RefreshCallback[] = [];
  private navigateBackCallbacks: NavigateBackCallback[] = [];
  private focusObsidianCallbacks: FocusObsidianCallback[] = [];
  private disposeCallbacks: (() => void)[] = [];
  private debugMode: boolean = false;
  private canGoBack: boolean = false;

  private constructor(
    panel: vscode.WebviewPanel,
    _extensionUri: vscode.Uri,
    debugMode: boolean = false
  ) {
    this.panel = panel;
    this.debugMode = debugMode;

    this.panel.webview.onDidReceiveMessage(async (message) => {
      if (message.type === "linkClick") {
        this.linkClickCallbacks.forEach((cb) => cb(message.targetPath));
      } else if (message.type === "hoverPreview") {
        if (this.hoverPreviewCallback) {
          const result = await this.hoverPreviewCallback(message.targetPath);
          if (result) {
            this.panel.webview.postMessage({
              type: "hoverPreviewResult",
              targetPath: message.targetPath,
              html: result.html,
              x: message.x,
              y: message.y,
            });
          }
        }
      } else if (message.type === "hoverEnd") {
        // Preview will handle hiding itself
      } else if (message.type === "refresh") {
        this.refreshCallbacks.forEach((cb) => cb());
      } else if (message.type === "navigateBack") {
        this.navigateBackCallbacks.forEach((cb) => cb());
      } else if (message.type === "focusObsidian") {
        this.focusObsidianCallbacks.forEach((cb) => cb());
      }
    });

    // Handle panel dispose
    this.panel.onDidDispose(() => {
      this.disposeCallbacks.forEach((cb) => cb());
    });
  }

  private vaultUri: vscode.Uri | null = null;
  private currentTitle: string | undefined;

  static create(extensionUri: vscode.Uri, debugMode: boolean = false): PreviewPanel {
    // Get all workspace folders and active editor's folder
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const activeEditor = vscode.window.activeTextEditor;
    
    // Collect all possible resource roots
    const resourceRoots: vscode.Uri[] = [extensionUri];
    
    // Add workspace folders
    if (workspaceFolders) {
      workspaceFolders.forEach(folder => resourceRoots.push(folder.uri));
    }
    
    // Add active file's directory (vault might be here)
    if (activeEditor) {
      const fileDir = vscode.Uri.joinPath(activeEditor.document.uri, '..');
      resourceRoots.push(fileDir);
      // Also add parent directories up to drive root (to cover vault root)
      let parent = fileDir;
      for (let i = 0; i < 10; i++) {
        const newParent = vscode.Uri.joinPath(parent, '..');
        if (newParent.fsPath === parent.fsPath) break;
        resourceRoots.push(newParent);
        parent = newParent;
      }
    }
    
    const vaultUri = workspaceFolders?.[0]?.uri || (activeEditor ? vscode.Uri.joinPath(activeEditor.document.uri, '..') : null);
    
    const panel = vscode.window.createWebviewPanel(
      PreviewPanel.viewType,
      debugMode ? "Obsidian Preview (Debug)" : "Obsidian Preview",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: resourceRoots,
      }
    );

    const previewPanel = new PreviewPanel(panel, extensionUri, debugMode);
    previewPanel.vaultUri = vaultUri || null;
    return previewPanel;
  }

  showLoading(title?: string): void {
    this.currentTitle = title;
    const loadingHtml = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:#888;">
        <div style="font-size:24px;margin-bottom:16px;">⏳</div>
        <div>Loading...</div>
      </div>
    `;
    this.panel.webview.html = this.getWebviewContent(loadingHtml, "");
  }

  updateContent(html: string, css: string, title?: string): void {
    this.currentTitle = title;
    // Debug: log HTML size
    if (this.debugMode) {
      console.log(`[Preview] Received HTML: ${html.length} chars`);
      console.log(`[Preview] First 500 chars:`, html.substring(0, 500));
      // Check for dataview content
      const dvMatch = html.match(/class="dataview[^"]*"[^>]*>[\s\S]{0,300}/g);
      if (dvMatch) {
        console.log(`[Preview] Dataview matches:`, dvMatch.slice(0, 3));
      }
    }
    
    // Convert local image paths to webview URIs
    const processedHtml = this.processLocalImages(html);
    this.panel.webview.html = this.getWebviewContent(processedHtml, css);
  }
  
  /**
   * Convert local image paths to webview-compatible URIs
   */
  private processLocalImages(html: string): string {
    if (!this.vaultUri) {
      console.log("[Preview] No vaultUri, skipping image processing");
      return html;
    }
    
    const webview = this.panel.webview;
    const vaultPath = this.vaultUri.fsPath;
    
    console.log("[Preview] Processing images, vaultPath:", vaultPath);
    
    // Match src attributes with various patterns
    return html.replace(
      /src=["']([^"']+)["']/g,
      (match, src) => {
        console.log("[Preview] Found src:", src);
        
        // Skip data URIs and external URLs
        if (src.startsWith('data:') || src.startsWith('http://') || src.startsWith('https://')) {
          return match;
        }
        
        // Handle app:// protocol (Obsidian internal)
        if (src.startsWith('app://')) {
          // Extract the path after app://xxx/
          const pathMatch = src.match(/app:\/\/[^/]+\/(.+)/);
          if (pathMatch) {
            let filePath = decodeURIComponent(pathMatch[1]);
            // Remove query string (e.g., ?1738439523304)
            const queryIndex = filePath.indexOf('?');
            if (queryIndex !== -1) {
              filePath = filePath.substring(0, queryIndex);
            }
            console.log("[Preview] app:// path converted to:", filePath);
            const fileUri = vscode.Uri.file(filePath);
            const webviewUri = webview.asWebviewUri(fileUri);
            return `src="${webviewUri}"`;
          }
        }
        
        // Handle relative paths
        try {
          const absolutePath = src.startsWith('/') ? src : `${vaultPath}/${src}`;
          console.log("[Preview] Relative path converted to:", absolutePath);
          const fileUri = vscode.Uri.file(absolutePath);
          const webviewUri = webview.asWebviewUri(fileUri);
          return `src="${webviewUri}"`;
        } catch (err) {
          console.log("[Preview] Error processing image:", err);
          return match;
        }
      }
    );
  }

  onLinkClick(callback: LinkClickCallback): void {
    this.linkClickCallbacks.push(callback);
  }

  onHoverPreview(callback: HoverPreviewCallback): void {
    this.hoverPreviewCallback = callback;
  }

  onRefresh(callback: RefreshCallback): void {
    this.refreshCallbacks.push(callback);
  }

  onNavigateBack(callback: NavigateBackCallback): void {
    this.navigateBackCallbacks.push(callback);
  }

  onFocusObsidian(callback: FocusObsidianCallback): void {
    this.focusObsidianCallbacks.push(callback);
  }

  setCanGoBack(value: boolean): void {
    this.canGoBack = value;
    // Dynamically update back button visibility in the webview
    this.panel.webview.postMessage({ type: "updateBackButton", visible: value });
  }

  onDispose(callback: () => void): void {
    this.disposeCallbacks.push(callback);
  }

  dispose(): void {
    this.panel.dispose();
  }

  private getWebviewContent(html: string, css: string): string {
    const debugPanel = this.debugMode ? `
    <div id="debug-panel" style="position:fixed;top:0;left:0;right:0;background:#ffeb3b;color:#000;padding:10px;font-family:monospace;font-size:12px;z-index:9999;border-bottom:2px solid #f57c00;">
      Debug Mode: Click anywhere to see element info
    </div>` : '';
    
    const titleBar = this.currentTitle ? `
    <div class="preview-title-bar">
      <button id="back-btn" class="preview-back-btn${this.canGoBack ? '' : ' disabled'}" onclick="if(!this.classList.contains('disabled'))vscode.postMessage({type:'navigateBack'})" title="Go back">←</button>
      <span class="preview-title-icon">📄</span>
      <span class="preview-title-text">${this.currentTitle}</span>
      <button class="preview-refresh-btn" onclick="vscode.postMessage({type:'refresh'})" title="Refresh (restart render server)">Reload</button>
    </div>` : '';
    
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    /* Base styles - Map VS Code theme variables to Obsidian CSS variables */
    :root {
      --background-primary: var(--vscode-editor-background, #ffffff);
      --background-secondary: var(--vscode-sideBar-background, #f5f5f5);
      --text-normal: var(--vscode-editor-foreground, #333333);
      --text-muted: var(--vscode-descriptionForeground, #666666);
      --text-accent: var(--vscode-textLink-foreground, #0969da);
      --interactive-accent: var(--vscode-textLink-activeForeground, #0550ae);
      --hr-color: var(--vscode-settings-dropdownListBorder, #e1e4e8);
    }

    /* Target VS Code Dark Themes */
    body.vscode-dark, body.vscode-high-contrast {
      --background-primary: var(--vscode-editor-background, #1e1e1e);
      --background-secondary: var(--vscode-sideBar-background, #252526);
      --text-normal: var(--vscode-editor-foreground, #cccccc);
      --text-muted: var(--vscode-descriptionForeground, #858585);
      --text-accent: var(--vscode-textLink-foreground, #3794ff);
      --interactive-accent: var(--vscode-textLink-activeForeground, #3794ff);
    }
    
    html, body {
      margin: 0;
      padding: 0;
      height: 100%;
      overflow: hidden;
    }
    
    body {
      background-color: var(--background-primary);
      color: var(--text-normal);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 14px;
      line-height: 1.6;
      display: flex;
      flex-direction: column;
    }
    
    /* Title bar styles - fixed at top */
    .preview-title-bar {
      display: flex;
      align-items: center;
      padding: 10px 20px;
      border-bottom: 1px solid var(--background-secondary);
      background: var(--background-primary);
      flex-shrink: 0;
    }
    
    .preview-title-icon {
      margin-right: 8px;
      font-size: 16px;
    }
    
    .preview-title-text {
      font-size: 18px;
      font-weight: 600;
      color: var(--text-normal);
      flex: 1;
    }
    
    .preview-back-btn {
      background: transparent;
      border: 1px solid var(--background-secondary);
      border-radius: 4px;
      cursor: pointer;
      padding: 4px 10px;
      font-size: 16px;
      font-weight: bold;
      opacity: 0.7;
      transition: opacity 0.2s, background 0.2s, color 0.2s;
      margin-right: 8px;
      color: var(--text-muted);
    }
    
    .preview-back-btn:hover:not(.disabled) {
      opacity: 1;
      background: var(--background-secondary);
      color: var(--text-accent);
    }
    
    .preview-back-btn.disabled {
      opacity: 0.25;
      cursor: default;
    }
    
    .preview-refresh-btn {
      background: transparent;
      border: 1px solid var(--background-secondary);
      border-radius: 4px;
      cursor: pointer;
      padding: 4px 8px;
      font-size: 14px;
      opacity: 0.6;
      color: var(--text-normal);
      transition: opacity 0.2s;
    }
    
    .preview-refresh-btn:hover {
      opacity: 1;
      background: var(--background-secondary);
    }
    
    /* Content area - scrollable */
    .preview-content {
      flex: 1;
      overflow: auto;
      padding: 20px;
    }
    
    /* Link styles */
    a, .internal-link, .cm-hmd-internal-link {
      color: var(--text-accent);
      text-decoration: none;
      cursor: pointer;
    }
    
    a:hover, .internal-link:hover {
      text-decoration: underline;
    }
    
    /* Admonition/Callout collapse styles */
    .admonition-title, .callout-title, .admonition-title-content {
      cursor: pointer;
      user-select: none;
    }
    
    .admonition.is-collapsed .admonition-content,
    .callout.is-collapsed .callout-content {
      display: none;
    }
    
    .callout-fold, .admonition-collapse-icon {
      cursor: pointer;
    }
    
    /* Embed styles - prevent extra whitespace */
    .internal-embed,
    .markdown-embed,
    .markdown-embed-content,
    .markdown-embed-content > .markdown-preview-view,
    .markdown-embed .markdown-preview-view,
    .markdown-embed-content .markdown-preview-view.markdown-rendered,
    .markdown-embed-content .markdown-preview-view.show-indentation-guide,
    span.internal-embed .markdown-embed,
    span.internal-embed .markdown-embed-content,
    span.internal-embed .markdown-preview-view {
      display: block !important;
      position: relative !important;
      min-height: 0 !important;
      max-height: none !important;
      height: auto !important;
      margin: 0 !important;
      padding: 0 !important;
      border: none !important;
      overflow: visible !important;
    }
    
    .internal-embed {
      margin: 8px 0 !important;
    }
    
    /* Hover preview popup */
    #hover-preview {
      position: fixed;
      display: none;
      background: var(--background-primary);
      color: var(--text-normal);
      border: 1px solid var(--background-secondary);
      border-radius: 6px;
      box-shadow: 0 4px 12px rgb(0 0 0 / 0.15);
      max-width: 400px;
      max-height: 300px;
      overflow: auto;
      padding: 12px;
      z-index: 10000;
      font-size: 13px;
    }
    
    #hover-preview .preview-title {
      font-weight: bold;
      margin-bottom: 8px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--background-secondary);
    }
    
    ${css}
  </style>
  <style>
    /* Override Obsidian's embed styles - MUST be after Obsidian CSS */
    .internal-embed,
    .markdown-embed,
    .markdown-embed-content,
    .markdown-embed-content > .markdown-preview-view,
    .markdown-embed .markdown-preview-view,
    .markdown-embed-content .markdown-preview-view.markdown-rendered,
    .markdown-embed-content .markdown-preview-view.show-indentation-guide {
      min-height: 0 !important;
      max-height: none !important;
      height: auto !important;
      position: relative !important;
      overflow: visible !important;
    }
  </style>
</head>
<body>
  ${debugPanel}
  ${titleBar}
  <div class="preview-content">
    <div class="markdown-preview-view markdown-rendered" style="${this.debugMode ? 'margin-top:50px;' : ''}">
      ${html}
    </div>
  </div>
  <div id="hover-preview"></div>
  <script>
    const vscode = acquireVsCodeApi();
    const isDebugMode = ${this.debugMode};

    // Dynamically sync Obsidian theme class based on VS Code's theme
    if (document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast')) {
      document.body.classList.add('theme-dark');
      document.body.classList.remove('theme-light');
    } else {
      document.body.classList.add('theme-light');
      document.body.classList.remove('theme-dark');
    }
    
    // Handle Admonition/Callout collapse
    function toggleAdmonition(container) {
      if (!container) return false;
      
      // Check current state
      var isCollapsed = container.classList.contains('is-collapsed');
      
      // Find content element
      var content = container.querySelector('.callout-content, .admonition-content, .admonition-content-holder');
      
      if (isCollapsed) {
        // Expand: remove collapsed class, show content
        container.classList.remove('is-collapsed');
        if (content) {
          content.style.display = 'block';
          content.style.visibility = 'visible';
          content.style.height = 'auto';
        }
      } else {
        // Collapse: add collapsed class, hide content
        container.classList.add('is-collapsed');
        if (content) {
          content.style.display = 'none';
        }
      }
      
      return true;
    }
    
    // Update debug panel
    function updateDebug(msg) {
      var panel = document.getElementById('debug-panel');
      if (panel) {
        panel.innerHTML = msg;
        panel.style.background = '#4caf50';
      }
    }
    
    // Click handler
    document.body.addEventListener('click', function(e) {
      var t = e.target;
      
      // Debug info
      if (isDebugMode) {
        var info = 'Clicked: ' + t.tagName + ' | Class: ' + (t.className || 'none');
        if (t.parentElement) {
          info += ' | Parent: ' + t.parentElement.tagName + '.' + (t.parentElement.className || 'none');
        }
        // Show innerHTML (truncated)
        var inner = t.innerHTML || t.textContent || '(empty)';
        if (inner.length > 100) inner = inner.substring(0, 100) + '...';
        info += ' | Content: ' + inner.replace(/</g, '&lt;');
        // Show all attributes
        var attrs = [];
        for (var i = 0; i < t.attributes.length; i++) {
          var attr = t.attributes[i];
          attrs.push(attr.name + '="' + attr.value + '"');
        }
        if (attrs.length > 0) {
          info += ' | Attrs: ' + attrs.join(', ');
        }
        // Check first child
        if (t.firstElementChild) {
          var child = t.firstElementChild;
          var childAttrs = [];
          for (var j = 0; j < child.attributes.length; j++) {
            childAttrs.push(child.attributes[j].name + '="' + child.attributes[j].value + '"');
          }
          info += ' | Child: ' + child.tagName + ' [' + childAttrs.join(', ') + '] text="' + (child.textContent || '') + '"';
        }
        updateDebug(info);
      }
      
      // Check if clicked on admonition title area
      var admonitionTitle = t.closest('.callout-title, .admonition-title, .callout-title-inner, .admonition-title-content');
      if (admonitionTitle) {
        e.preventDefault();
        e.stopPropagation();
        // Find the main container
        var container = admonitionTitle.closest('.callout, .admonition, [class*="admonition-plugin"]');
        if (container) {
          toggleAdmonition(container);
          if (isDebugMode) {
            updateDebug('Toggled! Container: ' + container.className);
          }
        }
        return;
      }
      
      // Handle links
      var link = t.closest('a');
      if (link) {
        e.preventDefault();
        e.stopPropagation();
        var targetPath = link.getAttribute('data-href') || link.getAttribute('href') || link.textContent;
        if (isDebugMode) {
          updateDebug('Link: data-href="' + (link.getAttribute('data-href') || 'none') + 
                     '" href="' + (link.getAttribute('href') || 'none') + 
                     '" text="' + (link.textContent || 'none') + 
                     '" → targetPath="' + targetPath + '"');
        }
        
        // Handle same-file anchor links (scroll within preview)
        if (targetPath && targetPath.startsWith('#')) {
          var anchorName = targetPath.substring(1).toLowerCase().replace(/-/g, ' ');
          // Find matching heading in preview
          var headings = document.querySelectorAll('h1, h2, h3, h4, h5, h6');
          for (var i = 0; i < headings.length; i++) {
            var h = headings[i];
            var headingText = (h.textContent || '').toLowerCase().trim();
            if (headingText === anchorName || headingText.replace(/\\s+/g, '-') === targetPath.substring(1).toLowerCase()) {
              h.scrollIntoView({ behavior: 'smooth', block: 'start' });
              if (isDebugMode) {
                updateDebug('Scrolled to heading: ' + h.textContent);
              }
              // Also notify extension to scroll editor
              vscode.postMessage({ type: 'linkClick', targetPath: targetPath });
              return;
            }
          }
          if (isDebugMode) {
            updateDebug('Heading not found in preview: ' + anchorName);
          }
          // Still notify extension even if not found in preview
          vscode.postMessage({ type: 'linkClick', targetPath: targetPath });
          return;
        }
        
        if (targetPath && targetPath.indexOf('http') !== 0) {
          vscode.postMessage({ type: 'linkClick', targetPath: targetPath });
        }
      }
    });
    
    // Hover preview functionality
    var hoverPreview = document.getElementById('hover-preview');
    var hoverTimeout = null;
    var currentHoverLink = null;
    
    // Listen for messages from extension
    window.addEventListener('message', function(e) {
      var msg = e.data;
      if (msg.type === 'hoverPreviewResult') {
        showHoverPreview(msg.html, msg.x, msg.y, msg.targetPath);
      } else if (msg.type === 'updateBackButton') {
        var btn = document.getElementById('back-btn');
        if (btn) {
          if (msg.visible) {
            btn.classList.remove('disabled');
          } else {
            btn.classList.add('disabled');
          }
        }
      }
    });
    
    function showHoverPreview(html, x, y, title) {
      if (!hoverPreview) return;
      
      // Extract just the content, limit size
      var tempDiv = document.createElement('div');
      tempDiv.innerHTML = html;
      var previewContent = tempDiv.innerHTML;
      if (previewContent.length > 5000) {
        previewContent = previewContent.substring(0, 5000) + '...';
      }
      
      hoverPreview.innerHTML = '<div class="preview-title">' + (title || 'Preview') + '</div>' + previewContent;
      
      // Position the preview
      var viewportWidth = window.innerWidth;
      var viewportHeight = window.innerHeight;
      
      hoverPreview.style.display = 'block';
      
      var previewWidth = hoverPreview.offsetWidth;
      var previewHeight = hoverPreview.offsetHeight;
      
      // Adjust position to stay in viewport
      var left = x + 10;
      var top = y + 10;
      
      if (left + previewWidth > viewportWidth - 20) {
        left = x - previewWidth - 10;
      }
      if (top + previewHeight > viewportHeight - 20) {
        top = viewportHeight - previewHeight - 20;
      }
      if (left < 10) left = 10;
      if (top < 10) top = 10;
      
      hoverPreview.style.left = left + 'px';
      hoverPreview.style.top = top + 'px';
    }
    
    function hideHoverPreview() {
      if (hoverPreview) {
        hoverPreview.style.display = 'none';
      }
      currentHoverLink = null;
    }
    
    // Add hover listeners to links
    document.body.addEventListener('mouseenter', function(e) {
      var link = e.target.closest('a.internal-link, a[data-href]');
      if (link && link !== currentHoverLink) {
        currentHoverLink = link;
        
        // Delay before showing preview
        clearTimeout(hoverTimeout);
        hoverTimeout = setTimeout(function() {
          var targetPath = link.getAttribute('data-href') || link.getAttribute('href');
          if (targetPath && targetPath.indexOf('http') !== 0) {
            var rect = link.getBoundingClientRect();
            vscode.postMessage({
              type: 'hoverPreview',
              targetPath: targetPath,
              x: rect.right,
              y: rect.top
            });
          }
        }, 200); // 200ms delay
      }
    }, true);
    
    document.body.addEventListener('mouseleave', function(e) {
      var link = e.target.closest('a.internal-link, a[data-href]');
      if (link) {
        clearTimeout(hoverTimeout);
        // Delay before hiding to allow moving to preview
        setTimeout(function() {
          if (!hoverPreview.matches(':hover')) {
            hideHoverPreview();
          }
        }, 100);
      }
    }, true);
    
    // Hide preview when mouse leaves the preview itself
    if (hoverPreview) {
      hoverPreview.addEventListener('mouseleave', function() {
        hideHoverPreview();
      });
    }
    
    // Debug: show image info on load
    if (isDebugMode) {
      setTimeout(function() {
        var imgs = document.querySelectorAll('img');
        var imgInfo = 'Images found: ' + imgs.length + '<br>';
        imgs.forEach(function(img, i) {
          var src = img.getAttribute('src') || '(none)';
          var broken = !img.complete || img.naturalWidth === 0;
          var dims = img.naturalWidth + 'x' + img.naturalHeight;
          imgInfo += (i+1) + '. ' + (broken ? '❌' : '✓') + ' [' + dims + '] src="' + src.substring(0, 150) + (src.length > 150 ? '...' : '') + '"<br>';
        });
        if (imgs.length > 0) {
          updateDebug(imgInfo);
        }
      }, 1000);
    }
  </script>
</body>
</html>`;
  }
}