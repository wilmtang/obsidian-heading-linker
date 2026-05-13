# Obsidian Heading Linker

An Obsidian plugin to copy markdown links to headings with customizable paths and hierarchy.

## Installation

1. Copy `main.js` and `manifest.json` to your vault's `.obsidian/plugins/obsidian-heading-linker/` folder.
2. Enable the plugin in Obsidian settings.

## Features

- **Right-click on headings** in the editor or outline view to copy a link.
- **Configurable Link Paths**:
  - Relative paths (e.g., `./Note.md`)
  - Full vault paths (e.g., `Folder/Sub/Note.md`)
- **Hierarchical Anchors**:
  - Include parent headings (e.g., `#H1/H2/H3`)
  - Or only the target heading (e.g., `#H3`)

## Development

```bash
npm install
npm run build
```
