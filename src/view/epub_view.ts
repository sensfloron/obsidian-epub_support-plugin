import { FileView, TFile ,WorkspaceLeaf } from "obsidian";
import { EpubPluginSettings } from "../setting/settings";
// import { EpubReader } from "./EpubReader";

export const EPUB_FILE_EXTENSION = "epub";
export const VIEW_TYPE_EPUB = "epub";
export const ICON_EPUB = "doc-epub";

export class EpubView extends FileView {
	allowNoFile: false

	constructor(leaf: WorkspaceLeaf, private settings: EpubPluginSettings) {
		super(leaf);
	}

	async onLoadFile(file: TFile): Promise<void> {
		this.contentEl.empty();
		const path = file.path;
		console.log(path)
		// const contents = await this.app.vault.adapter.readBinary(file.path);

	}

	onunload(): void {
	}

	getDisplayText() {
		if (this.file) {
			return this.file.basename;
		} else {
			return 'No File';
		}
	}

	canAcceptExtension(extension: string) {
		return extension == EPUB_FILE_EXTENSION;
	}

	getViewType() {
		return EPUB_FILE_EXTENSION;
	}

	getIcon() {
		return ICON_EPUB;
	}
}
