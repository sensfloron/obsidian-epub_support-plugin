import { EpubPluginSettings } from "../setting/settings";

/** 滚轮事件的最短节流间隔（毫秒），防止高频触发导致过度累积 */
const WHEEL_THROTTLE_MS = 50;

export class EpubPaginator {
    private viewportEl: HTMLElement | null = null;
    private trackEl: HTMLElement | null = null;
    private pageIndicatorEl: HTMLElement | null = null;
    private parentEl: HTMLElement | null = null;

    private currentPage = 0;
    private totalPages = 1;
    private pageWidth = 0;
    private pageHeight = 0;
    private resizeObserver: ResizeObserver | null = null;
    private touchStartX = 0;
    private touchStartY = 0;
    private swipeThreshold = 50;
    private lastWheelTime = 0;
    private clickZoneHandler: ((e: MouseEvent) => void) | null = null;
    private swipeHandled = false;
    private touchInEdgeZone = false;

    /** 章节切换完成后的待执行回调（排队用） */
    private pendingChapterChange: (() => void) | null = null;

    /** 章节切换内部的嵌套超时定时器 */
    private chapterAnimTimeout: ReturnType<typeof setTimeout> | null = null;

    private settings: EpubPluginSettings;
    private onPageChangeCallback: ((current: number, total: number) => void) | null = null;

    /** 桌面端禁用点击翻页区域（改用鼠标滚轮翻页 + 悬停切换沉浸模式） */
    disableClickZones = false;

    /** 当用户翻页超出章节边界时触发。dir: -1（上一章）或 1（下一章） */
    onChapterBoundary: ((direction: -1 | 1) => void) | null = null;

    /** 点击/触控热区中间区域时触发，用于切换沉浸式阅读（显示/隐藏 UI） */
    onCenterTap: (() => void) | null = null;

    constructor(settings: EpubPluginSettings) {
        this.settings = settings;
    }

    attach(parentEl: HTMLElement): void {
        this.parentEl = parentEl;
        this.buildDOM();
        this.bindEvents();
    }

    /**
     * 加载新章节内容。
     *
     * @param direction `1` = 下一章，`-1` = 上一章，`0` = 初始加载。
     * @param initialPage 可选初始页码。用于恢复阅读进度：加载时直接定位
     *    到该页（钳制到 `[0, totalPages-1]`），避免「先渲染 p0 再 rAF
     *    跳到目标页」造成的视觉闪烁。仅在 `direction === 0`（初始加载）
     *    时生效；跨章翻页忽略此参数，仍按 direction 定位到首/末页。
     */
    loadChapter(html: string, direction: -1 | 0 | 1 = 0, initialPage?: number): void {
        if (!this.viewportEl || !this.trackEl) return;

        const track = this.trackEl;

        this.clearChapterAnimTimeout();
        this.measureViewport();

        // 直接替换内容，无动画
        this.applyTrackStyles();
        track.innerHTML = this.buildChapterHTML(html);

        // 计算总页数
        void track.offsetHeight; // 强制重排，让分列布局生效
        this.totalPages = this.calculateTotalPages();

        // 根据方向设置当前页码
        if (direction === 0) {
            // 初始加载：若指定了 initialPage（恢复进度），直接定位过去，避免闪烁
            if (typeof initialPage === "number" && initialPage > 0) {
                this.currentPage = Math.min(initialPage, Math.max(0, this.totalPages - 1));
            } else {
                this.currentPage = 0;
            }
        } else if (direction === -1) {
            // 后退时定位到最后一页
            this.currentPage = Math.max(0, this.totalPages - 1);
        } else {
            // 前进时定位到第一页
            this.currentPage = 0;
        }

        this.updateTransform();
        this.updatePageIndicator();

        // 处理可能的排队章节切换
        if (this.pendingChapterChange) {
            const next = this.pendingChapterChange;
            this.pendingChapterChange = null;
            next();
        }
    }

    /**
     * 翻页（无动画）。
     */
    navigatePage(delta: number): boolean {
        // 边界检查（基于 currentPage + 本次 delta）
        const nextPage = this.currentPage + delta;
        if (nextPage < 0) {
            this.onChapterBoundary?.(-1);
            return false;
        }
        if (nextPage >= this.totalPages) {
            this.onChapterBoundary?.(1);
            return false;
        }

        // 直接跳转到目标页面
        this.currentPage = nextPage;
        this.updateTransform();
        this.updatePageIndicator();
        this.onPageChangeCallback?.(this.currentPage, this.totalPages);

        return true;
    }

