// Resources page: the memory, CPU and age limits Watcher enforces, and where every container stands against them.
// The host owns enforcement; this page edits the limits through request('manage') and previews them on live snapshots.

import { bytes, on, percent, registerPage, request } from './app.js';
import { badge, busyWhile, button, confirmAction, el, errorText, icon, status, statusLine, table } from './dom.js';

const GiB = 1024 ** 3;
const HOUR = 3_600_000;

/** The host's LimitRule table, in the same order, with how to read each value from a snapshot row. */
const rules = [
    {
        key: 'memoryGiB', rule: 'memory', label: 'Max memory', unit: 'GiB', max: 1024, step: 0.25, suggested: 4, sustained: true,
        read: (c) => (c.memoryBytes == null ? null : c.memoryBytes / GiB), show: (v) => bytes(v * GiB),
    },
    {
        key: 'cpuPercent', rule: 'CPU', label: 'Max CPU', unit: '% of WSL', max: 100, step: 1, suggested: 80, sustained: true,
        read: (c, cpus) => (c.cpu == null || !cpus ? null : (c.cpu / cpus) * 100), show: percent,
    },
    {
        key: 'ageHours', rule: 'age', label: 'Max age', unit: 'hours', max: 8760, step: 1, suggested: 72, sustained: false,
        read: (c, _, now) => (c.created ? (now - c.created) / HOUR : null), show: (v) => (v < 1 ? `${Math.round(v * 60)} min` : v < 48 ? `${+v.toFixed(1)} h` : `${+(v / 24).toFixed(1)} days`),
    },
];
const actions = [
    ['log', 'Log only'],
    ['stop', 'Stop the container'],
    ['remove', 'Remove the container'],
];
const defaultSamples = 15;

let containers = [];
let cpus = 0;
let interval = 2.3;
let lastSnapshot = 0;
let form = null;

on('snapshot', (message) => {
    containers = message.containers ?? [];
    cpus = message.capacity?.wsl?.cpus ?? 0;
    const now = Date.now();
    if (lastSnapshot) {
        interval = interval * 0.8 + ((now - lastSnapshot) / 1000) * 0.2;
    }
    lastSnapshot = now;
    if (form && !section.hidden) {
        form.refresh();
    }
});

// ---------- Page ----------

const link = el('a', { class: 'sd-rail-item', href: '#resources', dataset: { page: 'resources' }, title: 'Memory, CPU and age limits Watcher enforces' },
    icon('sliders'),
    el('span', {}, 'Resources'));
const activityLink = document.querySelector('.sd-rail-item[data-page="activity"]');
activityLink ? activityLink.after(link) : document.querySelector('.sd-rail-list')?.append(link);

const section = el('section', { class: 'page mg-page', dataset: { page: 'resources' }, hidden: true },
    el('div', { class: 'heading' }, el('div', {},
        el('h1', { class: 'sd-title' }, 'Resources'),
        el('p', { class: 'sd-subtle' }, 'Limits Watcher enforces on every container. Over a limit, Watcher logs it, stops the container or removes it.'))));
const holder = el('div', { class: 'mg-panel' }, el('p', { class: 'mg-status busy sd-meta', dataset: { tone: 'pending' } }, 'Reading limits…'));
const saveStatus = statusLine();
section.append(holder, saveStatus);
document.querySelector('.sd-shell-content')?.append(section);

registerPage('resources', { title: 'Resources', shown: () => form || load() });

async function load() {
    form = null;
    status(saveStatus, '', '');
    holder.replaceChildren(el('p', { class: 'mg-status busy sd-meta', dataset: { tone: 'pending' } }, 'Reading limits…'));
    try {
        render(await request('manage', { operation: 'limits' }));
    } catch (error) {
        holder.replaceChildren(el('p', { class: 'mg-status sd-meta', dataset: { tone: 'danger' } }, `Could not read limits: ${errorText(error)}`),
            button('Try again', () => load()));
    }
}

// ---------- Editors ----------

const seconds = (samples) => {
    const total = Math.round(samples * interval);
    return total < 120 ? `about ${total} s` : `about ${Math.round(total / 60)} min`;
};

