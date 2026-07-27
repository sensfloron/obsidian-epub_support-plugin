/**
 * Manages footnote popover rendering, ref detection/enhancement, and
 * content-observation for the EPUB reader view.
 *
 * Extracted from EpubView so that footnote DOM logic is testable
 * and the image-viewer cross-coupling is explicit (onImageClick callback).
 */

/**
 * 匹配脚注引用 id 中的标记词。
 *
 * 为什么要用 `(?:^|[_-])` 而非 `^`：EPUB 转换器（calibre 等）常给 id
 * 加前导下划线或前缀，例如 `_ftnref98`、`fnref-1`、`noteref_5`。
 * 原正则 `^(?:fnref|ftnref|...)` 因 `^` 锚定字符串开头，无法匹配
 * 这些带前缀的 id，导致点击未被识别为脚注引用而走浏览器默认锚点跳转
 * —— 这正是分页模式下点击 [98] 跳到 _ftn98 的根因。
 *
 * 词表保持精确（fnref/ftnref/noteref/endnoteref），不引入 fn 等宽泛词，
 * 避免误判普通 id。
 */
const FOOTNOTE_REF_ID_RE = /(?:^|[_-])(?:fnref|ftnref|noteref|endnoteref)/i;

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
                FOOTNOTE_REF_ID_RE.test(link.id);

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
        if (FOOTNOTE_REF_ID_RE.test(el.id)) return true;
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

        /**
         * 兜底分支。
         *
         * 原 `if (target.textContent?.trim()) return target` 有缺陷：
         * 当脚注正文结构是 `<span>正文<a id="_ftn98" href="#_ftnref98">[98]</a></span>`
         * 时，target 是那个反向链接 `<a>`，自身 textContent 仅 `[98]`（4 字符），
         * 但原逻辑仍返回它 → popover 只弹出空返回链接，正文丢失。
         *
         * 修复两步走：
         * 1. target 自身内容过短（≤ SHORT_THRESHOLD）时，向上找第一个
         *    textContent 显著更长的祖先作为「正文容器」。
         * 2. 这类 EPUB 常把多个脚注塞进同一个容器（如本例 795 字含 [95]-[99]），
         *    所以在容器内进一步提取「从 target 标号到下一个脚注标号之前」的
         *    片段，只弹出被点击的那一条。
         */
        const SHORT_THRESHOLD = 20;
        const MIN_BODY_LEN = 30;
        const targetLen = (target.textContent ?? "").trim().length;

        if (targetLen > SHORT_THRESHOLD) return target;

        // 步骤 1：向上找正文容器
        let container: HTMLElement | null = target.parentElement;
        while (container && container !== document.body) {
            const len = (container.textContent ?? "").trim().length;
            if (len >= MIN_BODY_LEN && len > targetLen * 2) break;
            container = container.parentElement;
        }
        if (!container || container === document.body) return target;

        // 步骤 2：在容器内提取单条脚注片段
        return this.extractSingleFootnote(target, container);
    }

    /**
     * 在多脚注容器里提取单条脚注的内容片段。
     *
     * 算法：以 target（标号 `<a id="_ftnNN">`）在容器中的位置为起点，
     * 收集它本身 + 后续兄弟节点，直到遇到下一个脚注标号链接为止。
     * 把收集到的节点克隆进一个临时 div 返回。
     *
     * 边界处理：
     * - target 不是容器的直接子节点（被包在 span 里）：向上找到容器内的
     *   直接子级祖先作为起点。
     * - 没有下一个标号（点击的是最后一条）：取到容器末尾。
     * - 提取失败（找不到合理起点）：回退返回整个 container。
     */
    private extractSingleFootnote(target: HTMLElement, container: HTMLElement): HTMLElement {
        // 找到 target 在 container 内的「直接子级起点」
        let startNode: HTMLElement = target;
        while (startNode.parentElement && startNode.parentElement !== container) {
            startNode = startNode.parentElement;
        }
        if (startNode.parentElement !== container) {
            // target 不在 container 子树里（不应发生），回退
            return container;
        }

        const result = document.createElement("div");
        let sibling: Node | null = startNode;
        while (sibling) {
            // 遇到下一个脚注标号就停止（不收集它）
            if (
                sibling !== startNode &&
                sibling instanceof HTMLElement &&
                this.isFootnoteMarkerAnchor(sibling)
            ) {
                break;
            }
            result.appendChild(sibling.cloneNode(true));
            sibling = sibling.nextSibling;
        }

        // 兜底：若提取结果过短（比如只有标号），返回整个容器
        if ((result.textContent ?? "").trim().length < 5) {
            return container;
        }
        return result;
    }

    /**
     * 判断元素是否是脚注标号链接（用于在容器内切分单条脚注的边界）。
     * 匹配 `<a id="_ftnNN">` 或 `<a id="_ftnrefNN">` 这类标号锚。
     */
    private isFootnoteMarkerAnchor(el: HTMLElement): boolean {
        if (el.tagName !== "A") return false;
        // 直接匹配脚注标号 id（覆盖引用端 _ftnrefNN 和定义端 _ftnNN）
        return /(?:^|[_-])(?:fnref|ftnref|fn|ftn)/i.test(el.id);
    }

    // ── Popover rendering ──

    private showForElement(fnEl: HTMLElement, evt: MouseEvent): void {
        if (!this.popover || !this.backdrop) return;

        const clone = fnEl.cloneNode(true) as HTMLElement;
        // 清除 clone 内所有 id，避免重复 id 污染 document.getElementById，
        // 否则下次点击脚注时 getElementById 可能命中 popover 里的副本而非原文
        // （这是"首次点击正常、关闭后再次点击内容不完整"的根因）。
        clone.querySelectorAll("[id]").forEach((el) => el.removeAttribute("id"));
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
        this.popover?.empty();   // 清空内容，防止残留的 clone（带重复 id）干扰下次 getElementById
        this.backdrop?.hide();
    }
}
