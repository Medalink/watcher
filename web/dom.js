// DOM helpers and dialogs shared by the Manage, Logs and Resources pages.

import { $ } from './app.js';

// Runtime data only ever reaches the page as text nodes or properties; markup strings below are fixed literals.

/** el('button', {class: 'sd-btn', onclick}, 'Label') — props become properties where they exist, attributes otherwise. */
export function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    let value;
    for (const [key, prop] of Object.entries(props ?? {})) {
        if (prop == null || prop === false) {
            continue;
        }
        if (key === 'value') {
            value = prop;
        } else if (key === 'class') {
            node.className = prop;
        } else if (key === 'dataset') {
            Object.assign(node.dataset, prop);
        } else if (key.startsWith('on')) {
            node.addEventListener(key.slice(2), prop);
        } else if (key === 'for') {
            node.htmlFor = prop;
        } else if (!key.includes('-') && key in node && key !== 'list' && key !== 'form') {
            node[key] = prop;
        } else {
            node.setAttribute(key, prop === true ? '' : String(prop));
        }
    }
    append(node, children);
    if (value !== undefined) {
        node.value = value;
    }

    return node;
}

export function append(node, children) {
    for (const child of children.flat(Infinity)) {
        if (child != null && child !== false) {
            node.append(child instanceof Node ? child : String(child));
        }
    }

    return node;
}

/** A fixed, data-free icon. */
export function icon(markup) {
    const holder = document.createElement('span');
    holder.innerHTML = `<svg viewBox="0 0 24 24" class="icon" aria-hidden="true">${markup}</svg>`;

    return holder.firstElementChild;
}

export const icons = {
    manage: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
    logs: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
    close: '<path d="M18 6 6 18M6 6l12 12"/>',
    up: '<path d="m18 15-6-6-6 6"/>',
    folder: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    file: '<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><path d="M14 2v6h6"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
};

export const text = (value) => (value == null || value === '' ? '—' : String(value));
export const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
export const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
export const errorText = (error) => (error instanceof Error ? error.message : String(error)) || 'Unknown error.';

/** sd tone names for the legacy palette words used across the page. */
const TONES = { green: 'success', amber: 'pending', pink: 'danger', cyan: 'accent', violet: 'extra', orange: 'warning', neutral: 'neutral' };
export const toneOf = (tone) => TONES[tone] ?? tone;

/** A <p> that says what is happening: '' for plain, 'busy', 'ok' or 'error'. */
export function status(node, kind, message) {
    node.className = `mg-status${kind === 'busy' ? ' busy' : ''} sd-meta`;
    if (kind) {
        node.dataset.tone = { ok: 'success', error: 'danger', busy: 'pending', warning: 'pending' }[kind];
    } else {
        delete node.dataset.tone;
    }
    node.textContent = message ?? '';
    node.hidden = !message;
}

export const statusLine = () => el('p', { class: 'mg-status sd-meta', role: 'status', 'aria-live': 'polite', hidden: true });

/** Disables a button while work runs, so nothing is sent twice. */
export async function busyWhile(button, label, work) {
    const before = button.textContent;
    button.disabled = true;
    if (label) {
        button.textContent = label;
    }
    try {
        return await work();
    } finally {
        button.disabled = false;
        if (label) {
            button.textContent = before;
        }
    }
}

export function field(labelText, control, hint = '') {
    const id = control.id || `mg-f-${++fieldSeq}`;
    control.id = id;

    return el('div', { class: 'mg-field' },
        el('label', { for: id, class: 'label' }, labelText),
        control,
        hint ? el('span', { class: 'hint' }, hint) : null);
}
let fieldSeq = 0;

export const button = (label, onclick, kind = 'secondary', props = {}) =>
    el('button', {
        type: 'button',
        class: kind === 'primary' ? 'sd-btn sd-btn-primary sd-btn-sm' : 'sd-btn sd-btn-sm',
        ...(kind === 'danger' ? { dataset: { tone: 'danger' } } : {}),
        onclick,
        ...props,
    }, label);

