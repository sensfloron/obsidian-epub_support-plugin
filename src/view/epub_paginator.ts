import { EpubPluginSettings } from "../setting/settings";

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

	private settings: EpubPluginSettings;
	private onPageChangeCallback: ((current: number, total: number) => void) | null = null;

	/** Fires when user tries to navigate past chapter boundary. dir: -1 (prev chapter) or 1 (next chapter) */
	onChapterBoundary: ((direction: -1 | 1) => void) | null = null;

	constructor(settings: EpubPluginSettings) {
		this.settings = settings;
	}

	attach(parentEl: HTMLElement): void {
		this.parentEl = parentEl;
		this.buildDOM();
		this.bindEvents();
	}

	/**
	 * Load new chapter content. `direction`: 1 = next chapter (slide from right),
	 * -1 = prev chapter (slide from left), 0 = no animation (initial load).
	 */
	loadChapter(html: string, direction: -1 | 0 | 1 = 0): void {
		if (!this.viewportEl || !this.trackEl) return;

		const track = this.trackEl; // capture ref for callbacks
		const dur = this.settings.transitionDuration;

		this.clearTransitionTimeout();
		this.isTransitioning = false;
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
				});
			});
			return;
		}

		const pageW = this.pageWidth + this.settings.columnGap;
		const exitX = direction === 1 ? -pageW : pageW;
		const enterX = direction === 1 ? pageW : -pageW;

		// Step 1: slide current content out
		this.applyTrackStyles(true);
		track.style.transform = `translateX(${exitX}px)`;

		setTimeout(() => {
			// Step 2: swap content while off-screen
			track.style.transition = 'none';
			track.style.transform = `translateX(${enterX}px)`;
			track.innerHTML = this.buildChapterHTML(html);
			this.currentPage = 0;
			void track.offsetHeight; // force reflow

			// Step 3: slide new content in
			track.style.transition = `transform ${dur}ms cubic-bezier(0.4, 0, 0.2, 1)`;
			track.style.transform = 'translateX(0px)';

			// Step 4: after entrance, set up column layout
			setTimeout(() => {
				this.applyTrackStyles(false);
				this.updateTransform(false);
				requestAnimationFrame(() => {
					requestAnimationFrame(() => {
						this.totalPages = this.calculateTotalPages();
						this.updatePageIndicator();
					});
				});
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
		return true;
	}

	goToPage(index: number): void {
		if (index < 0 || index >= this.totalPages) return;
		this.currentPage = index;
		this.updateTransform(false);
		this.updatePageIndicator();
	}

	getPageInfo(): { current: number; total: number } {
		return { current: this.currentPage, total: this.totalPages };
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

	private applyTrackStyles(animate: boolean): void {
		if (!this.trackEl) return;
		const count = this.settings.columnCount;
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
		// Auto-hide after 2s
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
      max-width: 33.33% !important;
      max-height: 40vh !important;
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
		// Override AFTER EPUB content so it wins the cascade
		return rawHtml + overrideStyle;
	}

	// ── events ──

	private bindEvents(): void {
		if (!this.viewportEl) return;
		this.viewportEl.addEventListener("touchstart", this.onTouchStart, { passive: true });
		this.viewportEl.addEventListener("touchend", this.onTouchEnd, { passive: true });

		this.resizeObserver = new ResizeObserver(() => this.onResize());
		this.resizeObserver.observe(this.viewportEl);
	}

	private unbindEvents(): void {
		if (this.viewportEl) {
			this.viewportEl.removeEventListener("touchstart", this.onTouchStart);
			this.viewportEl.removeEventListener("touchend", this.onTouchEnd);
		}
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
	}

	private onTouchStart = (e: TouchEvent): void => {
		this.touchStartX = e.touches[0].clientX;
		this.touchStartY = e.touches[0].clientY;
	};

	private onTouchEnd = (e: TouchEvent): void => {
		const dx = e.changedTouches[0].clientX - this.touchStartX;
		const dy = e.changedTouches[0].clientY - this.touchStartY;

		if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > this.swipeThreshold) {
			if (dx < 0) this.navigatePage(1);    // swipe left = next page
			else this.navigatePage(-1);            // swipe right = prev page
		}
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
