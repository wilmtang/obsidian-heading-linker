# Heading Linker & Refactor

**Supercharge your Obsidian headings!** Easily copy robust markdown links to any heading, find all references, and safely rename headings across your entire vault.

## Why this plugin?

As your vault grows, headings become powerful anchors for your thoughts. But Obsidian's native heading links can break if you rename them, and finding where a heading is used can be tedious. 

**Heading Linker & Refactor** solves this by providing a suite of advanced tools right in your editor's context menu.

## ✨ Features

- 🔗 **Smart Linking**: Right-click any heading to copy a markdown link to it. If you have duplicate headings in the same file, the plugin automatically generates and inserts a unique HTML anchor (e.g., `<a id="...">`) so your link never points to the wrong place!
- 📝 **Safe Renaming**: Right-click a heading and select "Rename this heading...". The plugin will safely rename the heading and instantly update every single link pointing to it (Wiki, Markdown, and HTML links) across your file, folder, or entire vault. It even intelligently updates display aliases that match the old heading name.
- 🔎 **Find References**: Need to know everywhere a heading is mentioned? Click "Find heading references..." to open a beautifully formatted search modal. See the exact context of each mention and jump straight to the source.
- ⚡ **Lightning Fast Refactor**: Press `Shift + Enter` right inside the "Find References" modal to instantly rename the heading and all its references across your vault!
- ⚙️ **Configurable Link Paths**: Choose between relative paths (`./Note.md`) or full vault paths (`Folder/Sub/Note.md`).

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
## 📥 Installation

### From Obsidian Community Plugins (Coming Soon)
*(Instructions for community plugin installation will go here once approved!)*

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
