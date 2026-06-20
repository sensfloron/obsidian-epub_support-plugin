import { FileView, Platform, TFile, WorkspaceLeaf, MarkdownRenderer } from "obsidian";
import { EpubPluginSettings } from "../setting/settings";
import { initSync as initParseSync, EpubHandle } from "../lib/epub_parse_module/pkg/epub_parse_module";
import { initSync as initNoteSync, TextProcessor } from "../lib/epub_note_module/pkg/epub_note_module";
import { EpubPaginator } from "./epub_paginator";
import { EpubProgress, ProgressStore } from "../lib/progress_store";
import { ProgressTracker } from "../lib/progress_tracker";
import { TocItem } from "./epub_outline_view";
import { FootnoteManager } from "./footnote_manager";
import { ImageViewerController } from "./image_viewer_controller";

export const EPUB_FILE_EXTENSION = "epub";
export const VIEW_TYPE_EPUB = "epub";
export const ICON_EPUB = "doc-epub";
const TITLEPAGE_INDEX = -1;

const PARSE_WASM_PATH = ".obsidian/plugins/obsidian-epub_support-plugin/epub_parse_module_bg.wasm";
const NOTE_WASM_PATH = ".obsidian/plugins/obsidian-epub_support-plugin/epub_note_module_bg.wasm";
const FONTS_DIR = ".obsidian/plugins/obsidian-epub_support-plugin/fonts";

let parseWasmReady = false;
let noteWasmReady = false;
let fontCssCache: string | null = null;

async function loadFontCss(read: (path: string) => Promise<string>, readBinary: (path: string) => Promise<ArrayBuffer>): Promise<string> {
    if (fontCssCache) return fontCssCache;

    const CODE_STYLES = `
pre, code {
    font-family: var(--font-monospace);
    color: var(--code-normal);
}
pre {
    background: var(--code-background);
    border: 1px solid var(--background-modifier-border);
    border-radius: 4px;
    padding: 12px 16px;
    overflow-x: auto;
    white-space: pre;
    line-height: 1.5;
}
:not(pre) > code {
    background: var(--code-background);
    color: var(--code-normal);
    border-radius: 3px;
    padding: 2px 5px;
    font-size: 0.9em;
}`;

    try {
        let css = await read(`${FONTS_DIR}/hack-subset.css`);

        const fontFiles = [
            "hack-regular-subset.woff2",
            "hack-bold-subset.woff2",
            "hack-italic-subset.woff2",
            "hack-bolditalic-subset.woff2",
        ];

        for (const file of fontFiles) {
            const data = await readBinary(`${FONTS_DIR}/${file}`);
            const bytes = new Uint8Array(data);
            let binary = '';
            for (let i = 0; i < bytes.length; i++) {
                binary += String.fromCharCode(bytes[i]);
            }
            const base64 = btoa(binary);
            css = css.replace(
                `url('fonts/${file}')`,
                `url('data:font/woff2;base64,${base64}')`
            );
        }

        css += CODE_STYLES;
        fontCssCache = css;
    } catch {
        fontCssCache = CODE_STYLES;
    }

    return fontCssCache;
}

async function initParseWasmOnce(readBinary: (path: string) => Promise<ArrayBuffer>): Promise<void> {
    if (parseWasmReady) return;
    const bin = await readBinary(PARSE_WASM_PATH);
    initParseSync({ module: new Uint8Array(bin) });
    parseWasmReady = true;
}

async function initNoteWasmOnce(readBinary: (path: string) => Promise<ArrayBuffer>): Promise<void> {
    if (noteWasmReady) return;
    const bin = await readBinary(NOTE_WASM_PATH);
    initNoteSync({ module: new Uint8Array(bin) });
    noteWasmReady = true;
}

export class EpubView extends FileView {
    allowNoFile: false = false;
    private handle: EpubHandle | null = null;
    private textProcessor: TextProcessor | null = null;
    private currentChapter = 0;
    private firstContentChapterIndex = 0;
    private showingTitlePage = false;
    private tocData: TocItem[] = [];
    private contentArea: HTMLElement | null = null;
    private paginator: EpubPaginator | null = null;
    private actionsAdded = false;
    private footnoteManager: FootnoteManager;
    private imageViewerController: ImageViewerController;
    private progressTracker: ProgressTracker;
    private selectionBar: HTMLElement | null = null;
    private viewHeaderHoverCleanup: (() => void) | null = null;
    private immersiveActive = false;
    onPositionChange: ((label: string) => void) | null = null;
    onProgressSave: (() => void) | null = null;
    onTocReady: ((toc: TocItem[]) => void) | null = null;
    onChapterChange: ((index: number) => void) | null = null;

