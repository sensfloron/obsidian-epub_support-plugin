import { ItemView, WorkspaceLeaf } from "obsidian";

export const VIEW_TYPE_EPUB_OUTLINE = "epub-outline";

export interface TocItem {
	label: string;
	href: string;
	chapterIndex: number;
	children: TocItem[];
}

export class EpubOutlineView extends ItemView {
	private tocData: TocItem[] = [];
	private currentChapter = 0;
	private onNavigateCallback: ((chapterIndex: number) => void) | null = null;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_EPUB_OUTLINE;
	}

	getDisplayText(): string {
		return "目录";
	}

	getIcon(): string {
		return "list";
	}

	async onOpen() {
		this.render();
	}

	setToc(items: TocItem[]): void {
		this.tocData = items;
		this.render();
	}

	setCurrentChapter(index: number): void {
		this.currentChapter = index;
		this.updateActiveItem();
	}

	setOnNavigate(cb: (chapterIndex: number) => void): void {
		this.onNavigateCallback = cb;
	}

	private render(): void {
		const container = this.contentEl;
		container.empty();
		container.addClass("epub-outline-container");

		if (this.tocData.length === 0) {
			container.createDiv({ cls: "epub-outline-empty", text: "打开 EPUB 文件以查看目录" });
			return;
		}

		const list = container.createEl("ul", { cls: "epub-outline-list" });
		this.tocData.forEach((item) => this.renderTocItem(list, item, 0));
	}

	private renderTocItem(parent: HTMLElement, item: TocItem, depth: number): void {
		const li = parent.createEl("li", { cls: "epub-outline-item" });
		const link = li.createEl("a", {
			cls: "epub-outline-link",
			text: item.label,
		});
		link.setAttr("data-chapter", String(item.chapterIndex));
		link.style.paddingLeft = `${12 + depth * 16}px`;

		link.addEventListener("click", (e) => {
			e.preventDefault();
			this.onNavigateCallback?.(item.chapterIndex);
		});

		if (item.children.length > 0) {
			const subList = li.createEl("ul", { cls: "epub-outline-sublist" });
			item.children.forEach((child) => this.renderTocItem(subList, child, depth + 1));
		}
	}

	private updateActiveItem(): void {
		const container = this.contentEl;
		container.querySelectorAll(".epub-outline-link.active").forEach((el) => {
			el.removeClass("active");
		});

		const activeLink = container.querySelector(
			`.epub-outline-link[data-chapter="${this.currentChapter}"]`
		);
		if (activeLink) {
			activeLink.addClass("active");
			activeLink.scrollIntoView({ block: "nearest", behavior: "smooth" });
		}
	}
}
