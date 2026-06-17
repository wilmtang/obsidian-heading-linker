# Changelog

All notable changes to **Heading Linker and Refactor** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Headings containing `[` or `]` are now linked, found, and renamed correctly.**
  Previously, a link the plugin generated for such a heading was invisible to
  **Find heading references...** and **Rename this heading...** — rename reported
  success while changing nothing. Markdown link labels are now parsed with
  awareness of the `\[`/`\]` escaping the plugin emits.
- **Display labels that match the old heading are updated on rename even when
  escaped.** A label such as `A \[x\]` or `A \\ B` that renders as the old
  heading name is now rewritten to the new name, as the README promises.
- **Headings or file names containing `<` now produce valid links.** The wrapped
  destination escapes both `<` and `>` (previously only `>`), so a heading like
  `Vector<T>` no longer yields a malformed link.
- **Copying a heading link no longer leaves a stray block ID behind if the copy
  fails.** The document is only modified after the clipboard write succeeds, and
  a failed copy now shows a clear notice instead of silently doing nothing.

### Changed

- **Renaming a heading now rejects new names containing `|`, `]`, or line breaks.**
  Obsidian wikilinks cannot escape these characters, so the rename modal shows a
  notice instead of writing a broken link. Names that already contain them can
  still be renamed *to* a valid name.
- Modal and search-result styling moved from inline styles to a bundled
  `styles.css`. Appearance is unchanged, but **manual installs must now also copy
  `styles.css`** into the plugin folder (it is included in every release).

### Added

- `versions.json` is now published so Obsidian can match plugin versions to the
  minimum supported app version. The release check enforces that the mapping
  stays in sync with `manifest.json`.

[Unreleased]: https://github.com/wilmtang/obsidian-heading-linker/compare/1.0.7...HEAD
