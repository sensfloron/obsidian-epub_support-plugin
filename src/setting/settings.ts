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
			.setName('缓存大小')
			.setDesc('It\'s a secret')
			.addText(text => text
				.setPlaceholder('Enter your secret')
				.setValue(this.plugin.settings.mySetting)
				.onChange(async (value) => {
					this.plugin.settings.mySetting = value;
					await this.plugin.saveSettings();
				}));
	}
}
