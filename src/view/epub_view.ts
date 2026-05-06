import { FileView, TFile, WorkspaceLeaf, MarkdownRenderer } from "obsidian";
import { EpubPluginSettings, PAGE_TURN_COOLDOWN_MS } from "../setting/settings";
import { initSync as initParseSync, EpubHandle } from "../lib/epub_parse_module/pkg/epub_parse_module";
import { initSync as initNoteSync, TextProcessor } from "../lib/epub_note_module/pkg/epub_note_module";
import { EpubPaginator } from "./epub_paginator";
import { EpubProgress, ProgressStore } from "../lib/progress_store";

export const EPUB_FILE_EXTENSION = "epub";
export const VIEW_TYPE_EPUB = "epub";
export const ICON_EPUB = "doc-epub";

const PARSE_WASM_PATH = ".obsidian/plugins/obsidian-epub_support-plugin/lib/epub_parse_module/epub_parse_module_bg.wasm";
const NOTE_WASM_PATH = ".obsidian/plugins/obsidian-epub_support-plugin/lib/epub_note_module/epub_note_module_bg.wasm";
const FONTS_DIR = ".obsidian/plugins/obsidian-epub_support-plugin/fonts";

let parseWasmReady = false;
let noteWasmReady = false;
let fontCssCache: string | null = null;

async function loadFontCss(read: (path: string) => Promise<string>, readBinary: (path: string) => Promise<ArrayBuffer>): Promise<string> {
	if (fontCssCache) return fontCssCache;

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

	css += `
pre, code {
	font-family: Hack, monospace;
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

	fontCssCache = css;
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
	private contentArea: HTMLElement | null = null;
	private paginator: EpubPaginator | null = null;
	private actionsAdded = false;
	private footnotePopover: HTMLElement | null = null;
	private footnoteBackdrop: HTMLElement | null = null;
	private fnObserver: MutationObserver | null = null;
	private saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
	private lastKeyTime = 0;

	onPositionChange: ((label: string) => void) | null = null;
	onProgressSave: (() => void) | null = null;

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
		this.registerKeyboard();
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
		// Save final progress before unloading
		this.saveCurrentProgress();
		this.onProgressSave?.();
		this.paginator?.destroy();
		this.paginator = null;
		this.textProcessor?.free();
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
}
