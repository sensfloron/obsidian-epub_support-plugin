/**
 * Manages the full-screen image viewer overlay: zoom-to-fit with wheel/pinch
 * scaling, mouse/touch pan, GIF reset, and double-click 1×↔2× toggle.
 *
 * Extracted from EpubView so gesture state (14 fields) and 13 handler methods
 * no longer pollute the view class.  The controller self-manages its document
 * listeners and cleans them up in dispose() — no Obsidian dependency needed.
 */
export class ImageViewerController {
    // ── DOM ──
    private backdrop: HTMLElement | null = null;
    private overlay: HTMLElement | null = null;
    private img: HTMLImageElement | null = null;
    private closeBtn: HTMLElement | null = null;
    private gifBadge: HTMLElement | null = null;

    // ── Gesture state ──
    private scale = 1;
    private panX = 0;
    private panY = 0;
    private panning = false;
    private panStartX = 0;
    private panStartY = 0;
    private panOrigX = 0;
    private panOrigY = 0;
    private pinchStartDist = 0;
    private pinchStartScale = 1;
    private touchInEdgeZone = false;

    // ── Document listeners (tracked for self-cleanup) ──
    private docKeydownHandler: ((e: KeyboardEvent) => void) | null = null;
    private docMousemoveHandler: ((e: MouseEvent) => void) | null = null;
    private docMouseupHandler: (() => void) | null = null;

    constructor(private contentEl: HTMLElement) {}

    // ── Public API ──

    /** Open the viewer for an image element. Lazy-installs DOM on first call. */
    show(img: HTMLImageElement): void {
        if (!this.backdrop) this.install();

        if (!this.backdrop || !this.img || !this.closeBtn) return;

        const isGif =
            img.src.startsWith("data:image/gif") || /\.gif/i.test(img.src);

        // Force-reload so GIFs restart from frame 0.
        this.img.removeAttribute("src");
        requestAnimationFrame(() => {
            if (!this.img) return;
            this.img.src = img.src;
        });

        if (isGif) {
            this.img.dataset.gif = "true";
            this.gifBadge?.show();
        } else {
            delete this.img.dataset.gif;
            this.gifBadge?.hide();
        }

        this.scale = 1;
        this.panX = 0;
        this.panY = 0;
        this.applyTransform();

        this.backdrop.show();
        this.closeBtn.show();
        document.body.style.overflow = "hidden";
    }

    /** Close the viewer. Restores body overflow and releases the image src. */
    hide(): void {
        this.backdrop?.hide();
        this.closeBtn?.hide();
        this.gifBadge?.hide();
        this.panning = false;
        document.body.style.overflow = "";
        // Remove src to free memory (avoid src="" which triggers a base-URL request).
        this.img?.removeAttribute("src");
    }

    /** Remove DOM, detach all listeners, restore body overflow. Safe to call repeatedly. */
    dispose(): void {
        // Document listeners
        if (this.docKeydownHandler) {
            document.removeEventListener("keydown", this.docKeydownHandler);
            this.docKeydownHandler = null;
        }
        if (this.docMousemoveHandler) {
            document.removeEventListener("mousemove", this.docMousemoveHandler);
            this.docMousemoveHandler = null;
        }
        if (this.docMouseupHandler) {
            document.removeEventListener("mouseup", this.docMouseupHandler);
            this.docMouseupHandler = null;
        }

        // Clean up DOM (removing removes their listeners too)
        this.backdrop?.remove();
        this.backdrop = null;
        this.overlay = null;
        this.img = null;
        this.closeBtn?.remove();
        this.closeBtn = null;
        this.gifBadge = null;

        // Safety net: restore body overflow
        document.body.style.overflow = "";
        this.panning = false;
    }

    // ── Infrastructure (lazy init) ──

