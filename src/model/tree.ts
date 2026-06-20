/**
 * tree.ts — EPUB Content Tree Model
 *
 * A hierarchical content tree (Book → Chapter → Section → Paragraph → Sentence)
 * built from the existing marked HTML output of the Rust WASM crates.
 *
 * Design principles:
 * - Immutable tree: parent/child/sibling links are set once during construction
 * - Stable Node IDs: derived from content positions, survive re-renders
 * - Lazy per-chapter parsing: chapters parsed on demand
 * - No Rust WASM dependency: pure TypeScript, testable standalone
 * - Backward compatible: existing EpubProgress / TocItem APIs unchanged
 */

import type { TocItem } from "../view/epub_outline_view";
import type { EpubProgress } from "../lib/progress_store";

// ─── Enums ────────────────────────────────────────────────────────────

export enum NodeType {
	Book = "book",
	Chapter = "chapter",
	Section = "section",
	Paragraph = "paragraph",
	Sentence = "sentence",
	Image = "image",
	Footnote = "footnote",
}

// ─── Types ────────────────────────────────────────────────────────────

export type NodeId = string;

// ─── Interfaces ───────────────────────────────────────────────────────

export interface BookMetadata {
	title: string;
	creator: string;
	language: string;
	identifier: string;
}

/**
 * Base interface for all content tree nodes.
 * Implemented by _BaseContentNode and its concrete subclasses.
 */
export interface ContentNode {
	readonly id: NodeId;
	readonly type: NodeType;
	parent: ContentNode | null;
	readonly children: readonly ContentNode[];
	prevSibling: ContentNode | null;
	nextSibling: ContentNode | null;
	depth: number;

	/** DOM element reference (set after render, cleared on re-render) */
	domRef: HTMLElement | null;

	getRoot(): BookNode;
	getAncestors(): ContentNode[];
	walk(callback: (node: ContentNode, depth: number) => void | "stop"): void;
	find(predicate: (node: ContentNode) => boolean): ContentNode | null;
	getText(): string;
	toJSON(): Record<string, unknown>;
}

/**
 * A stable progress reference using tree node IDs instead of ephemeral
 * page positions. Survives re-renders, font size changes, and view mode switches.
 */
export interface ProgressAnchor {
	nodeId: NodeId;
	chapterIndex: number;
	sentenceSi: number;
}

/**
 * Foundation for future annotation/highlighting features.
 * References a sentence node by its stable ID.
 */
export interface AnnotationAnchor {
	sentenceNodeId: NodeId;
	offsetStart: number;
	offsetEnd: number;
	textSnapshot: string;
	note?: string;
}

// ─── Base class ───────────────────────────────────────────────────────

abstract class _BaseContentNode implements ContentNode {
	abstract readonly id: NodeId;
	abstract readonly type: NodeType;

	parent: ContentNode | null = null;
	prevSibling: ContentNode | null = null;
	nextSibling: ContentNode | null = null;
	depth = 0;
	domRef: HTMLElement | null = null;

	abstract get children(): readonly ContentNode[];

	getRoot(): BookNode {
		let node: ContentNode = this;
		while (node.parent) node = node.parent;
		return node as BookNode;
	}

	getAncestors(): ContentNode[] {
		const ancestors: ContentNode[] = [];
		let node = this.parent;
		while (node) {
			ancestors.unshift(node);
			node = node.parent;
		}
		return ancestors;
	}

	walk(callback: (node: ContentNode, depth: number) => void | "stop"): void {
		const visit = (node: ContentNode, depth: number): void | "stop" => {
			const result = callback(node, depth);
			if (result === "stop") return "stop";
			for (const child of node.children) {
				if (visit(child, depth + 1) === "stop") return "stop";
			}
		};
		visit(this, 0);
	}

	find(predicate: (node: ContentNode) => boolean): ContentNode | null {
		if (predicate(this)) return this;
		for (const child of this.children) {
			const found = child.find(predicate);
			if (found) return found;
		}
		return null;
	}

