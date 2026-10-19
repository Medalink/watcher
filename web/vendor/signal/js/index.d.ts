// Types for signal-design/js.

export type Theme = "ink" | "graphite" | "paper" | "auto";
/** "light" is the older name for "paper" and is still accepted. */
export type ThemeName = Theme | "light";
export type Tone = "accent" | "success" | "danger" | "warning" | "pending" | "extra" | "neutral";

/** Wire up every behavior (delegated, so later markup works too). Call once. */
export function init(options?: {
  /** Restore the remembered theme. Default true. */
  theme?: boolean;
  /** "auto" hides scrollbars 2s after scrolling stops. Default "auto". */
  scrollbars?: "auto" | "always";
  /** Key combo that steps the theme; false turns it off. Default "shift+t". */
  themeKey?: string | false;
}): void;

/* Dialogs */
export function openDialog(target: string | HTMLDialogElement): HTMLDialogElement | null;
export function closeDialog(target: string | HTMLDialogElement, returnValue?: string): HTMLDialogElement | null;

/* Tabs, expand */
export function selectTab(tab: HTMLElement): void;
export function setExpanded(target: string | HTMLElement, open?: boolean): void;

/* Toast */
export function toast(
  message: string | Node,
  options?: { tone?: Tone; timeout?: number; action?: { label: string; onClick?: () => void } },
): () => void;

/* Keyboard */
export function hotkeys(
  map: Record<string, (event: KeyboardEvent) => void>,
  options?: {
    target?: EventTarget;
    /** Milliseconds between sequence keys, such as "g t". Default 900. */
    sequenceTimeout?: number;
    /** Allow repeated single-key bindings. Default true. Sequences never repeat. */
    repeat?: boolean;
    enabled?: boolean | ((event: KeyboardEvent) => boolean);
  },
): () => void;
export function keyOf(event: KeyboardEvent): string;

/* Countdowns */
export interface CountdownState {
  state: "running" | "paused" | "complete";
  remainingMs: number;
  running: boolean;
}
export interface CountdownMount {
  /** Supply authoritative time. Zero or negative time completes the display. */
  set(value: { remainingMs: number; running: boolean }): void;
  /** Stop future updates. Later set() calls have no effect. */
  dispose(): void;
}
/** Explicit mount, independent of init(). Progress uses the largest remaining
 * time since mount or the last completion as its duration. Remount for a new task. */
export function mountCountdown(root: HTMLElement): CountdownMount;

/* Live feeds */
export interface FeedState {
  activeId: string | null;
  /** Rows entirely above the viewport. */
  aboveCount: number;
  returnPending: boolean;
}
export interface FeedNavigation {
  scroll?: boolean;
  /** Smooth movement takes 180ms, or is immediate under reduced motion. */
  behavior?: "auto" | "smooth";
}
export interface FeedMount {
  select(id: string, options?: FeedNavigation): void;
  /** Move in DOM order, clamped at either end. */
  move(delta: number, options?: FeedNavigation): void;
  /** Select the lowest or highest numeric data-order. */
  oldest(options?: FeedNavigation): void;
  newest(options?: FeedNavigation): void;
  /** Bracket a synchronous DOM change with beforeUpdate() and afterUpdate(). */
  beforeUpdate(): void;
  afterUpdate(): void;
  refresh(): void;
  suspend(value?: boolean): void;
  dispose(): void;
}
export function mountFeed(root: HTMLElement, options?: {
  itemSelector?: string;
  activeId?: string | null;
  /** A row ID or marker element. No idle return without a target. */
  returnTarget?: () => string | HTMLElement | null;
  /** Default blocks return while a descendant has aria-expanded="true". */
  canReturn?: () => boolean;
  idleMs?: number;
  returnDistance?: number;
  /** Target position as a fraction of viewport height. Default 0.45. */
  align?: number;
}): FeedMount;

/* Theme */
export const THEMES: readonly Theme[];
export function setTheme(name: ThemeName, options?: { persist?: boolean }): void;
export function getTheme(): Theme;
export function restoreTheme(fallback?: ThemeName): void;
/** Step to the next theme: ink → graphite → paper → auto. */
export function cycleTheme(): void;

/* Positioning */
export function place(
  floating: HTMLElement,
  anchor: Element,
  options?: { side?: "top" | "bottom" | "left" | "right"; align?: "start" | "center" | "end"; offset?: number },
): void;

/* App shell */
export function setSidebar(shell: HTMLElement, state: "pinned" | "collapsed"): void;
export function setAside(shell: HTMLElement, open: boolean): void;
export function setDrawer(shell: HTMLElement, open: boolean): void;
export function selectSection(shell: HTMLElement, name: string): void;
export function windowAction(action: "minimize" | "maximize" | "close", titlebar?: HTMLElement | null): Promise<void>;

/* Digital rain */
export interface RainMount {
  readonly canvas: HTMLCanvasElement;
  readonly playing: boolean;
  play(): void;
  pause(): void;
  update(options: Record<string, unknown>): void;
  destroy(): void;
}
export function mountRain(canvas: HTMLCanvasElement, options?: { playing?: boolean; style?: "glyphs" | "squares" }): RainMount;
export const rain: {
  play(): void;
  pause(): void;
  /** The user's switch, remembered across visits. */
  toggle(): void;
  /** Work started or finished; respects the user's explicit on or off. */
  busy(isBusy: boolean): void;
};

/* FPS */
export const fps: {
  readonly value: number;
  subscribe(listener: (value: number) => void): () => void;
};

/* Ornaments */
export const ORNAMENT_STYLES: Record<"blocks" | "dust", { cell: number; metric: string; falloff: number; merge: number; mix: number[] }>;
export function ornamentShapes(options?: {
  size?: number;
  width?: number;
  edge?: boolean;
  color?: string;
  seed?: number;
  strength?: number;
  style?: "blocks" | "dust";
}): string;
export function paintOrnaments(element: HTMLElement): void;

/* Scrollbars */
export function setScrollbars(mode?: "auto" | "always"): void;

/* Listboxes: palette and combobox */
export interface PaletteOption {
  label: string;
  hint?: string;
  group?: string;
  href?: string;
  keywords?: string;
  run?: (event: MouseEvent) => void;
}
export function setOptions(palette: HTMLDialogElement, options: PaletteOption[]): void;
export function filterList(list: HTMLElement, query: string): number;

/* Charts */
export function drawSpark(element: HTMLElement): void;

/* Events the library dispatches */
declare global {
  interface HTMLElementEventMap {
    "sd:countdown": CustomEvent<CountdownState>;
    "sd:feed": CustomEvent<FeedState>;
  }
  interface DocumentEventMap {
    "sd:countdown": CustomEvent<CountdownState>;

    "sd:feed": CustomEvent<FeedState>;
    "sd:theme": CustomEvent<{ theme: Theme }>;
    "sd:shell": CustomEvent<{ sidebar: "pinned" | "collapsed"; aside: "open" | "closed"; drawer: boolean; section?: string }>;
    "sd:window": CustomEvent<{ action: "minimize" | "maximize" | "close" }>;
    "sd:reaction": CustomEvent<{ on: boolean }>;
    "sd:contextmenu": CustomEvent<{ target: HTMLElement }>;
    "sd:tab": CustomEvent<{ tab: HTMLElement }>;
  }
}
