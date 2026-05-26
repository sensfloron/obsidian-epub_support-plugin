import { FileView, Platform, TFile, WorkspaceLeaf, MarkdownRenderer } from "obsidian";
import { EpubPluginSettings, PAGE_TURN_COOLDOWN_MS } from "../setting/settings";
import { initSync as initParseSync, EpubHandle } from "../lib/epub_parse_module/pkg/epub_parse_module";
import { initSync as initNoteSync, TextProcessor } from "../lib/epub_note_module/pkg/epub_note_module";
import { EpubPaginator } from "./epub_paginator";
import { EpubProgress, ProgressStore } from "../lib/progress_store";
import { TocItem } from "./epub_outline_view";

export const EPUB_FILE_EXTENSION = "epub";
export const VIEW_TYPE_EPUB = "epub";
export const ICON_EPUB = "doc-epub";

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

const SAVE_DEBOUNCE_MS = 300;


export class EpubView extends FileView {
    allowNoFile: false = false;
    private handle: EpubHandle | null = null;
    private textProcessor: TextProcessor | null = null;
    private currentChapter = 0;
    private tocData: TocItem[] = [];
    private contentArea: HTMLElement | null = null;
    private paginator: EpubPaginator | null = null;
    private actionsAdded = false;
    private footnotePopover: HTMLElement | null = null;
    private footnoteBackdrop: HTMLElement | null = null;
    private imageViewerBackdrop: HTMLElement | null = null;
    private imageViewerOverlay: HTMLElement | null = null;
    private imageViewerImg: HTMLImageElement | null = null;
    private imageViewerCloseBtn: HTMLElement | null = null;
    private imageViewerGifBadge: HTMLElement | null = null;
    private imageViewerScale = 1;
    private imageViewerPanX = 0;
    private imageViewerPanY = 0;
    private imageViewerPanning = false;
    private imageViewerPanStartX = 0;
    private imageViewerPanStartY = 0;
    private imageViewerPanOrigX = 0;
    private imageViewerPanOrigY = 0;
    private imageViewerPinchStartDist = 0;
    private imageViewerPinchStartScale = 1;
    private imageViewerTouchInEdgeZone = false;
    private fnObserver: MutationObserver | null = null;
    private saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    private lastKeyTime = 0;
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
        this.ensureFootnoteInfrastructure();

        // Check for saved progress before rendering
        const savedProgress = this.progressStore.getProgress(file.path);

