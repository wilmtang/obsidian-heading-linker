# Heading Linker & Refactor

![Obsidian Download](https://img.shields.io/badge/dynamic/json?logo=obsidian&color=%23483699&label=Downloads&query=%24%5B%22obsidian-heading-linker%22%5D.downloads&url=https%3A%2F%2Fraw.githubusercontent.com%2Fobsidianmd%2Fobsidian-releases%2Fmaster%2Fcommunity-plugin-stats.json) ![Total Downloads](https://img.shields.io/github/downloads/wilmtang/obsidian-heading-linker/total?style=flat&label=Total%20Downloads) ![GitHub Issues](https://img.shields.io/github/issues/wilmtang/obsidian-heading-linker?style=flat&label=Issues) ![GitHub Last Commit](https://img.shields.io/github/last-commit/wilmtang/obsidian-heading-linker?style=flat&label=Last%20Commit)

**Supercharge your Obsidian headings!** Easily copy robust markdown links to any heading, find all references, and safely rename headings across your entire vault.

## Why this plugin?

As your vault grows, headings become powerful anchors for your thoughts. But Obsidian's native heading links can break if you rename them, and finding where a heading is used can be tedious. 

**Heading Linker & Refactor** solves this by providing a suite of advanced tools right in your editor's context menu.

## ✨ Features

- 🔗 **Smart Linking**: Right-click any heading to copy a markdown link to it. If you have duplicate headings in the same file, the plugin automatically generates and inserts a stable target. Obsidian block IDs (e.g., `^heading-id`) are the default, with legacy HTML anchors (e.g., `<a id="...">`) available as a compatibility option.
- 📝 **Safe Renaming**: Right-click a heading and select "Rename this heading...". The plugin will safely rename the heading and instantly update every single link pointing to it (Wiki, Markdown, and HTML links) across your file, folder, or entire vault. It even intelligently updates display aliases that match the old heading name.
- 🔎 **Find References**: Need to know everywhere a heading is mentioned? Click "Find heading references..." to open a beautifully formatted search modal. See the exact context of each mention and jump straight to the source.
- ⚡ **Lightning Fast Refactor**: Press `Shift + Enter` right inside the "Find References" modal to instantly rename the heading and all its references across your vault!
- ⚙️ **Customizable Settings**: Choose between relative or full vault link paths, and configure the default scope for renaming headings (Entire Vault, Current Folder, or Current File).
- ⌨️ **Keyboard Shortcuts (Hotkeys)**: Bind custom keyboard shortcuts for all three commands (Copy, Rename, and Find References) that trigger only when editing a heading line!

## 🛠️ How to Use

1. Open any markdown file in Obsidian.
2. Right-click on any heading in the editor to open the context menu.

<img src="images/context-menu.png" alt="Context Menu" width="300">

3. Choose one of the new options:
   - **Copy markdown link to heading**: Instantly copies a reliable markdown link to your clipboard.
   
   - **Rename this heading...**: Opens a modal to safely rename the heading across your entire vault.
   
   <br>
   <img src="images/rename-modal.png" alt="Rename Heading Modal" width="450">
   
   - **Find heading references...**: Opens a beautifully formatted search modal to see the exact context of each mention and jump straight to the source.
   
   <br>
   <img src="images/search-references.png" alt="Find References Modal" width="600">

## ⚙️ Configuration & Hotkeys

### Keyboard Shortcuts (Hotkeys)
By default, the plugin registers commands without default keyboard shortcuts so they don't conflict with your existing setup. You can assign your own custom shortcuts in Obsidian:
1. Open Obsidian **Settings** and navigate to **Hotkeys**.
2. Search for `Heading Linker & Refactor`.
3. Click the blank button next to a command to record a key combination for:
   - `Copy Markdown Link`
   - `Rename this Heading`
   - `Find Heading References`
   - `Convert Heading Link Target Format`

> [!NOTE]
> To prevent accidental triggers, these keyboard shortcuts are context-sensitive. They will **only trigger when your cursor is positioned directly on a heading line**. If you press the shortcut while the cursor is anywhere else in the document, the command will silently do nothing.

### Settings Tab
Navigate to **Settings > Heading Linker & Refactor** to customize the default behavior:
- **File Path Format**: Choose whether generated links use relative paths (`./filename.md`) or full vault paths (`folder/filename.md`).
- **Duplicate Heading Target Format**: Choose whether duplicate headings use Obsidian block IDs (`^id`) or legacy HTML anchors (`<a id="...">`).
- **Rename Scope**: Set the default search scope when renaming a heading (search and replace in the **Entire vault**, **Current folder only**, or **Current file only**).

## 📥 Installation

### From Obsidian Community Plugins
You can install this plugin directly from the Obsidian Community Plugins store:
[Heading Linker & Refactor](https://community.obsidian.md/plugins/heading-link-copy)

### Manual Installation
1. Download the latest release (`main.js` and `manifest.json`) from the [Releases](https://github.com/wilmtang/obsidian-heading-linker/releases) page.
2. Create a folder named `obsidian-heading-linker` in your vault's `.obsidian/plugins/` directory.
3. Place the downloaded files in that folder.
4. Restart Obsidian, go to **Settings > Community Plugins**, disable "Safe Mode", and enable **Heading Linker & Refactor**.

## 💻 Development

Want to contribute or build it yourself? 

```bash
npm install
npm run build
```

---
*Built with ❤️ for the Obsidian Community.*
