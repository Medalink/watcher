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
  options?: { target?: EventTarget },
): () => void;
export function keyOf(event: KeyboardEvent): string;

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
  interface DocumentEventMap {
    "sd:theme": CustomEvent<{ theme: Theme }>;
    "sd:shell": CustomEvent<{ sidebar: "pinned" | "collapsed"; aside: "open" | "closed"; drawer: boolean; section?: string }>;
    "sd:window": CustomEvent<{ action: "minimize" | "maximize" | "close" }>;
    "sd:reaction": CustomEvent<{ on: boolean }>;
    "sd:contextmenu": CustomEvent<{ target: HTMLElement }>;
    "sd:tab": CustomEvent<{ tab: HTMLElement }>;
  }
}
