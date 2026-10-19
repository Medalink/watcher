// Shared by every page: the host bridge, window chrome, the router and formatters. Pages import from here
// and register themselves; this module never imports a page.

// Window control buttons speak the library's data-sd-window contract; the
// sd:window event is bridged to the host like any other action.
import { initWindow, onWindowClick } from './vendor/signal/js/window.js';
initWindow();
document.addEventListener('click', onWindowClick);
document.addEventListener('sd:window', ({ detail }) => post({ type: detail.action }));

const host = window.chrome.webview;
export const post = (message) => host.postMessage(message);
export const $ = (id) => document.getElementById(id);

// ---------- Bridge ----------

const handlers = new Map();
const pending = new Map();
let nextRequest = 1;

/** Subscribe to a pushed host message type ('snapshot', 'event', …). */
export function on(type, handler) {
    handlers.set(type, [...(handlers.get(type) ?? []), handler]);
}

/** Ask the host a question; resolves with its data or rejects with its error. */
export function request(query, params = {}) {
    const id = nextRequest++;
    post({ type: 'query', id, query, params });

    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

host.addEventListener('message', ({ data }) => {
    if (data.type === 'result') {
        const settle = pending.get(data.id);
        pending.delete(data.id);
        data.ok ? settle?.resolve(data.data) : settle?.reject(new Error(data.error));
        return;
    }
    if (data.type === 'window') {
        document.body.classList.toggle('maximized', data.maximized);
        $('maximize').title = data.maximized ? 'Restore' : 'Maximize';
        return;
    }
    handlers.get(data.type)?.forEach((handler) => handler(data));
});

// ---------- Window chrome ----------

document.addEventListener('mousedown', (event) => {
    if (event.button !== 0) {
        return;
    }
    const edge = event.target.closest('[data-edge]');
    if (edge) {
        event.preventDefault();
        post({ type: 'resize', edge: edge.dataset.edge });
        return;
    }
    if (event.target.closest('.drag') && !event.target.closest('.no-drag, button, a')) {
        event.preventDefault();
        post({ type: event.detail === 2 ? 'maximize' : 'drag' });
    }
});

// ---------- Router ----------

const pages = new Map();
let current = null;

/** A page is a <section data-page="name">; hooks run when it is shown or hidden. */
export function registerPage(name, { title, shown = () => {}, hidden = () => {} }) {
    pages.set(name, { title, shown, hidden });
}

function route() {
    const wanted = location.hash.slice(1);
    const name = pages.has(wanted) ? wanted : pages.has(localStorage.getItem('page')) ? localStorage.getItem('page') : 'containers';
    if (`#${name}` !== location.hash) {
        history.replaceState(null, '', `#${name}`);
    }
    if (name === current) {
        return;
    }
    if (current) {
        pages.get(current).hidden();
    }
    current = name;
    localStorage.setItem('page', name);
    document.querySelectorAll('section[data-page]').forEach((section) => (section.hidden = section.dataset.page !== name));
    document.querySelectorAll('.sd-rail-item[data-page]').forEach((item) => item.toggleAttribute('aria-current', item.dataset.page === name));
    $('crumb').textContent = pages.get(name).title;
    pages.get(name).shown();
}

window.addEventListener('hashchange', route);
// Module scripts all run before DOMContentLoaded, so every page has registered by then.
document.addEventListener('DOMContentLoaded', route);

// ---------- Formatting ----------

export function bytes(value) {
    if (!value) {
        return '0 B';
    }
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    const power = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
    const scaled = value / 1024 ** power;
    const digits = power === 0 || scaled >= 100 ? 0 : 1;

    return `${scaled.toFixed(digits)} ${units[power]}`;
}

export const percent = (value) => `${value.toFixed(value >= 10 ? 0 : 1)}%`;

// ---------- Capacity ----------
// The host sends {wsl, windows, wslMeasured}, each {cpus, memoryBytes}. CPU arrives as cores busy and memory as bytes;
// page percentages divide by wsl, which is Windows' size standing in until a probe measures WSL.

/** Cores or bytes as a percentage of a total: share(2, 32) is 6.25. */
export const share = (value, total) => (total ? (value / total) * 100 : 0);

/** What wsl percentages are of, so nothing claims a WSL size that was never measured. */
export const basis = (capacity) => (capacity.wslMeasured ? 'WSL' : 'Windows');
export const whose = (capacity) => (capacity.wslMeasured ? "WSL's" : "Windows'");

/** 32 processors · 45.9 GiB */
export const size = ({ cpus, memoryBytes }) => `${cpus} processors · ${bytes(memoryBytes)}`;

const pad = (value) => String(value).padStart(2, '0');

/** 14:03:12 in local time. */
export const clock = (at) => {
    const date = new Date(at);
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

/** 2026-10-16 in local time. */
export const day = (at) => {
    const date = new Date(at);
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

/** 3 min ago, 5 h ago, 2 days ago. */
export function ago(at, now = Date.now()) {
    const minutes = Math.floor((now - at) / 60_000);
    if (minutes < 1) {
        return 'just now';
    }
    if (minutes < 60) {
        return `${minutes} min ago`;
    }
    const hours = Math.floor(minutes / 60);

    return hours < 48 ? `${hours} h ago` : `${Math.floor(hours / 24)} days ago`;
}

/** Oct 16, 14:03 in local time. */
export const moment = (at) =>
    new Date(at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
