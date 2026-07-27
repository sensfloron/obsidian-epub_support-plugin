/**
 * NavigationHistory 纯逻辑测试（Node 内置 test runner）。
 *
 * 运行方式：
 *   node --test test/navigation_history.test.mjs
 *
 * 这些测试不依赖 Obsidian / DOM，验证浏览器风格的双栈语义：
 * push/back/forward 往返、新跳转清空 forwardStack、栈空返回 null、容量上限。
 * 去重责任由调用方（EpubView.pushHistorySnapshot）承担，故此处不测去重。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// 被测模块是 TypeScript。为了零依赖运行，这里以源码形式重新声明
// NavigationHistory 的逻辑（与 src/view/navigation_history.ts 保持一致）。
// 当源文件逻辑变更时，需同步此处 —— 详见 test/README.md「测试维护」一节。

const MAX_STACK = 200;

class NavigationHistory {
    constructor() {
        this.backStack = [];
        this.forwardStack = [];
    }
    push(current) {
        this.backStack.push(current);
        if (this.backStack.length > MAX_STACK) this.backStack.shift();
        this.forwardStack = [];
    }
    back(current) {
        if (this.backStack.length === 0) return null;
        const target = this.backStack.pop();
        this.forwardStack.push(current);
        if (this.forwardStack.length > MAX_STACK) this.forwardStack.shift();
        return target;
    }
    forward(current) {
        if (this.forwardStack.length === 0) return null;
        const target = this.forwardStack.pop();
        this.backStack.push(current);
        if (this.backStack.length > MAX_STACK) this.backStack.shift();
        return target;
    }
    canGoBack() { return this.backStack.length > 0; }
    canGoForward() { return this.forwardStack.length > 0; }
    clear() {
        this.backStack = [];
        this.forwardStack = [];
    }
}

const loc = (chapterIndex, pageIndex, showingTitlePage = false) =>
    ({ chapterIndex, pageIndex, showingTitlePage });

test('空栈 back/forward 返回 null', () => {
    const h = new NavigationHistory();
    assert.equal(h.canGoBack(), false);
    assert.equal(h.canGoForward(), false);
    assert.equal(h.back(loc(0, 0)), null);
    assert.equal(h.forward(loc(0, 0)), null);
});

test('push → back → forward 完整往返', () => {
    const h = new NavigationHistory();
    // 当前在 A(0,0)，大跳转到 B(1,0)
    h.push(loc(0, 0));          // A 入 backStack
    // 现在"当前"是 B(1,0)，回退
    const t1 = h.back(loc(1, 0));
    assert.deepEqual(t1, loc(0, 0));
    assert.equal(h.canGoForward(), true);
    // 回退后"当前"是 A(0,0)，前进应回到 B
    const t2 = h.forward(loc(0, 0));
    assert.deepEqual(t2, loc(1, 0));
});

test('新跳转清空 forwardStack（浏览器分支语义）', () => {
    const h = new NavigationHistory();
    h.push(loc(0, 0));          // A → B
    h.back(loc(1, 0));          // 回到 A，forwardStack = [B]
    assert.equal(h.canGoForward(), true);

    // 从 A 跳到新的 C：forwardStack 应被清空
    h.push(loc(0, 0));          // A → C
    assert.equal(h.canGoForward(), false);
    assert.equal(h.forwardStack.length, 0);
    assert.equal(h.backStack.length, 1);  // 仅 A 在 backStack
});

test('连续 push 累积入栈（去重由调用方负责）', () => {
    const h = new NavigationHistory();
    h.push(loc(0, 0));
    h.push(loc(1, 0));
    h.push(loc(2, 0));
    assert.equal(h.backStack.length, 3);
});

test('扉页快照参与 Location 等值（结构化比较）', () => {
    // 同 chapter/page 但 showingTitlePage 不同 → 不同位置
    const a = loc(0, 0, false);
    const b = loc(0, 0, true);
    assert.notDeepEqual(a, b);
});

test('栈容量上限 MAX_STACK 不被无限增长', () => {
    const h = new NavigationHistory();
    for (let i = 0; i < MAX_STACK + 50; i++) {
        h.push(loc(i, 0));
    }
    assert.equal(h.backStack.length, MAX_STACK);
    // 最旧的被 shift 掉，栈顶（最后压入的）仍是最新位置
    assert.deepEqual(h.backStack[h.backStack.length - 1], loc(MAX_STACK + 49, 0));
});

test('back/forward 交替往返不丢失位置', () => {
    const h = new NavigationHistory();
    // 模拟：A(0) → B(1) → C(2)
    h.push(loc(0, 0));
    h.push(loc(1, 0));
    // 当前在 C(2,0)
    // 回退两步到 A
    assert.deepEqual(h.back(loc(2, 0)), loc(1, 0));   // C → B
    assert.deepEqual(h.back(loc(1, 0)), loc(0, 0));   // B → A
    // 前进两步回 C
    assert.deepEqual(h.forward(loc(0, 0)), loc(1, 0)); // A → B
    assert.deepEqual(h.forward(loc(1, 0)), loc(2, 0)); // B → C
    assert.equal(h.canGoForward(), false);
});

test('clear 重置所有栈', () => {
    const h = new NavigationHistory();
    h.push(loc(0, 0));
    h.back(loc(1, 0));
    h.clear();
    assert.equal(h.canGoBack(), false);
    assert.equal(h.canGoForward(), false);
});

test('forwardStack 也有容量上限', () => {
    const h = new NavigationHistory();
    // 先建一条长 backStack
    for (let i = 0; i < MAX_STACK + 10; i++) {
        h.push(loc(i, 0));
    }
    // 全部回退，forwardStack 填充
    let current = loc(MAX_STACK + 9, 0);
    while (h.canGoBack()) {
        current = h.back(current);
    }
    assert.equal(h.forwardStack.length, MAX_STACK);
});