    goToPage(index: number): void {
        if (index < 0 || index >= this.totalPages) return;
        this.currentPage = index;
        this.updateTransform();
        this.updatePageIndicator();
        this.onPageChangeCallback?.(this.currentPage, this.totalPages);
    }

    getPageInfo(): { current: number; total: number } {
        return { current: this.currentPage, total: this.totalPages };
    }

    /** 当前是否处于翻页动画或章节切换动画中（已禁用动画，总是返回 false）。 */
    isAnimating(): boolean {
        return false;
    }

    /** 获取当前页第一个可见句子的 data-si 索引。 */
    getFirstVisibleSentenceIndex(): number {
        if (!this.trackEl || !this.pageWidth) return 0;

        const sentenceNodes = this.trackEl.querySelectorAll<HTMLElement>('.epub-s');
        if (sentenceNodes.length === 0) return 0;

        const sentences = Array.from(sentenceNodes);
        const trackRect = this.trackEl.getBoundingClientRect();
        const visibleLeft = trackRect.left;

        for (const s of sentences) {
            const rect = s.getBoundingClientRect();
            // 句子至少部分可见
            if (rect.right > visibleLeft && rect.left < visibleLeft + this.pageWidth) {
                const si = s.getAttribute('data-si');
                if (si !== null) return parseInt(si, 10);
            }
        }
        return 0;
    }

    setOnPageChange(cb: (current: number, total: number) => void): void {
        this.onPageChangeCallback = cb;
    }

    destroy(): void {
        this.clearChapterAnimTimeout();
        this.unbindEvents();
        this.viewportEl?.remove();
        this.viewportEl = null;
        this.trackEl = null;
        this.pageIndicatorEl = null;
        this.parentEl = null;
    }

    // ── private ──

    private buildDOM(): void {
        if (!this.parentEl) return;

        this.viewportEl = this.parentEl.createDiv("epub-paginated-viewport");
        this.trackEl = this.viewportEl.createDiv("epub-paginated-track");
        this.pageIndicatorEl = this.viewportEl.createDiv("epub-page-indicator");
    }

    private measureViewport(): void {
        if (!this.viewportEl) return;
        const rect = this.viewportEl.getBoundingClientRect();
        this.pageWidth = rect.width;
        this.pageHeight = rect.height || 600;
    }

    private resolveColumnCount(): number {
        // 视口宽度低于阈值时强制单页，适合手机竖屏阅读
        if (this.pageWidth < this.settings.mobileColumnThreshold) return 1;
        return this.settings.columnCount;
    }

    private applyTrackStyles(): void {
        if (!this.trackEl) return;
        const count = this.resolveColumnCount();
        const gap = this.settings.columnGap;
        const totalGap = gap * (count - 1);
        const colWidth = (this.pageWidth - totalGap) / count;

        Object.assign(this.trackEl.style, {
            columnWidth: `${colWidth}px`,
            columnGap: `${gap}px`,
            columnFill: "auto",
            height: `${this.pageHeight}px`,
            width: "auto",
            transition: "none", // 始终禁用动画
        });
    }

    private calculateTotalPages(): number {
        if (!this.trackEl || !this.pageWidth) return 1;
        const scrollW = this.trackEl.scrollWidth;
        return Math.max(1, Math.ceil(scrollW / (this.pageWidth + this.settings.columnGap)));
    }

    private updateTransform(): void {
        if (!this.trackEl) return;
        const x = -this.currentPage * (this.pageWidth + this.settings.columnGap);
        this.applyTrackStyles();
        this.trackEl.style.transform = `translateX(${x}px)`;
    }

    private updatePageIndicator(): void {
        if (!this.pageIndicatorEl) return;
        if (this.totalPages <= 1) {
            this.pageIndicatorEl.removeClass("visible");
            return;
        }
        this.pageIndicatorEl.setText(`${this.currentPage + 1} / ${this.totalPages}`);
        this.pageIndicatorEl.addClass("visible");
        // 2秒后自动隐藏
        clearTimeout(this._indicatorTimeout);
        this._indicatorTimeout = setTimeout(() => {
            this.pageIndicatorEl?.removeClass("visible");
        }, 2000) as unknown as number;
    }

    private _indicatorTimeout = 0;

