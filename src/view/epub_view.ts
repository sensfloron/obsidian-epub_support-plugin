import { FileView, Platform, TFile, WorkspaceLeaf } from "obsidian";
import { EpubPluginSettings } from "../setting/settings";
import { initSync as initParseSync, EpubHandle } from "../lib/epub_parse_module/pkg/epub_parse_module";
import { initSync as initNoteSync, TextProcessor,
    get_combined_theme_css,
} from "../lib/epub_note_module/pkg/epub_note_module";
import { EpubPaginator } from "./epub_paginator";
import { EpubProgress, ProgressStore } from "../lib/progress_store";
import { ProgressTracker } from "../lib/progress_tracker";
import { TocItem } from "./epub_outline_view";
import { FootnoteManager } from "./footnote_manager";
import { ImageViewerController } from "./image_viewer_controller";
import { NavigationHistory, ReadingLocation } from "./navigation_history";

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
}

/* ── 语法高亮 CSS 由 Rust/WASM 动态生成并注入到 epub-syntax-theme-style ── */
`;

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
    private codeCopyResetTimer: number | null = null;
    private codeCopyClickRegistered = false;
    private mouseButtonRegistered = false;
    /** 浏览器风格的双栈阅读位置历史（仅当前会话，不持久化）。 */
    private navHistory = new NavigationHistory();
    /** 历史回退/前进执行期间为 true，用于抑制四大跳转方法里的二次入栈。 */
    private isRestoringHistory = false;
    /** 最近一次 onLoadFile 处理的文件路径，用于检测文件切换以清空历史。 */
    private lastLoadedPath: string | null = null;
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
            onContentChanged: () => {
                this.highlightCodeBlocks();
                this.decorateCodeBlocks();
            },
        });
    }

    async onLoadFile(file: TFile): Promise<void> {
        // 切换到不同的 EPUB 文件时，清空阅读历史（历史不跨文件）
        if (this.lastLoadedPath !== null && this.lastLoadedPath !== file.path) {
            this.navHistory.clear();
        }
        this.lastLoadedPath = file.path;
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
                // 恢复进度时直接把 initialPage 传给 loadChapter，加载即定位到
                // 目标页，避免「先渲染 p0 再 rAF 跳转」的视觉闪烁。
                const restorePage = savedProgress?.pageIndex ?? undefined;
                this.paginator.loadChapter(markedHtml, 0, restorePage);

                const p = this.buildProgress();
                if (p) this.progressTracker.save(p);
            }
        }

        this.footnoteManager.enhance();
        this.highlightCodeBlocks();
        this.decorateCodeBlocks();
        if (!this.codeCopyClickRegistered) {
            this.registerDomEvent(this.contentEl, "click", this.handleCodeCopyClick);
            this.codeCopyClickRegistered = true;
        }
        this.notifyPositionChange();
        this.onChapterChange?.(this.currentChapter);
        this.registerKeyboard();
        this.registerSelectionEvents();
        if (!this.mouseButtonRegistered) {
            this.registerDomEvent(this.contentEl, "mousedown", this.handleMouseButtons);
            this.mouseButtonRegistered = true;
        }
        }

    // ── Progress persistence (delegated to ProgressTracker) ──

    /**
     * 离开当前文件时立即落盘进度。
     *
     * FileView 的生命周期里，切换标签 / 关闭标签 / 打开别的文件触发的是
     * onUnloadFile，而非 onunload（后者只在 view 彻底销毁时触发）。
     * 翻页保存走的是 300ms debounce（progressTracker.schedule），若在窗口
     * 内离开文件且不在此 flush，pending 进度会丢失，重开时回到上次 flush
     * 的旧位置（往往是章节首页）—— 这正是「重开文件进度回到章节首页」
     * 的根因。
     */
    async onUnloadFile(file: TFile): Promise<void> {
        this.progressTracker.flush();
    }

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
        if (!container || !this.textProcessor) return;

        // 仅处理未被 Rust 侧标记的 <pre> 块（如脚注动态注入的内容）
        const unhighlighted = Array.from(
            container.querySelectorAll("pre")
        ).filter((pre) => {
            // 已由 Rust 高亮 → 含有 tok- class
            if (pre.querySelector("[class*='tok-']")) return false;
            // 已由 Obsidian MarkdownRenderer 处理
            if (pre.querySelector(".code-block-pre")) return false;
            // 已由本方法处理过
            if (pre.hasAttribute("data-epub-highlighted")) return false;
            return true;
        });

        for (const pre of unhighlighted) {
            const text = pre.textContent ?? "";
            if (!text.trim()) continue;

            try {
                // 包装为 <pre> 以便 highlight_code_blocks() 识别
                const highlighted = this.textProcessor.highlight_code_blocks(
                    `<pre>${text}</pre>`
                );
                const temp = document.createElement("div");
                temp.innerHTML = highlighted;
                const newPre = temp.querySelector("pre");
                if (newPre) {
                    newPre.setAttribute("data-epub-highlighted", "");
                    pre.replaceWith(newPre);
                }
                temp.remove();
            } catch (err) {
                console.debug("[epub] highlightCodeBlocks WASM error:", err);
            }
        }
    }

    /**
     * 为每个代码块包装一层带「语言标签 + 复制按钮」的头部容器。
     *
     * 幂等：用 `data-epub-copy` 标记已处理的 `<pre>`，重复调用安全。
     * 覆盖两条高亮路径产出的 `<pre>`：Rust mark_sentences 内联高亮、
     * 以及 highlightCodeBlocks() 的脚注路径。按钮放在 `<pre>` 外部，
     * 不污染其 textContent（复制时不会带上按钮文字）。
     */
    private decorateCodeBlocks(): void {
        const container =
            this.contentEl.querySelector(".epub-paginated-track") ??
            this.contentEl.querySelector(".epub-content");
        if (!container) return;

        const pres = Array.from(container.querySelectorAll("pre")).filter((pre) => {
            // 已包装过 → 跳过
            if (pre.parentElement?.classList.contains("epub-code-block")) return false;
            // 空内容 → 跳过
            if (!(pre.textContent ?? "").trim()) return false;
            // Obsidian MarkdownRenderer 自己的代码块 → 不接管
            if (pre.querySelector(".code-block-pre")) return false;
            return true;
        });

        for (const pre of pres) {
            // 从 class="language-X" 解析语言名
            const langMatch = pre.className.match(/language-([\w-]+)/);
            const lang = langMatch ? langMatch[1] : "";

            const wrapper = document.createElement("div");
            wrapper.className = "epub-code-block";
            wrapper.setAttribute("data-epub-copy", "");

            const header = document.createElement("div");
            header.className = "epub-code-header";

            const langLabel = document.createElement("span");
            langLabel.className = "epub-code-lang";
            langLabel.textContent = lang || "code";

            const copyBtn = document.createElement("button");
            copyBtn.className = "epub-copy-btn";
            copyBtn.type = "button";
            copyBtn.textContent = "复制";

            header.appendChild(langLabel);
            header.appendChild(copyBtn);
            wrapper.appendChild(header);

            // 用 wrapper 包裹 pre（保留 pre 在 DOM 中，事件委托自动覆盖）
            pre.parentElement?.insertBefore(wrapper, pre);
            wrapper.appendChild(pre);
        }
    }

    /**
     * 代码块复制按钮的点击处理（事件委托，挂在 contentEl 上）。
     *
     * 命中 `.epub-copy-btn` 时：取同容器内 `<pre>` 的纯文本写入剪贴板，
     * 按钮文字短暂变为「已复制」作为反馈。分页是纯 CSS 列布局不移动节点，
     * highlightCodeBlocks 的 replaceWith 也不影响委托，故无需重新绑定。
     */
    /**
     * 鼠标侧键（X1/X2 thumb buttons）映射为阅读历史的回退/前进，
     * 对齐 Chrome/Edge 浏览器侧键行为。
     *
     * MouseEvent.button: 3 = X1(后退), 4 = X2(前进)。
     * 历史栈非空时拦截（preventDefault），避免 Electron 把侧键
     * 解释为应用级 back/forward 导航；栈空时放行，让默认行为兜底。
     */
    private handleMouseButtons = (evt: MouseEvent): void => {
        if (evt.button === 3) {
            if (this.navHistory.canGoBack()) {
                evt.preventDefault();
                this.goBack();
            }
        } else if (evt.button === 4) {
            if (this.navHistory.canGoForward()) {
                evt.preventDefault();
                this.goForward();
            }
        }
    };

    private handleCodeCopyClick = (evt: MouseEvent): void => {
        const target = evt.target as HTMLElement | null;
        const btn = target?.closest(".epub-copy-btn") as HTMLButtonElement | null;
        if (!btn) return;

        evt.preventDefault();
        evt.stopPropagation();

        const pre = btn.closest(".epub-code-block")?.querySelector("pre");
        const text = pre?.textContent ?? "";
        if (!text) return;

        // 防抖：快速连点时先清掉上一次的恢复 timer
        if (this.codeCopyResetTimer !== null) {
            window.clearTimeout(this.codeCopyResetTimer);
            this.codeCopyResetTimer = null;
        }

        try {
            navigator.clipboard.writeText(text).then(
                () => {
                    btn.textContent = "已复制";
                    btn.classList.add("copied");
                    this.codeCopyResetTimer = window.setTimeout(() => {
                        btn.textContent = "复制";
                        btn.classList.remove("copied");
                        this.codeCopyResetTimer = null;
                    }, 1500);
                },
                (err) => {
                    console.warn("[epub] clipboard writeText rejected:", err);
                    btn.textContent = "复制失败";
                    this.codeCopyResetTimer = window.setTimeout(() => {
                        btn.textContent = "复制";
                        this.codeCopyResetTimer = null;
                    }, 1500);
                },
            );
        } catch (err) {
            // navigator.clipboard 不可用（老版 webview）
            console.warn("[epub] clipboard API unavailable:", err);
            btn.textContent = "复制失败";
            this.codeCopyResetTimer = window.setTimeout(() => {
                btn.textContent = "复制";
                this.codeCopyResetTimer = null;
            }, 1500);
        }
    };

    private async ensureFontStyle(): Promise<void> {
        if (!document.head.querySelector("style.epub-font-style")) {
            const css = await loadFontCss(
                (p) => this.app.vault.adapter.read(p),
                (p) => this.app.vault.adapter.readBinary(p)
            );
            const styleEl = document.createElement("style");
            styleEl.className = "epub-font-style";
            styleEl.textContent = css;
            document.head.appendChild(styleEl);
        }

        // 语法高亮主题 CSS —— 注入一次，通过 CSS 级联自动跟随 Obsidian 主题切换
        this.ensureSyntaxThemeStyle();
    }

    /**
     * 注入语法高亮 CSS（仅调用一次）。
     *
     * 生成的 CSS 同时包含亮色（默认）和暗色（body.theme-dark 覆写）规则，
     * 浏览器会根据 body 的 class 自动应用正确的主题颜色，
     * 无需 JavaScript 监听 Obsidian 主题切换。
     */
    private ensureSyntaxThemeStyle(): void {
        if (!noteWasmReady) return;
        if (document.head.querySelector("style.epub-syntax-theme-style")) return;

        try {
            const css = get_combined_theme_css();
            const styleEl = document.createElement("style");
            styleEl.className = "epub-syntax-theme-style";
            styleEl.textContent = css;
            document.head.appendChild(styleEl);
        } catch (err) {
            console.warn("[epub] Failed to generate syntax theme CSS:", err);
        }
    }

    private setupViewHeaderHover(): void {
        this.viewHeaderHoverCleanup?.();

        const leafEl = this.containerEl.closest('.workspace-leaf') as HTMLElement | null;
        const viewHeader = leafEl?.querySelector('.view-header') as HTMLElement | null;
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
                document.body.classList.remove("epub-immersive");
            } else if (!inHeader && wasInHeader) {
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

    // ── 导航历史（浏览器同款 back/forward） ──

    /** 当前阅读位置的快照。扉页用 TITLEPAGE_INDEX。 */
    private currentLocation(): ReadingLocation {
        return {
            chapterIndex: this.showingTitlePage ? TITLEPAGE_INDEX : this.currentChapter,
            pageIndex: this.paginator?.getPageInfo().current ?? 0,
            showingTitlePage: this.showingTitlePage,
        };
    }

    /**
     * 在一次"大跳转"（目录跳转、跨章、扉页切换）执行**前**调用，
     * 把当前位置压入历史栈。逐页翻页不走这里 → 不入栈，与浏览器
     * "翻滚/小步移动不入历史"的语义一致。历史回退/前进执行期间
     * 被抑制，避免无限入栈。
     */
    private pushHistorySnapshot(): void {
        if (this.isRestoringHistory) return;
        this.navHistory.push(this.currentLocation());
    }

    /** 浏览器后退：回退一步（若有历史）。 */
    private goBack(): void {
        const target = this.navHistory.back(this.currentLocation());
        if (target) this.restoreLocation(target);
    }

    /** 浏览器前进：前进一步（若有历史）。 */
    private goForward(): void {
        const target = this.navHistory.forward(this.currentLocation());
        if (target) this.restoreLocation(target);
    }

    /**
     * 恢复到指定位置。复用现有的跳转路径（扉页 / 章节加载），
     * 在 isRestoringHistory 包裹下执行以抑制二次入栈，跳转完成后
     * 用 paginator.goToPage 精确还原页码。
     */
    private restoreLocation(loc: ReadingLocation): void {
        if (!this.handle || !this.paginator) return;

        this.isRestoringHistory = true;
        try {
            if (loc.showingTitlePage) {
                // 目标是扉页
                if (!this.showingTitlePage) {
                    this.showTitlePage(0);
                }
                this.restorePage(loc.pageIndex);
                return;
            }

            // 目标是正文章节
            const targetChapter = Math.min(
                Math.max(0, loc.chapterIndex),
                this.handle.total_chapters() - 1,
            );

            if (this.showingTitlePage) {
                // 从扉页离开：hideTitlePage 总是加载 firstContentChapterIndex，
                // 因此若目标不是首章，需先离开扉页再 navigateChapter 到目标章。
                this.hideTitlePage();
                if (targetChapter !== this.firstContentChapterIndex) {
                    const delta = targetChapter - this.firstContentChapterIndex;
                    if (delta !== 0) this.navigateChapter(delta);
                }
                this.restorePage(loc.pageIndex);
                return;
            }

            // 当前已在正文
            if (targetChapter !== this.currentChapter) {
                const delta = targetChapter - this.currentChapter;
                this.navigateChapter(delta);
            }
            this.restorePage(loc.pageIndex);
        } finally {
            this.isRestoringHistory = false;
        }
    }

    /**
     * 跳转完成后还原章节内页码。loadChapter 的内容重排在 rAF 后才稳定，
     * 因此用双层 requestAnimationFrame 确保 goToPage 命中正确的总页数。
     */
    private restorePage(pageIndex: number): void {
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                this.paginator?.goToPage(pageIndex);
                this.notifyPositionChange();
            });
        });
    }

    navigateToChapter(index: number): void {
        this.pushHistorySnapshot();
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
            this.pushHistorySnapshot();
            this.showTitlePage();
            return;
        }

        // 从扉页往后翻：回到第一个内容章节
        if (delta === 1 && this.showingTitlePage) {
            this.pushHistorySnapshot();
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
        this.pushHistorySnapshot();
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
        // 翻章后 track DOM 被整体重建（paginator.loadChapter 的 innerHTML 赋值），
        // 之前的 .epub-code-block 包装随之销毁，必须重新 decorate 才能恢复语言标签和复制按钮。
        // scrolled 模式下 DOM 在文件打开时已预渲染，此处调用幂等无害。
        this.decorateCodeBlocks();
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
        this.decorateCodeBlocks();
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
        this.decorateCodeBlocks();
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
        // 浏览器同款回退/前进：Alt+Left / Alt+Right。
        // 两种阅读模式都生效；EPUB 视图激活时拦截，避免触发 Obsidian 面板切换。
        this.registerDomEvent(document, 'keydown', (evt: KeyboardEvent) => {
            if (this.app.workspace.getActiveViewOfType(EpubView) !== this) return;
            const tag = (evt.target as HTMLElement)?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA') return;
            if (!evt.altKey || evt.ctrlKey || evt.metaKey || evt.shiftKey) return;

            if (evt.key === 'ArrowLeft') {
                if (this.navHistory.canGoBack()) {
                    evt.preventDefault();
                    this.goBack();
                }
                return;
            }
            if (evt.key === 'ArrowRight') {
                if (this.navHistory.canGoForward()) {
                    evt.preventDefault();
                    this.goForward();
                }
                return;
            }
        });

        if (this.settings.viewMode !== 'paginated') return;
        this.registerDomEvent(document, 'keydown', (evt: KeyboardEvent) => {
            if (!this.paginator) return;
            if (this.app.workspace.getActiveViewOfType(EpubView) !== this) return;
            const tag = (evt.target as HTMLElement)?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA') return;
            // 带 Alt 的是历史导航，交给上面的处理器；带 Ctrl/Meta 的留给 Obsidian
            if (evt.altKey || evt.ctrlKey || evt.metaKey) return;

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
        this.navHistory.clear();
        this.lastLoadedPath = null;
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