    constructor(
        leaf: WorkspaceLeaf,
        private settings: EpubPluginSettings,
        private progressStore: ProgressStore,
    ) {
        super(leaf);
        this.progressTracker = new ProgressTracker(progressStore, () => this.onProgressSave?.());
        this.imageViewerController = new ImageViewerController(this.contentEl);
        this.footnoteManager = new FootnoteManager(this.contentEl, {
            onImageClick: (img) => {
                // 翻页动画中屏蔽图片查看，避免误触
                if (this.paginator?.isAnimating()) return;
                this.imageViewerController.show(img);
            },
            onContentChanged: () => this.highlightCodeBlocks(),
        });
    }

    async onLoadFile(file: TFile): Promise<void> {
        this.contentEl.empty();

        await Promise.all([
            initParseWasmOnce((p) => this.app.vault.adapter.readBinary(p)),
            initNoteWasmOnce((p) => this.app.vault.adapter.readBinary(p)),
        ]);

        await this.ensureFontStyle();

        const epubData = new Uint8Array(
            await this.app.vault.adapter.readBinary(file.path)
        );

        this.handle?.free();
        this.handle = new EpubHandle(epubData);
        this.textProcessor = new TextProcessor();
        this.currentChapter = 0;

        this.buildAndPublishToc();

        this.addViewActions();
        this.footnoteManager.install();
        this.registerDomEvent(this.contentEl, "click", this.footnoteManager.handleClick);

        // Check for saved progress before rendering
        const savedProgress = this.progressStore.getProgress(file.path);
        let startWithTitlePage = false;

        if (savedProgress && savedProgress.totalChapters === this.handle.total_chapters()) {
            // Restore chapter position
            this.currentChapter = Math.min(savedProgress.chapterIndex, this.handle.total_chapters() - 1);
        } else {
            // 首次打开：展示扉页
            this.currentChapter = this.firstContentChapterIndex;
            startWithTitlePage = true;
        }

        if (this.settings.viewMode === 'scrolled') {
            this.renderAllChapters();
            if (savedProgress && savedProgress.scrollFraction > 0) {
                requestAnimationFrame(() => {
                    const el = this.contentEl.querySelector('.epub-content');
                    if (el) {
                        el.scrollTop = savedProgress.scrollFraction * el.scrollHeight;
                    }
                });
            }
        } else {
            this.paginator?.destroy();
            this.paginator = new EpubPaginator(this.settings);
            this.paginator.onChapterBoundary = (dir) => this.navigateChapter(dir);
        if (Platform.isDesktop) {
            this.paginator.disableClickZones = true;
            this.setupViewHeaderHover();
            this.immersiveActive = this.settings.immersiveDefault;
            if (this.immersiveActive) {
                requestAnimationFrame(() => {
                    document.body.classList.add("epub-immersive");
                });
            }
        } else {
            this.paginator.onCenterTap = () => {
                this.immersiveActive = !this.immersiveActive;
                if (this.immersiveActive) {
                    requestAnimationFrame(() => {
                        document.body.classList.add("epub-immersive");
                    });
                } else {
                    document.body.classList.remove("epub-immersive");
                }
            };
            this.immersiveActive = true;
            requestAnimationFrame(() => {
                document.body.classList.add("epub-immersive");
            });
        }

            this.paginator.setOnPageChange(() => {
                this.notifyPositionChange();
                const p = this.buildProgress();
                if (p) this.progressTracker.schedule(p);
            });

            this.contentArea = this.contentEl.createDiv("epub-content");
            this.paginator.attach(this.contentArea);

            if (startWithTitlePage) {
                this.showTitlePage(0);
            } else {
                const rawHtml = this.handle.get_chapter_content(this.currentChapter);
                const markedHtml = this.textProcessor.mark_sentences(rawHtml);
                this.paginator.loadChapter(markedHtml);

                // Restore page if progress exists
                if (savedProgress && savedProgress.pageIndex != null) {
                    const pageIndex = savedProgress.pageIndex;
                    requestAnimationFrame(() => {
                        requestAnimationFrame(() => {
                            this.paginator?.goToPage(pageIndex);
                        });
                    });
                } else {
                    const p = this.buildProgress();
                    if (p) this.progressTracker.save(p);
                }
            }
        }

        this.footnoteManager.enhance();
        this.highlightCodeBlocks();
        this.notifyPositionChange();
        this.onChapterChange?.(this.currentChapter);
        this.registerKeyboard();
        this.registerSelectionEvents();
        }

