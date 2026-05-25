# EPUB Support Plugin for Obsidian

[![GitHub release](https://img.shields.io/github/v/release/sensfloron/obsidian-epub_support-plugin?style=flat-square)](https://github.com/sensfloron/obsidian-epub_support-plugin/releases)
[English](README_en.md)

在 Obsidian 中直接阅读和管理 EPUB 电子书的插件，基于 Rust WASM 构建，支持分页阅读、连续滚动、大纲导航、沉浸模式等功能。

## 功能

- **EPUB 解析与渲染** — 基于 Rust WASM 的高性能 EPUB 解析，支持章节内容提取、内嵌图片、代码块渲染
- **分页阅读模式** — CSS 多栏分页，可配置 1-4 栏、页间距、翻页动画时长，支持键盘 / 鼠标 / 触屏翻页
- **滚动阅读模式** — 连续垂直滚动，所有章节无缝衔接
- **大纲导航** — 提取 EPUB 目录结构，树形展示，支持搜索筛选、折叠、自动定位当前章节
- **沉浸阅读模式** — 桌面端自动隐藏 Obsidian 界面元素，移动端点击切换，专注阅读体验
- **阅读进度持久化** — 自动保存当前章节、页码、句子位置、滚动进度、完成百分比
- **脚注弹窗** — 点击脚注引用弹出浮动窗口显示内容
- **图片查看器** — 支持缩放、拖拽、双击切换缩放

## 安装

### 通过发行版安装（推荐）

1. 从 [Releases](https://github.com/sensfloron/obsidian-epub_support-plugin/releases) 下载 `epub_rs-plugin-{version}.zip`
2. 解压到 vault 的 `.obsidian/plugins/epub_rs-plugin/` 目录
3. 如需内嵌字体支持，下载 `epub_rs-plugin-fonts.zip` 解压到同目录
4. 重启 Obsidian，在设置中启用插件

### 手动构建

```bash
# 需要 Node.js 18+ 和 Rust 工具链（wasm32-unknown-unknown）
git clone https://github.com/sensfloron/obsidian-epub_support-plugin.git
cd obsidian-epub_support-plugin
npm ci
npm run build
```

## 使用

1. 将 `.epub` 文件放入 Obsidian vault
2. 点击文件即可在 EPUB 视图中打开
3. 使用左侧大纲面板浏览章节
4. 在设置中调整阅读偏好

## 设置

| 选项 | 说明 |
|------|------|
| 默认视图模式 | 分页模式 / 滚动模式 |
| 翻页方式 | 左右翻页 / 上下翻页 |
| 分页栏数 | 1-4 栏 |
| 栏间距 | CSS 值（如 `40px`） |
| 翻页动画时长 | 毫秒 |
| 启动时进入沉浸模式 | 开关 |
| 笔记保存路径 | EPUB 笔记存储位置 |

## 开发

```bash
npm run dev        # TypeScript 热编译
npm run dev:wasm   # WASM 监听编译
npm run build      # 完整构建（WASM + TS + esbuild）
```

## 技术栈

- TypeScript + esbuild
- Rust → WASM（epub 解析、中文分句）
- Obsidian Plugin API

## 许可

MIT

## 作者

[Floron Eon](https://github.com/sensfloron)
