## 实现目标
让 EPUB 代码块语法高亮的亮色/暗色自动跟随 Obsidian 的 `body.theme-dark` 切换。

## 现状诊断
经过探查确认：

1. **高亮由 Rust/WASM（syntect）生成**，输出 `tok-*` 语义类（如 `tok-keyword`），TS 端 `EpubView.ensureSyntaxThemeStyle()`（`src/view/epub_view.ts:343`）调用 wasm 的 `get_combined_theme_css()` 注入一次 `<style class="epub-syntax-theme-style">`。
2. **Rust 源码**（`src/lib/epub_note_module/src/lib.rs:160` `theme_get_combined_css`）已尝试用 `@scope (body.theme-dark) { … }` 包裹暗色规则实现切换。
3. **但有两个问题**：
   - **未构建部署**：`main.js` 里 `tok-` CSS 为 0 条、`@scope` 仅 1 处（属于别的旧逻辑），`epub_note_module_bg.wasm` 里 `@scope` 为 0 —— 即源码改动从未编进产物，功能当前完全失效。
   - **`@scope` 兼容性脆弱**：`@scope` 是较新的 CSS at-rule，旧版 Obsidian 使用的 Electron/Chromium 可能不支持；而 Obsidian 生态（Prism、highlight.js 适配）通用做法是给选择器加 `body.theme-dark` 前缀，兼容所有版本。

## 实施方案

唯一改动点：`src/lib/epub_note_module/src/lib.rs` 的 `theme_get_combined_css()`（160-190 行）。

把暗色规则的包裹方式从 `@scope (body.theme-dark) { … }` 改为「逐条给选择器加 `body.theme-dark ` 前缀」。

具体做法：
- 用 `syntect` 的 `css_for_theme_with_class_style` 生成暗色 CSS 后，按 `}` 拆分成单条规则。
- 对每条规则，把其中的逗号分隔选择器列表里每个选择器前面都加上 `body.theme-dark `。
- 例如 `.tok-keyword { color: #cde; }` → `body.theme-dark .tok-keyword { color: #cde; }`，`.plain-text, .tok-string { ... }` → `body.theme-dark .plain-text, body.theme-dark .tok-string { ... }`。
- 这样既等价于 `@scope` 的效果（仅当 `body.theme-dark` 存在时生效，否则被亮色默认覆盖），又能在所有 Obsidian 版本下工作。

亮色默认规则保持不变（裸 `tok-*` 选择器）。

实现用纯字符串处理（无需新依赖），并保留原有的注释/可读性。

## 关键约束
- **必须重新构建 WASM**：源码改完需执行 `npm run build:wasm`（项目 `package.json` 已配置，会调 `wasm-pack` 生成 `pkg` 并被 esbuild 打包进 `main.js`），否则改动不生效。这一步依赖本机已装 Rust + wasm-pack；如未安装，会提示用户。
- 之后跑 `npm run build`（= `build:wasm` + esbuild）生成新的 `main.js` / `epub_note_module_bg.wasm`。
- 不需要新增 JS 监听器、不需要改 settings、不需要改 TS 注入逻辑（CSS 级联自动切换）。

## 不改动
- `styles.css`、`epub_view.ts` 的注入逻辑、TS 端调用点 —— 全部不动，CSS 级联方案保持。
- 不引入 Prism / highlight.js。

## 验证
1. `npm run build` 成功生成新 wasm + main.js。
2. 在 Obsidian 中：浅色主题下代码块显示亮色主题；切换到深色主题后，**无需刷新/重开**，代码块自动变为深色主题。
3. 检查注入的 `<style class="epub-syntax-theme-style">` 内容：含亮色默认 `.tok-*` 规则，且暗色规则全部带 `body.theme-dark ` 前缀、无 `@scope`。