	getText(): string {
		const parts: string[] = [];
		this.walk((node) => {
			if (node.type === NodeType.Sentence) {
				parts.push((node as SentenceNode).text);
			}
		});
		return parts.join("");
	}

	toJSON(): Record<string, unknown> {
		return {
			id: this.id,
			type: this.type,
			depth: this.depth,
			children: this.children.map((c) => ({ id: c.id, type: c.type })),
		};
	}

	/**
	 * Adopt children: set parent, sibling, and depth links.
	 * Call after populating typed children arrays.
	 */
	protected _adoptChildren(children: ContentNode[]): void {
		for (let i = 0; i < children.length; i++) {
			children[i].parent = this;
			children[i].prevSibling = i > 0 ? children[i - 1] : null;
			children[i].nextSibling = i < children.length - 1 ? children[i + 1] : null;
			children[i].depth = this.depth + 1;
		}
	}
}

// ─── Concrete node classes ───────────────────────────────────────────

export class BookNode extends _BaseContentNode {
	readonly type = NodeType.Book;
	readonly id: NodeId;
	chapters: ChapterNode[] = [];
	tocData: TocItem[] = [];
	metadata: BookMetadata;

	constructor(metadata: BookMetadata, bookId?: string) {
		super();
		this.metadata = metadata;
		this.id = NodeIdBuilder.book(bookId ?? (metadata.identifier || "unknown"));
	}

	get children(): readonly ContentNode[] {
		return this.chapters;
	}

	/** Call after populating chapters to link parent/sibling refs */
	linkChapters(): void {
		this._adoptChildren(this.chapters);
	}
}

export class ChapterNode extends _BaseContentNode {
	readonly type = NodeType.Chapter;
	readonly id: NodeId;
	readonly index: number;
	href: string | null = null;

	sections: SectionNode[] = [];
	orphanParagraphs: ParagraphNode[] = [];
	images: ImageNode[] = [];
	footnotes: FootnoteNode[] = [];
	isParsed = false;

	/** Cached children array (avoids recreating on every access) */
	private _childrenCache: ContentNode[] | null = null;

	constructor(index: number) {
		super();
		this.index = index;
		this.id = NodeIdBuilder.chapter(index);
	}

	get children(): readonly ContentNode[] {
		if (!this._childrenCache) {
			this._childrenCache = [
				...this.sections,
				...this.orphanParagraphs,
				...this.images,
				...this.footnotes,
			];
		}
		return this._childrenCache;
	}

	findSentenceBySi(si: number): SentenceNode | null {
		return this.find(
			(n) => n.type === NodeType.Sentence && (n as SentenceNode).si === si,
		) as SentenceNode | null;
	}

	clearDomRefs(): void {
		this._childrenCache = null;
		this.walk((node) => {
			node.domRef = null;
		});
	}

	/** Link all typed children into the tree hierarchy. Call after populating children arrays. */
	linkChildren(): void {
		this._childrenCache = null; // bust cache
		this._adoptChildren([
			...this.sections,
			...this.orphanParagraphs,
			...this.images,
			...this.footnotes,
		]);
	}
}

export class SectionNode extends _BaseContentNode {
	readonly type = NodeType.Section;
	readonly id: NodeId;
	readonly level: number;
	readonly headingText: string;
	readonly headingTag: string;
	paragraphs: ParagraphNode[] = [];

	constructor(path: number[], level: number, headingText: string, headingTag: string) {
		super();
		this.id = NodeIdBuilder.section(path);
		this.level = level;
		this.headingText = headingText;
		this.headingTag = headingTag;
	}

	get children(): readonly ContentNode[] {
		return this.paragraphs;
	}

	linkChildren(): void {
		this._adoptChildren(this.paragraphs);
	}
}

export class ParagraphNode extends _BaseContentNode {
	readonly type = NodeType.Paragraph;
	readonly id: NodeId;
	readonly tagName: string;
	sentences: SentenceNode[] = [];
	readonly index: number;

