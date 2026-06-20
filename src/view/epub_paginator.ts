import { EpubPluginSettings } from "../setting/settings";

/** 滚轮事件的最短节流间隔（毫秒），防止高频触发导致过度累积 */
const WHEEL_THROTTLE_MS = 50;

/**
 * 解析 CSS `matrix()` / `matrix3d()` 中的 X 平移值。
 */
function parseTransformX(transform: string): number {
    if (!transform || transform === 'none') return 0;
    const m = transform.match(/matrix(?:3d)?\(([^)]+)\)/);
    if (!m) return 0;
    const vals = m[1].split(",").map(v => parseFloat(v.trim()));
    // matrix(a,b,c,d,tx,ty) → tx = vals[4]
    // matrix3d(a,...,m,n,o,p) → tx = vals[12]
    return vals.length === 16 ? (vals[12] || 0) : (vals[4] || 0);
}

export class EpubPaginator {
    private viewportEl: HTMLElement | null = null;
    private trackEl: HTMLElement | null = null;
    private pageIndicatorEl: HTMLElement | null = null;
    private parentEl: HTMLElement | null = null;

    private currentPage = 0;
    private totalPages = 1;
    private pageWidth = 0;
    private pageHeight = 0;
    private isChapterAnimating = false;
    private resizeObserver: ResizeObserver | null = null;
    private touchStartX = 0;
    private touchStartY = 0;
    private swipeThreshold = 50;
    private lastWheelTime = 0;
    private clickZoneHandler: ((e: MouseEvent) => void) | null = null;
    private swipeHandled = false;
    private touchInEdgeZone = false;

    // ── 累积翻页 + 动画刹车 ──

    /** 累积的翻页偏移量（快速操作累加，动画消费后归零） */
    private accumulatedDelta = 0;

    /** 当前同章节翻页动画（Web Animation），用于读取进度和刹车中断 */
    private pageAnim: Animation | null = null;

    /** 当前动画的起始 translateX（用于计算实时位置） */
    private animStartX = 0;

    /** 当前动画的目标 translateX（用于计算实时位置） */
    private animEndX = 0;

    /** 章节切换动画完成后的待执行回调（排队用） */
    private pendingChapterChange: (() => void) | null = null;