/** One set of limits. read() returns the host's ResourceLimits shape, or null with the problem shown. */
function limitEditor(limits, label, onChange) {
    const rows = rules.map((rule) => {
        const set = limits?.[rule.key];
        const on = el('input', { type: 'checkbox', checked: Boolean(set) });
        const value = el('input', { type: 'number', class: 'mg-narrow', min: rule.step, max: rule.max, step: rule.step, value: String(set?.value ?? rule.suggested), 'aria-label': `${rule.label} in ${rule.unit}` });
        const action = el('select', { 'aria-label': `What to do over the ${rule.rule} limit` }, actions.map(([key, text]) => new Option(text, key)));
        action.value = set?.action ?? 'log';
        const sync = () => {
            value.disabled = action.disabled = !on.checked;
            onChange();
        };
        on.addEventListener('change', sync);
        value.addEventListener('input', onChange);
        action.addEventListener('change', onChange);
        value.disabled = action.disabled = !on.checked;

        return {
            rule, on, value, action,
            node: el('div', { class: 'rs-rule' },
                el('label', { class: 'mg-inline' }, on, rule.label),
                el('span', { class: 'mg-inline' }, value, el('span', { class: 'hint' }, rule.unit)),
                action),
        };
    });
    const samples = el('input', { type: 'number', class: 'mg-narrow', min: 1, max: 600, step: 1, value: String(limits?.samples ?? defaultSamples) });
    const duration = el('span', { class: 'hint' });
    const problem = el('p', { class: 'mg-status sd-meta', dataset: { tone: 'danger' }, role: 'alert', hidden: true });
    const showDuration = () => (duration.textContent = `samples in a row, ${seconds(Number(samples.value) || 0)} at the current refresh rate`);
    samples.addEventListener('input', () => {
        showDuration();
        onChange();
    });
    showDuration();

    return {
        node: el('fieldset', { class: 'mg-fieldset' }, el('legend', { class: 'label' }, label),
            rows.map((row) => row.node),
            el('div', { class: 'rs-samples' }, el('span', { class: 'hint' }, 'Memory and CPU must stay over for'), samples, duration),
            problem),
        refresh: showDuration,
        /** The limits as typed, valid or not, for the preview. */
        draft() {
            const next = { samples: Number(samples.value) };
            for (const row of rows) {
                next[row.rule.key] = row.on.checked ? { value: Number(row.value.value), action: row.action.value } : null;
            }
            return next;
        },
        read() {
            const next = this.draft();
            let message = '';
            for (const row of rows) {
                const limit = next[row.rule.key];
                if (limit && !(row.value.value.trim() !== '' && Number.isFinite(limit.value) && limit.value > 0 && limit.value <= row.rule.max)) {
                    message = `${row.rule.label} must be above 0 and at most ${row.rule.max} ${row.rule.unit}.`;
                }
            }
            if (!Number.isInteger(next.samples) || next.samples < 1 || next.samples > 600) {
                message ||= 'Samples must be a whole number from 1 to 600.';
            }
            status(problem, message ? 'error' : '', message);
            return message ? null : next;
        },
    };
}

/** Every limit a container is over right now under these limits; sustained ones still need their samples. */
function overNow(c, limits, now = Date.now()) {
    return rules.flatMap((rule) => {
        const limit = limits?.[rule.key];
        const value = rule.read(c, cpus, now);
        if (!limit || value == null || !(value >= limit.value) || (limit.action === 'stop' && c.state !== 'running')) {
            return [];
        }
        return [{ rule, value, limit }];
    });
}

// ---------- Form ----------

