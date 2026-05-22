import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";

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
	onCollapseToggle: (() => void) | null = null;
	private searchQuery = "";
	private searchVisible = false;
	private searchInputEl: HTMLInputElement | null = null;
	private searchBarEl: HTMLElement | null = null;
	private treeEl: HTMLElement | null = null;
	private treeCollapsedAll = false;
	private collapseBtnEl: HTMLElement | null = null;
	private lastScrollTop = 0;
	private scrollTrackerBound = false;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_EPUB_OUTLINE;
	}

	getDisplayText(): string {
		return "书籍目录";
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

		this.buildSearchBar(container);

		if (this.tocData.length === 0) {
			container.createDiv({ cls: "epub-outline-empty", text: "打开 EPUB 文件以查看书籍目录" });
			return;
		}

		this.buildTree(container);
	}

	// ── search bar (built once, toggled without re-render) ──

	private buildSearchBar(container: HTMLElement): void {
		const bar = container.createDiv({ cls: "epub-outline-search-bar" });
		this.searchBarEl = bar;
		this.bindScrollTracker(container);

		this.collapseBtnEl = bar.createDiv({ cls: "epub-outline-collapse-btn clickable-icon" });
		setIcon(this.collapseBtnEl, "list-tree");
		if (this.treeCollapsedAll) {
			this.collapseBtnEl.addClass("is-active");
		}
		this.collapseBtnEl.addEventListener("click", () => this.toggleCollapseAll());

		const btn = bar.createDiv({ cls: "epub-outline-search-btn clickable-icon" });
		setIcon(btn, "search");
		btn.addEventListener("click", () => this.toggleSearch());

		// Replicate Obsidian's .search-input-container structure
		const inputContainer = bar.createDiv({ cls: "epub-outline-search-input-container" });
		if (this.searchVisible) {
			inputContainer.addClass("visible");
		}

		this.searchInputEl = inputContainer.createEl("input", {
			cls: "",
			attr: {
				type: "search",
				spellcheck: "false",
				enterkeyhint: "search",
				placeholder: "搜索目录…",
			},
		});

		if (this.searchQuery) {
			this.searchInputEl.value = this.searchQuery;
		}

		// Clear button matching Obsidian's .search-input-clear-button
		const clearBtn = inputContainer.createDiv({
			cls: "search-input-clear-button",
			attr: { "aria-label": "清除搜索" },
		});
		clearBtn.addEventListener("click", () => {
			this.searchQuery = "";
			this.searchInputEl!.value = "";
			this.rebuildTree();
			this.searchInputEl?.focus();
		});

		const input = this.searchInputEl;
		input.addEventListener("input", () => {
			this.searchQuery = input.value;
			this.rebuildTree();
		});

		input.addEventListener("keydown", (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				this.searchQuery = "";
				this.searchVisible = false;
				input.value = "";
				input.closest(".epub-outline-search-input-container")?.removeClass("visible");
				this.rebuildTree();
			}
		});
	}

	private toggleSearch(): void {
		this.searchVisible = !this.searchVisible;
		const input = this.searchInputEl;
		if (!input) return;
		const inputContainer = input.closest(".epub-outline-search-input-container");
		if (this.searchVisible) {
			inputContainer?.addClass("visible");
			input.focus();
		} else {
			this.searchQuery = "";
			input.value = "";
			inputContainer?.removeClass("visible");
			this.rebuildTree();
		}
	}

	setOutlineCollapsed(enabled: boolean): void {
		this.treeCollapsedAll = enabled;
		this.collapseBtnEl?.toggleClass("is-active", !enabled);
		this.applyCollapseState();
	}

	private toggleCollapseAll(): void {
		this.treeCollapsedAll = !this.treeCollapsedAll;
		this.collapseBtnEl?.toggleClass("is-active", !this.treeCollapsedAll);
		this.applyCollapseState();
		this.onCollapseToggle?.();
	}

	private applyCollapseState(): void {
		if (!this.treeEl) return;
		const items = this.treeEl.querySelectorAll(".epub-outline-item");
		if (!this.treeCollapsedAll) {
			items.forEach((el) => el.removeClass("collapsed"));
			return;
		}
		// Collapse all, then expand ancestor chain of current chapter
		const ancestors = this.findAncestorPath(this.tocData, this.currentChapter);
		const ancestorSet = new Set(ancestors);
		items.forEach((el) => {
			const ch = parseInt(el.getAttribute("data-chapter") ?? "", 10);
			if (ancestorSet.has(ch)) {
				el.removeClass("collapsed");
			} else {
				el.addClass("collapsed");
			}
		});
	}

	private findAncestorPath(items: TocItem[], target: number): number[] {
		for (const item of items) {
			if (item.chapterIndex === target) return [item.chapterIndex];
			if (item.children.length > 0) {
				const childPath = this.findAncestorPath(item.children, target);
				if (childPath.length > 0) return [item.chapterIndex, ...childPath];
			}
		}
		return [];
	}

	// ── scroll-aware sticky toolbar ──

	private bindScrollTracker(container: HTMLElement): void {
		if (this.scrollTrackerBound) return;
		this.scrollTrackerBound = true;
		container.addEventListener("scroll", () => {
			const delta = container.scrollTop - this.lastScrollTop;
			if (delta > 5 && container.scrollTop > 30) {
				this.searchBarEl?.addClass("hidden");
			} else if (delta < -5) {
				this.searchBarEl?.removeClass("hidden");
			}
			this.lastScrollTop = container.scrollTop;
		}, { passive: true });
	}

	// ── tree (rebuilt when data or filter changes) ──

	private rebuildTree(): void {
		if (this.treeEl) {
			this.treeEl.remove();
			this.treeEl = null;
		}
		this.buildTree(this.contentEl);
	}

	private buildTree(container: HTMLElement): void {
		const tree = container.createDiv({ cls: "epub-outline-tree" });
		this.treeEl = tree;
		const filtered = this.searchQuery
			? this.filterTree(this.tocData, this.searchQuery.toLowerCase())
			: this.tocData;
		filtered.forEach((item) => this.renderTocItem(tree, item, 0));
		this.applyCollapseState();
		this.updateActiveItem();
	}

	// ── filter ──

	/**
	 * Recursively filter the TOC tree, preserving ancestors of matching items.
	 */
	private filterTree(items: TocItem[], query: string): TocItem[] {
		const result: TocItem[] = [];
		for (const item of items) {
			const labelMatch = item.label.toLowerCase().includes(query);
			const filteredChildren = item.children.length > 0
				? this.filterTree(item.children, query)
				: [];

			if (labelMatch || filteredChildren.length > 0) {
				result.push({
					label: item.label,
					href: item.href,
					chapterIndex: item.chapterIndex,
					children: filteredChildren,
				});
			}
		}
		return result;
	}

	// ── tree item ──

	private renderTocItem(parent: HTMLElement, item: TocItem, depth: number): void {
		const itemEl = parent.createDiv({ cls: "epub-outline-item" });
		itemEl.setAttr("data-chapter", String(item.chapterIndex));
		if (depth > 0) {
			itemEl.style.setProperty("--epub-outline-depth", String(depth));
		}

		const self = itemEl.createDiv({ cls: "epub-outline-item-self" });

		const hasChildren = item.children.length > 0;
		if (hasChildren) {
			const toggle = self.createSpan({ cls: "epub-outline-toggle" });
			setIcon(toggle, "chevron-right");
			toggle.addEventListener("click", (e: MouseEvent) => {
				e.stopPropagation();
				e.preventDefault();
				itemEl.classList.toggle("collapsed");
			});
		}

		const inner = self.createSpan({ cls: "epub-outline-inner", text: item.label });

		self.addEventListener("click", () => {
			this.onNavigateCallback?.(item.chapterIndex);
		});

		if (hasChildren) {
			const children = itemEl.createDiv({ cls: "epub-outline-children" });
			item.children.forEach((child) => this.renderTocItem(children, child, depth + 1));
		}
	}

	// ── active item ──

	private updateActiveItem(): void {
		const container = this.contentEl;
		container.querySelectorAll(".epub-outline-item-self.is-active").forEach((el) => {
			el.removeClass("is-active");
		});

		const activeItem = container.querySelector(
			`.epub-outline-item[data-chapter="${this.currentChapter}"]`
		);
		if (activeItem) {
			const self = activeItem.querySelector(".epub-outline-item-self");
			if (self) {
				self.addClass("is-active");
				self.scrollIntoView({ block: "nearest", behavior: "smooth" });
			}
		}
	}
}