	constructor(chapterIndex: number, paragraphIndex: number, tagName: string) {
		super();
		this.id = NodeIdBuilder.paragraph(paragraphIndex);
		this.tagName = tagName;
		this.index = paragraphIndex;
	}

	get children(): readonly ContentNode[] {
		return this.sentences;
	}

	linkChildren(): void {
		this._adoptChildren(this.sentences);
	}
}

export class SentenceNode extends _BaseContentNode {
	readonly type = NodeType.Sentence;
	readonly id: NodeId;
	readonly si: number;
	readonly text: string;

	constructor(si: number, text: string) {
		super();
		this.si = si;
		this.text = text;
		this.id = NodeIdBuilder.sentence(si);
	}

	get children(): readonly ContentNode[] {
		return [];
	}

	/** Stable anchor for future annotations */
	get anchor(): AnnotationAnchor {
		return {
			sentenceNodeId: this.id,
			offsetStart: 0,
			offsetEnd: this.text.length,
			textSnapshot: this.text,
		};
	}
}

export class ImageNode extends _BaseContentNode {
	readonly type = NodeType.Image;
	readonly id: NodeId;
	readonly src: string;
	readonly alt: string;
	readonly isFootnote: boolean;

	constructor(src: string, alt: string, isFootnote: boolean, index: number) {
		super();
		this.src = src;
		this.alt = alt;
		this.isFootnote = isFootnote;
		this.id = NodeIdBuilder.image(index);
	}

	get children(): readonly ContentNode[] {
		return [];
	}
}

export class FootnoteNode extends _BaseContentNode {
	readonly type = NodeType.Footnote;
	readonly id: NodeId;
	readonly refId: string;
	readonly contentHtml: string;
	paragraphs: ParagraphNode[] = [];

	constructor(refId: string, contentHtml: string, index: number) {
		super();
		this.refId = refId;
		this.contentHtml = contentHtml;
		this.id = NodeIdBuilder.footnote(index);
	}

	get children(): readonly ContentNode[] {
		return this.paragraphs;
	}

	linkChildren(): void {
		this._adoptChildren(this.paragraphs);
	}
}

// ─── NodeIdBuilder ───────────────────────────────────────────────────

export const NodeIdBuilder = {
	book(id: string): NodeId {
		return `book:${id}`;
	},
	chapter(index: number): NodeId {
		return `ch:${index}`;
	},
	section(path: number[]): NodeId {
		return `sec:${path.join(".")}`;
	},
	paragraph(index: number): NodeId {
		return `p:${index}`;
	},
	sentence(si: number): NodeId {
		return `s:${si}`;
	},
	image(index: number): NodeId {
		return `img:${index}`;
	},
	footnote(index: number): NodeId {
		return `fn:${index}`;
	},

	parse(id: NodeId): { type: string; value: string } {
		const colonIdx = id.indexOf(":");
		if (colonIdx === -1) return { type: "unknown", value: id };
		return { type: id.substring(0, colonIdx), value: id.substring(colonIdx + 1) };
	},

	chapterIndex(id: NodeId): number | null {
		const parsed = NodeIdBuilder.parse(id);
		if (parsed.type !== "ch") return null;
		const n = parseInt(parsed.value, 10);
		return isNaN(n) ? null : n;
	},

	sentenceSi(id: NodeId): number | null {
		const parsed = NodeIdBuilder.parse(id);
		if (parsed.type !== "s") return null;
		const n = parseInt(parsed.value, 10);
		return isNaN(n) ? null : n;
	},
};

// ─── Tree Construction ────────────────────────────────────────────────

/**
 * Create a BookNode with chapter stubs from a WASM handle's metadata.
 * Chapters are not parsed until parseChapterContent() is called.
 *
 * @param totalChapters  Number of spine items
 * @param getChapterHref  Callback to resolve spine index → resource path
 * @param tocData  Table of contents tree from handle.get_toc()
 * @param metadata  Book metadata
 * @param bookId  Optional unique book identifier (falls back to metadata.identifier)
 */
