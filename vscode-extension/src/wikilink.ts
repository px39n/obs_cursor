import * as vscode from "vscode";

export const normalizeAnchor = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[*_`~[\]]/g, "")
    .replace(/\^[a-zA-Z0-9-]+$/, "")
    .replace(/[-_]+/g, " ")
    .replace(/[^\w\s\u4e00-\u9fa5]/g, "")
    .trim();

export interface HeadingCandidate {
  lineIndex: number;
  raw: string;
  lower: string;
  norm: string;
}

// Searches document lines for heading or block reference matching the anchor
export function findAnchorInLines(lines: string[], rawAnchor: string): number | null {
  const decodedAnchor = decodeURIComponent(rawAnchor).trim();
  const cleanAnchor = decodedAnchor.replace(/^#+/, "").trim();

  if (!cleanAnchor) {
    return null;
  }

  if (cleanAnchor.startsWith("^")) {
    const blockId = cleanAnchor.toLowerCase();
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(blockId)) {
        return i;
      }
    }
    return null;
  }

  const targetLower = cleanAnchor.toLowerCase();
  const targetNorm = normalizeAnchor(cleanAnchor);

  const headings: HeadingCandidate[] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^\s*#+\s+(.+)$/);
    if (match) {
      const raw = match[1].trim();
      headings.push({
        lineIndex: i,
        raw,
        lower: raw.toLowerCase(),
        norm: normalizeAnchor(raw),
      });
    }
  }

  if (headings.length === 0) {
    return null;
  }

  for (const h of headings) {
    if (h.lower === targetLower) {
      return h.lineIndex;
    }
  }

  if (targetNorm.length > 0) {
    for (const h of headings) {
      if (h.norm === targetNorm) {
        return h.lineIndex;
      }
    }

    for (const h of headings) {
      if (h.norm.startsWith(targetNorm) || targetNorm.startsWith(h.norm)) {
        return h.lineIndex;
      }
    }
  }

  return null;
}

// Find file in workspace matching wikilink target (checks exact path first, then filename)
export async function findWikilinkFile(filePart: string): Promise<vscode.Uri | null> {
  const searchPath = filePart.endsWith(".md") ? filePart : filePart + ".md";
  let files = await vscode.workspace.findFiles(`**/${searchPath}`);
  if (files.length === 0) {
    const filename = searchPath.split("/").pop() || searchPath;
    files = await vscode.workspace.findFiles(`**/${filename}`);
  }
  return files[0] ?? null;
}

// Extract basename from markdown file path without extension
export function mdBaseName(filePath: string): string {
  return filePath.split(/[/\\]/).pop()?.replace(/\.md$/i, "") || "";
}