import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { findAnchorInLines, findWikilinkFile } from "./wikilink";

/**
 * Provides hover preview for wikilinks in the editor.
 * Shows a preview of the linked file when hovering with Ctrl pressed.
 */
export class WikilinkHoverProvider implements vscode.HoverProvider {
  private enabled: boolean = false;

  enable(): void {
    this.enabled = true;
  }

  disable(): void {
    this.enabled = false;
  }

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken
  ): Promise<vscode.Hover | null> {
    if (!this.enabled) return null;

    const line = document.lineAt(position.line).text;
    
    // Find wikilink at position: [[link]] or [[link|alias]]
    const wikilinkRegex = /\[\[([^\]]+)\]\]/g;
    let match: RegExpExecArray | null;
    
    while ((match = wikilinkRegex.exec(line)) !== null) {
      const startCol = match.index;
      const endCol = match.index + match[0].length;
      
      if (position.character >= startCol && position.character <= endCol) {
        // Found wikilink at cursor position
        const linkContent = match[1];
        const linkTarget = linkContent.split("|")[0]; // Remove alias if present
        
        // Try to find the file
        const preview = await this.getFilePreview(document, linkTarget);
        
        if (preview) {
          const range = new vscode.Range(
            position.line, startCol,
            position.line, endCol
          );
          
          return new vscode.Hover(preview, range);
        }
      }
    }
    
    // Check for embeds: ![[embed]]
    const embedRegex = /!\[\[([^\]]+)\]\]/g;
    while ((match = embedRegex.exec(line)) !== null) {
      const startCol = match.index;
      const endCol = match.index + match[0].length;
      
      if (position.character >= startCol && position.character <= endCol) {
        const linkTarget = match[1].split("|")[0];
        const preview = await this.getFilePreview(document, linkTarget);
        
        if (preview) {
          const range = new vscode.Range(
            position.line, startCol,
            position.line, endCol
          );
          
          return new vscode.Hover(preview, range);
        }
      }
    }
    
    return null;
  }

  /**
   * Get preview content for a linked file.
   */
  private async getFilePreview(
    currentDocument: vscode.TextDocument,
    linkTarget: string
  ): Promise<vscode.MarkdownString | null> {
    // FIX: Guard decodeURIComponent against malformed URI sequences
    let cleanTarget = linkTarget;
    try {
      cleanTarget = decodeURIComponent(linkTarget).trim();
    } catch {
      cleanTarget = linkTarget.trim();
    }

    let filePart = cleanTarget;
    let anchorPart = "";
    const hashIndex = cleanTarget.indexOf("#");
    if (hashIndex !== -1) {
      filePart = cleanTarget.substring(0, hashIndex).trim();
      anchorPart = cleanTarget.substring(hashIndex + 1).trim();
    }

    let filePath: string;

    // Allow same-file preview if an anchor is specified, otherwise skip
    if (!filePart) {
      filePath = currentDocument.uri.fsPath;
    } else {
      // Search for target workspace file using findWikilinkFile
      const target = await findWikilinkFile(filePart);

      if (!target) {
        return new vscode.MarkdownString(`*File not found: ${linkTarget}*`);
      }
      filePath = target.fsPath;
    }

    // Skip preview if pointing to current document without an anchor
    if (filePath.toLowerCase() === currentDocument.uri.fsPath.toLowerCase() && !anchorPart) {
      return null;
    }

    try {
      const content = fs.readFileSync(filePath, "utf8");
      const lines = content.split("\n");

      let startLine = 0;
      if (anchorPart) {
        const matchedLine = findAnchorInLines(lines, anchorPart);
        if (matchedLine !== null) {
          startLine = matchedLine;
        }
      }

      // Extract up to 30 lines starting from anchor position for preview
      const endLine = Math.min(lines.length, startLine + 30);
      const previewLines = lines.slice(startLine, endLine);
      let previewContent = previewLines.join("\n").trim();

      if (startLine > 0) {
        previewContent = "*... (above omitted)*\n\n" + previewContent;
      }
      if (endLine < lines.length) {
        previewContent += "\n\n*... (below omitted)*";
      }

      const title = `**${path.basename(filePath, ".md")}${anchorPart ? " > " + anchorPart : ""}**`;
      const md = new vscode.MarkdownString();
      md.appendMarkdown(`${title}\n\n---\n\n${previewContent}`);
      md.isTrusted = true;
      return md;
    } catch (err) {
      return new vscode.MarkdownString(`*Error reading file: ${err}*`);
    }
  }
}
