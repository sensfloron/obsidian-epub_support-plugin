import { App, PluginSettingTab, Setting } from 'obsidian';
import EpubSupportPlugin from '../main'

export interface EpubPluginSettings {
	scrolledView: boolean;
	notePath: string;
	useSameFolder: boolean;
	tags: string;
}

export const DEFAULT_SETTINGS: EpubPluginSettings = {
	scrolledView: false,
	notePath: '/',
	useSameFolder: true,
	tags: 'notes/booknotes'
}



export class EpubSettingTab extends PluginSettingTab {
	plugin: EpubSupportPlugin;

	constructor(app: App, plugin: EpubSupportPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('滚动阅读')
			.setDesc('启用后一次性渲染全部章节，支持滚动阅读；关闭则逐章翻页')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.scrolledView)
				.onChange(async (value) => {
					this.plugin.settings.scrolledView = value;
					await this.plugin.saveSettings();
				}));
	}
}
