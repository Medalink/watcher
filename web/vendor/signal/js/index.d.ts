// Types for signal-design/js.

export type Theme = "ink" | "graphite" | "paper" | "auto";
/** "light" is the older name for "paper" and is still accepted. */
export type ThemeName = Theme | "light";
export type Font = "system" | "leon-sans" | "source-code-pro";
export type Tone = "accent" | "success" | "danger" | "warning" | "pending" | "extra" | "neutral";

/** Wire up every behavior (delegated, so later markup works too). Call once. */
export function init(options?: {
  /** Restore the remembered theme. Default true. */
  theme?: boolean;
  /** Restore the remembered text font. Default true. */
  font?: boolean;
  /** "auto" hides scrollbars 2s after scrolling stops. Default "auto". */
  scrollbars?: "auto" | "always";
  /** Key combo that steps the theme; false turns it off. Default "shift+t". */
  themeKey?: string | false;
}): void;

/* Dialogs */
export function openDialog(target: string | HTMLDialogElement): HTMLDialogElement | null;
export function closeDialog(target: string | HTMLDialogElement, returnValue?: string): HTMLDialogElement | null;

/* Labels: the words Signal's JS writes into the page. English by default. */
export type LabelKey =
  | "copy.done"
  | "copy.failed"
  | "list.empty"
  | "tags.remove"
  | "spark.trend"
  | "fps.value"
  | "table.resize"
  | "table.width"
  | "shell.pin"
  | "shell.collapse"
  | "window.maximize"
  | "window.restore"
  | "countdown.remaining"
  | "countdown.running"
  | "countdown.paused"
  | "countdown.complete"
  | `stream.${AlertKind}.${"label" | "detail"}`;
/** A string with `{name}` placeholders, or a function of the values (for plurals). */
export type LabelValue = string | ((vars: Record<string, string | number>) => string);
/** The English defaults. Read-only; `setLabels` does not change it. */
export const DEFAULT_LABELS: Readonly<Record<LabelKey, LabelValue>>;
/**
 * Replace some labels, once at startup. Unknown keys throw. A value of
 * `undefined` restores that key's English default. `data-sd-empty` and an
 * `aria-label` on the element still win over the table.
 * Placeholders: `tags.remove` {value}; `spark.trend` {values}; `fps.value`
 * {value}; `table.width` {value}; `countdown.remaining` {count} {state}.
 */
export function setLabels(labels: { [K in LabelKey]?: LabelValue | undefined }): void;
/** The label for `key` with placeholders filled from `vars`. */
export function getLabel(key: LabelKey, vars?: Record<string, string | number>): string;

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

/* Stream scenes */
export type AlertKind = "follow" | "sub" | "raid" | "bits";
export interface StreamAlert {
  /** follow, sub, raid and bits have default tones and labels; any other string needs `tone`. */
  kind: AlertKind | (string & {});
  name: string;
  detail?: string;
  label?: string;
  tone?: Tone;
  size?: "big";
  /** Added to a matching [data-sd-goal]. Default 1. */
  amount?: number;
  /** Milliseconds on screen. */
  hold?: number;
}
export const ALERT_KINDS: Record<AlertKind, { tone: Tone; label: string; detail: string; size?: "big" }>;
export interface StreamMount {
  /** Queue an alert; each shows in turn. Dispatches `sd:alert` on the scene. */
  alert(alert: StreamAlert): void;
  readonly pending: number;
  dispose(): void;
}
/** Alerts, latest-event labels, goals and timers for an `.sd-scene`. */
export function mountStream(scene: HTMLElement, options?: { hold?: number; burst?: boolean }): StreamMount;

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

/* Living tables */
export interface LivingTableState {
  width: number;
  collapsed: string[];
}
export interface LivingTableMount {
  toggle(id: string, open?: boolean): void;
  /** Width in CSS pixels. null restores fluid parent width. */
  resize(value: { width: number | null }): void;
  /** Reconcile rows, groups, and parent width after moving containers. Remount after changing the column schema. */
  refresh(): void;
  /** Restore authored markup. Later calls have no effect. */
  dispose(): void;
}
/** Explicit mount, independent of init(). Duplicate live mounts throw. */
export function mountLivingTable(root: HTMLElement): LivingTableMount;

