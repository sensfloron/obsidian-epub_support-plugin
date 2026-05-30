export interface EpubProgress {
    /** Vault path to the EPUB file — primary key */
    epubPath: string;
    /** Spine chapter index (0-based) */
    chapterIndex: number;
    /** Page index within chapter (paginated mode, 0-based) */
    pageIndex: number;
    /** Index of the first visible sentence on the page */
    sentenceIndex: number;
    /** Scroll fraction 0–1 (scrolled mode) */
    scrollFraction: number;
    /** Snapshot of total chapters at save time */
    totalChapters: number;
    /** Unix timestamp (ms) of last read */
    lastReadAt: number;
    /** Completion percentage 0–100 */
    completionPercent: number;
}

type ProgressMap = Record<string, EpubProgress>;

export const PROGRESSES_KEY = 'epubProgresses';

export class ProgressStore {
    private progresses: ProgressMap;

    constructor() {
        this.progresses = {};
    }

    /** Hydrate from plugin data.json on load */
    load(data: Record<string, unknown> | null): void {
        this.progresses = (data?.[PROGRESSES_KEY] as ProgressMap) ?? {};
    }

    /** Serialize for persistence. Caller merges with other plugin data. */
    toJSON(): ProgressMap {
        return this.progresses;
    }

    getProgress(epubPath: string): EpubProgress | null {
        return this.progresses[epubPath] ?? null;
    }

    setProgress(progress: EpubProgress): void {
        this.progresses[progress.epubPath] = {
            ...progress,
            lastReadAt: Date.now(),
        };
    }

    deleteProgress(epubPath: string): void {
        delete this.progresses[epubPath];
    }

    /** Migrate progress from oldPath to newPath (file rename / move). No-op if oldPath has no entry. */
    migrateProgress(oldPath: string, newPath: string): void {
        if (this.progresses[oldPath]) {
            this.progresses[newPath] = {
                ...this.progresses[oldPath],
                epubPath: newPath,
            };
            delete this.progresses[oldPath];
        }
    }

    listAll(): EpubProgress[] {
        return Object.values(this.progresses).sort(
            (a, b) => b.lastReadAt - a.lastReadAt,
        );
    }
}