export function createBookFromHandle(
	totalChapters: number,
	getChapterHref: (index: number) => string | null,
	tocData: TocItem[],
	metadata: BookMetadata,
	bookId?: string,
): BookNode {
	const book = new BookNode(metadata, bookId);
	const chapters: ChapterNode[] = [];

	for (let i = 0; i < totalChapters; i++) {
		const ch = new ChapterNode(i);
		ch.href = getChapterHref(i);
		chapters.push(ch);
	}

	book.chapters = chapters;
	book.tocData = tocData;
	book.linkChapters();
	return book;
}

/** Block-level tags that start a new paragraph node */
const BLOCK_TAGS = new Set([
	"p", "div", "blockquote", "pre", "li", "td", "th",
	"h1", "h2", "h3", "h4", "h5", "h6",
]);

/**
 * Parse marked HTML into the chapter's content tree.
 * Populates sections, orphanParagraphs, images, and footnotes arrays.
 * Idempotent — safe to call multiple times with the same or different HTML.
 */
export function parseChapterContent(chapter: ChapterNode, markedHtml: string): void {
	// Reset
	chapter.sections = [];
	chapter.orphanParagraphs = [];
	chapter.images = [];
	chapter.footnotes = [];
	chapter.isParsed = false;

	const doc = new DOMParser().parseFromString(markedHtml, "text/html");
	const body = doc.body;
	if (!body) return;

	const children = Array.from(body.children);
	if (children.length === 0) return;

	const headingTags = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

	// Find heading indices
	const headingIndices: number[] = [];
	children.forEach((el, i) => {
		if (headingTags.has(el.tagName.toLowerCase())) {
			headingIndices.push(i);
		}
	});

	let paragraphCounter = 0;

	if (headingIndices.length === 0) {
		// No headings — all content is orphan paragraphs
		for (const el of children) {
			paragraphCounter = extractBlocks(el, chapter.orphanParagraphs, chapter, paragraphCounter);
		}
		chapter.linkChildren();
		chapter.isParsed = true;
		return;
	}

	// Has headings — partition into sections using a stack for nesting
	const sectionStack: SectionNode[] = [];
	const sectionPath: number[] = [];
	const allSections: SectionNode[] = [];
	let sectionCounter = 0;
	let currentSection: SectionNode | null = null;
	let contentBuffer: Element[] = [];
	let contentBeforeFirstHeading: Element[] = [];

	for (let i = 0; i < children.length; i++) {
		const el = children[i];
		const tag = el.tagName.toLowerCase();

		if (headingTags.has(tag)) {
			// Flush content buffer into current section
			if (currentSection && contentBuffer.length > 0) {
				for (const contentEl of contentBuffer) {
					paragraphCounter = extractBlocks(contentEl, currentSection.paragraphs, chapter, paragraphCounter);
				}
				contentBuffer = [];
			}

			// Create new section with nesting
			const level = parseInt(tag.charAt(1), 10);

			// Pop sections at same or deeper level
			while (sectionStack.length > 0 && sectionStack[sectionStack.length - 1].level >= level) {
				sectionStack.pop();
				sectionPath.pop();
			}

			sectionPath.push(sectionCounter);
			sectionCounter++;

			const headingText = el.textContent?.trim() ?? "";
			const section = new SectionNode([...sectionPath], level, headingText, tag);

			sectionStack.push(section);
			currentSection = section;
			allSections.push(section);

			// Content before first heading
			if (i === headingIndices[0]) {
				contentBeforeFirstHeading = [...contentBuffer];
				contentBuffer = [];
			}
		} else {
			contentBuffer.push(el);
		}
	}

	// Flush remaining buffer into last section
	if (contentBuffer.length > 0 && currentSection) {
		for (const contentEl of contentBuffer) {
			paragraphCounter = extractBlocks(contentEl, currentSection.paragraphs, chapter, paragraphCounter);
		}
	}

	// Content before first heading = orphan paragraphs
	for (const el of contentBeforeFirstHeading) {
		paragraphCounter = extractBlocks(el, chapter.orphanParagraphs, chapter, paragraphCounter);
	}

	// Assign all sections to chapter
	chapter.sections = allSections;

	// Link children
	for (const section of chapter.sections) {
		section.linkChildren();
	}
	chapter.linkChildren();
	chapter.isParsed = true;
}