    private buildChapterHTML(rawHtml: string): string {
        const overrideStyle = `
    <style class="epub-pagination-override" data-epub-paginator="true">
      @scope (.epub-paginated-track) {
        img, svg, video, canvas, iframe, object, embed {
          max-width: 100% !important;
          width: auto !important;
          height: auto !important;
          display: block;
          margin-left: auto !important;
          margin-right: auto !important;
        }
        /* Inline footnote images */
        img.qqreader-footnote,
        img.duokan-footnote,
        img[class*="footnote"] {
          max-width: 1.2em !important;
          max-height: 1.2em !important;
          display: inline !important;
          vertical-align: super;
          margin: 0 !important;
          cursor: pointer;
        }
        pre, code {
          white-space: pre-wrap !important;
          word-break: break-word !important;
          overflow-wrap: break-word !important;
        }
        table {
          max-width: 100% !important;
          word-break: break-word;
        }
        h1, h2, h3, h4, h5, h6 {
          break-after: avoid;
          break-inside: avoid;
        }
        figure, .figure, .image, .illustration, table {
          break-inside: avoid;
        }
        p {
          orphans: 2;
          widows: 2;
        }
        body {
          margin: 0 !important;
          padding: 0 !important;
        }
      }
    </style>`;
        // 在 EPUB 内容之后注入，确保样式优先
        return rawHtml + overrideStyle;
    }

    // ── 累积翻页：动画刹车核心 ──

    /**
     * 直接跳转到指定页面，无动画。
     *
     * @param targetPage  目标页码
     */
    private animateToPage(targetPage: number): void {
        if (!this.trackEl) return;

        // 更新逻辑状态
        this.currentPage = targetPage;

        // 直接设置目标位置，无动画
        this.updateTransform();
        this.updatePageIndicator();
        this.onPageChangeCallback?.(this.currentPage, this.totalPages);
    }


    /** 章节切换完成后的清理（处理排队） */
    private finalizeChapterTransition(): void {
        this.clearChapterAnimTimeout();

        if (this.pendingChapterChange) {
            const next = this.pendingChapterChange;
            this.pendingChapterChange = null;
            next();
        }
    }

    private clearChapterAnimTimeout(): void {
        if (this.chapterAnimTimeout) {
            clearTimeout(this.chapterAnimTimeout);
            this.chapterAnimTimeout = null;
        }
    }

    // ── events ──

    private bindEvents(): void {
        if (!this.viewportEl) return;
        const mode = this.settings.pageTurnMode;

        if (mode === 'swipe' || mode === 'both') {
            this.viewportEl.addEventListener("touchstart", this.onTouchStart, { passive: true });
            this.viewportEl.addEventListener("touchend", this.onTouchEnd, { passive: true });
            this.viewportEl.addEventListener("touchmove", this.onTouchMove, { passive: false });
        }
        if ((mode === 'tap' || mode === 'both') && !this.disableClickZones) {
            this.bindClickZones();
        }

        this.viewportEl.addEventListener("wheel", this.onWheel, { passive: false });

        this.resizeObserver = new ResizeObserver(() => this.onResize());
        this.resizeObserver.observe(this.viewportEl);
    }

    private unbindEvents(): void {
        if (this.viewportEl) {
            this.viewportEl.removeEventListener("touchstart", this.onTouchStart);
            this.viewportEl.removeEventListener("touchend", this.onTouchEnd);
            this.viewportEl.removeEventListener("touchmove", this.onTouchMove);
            this.viewportEl.removeEventListener("wheel", this.onWheel);
            this.unbindClickZones();
        }
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
    }

    private bindClickZones(): void {
        if (!this.viewportEl) return;
        this.clickZoneHandler = (e: MouseEvent) => {
            if (this.swipeHandled) {
                this.swipeHandled = false;
                return;
            }
            // 忽略文本选择拖拽后的 click
            const selection = window.getSelection();
            if (selection && !selection.isCollapsed) return;

            // 脚注链接不翻页，交由 EpubView 处理
            const target = e.target as HTMLElement;
            if (target.closest("a[href^='#']")) return;

            // 脚注小图不翻页；正文图片仅中央 75% 区域打开查看器，边缘留给翻页
            const img = target.closest("img") as HTMLImageElement | null;
            if (img) {
                const isFootnoteImg = img.matches(
                    "img.qqreader-footnote, img.duokan-footnote, img[class*='footnote']"
                );
                if (isFootnoteImg) return;

                const imgRect = img.getBoundingClientRect();
                const clickRelX = e.clientX - imgRect.left;
                const margin = imgRect.width * 0.125;
                if (clickRelX > margin && clickRelX < imgRect.width - margin) return;
            }

            const rect = this.viewportEl!.getBoundingClientRect();
            const relX = e.clientX - rect.left;
            const third = rect.width / 3;

            if (relX < third) {
                this.navigatePage(-1);
            } else if (relX > third * 2) {
                this.navigatePage(1);
            } else {
                this.onCenterTap?.();
            }
        };
        this.viewportEl.addEventListener("click", this.clickZoneHandler);
    }