/* Theme */
export const THEMES: readonly Theme[];
export function setTheme(name: ThemeName, options?: { persist?: boolean }): void;
export function getTheme(): Theme;
export function restoreTheme(fallback?: ThemeName): void;
/** Step to the next theme: ink → graphite → paper → auto. */
export function cycleTheme(): void;

/* Font */
export const FONTS: readonly Font[];
/** Resolves once the font applies (after its face loads, or a short wait). The last overlapping call wins. */
export function setFont(name: Font, options?: { persist?: boolean }): Promise<void>;
export function getFont(): Font;
export function restoreFont(fallback?: Font): void;

/* Positioning */
/**
 * What an element can be placed beside: an element, anything with `getBoundingClientRect`, a rect, or a `{ x, y }` point.
 * A rect needs `left` and `top`. A missing `right` or `bottom` is `left` or `top` plus `width` or `height`, or just `left` or `top` when there is none.
 */
export type PlaceAnchor =
  | { getBoundingClientRect(): { left: number; top: number; right: number; bottom: number } }
  | { left: number; top: number; right?: number | undefined; bottom?: number | undefined; width?: number | undefined; height?: number | undefined }
  | { x: number; y: number };
/**
 * Places a `position: fixed` element beside the anchor, flipped to the other side at the viewport edge.
 * A point has no size, so its default `offset` is 0 and the element's corner sits on it (6 otherwise).
 * Where the element flips above or left of the point or shifts at an edge it overlaps the point by a few pixels, so it always contains it.
 * Nothing happens when the element or the anchor is null.
 */
export function place(
  floating: HTMLElement | null,
  anchor: PlaceAnchor | null,
  options?: { side?: "top" | "bottom" | "left" | "right"; align?: "start" | "center" | "end"; offset?: number },
): void;

/* App shell */
export function setSidebar(shell: HTMLElement, state: "pinned" | "collapsed"): void;
/** Set the sidebar width in CSS px, clamped to the resize handle's aria-valuemin and aria-valuemax, and remember it; null returns to the width the page was authored with. `target` is the .sd-shell, or a .sd-sidebar used on its own; only a shell fires sd:shell. */
export function setSidebarWidth(target: HTMLElement, width: number | null): void;
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
export type OrnamentArtStyle = "contours" | "lattice" | "waveform" | "dashed" | "book" | "stack";
export const ORNAMENT_ART: Record<OrnamentArtStyle, { crisp: boolean; figure: boolean; gain: number }>;
export function ornamentArt(options?: {
  style?: OrnamentArtStyle;
  size?: number;
  width?: number;
  edge?: boolean;
  center?: boolean;
  right?: boolean;
  bottom?: boolean;
  color?: string;
  seed?: number;
  strength?: number;
}): string;
export function paintOrnaments(element: HTMLElement): void;

/* Scrollbars */
export function setScrollbars(mode?: "auto" | "always"): void;
/**
 * The auto-hiding scrollbars without `init()`: sets `data-sd-scrollbars` on
 * `<html>` and starts the scroll listener once. Safe to call again to change
 * the mode, and beside React, since it writes only that attribute and
 * `data-sd-scrolling` on whatever scrolls. Does nothing without a `document`, and
 * `signal-design/js` imports in Node, so a client entry that is also run on the server does not throw. Default "auto".
 */
export function initScrollbars(mode?: "auto" | "always"): void;

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
    "sd:living-table": CustomEvent<LivingTableState>;
    "sd:countdown": CustomEvent<CountdownState>;
    "sd:feed": CustomEvent<FeedState>;
  }
  interface DocumentEventMap {
    "sd:living-table": CustomEvent<LivingTableState>;
    "sd:countdown": CustomEvent<CountdownState>;

    "sd:feed": CustomEvent<FeedState>;
    "sd:theme": CustomEvent<{ theme: Theme }>;
    "sd:font": CustomEvent<{ font: Font }>;
    "sd:shell": CustomEvent<{ sidebar: "pinned" | "collapsed"; aside: "open" | "closed"; drawer: boolean; section?: string; width?: number }>;
    "sd:window": CustomEvent<{ action: "minimize" | "maximize" | "close" }>;
    "sd:reaction": CustomEvent<{ on: boolean }>;
    "sd:contextmenu": CustomEvent<{ target: HTMLElement }>;
    "sd:tab": CustomEvent<{ tab: HTMLElement }>;
  }
}
