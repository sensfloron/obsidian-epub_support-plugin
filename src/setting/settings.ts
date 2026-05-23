import { App, PluginSettingTab, Setting } from 'obsidian';
import EpubSupportPlugin from '../main'

export type ViewMode = 'paginated' | 'scrolled';
export type PageTurnMode = 'swipe' | 'tap' | 'both';

export interface EpubPluginSettings {
    viewMode: ViewMode;
    pageTurnMode: PageTurnMode;
    notePath: string;
    useSameFolder: boolean;
    tags: string;
    columnCount: number;
    columnGap: number;
    transitionDuration: number;
    mobileColumnThreshold: number;
    outlineCollapsed: boolean;
    immersiveDefault: boolean;
}

/** 翻页冷却时间（毫秒），防止滚轮/按键快速连续翻页 */
export const PAGE_TURN_COOLDOWN_MS = 550;

export const DEFAULT_SETTINGS: EpubPluginSettings = {
    viewMode: 'paginated',
    pageTurnMode: 'both',
    notePath: '/',
    useSameFolder: true,
    tags: 'notes/booknotes',
    columnCount: 2,
    columnGap: 40,
    transitionDuration: 350,
    mobileColumnThreshold: 600,
    outlineCollapsed: true,
    immersiveDefault: true,
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
            .setName('翻页方式')
            .setDesc('滑动：通过滑动手势翻页；点击：点击屏幕左右侧翻页；两者：同时启用滑动与点击')
            .addDropdown(dropdown => dropdown
                .addOption('both', '两者')
                .addOption('swipe', '滑动')
                .addOption('tap', '点击')
                .setValue(this.plugin.settings.pageTurnMode)
                .onChange(async (value) => {
                    this.plugin.settings.pageTurnMode = value as PageTurnMode;
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

        new Setting(containerEl)
            .setName('单页栏数阈值')
                .setDesc('视口宽度低于此值（像素）时自动切换为单页模式，适合手机竖屏阅读')
                .addSlider(slider => slider
                    .setLimits(300, 1024, 25)
                    .setValue(this.plugin.settings.mobileColumnThreshold)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        this.plugin.settings.mobileColumnThreshold = value;
                        await this.plugin.saveSettings();
                    }));

            new Setting(containerEl)
                .setName('笔记存储路径')
            .setDesc('阅读笔记和标注的保存位置')
            .addText(text => text
                .setPlaceholder('/')
                .setValue(this.plugin.settings.notePath)
                .onChange(async (value) => {
                    this.plugin.settings.notePath = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('与 EPUB 同目录存储')
            .setDesc('是否在与 EPUB 文件相同的目录下创建笔记')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.useSameFolder)
                .onChange(async (value) => {
                    this.plugin.settings.useSameFolder = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('默认标签')
            .setDesc('新创建的阅读笔记自动添加的标签（空格分隔）')
            .addText(text => text
                .setPlaceholder('notes/booknotes')
                .setValue(this.plugin.settings.tags)
                .onChange(async (value) => {
                    this.plugin.settings.tags = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('默认沉浸模式')
            .setDesc('打开 EPUB 时自动进入沉浸阅读模式（隐藏 Obsidian 界面元素）。关闭后可在标签栏手动切换')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.immersiveDefault)
                .onChange(async (value) => {
                    this.plugin.settings.immersiveDefault = value;
                    await this.plugin.saveSettings();
                }));
    }
}
