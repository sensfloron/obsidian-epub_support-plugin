/**
 * 浏览器风格的双栈阅读位置历史。
 *
 * 设计语义对齐 Chrome/Edge 的 back/forward：
 * - `push(current)`：在一次"大跳转"发生**前**调用，把跳转前的位置压入
 *   backStack，并清空 forwardStack（新跳转分支使前进历史失效）。
 *   调用方负责只在"真实跳转"的分支里调用，因此本方法不做去重 ——
 *   例如 EpubView 的 navigateChapter 已确保 no-op 边界路径不会触发 push。
 * - `back(current)` / `forward(current)`：回退/前进一步，返回目标位置；
 *   栈空时返回 null。调用方需把"当前位置"传入，以便正确地把它推入
 *   对向栈。
 *
 * 当前位置本身不入栈（隐式为"当前页"），这与浏览器的语义一致：
 * 栈中存的是"可以回到的过去位置"和"可以再前往的未来位置"。
 */

/** 一个可被恢复的阅读位置快照。 */
export interface ReadingLocation {
    /** 当前章节（spine 索引，0-based）；扉页用 TITLEPAGE_INDEX(-1) */
    chapterIndex: number;
    /** 章节内页码（分页模式）；滚动模式无意义，保持 0 */
    pageIndex: number;
    /** 是否停留在扉页 */
    showingTitlePage: boolean;
}

const MAX_STACK = 200;

export class NavigationHistory {
    private backStack: ReadingLocation[] = [];
    private forwardStack: ReadingLocation[] = [];

    /**
     * 大跳转前调用：把 current 压入 backStack 并清空 forwardStack
     *（新跳转分支使前进历史失效）。
     */
    push(current: ReadingLocation): void {
        this.backStack.push(current);
        if (this.backStack.length > MAX_STACK) {
            this.backStack.shift();
        }
        // 新跳转分支：前进历史失效
        this.forwardStack = [];
    }

    /**
     * 回退一步。返回目标位置，或栈空时返回 null。
     * `current`（当前位置）会被推入 forwardStack。
     */
    back(current: ReadingLocation): ReadingLocation | null {
        if (this.backStack.length === 0) return null;
        const target = this.backStack.pop()!;
        this.forwardStack.push(current);
        if (this.forwardStack.length > MAX_STACK) {
            this.forwardStack.shift();
        }
        return target;
    }

    /**
     * 前进一步。返回目标位置，或栈空时返回 null。
     * `current`（当前位置）会被推入 backStack。
     */
    forward(current: ReadingLocation): ReadingLocation | null {
        if (this.forwardStack.length === 0) return null;
        const target = this.forwardStack.pop()!;
        this.backStack.push(current);
        if (this.backStack.length > MAX_STACK) {
            this.backStack.shift();
        }
        return target;
    }

    canGoBack(): boolean {
        return this.backStack.length > 0;
    }

    canGoForward(): boolean {
        return this.forwardStack.length > 0;
    }

    clear(): void {
        this.backStack = [];
        this.forwardStack = [];
    }
}
