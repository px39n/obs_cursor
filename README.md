# Obsidian for Cursor

> **Preview & navigate your Obsidian vault while coding with AI.**

![License](https://img.shields.io/badge/license-MIT-blue.svg)
[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-support-yellow?logo=buy-me-a-coffee)](https://buymeacoffee.com/px39n)

**Have a feature request? Feel free to reach out: cumbiasbj12@gmail.com**

---

## Why?

Cursor/VS Code is great for AI-assisted editing. Obsidian is great for knowledge management. This plugin bridges them — **preview your notes with full Obsidian rendering while you code**.

---

## Features

![Demo](assets/Animation.gif)

- **Live Preview** — Dataview, Admonition, callouts, all rendered
- **Click to Navigate** — `[[wikilinks]]` and `[[File#Heading]]` work, with back button
- **Hover Preview** — See linked notes without switching files
- **Syntax Highlighting** — Wikilinks, tags, embeds colored in editor
- **Wikilink Completion** — Type `[[` to get file suggestions with alias support
- **Collapsible Callouts** — Expand/collapse just like Obsidian
- **Auto Launch** — Automatically detects vault, launches Obsidian, and installs/updates the plugin
- **Imgur Upload** — Paste images directly to Imgur with `Ctrl+Shift+V` (requires [Obsidian Imgur Plugin](https://github.com/gavvvr/obsidian-imgur-plugin), Windows only)

---

## Install

**Strongly Recommended — one step for everything:**

Search `obsidianpreview` in Cursor/VS Code Extensions and install. That's it.

> On first use, the extension auto-detects your vault, installs the Obsidian plugin, and launches Obsidian for you.

For manual installation, see the [Manual Installation Guide](INSTALL.md).

---

## Usage

1. Open your vault folder in Cursor/VS Code
2. Open any `.md` file → Click the 👁️ icon or run `Obsidian Preview: Open Preview`
3. Everything is handled automatically — Obsidian will launch if needed

### Commands

| Command | Description |
|---------|-------------|
| `Obsidian Preview: Open Preview` | Open the preview panel |
| `Obsidian Preview: Open Obsidian Vault` | Launch Obsidian |
| `Obsidian Preview: Update Obsidian Plugin` | Check for and install plugin updates |
| `Obsidian Preview: Update Vault Path` | Change the detected vault path |

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `obsidianPreview.autoOpenPreview` | `true` | Open the Obsidian preview when you focus a Markdown editor (including after a window reload with a note already open). |
| `obsidianPreview.previewInSecondEditorGroup` | `true` | Keep the note in the **first** editor group and the preview in the **second**, so new files from the explorer open next to the source instead of stacking with the webview. Set to `false` for the previous “open beside active editor” behavior. |

To further discourage new tabs from opening in the preview’s group, you can enable the editor auto-lock for this webview in your user `settings.json`:

```json
"workbench.editor.autoLockGroups": {
  "obsidianPreview": true
}
```

(Merge with any other `autoLockGroups` keys you already use.)

---

## Support

If you find this useful, consider supporting the project ☕

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-support-yellow?logo=buy-me-a-coffee&style=for-the-badge)](https://buymeacoffee.com/px39n)

<details open>
<summary>支付宝 / Alipay</summary>

<img src="assets/alipay.jpg" width="200">

</details>

<details open>
<summary>微信支付 / WeChat Pay</summary>

<img src="assets/wechat.jpg" width="200">

</details>

---

## License

MIT © px39n