    // ── Progress persistence (delegated to ProgressTracker) ──

    private buildProgress(): EpubProgress | null {
        if (!this.handle || !this.file) return null;
        const total = this.handle.total_chapters();
        return {
            epubPath: this.file.path,
            chapterIndex: this.currentChapter,
            pageIndex: this.paginator?.getPageInfo().current ?? 0,
            sentenceIndex: this.paginator?.getFirstVisibleSentenceIndex() ?? 0,
            scrollFraction: 0,
            totalChapters: total,
            lastReadAt: 0,
            completionPercent: total > 0
                ? Math.round(((this.currentChapter + 1) / total) * 100)
                : 0,
        };
    }

    private highlightCodeBlocks(): void {
        const container =
            this.contentEl.querySelector(".epub-paginated-track") ??
            this.contentEl.querySelector(".epub-content");
        if (!container) return;

        const preElements = container.querySelectorAll("pre");
        preElements.forEach((pre) => {
            if (pre.querySelector(".code-block-pre")) return;

            const text = pre.textContent ?? "";
            if (!text.trim()) return;

            const md = "```\n" + text + "\n```";
            const wrapper = document.createElement("span");
            MarkdownRenderer.render(
                this.app,
                md,
                wrapper,
                "",
                this
            ).then(() => {
                const rendered = wrapper.querySelector(".markdown-rendered pre");
                if (rendered) {
                    pre.replaceWith(rendered);
                }
                wrapper.remove();
            });
        });
    }

    private async ensureFontStyle(): Promise<void> {
        if (document.head.querySelector("style.epub-font-style")) return;

        const css = await loadFontCss(
            (p) => this.app.vault.adapter.read(p),
            (p) => this.app.vault.adapter.readBinary(p)
        );
        const styleEl = document.createElement("style");
        styleEl.className = "epub-font-style";
        styleEl.textContent = css;
        document.head.appendChild(styleEl);
    }

    private setupViewHeaderHover(): void {
        this.viewHeaderHoverCleanup?.();

        const leafEl = this.containerEl.closest('.workspace-leaf') as HTMLElement | null;
        const viewHeader = leafEl?.querySelector('.view-header') as HTMLElement | null;
        console.debug("[epub-immersive] leafEl:", leafEl, "viewHeader:", viewHeader);
        if (!viewHeader) return;

        let wasInHeader = false;

        const onMouseMove = (e: MouseEvent) => {
            if (!this.immersiveActive) return;
            const rect = viewHeader.getBoundingClientRect();
            const inHeader = (
                e.clientX >= rect.left &&
                e.clientX <= rect.right &&
                e.clientY >= rect.top &&
                e.clientY <= rect.bottom
            );
            if (inHeader && !wasInHeader) {
                console.debug("[epub-immersive] enter header → remove immersive");
                document.body.classList.remove("epub-immersive");
            } else if (!inHeader && wasInHeader) {
                console.debug("[epub-immersive] leave header → add immersive");
                document.body.classList.add("epub-immersive");
            }
            wasInHeader = inHeader;
        };

        document.addEventListener('mousemove', onMouseMove);

        this.viewHeaderHoverCleanup = () => {
            document.removeEventListener('mousemove', onMouseMove);
        };
    }

    private addViewActions(): void {
        if (this.actionsAdded) return;
        this.actionsAdded = true;

        if (this.settings.viewMode === 'paginated') {
            this.addAction('arrow-left', '上一页', () => {
                if (this.paginator) this.paginator.navigatePage(-1);
            });
            this.addAction('arrow-right', '下一页', () => {
                if (this.paginator) this.paginator.navigatePage(1);
            });
        } else {
            this.addAction('arrow-left', '上一章', () => this.navigateChapter(-1));
            this.addAction('arrow-right', '下一章', () => this.navigateChapter(1));
        }

    }