        if (savedProgress && savedProgress.totalChapters === this.handle.total_chapters()) {
            // Restore chapter position
            this.currentChapter = Math.min(savedProgress.chapterIndex, this.handle.total_chapters() - 1);
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
                this.debounceSaveProgress();
            });

            this.contentArea = this.contentEl.createDiv("epub-content");
            this.paginator.attach(this.contentArea);

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
                this.saveCurrentProgress();
            }
        }

        this.enhanceFootnoteRefs();
        this.observeContentChanges();
        this.highlightCodeBlocks();
        this.notifyPositionChange();
        this.onChapterChange?.(this.currentChapter);
        this.registerKeyboard();
        this.registerSelectionEvents();
        }

    private saveCurrentProgress(): void {
        if (!this.handle || !this.file) return;

        const total = this.handle.total_chapters();
        const progress: EpubProgress = {
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

        this.progressStore.setProgress(progress);
    }

    private debounceSaveProgress(): void {
        if (this.saveDebounceTimer) clearTimeout(this.saveDebounceTimer);
        this.saveDebounceTimer = setTimeout(() => {
            this.saveCurrentProgress();
            this.onProgressSave?.();
        }, SAVE_DEBOUNCE_MS);
    }

    private flashSaveProgress(): void {
        if (this.saveDebounceTimer) clearTimeout(this.saveDebounceTimer);
        this.saveCurrentProgress();
        this.onProgressSave?.();
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

            this.tocData = transform(rawToc);
            this.onTocReady?.(this.tocData);
        } catch {
            // Ignore TOC errors
        }
    }

    private findChapterBreadcrumb(items: TocItem[], target: number, path: string[]): string[] | null {
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

        if (this.settings.viewMode === 'paginated' && this.paginator) {
            const page = this.paginator.getPageInfo();
            return `第 ${this.currentChapter + 1} / ${total} 章 — ${page.current + 1} / ${page.total} 页`;
        }
        return `第 ${this.currentChapter + 1} / ${total} 章`;
    }

    getTocData(): TocItem[] {
        return this.tocData;
    }

    getCurrentChapter(): number {
        return this.currentChapter;
    }

    navigateToChapter(index: number): void {
        const delta = index - this.currentChapter;
        if (delta !== 0) this.navigateChapter(delta);
    }

    private navigateChapter(delta: number): void {
        if (!this.handle || !this.textProcessor) return;
        const total = this.handle.total_chapters();
        const next = this.currentChapter + delta;
        if (next < 0 || next >= total) return;
        this.currentChapter = next;

        if (this.settings.viewMode === 'paginated' && this.paginator) {
            const rawHtml = this.handle.get_chapter_content(this.currentChapter);
            const markedHtml = this.textProcessor.mark_sentences(rawHtml);
            this.paginator.loadChapter(markedHtml, delta as -1 | 0 | 1);
        } else {
            this.scrollToChapter(this.currentChapter);
        }
        this.enhanceFootnoteRefs();
        this.notifyPositionChange();
        this.onChapterChange?.(this.currentChapter);
        this.flashSaveProgress();
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
            if (this.app.workspace.activeLeaf !== this.leaf) return;
            const tag = (evt.target as HTMLElement)?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA') return;

            const now = Date.now();
            if (now - this.lastKeyTime < PAGE_TURN_COOLDOWN_MS) return;

            switch (evt.key) {
                case 'ArrowLeft':
                case 'PageUp':
                    evt.preventDefault();
                    this.lastKeyTime = now;
                    this.paginator.navigatePage(-1);
                    break;
                case 'ArrowRight':
                case ' ':
                case 'PageDown':
                    evt.preventDefault();
                    this.lastKeyTime = now;
                    this.paginator.navigatePage(1);
                    break;
            }
        });
    }

    onunload(): void {
        this.fnObserver?.disconnect();
        this.fnObserver = null;
        if (this.saveDebounceTimer) clearTimeout(this.saveDebounceTimer);
        // Save final progress before any DOM changes that could trigger resize
        this.saveCurrentProgress();
        this.onProgressSave?.();
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

    // ── Footnote support ──

    private ensureFootnoteInfrastructure(): void {
        if (this.footnotePopover) return;

        this.footnoteBackdrop = this.contentEl.createDiv("epub-footnote-backdrop");
        this.footnoteBackdrop.hide();
        this.footnoteBackdrop.addEventListener("click", () => this.hideFootnotePopover());

        this.footnotePopover = this.contentEl.createDiv("epub-footnote-popover");
        this.footnotePopover.hide();

        this.registerDomEvent(
            this.contentEl,
            "click",
            this.onFootnoteClick
        );
    }

    private observeContentChanges(): void {
        this.fnObserver?.disconnect();
        const track = this.contentEl.querySelector(".epub-paginated-track");
        if (track) {
            this.fnObserver = new MutationObserver(() => {
                this.enhanceFootnoteRefs();
                this.highlightCodeBlocks();
            });
            this.fnObserver.observe(track, { childList: true, subtree: true });
        }
    }

    private enhanceFootnoteRefs(): void {
        const container =
            this.contentEl.querySelector(".epub-paginated-track") ??
            this.contentEl.querySelector(".epub-content");
        if (!container) return;

        this.fnObserver?.disconnect();

        const links = container.querySelectorAll("a[href^='#']");
        links.forEach((link) => {
            if (link.classList.contains("fn-ref")) return;

            const href = link.getAttribute("href");
            if (!href || href === "#") return;

            const isRef =
                link.getAttribute("epub:type") === "noteref" ||
                link.classList.contains("footnote-ref") ||
                link.closest("sup") !== null ||
                /^(?:fnref|ftnref|noteref|endnoteref)/i.test(link.id);

            if (isRef) {
                link.classList.add("fn-ref");
            }
        });

        const fnImgs = container.querySelectorAll(
            "img.qqreader-footnote, img.duokan-footnote, img[class*='footnote']"
        );
        fnImgs.forEach((img) => {
            if (!img.classList.contains("fn-img")) {
                img.classList.add("fn-img");
            }
        });

        this.observeContentChanges();
    }

    private isFootnoteRef(el: HTMLElement): boolean {
        if (el.classList.contains("fn-ref")) return true;
        const href = el.getAttribute("href");
        if (!href || !href.startsWith("#")) return false;
        if (el.getAttribute("epub:type") === "noteref") return true;
        if (el.closest("sup") !== null) return true;
        if (/^(?:fnref|ftnref|noteref|endnoteref)/i.test(el.id)) return true;
        return false;
    }

    private findFootnoteContent(href: string): HTMLElement | null {
        const id = href.replace(/^#/, "");
        if (!id) return null;

        const target = document.getElementById(id);
        if (!target) return null;

        if (
            target.getAttribute("epub:type") === "footnote" ||
            target.tagName === "ASIDE" ||
            target.classList.contains("footnote") ||
            target.classList.contains("footnotes") ||
            target.classList.contains("endnote") ||
            /fn|footnote|endnote/i.test(target.className)
        ) {
            return target;
        }

        const ancestor = target.closest(
            "aside, .footnote, .footnotes, .endnote, [epub\\:type='footnote'], li.footnote"
        );
        if (ancestor) return ancestor as HTMLElement;

        if (target.textContent?.trim()) return target;

        return null;
    }

    private onFootnoteClick = (evt: MouseEvent): void => {
        const target = evt.target as HTMLElement;

        if (target.closest(".epub-footnote-popover")) {
            this.hideFootnotePopover();
            return;
        }

        // 图片查看器内的点击不处理
        if (target.closest(".epub-image-overlay")) {
            return;
        }

        // 正文图片 → 仅中央 75% 区域打开图片查看器，边缘留给翻页
        const contentImg = target.closest(
            "img:not(.fn-img):not(.qqreader-footnote):not(.duokan-footnote):not([class*='footnote'])"
        ) as HTMLImageElement | null;
        if (contentImg) {
            const imgRect = contentImg.getBoundingClientRect();
            const clickRelX = evt.clientX - imgRect.left;
            const margin = imgRect.width * 0.125;
            if (clickRelX > margin && clickRelX < imgRect.width - margin) {
                evt.preventDefault();
                evt.stopPropagation();
                this.ensureImageViewerInfrastructure();
                this.showImageViewer(contentImg);
            }
            return;
        }

        const fnImg = target.closest(
            "img.fn-img, img.qqreader-footnote, img.duokan-footnote, img[class*='footnote']"
        ) as HTMLImageElement | null;
        if (fnImg) {
            evt.preventDefault();
            evt.stopPropagation();
            this.showFootnotePopoverForImage(fnImg, evt);
            return;
        }

        const ref = target.closest("a[href^='#']") as HTMLAnchorElement | null;
        if (!ref) return;

        if (!this.isFootnoteRef(ref)) return;

        evt.preventDefault();
        evt.stopPropagation();

        const href = ref.getAttribute("href");
        if (!href) return;

        const fnContent = this.findFootnoteContent(href);
        if (!fnContent) return;

        this.showFootnotePopoverForElement(fnContent, evt);
    }

    private showFootnotePopoverForElement(fnEl: HTMLElement, evt: MouseEvent): void {
        if (!this.footnotePopover || !this.footnoteBackdrop) return;

        const clone = fnEl.cloneNode(true) as HTMLElement;
        clone.querySelectorAll("a[href^='#']").forEach((a) => {
            a.classList.add("fn-backlink");
        });

        const numEl = clone.querySelector("sup, .footnote-num, .fn-num");
        const numText = numEl?.textContent?.trim() ?? "";

        this.footnotePopover.empty();
        if (numText) {
            this.footnotePopover.createSpan({ cls: "fn-num", text: numText });
        }
        this.footnotePopover.createSpan({ cls: "fn-text" }).appendChild(clone);
        this.footnotePopover.show();
        this.footnoteBackdrop.show();

        this.positionPopover(evt);
    }

    private showFootnotePopoverForImage(img: HTMLImageElement, evt: MouseEvent): void {
        if (!this.footnotePopover || !this.footnoteBackdrop) return;

        const altText = img.getAttribute("alt")?.trim() ?? "";
        const titleText = img.getAttribute("title")?.trim() ?? "";
        const content = altText || titleText;
        if (!content) return;

        this.footnotePopover.empty();
        this.footnotePopover.createSpan({ cls: "fn-text", text: content });
        this.footnotePopover.show();
        this.footnoteBackdrop.show();

        this.positionPopover(evt);
    }

    private positionPopover(evt: MouseEvent): void {
        if (!this.footnotePopover) return;

        const popoverRect = this.footnotePopover.getBoundingClientRect();
        const popoverW = popoverRect.width || 300;
        const popoverH = popoverRect.height || 150;

        let left = evt.clientX - popoverW / 2;
        let top = evt.clientY - popoverH - 12;

        left = Math.max(8, Math.min(left, window.innerWidth - popoverW - 8));

        if (top < 8) {
            top = evt.clientY + 20;
        }

        if (top + popoverH > window.innerHeight - 8) {
            top = window.innerHeight - popoverH - 8;
        }

        this.footnotePopover.setCssProps({
            position: "fixed",
            left: `${left}px`,
            top: `${top}px`,
        });
    }

    private hideFootnotePopover(): void {
        this.footnotePopover?.hide();
        this.footnoteBackdrop?.hide();
    }

    // ── Image viewer ──

    private ensureImageViewerInfrastructure(): void {
        if (this.imageViewerBackdrop) return;

        this.imageViewerBackdrop = this.contentEl.createDiv("epub-image-backdrop");
        this.imageViewerBackdrop.hide();

        this.imageViewerOverlay = this.imageViewerBackdrop.createDiv("epub-image-overlay");
        this.imageViewerImg = this.imageViewerOverlay.createEl("img");

        this.imageViewerCloseBtn = this.contentEl.createEl("button", { cls: "epub-image-close-btn" });
        this.imageViewerCloseBtn.setText("×");
        this.imageViewerCloseBtn.hide();

        this.imageViewerGifBadge = this.imageViewerOverlay.createDiv("epub-image-gif-badge");
        this.imageViewerGifBadge.setText("GIF");
        this.imageViewerGifBadge.hide();

        // 屏蔽 Obsidian 移动端非边缘手势：
        // - 边缘区域（左右各 24px）放行，保留侧边栏边缘滑动
        // - 图片区域由 img 自身 handler 处理（缩放/拖拽）
        // - 其余区域屏蔽（阻止任意位置触发侧边栏和命令面板）
        this.imageViewerBackdrop.addEventListener("touchstart", (e) => {
            const edgeW = 24;
            const touchX = e.touches[0]?.clientX ?? 0;
            this.imageViewerTouchInEdgeZone =
                touchX < edgeW || touchX > window.innerWidth - edgeW;
            if (!this.imageViewerTouchInEdgeZone) {
                e.stopPropagation();
            }
        }, { passive: true });
        this.imageViewerBackdrop.addEventListener("touchmove", (e) => {
            if (!this.imageViewerTouchInEdgeZone) {
                e.preventDefault();
                e.stopPropagation();
            }
        }, { passive: false });
        this.imageViewerBackdrop.addEventListener("touchend", () => {
            this.imageViewerTouchInEdgeZone = false;
        });

        // 点击背景关闭
        this.imageViewerBackdrop.addEventListener("click", (e) => {
            if (e.target === this.imageViewerBackdrop) this.hideImageViewer();
        });

        // 关闭按钮
        this.imageViewerCloseBtn.addEventListener("click", () => this.hideImageViewer());

        // Escape 关闭
        this.registerDomEvent(document, "keydown", (e: KeyboardEvent) => {
            if (e.key === "Escape" && this.imageViewerBackdrop && !this.imageViewerBackdrop.hidden) {
                this.hideImageViewer();
            }
        });

        // 滚轮缩放
        this.imageViewerOverlay.addEventListener("wheel", this.onImageViewerWheel, { passive: false });

        // 鼠标拖拽平移
        this.imageViewerImg.addEventListener("mousedown", this.onImageViewerMouseDown);
        this.registerDomEvent(document, "mousemove", this.onImageViewerMouseMove);
        this.registerDomEvent(document, "mouseup", this.onImageViewerMouseUp);

        // 双击切换缩放
        this.imageViewerImg.addEventListener("dblclick", this.onImageViewerDblClick);

        // 触摸事件（pinch 缩放 + 单指平移）
        this.imageViewerImg.addEventListener("touchstart", this.onImageViewerTouchStart, { passive: false });
        this.imageViewerImg.addEventListener("touchmove", this.onImageViewerTouchMove, { passive: false });
        this.imageViewerImg.addEventListener("touchend", this.onImageViewerTouchEnd);
    }

    private showImageViewer(img: HTMLImageElement): void {
        if (!this.imageViewerBackdrop || !this.imageViewerImg || !this.imageViewerCloseBtn) return;

        const isGif = img.src.startsWith("data:image/gif") || /\.gif/i.test(img.src);

        // 强制重新加载以确保 GIF 从第一帧开始播放
        this.imageViewerImg.src = "";
        // 使用 requestAnimationFrame 确保 src 被清空后再设置新值
        requestAnimationFrame(() => {
            if (!this.imageViewerImg) return;
            this.imageViewerImg.src = img.src;
        });

        // GIF 标记
        if (isGif) {
            this.imageViewerImg.dataset.gif = "true";
            this.imageViewerGifBadge?.show();
        } else {
            delete this.imageViewerImg.dataset.gif;
            this.imageViewerGifBadge?.hide();
        }

        this.imageViewerScale = 1;
        this.imageViewerPanX = 0;
        this.imageViewerPanY = 0;
        this.applyImageViewerTransform();

        this.imageViewerBackdrop.show();
        this.imageViewerCloseBtn.show();
        // 禁止 body 滚动
        document.body.style.overflow = "hidden";
    }

    private hideImageViewer(): void {
        this.imageViewerBackdrop?.hide();
        this.imageViewerCloseBtn?.hide();
        this.imageViewerGifBadge?.hide();
        this.imageViewerPanning = false;
        document.body.style.overflow = "";
        // 清空 src，释放内存并确保下次打开时重新加载
        if (this.imageViewerImg) {
            this.imageViewerImg.src = "";
        }
    }

    private applyImageViewerTransform(): void {
        if (!this.imageViewerImg) return;
        const tx = this.imageViewerPanX;
        const ty = this.imageViewerPanY;
        const s = this.imageViewerScale;
        this.imageViewerImg.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
    }

    private clampPan(): void {
        // 缩放为 1 时不需平移（复位）
        if (this.imageViewerScale <= 1) {
            this.imageViewerPanX = 0;
            this.imageViewerPanY = 0;
            return;
        }
        // 限制平移范围避免图片完全拖出视野
        const s = this.imageViewerScale;
        const maxD = 200 * (s - 1); // 缩放越大允许拖越远
        this.imageViewerPanX = Math.max(-maxD, Math.min(maxD, this.imageViewerPanX));
        this.imageViewerPanY = Math.max(-maxD, Math.min(maxD, this.imageViewerPanY));
    }

    // 滚轮缩放
    private onImageViewerWheel = (e: WheelEvent): void => {
        e.preventDefault();
        const delta = -e.deltaY * 0.005;
        const prev = this.imageViewerScale;
        this.imageViewerScale = Math.max(0.5, Math.min(5, this.imageViewerScale * (1 + delta)));
        // 以鼠标位置为中心缩放（近似）
        if (this.imageViewerScale !== prev && this.imageViewerScale > 1 && this.imageViewerImg) {
            const rect = this.imageViewerImg.getBoundingClientRect();
            const cx = e.clientX - rect.left;
            const cy = e.clientY - rect.top;
            const factor = this.imageViewerScale / prev - 1;
            this.imageViewerPanX -= cx * factor;
            this.imageViewerPanY -= cy * factor;
        }
        if (this.imageViewerScale <= 1) {
            this.imageViewerPanX = 0;
            this.imageViewerPanY = 0;
        }
        this.clampPan();
        this.applyImageViewerTransform();
    };

    // 鼠标拖拽平移
    private onImageViewerMouseDown = (e: MouseEvent): void => {
        if (this.imageViewerScale <= 1) return;
        e.preventDefault();
        this.imageViewerPanning = true;
        this.imageViewerPanStartX = e.clientX;
        this.imageViewerPanStartY = e.clientY;
        this.imageViewerPanOrigX = this.imageViewerPanX;
        this.imageViewerPanOrigY = this.imageViewerPanY;
        this.imageViewerImg?.addClass("grabbing");
    };

    private onImageViewerMouseMove = (e: MouseEvent): void => {
        if (!this.imageViewerPanning) return;
        this.imageViewerPanX = this.imageViewerPanOrigX + (e.clientX - this.imageViewerPanStartX);
        this.imageViewerPanY = this.imageViewerPanOrigY + (e.clientY - this.imageViewerPanStartY);
        this.clampPan();
        this.applyImageViewerTransform();
    };

    private onImageViewerMouseUp = (): void => {
        this.imageViewerPanning = false;
        this.imageViewerImg?.removeClass("grabbing");
    };

    // 双击切换 1x ↔ 2x
    private onImageViewerDblClick = (e: MouseEvent): void => {
        e.preventDefault();
        if (this.imageViewerScale > 1.1) {
            this.imageViewerScale = 1;
            this.imageViewerPanX = 0;
            this.imageViewerPanY = 0;
        } else {
            this.imageViewerScale = 2;
            this.imageViewerPanX = 0;
            this.imageViewerPanY = 0;
        }
        this.applyImageViewerTransform();
    };

    // 触摸 pinch 缩放
    private onImageViewerTouchStart = (e: TouchEvent): void => {
        if (e.touches.length === 2) {
            e.preventDefault();
            const dx = e.touches[0].clientX - e.touches[1].clientX;
            const dy = e.touches[0].clientY - e.touches[1].clientY;
            this.imageViewerPinchStartDist = Math.hypot(dx, dy);
            this.imageViewerPinchStartScale = this.imageViewerScale;
        } else if (e.touches.length === 1 && this.imageViewerScale > 1) {
            this.imageViewerPanning = true;
            this.imageViewerPanStartX = e.touches[0].clientX;
            this.imageViewerPanStartY = e.touches[0].clientY;
            this.imageViewerPanOrigX = this.imageViewerPanX;
            this.imageViewerPanOrigY = this.imageViewerPanY;
        }
    };

    private onImageViewerTouchMove = (e: TouchEvent): void => {
        if (e.touches.length === 2 && this.imageViewerPinchStartDist > 0) {
            e.preventDefault();
            const dx = e.touches[0].clientX - e.touches[1].clientX;
            const dy = e.touches[0].clientY - e.touches[1].clientY;
            const dist = Math.hypot(dx, dy);
            this.imageViewerScale = Math.max(0.5, Math.min(5,
                this.imageViewerPinchStartScale * (dist / this.imageViewerPinchStartDist)
            ));
            if (this.imageViewerScale <= 1) {
                this.imageViewerPanX = 0;
                this.imageViewerPanY = 0;
            }
            this.applyImageViewerTransform();
        } else if (e.touches.length === 1 && this.imageViewerPanning) {
            this.imageViewerPanX = this.imageViewerPanOrigX + (e.touches[0].clientX - this.imageViewerPanStartX);
            this.imageViewerPanY = this.imageViewerPanOrigY + (e.touches[0].clientY - this.imageViewerPanStartY);
            this.clampPan();
            this.applyImageViewerTransform();
        }
    };

    private onImageViewerTouchEnd = (_e: TouchEvent): void => {
        this.imageViewerPanning = false;
        this.imageViewerPinchStartDist = 0;
    };

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
