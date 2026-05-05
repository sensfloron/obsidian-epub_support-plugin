import { App, PluginSettingTab, Setting } from 'obsidian';
import EpubSupportPlugin from '../main'

export type ViewMode = 'paginated' | 'scrolled';

export interface EpubPluginSettings {
	viewMode: ViewMode;
	notePath: string;
	useSameFolder: boolean;
	tags: string;
	columnCount: number;
	columnGap: number;
	transitionDuration: number;
}

export const DEFAULT_SETTINGS: EpubPluginSettings = {
	viewMode: 'paginated',
	notePath: '/',
	useSameFolder: true,
	tags: 'notes/booknotes',
	columnCount: 2,
	columnGap: 40,
	transitionDuration: 350,
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
			.setName('阅读模式')
			.setDesc('分页阅读：逐页翻看；滚动阅读：连续滚动全部章节')
			.addDropdown(dropdown => dropdown
				.addOption('paginated', '分页阅读')
				.addOption('scrolled', '滚动阅读')
				.setValue(this.plugin.settings.viewMode)
				.onChange(async (value) => {
					this.plugin.settings.viewMode = value as ViewMode;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('单页栏数')
			.setDesc('分页模式中每页显示的栏目数量（模拟书本双栏）')
			.addSlider(slider => slider
				.setLimits(1, 4, 1)
				.setValue(this.plugin.settings.columnCount)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.columnCount = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('页间距')
			.setDesc('分页模式中页面之间的间隔（像素）')
			.addSlider(slider => slider
				.setLimits(0, 80, 4)
				.setValue(this.plugin.settings.columnGap)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.columnGap = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('翻页动画时长')
			.setDesc('分页模式中页面切换动画的持续时间（毫秒）')
			.addSlider(slider => slider
				.setLimits(0, 800, 50)
				.setValue(this.plugin.settings.transitionDuration)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.transitionDuration = value;
					await this.plugin.saveSettings();
				}));
	}
}
