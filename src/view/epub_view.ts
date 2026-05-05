import { FileView, TFile, WorkspaceLeaf } from "obsidian";
import { EpubPluginSettings } from "../setting/settings";
import { initSync, EpubHandle } from "../lib/epub_parse_module/epub_parse_module";
import { EpubPaginator } from "./epub_paginator";

export const EPUB_FILE_EXTENSION = "epub";
export const VIEW_TYPE_EPUB = "epub";
export const ICON_EPUB = "doc-epub";

const WASM_PLUGIN_PATH = ".obsidian/plugins/obsidian-epub_support-plugin/lib/epub_parse_module/epub_parse_module_bg.wasm";

let wasmReady = false;

async function initWasmOnce(readBinary: (path: string) => Promise<ArrayBuffer>): Promise<void> {
	if (wasmReady) return;
	const bin = await readBinary(WASM_PLUGIN_PATH);
	initSync({ module: new Uint8Array(bin) });
	wasmReady = true;
}

export class EpubView extends FileView {
	allowNoFile: false = false;
	private handle: EpubHandle | null = null;
	private currentChapter = 0;
	private contentArea: HTMLElement | null = null;
	private paginator: EpubPaginator | null = null;
	private actionsAdded = false;
	private footnotePopover: HTMLElement | null = null;
	private footnoteBackdrop: HTMLElement | null = null;
	private fnObserver: MutationObserver | null = null;

	onPositionChange: ((label: string) => void) | null = null;

	constructor(leaf: WorkspaceLeaf, private settings: EpubPluginSettings) {
		super(leaf);
	}

	async onLoadFile(file: TFile): Promise<void> {
		this.contentEl.empty();

		await initWasmOnce((p) => this.app.vault.adapter.readBinary(p));

		const epubData = new Uint8Array(
			await this.app.vault.adapter.readBinary(file.path)
		);

		this.handle?.free();
		this.handle = new EpubHandle(epubData);
		this.currentChapter = 0;

		this.addViewActions();

		this.ensureFootnoteInfrastructure();

		if (this.settings.viewMode === 'scrolled') {
			this.renderAllChapters();
		} else {
			this.paginator?.destroy();
			this.paginator = new EpubPaginator(this.settings);
			this.paginator.onChapterBoundary = (dir) => this.navigateChapter(dir);
			this.paginator.setOnPageChange(() => {
				this.notifyPositionChange();
			});

			this.contentArea = this.contentEl.createDiv("epub-content");
			this.paginator.attach(this.contentArea);

			const html = this.handle.get_chapter_content(this.currentChapter);
			this.paginator.loadChapter(html);
		}

		this.enhanceFootnoteRefs();
		this.observeContentChanges();
		this.notifyPositionChange();
		this.registerKeyboard();
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

	private notifyPositionChange(): void {
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

	private navigateChapter(delta: number): void {
		if (!this.handle) return;
		const total = this.handle.total_chapters();
		const next = this.currentChapter + delta;
		if (next < 0 || next >= total) return;
		this.currentChapter = next;

		if (this.settings.viewMode === 'paginated' && this.paginator) {
			const html = this.handle.get_chapter_content(this.currentChapter);
			this.paginator.loadChapter(html, delta as -1 | 0 | 1);
		} else {
			this.scrollToChapter(this.currentChapter);
		}
		this.enhanceFootnoteRefs();
		this.notifyPositionChange();
	}

	private scrollToChapter(index: number): void {
		const el = document.getElementById(`epub-chapter-${index}`);
		el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
	}

	private renderAllChapters(): void {
		if (!this.handle) return;
		this.contentArea = this.contentEl.createDiv("epub-content");
		for (let i = 0, n = this.handle.total_chapters(); i < n; i++) {
			const el = this.contentArea.createDiv("epub-chapter");
			el.id = `epub-chapter-${i}`;
			el.innerHTML = this.handle.get_chapter_content(i);
		}
	}

	private registerKeyboard(): void {
		if (this.settings.viewMode !== 'paginated') return;
		this.registerDomEvent(document, 'keydown', (evt: KeyboardEvent) => {
			if (!this.paginator) return;
			if (this.app.workspace.activeLeaf !== this.leaf) return;
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
		this.fnObserver?.disconnect();
		this.fnObserver = null;
		this.paginator?.destroy();
		this.paginator = null;
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
			});
			this.fnObserver.observe(track, { childList: true, subtree: true });
		}
	}

	private enhanceFootnoteRefs(): void {
		const container =
			this.contentEl.querySelector(".epub-paginated-track") ??
			this.contentEl.querySelector(".epub-content");
		if (!container) return;

		// Pause observer to avoid feedback loop
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

		// Mark footnote images (e.g. QQ reader inline note icons)
		const fnImgs = container.querySelectorAll(
			"img.qqreader-footnote, img.duokan-footnote, img[class*='footnote']"
		);
		fnImgs.forEach((img) => {
			if (!img.classList.contains("fn-img")) {
				img.classList.add("fn-img");
			}
		});

		// Resume observer
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

		// The target itself or a descendant of a footnote container
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

		// Walk up to find a footnote container
		const ancestor = target.closest(
			"aside, .footnote, .footnotes, .endnote, [epub\\:type='footnote'], li.footnote"
		);
		if (ancestor) return ancestor as HTMLElement;

		// Just return the target itself if it has text content
		if (target.textContent?.trim()) return target;

		return null;
	}

	private onFootnoteClick = (evt: MouseEvent): void => {
		const target = evt.target as HTMLElement;

		// If clicking a backlink inside the popover, dismiss it
		if (target.closest(".epub-footnote-popover")) {
			this.hideFootnotePopover();
			return;
		}

		// Handle image-based footnotes (e.g. qqreader-footnote)
		const fnImg = target.closest(
			"img.fn-img, img.qqreader-footnote, img.duokan-footnote, img[class*='footnote']"
		) as HTMLImageElement | null;
		if (fnImg) {
			evt.preventDefault();
			evt.stopPropagation();
			this.showFootnotePopoverForImage(fnImg, evt);
			return;
		}

		// Handle link-based footnotes
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

		// Clone the footnote content to avoid moving the original
		const clone = fnEl.cloneNode(true) as HTMLElement;
		clone.querySelectorAll("a[href^='#']").forEach((a) => {
			a.classList.add("fn-backlink");
		});

		// Build clean popover content
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

		// Clamp horizontally
		left = Math.max(8, Math.min(left, window.innerWidth - popoverW - 8));

		// If not enough room above, show below
		if (top < 8) {
			top = evt.clientY + 20;
		}

		// Clamp bottom to viewport
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
}