function render(saved) {
    const overrides = new Map();
    const overrideHolder = el('div', {});
    const pick = el('select', { class: 'mg-grow', 'aria-label': 'Container to give its own limits' });
    const standing = el('div', {});
    const general = limitEditor(saved.limits, 'Every container', () => preview());
    const limitsFor = (name) => overrides.get(name)?.draft() ?? general.draft();

    const fillPick = () => {
        const names = [...new Set(containers.map((c) => c.name))].filter((name) => !overrides.has(name)).sort();
        const signature = names.join('\u0000');
        if (pick.dataset.names === signature && pick.options.length) {
            return;
        }
        const chosen = pick.value;
        pick.dataset.names = signature;
        const title = (name) => containers.find((c) => c.name === name)?.title ?? name;
        pick.replaceChildren(new Option(names.length ? 'Choose a container' : 'Every listed container has its own limits', ''),
            ...names.map((name) => new Option(title(name) === name ? name : `${title(name)} (${name})`, name)));
        pick.value = names.includes(chosen) ? chosen : '';
    };
    const addOverride = (name, limits) => {
        const title = containers.find((c) => c.name === name)?.title ?? name;
        const editor = limitEditor(limits ?? general.draft(), `Only ${title}`, () => preview());
        const missing = el('span', { class: 'hint' }, 'Not in the current snapshot.');
        editor.refreshListed = () => (missing.hidden = containers.some((c) => c.name === name));
        editor.refreshListed();
        const box = el('div', { class: 'mg-override' }, editor.node, el('div', { class: 'mg-row-actions' }, missing,
            button('Use the defaults again', () => {
                overrides.delete(name);
                box.remove();
                fillPick();
                preview();
            }, 'secondary', { 'aria-label': `Remove the limits for ${name}` })));
        overrides.set(name, editor);
        overrideHolder.append(box);
        fillPick();
        preview();
    };

    function preview() {
        const now = Date.now();
        const rows = [...containers].sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
        const cell = (rule) => (c) => {
            const value = rule.read(c, cpus, now);
            const limit = limitsFor(c.name)[rule.key];
            const text = value == null ? '—' : rule.show(value);
            return limit ? el('span', { class: value != null && value >= limit.value ? 'mg-warn-text' : '' }, `${text} / ${rule.show(limit.value)}`) : text;
        };
        standing.replaceChildren(rows.length === 0
            ? el('p', { class: 'sd-empty' }, 'No containers yet.')
            : table(rows, [
                { label: 'Container', value: (c) => el('span', { title: c.name }, c.title) },
                { label: 'State', value: (c) => c.state },
                ...rules.map((rule) => ({ label: rule.label.replace('Max ', ''), value: cell(rule), class: 'sd-num' })),
                { label: 'Limits', value: (c) => (overrides.has(c.name) ? (rules.some((r) => limitsFor(c.name)[r.key]) ? 'Own' : 'Exempt') : 'Default') },
                {
                    label: 'Now',
                    value: (c) => {
                        const over = overNow(c, limitsFor(c.name), now);
                        if (over.length === 0) {
                            return badge('within', 'green');
                        }
                        const worst = over.some((o) => o.limit.action === 'remove') ? 'remove' : over.some((o) => o.limit.action === 'stop') ? 'stop' : 'log';
                        return badge(`over ${over.map((o) => o.rule.rule).join(', ')} → ${worst}`, worst === 'log' ? 'amber' : 'pink');
                    },
                },
            ], { caption: 'Where each container stands against these limits' }));
    }

    const save = button('Save limits', () => submit(), 'primary');
    async function submit() {
        const limits = general.read();
        const containerLimits = {};
        let invalid = !limits;
        for (const [name, editor] of overrides) {
            const next = editor.read();
            invalid ||= !next;
            containerLimits[name] = next;
        }
        if (invalid) {
            status(saveStatus, 'error', 'Fix the highlighted limits before saving.');
            return;
        }
        const now = Date.now();
        const hit = containers.flatMap((c) => overNow(c, containerLimits[c.name] ?? limits, now)
            .filter((o) => o.limit.action !== 'log')
            .map((o) => ({ c, o })));
        if (hit.length) {
            const removes = hit.some(({ o }) => o.limit.action === 'remove');
            const ok = await confirmAction({
                title: 'Save limits that act on containers now?',
                message: 'These containers are over a limit now. Age limits act on the next refresh; memory and CPU act once they stay over for the required samples.',
                items: hit.map(({ c, o }) => `${c.title}: ${o.rule.rule} ${o.rule.show(o.value)} ≥ ${o.rule.show(o.limit.value)} → ${o.limit.action}`),
                warning: removes ? 'Remove deletes the container and everything in it that is not on a volume. It cannot be undone.' : '',
                action: removes ? 'Save and remove' : 'Save and stop',
            });
            if (!ok) {
                return;
            }
        }
        status(saveStatus, 'busy', 'Saving…');
        try {
            const result = await busyWhile(save, 'Saving…', () => request('manage', { operation: 'save-limits', parameters: { limits, containerLimits } }));
            status(saveStatus, 'ok', result?.message ?? 'Saved.');
        } catch (error) {
            status(saveStatus, 'error', `Not saved: ${errorText(error)}`);
        }
    }

    Object.entries(saved.containerLimits ?? {}).forEach(([name, limits]) => addOverride(name, limits));
    fillPick();
    preview();

    form = {
        refresh() {
            general.refresh();
            overrides.forEach((editor) => {
                editor.refresh();
                editor.refreshListed();
            });
            if (document.activeElement?.tagName !== 'SELECT') {
                fillPick();
            }
            preview();
        },
    };
    holder.replaceChildren(
        el('section', { class: 'sd-card', dataset: { tone: 'pending' } },
            el('div', { class: 'sd-card-head' }, el('h2', {}, 'Limits')),
            el('div', { class: 'sd-card-body' },
                el('p', { class: 'hint' }, 'Every limit starts off. Stop keeps the container so you can start it again; wslc has no pause. '
                    + 'Remove deletes it the way Reap does. Age counts from creation, so with Stop a container over its age limit is stopped again each time it starts.'),
                general.node,
                el('div', { class: 'label mg-sub' }, 'Containers with their own limits'),
                el('p', { class: 'hint' }, 'Own limits replace the defaults for one container. Turn every limit off to exempt it.'),
                overrideHolder,
                el('div', { class: 'mg-row-actions' }, pick, button('Give it its own limits', () => pick.value && addOverride(pick.value))))),
        el('section', { class: 'sd-card' },
            el('div', { class: 'sd-card-head' }, el('h2', {}, 'Now')),
            el('div', { class: 'sd-card-body' },
                el('p', { class: 'hint' }, 'Live values against the limits as typed above, before you save. CPU is a share of WSL, like the Containers page.'),
                standing)),
        el('div', { class: 'mg-row-actions' }, save, button('Discard changes', () => load())));
}