    private unbindClickZones(): void {
        if (this.viewportEl && this.clickZoneHandler) {
            this.viewportEl.removeEventListener("click", this.clickZoneHandler);
            this.clickZoneHandler = null;
        }
    }

    private onTouchStart = (e: TouchEvent): void => {
        this.touchStartX = e.touches[0].clientX;
        this.touchStartY = e.touches[0].clientY;
        const edgeW = 24;
        this.touchInEdgeZone =
            this.touchStartX < edgeW || this.touchStartX > window.innerWidth - edgeW;
    };

    private onWheel = (e: WheelEvent): void => {
        // 高频节流：防止滚轮一格格触发大量微小累积
        const now = Date.now();
        if (now - this.lastWheelTime < WHEEL_THROTTLE_MS) return;
        this.lastWheelTime = now;

        if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
            // 水平滚动：视为翻页
            if (e.deltaX > 0) {
                this.navigatePage(1);
            } else {
                this.navigatePage(-1);
            }
        } else if (Math.abs(e.deltaY) > 10) {
            // 垂直滚动：视为翻页
            if (e.deltaY > 0) {
                this.navigatePage(1);
            } else {
                this.navigatePage(-1);
            }
        }
    };

    private onTouchMove = (e: TouchEvent): void => {
        if (!this.touchInEdgeZone) {
            e.preventDefault();
            e.stopPropagation();
        }
    };

    private onTouchEnd = (e: TouchEvent): void => {
        // 边缘手势留给 Obsidian 处理侧边栏，不翻页
        if (this.touchInEdgeZone) {
            this.touchInEdgeZone = false;
            return;
        }

        const dx = e.changedTouches[0].clientX - this.touchStartX;
        const dy = e.changedTouches[0].clientY - this.touchStartY;

        if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > this.swipeThreshold) {
            this.swipeHandled = true;
            if (dx < 0) this.navigatePage(1);    // 左滑 = 下一页
            else this.navigatePage(-1);            // 右滑 = 上一页
        }
        this.touchInEdgeZone = false;
    };

    private onResize = (): void => {
        if (!this.trackEl) return;

        this.clearChapterAnimTimeout();

        // 注意：必须保留 currentPage 的绝对值，**不要**用 progress 比例
        // （currentPage / (prevTotal-1)）反推——否则在 loadChapter 与
        // 恢复进度 goToPage 的 rAF 竞争中，onResize 会用过期的 progress
        // （此时 currentPage 仍是加载初值 0）把刚恢复到的页码冲回 0，
        // 导致 schedule(p0) 覆盖正确的进度。这是"重开文件回到章节首页"
        // 的根因。
        const prevTotal = this.totalPages;

        this.measureViewport();
        this.applyTrackStyles();

        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                // 关键修复：在 rAF 回调里**重新读取**此刻的 currentPage，
                // 而不是用闭包里捕获的 prevPage。这样无论本 rAF 相对于
                // loadChapter/goToPage 的 rAF 谁先执行，用的都是最新值：
                // - 若 goToPage 已执行 → currentPage 是恢复的目标页，保留它
                // - 若 goToPage 未执行 → currentPage 是 0，但随后 goToPage
                //   会覆盖它，且我们只在"页码真的变化"时才触发回调，不会
                //   多余地 schedule(0)。
                const livePage = this.currentPage;
                const newTotal = this.calculateTotalPages();
                this.totalPages = newTotal;
                const newPage = livePage >= newTotal
                    ? Math.max(0, newTotal - 1)
                    : livePage;
                const changed = newPage !== livePage || newTotal !== prevTotal;
                this.currentPage = newPage;
                this.updateTransform();
                this.updatePageIndicator();
                if (changed) {
                    this.onPageChangeCallback?.(this.currentPage, this.totalPages);
                }
            });
        });
    };
}