    private buildAndPublishToc(): void {
        if (!this.handle) return;
        try {
            const rawToc = this.handle.get_toc() as { label: string; href: string; children: never[] }[];
            if (!rawToc || rawToc.length === 0) return;

            // Build href → chapter index map from spine paths
            const hrefToIndex = new Map<string, number>();
            const total = this.handle.total_chapters();
            for (let i = 0; i < total; i++) {
                const path = this.handle.get_spine_item_path(i);
                if (path) hrefToIndex.set(path, i);
            }

            const resolveIndex = (href: string): number => {
                const clean = href.split("#")[0];
                const match = hrefToIndex.get(clean);
                if (match !== undefined) return match;
                for (const [p, idx] of hrefToIndex) {
                    if (p.endsWith(clean) || clean.endsWith(p)) return idx;
                }
                return 0;
            };

            const transform = (items: typeof rawToc): TocItem[] =>
                items.map((item) => ({
                    label: item.label,
                    href: item.href,
                    chapterIndex: resolveIndex(item.href),
                    children: item.children ? transform(item.children) : [],
                }));

            const rawTocData = transform(rawToc);

            // 取第一个目录项的章节索引作为首个内容章节，用于跳过前置内容
            this.firstContentChapterIndex = rawTocData?.[0]?.chapterIndex ?? 0;

            // 在目录最前面插入扉页条目
            const titlePageEntry: TocItem = {
                label: "扉页",
                href: "",
                chapterIndex: TITLEPAGE_INDEX,
                children: [],
            };
            this.tocData = [titlePageEntry, ...rawTocData];
            this.onTocReady?.(this.tocData);
        } catch {
            // Ignore TOC errors
        }
    }

    private findChapterBreadcrumb(items: TocItem[], target: number, path: string[]): string[] | null {
        if (target === TITLEPAGE_INDEX) return ["扉页"];
        for (const item of items) {
            const current = [...path, item.label];
            if (item.chapterIndex === target) return current;
            if (item.children.length > 0) {
                const found = this.findChapterBreadcrumb(item.children, target, current);
                if (found) return found;
            }
        }
        return null;
    }

    private updateViewHeaderTitle(): void {
        const leafEl = this.containerEl.closest('.workspace-leaf') as HTMLElement | null;
        const titleEl = leafEl?.querySelector('.view-header-title') as HTMLElement | null;
        if (!titleEl) return;

        if (this.showingTitlePage) {
            titleEl.textContent = '扉页';
            return;
        }

        const breadcrumb = this.findChapterBreadcrumb(this.tocData, this.currentChapter, []);
        if (!breadcrumb || breadcrumb.length === 0) {
            titleEl.textContent = this.file?.basename ?? 'EPUB';
            return;
        }

        if (Platform.isDesktop) {
            let html = '<span class="epub-vh-hash">#</span> ' + breadcrumb
                .map((label, i) => {
                    const escaped = this.escapeHtml(label);
                    if (i === breadcrumb.length - 1) return `<span class="epub-vh-current">${escaped}</span>`;
                    return `<span>${escaped}</span> <span class="epub-vh-sep">|</span>`;
                })
                .join(' ');
            titleEl.innerHTML = html;
        } else {
            titleEl.textContent = breadcrumb[0];
        }
    }

    private escapeHtml(s: string): string {
        const div = document.createElement('div');
        div.textContent = s;
        return div.innerHTML;
    }

    private notifyPositionChange(): void {
        this.updateViewHeaderTitle();
        if (this.onPositionChange) {
            this.onPositionChange(this.getPositionLabel());
        }
    }

    getPositionLabel(): string {
        const total = this.handle?.total_chapters() ?? 0;
        if (total === 0) return "无内容";

        if (this.showingTitlePage) {
            if (this.settings.viewMode === 'paginated' && this.paginator) {
                const page = this.paginator.getPageInfo();
                return `扉页 — ${page.current + 1} / ${page.total} 页`;
            }
            return "扉页";
        }

        if (this.settings.viewMode === 'paginated' && this.paginator) {
            const page = this.paginator.getPageInfo();
            return `第 ${this.currentChapter + 1} / ${total} 章 — ${page.current + 1} / ${page.total} 页`;
        }
        return `第 ${this.currentChapter + 1} / ${total} 章`;
    }

