/**
 * The Signal icon set: line icons with square caps and mitered corners, drawn
 * on the 24 grid inside the 4-unit inset that `.sd-icon` expects, so each one
 * spans the cap height of the text beside it. Straight lines and right angles
 * only, like the rest of the kit; a few use a diagonal. Each value is the `d`
 * of one path, stroked at 1.5 in `currentColor` and never filled.
 *
 *   import { icon } from "signal-design/js/icons";
 *   button.innerHTML = icon("undo");
 *
 * React apps use `<Icon name="undo" />` from `signal-design/react`.
 */
export const ICONS = {
  account: "M4 4h16v16H4zM9.5 7.5h5v5h-5zM7 20v-3.5h10V20",
  "align-center": "M4 6h16M7 10h10M4 14h16M7 18h10",
  "align-justify": "M4 6h16M4 10h16M4 14h16M4 18h16",
  "align-left": "M4 6h16M4 10h10M4 14h16M4 18h10",
  "align-right": "M4 6h16M10 10h10M4 14h16M10 18h10",
  bell: "M7 17v-6.5L9.5 6h5l2.5 4.5V17M4.5 17h15M10.5 17v2.5h3V17M12 4v2",
  bold: "M7 4.5h6.5v7H7zM7 11.5h8v8H7z",
  bookmark: "M7 4.5h10v15l-5-4-5 4z",
  chart: "M4.5 4.5v15h15M8 15v-4M12 15V8M16 15v-6",
  check: "M4.5 12.5l5 5 10-11",
  "chevron-down": "M6 9l6 6 6-6",
  "chevron-left": "M15 6l-6 6 6 6",
  "chevron-right": "M9 6l6 6-6 6",
  "chevron-up": "M6 15l6-6 6 6",
  "chevrons-left": "M11 6l-6 6 6 6M19 6l-6 6 6 6",
  "chevrons-right": "M5 6l6 6-6 6M13 6l6 6-6 6",
  close: "M6 6l12 12M18 6L6 18",
  comment: "M4 5h16v11h-8l-4 4v-4H4z",
  container: "M4.5 6.5h15v11h-15zM8.5 6.5v11M12 6.5v11M15.5 6.5v11",
  contract: "M19.5 10H14V4.5M14 10l5.5-5.5M4.5 14H10v5.5M10 14l-5.5 5.5",
  copy: "M8.5 8.5h11v11h-11zM15.5 8.5v-4h-11v11h4",
  database: "M5.5 5h13v4h-13zM5.5 10h13v4h-13zM5.5 15h13v4h-13z",
  delete: "M5 7h14M9 7V4.5h6V7M6.5 7l1 13h9l1-13M10 11v6M14 11v6",
  download: "M12 4.5V15M7.5 11l4.5 4.5 4.5-4.5M4.5 14v5.5h15V14",
  edit: "M16 4.5l3.5 3.5L8 19.5H4.5V16zM13.5 7l3.5 3.5",
  expand: "M14 4.5h5.5V10M19.5 4.5l-6 6M10 19.5H4.5V14M4.5 19.5l6-6",
  external: "M13 4.5h6.5V11M19.5 4.5L11 13M17.5 14.5v5h-13v-13h5",
  hash: "M9 4.5v15M15 4.5v15M4.5 9h15M4.5 15h15",
  history: "M4.5 4.5h15v15h-15zM12 8v4.5l3 2",
  italic: "M10 4.5h8M6 19.5h8M15 4.5L9 19.5",
  link: "M10.5 8H5v8h5.5M13.5 8H19v8h-5.5M8.5 12h7",
  "list-bullet": "M4.75 5.75h1v1h-1zM9 6.5h11M4.75 11.5h1v1h-1zM9 12h11M4.75 17.25h1v1h-1zM9 17.75h11",
  "list-number": "M4.5 5.25L6 4v3M4 10.5h3v1.5H4v1.5h3M4 17h3v3H4M5.5 18.5H7M10 5.5h10M10 12h10M10 18.5h10",
  lock: "M5.5 11h13v8.5h-13zM8.5 11V4.5h7V11M12 14.25v2.25",
  logs: "M6.5 4.5h8l3 3v12h-11zM14.5 4.5v3h3M9 11.5h6M9 15h6",
  maximize: "M5.5 5.5h13v13h-13z",
  menu: "M4 6h16M4 12h16M4 18h16",
  minimize: "M6 17.5h12",
  minus: "M5 12h14",
  more: "M5 11.5h1v1H5zM11.5 11.5h1v1h-1zM18 11.5h1v1h-1z",
  object: "M12 3.5l7.5 4.25v8.5L12 20.5l-7.5-4.25v-8.5zM4.5 7.75L12 12l7.5-4.25M12 12v8.5",
  pause: "M9 5v14M15 5v14",
  people: "M5 5.5h5v5H5zM14 5.5h5v5h-5zM4.5 19.5v-5h15v5",
  person: "M9 4.5h6v6H9zM5 20v-4h14v4",
  pin: "M8 4.5h8M9.5 4.5v6L6.5 14h11l-3-3.5v-6M12 14v5.5",
  place: "M5.5 4.5h13V11L12 20 5.5 11zM11.25 7.75h1.5v1.5h-1.5z",
  play: "M8 5v14l10-7z",
  plus: "M12 5v14M5 12h14",
  publish: "M12 15V4.5M7.5 9L12 4.5 16.5 9M4.5 14v5.5h15V14",
  rain: "M7 4.5v4M7 12v3.5M12 7v4M12 15v4.5M17 4.5v3M17 11v4",
  redo: "M15 5l4.5 4.5L15 14M19.5 9.5H9v8h6",
  reply: "M10 4.5L4.5 10l5.5 5.5M4.5 10h15v9.5",
  restore: "M5.5 9.5h9v9h-9zM9.5 9.5v-4h9v9h-4",
  search: "M4 4h11v11H4zM15 15l5.5 5.5",
  send: "M4.5 4.5L19.5 12 4.5 19.5 7 12zM7 12h7",
  settings: "M10.5 4.5h3v2.2l2.1-1.2 2.1 2.1-1.2 2.1h2.2v3h-2.2l1.2 2.1-2.1 2.1-2.1-1.2v2.2h-3v-2.2l-2.1 1.2-2.1-2.1 1.2-2.1H4.5v-3h2.2L5.5 7.6l2.1-2.1 2.1 1.2zM10.5 10.5h3v3h-3z",
  sliders: "M4.5 8h4M12.5 8h7M8.5 5.5h4v5h-4zM4.5 16h8M16.5 16h3M12.5 13.5h4v5h-4z",
  smile: "M4.5 4.5h15v15h-15zM9 9v2M15 9v2M8 14l2 2.5h4l2-2.5",
  sparkle: "M12 3.5L14 10l6.5 2-6.5 2-2 6.5-2-6.5-6.5-2L10 10z",
  strike: "M16.5 7H9v5M15 12v5.5H7.5M4 12h16",
  sync: "M4.5 8h14M14.5 4l4 4-4 4M19.5 16h-14M9.5 12l-4 4 4 4",
  theme: "M4.5 4.5h15v15h-15zM4.5 19.5l15-15M16 13v3.5h-3.5",
  underline: "M7 4.5v8.5h10V4.5M5 19.5h14",
  undo: "M9 5L4.5 9.5 9 14M4.5 9.5H15v8H9",
  unlink: "M10 8H5v8h5M14 8h5v8h-5M4.5 4.5l15 15",
  view: "M3.5 12L8 6.5h8l4.5 5.5L16 17.5H8zM10.75 10.75h2.5v2.5h-2.5z",
  warning: "M12 4l8.5 16h-17zM12 10v4.5M12 17.5v.01",
  write: "M11 5H5v14h14v-6M17 4l3 3-8 8H9v-3z",
};

export const ICON_NAMES = Object.keys(ICONS);

/**
 * The markup of one icon, ready for `innerHTML`. Without `label` it is
 * decorative (`aria-hidden`); with one it is an image with that name.
 *
 * @param {keyof typeof ICONS} name
 * @param {string} [label]
 */
export function icon(name, label) {
  const d = ICONS[name];
  if (d === undefined) throw new RangeError(`Unknown icon "${name}"`);
  const a11y = label === undefined ? 'aria-hidden="true"' : `role="img" aria-label="${label.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`;
  return `<svg class="sd-icon" data-icon="${name}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" stroke-linejoin="miter" ${a11y}><path d="${d}"/></svg>`;
}
