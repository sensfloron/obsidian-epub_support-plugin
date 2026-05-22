import { EpubPluginSettings, PAGE_TURN_COOLDOWN_MS } from "../setting/settings";

export class EpubPaginator {
	private viewportEl: HTMLElement | null = null;
	private trackEl: HTMLElement | null = null;
	private pageIndicatorEl: HTMLElement | null = null;
	private parentEl: HTMLElement | null = null;

	private currentPage = 0;
	private totalPages = 1;
	private pageWidth = 0;
	private pageHeight = 0;
	private isTransitioning = false;
	private transitionTimeout: ReturnType<typeof setTimeout> | null = null;
	private resizeObserver: ResizeObserver | null = null;
	private touchStartX = 0;
	private touchStartY = 0;
	private swipeThreshold = 50;
	private lastWheelTime = 0;
	private lastTapTime = 0;
	private clickZoneHandler: ((e: MouseEvent) => void) | null = null;
	private swipeHandled = false;
	private touchInEdgeZone = false;

	private settings: EpubPluginSettings;
	private onPageChangeCallback: ((current: number, total: number) => void) | null = null;

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

		const track = this.trackEl;
		const dur = this.settings.transitionDuration;

		this.clearTransitionTimeout();
		this.isTransitioning = true;
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
					this.isTransitioning = false;
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

		setTimeout(() => {
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
			setTimeout(() => {
				this.applyTrackStyles(false);
				this.updateTransform(false);
				this.updatePageIndicator();
				this.isTransitioning = false;
			}, dur);
		}, dur);
	}

	navigatePage(delta: number): boolean {
		if (this.isTransitioning) return true;
		if (!this.trackEl) return false;

		const nextPage = this.currentPage + delta;

		if (nextPage < 0) {
			this.onChapterBoundary?.(-1);
			return false;
		}
		if (nextPage >= this.totalPages) {
			this.onChapterBoundary?.(1);
			return false;
		}

		this.currentPage = nextPage;
		this.updateTransform(true);
		this.updatePageIndicator();
		this.startTransitionGuard();
		this.onPageChangeCallback?.(this.currentPage, this.totalPages);
		return true;
	}

	goToPage(index: number): void {
		if (index < 0 || index >= this.totalPages) return;
		this.currentPage = index;
		this.updateTransform(false);
		this.updatePageIndicator();
		this.onPageChangeCallback?.(this.currentPage, this.totalPages);
	}

	getPageInfo(): { current: number; total: number } {
		return { current: this.currentPage, total: this.totalPages };
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
		this.clearTransitionTimeout();
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

	private startTransitionGuard(): void {
		this.isTransitioning = true;
		this.transitionTimeout = setTimeout(() => {
			this.isTransitioning = false;
		}, this.settings.transitionDuration + 50);
	}

	private clearTransitionTimeout(): void {
		if (this.transitionTimeout) {
			clearTimeout(this.transitionTimeout);
			this.transitionTimeout = null;
		}
	}

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

	// ── events ──

	private bindEvents(): void {
		if (!this.viewportEl) return;
		const mode = this.settings.pageTurnMode;

		if (mode === 'swipe' || mode === 'both') {
			this.viewportEl.addEventListener("touchstart", this.onTouchStart, { passive: true });
			this.viewportEl.addEventListener("touchend", this.onTouchEnd, { passive: true });
			this.viewportEl.addEventListener("touchmove", this.onTouchMove, { passive: false });
		}
		if (mode === 'tap' || mode === 'both') {
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
			if (this.isTransitioning) return;
			if (this.swipeHandled) {
				this.swipeHandled = false;
				return;
			}
			const now = Date.now();
			if (now - this.lastTapTime < PAGE_TURN_COOLDOWN_MS) return;
			// 忽略文本选择拖拽后的 click
			const selection = window.getSelection();
			if (selection && !selection.isCollapsed) return;

			const rect = this.viewportEl!.getBoundingClientRect();
			const relX = e.clientX - rect.left;
			const third = rect.width / 3;

			if (relX < third) {
				this.lastTapTime = now;
				this.navigatePage(-1);
			} else if (relX > third * 2) {
				this.lastTapTime = now;
				this.navigatePage(1);
			} else {
				this.lastTapTime = now;
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
		// 仅在非过渡状态且冷却时间已过时处理
		const now = Date.now();
		if (this.isTransitioning) return;
		if (now - this.lastWheelTime < PAGE_TURN_COOLDOWN_MS) return;

		if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
			// 水平滚动：视为翻页
			this.lastWheelTime = now;
			if (e.deltaX > 0) {
				this.navigatePage(1);
			} else {
				this.navigatePage(-1);
			}
		} else if (Math.abs(e.deltaY) > 10) {
			// 垂直滚动：视为翻页
			this.lastWheelTime = now;
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
		if (!this.trackEl || this.totalPages <= 1) return;

		const progress = this.currentPage / Math.max(1, this.totalPages - 1);
		this.clearTransitionTimeout();
		this.isTransitioning = false;

		this.measureViewport();
		this.applyTrackStyles(false);

		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				const newTotal = this.calculateTotalPages();
				this.totalPages = newTotal;
				this.currentPage = Math.round(progress * Math.max(1, newTotal - 1));
				this.updateTransform(false);
				this.updatePageIndicator();
			});
		});
	};
}