export function badge(label, tone = '') {
    return el('span', { class: 'sd-badge', ...(tone ? { dataset: { tone: toneOf(tone) } } : {}) }, label);
}

/** A two-column fact list; values that are long wrap and stay selectable. */
export function facts(pairs) {
    return el('dl', { class: 'mg-facts' }, pairs.filter(Boolean).flatMap(([key, value]) => [
        el('dt', {}, key),
        el('dd', {}, value instanceof Node ? value : text(value)),
    ]));
}

/** A JSON block with a copy button. */
export function jsonBlock(value, label = 'JSON') {
    const pre = el('pre', { class: 'mg-json sd-code', tabIndex: 0, 'aria-label': label }, JSON.stringify(value, null, 2) ?? 'null');
    const note = el('span', { class: 'hint', role: 'status' });
    const copy = button('Copy', async () => {
        try {
            await navigator.clipboard.writeText(pre.textContent);
            note.textContent = 'Copied.';
        } catch (error) {
            note.textContent = `Could not copy: ${errorText(error)}`;
        }
    });

    return el('div', { class: 'mg-json-wrap' }, el('div', { class: 'mg-row-actions' }, copy, note), pre);
}

/** A plain table. columns: [{label, value(row) → string|Node, class?}]. */
export function table(rows, columns, { caption = '', rowProps } = {}) {
    return el('div', { class: 'mg-table-wrap' }, el('table', { class: 'sd-table mg-table' },
        caption ? el('caption', { class: 'sd-sr-only' }, caption) : null,
        el('thead', {}, el('tr', {}, columns.map((c) => el('th', { scope: 'col', class: c.class }, c.label)))),
        el('tbody', {}, rows.map((row) => el('tr', rowProps?.(row) ?? {},
            columns.map((c) => {
                const value = c.value(row);
                return el('td', { class: c.class }, value instanceof Node ? value : text(value));
            }))))));
}