    private install(): void {
        if (this.backdrop) return;

        this.backdrop = this.contentEl.createDiv("epub-image-backdrop");
        this.backdrop.hide();

        this.overlay = this.backdrop.createDiv("epub-image-overlay");
        this.img = this.overlay.createEl("img");

        this.closeBtn = this.contentEl.createEl("button", {
            cls: "epub-image-close-btn",
        });
        this.closeBtn.setText("×");
        this.closeBtn.hide();

        this.gifBadge = this.overlay.createDiv("epub-image-gif-badge");
        this.gifBadge.setText("GIF");
        this.gifBadge.hide();

        // ── Backdrop listeners (self-owned — cleaned up on DOM removal) ──

        // Shield Obsidian mobile non-edge gestures:
        // - Edge zone (24px left/right) passes through for sidebar swipe.
        // - Image zone is handled by img handlers (scale/drag).
        // - Everything else is blocked to prevent accidental sidebar/command palette.
        this.backdrop.addEventListener(
            "touchstart",
            (e) => {
                const edgeW = 24;
                const touchX = e.touches[0]?.clientX ?? 0;
                this.touchInEdgeZone =
                    touchX < edgeW || touchX > window.innerWidth - edgeW;
                if (!this.touchInEdgeZone) {
                    e.stopPropagation();
                }
            },
            { passive: true },
        );
        this.backdrop.addEventListener("touchmove", (e) => {
            if (!this.touchInEdgeZone) {
                e.preventDefault();
                e.stopPropagation();
            }
        }, { passive: false });
        this.backdrop.addEventListener("touchend", () => {
            this.touchInEdgeZone = false;
        });

        // Click backdrop to close
        this.backdrop.addEventListener("click", (e) => {
            if (e.target === this.backdrop) this.hide();
        });

        // Close button
        this.closeBtn.addEventListener("click", () => this.hide());

        // ── Document listeners (tracked for manual cleanup) ──
        this.docKeydownHandler = (e: KeyboardEvent) => {
            if (
                e.key === "Escape" &&
                this.backdrop &&
                !this.backdrop.hidden
            ) {
                this.hide();
            }
        };
        document.addEventListener("keydown", this.docKeydownHandler);

        this.docMousemoveHandler = (e: MouseEvent) => {
            if (!this.panning) return;
            this.panX =
                this.panOrigX + (e.clientX - this.panStartX);
            this.panY =
                this.panOrigY + (e.clientY - this.panStartY);
            this.clampPan();
            this.applyTransform();
        };
        document.addEventListener("mousemove", this.docMousemoveHandler);

        this.docMouseupHandler = () => {
            this.panning = false;
            this.img?.removeClass("grabbing");
        };
        document.addEventListener("mouseup", this.docMouseupHandler);

        // ── Overlay / img listeners (self-owned — cleaned up on DOM removal) ──

        // Wheel zoom
        this.overlay.addEventListener("wheel", this.onWheel, { passive: false });

        // Mouse drag pan
        this.img.addEventListener("mousedown", this.onMouseDown);

        // Double-click toggle 1× ↔ 2×
        this.img.addEventListener("dblclick", this.onDblClick);

        // Touch pinch zoom + single-finger pan
        this.img.addEventListener("touchstart", this.onTouchStart, {
            passive: false,
        });
        this.img.addEventListener("touchmove", this.onTouchMove, {
            passive: false,
        });
        this.img.addEventListener("touchend", this.onTouchEnd);
    }

    // ── Transforms ──

    private applyTransform(): void {
        if (!this.img) return;
        this.img.style.transform =
            `translate(${this.panX}px, ${this.panY}px) scale(${this.scale})`;
    }

    private clampPan(): void {
        if (this.scale <= 1) {
            this.panX = 0;
            this.panY = 0;
            return;
        }
        const s = this.scale;
        const maxD = 200 * (s - 1);
        this.panX = Math.max(-maxD, Math.min(maxD, this.panX));
        this.panY = Math.max(-maxD, Math.min(maxD, this.panY));
    }

    // ── Gesture handlers ──

    private onWheel = (e: WheelEvent): void => {
        e.preventDefault();
        const delta = -e.deltaY * 0.005;
        const prev = this.scale;
        this.scale = Math.max(
            0.5,
            Math.min(5, this.scale * (1 + delta)),
        );
        // Approximate centre-zoom toward cursor position
        if (this.scale !== prev && this.scale > 1 && this.img) {
            const rect = this.img.getBoundingClientRect();
            const cx = e.clientX - rect.left;
            const cy = e.clientY - rect.top;
            const factor = this.scale / prev - 1;
            this.panX -= cx * factor;
            this.panY -= cy * factor;
        }
        if (this.scale <= 1) {
            this.panX = 0;
            this.panY = 0;
        }
        this.clampPan();
        this.applyTransform();
    };

    private onMouseDown = (e: MouseEvent): void => {
        if (this.scale <= 1) return;
        e.preventDefault();
        this.panning = true;
        this.panStartX = e.clientX;
        this.panStartY = e.clientY;
        this.panOrigX = this.panX;
        this.panOrigY = this.panY;
        this.img?.addClass("grabbing");
    };

    private onDblClick = (e: MouseEvent): void => {
        e.preventDefault();
        if (this.scale > 1.1) {
            this.scale = 1;
        } else {
            this.scale = 2;
        }
        this.panX = 0;
        this.panY = 0;
        this.applyTransform();
    };

    private onTouchStart = (e: TouchEvent): void => {
        if (e.touches.length === 2) {
            e.preventDefault();
            const dx = e.touches[0].clientX - e.touches[1].clientX;
            const dy = e.touches[0].clientY - e.touches[1].clientY;
            this.pinchStartDist = Math.hypot(dx, dy);
            this.pinchStartScale = this.scale;
        } else if (e.touches.length === 1 && this.scale > 1) {
            this.panning = true;
            this.panStartX = e.touches[0].clientX;
            this.panStartY = e.touches[0].clientY;
            this.panOrigX = this.panX;
            this.panOrigY = this.panY;
        }
    };

    private onTouchMove = (e: TouchEvent): void => {
        if (e.touches.length === 2 && this.pinchStartDist > 0) {
            e.preventDefault();
            const dx = e.touches[0].clientX - e.touches[1].clientX;
            const dy = e.touches[0].clientY - e.touches[1].clientY;
            const dist = Math.hypot(dx, dy);
            this.scale = Math.max(
                0.5,
                Math.min(
                    5,
                    this.pinchStartScale *
                        (dist / this.pinchStartDist),
                ),
            );
            if (this.scale <= 1) {
                this.panX = 0;
                this.panY = 0;
            }
            this.applyTransform();
        } else if (e.touches.length === 1 && this.panning) {
            this.panX =
                this.panOrigX +
                (e.touches[0].clientX - this.panStartX);
            this.panY =
                this.panOrigY +
                (e.touches[0].clientY - this.panStartY);
            this.clampPan();
            this.applyTransform();
        }
    };

    private onTouchEnd = (_e: TouchEvent): void => {
        this.panning = false;
        this.pinchStartDist = 0;
    };
}