/**
 * Extract paragraph / image / footnote nodes from a DOM element.
 * Returns the updated paragraph counter.
 */
function extractBlocks(
	element: Element,
	targetParagraphs: ParagraphNode[],
	chapter: ChapterNode,
	startIndex: number,
): number {
	let counter = startIndex;
	const tag = element.tagName.toLowerCase();

	if (BLOCK_TAGS.has(tag)) {
		const sentences = extractSentences(element);
		if (sentences.length > 0 || (element.textContent?.trim() ?? "").length > 0) {
			const para = new ParagraphNode(chapter.index, counter, tag);
			para.sentences = sentences;
			targetParagraphs.push(para);
			counter++;
		}
	} else if (tag === "img") {
		const src = element.getAttribute("src") ?? "";
		const alt = element.getAttribute("alt") ?? "";
		const isFn = element.matches(
			"img.qqreader-footnote, img.duokan-footnote, img[class*='footnote']",
		);
		const img = new ImageNode(src, alt, isFn, chapter.images.length);
		chapter.images.push(img);
	} else if (tag === "aside" || element.getAttribute("epub:type") === "footnote") {
		const refId = element.id || `fn-${counter}`;
		const fn = new FootnoteNode(refId, element.innerHTML, chapter.footnotes.length);
		chapter.footnotes.push(fn);
	} else {
		// Unknown wrapper — still try to extract sentences
		const sentences = extractSentences(element);
		if (sentences.length > 0) {
			const para = new ParagraphNode(chapter.index, counter, tag);
			para.sentences = sentences;
			targetParagraphs.push(para);
			counter++;
		}
	}

	return counter;
}

/**
 * Extract sentence nodes from an element by querying .epub-s[data-si] spans.
 */
function extractSentences(element: Element): SentenceNode[] {
	const sentenceSpans = element.querySelectorAll<HTMLElement>(".epub-s[data-si]");
	if (sentenceSpans.length === 0) return [];

	return Array.from(sentenceSpans).map((span) => {
		const si = parseInt(span.getAttribute("data-si") ?? "-1", 10);
		const text = span.textContent?.trim() ?? "";
		return new SentenceNode(si, text);
	});
}

// ─── DOM Integration ──────────────────────────────────────────────────

/**
 * Refresh domRef fields on tree nodes by scanning the rendered DOM container.
 * Call after the paginator loads new HTML into the DOM.
 */
export function refreshDomRefs(chapter: ChapterNode, container: HTMLElement): void {
	chapter.clearDomRefs();

	// Map all sentence spans to their tree nodes
	const sentenceSpans = Array.from(container.querySelectorAll<HTMLElement>(".epub-s[data-si]"));
	for (const span of sentenceSpans) {
		const si = parseInt(span.getAttribute("data-si") ?? "-1", 10);
		if (si < 0) continue;
		const sentenceNode = chapter.findSentenceBySi(si);
		if (sentenceNode) {
			sentenceNode.domRef = span;
		}
	}

	// Set paragraph/section domRef from closest ancestor elements
	chapter.walk((node) => {
		if (node.type === NodeType.Sentence && node.domRef) {
			let el = node.domRef.parentElement;
			const pBlock = new Set(["p", "div", "blockquote", "pre", "li", "td", "th"]);
			while (el && el !== container) {
				if (node.parent && !node.parent.domRef && pBlock.has(el.tagName.toLowerCase())) {
					node.parent.domRef = el;
				}
				el = el.parentElement;
			}
		}
	});
}

