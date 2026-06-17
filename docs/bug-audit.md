# Bug Audit

Date: 2026-06-15
Last updated: 2026-06-16

Scope: full repository pass over `main.ts`, tests, WebdriverIO e2e setup, release workflow, TypeScript/ESLint config, and version/release scripts.

Verification run:

- `npm run typecheck`
- `npm test`
- `npm run typecheck:e2e`
- `npm run lint:obsidian`
- `npm run test:e2e`
- `npm run check:release`

All commands passed locally. The e2e run passed against Obsidian v1.12.7 with installer v1.5.8 on macOS.

## Status Summary

| Priority | Finding | Status | Fix or decision | Commit |
| --- | --- | --- | --- | --- |
| P1 | Valid Markdown heading forms can fail or be corrupted | Deferred / no fix planned | Support for indented ATX headings and closing-hash headings is intentionally out of scope for now. | n/a |
| P1 | Rename, find references, and migration rewrite links inside code examples | Deferred / no fix planned for rename/find | Renaming and finding links inside code blocks is acceptable for current behavior. Migration behavior remains documented as part of the same scanner limitation. | n/a |
| P2 | Generated links containing escaped `>` are not recognized later | Fixed | Wrapped markdown destinations are parsed with escaped characters, normalized before matching, and re-escaped when rewritten; regression covers `>` in headings and filenames. | `25caca8` |
| P2 | Markdown link labels that render as the old heading can remain stale | Open | Needs a fix that compares rendered/unescaped markdown labels before deciding whether to update the label. | n/a |
| P2 | Wikilink rewrites can create broken links for new names containing wikilink syntax characters | Open | Needs validation or safe construction for wikilink heading fragments and aliases containing `|`, `]]`, newlines, and related syntax characters. | n/a |
| P2 | Target-format migration can drop extra stable markers from headings | Fixed | Migration converts source-format markers in place while preserving unrelated stable markers; regression covers mixed marker headings in both directions. | `4ee1bd3` |
| P3 | Relative copy mode may create ambiguous or non-portable links | Fixed as terminology / behavior retained | The UI and README now call `./filename.md` mode "Basename" so it no longer implies a source-relative path. | `7f27b53` |
| P3 | GitHub Actions does not run the WebdriverIO e2e suite | Fixed | CI caches `.obsidian-cache/`, typechecks e2e files, and runs WebdriverIO through `xvfb-run`. | `8a18413` |

## Findings

### P1: Valid Markdown heading forms can fail or be corrupted

Status: Deferred / no fix planned. Support for indented ATX headings and closing-hash headings is intentionally out of scope for now.

Affected code:

- `main.ts:339` parses headings only with `^(#{1,6}\s+)(.*)$`.
- `main.ts:426` counts duplicate headings using only `parseHeadingLine`.
- `main.ts:396` can fall back to an empty heading prefix when parsing fails.
- `main.ts:410` refuses to rename when parsing fails.

The custom heading parser does not handle valid ATX headings with up to three leading spaces, such as `  ## Intro`, or closing hash sequences, such as `## Intro ##`.

Impact:

- Rename can show `Could not parse heading line.` for headings that Obsidian may still treat as headings.
- Copying a duplicate indented heading can be worse: duplicate counting may return `0`, then `ensureHeadingTargetFormat` can build a replacement with an empty prefix, turning a heading into plain text like `Intro ^intro-abc123`.
- Closing-ATX headings are treated as visible text including the trailing `##`, so copied fragments and renamed headings can be wrong.

Possible fix if this is revisited:

Use Obsidian metadata for visible heading text when possible, and make `parseHeadingLine` Markdown-compatible for optional 0-3 leading spaces and closing hash sequences before target markers. Add unit tests for:

- `  ## Intro`
- `## Intro ##`
- `  ## Intro ## ^intro-id`

### P1: Rename, find references, and migration rewrite links inside code examples

Status: Deferred / no fix planned for rename/find. Renaming and finding links inside code blocks is acceptable for current behavior.

Affected code:

- `main.ts:736` rewrites every line in a file.
- `main.ts:611`, `main.ts:638`, and `main.ts:661` match links with regexes without Markdown context.
- `main.ts:1059` builds migration plans by scanning every line the same way.

The rewrite and migration logic does not skip fenced code blocks, indented code blocks, inline code, or HTML code/pre blocks. A note containing documentation such as:

````md
```md
[[Target#Intro]]
```
````

would have the example rewritten during a heading rename or target-format migration.

Impact:

- User documentation, snippets, templates, or examples can be mutated even though they are not real references.
- `Find heading references...` will also report these examples as live references.

Possible fix if this is revisited:

Track Markdown code context before applying line-level regexes, or use a Markdown parser/tokenizer for link collection and rewriting. At minimum, skip fenced blocks and inline-code ranges, then add tests for links inside and outside code fences.

### P2: Generated links containing escaped `>` are not recognized later

Status: Fixed in `25caca8`. Wrapped markdown destinations are now parsed with escaped characters, normalized before matching, and re-escaped when rewritten.

Affected code:

- `main.ts:301` escapes `>` in generated markdown destinations.
- `main.ts:638` parses wrapped markdown destinations with `<[^>\n]+>`.
- `main.ts:829` strips wrappers without unescaping destination escapes.

The plugin can generate a link for a heading containing `>`:

```md
[A > B](<./Target.md#A \> B>)
```

But the wrapped-destination regex stops at the escaped `>`, so the link is not detected by find/rename/migration. Even with an escape-aware regex, `stripDestinationWrapper` would still need to unescape `\>` before comparing the fragment to the heading text.