    getTocData(): TocItem[] {
        return this.tocData;
    }

    applyImmersiveMode(): void {
        if (!Platform.isDesktop) return;
        this.immersiveActive = this.settings.immersiveDefault;
        if (this.immersiveActive) {
            document.body.classList.add("epub-immersive");
        } else {
            document.body.classList.remove("epub-immersive");
        }
    }

    getCurrentChapter(): number {
        return this.showingTitlePage ? TITLEPAGE_INDEX : this.currentChapter;
    }

    navigateToChapter(index: number): void {
        if (index === TITLEPAGE_INDEX) {
            if (!this.showingTitlePage) {
                this.showTitlePage(0);
            }
            return;
        }
        if (this.showingTitlePage) {
            this.showingTitlePage = false;
            if (index === this.currentChapter) {
                // Force reload the chapter to replace the title page
                this.navigateChapter(0);
                return;
            }
        }
        const delta = index - this.currentChapter;
        if (delta !== 0) this.navigateChapter(delta);
    }

    private navigateChapter(delta: number): void {
        if (!this.handle || !this.textProcessor) return;

        // 从第一个内容章节往回翻：展示生成的扉页，跳过前置内容
        if (delta === -1 && !this.showingTitlePage && this.currentChapter === this.firstContentChapterIndex) {
            this.showTitlePage();
            return;
        }

        // 从扉页往后翻：回到第一个内容章节
        if (delta === 1 && this.showingTitlePage) {
            this.hideTitlePage();
            return;
        }

        // 从扉页往回翻：已到边界，不做任何操作
        if (delta === -1 && this.showingTitlePage) {
            return;
        }

        const total = this.handle.total_chapters();
        const next = this.currentChapter + delta;
        if (next < 0 || next >= total) return;
        this.showingTitlePage = false;
        this.currentChapter = next;

        if (this.settings.viewMode === 'paginated' && this.paginator) {
            const rawHtml = this.handle.get_chapter_content(this.currentChapter);
            const markedHtml = this.textProcessor.mark_sentences(rawHtml);
            this.paginator.loadChapter(markedHtml, delta as -1 | 0 | 1);
        } else {
            this.scrollToChapter(this.currentChapter);
        }
        this.footnoteManager.enhance();
        this.notifyPositionChange();
        this.onChapterChange?.(this.currentChapter);
        this.progressTracker.flush();
    }

    private showTitlePage(direction: -1 | 0 = -1): void {
        if (!this.handle || !this.textProcessor || !this.paginator) return;
        this.showingTitlePage = true;
        const rawHtml = this.handle.generate_titlepage();
        const markedHtml = this.textProcessor.mark_sentences(rawHtml);
        this.paginator.loadChapter(markedHtml, direction);
        this.footnoteManager.enhance();
        this.notifyPositionChange();
        this.onChapterChange?.(TITLEPAGE_INDEX);
    }

    private hideTitlePage(): void {
        if (!this.handle || !this.textProcessor || !this.paginator) return;
        this.showingTitlePage = false;
        const rawHtml = this.handle.get_chapter_content(this.firstContentChapterIndex);
        const markedHtml = this.textProcessor.mark_sentences(rawHtml);
        this.paginator.loadChapter(markedHtml, 1);
        this.footnoteManager.enhance();
        this.notifyPositionChange();
        this.onChapterChange?.(this.currentChapter);
        this.progressTracker.flush();
    }