/**
 * Given a DOM element inside a chapter's rendered content, find the
 * corresponding tree node. Uses data-si on .epub-s spans for sentence lookup.
 */
export function findNodeFromElement(chapter: ChapterNode, element: HTMLElement): ContentNode | null {
	const sentenceSpan = element.closest<HTMLElement>(".epub-s[data-si]");
	if (sentenceSpan) {
		const si = parseInt(sentenceSpan.getAttribute("data-si") ?? "-1", 10);
		if (si >= 0) return chapter.findSentenceBySi(si);
	}

	// Walk up DOM looking for a node whose domRef matches
	let el: HTMLElement | null = element;
	while (el) {
		const match = chapter.find((n) => n.domRef === el);
		if (match) return match;
		el = el.parentElement;
	}

	return null;
}

// ─── Progress Anchoring ──────────────────────────────────────────────

/**
 * Create a ProgressAnchor from the current reading position.
 */
export function makeProgressAnchor(
	book: BookNode,
	chapterIndex: number,
	sentenceSi: number,
): ProgressAnchor {
	const chapter = book.chapters[chapterIndex];
	let nodeId: NodeId;

	if (chapter && sentenceSi >= 0) {
		const sentence = chapter.findSentenceBySi(sentenceSi);
		nodeId = sentence ? sentence.id : NodeIdBuilder.chapter(chapterIndex);
	} else {
		nodeId = NodeIdBuilder.chapter(chapterIndex);
	}

	return { nodeId, chapterIndex, sentenceSi };
}

/**
 * Resolve a ProgressAnchor to concrete chapter/sentence positions.
 * Falls back gracefully if the original target sentence no longer exists.
 */
export function resolveProgressToReadPosition(
	book: BookNode,
	anchor: ProgressAnchor,
): { chapterIndex: number; sentenceSi: number; scrollFraction: number } {
	let chapterIndex = anchor.chapterIndex;
	let sentenceSi = anchor.sentenceSi;

	// Clamp chapter index
	if (chapterIndex < 0) chapterIndex = 0;
	if (chapterIndex >= book.chapters.length) chapterIndex = book.chapters.length - 1;

	// Try to validate the sentence reference
	const chapter = book.chapters[chapterIndex];
	if (chapter && chapter.isParsed && sentenceSi >= 0) {
		const sentence = chapter.findSentenceBySi(sentenceSi);
		if (!sentence) {
			// Fall back to first sentence in chapter
			const firstSentence = chapter.find(
				(n) => n.type === NodeType.Sentence,
			) as SentenceNode | null;
			sentenceSi = firstSentence ? firstSentence.si : -1;
		}
	} else {
		sentenceSi = -1;
	}

	return { chapterIndex, sentenceSi, scrollFraction: 0 };
}

/**
 * Bridge: convert the legacy EpubProgress format to a ProgressAnchor.
 */
export function progressFromLegacy(p: EpubProgress): ProgressAnchor {
	return {
		nodeId:
			p.sentenceIndex >= 0
				? NodeIdBuilder.sentence(p.sentenceIndex)
				: NodeIdBuilder.chapter(p.chapterIndex),
		chapterIndex: p.chapterIndex,
		sentenceSi: p.sentenceIndex,
	};
}

/**
 * Bridge: convert a ProgressAnchor to the legacy EpubProgress for storage.
 */
export function progressToLegacy(
	anchor: ProgressAnchor,
	totalChapters: number,
	path: string,
): EpubProgress {
	return {
		epubPath: path,
		chapterIndex: anchor.chapterIndex,
		pageIndex: 0,
		sentenceIndex: anchor.sentenceSi >= 0 ? anchor.sentenceSi : 0,
		scrollFraction: 0,
		totalChapters,
		lastReadAt: 0,
		completionPercent:
			totalChapters > 0
				? Math.round(((anchor.chapterIndex + 1) / totalChapters) * 100)
				: 0,
	};
}
