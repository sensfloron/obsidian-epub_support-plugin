/**
 * Manages footnote popover rendering, ref detection/enhancement, and
 * content-observation for the EPUB reader view.
 *
 * Extracted from EpubView so that footnote DOM logic is testable and
 * the image-viewer cross-coupling is explicit (onImageClick callback).
 */
export class FootnoteManager {
    private popover: HTMLElement | null = null;
    private backdrop: HTMLElement | null = null;
    private observer: MutationObserver | null = null;

    constructor(
        private contentEl: HTMLElement,
        private callbacks: {
            /** Called when a content image is clicked in the centre 75% zone.
             *  EpubView routes this to ensureImageViewerInfrastructure + showImageViewer. */
            onImageClick?: (img: HTMLImageElement) => void;
            /** Called by the MutationObserver after footnote refs are re-scanned.
             *  EpubView uses this to call highlightCodeBlocks. */
            onContentChanged?: () => void;
        } = {},
    ) {}

    // ── Lifecycle ──

    /** Create popover/backdrop DOM. Call once after contentEl is ready.
     *  The host view must register the click handler separately via
     *  `registerDomEvent(contentEl, "click", footnoteManager.handleClick)`. */
    install(): void {
        if (this.popover) return;

        this.backdrop = this.contentEl.createDiv("epub-footnote-backdrop");
        this.backdrop.hide();
        this.backdrop.addEventListener("click", () => this.hidePopover());

        this.popover = this.contentEl.createDiv("epub-footnote-popover");
        this.popover.hide();
    }

    /**
     * Scan the current paginated/scrolled container for footnote references,
     * enhance them with marker classes, and (re)start the MutationObserver
     * so newly loaded pages get scanned automatically.
     */
    enhance(): void {
        const container =
            this.contentEl.querySelector(".epub-paginated-track") ??
            this.contentEl.querySelector(".epub-content");
        if (!container) return;

        this.observer?.disconnect();

        // Anchor-based footnote references
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

        // Image-based footnotes (QQReader / Duokan / generic)
        const fnImgs = container.querySelectorAll(
            "img.qqreader-footnote, img.duokan-footnote, img[class*='footnote']",
        );
        fnImgs.forEach((img) => {
            if (!img.classList.contains("fn-img")) {
                img.classList.add("fn-img");
            }
        });

        this.setupObserver();
    }

    /** Tear down MutationObserver. Call on view unload. */
    dispose(): void {
        this.observer?.disconnect();
        this.observer = null;
    }

    // ── Observer ──

    private setupObserver(): void {
        const track = this.contentEl.querySelector(".epub-paginated-track");
        if (track) {
            this.observer = new MutationObserver(() => {
                this.enhance();
                this.callbacks.onContentChanged?.();
            });
            this.observer.observe(track, { childList: true, subtree: true });
        }
    }

    // ── Click handler ──

    /** Public so the host view can register it via Obsidian's registerDomEvent. */
    handleClick = (evt: MouseEvent): void => {
        const target = evt.target as HTMLElement;

        // Click on the popover itself → dismiss
        if (target.closest(".epub-footnote-popover")) {
            this.hidePopover();
            return;
        }

        // Inside the image viewer overlay → ignore
        if (target.closest(".epub-image-overlay")) {
            return;
        }

        // Content image → only centre 75% zone opens the image viewer;
        // edges are reserved for page-turning.
        const contentImg = target.closest(
            "img:not(.fn-img):not(.qqreader-footnote):not(.duokan-footnote):not([class*='footnote'])",
        ) as HTMLImageElement | null;
        if (contentImg) {
            const imgRect = contentImg.getBoundingClientRect();
            const clickRelX = evt.clientX - imgRect.left;
            const margin = imgRect.width * 0.125;
            if (clickRelX > margin && clickRelX < imgRect.width - margin) {
                evt.preventDefault();
                evt.stopPropagation();
                this.callbacks.onImageClick?.(contentImg);
            }
            return;
        }

        // Footnote image (QQReader / Duokan) → show alt-text popover
        const fnImg = target.closest(
            "img.fn-img, img.qqreader-footnote, img.duokan-footnote, img[class*='footnote']",
        ) as HTMLImageElement | null;
        if (fnImg) {
            evt.preventDefault();
            evt.stopPropagation();
            this.showForImage(fnImg, evt);
            return;
        }

        // Anchor footnote reference
        const ref = target.closest("a[href^='#']") as HTMLAnchorElement | null;
        if (!ref) return;

        if (!this.isFootnoteRef(ref)) return;

        evt.preventDefault();
        evt.stopPropagation();

        const href = ref.getAttribute("href");
        if (!href) return;

        const fnContent = this.findFootnoteContent(href);
        if (!fnContent) return;

        this.showForElement(fnContent, evt);
    };

    // ── Footnote detection ──

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
            "aside, .footnote, .footnotes, .endnote, [epub\\:type='footnote'], li.footnote",
        );
        if (ancestor) return ancestor as HTMLElement;

        if (target.textContent?.trim()) return target;

        return null;
    }

    // ── Popover rendering ──

    private showForElement(fnEl: HTMLElement, evt: MouseEvent): void {
        if (!this.popover || !this.backdrop) return;

        const clone = fnEl.cloneNode(true) as HTMLElement;
        clone.querySelectorAll("a[href^='#']").forEach((a) => {
            a.classList.add("fn-backlink");
        });

        const numEl = clone.querySelector("sup, .footnote-num, .fn-num");
        const numText = numEl?.textContent?.trim() ?? "";

        this.popover.empty();
        if (numText) {
            this.popover.createSpan({ cls: "fn-num", text: numText });
        }
        this.popover.createSpan({ cls: "fn-text" }).appendChild(clone);
        this.popover.show();
        this.backdrop.show();

        this.positionPopover(evt);
    }

    private showForImage(img: HTMLImageElement, evt: MouseEvent): void {
        if (!this.popover || !this.backdrop) return;

        const altText = img.getAttribute("alt")?.trim() ?? "";
        const titleText = img.getAttribute("title")?.trim() ?? "";
        const content = altText || titleText;
        if (!content) return;

        this.popover.empty();
        this.popover.createSpan({ cls: "fn-text", text: content });
        this.popover.show();
        this.backdrop.show();

        this.positionPopover(evt);
    }

    private positionPopover(evt: MouseEvent): void {
        if (!this.popover) return;

        const popoverRect = this.popover.getBoundingClientRect();
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

        this.popover.setCssProps({
            position: "fixed",
            left: `${left}px`,
            top: `${top}px`,
        });
    }

    private hidePopover(): void {
        this.popover?.hide();
        this.backdrop?.hide();
    }
}