    /** 章节切换动画内部的嵌套超时定时器 */
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
     * 加载新章节内容。`direction`: 1 = 下一章（从右侧滑入），
     * -1 = 上一章（从左侧滑入），0 = 无动画（初始加载）。
     */
    loadChapter(html: string, direction: -1 | 0 | 1 = 0): void {
        if (!this.viewportEl || !this.trackEl) return;

        // 若已在章节切换动画中 → 排队，完成后执行最新的一次
        if (this.isChapterAnimating) {
            this.pendingChapterChange = () => { this.loadChapter(html, direction); };
            return;
        }

        // 取消可能正在运行的同章节翻页动画
        this.pageAnim?.cancel();
        this.pageAnim = null;
        this.accumulatedDelta = 0;

        const track = this.trackEl;
        const dur = this.settings.transitionDuration;

        this.clearChapterAnimTimeout();
        this.isChapterAnimating = true;
        this.measureViewport();

        if (direction === 0) {
            this.applyTrackStyles(false);
            track.innerHTML = this.buildChapterHTML(html);
            this.currentPage = 0;
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    this.totalPages = this.calculateTotalPages();
                    this.updateTransform(false);
                    this.updatePageIndicator();
                    this.finalizeChapterTransition();
                });
            });
            return;
        }

        const pageW = this.pageWidth + this.settings.columnGap;
        const currentX = -this.currentPage * pageW;
        const exitX = currentX + (direction === 1 ? -pageW : pageW);
        const enterX = direction === 1 ? pageW : -pageW;

        // 第一步：将当前内容滑出
        this.applyTrackStyles(true);
        track.style.transform = `translateX(${exitX}px)`;

        this.chapterAnimTimeout = setTimeout(() => {
            // 第二步：在屏幕外替换内容，同时计算页数
            track.style.transition = 'none';
            track.style.transform = `translateX(${enterX}px)`;
            track.innerHTML = this.buildChapterHTML(html);

            // 在屏幕外计算总页数，以便滑入时直接定位到正确的页面
            this.applyTrackStyles(false);
            void track.offsetHeight; // 强制重排，让分列布局生效
            this.totalPages = this.calculateTotalPages();

            // 前进时定位到第一页，后退时定位到最后一页
            this.currentPage = direction === -1
                ? Math.max(0, this.totalPages - 1)
                : 0;

            const targetX = -this.currentPage * pageW;
            const startX = targetX + (direction === 1 ? pageW : -pageW);

            // 设置动画样式并定位到屏幕外
            this.applyTrackStyles(true);
            track.style.transition = 'none';
            track.style.transform = `translateX(${startX}px)`;
            void track.offsetHeight; // 强制重排

            // 第三步：将新内容滑入到正确的页面位置
            track.style.transition = `transform ${dur}ms cubic-bezier(0.4, 0, 0.2, 1)`;
            track.style.transform = `translateX(${targetX}px)`;

            // 第四步：动画结束后，固化布局
            this.chapterAnimTimeout = setTimeout(() => {
                this.applyTrackStyles(false);
                this.updateTransform(false);
                this.updatePageIndicator();
                this.finalizeChapterTransition();
            }, dur);
        }, dur);
    }

    /**
     * 翻页（累积式）。
     *
     * - 如果无动画运行，从当前位置直接启动动画。
     * - 如果已有翻页动画执行中，将 delta 累积后刹车重定向：
     *   - 同方向：继续向更远目标前进
     *   - 反方向：从当前插值位置平滑反向
     */
    navigatePage(delta: number): boolean {
        // 章节切换动画中 → 只累积，暂不处理
        if (this.isChapterAnimating) {
            this.accumulatedDelta += delta;
            return true;
        }

        // 边界检查（基于 currentPage + 本次 delta）
        const nextPage = this.currentPage + delta;
        if (nextPage < 0) {
            this.cancelAnimAndSnap();
            this.accumulatedDelta = 0;
            this.onChapterBoundary?.(-1);
            return false;
        }
        if (nextPage >= this.totalPages) {
            this.cancelAnimAndSnap();
            this.accumulatedDelta = 0;
            this.onChapterBoundary?.(1);
            return false;
        }

        // 累积偏移
        this.accumulatedDelta += delta;

        if (this.pageAnim) {
            // 动画刹车：取消当前动画，从当前位置向新总目标重新启动
            const currentX = this.getCurrentTransformX();
            const targetTotal = this.currentPage + this.accumulatedDelta;

            // 边界检查（基于累积总目标）
            if (targetTotal < 0 || targetTotal >= this.totalPages) {
                this.pageAnim.cancel();
                this.pageAnim = null;
                this.trackEl!.style.transform = `translateX(${currentX}px)`;
                const sign = Math.sign(this.accumulatedDelta) as -1 | 0 | 1;
                this.accumulatedDelta = 0;
                this.onChapterBoundary?.(sign === 1 ? 1 : -1);
                return false;
            }

            this.pageAnim.cancel();
            this.pageAnim = null;

            this.animateToPage(targetTotal, currentX);
        } else {
            // 无动画运行 → 直接启动
            const target = this.currentPage + this.accumulatedDelta;

            if (target < 0 || target >= this.totalPages) {
                this.accumulatedDelta = 0;
                this.onChapterBoundary?.(Math.sign(delta) as -1 | 1);
                return false;
            }

            this.animateToPage(target);
        }
        return true;
    }

    goToPage(index: number): void {
        if (index < 0 || index >= this.totalPages) return;
        // 取消所有运行中的动画
        this.pageAnim?.cancel();
        this.pageAnim = null;
        this.accumulatedDelta = 0;
        this.currentPage = index;
        this.updateTransform(false);
        this.updatePageIndicator();
        this.onPageChangeCallback?.(this.currentPage, this.totalPages);
    }

    getPageInfo(): { current: number; total: number } {
        return { current: this.currentPage, total: this.totalPages };
    }

    /** 当前是否处于翻页动画或章节切换动画中。 */
    isAnimating(): boolean {
        return this.pageAnim !== null || this.isChapterAnimating;
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
        this.pageAnim?.cancel();
        this.pageAnim = null;
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

    private applyTrackStyles(animate: boolean): void {
        if (!this.trackEl) return;
        const count = this.resolveColumnCount();
        const gap = this.settings.columnGap;
        const dur = this.settings.transitionDuration;
        const totalGap = gap * (count - 1);
        const colWidth = (this.pageWidth - totalGap) / count;

        Object.assign(this.trackEl.style, {
            columnWidth: `${colWidth}px`,
            columnGap: `${gap}px`,
            columnFill: "auto",
            height: `${this.pageHeight}px`,
            width: "auto",
            transition: animate
                ? `transform ${dur}ms cubic-bezier(0.4, 0, 0.2, 1)`
                : "none",
        });
    }

    private calculateTotalPages(): number {
        if (!this.trackEl || !this.pageWidth) return 1;
        const scrollW = this.trackEl.scrollWidth;
        return Math.max(1, Math.ceil(scrollW / (this.pageWidth + this.settings.columnGap)));
    }

    private updateTransform(animate: boolean): void {
        if (!this.trackEl) return;
        const x = -this.currentPage * (this.pageWidth + this.settings.columnGap);
        this.applyTrackStyles(animate);
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
     * 使用 Web Animations API 驱动翻页动画，支持中途刹车重定向。
     *
     * @param targetPage  目标页码
     * @param fromX       可选的起始 translateX；不传则读取当前计算值
     */
    private animateToPage(targetPage: number, fromX?: number): void {
        if (!this.trackEl) return;

        const pageW = this.pageWidth + this.settings.columnGap;
        const targetX = -targetPage * pageW;
        const startX = fromX ?? this.getCurrentTransformX();
        const dur = this.settings.transitionDuration;

        // 更新逻辑状态
        this.currentPage = targetPage;
        this.accumulatedDelta = 0;

        // 保存动画起止位置，供 getCurrentTransformX 计算实时进度
        this.animStartX = startX;
        this.animEndX = targetX;

        const anim = this.trackEl.animate(
            [
                { transform: `translateX(${startX}px)` },
                { transform: `translateX(${targetX}px)` },
            ],
            {
                duration: dur,
                easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
                fill: 'forwards',
            }
        );
        this.pageAnim = anim;

        // 动画正常完成后固化
        anim.finished
            .then(() => {
                if (!this.trackEl) return;
                // 将最终位置写入 style 层（解除动画引用）
                this.trackEl.style.transform = `translateX(${targetX}px)`;
                if (this.pageAnim === anim) {
                    this.pageAnim = null;
                }
                this.updatePageIndicator();
                this.onPageChangeCallback?.(this.currentPage, this.totalPages);
            })
            .catch(() => {
                // 动画被 cancel（刹车 / 章节切换 / destroy）→ 静默忽略
                if (this.pageAnim === anim) {
                    this.pageAnim = null;
                }
            });
    }

    /** 获取 track 元素当前的实时 translateX 值（考虑进行中的 Web Animation） */
    private getCurrentTransformX(): number {
        if (this.pageAnim && this.pageAnim.currentTime !== null) {
            const progress = this.settings.transitionDuration > 0
                ? Number(this.pageAnim.currentTime) / this.settings.transitionDuration
                : 1;
            const clamped = Math.min(1, Math.max(0, progress));
            return this.animStartX + (this.animEndX - this.animStartX) * clamped;
        }
        return parseTransformX(getComputedStyle(this.trackEl!).transform);
    }

    /** 取消翻页动画并保持当前视觉位置 */
    private cancelAnimAndSnap(): void {
        if (!this.pageAnim) return;
        const x = this.getCurrentTransformX();
        this.pageAnim.cancel();
        this.pageAnim = null;
        if (this.trackEl) {
            this.trackEl.style.transform = `translateX(${x}px)`;
        }
    }

    /** 章节切换动画完成后的收尾（解锁 + 处理排队） */
    private finalizeChapterTransition(): void {
        this.isChapterAnimating = false;
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

        // 章节切换动画中 → 累积但暂不处理
        if (this.isChapterAnimating) {
            this.accumulatedDelta += (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) > 0 ? 1 : -1;
            e.preventDefault();
            return;
        }

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

        // 取消所有运行中的动画
        this.pageAnim?.cancel();
        this.pageAnim = null;
        this.clearChapterAnimTimeout();

        const prevTotal = this.totalPages;
        const progress = prevTotal > 1
            ? this.currentPage / (prevTotal - 1)
            : 0;

        this.isChapterAnimating = false;
        this.accumulatedDelta = 0;

        this.measureViewport();
        this.applyTrackStyles(false);

        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                const newTotal = this.calculateTotalPages();
                this.totalPages = newTotal;
                this.currentPage = Math.min(
                    Math.round(progress * Math.max(1, newTotal - 1)),
                    newTotal - 1
                );
                this.updateTransform(false);
                this.updatePageIndicator();
                this.onPageChangeCallback?.(this.currentPage, this.totalPages);
            });
        });
    };
}