/** Renders a JSON node whose shape the contract leaves open: arrays of objects and maps of objects become tables. */
export function shape(value, empty) {
    if (value == null || (Array.isArray(value) && value.length === 0) || (isObject(value) && Object.keys(value).length === 0)) {
        return el('p', { class: 'sd-empty' }, empty);
    }
    const cell = (v) => (v == null ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
    if (Array.isArray(value) && value.every(isObject)) {
        const keys = [...new Set(value.flatMap(Object.keys))];
        return table(value, keys.map((key) => ({ label: key, value: (row) => cell(row[key]) })));
    }
    if (isObject(value) && Object.values(value).every((v) => isObject(v) || Array.isArray(v) || v == null)) {
        const entries = Object.entries(value).flatMap(([key, v]) =>
            Array.isArray(v) ? (v.length ? v.map((item) => [key, isObject(item) ? item : { value: item }]) : [[key, {}]]) : [[key, v ?? {}]]);
        const keys = [...new Set(entries.flatMap(([, v]) => Object.keys(v)))];
        return table(entries, [{ label: 'Key', value: ([key]) => key }, ...keys.map((key) => ({ label: key, value: ([, v]) => cell(v[key]) }))]);
    }
    if (Array.isArray(value)) {
        return el('ul', { class: 'mg-list' }, value.map((v) => el('li', {}, cell(v))));
    }

    return jsonBlock(value);
}

// ---------- Dialogs ----------
// Our own overlay rather than showModal(): a top-layer dialog would make the shared #modal that containers.js raises for
// host errors inert, leaving it unreachable behind ours. The stack stays below #modal's z-index of 50.

const stack = [];
let dialogSeq = 0;

/**
 * Opens a keyboard-trapped dialog. body is a Node or array of Nodes. Returns a handle with close(), body and foot;
 * onClose runs once, however it closes.
 */
export function openDialog({ title, tone = 'cyan', wide = false, body = [], onClose = () => {} }) {
    const opener = document.activeElement;
    const titleId = `mg-dialog-title-${++dialogSeq}`;
    const content = el('div', { class: 'mg-dialog-body' });
    const foot = el('div', { class: 'mg-dialog-actions' });
    const heading = el('h3', { id: titleId }, el('span', {}, title));
    const close = el('button', { type: 'button', class: 'sd-btn sd-btn-ghost sd-btn-sm sd-btn-icon', title: 'Close', 'aria-label': 'Close dialog' }, icon(icons.close));
    const box = el('div', {
        class: `mg-dialog${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabIndex: -1,
        dataset: { tone: toneOf(tone) },
    }, el('div', { class: 'mg-dialog-head' }, heading, close), content, foot);
    const overlay = el('div', { class: 'mg-overlay' }, box);
    overlay.style.zIndex = String(Math.min(49, 40 + stack.length));
    append(content, [body]);

    const handle = {
        box, body: content, foot, open: true,
        setTitle: (value) => (heading.lastElementChild.textContent = value),
        close() {
            if (!handle.open) {
                return;
            }
            handle.open = false;
            overlay.remove();
            stack.splice(stack.indexOf(handle), 1);
            onClose();
            if (opener?.isConnected) {
                opener.focus();
            }
        },
    };
    close.addEventListener('click', () => handle.close());
    overlay.addEventListener('mousedown', (event) => event.target === overlay && handle.close());
    stack.push(handle);
    document.body.append(overlay);
    requestAnimationFrame(() => (focusables(box).find((node) => node !== close) ?? box).focus());

    return handle;
}

const focusables = (root) => [...root.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
    .filter((node) => !node.disabled && !node.hidden && node.getClientRects().length > 0);

document.addEventListener('keydown', (event) => {
    const top = stack.at(-1);
    const shared = $('modal');
    // The shared error dialog sits above ours and owns the keyboard while it is open.
    if (!top || (shared && shared.open)) {
        return;
    }
    if (event.key === 'Escape') {
        event.preventDefault();
        top.close();
        return;
    }
    if (event.key === 'Tab') {
        const nodes = focusables(top.box);
        if (nodes.length === 0) {
            event.preventDefault();
            top.box.focus();
            return;
        }
        const [first, last] = [nodes[0], nodes.at(-1)];
        if (!top.box.contains(document.activeElement)) {
            event.preventDefault();
            first.focus();
        } else if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    }
});

/** A list of exactly what an action touches. */
export function targetList(items) {
    return el('div', { class: 'mg-targets-wrap' },
        el('div', { class: 'label' }, `Affected (${items.length})`),
        el('ul', { class: 'mg-targets', 'aria-label': 'Affected targets' }, items.map((item) => el('li', { class: 'sd-num' }, item))));
}

/** Resolves true only when the named action button is pressed. */
export function confirmAction({ title, message, items = [], warning = '', action = 'Confirm', tone = 'pink' }) {
    return new Promise((resolve) => {
        let ok = false;
        const dialog = openDialog({
            title, tone,
            body: [
                el('p', {}, message),
                items.length ? targetList(items) : null,
                warning ? el('p', { class: 'sd-note', dataset: { tone: 'warning' } }, warning) : null,
            ],
            onClose: () => resolve(ok),
        });
        const confirm = el('button', {
            type: 'button',
            class: `sd-btn sd-btn-sm${tone === 'pink' ? '' : ' sd-btn-primary'}`,
            ...(tone === 'pink' ? { dataset: { tone: 'danger' } } : {}),
        }, action);
        confirm.addEventListener('click', () => {
            ok = true;
            dialog.close();
        });
        const cancel = button('Cancel', () => dialog.close());
        append(dialog.foot, [cancel, confirm]);
        // Destructive confirmations start on Cancel, so a stray Enter never removes or stops anything.
        requestAnimationFrame(() => (tone === 'pink' ? cancel : confirm).focus());
    });
}
