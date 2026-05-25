# EPUB Support Plugin for Obsidian

[![GitHub release](https://img.shields.io/github/v/release/sensfloron/obsidian-epub_support-plugin?style=flat-square)](https://github.com/sensfloron/obsidian-epub_support-plugin/releases)
[中文](README.md)

Read and manage EPUB ebooks directly in Obsidian. Built with Rust WASM for high-performance parsing. Supports paginated reading, continuous scrolling, outline navigation, immersive mode, and more.

## Features

- **EPUB Parsing & Rendering** — High-performance EPUB parsing via Rust WASM. Supports chapter content extraction, embedded base64 images, and code block rendering via Obsidian's Markdown renderer
- **Paginated Mode** — CSS multi-column page splitting with 1-4 columns, configurable gap, animation duration. Keyboard, mouse wheel, and touch gesture navigation
- **Scroll Mode** — Continuous vertical scrolling with seamless chapter transitions
- **Outline Navigation** — Hierarchical TOC tree extracted from EPUB structure. Search/filter, collapse-all, auto-scroll to current chapter, click-to-navigate
- **Immersive Reading** — Desktop: auto-hide Obsidian chrome on hover. Mobile: tap-to-toggle. Distraction-free reading persisted as a setting
- **Progress Persistence** — Auto-saves chapter index, page index, sentence index, scroll fraction, and completion percentage
- **Footnote Popovers** — Click footnote references to view content in floating popups
- **Image Viewer** — Full-featured overlay with scroll-wheel zoom, pinch-to-zoom, panning, and double-click toggle

## Installation

### From Release (Recommended)

1. Download `epub_rs-plugin-{version}.zip` from [Releases](https://github.com/sensfloron/obsidian-epub_support-plugin/releases)
2. Extract to `<vault>/.obsidian/plugins/epub_rs-plugin/`
3. For embedded font support, also download `epub_rs-plugin-fonts.zip` and extract to the same directory
4. Restart Obsidian and enable the plugin in Settings

### Build from Source

```bash
# Requires Node.js 18+ and Rust toolchain (wasm32-unknown-unknown)
git clone https://github.com/sensfloron/obsidian-epub_support-plugin.git
cd obsidian-epub_support-plugin
npm ci
npm run build
```

## Usage

1. Place `.epub` files in your Obsidian vault
2. Click an EPUB file to open it in the EPUB reader view
3. Use the outline panel to browse chapters
4. Toggle between paginated/scroll mode in the status bar
5. Adjust reading preferences in plugin settings

## Settings

| Option | Description |
|--------|-------------|
| Default View Mode | Paginated / Scroll |
| Page Turn Mode | Left-right / Up-down |
| Columns | 1-4 |
| Column Gap | CSS value (e.g. `40px`) |
| Animation Duration | Milliseconds |
| Immersive on Startup | Toggle |
| Note Path | Storage location for EPUB notes |

## Development

```bash
npm run dev        # TypeScript watch compilation
npm run dev:wasm   # WASM watch compilation
npm run build      # Full build (WASM + TS + esbuild)
```

## Tech Stack

- TypeScript + esbuild
- Rust → WASM (EPUB parsing, Chinese sentence segmentation)
- Obsidian Plugin API

## License

MIT

## Author

[Floron Eon](https://github.com/sensfloron)
