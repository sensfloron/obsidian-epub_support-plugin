import { EpubProgress, ProgressStore } from "./progress_store";

export const SAVE_DEBOUNCE_MS = 300;

/**
 * Encapsulates debounce + persistence logic for reading progress.
 * Extracted from EpubView so progress save/load/schedule is testable
 * without instantiating the full view.
 */
export class ProgressTracker {
    private saveTimer: ReturnType<typeof setTimeout> | null = null;
    /** Latest progress snapshot — used by flush() to save even if schedule() hasn't fired */
    private pending: EpubProgress | null = null;

    constructor(
        private store: ProgressStore,
        private onSaved?: () => void,
    ) {}

    /** Write progress to the store immediately (no debounce). */
    save(progress: EpubProgress): void {
        this.store.setProgress(progress);
        this.pending = progress;
    }

    /** Debounced save — call from frequent events (page turns, scroll).
     *  Only the last call within the window is persisted. */
    schedule(progress: EpubProgress, debounceMs: number = SAVE_DEBOUNCE_MS): void {
        this.pending = progress;
        if (this.saveTimer) clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => {
            this.store.setProgress(progress);
            this.onSaved?.();
            this.saveTimer = null;
        }, debounceMs);
    }

    /**
     * Flush any pending debounced save immediately.
     * Call on chapter change / unload to avoid losing progress.
     */
    flush(): void {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
        if (this.pending) {
            this.store.setProgress(this.pending);
            this.onSaved?.();
        }
    }

    /** Cancel any pending debounce timer. Safe to call multiple times. */
    dispose(): void {
        if (this.saveTimer) clearTimeout(this.saveTimer);
        this.saveTimer = null;
        this.pending = null;
    }
}