Impact:

- Links generated by the plugin can become invisible to the plugin's own rename/reference tooling.
- Users with headings or file names containing `>` may get stale links after rename.

Implemented fix:

Replace destination regex parsing with an escape-aware scanner for markdown link destinations. Normalize escaped destination text before comparing fragments. Add a regression test for a heading named `A > B`.

### P2: Markdown link labels that render as the old heading can remain stale

Status: Open. No fix has been applied yet.

Affected code:

- `main.ts:305` escapes copied markdown link labels.
- `main.ts:645` updates a markdown label only when the raw label string equals `target.oldName`.

For headings containing markdown-special label characters, copied labels are escaped. For example, `A [bracket]` is generated as `A \[bracket\]`. On rename, the destination can be updated, but the label comparison fails because the raw label is escaped and the old heading text is not.

Impact:

- Display text can remain stale for links generated by this plugin.
- This conflicts with the README promise that matching display aliases are updated.

Suggested fix:

Compare the rendered/unescaped markdown label with `oldName`, then rewrite the label with `escapeMarkdownLinkText(newName)`. Add tests for brackets and backslashes in heading names.

### P2: Wikilink rewrites can create broken links for new names containing wikilink syntax characters

Status: Open. No fix has been applied yet.

Affected code:

- `main.ts:620` replaces wikilink subpaths with raw `target.newName`.
- `main.ts:623` writes aliases with raw `target.newName`.

The rename modal allows arbitrary heading names after `trim()`. If the new heading contains characters meaningful to wikilinks, such as `|`, `]]`, or a newline, a rewritten link like `[[Target#A | B|A | B]]` can become ambiguous or broken.

Impact:

- Renaming a heading to text that is valid Markdown heading content can produce invalid or mis-targeted wikilinks.
- Markdown links are safer because label text is escaped, but wikilinks have no equivalent escaping here.

Suggested fix:

Validate or encode wikilink heading fragments and aliases before writing them. If Obsidian has a helper for linktext construction, prefer it over string concatenation. Add tests for `|`, `]`, and newline rejection/handling.

### P2: Target-format migration can drop extra stable markers from headings

Status: Fixed. Target-format migration now converts source-format markers in place while preserving unrelated target markers on the same heading line. Regression coverage checks mixed HTML-anchor and Obsidian-block markers in both conversion directions.

Affected code:

- `main.ts:977` selects only the first source-format target marker.
- `main.ts:982` rebuilds the heading with only one target marker.
- `main.ts:391` can preserve multiple markers, but migration does not use it.

The parser supports headings with multiple targets, such as:

```md
## Intro <a id="intro-a"></a> ^intro-b
```

But the conversion flow rebuilds the line with a single converted marker. Converting block-to-HTML can drop the existing HTML anchor and replace it with an anchor derived from the block ID; converting HTML-to-block can similarly drop an existing block ID.

Impact:

- Existing stable links can break after running `Convert Heading Link Target Format`.
- The migration preview may look correct for the selected source ID while silently removing other valid targets on the same heading line.

Implemented fix:

Convert only the relevant source-format markers while preserving unrelated target markers. Add migration tests for headings containing both target formats.

### P3: Relative copy mode may create ambiguous or non-portable links

Status: Fixed as terminology in `7f27b53`; behavior is retained. The setting and README now describe this as Basename mode rather than a relative path mode.

Affected code:

- `main.ts:243` uses `./${file.name}` for relative path mode.
- `main.ts:1596` labels the setting as "File Path Format".

Relative mode always emits only the basename, such as `./Note.md`, regardless of the target file's folder. This is documented in the README, but it can still surprise users because it is not relative to the note where the link is eventually pasted.

Impact:

- Links copied from nested notes can resolve incorrectly when pasted outside the target note's folder.
- Vaults with duplicate basenames can produce ambiguous links.

Implemented fix:

Rename the setting and documentation to "Basename" vs "Full vault path". A source-aware relative path mode was not added.

### P3: GitHub Actions does not run the WebdriverIO e2e suite

Status: Fixed in `8a18413`. CI now typechecks and runs the WebdriverIO e2e suite.

Affected code:

- `.github/workflows/release.yml:29` runs `npm run check:release`.
- `package.json:16` defines `check:release` without `typecheck:e2e` or `test:e2e`.

The real Obsidian/WebdriverIO tests are available and pass locally, but CI only runs version checks, TypeScript, lint, Vitest, and build.

Impact:

- Regressions in command registration, modal behavior, editor integration, and vault rewrites can reach the default branch.

Implemented fix:

Add CI steps for:

```bash
npm run typecheck:e2e
xvfb-run -a npm run test:e2e
```

Cache `.obsidian-cache/` to reduce Obsidian download time.

## Coverage Notes

Current strengths:

- Unit tests cover source-aware rewrites, escaped markdown destinations, stable IDs, active-editor line rewrites, duplicate heading counting, and line-ending preservation.
- Integration tests cover duplicate target insertion, rename across mocked vault files, and target-format migration preserving mixed target markers.
- WebdriverIO e2e tests cover plugin loading, copy behavior, cross-note rename behavior, and stable-id alias behavior in real Obsidian.

Recommended next tests:

- Heading parsing edge cases: indented ATX headings and closing hash headings.
- Rename/find/migration behavior around fenced code blocks and inline code.
- Markdown label alias rewrites for escaped label text.
- Wikilink rewrites for new heading names containing `|`, `]`, `#`, and newline.