    private scrollToChapter(index: number): void {
        const el = document.getElementById(`epub-chapter-${index}`);
        el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    private renderAllChapters(): void {
        if (!this.handle || !this.textProcessor) return;
        this.contentArea = this.contentEl.createDiv("epub-content");
        for (let i = 0, n = this.handle.total_chapters(); i < n; i++) {
            const el = this.contentArea.createDiv("epub-chapter");
            el.id = `epub-chapter-${i}`;
            const rawHtml = this.handle.get_chapter_content(i);
            el.innerHTML = this.textProcessor.mark_sentences(rawHtml);
        }
    }

    private registerKeyboard(): void {
        if (this.settings.viewMode !== 'paginated') return;
        this.registerDomEvent(document, 'keydown', (evt: KeyboardEvent) => {
            if (!this.paginator) return;
            if (this.app.workspace.getActiveViewOfType(EpubView) !== this) return;
            const tag = (evt.target as HTMLElement)?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA') return;

            switch (evt.key) {
                case 'ArrowLeft':
                case 'PageUp':
                    evt.preventDefault();
                    this.paginator.navigatePage(-1);
                    break;
                case 'ArrowRight':
                case ' ':
                case 'PageDown':
                    evt.preventDefault();
                    this.paginator.navigatePage(1);
                    break;
            }
        });
    }

    onunload(): void {
        this.footnoteManager.dispose();
        this.imageViewerController.dispose();
        // Save final progress before any DOM changes that could trigger resize
        this.progressTracker.flush();
        this.progressTracker.dispose();
        document.body.classList.remove("epub-immersive");
        document.body.style.overflow = "";
        this.paginator?.destroy();
        this.paginator = null;
        this.textProcessor?.free();
            this.viewHeaderHoverCleanup?.();
            this.viewHeaderHoverCleanup = null;
        this.textProcessor = null;
        this.handle?.free();
        this.handle = null;
    }

    getDisplayText() {
        return this.file ? this.file.basename : "No File";
    }

    canAcceptExtension(extension: string) {
        return extension === EPUB_FILE_EXTENSION;
    }

    getViewType() {
        return EPUB_FILE_EXTENSION;
    }

    getIcon() {
        return ICON_EPUB;
    }

    // ── Selection support ──

    private registerSelectionEvents(): void {
        this.registerDomEvent(document, 'mouseup', this.onSelectionMouseUp);
        this.registerDomEvent(document, 'mousedown', this.onSelectionMouseDown);
    }

    private onSelectionMouseDown = (evt: MouseEvent): void => {
        if (this.selectionBar && !this.selectionBar.contains(evt.target as Node)) {
            this.hideSelectionBar();
        }
    };

    private onSelectionMouseUp = (evt: MouseEvent): void => {
        const { clientX, clientY } = evt;
        setTimeout(() => {
            const selection = window.getSelection();
            if (!selection || selection.isCollapsed || !selection.toString().trim()) {
                this.hideSelectionBar();
                return;
            }

            if (!selection.anchorNode || !this.contentEl.contains(selection.anchorNode)) {
                this.hideSelectionBar();
                return;
            }

            this.showSelectionBar(clientX, clientY);
        }, 10);
    };

    private ensureSelectionBar(): void {
        if (this.selectionBar) return;

        this.selectionBar = this.contentEl.createDiv("epub-selection-bar");

        const copyBtn = this.selectionBar.createEl("button", { cls: "copy-btn" });
        copyBtn.setText("复制");
        copyBtn.addEventListener("mousedown", (e) => {
            e.preventDefault();
            e.stopPropagation();
            navigator.clipboard.writeText(window.getSelection()?.toString() ?? "");
            this.hideSelectionBar();
            window.getSelection()?.removeAllRanges();
        });
    }

    private showSelectionBar(clientX: number, clientY: number): void {
        const FALLBACK_WIDTH = 120;
        const FALLBACK_HEIGHT = 32;
        const MARGIN = 8;
        const GAP = 12;

        this.ensureSelectionBar();
        if (!this.selectionBar) return;

        const barRect = this.selectionBar.getBoundingClientRect();
        const barW = barRect.width || FALLBACK_WIDTH;
        const barH = barRect.height || FALLBACK_HEIGHT;

        let left = clientX - barW / 2;
        let top = clientY - barH - GAP;

        left = Math.max(MARGIN, Math.min(left, window.innerWidth - barW - MARGIN));

        if (top < MARGIN) {
            top = clientY + GAP;
        }

        if (top + barH > window.innerHeight - MARGIN) {
            top = window.innerHeight - barH - MARGIN;
        }

        this.selectionBar.setCssProps({
            position: "fixed",
            left: `${left}px`,
            top: `${top}px`,
        });
        this.selectionBar.addClass("visible");
    }

    private hideSelectionBar(): void {
        this.selectionBar?.removeClass("visible");
    }
}
