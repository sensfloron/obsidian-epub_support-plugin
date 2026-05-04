import { FileView, TFile, WorkspaceLeaf } from "obsidian";
import { EpubPluginSettings } from "../setting/settings";
import { initSync, EpubHandle } from "../lib/epub_parse_module/epub_parse_module";

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
	private chapterLabel: HTMLElement | null = null;
	private prevBtn: HTMLButtonElement | null = null;
	private nextBtn: HTMLButtonElement | null = null;

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

		this.renderToolbar();

		if (this.settings.scrolledView) {
			this.renderAllChapters();
		} else {
			this.contentArea = this.contentEl.createDiv("epub-content");
			this.renderCurrentChapter();
		}
	}

	private renderToolbar(): void {
		const bar = this.contentEl.createDiv("epub-toolbar");
		Object.assign(bar.style, {
			display: "flex",
			alignItems: "center",
			gap: "8px",
			padding: "8px 0",
			borderBottom: "1px solid var(--background-modifier-border)",
			marginBottom: "16px",
			position: "sticky",
			top: "0",
			background: "var(--background-primary)",
			zIndex: "1",
		});

		this.prevBtn = bar.createEl("button", { text: "◀ 上一章" });
		this.chapterLabel = bar.createEl("span", {
			text: this.formatChapterLabel(),
			attr: { style: "flex:1; text-align:center; font-size:0.9em; color:var(--text-muted)" },
		});
		this.nextBtn = bar.createEl("button", { text: "下一章 ▶" });

		this.prevBtn.onclick = () => this.navigateChapter(-1);
		this.nextBtn.onclick = () => this.navigateChapter(1);
	}

	private formatChapterLabel(): string {
		const total = this.handle?.total_chapters() ?? 0;
		return total > 0 ? `第 ${this.currentChapter + 1} / ${total} 章` : "无内容";
	}

	private navigateChapter(delta: number): void {
		if (!this.handle) return;
		const total = this.handle.total_chapters();
		const next = this.currentChapter + delta;
		if (next < 0 || next >= total) return;
		this.currentChapter = next;
		this.renderCurrentChapter();
		this.chapterLabel?.setText(this.formatChapterLabel());
		this.updateNavButtons(total);
	}

	private updateNavButtons(total: number): void {
		if (this.prevBtn) this.prevBtn.disabled = this.currentChapter <= 0;
		if (this.nextBtn) this.nextBtn.disabled = this.currentChapter >= total - 1;
	}

	private renderCurrentChapter(): void {
		if (!this.handle || !this.contentArea) return;
		const html = this.handle.get_chapter_content(this.currentChapter);
		this.contentArea.innerHTML = html;
		this.updateNavButtons(this.handle.total_chapters());
	}

	private renderAllChapters(): void {
		if (!this.handle) return;
		this.contentArea = this.contentEl.createDiv("epub-content");
		for (let i = 0, n = this.handle.total_chapters(); i < n; i++) {
			const el = this.contentArea.createDiv("epub-chapter");
			el.innerHTML = this.handle.get_chapter_content(i);
		}
	}

	onunload(): void {
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
}
