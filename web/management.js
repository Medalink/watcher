// Manage and Logs pages: control and inspect existing WSLc workloads through request('manage'). Nothing here creates
// containers, images, networks or volumes; every change is a confirmed action on an explicit, listed target.

import { $, ago, bytes, clock, day, on, registerPage, request } from './app.js';
import {
    confirmAction, openDialog, targetList, el, append, icon, text, plural, isObject, errorText, toneOf, status, statusLine, busyWhile, field, button, badge, facts, jsonBlock, table, shape,
} from './dom.js';

// ---------- Host bridge ----------

let operationSeq = 0;
const operationId = () => `mg-${Date.now().toString(36)}-${++operationSeq}`;

/** One management call; pass an id from operationId() when the caller offers Cancel. */
const manage = (operation, parameters = {}, id = operationId()) => request('manage', { operation, parameters, operationId: id });

const cancelOperation = (id) => manage('cancel-operation', { id }).catch(() => {});

/** A Cancel button bound to a running operation id; it reports nothing itself, the operation's own error does. */
function cancelButton(id) {
    const cancel = button('Cancel', () => {
        cancel.disabled = true;
        cancel.textContent = 'Cancelling…';
        cancelOperation(id);
    }, 'secondary', { 'aria-label': 'Cancel the running operation' });

    return cancel;
}

// ---------- Snapshot ----------

let containers = [];
let snapshotSeen = false;
const snapshotListeners = new Set();

on('snapshot', (message) => {
    containers = message.containers ?? [];
    snapshotSeen = true;
    snapshotListeners.forEach((listener) => listener());
});

const running = (c) => c.state === 'running';
const containerByName = (name) => containers.find((c) => c.name === name);
const titleOf = (name) => containerByName(name)?.title ?? name;

/** The same sections as the Containers page: the group label, else the folder's parent folder name, else Other. */
function sectionOf(c) {
    if (c.group) {
        return c.group;
    }
    const parts = (c.path ?? '').split(/[\\/]+/).filter(Boolean);

    return parts.length >= 2 ? parts.at(-2) : 'Other';
}

const bySectionName = (a, b) => (a === 'Other') - (b === 'Other') || a.localeCompare(b, undefined, { sensitivity: 'base' });

/** First published port number in a snapshot port string such as "8080" or "0.0.0.0:8080->80/tcp". */
function hostPort(c) {
    const match = /(?:^|:)(\d{1,5})(?:->|$|\/|,|\s)/.exec(c?.port ?? '') ?? /(\d{1,5})/.exec(c?.port ?? '');
    const port = match ? Number(match[1]) : 0;

    return port >= 1 && port <= 65535 ? port : 8080;
}

/** Per-target outcomes of a multi-target action. results: [{name, ok, detail, ms?}]. */
function outcomeTable(results) {
    const failed = results.filter((r) => !r.ok).length;

    return el('div', { class: 'mg-outcome' },
        el('p', { class: 'mg-status sd-meta', dataset: { tone: failed ? 'danger' : 'success' } },
            failed ? `${failed} of ${results.length} failed.` : `All ${plural(results.length, 'target')} succeeded.`),
        table(results, [
            { label: 'Target', value: (r) => r.name, class: 'sd-num' },
            { label: 'Result', value: (r) => badge(r.ok ? 'ok' : 'failed', r.ok ? 'green' : 'pink') },
            { label: 'Time', value: (r) => (r.ms == null ? '—' : `${(r.ms / 1000).toFixed(1)} s`), class: 'sd-num' },
            { label: 'Output', value: (r) => el('span', { class: 'mg-output sd-code' }, r.detail || '—') },
        ], { caption: 'Per-target results' }));
}

// ---------- Pages ----------

function railItem(page, label, title, glyph) {
    const link = el('a', { class: 'sd-rail-item', href: `#${page}`, dataset: { page }, title }, icon(glyph), el('span', {}, label));

    return link;
}

const rail = document.querySelector('.sd-rail-list');
rail?.append(
    railItem('manage', 'Manage', 'Inspect and control existing workloads, images, volumes and networks', 'settings'),
    railItem('logs', 'Logs', 'Combined, searchable container logs', 'logs'));

function page(name, heading, intro, side = null) {
    const section = el('section', { class: 'page mg-page', dataset: { page: name }, hidden: true },
        el('div', { class: 'heading' }, el('div', {}, el('h1', { class: 'sd-title' }, heading), el('p', { class: 'sd-subtle' }, intro)), side));
    document.querySelector('.sd-shell-content')?.append(section);

    return section;
}

const visible = (section) => section.isConnected && !section.hidden && !document.hidden;

// ---------- Manage page and its tabs ----------

const tabBar = el('div', { class: 'sd-tabs mg-tabs', role: 'tablist', 'aria-label': 'Management sections' });
const managePage = page('manage', 'Manage',
    'Inspect workloads, control project groups, and troubleshoot networking and storage.');
managePage.append(tabBar);
const tabs = new Map();
let currentTab = localStorage.getItem('manage-tab') ?? 'containers';

/** A tab owns a panel; shown runs each time it becomes visible, never on load. */
function addTab(key, label, { shown = () => {}, hidden = () => {} } = {}) {
    const panel = el('div', { class: 'mg-panel', role: 'tabpanel', id: `mg-panel-${key}`, 'aria-labelledby': `mg-tab-${key}`, hidden: true });
    const tab = el('button', {
        type: 'button', role: 'tab', id: `mg-tab-${key}`, 'aria-controls': panel.id, 'aria-selected': 'false', tabIndex: -1,
        onclick: () => selectTab(key),
    }, label);
    tabBar.append(tab);
    managePage.append(panel);
    tabs.set(key, { tab, panel, shown, hidden });

    return panel;
}

function selectTab(key, focus = false) {
    if (!tabs.has(key)) {
        key = 'containers';
    }
    const before = currentTab;
    currentTab = key;
    localStorage.setItem('manage-tab', key);
    for (const [name, entry] of tabs) {
        const on = name === key;
        entry.tab.setAttribute('aria-selected', String(on));
        entry.tab.tabIndex = on ? 0 : -1;
        entry.panel.hidden = !on;
    }
    if (focus) {
        tabs.get(key).tab.focus();
    }
    if (!managePage.hidden) {
        if (before !== key) {
            tabs.get(before)?.hidden();
        }
        tabs.get(key).shown();
    }
}

tabBar.addEventListener('keydown', (event) => {
    const keys = [...tabs.keys()];
    const index = keys.indexOf(currentTab);
    const next = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: keys.length - 1 }[event.key];
    if (next !== undefined) {
        event.preventDefault();
        selectTab(keys[(next + keys.length) % keys.length], true);
    }
});

// ---------- Containers: bulk lifecycle and per-container tools ----------

const selected = new Set();
const groupElements = new Map();
const rowElements = new Map();
let bulkRun = null;

const containersPanel = addTab('containers', 'Containers', { shown: () => renderContainers() });
const containerSearch = el('input', { type: 'search', class: 'mg-search', placeholder: 'Filter by name, image or group', spellcheck: false, 'aria-label': 'Filter containers' });
const stopTimeout = el('input', { type: 'number', class: 'mg-narrow', min: 1, max: 120, step: 1, value: '10', 'aria-label': 'Stop timeout in seconds' });
const selectionCount = el('span', { class: 'hint', role: 'status', 'aria-live': 'polite' });
const bulkStatus = statusLine();
const bulkProgress = el('div', { class: 'sd-card mg-progress', dataset: { tone: 'pending' }, hidden: true });
const bulkResults = el('div', { class: 'mg-results' });
const containerList = el('div', { class: 'mg-groups', role: 'group', 'aria-label': 'Containers' });
const containerEmpty = el('p', { class: 'sd-empty', hidden: true });
const bulkButtons = {
    start: button('Start selected', () => bulk('start'), 'secondary', { 'aria-label': 'Start the selected containers' }),
    stop: button('Stop selected', () => bulk('stop'), 'secondary', { 'aria-label': 'Stop the selected containers' }),
    restart: button('Restart selected', () => bulk('restart'), 'secondary', { 'aria-label': 'Restart the selected containers' }),
};

containerSearch.addEventListener('input', () => renderContainers());

append(containersPanel, [
    el('div', { class: 'toolbar mg-toolbar' },
        containerSearch,
        button('Select running', () => selectWhere(running)),
        button('Select stopped', () => selectWhere((c) => !running(c))),
        button('Clear', () => selectWhere(() => false)),
        el('span', { class: 'spacer' }),
        selectionCount),
    el('div', { class: 'toolbar mg-toolbar' },
        bulkButtons.start, bulkButtons.stop, bulkButtons.restart,
        el('label', { class: 'mg-inline' }, el('span', { class: 'label' }, 'Stop timeout'), stopTimeout, el('span', { class: 'hint' }, 'seconds, 1–120'))),
    el('p', { class: 'hint mg-lead' },
        'Tick containers or a whole group, then act on them together. Each action lists its exact targets before anything is sent, and reports every container separately.'),
    bulkStatus,
    bulkProgress,
    bulkResults,
    containerList,
    containerEmpty,
]);

function visibleContainers() {
    const query = containerSearch.value.trim().toLowerCase();

    return containers.filter((c) => !query
        || `${c.title} ${c.name} ${c.image ?? ''} ${sectionOf(c)} ${c.state}`.toLowerCase().includes(query));
}

/** Selection follows the filter: only what is listed is ticked or cleared. */
function selectWhere(test) {
    for (const c of visibleContainers()) {
        test(c) ? selected.add(c.name) : selected.delete(c.name);
    }
    renderContainers();
}

function groupElement(name) {
    if (!groupElements.has(name)) {
        const box = el('input', { type: 'checkbox', class: 'mg-check' });
        const element = el('section', { class: 'mg-group' },
            el('div', { class: 'mg-group-head' }, el('label', { class: 'mg-inline' }, box,
                el('h2', {}, name, el('span', { class: 'count sd-count' })))),
            el('div', { class: 'mg-crows' }));
        box.setAttribute('aria-label', `Select every listed container in ${name}`);
        box.addEventListener('change', () => {
            const members = visibleContainers().filter((c) => sectionOf(c) === name);
            members.forEach((c) => (box.checked ? selected.add(c.name) : selected.delete(c.name)));
            renderContainers();
        });
        groupElements.set(name, element);
    }

    return groupElements.get(name);
}

function rowElement(name) {
    if (!rowElements.has(name)) {
        const box = el('input', { type: 'checkbox', class: 'mg-check' });
        box.addEventListener('change', () => {
            box.checked ? selected.add(name) : selected.delete(name);
            renderContainers();
        });
        const terminal = button('Terminal…', () => openTerminal(name));
        const row = el('div', { class: 'mg-crow', dataset: { name } },
            box,
            el('div', { class: 'mg-cname' }, el('span', { class: 'name' }), el('span', { class: 'sub sd-num' })),
            el('span', { class: 'mg-cstate' }),
            el('span', { class: 'mg-cport sd-num' }),
            el('div', { class: 'mg-row-actions' },
                button('Inspect', () => openInspect(name)),
                button('Logs', () => openLogsFor(name)),
                button('Files', () => openFiles(name)),
                terminal,
                button('Diagnose…', () => openDiagnose(name))));
        row.terminal = terminal;
        row.box = box;
        rowElements.set(name, row);
    }

    return rowElements.get(name);
}

const stateTone = (c) => (c.orphan ? 'amber' : running(c) ? 'green' : c.state === 'exited' ? 'neutral' : 'amber');

function setText(node, value) {
    if (node.textContent !== value) {
        node.textContent = value;
    }
}

/** Keyed: rows survive snapshots so ticks, focus and hover are never lost. */
function renderContainers() {
    if (managePage.hidden || currentTab !== 'containers') {
        return;
    }
    const names = new Set(containers.map((c) => c.name));
    [...selected].filter((name) => !names.has(name)).forEach((name) => selected.delete(name));
    for (const name of [...rowElements.keys()].filter((key) => !names.has(key))) {
        rowElements.get(name).remove();
        rowElements.delete(name);
    }

    const list = visibleContainers();
    const sections = new Map();
    for (const c of [...list].sort((a, b) => a.title.localeCompare(b.title))) {
        const name = sectionOf(c);
        sections.set(name, [...(sections.get(name) ?? []), c]);
    }
    const order = [...sections.keys()].sort(bySectionName);
    order.forEach((name, index) => {
        const group = groupElement(name);
        if (containerList.children[index] !== group) {
            containerList.insertBefore(group, containerList.children[index] ?? null);
        }
        const members = sections.get(name);
        const ticked = members.filter((c) => selected.has(c.name)).length;
        const box = group.querySelector('.mg-group-head input');
        box.checked = ticked === members.length;
        box.indeterminate = ticked > 0 && ticked < members.length;
        setText(group.querySelector('.count'), String(members.length));
        const holder = group.querySelector('.mg-crows');
        members.forEach((c, at) => {
            const row = rowElement(c.name);
            row.box.checked = selected.has(c.name);
            row.box.setAttribute('aria-label', `Select ${c.title}`);
            row.classList.toggle('selected', selected.has(c.name));
            setText(row.querySelector('.name'), c.title);
            row.querySelector('.name').title = c.name;
            setText(row.querySelector('.sub'), c.title === c.name ? (c.image ?? '') : `${c.name} · ${c.image ?? ''}`);
            const state = row.querySelector('.mg-cstate');
            const label = c.orphan ? 'folder deleted' : c.state;
            const tone = toneOf(stateTone(c));
            if (state.textContent !== label || state.dataset.tone !== tone) {
                state.dataset.tone = tone;
                state.replaceChildren(badge(label, stateTone(c)));
            }
            setText(row.querySelector('.mg-cport'), c.port || '—');
            row.terminal.disabled = !running(c);
            row.terminal.title = running(c) ? 'Open an interactive shell in Windows Terminal' : 'Start the container to open a shell';
            if (holder.children[at] !== row) {
                holder.insertBefore(row, holder.children[at] ?? null);
            }
        });
        while (holder.children.length > members.length) {
            holder.lastElementChild.remove();
        }
    });
    for (const [name, group] of groupElements) {
        if (!sections.has(name)) {
            group.remove();
            groupElements.delete(name);
        }
    }

    const count = selected.size;
    setText(selectionCount, count ? `${count} selected` : 'None selected');
    Object.values(bulkButtons).forEach((b) => (b.disabled = count === 0 || bulkRun !== null));
    containerEmpty.hidden = list.length > 0;
    containerEmpty.textContent = !snapshotSeen
        ? 'Waiting for the first snapshot from the monitor…'
        : containers.length === 0 ? 'No containers in this session.' : 'No container matches this filter.';
}

snapshotListeners.add(renderContainers);

const verbs = { start: ['Start', 'Starting'], stop: ['Stop', 'Stopping'], restart: ['Restart', 'Restarting'] };

async function bulk(op) {
    const names = [...selected].filter(containerByName);
    const timeout = Number(stopTimeout.value);
    if (names.length === 0) {
        status(bulkStatus, 'error', 'Select at least one container.');
        return;
    }
    if (names.length > 100) {
        status(bulkStatus, 'error', `Select at most 100 containers; ${names.length} are selected.`);
        return;
    }
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 120) {
        status(bulkStatus, 'error', 'Stop timeout must be a whole number of seconds from 1 to 120.');
        stopTimeout.focus();
        return;
    }
    const [verb, doing] = verbs[op];
    const ok = await confirmAction({
        title: `${verb} ${plural(names.length, 'container')}?`,
        message: op === 'start'
            ? 'These containers are started one at a time. Containers already running report their own result.'
            : `These containers are ${op === 'stop' ? 'stopped' : 'restarted'} one at a time. Each gets ${timeout} s to exit before it is killed.`,
        items: names.map((name) => `${titleOf(name)} · ${name} · ${containerByName(name)?.state ?? 'unknown'}`),
        warning: op === 'start' ? '' : 'Processes inside are ended. Clients connected to these containers lose their connections.',
        action: verb,
        tone: op === 'start' ? 'amber' : 'pink',
    });
    if (!ok) {
        return;
    }
    const id = operationId();
    bulkRun = { id, names, live: [] };
    status(bulkStatus, '', '');
    bulkResults.replaceChildren();
    const progressText = el('p', { class: 'mg-status busy sd-meta', dataset: { tone: 'pending' }, role: 'status', 'aria-live': 'polite' }, `${doing} ${plural(names.length, 'container')}…`);
    const progressRows = el('div', {});
    bulkProgress.replaceChildren(el('div', { class: 'mg-row-actions' }, progressText, cancelButton(id)), progressRows);
    bulkProgress.hidden = false;
    bulkRun.render = () => {
        progressText.textContent = `${doing}: ${bulkRun.live.length} of ${names.length} done…`;
        progressRows.replaceChildren(outcomeTable(bulkRun.live));
    };
    renderContainers();
    try {
        const result = await manage('bulk', { names, op, timeout }, id);
        const rows = (result?.results ?? []).map((r) => ({ name: r.name, ok: r.ok, detail: r.output, ms: r.ms }));
        bulkResults.replaceChildren(el('div', { class: 'sd-card' },
            el('div', { class: 'sd-card-head' }, el('h2', {}, `${verb} results`),
                el('span', { class: 'hint' }, clock(Date.now()))),
            el('div', { class: 'sd-card-body' },
                outcomeTable(rows),
                names.length > rows.length ? el('p', { class: 'mg-status sd-meta', dataset: { tone: 'danger' } }, `${names.length - rows.length} of ${names.length} were not attempted.`) : null)));
    } catch (error) {
        const done = bulkRun.live;
        const skipped = names.filter((name) => !done.some((r) => r.name === name));
        bulkResults.replaceChildren(el('div', { class: 'sd-card', dataset: { tone: 'danger' } },
            el('p', { class: 'mg-status sd-meta', dataset: { tone: 'danger' } }, `${verb} stopped early: ${errorText(error)}`),
            done.length ? outcomeTable(done) : null,
            skipped.length ? el('div', {}, el('p', { class: 'hint' }, 'Not attempted:'), targetList(skipped)) : null));
    } finally {
        bulkRun = null;
        bulkProgress.hidden = true;
        renderContainers();
    }
}

on('bulk-result', ({ result }) => {
    if (bulkRun && result && bulkRun.names.includes(result.name)) {
        bulkRun.live.push({ name: result.name, ok: result.ok, detail: result.output, ms: result.ms });
        bulkRun.render();
    }
});

// ---------- Inspect ----------

/** 2026-10-16 14:03:12 (5 min ago) from an ISO string; Go's zero time and blanks read as a dash. */
function when(iso) {
    const at = Date.parse(iso ?? '');
    if (!iso || Number.isNaN(at) || String(iso).startsWith('0001-')) {
        return '—';
    }

    return `${day(at)} ${clock(at)} (${ago(at)})`;
}

const quote = (arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : JSON.stringify(arg));

function command(value) {
    if (value == null || (Array.isArray(value) && value.length === 0)) {
        return '—';
    }

    return Array.isArray(value) ? value.map((arg) => quote(String(arg))).join(' ') : String(value);
}

const healthTone = (status) => ({ healthy: 'green', unhealthy: 'pink', starting: 'amber' }[String(status).toLowerCase()] ?? 'neutral');
const healthStatus = (health) => (health == null ? null : typeof health === 'string' ? health : health.Status ?? health.status ?? null);

function stateBadge(state) {
    const label = typeof state === 'string' ? state : state?.Status ?? (state?.Running ? 'running' : 'unknown');

    return badge(label, label === 'running' ? 'green' : label === 'exited' || label === 'dead' ? 'neutral' : 'amber');
}

/** Network names a container belongs to, whatever shape inspect used. */
function memberships(networks) {
    if (Array.isArray(networks)) {
        return networks.map((n) => (isObject(n) ? n.Name ?? n.Network ?? n.name ?? '' : String(n))).filter(Boolean);
    }

    return isObject(networks) ? Object.keys(networks) : [];
}

/** Small tablist inside a dialog; each pane builds once, when first opened. */
function innerTabs(label, panes) {
    const bar = el('div', { class: 'sd-tabs mg-inner-tabs', role: 'tablist', 'aria-label': label });
    const holder = el('div', { class: 'mg-inner-panes' });
    const built = new Map();
    const select = (index, focus = false) => {
        panes.forEach((_, at) => {
            const tab = bar.children[at];
            tab.setAttribute('aria-selected', String(at === index));
            tab.tabIndex = at === index ? 0 : -1;
        });
        if (!built.has(index)) {
            const panel = el('div', { role: 'tabpanel', class: 'mg-inner-pane', 'aria-label': panes[index].label }, panes[index].build());
            built.set(index, panel);
            holder.append(panel);
        }
        built.forEach((panel, at) => (panel.hidden = at !== index));
        if (focus) {
            bar.children[index].focus();
        }
    };
    panes.forEach((pane, index) => bar.append(el('button', { type: 'button', role: 'tab', onclick: () => select(index) }, pane.label)));
    bar.addEventListener('keydown', (event) => {
        const index = [...bar.children].findIndex((tab) => tab.getAttribute('aria-selected') === 'true');
        const next = { ArrowRight: index + 1, ArrowLeft: index - 1 }[event.key];
        if (next !== undefined) {
            event.preventDefault();
            select((next + panes.length) % panes.length, true);
        }
    });
    select(0);

    return el('div', { class: 'mg-inner' }, bar, holder);
}

function overviewPane(data) {
    const raw = data.raw ?? {};
    const state = raw.State ?? {};
    const health = healthStatus(data.health);

    return facts([
        ['Name', el('span', { class: 'sd-num' }, text(data.name ?? raw.Name))],
        ['State', el('span', { class: 'mg-inline' }, stateBadge(data.state ?? state), health ? badge(`health: ${health}`, healthTone(health)) : null)],
        ['Exit code', data.exitCode ?? state.ExitCode],
        ['Started', when(state.StartedAt)],
        ['Finished', when(state.FinishedAt)],
        ['Created', when(raw.Created)],
        ['Image', el('span', { class: 'sd-num' }, text(data.image ?? raw.Config?.Image ?? raw.Image))],
        ['Entrypoint', el('code', { class: 'mg-code sd-code' }, command(raw.Config?.Entrypoint))],
        ['Command', el('code', { class: 'mg-code sd-code' }, command(data.command ?? raw.Config?.Cmd))],
        ['User', data.user || raw.Config?.User || 'image default'],
        ['Working dir', el('span', { class: 'sd-num' }, data.workingDir || raw.Config?.WorkingDir || 'image default')],
        ['Network mode', raw.HostConfig?.NetworkMode],
        ['Stop timeout', raw.Config?.StopTimeout == null ? null : `${raw.Config.StopTimeout} s`],
        ['ID', el('span', { class: 'sd-num' }, text(raw.Id))],
    ]);
}

function healthPane(data, capabilities) {
    const health = data.health;
    const status = healthStatus(health);
    const check = data.raw?.Config?.Healthcheck;
    const log = isObject(health) ? health.Log ?? health.log ?? [] : [];
    const parts = [];
    if (capabilities && capabilities.health === false) {
        parts.push(el('p', { class: 'sd-note', dataset: { tone: 'warning' } }, 'The installed wslc does not report native health. Use Diagnose for a Windows-side reachability check.'));
    }
    if (!status && !check) {
        parts.push(el('p', { class: 'sd-empty' }, 'No health check is defined for this container, so wslc has no health status to report.'));
    } else {
        parts.push(facts([
            ['Status', status ? badge(status, healthTone(status)) : 'not reported'],
            ['Failing streak', isObject(health) ? health.FailingStreak : null],
            ['Test', check?.Test ? el('code', { class: 'mg-code sd-code' }, command(check.Test)) : null],
            ['Interval', check?.Interval ? `${check.Interval / 1e9} s` : null],
            ['Timeout', check?.Timeout ? `${check.Timeout / 1e9} s` : null],
            ['Retries', check?.Retries],
        ]));
        if (log.length) {
            parts.push(el('div', { class: 'label mg-sub' }, 'Recent probes'), table(log.slice(-10).reverse(), [
                { label: 'Ended', value: (entry) => when(entry.End) },
                { label: 'Exit', value: (entry) => badge(String(entry.ExitCode ?? '?'), entry.ExitCode === 0 ? 'green' : 'pink') },
                { label: 'Output', value: (entry) => el('span', { class: 'mg-output sd-code' }, (entry.Output ?? '').trim() || '—') },
            ], { caption: 'Recent health probes' }));
        }
    }
    parts.push(el('p', { class: 'hint' }, 'Native health comes from the container\'s own check inside WSLc. Diagnose tests reachability from Windows separately.'));

    return parts;
}

function environmentPane(data) {
    const entries = (data.environment ?? []).map((line) => {
        const at = String(line).indexOf('=');
        return at < 0 ? [String(line), ''] : [line.slice(0, at), line.slice(at + 1)];
    });
    if (entries.length === 0) {
        return el('p', { class: 'sd-empty' }, 'No environment variables are set.');
    }
    const filter = el('input', { type: 'search', class: 'mg-search', placeholder: 'Filter variables', 'aria-label': 'Filter environment variables', spellcheck: false });
    const holder = el('div', {});
    const draw = () => {
        const query = filter.value.trim().toLowerCase();
        holder.replaceChildren(table(entries.filter(([key]) => key.toLowerCase().includes(query)), [
            { label: 'Variable', value: ([key]) => key, class: 'sd-num' },
            { label: 'Value', value: ([, value]) => value, class: 'num mg-dim' },
        ], { caption: 'Environment variables, values masked' }));
    };
    filter.addEventListener('input', draw);
    draw();

    return [
        el('div', { class: 'mg-row-actions' }, filter, el('span', { class: 'hint' }, plural(entries.length, 'variable'))),
        el('p', { class: 'hint' }, 'Values are masked by Watcher before they reach this window; they cannot be revealed here.'),
        holder,
    ];
}

function limitsPane(data) {
    const { cpus, memoryBytes } = data.limits ?? {};
    const ulimits = data.raw?.HostConfig?.Ulimits;

    return [
        facts([
            ['CPUs', cpus ? `${cpus} ${cpus === 1 ? 'processor' : 'processors'}` : 'No limit (can use every WSL processor)'],
            ['Memory', memoryBytes ? bytes(memoryBytes) : 'No limit (bounded by WSL\'s memory)'],
        ]),
        ulimits?.length ? [el('div', { class: 'label mg-sub' }, 'Ulimits'), shape(ulimits, 'None')] : null,
        el('p', { class: 'sd-note', dataset: { tone: 'accent' } },
            'Limits are fixed when a container is created. Changing them means recreating the container, which Watcher deliberately does not do, so they are shown read-only.'),
    ];
}

async function openInspect(name) {
    const statusNode = statusLine();
    const holder = el('div', { class: 'mg-inspect' }, el('p', { class: 'mg-status busy sd-meta', dataset: { tone: 'pending' } }, 'Reading inspect data…'));
    const dialog = openDialog({ title: `Inspect ${titleOf(name)}`, wide: true, body: [holder, statusNode] });
    const refresh = button('Refresh', () => load());
    append(dialog.foot, [
        button('Logs', () => {
            dialog.close();
            openLogsFor(name);
        }),
        button('Files…', () => openFiles(name)),
        button('Terminal…', () => openTerminal(name)),
        button('Diagnose…', () => openDiagnose(name)),
        button('Networks…', () => openMembership({ container: name })),
        el('span', { class: 'spacer' }),
        refresh,
        button('Close', () => dialog.close()),
    ]);
    let ticket = 0;
    const load = async () => {
        const mine = ++ticket;
        status(statusNode, 'busy', 'Reading…');
        refresh.disabled = true;
        try {
            const data = await manage('inspect', { name });
            if (mine !== ticket || !dialog.open) {
                return;
            }
            holder.replaceChildren(innerTabs('Inspect sections', [
                { label: 'Overview', build: () => overviewPane(data) },
                { label: 'Health', build: () => healthPane(data, runtimeCache?.capabilities) },
                { label: 'Environment', build: () => environmentPane(data) },
                { label: 'Mounts', build: () => shape(data.mounts, 'No volumes or bind mounts.') },
                { label: 'Networks', build: () => shape(data.networks, 'Not attached to any network.') },
                { label: 'Ports', build: () => shape(data.ports, 'No published ports.') },
                { label: 'Limits', build: () => limitsPane(data) },
                { label: 'Raw JSON', build: () => [el('p', { class: 'hint' }, 'Environment and credential-like values are masked.'), jsonBlock(data.raw, 'Raw inspect JSON')] },
            ]));
            status(statusNode, '', `Read at ${clock(Date.now())}.`);
        } catch (error) {
            if (mine === ticket && dialog.open) {
                holder.replaceChildren(el('p', { class: 'mg-status sd-meta', dataset: { tone: 'danger' } }, `Could not inspect ${name}: ${errorText(error)}`));
                status(statusNode, '', '');
            }
        } finally {
            refresh.disabled = false;
        }
    };
    load();
}

// ---------- Terminal ----------

const shells = ['/bin/sh', '/bin/bash', '/bin/ash', '/bin/zsh'];

function openTerminal(name) {
    const c = containerByName(name);
    const user = el('input', { type: 'text', placeholder: 'image default', spellcheck: false, autocomplete: 'off' });
    const workdir = el('input', { type: 'text', placeholder: 'image default', spellcheck: false, autocomplete: 'off' });
    const shell = el('select', {}, shells.map((path) => new Option(path, path)));
    const statusNode = statusLine();
    const dialog = openDialog({
        title: `Terminal in ${titleOf(name)}`,
        body: [
            el('p', {}, 'Opens Windows Terminal with an interactive shell inside this container. No command text is passed, only the options below.'),
            c && !running(c) ? el('p', { class: 'sd-note', dataset: { tone: 'warning' } }, `${titleOf(name)} is ${c.state}. A shell needs the container running.`) : null,
            el('div', { class: 'mg-form' },
                field('User', user, 'name, uid or uid:gid'),
                field('Working directory', workdir, 'absolute path inside the container'),
                field('Shell', shell, 'must exist in the image')),
            statusNode,
        ],
    });
    const open = button('Open terminal', () => run(), 'primary');
    append(dialog.foot, [button('Close', () => dialog.close()), open]);
    const run = async () => {
        const parameters = { name, user: user.value.trim(), workdir: workdir.value.trim(), shell: shell.value };
        if (parameters.user && !/^[A-Za-z0-9_.-]+(:[A-Za-z0-9_.-]+)?$/.test(parameters.user)) {
            status(statusNode, 'error', 'User must be a name, uid or uid:gid without spaces.');
            user.focus();
            return;
        }
        if (parameters.workdir && (!parameters.workdir.startsWith('/') || /[\u0000-\u001f]/.test(parameters.workdir))) {
            status(statusNode, 'error', 'Working directory must be an absolute path such as /app.');
            workdir.focus();
            return;
        }
        status(statusNode, 'busy', 'Opening Windows Terminal…');
        try {
            const result = await busyWhile(open, 'Opening…', () => manage('terminal', parameters));
            status(statusNode, 'ok', result?.message ?? 'Opened.');
        } catch (error) {
            status(statusNode, 'error', errorText(error));
        }
    };
}

// ---------- Files ----------

const isDirectory = (entry) => /^d|dir/i.test(entry?.type ?? '');
const isLink = (entry) => /^l|link/i.test(entry?.type ?? '');
const joinPath = (dir, name) => `${dir.replace(/\/+$/, '')}/${name}`;
const parentPath = (dir) => dir.replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/';
const baseName = (path) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
const windowsPath = (path) => /^[A-Za-z]:\\/.test(path ?? '') || /^\\\\[^\\]+\\/.test(path ?? '');

function openFiles(name, start = '/') {
    let path = start;
    let entries = [];
    let chosen = null;
    let ticket = 0;
    const c = containerByName(name);
    const pathInput = el('input', { type: 'text', class: 'mg-grow sd-num', value: path, spellcheck: false, 'aria-label': 'Path inside the container' });
    const list = el('div', { class: 'mg-files', role: 'listbox', 'aria-label': 'Directory entries' });
    const preview = el('div', {});
    const statusNode = statusLine();
    const choice = el('p', { class: 'hint' }, 'Nothing selected.');
    const dialog = openDialog({
        title: `Files in ${titleOf(name)}`,
        wide: true,
        body: [
            c && !running(c) ? el('p', { class: 'sd-note', dataset: { tone: 'warning' } }, 'Listing runs a read-only command inside the container, so it needs the container running. Copying works either way.') : null,
            el('form', { class: 'mg-row-actions', onsubmit: (event) => {
                event.preventDefault();
                browse(pathInput.value.trim() || '/');
            } },
            el('button', { type: 'button', class: 'sd-btn sd-btn-icon sd-btn-sm', title: 'Parent folder', 'aria-label': 'Parent folder', onclick: () => browse(parentPath(path)) }, icon('chevron-up')),
            pathInput,
            el('button', { type: 'submit', class: 'sd-btn sd-btn-sm' }, 'Go')),
            list,
            preview,
            choice,
            statusNode,
        ],
    });
    const copyOut = button('Copy selected out…', () => copy('out'), 'secondary', { disabled: true });
    const copyFileIn = button('Copy file in…', () => copy('in', 'file'));
    const copyFolderIn = button('Copy folder in…', () => copy('in', 'folder'));
    append(dialog.foot, [
        copyOut,
        copyFileIn,
        copyFolderIn,
        el('span', { class: 'spacer' }),
        button('Close', () => dialog.close()),
    ]);

    const choose = (entry) => {
        chosen = entry;
        copyOut.disabled = !entry;
        choice.textContent = entry ? `Selected ${joinPath(path, entry.name)}` : 'Nothing selected.';
        list.querySelectorAll('[role="option"]').forEach((node) => node.setAttribute('aria-selected', String(node.dataset.name === entry?.name)));
    };

    const render = () => {
        const sorted = [...entries].sort((a, b) => isDirectory(b) - isDirectory(a) || a.name.localeCompare(b.name));
        list.replaceChildren(...(sorted.length ? sorted.map((entry) => {
            const node = el('div', {
                class: 'mg-file sd-item', role: 'option', tabIndex: 0, 'aria-selected': 'false', dataset: { name: entry.name },
                title: isDirectory(entry) ? 'Double-click or press Enter to open' : 'Select to copy out',
            }, icon(isDirectory(entry) ? 'chevron-right' : isLink(entry) ? 'link' : 'logs'),
                el('span', { class: 'sd-item-body' }, el('span', { class: 'sd-item-title' }, entry.name)),
                el('span', { class: 'sd-item-end' }, entry.type ?? ''));
            node.addEventListener('click', () => choose(entry));
            node.addEventListener('dblclick', () => isDirectory(entry) && browse(joinPath(path, entry.name)));
            node.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    isDirectory(entry) ? browse(joinPath(path, entry.name)) : choose(entry);
                } else if (event.key === ' ') {
                    event.preventDefault();
                    choose(entry);
                } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault();
                    (event.key === 'ArrowDown' ? node.nextElementSibling : node.previousElementSibling)?.focus();
                } else if (event.key === 'Backspace') {
                    event.preventDefault();
                    browse(parentPath(path));
                }
            });
            return node;
        }) : [el('p', { class: 'sd-empty' }, 'This folder is empty.')]));
    };

    async function browse(next) {
        if (!next.startsWith('/')) {
            status(statusNode, 'error', 'Use an absolute path inside the container, such as /app.');
            return;
        }
        const mine = ++ticket;
        status(statusNode, 'busy', `Listing ${next}…`);
        try {
            const result = await manage('files', { name, path: next, confirmed: true });
            if (mine !== ticket || !dialog.open) {
                return;
            }
            path = result?.path ?? next;
            pathInput.value = path;
            entries = (result?.entries ?? []).filter((entry) => entry?.name && entry.name !== '.' && entry.name !== '..');
            choose(null);
            render();
            const isFile = result?.text != null || result?.binary === true;
            list.hidden = choice.hidden = isFile;
            copyFileIn.disabled = copyFolderIn.disabled = isFile;
            preview.replaceChildren(...(result?.text != null
                ? [el('div', { class: 'label mg-sub' }, 'Contents'), el('pre', { class: 'mg-json sd-code', tabIndex: 0, 'aria-label': 'File contents' }, result.text)]
                : []));
            status(statusNode, result?.binary || result?.truncated ? 'warning' : '', result?.binary
                ? 'Binary file; preview is unavailable. Select it from its parent folder to copy it out.'
                : result?.truncated
                    ? isFile ? 'Preview truncated; copy the file out to read all of it.' : 'Listing truncated; some entries are not shown.'
                    : isFile ? 'Text file preview.' : plural(entries.length, 'entry', 'entries'));
        } catch (error) {
            if (mine === ticket && dialog.open) {
                status(statusNode, 'error', `Could not list ${next}: ${errorText(error)}`);
            }
        }
    }

    async function copy(direction, kind) {
        let hostPath;
        let containerPath;
        try {
            if (direction === 'out') {
                if (!chosen) {
                    return;
                }
                containerPath = joinPath(path, chosen.name);
                const picked = await manage('pick-path', isDirectory(chosen) ? { kind: 'folder' } : { kind: 'save', suggested: chosen.name });
                if (!picked?.path) {
                    status(statusNode, '', 'Copy cancelled; no destination chosen.');
                    return;
                }
                hostPath = picked.path;
            } else {
                const picked = await manage('pick-path', { kind });
                if (!picked?.path) {
                    status(statusNode, '', 'Copy cancelled; nothing chosen.');
                    return;
                }
                hostPath = picked.path;
                containerPath = path.endsWith('/') ? path : `${path}/`;
            }
        } catch (error) {
            status(statusNode, 'error', `Could not open the path picker: ${errorText(error)}`);
            return;
        }
        if (!windowsPath(hostPath)) {
            status(statusNode, 'error', `The Windows path must be fully qualified: ${hostPath}`);
            return;
        }
        const exists = direction === 'in' && entries.some((entry) => entry.name === baseName(hostPath));
        const folderOut = direction === 'out' && isDirectory(chosen);
        const destination = folderOut ? `${hostPath.replace(/\\+$/, '')}\\${chosen.name}` : hostPath;
        const ok = await confirmAction({
            title: direction === 'out' ? `Copy out of ${titleOf(name)}?` : `Copy into ${titleOf(name)}?`,
            message: direction === 'out' ? 'Copies from the container to Windows.' : 'Copies from Windows into the container.',
            items: direction === 'out' ? [`from ${name}:${containerPath}`, `to ${destination}`] : [`from ${hostPath}`, `to ${name}:${containerPath}`],
            warning: direction === 'out'
                ? `If ${destination} already exists, folders are merged and files with the same name are replaced.`
                : exists
                    ? `${joinPath(containerPath, baseName(hostPath))} already exists. Matching files are replaced and folders are merged.`
                    : `The filename is kept in ${containerPath}. Matching files are replaced and folders are merged if they already exist.`,
            action: 'Copy and overwrite',
            tone: 'amber',
        });
        if (!ok) {
            return;
        }
        const id = operationId();
        const cancel = cancelButton(id);
        statusNode.after(cancel);
        status(statusNode, 'busy', 'Copying…');
        try {
            const result = await manage('copy', { name, containerPath, hostPath, direction, directory: folderOut, overwrite: true, confirmed: true }, id);
            status(statusNode, 'ok', result?.message ?? 'Copied.');
            if (direction === 'in') {
                browse(path);
            }
        } catch (error) {
            status(statusNode, 'error', `Copy failed: ${errorText(error)}`);
        } finally {
            cancel.remove();
        }
    }

    browse(path);
}

// ---------- Diagnose ----------

function openDiagnose(name) {
    const port = hostPort(containerByName(name));
    const host = el('input', { type: 'text', value: 'localhost', spellcheck: false, autocomplete: 'off' });
    const portField = el('input', { type: 'number', class: 'mg-narrow', min: 1, max: 65535, step: 1, value: String(port) });
    const http = el('input', { type: 'checkbox', checked: true });
    const url = el('input', { type: 'url', class: 'mg-grow', value: `http://localhost:${port}/`, spellcheck: false, autocomplete: 'off' });
    const results = el('div', { class: 'mg-diagnose' });
    const statusNode = statusLine();
    portField.addEventListener('input', () => {
        if (/^https?:\/\/localhost:\d+\/?$/.test(url.value)) {
            url.value = `http://localhost:${portField.value}/`;
        }
    });
    const dialog = openDialog({
        title: `Diagnose ${titleOf(name)}`,
        wide: true,
        body: [
            el('p', {}, 'Runs bounded, read-only checks against the host and port you give: Windows listeners, TCP reachability and in-container probes. Nothing is written.'),
            el('div', { class: 'mg-form' },
                field('Host', host, 'as reached from Windows'),
                field('Port', portField, '1–65535'),
                el('div', { class: 'mg-field mg-wide' },
                    el('label', { class: 'mg-inline' }, http, el('span', { class: 'label' }, 'Also send one HTTP request from Windows')),
                    url)),
            statusNode,
            results,
        ],
    });
    const runButton = button('Run checks', () => run(), 'primary');
    append(dialog.foot, [button('Close', () => dialog.close()), runButton]);

    const run = async () => {
        const target = host.value.trim();
        const number = Number(portField.value);
        if (!/^[A-Za-z0-9.\-:[\]]{1,253}$/.test(target)) {
            status(statusNode, 'error', 'Host must be a name or IP address without spaces.');
            host.focus();
            return;
        }
        if (!Number.isInteger(number) || number < 1 || number > 65535) {
            status(statusNode, 'error', 'Port must be a whole number from 1 to 65535.');
            portField.focus();
            return;
        }
        if (http.checked) {
            let parsed = null;
            try {
                parsed = new URL(url.value.trim());
            } catch {
                parsed = null;
            }
            if (!parsed || !['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
                status(statusNode, 'error', 'The HTTP check needs an http:// or https:// URL without credentials.');
                url.focus();
                return;
            }
        }
        const id = operationId();
        const cancel = cancelButton(id);
        statusNode.after(cancel);
        runButton.disabled = true;
        results.replaceChildren();
        const section = (heading, explanation, ...content) => el('section', { class: 'mg-section' },
            el('div', { class: 'label' }, heading), el('p', { class: 'hint' }, explanation), ...content);
        try {
            status(statusNode, 'busy', 'Checking listeners and TCP…');
            try {
                // The diagnose dialog is the explicit consent for probing the typed host, which may
                // resolve to a private or loopback address — that is the feature's normal case.
                const result = await manage('diagnose', { name, host: target, port: number, confirmed: true }, id);
                results.append(section('Network checks', `Host ${target}, port ${number}.`,
                    (result?.checks ?? []).length
                        ? el('ul', { class: 'mg-checks' }, result.checks.map((check) => el('li', {},
                            badge(check.ok ? 'pass' : 'fail', check.ok ? 'green' : 'pink'),
                            el('span', { class: 'mg-check-name' }, check.name),
                            el('span', { class: 'mg-output sd-code' }, check.detail ?? ''))))
                        : el('p', { class: 'sd-empty' }, 'No checks were reported.'),
                    result?.ports != null ? [el('div', { class: 'label mg-sub' }, 'Windows listeners and published ports'), shape(result.ports, 'Nothing is listening.')] : null));
            } catch (error) {
                results.append(section('Network checks', '', el('p', { class: 'mg-status sd-meta', dataset: { tone: 'danger' } }, errorText(error))));
            }
            if (!dialog.open) {
                return;
            }
            if (http.checked) {
                status(statusNode, 'busy', 'Sending one HTTP request from Windows…');
                try {
                    // The host guard on Windows asks for confirmation when the URL resolves to a private
                    // or loopback address; this heuristic covers the common literal cases up front.
                    const target = url.value.trim();
                    const restricted = (() => { try { return /^(localhost|0\.|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\]|::1)/i.test(new URL(target).hostname); } catch { return false; } })();
                    const ready = await manage('readiness', { name, url: target, confirmed: restricted }, id);
                    results.append(section('Windows HTTP reachability', 'One request from Windows to this URL, without redirects. Separate from the container\'s own health check.',
                        el('p', { class: 'mg-inline' }, badge(ready?.ok ? 'reachable' : 'not ready', ready?.ok ? 'green' : 'pink'),
                            el('span', { class: 'sd-num' }, `${ready?.status || 'no response'} · ${ready?.ms ?? '?'} ms`)),
                        el('p', { class: 'mg-output sd-code' }, ready?.detail ?? '')));
                } catch (error) {
                    results.append(section('Windows HTTP reachability', '', el('p', { class: 'mg-status sd-meta', dataset: { tone: 'danger' } }, errorText(error))));
                }
            }
            if (!dialog.open) {
                return;
            }
            status(statusNode, 'busy', 'Reading native health…');
            try {
                const data = await manage('inspect', { name }, id);
                const health = healthStatus(data?.health);
                results.append(section('Native health (wslc)', 'The container\'s own health check, as WSLc reports it.',
                    el('p', { class: 'mg-inline' }, health ? badge(health, healthTone(health)) : badge('no health check', 'neutral'),
                        stateBadge(data?.state ?? data?.raw?.State))));
            } catch (error) {
                results.append(section('Native health (wslc)', '', el('p', { class: 'mg-status sd-meta', dataset: { tone: 'danger' } }, errorText(error))));
            }
            status(statusNode, '', `Finished at ${clock(Date.now())}.`);
        } finally {
            cancel.remove();
            runButton.disabled = false;
        }
    };
}

// ---------- Network membership ----------

function openMembership({ container = '', network = '' } = {}) {
    const containerSelect = el('select', { class: 'mg-grow' });
    const networkSelect = el('select', { class: 'mg-grow' });
    const current = el('div', {});
    const statusNode = statusLine();
    const connect = button('Connect…', () => change(false), 'primary', { disabled: true });
    const disconnect = button('Disconnect…', () => change(true), 'danger', { disabled: true });
    const dialog = openDialog({
        title: 'Network membership',
        body: [
            el('p', {}, 'Connect an existing container to an existing network, or disconnect it. Networks are not created here.'),
            el('div', { class: 'mg-form' }, field('Container', containerSelect), field('Network', networkSelect)),
            current,
            statusNode,
        ],
    });
    append(dialog.foot, [button('Close', () => dialog.close()), disconnect, connect]);
    let joined = [];
    let ticket = 0;

    const sync = () => {
        const member = joined.includes(networkSelect.value);
        connect.disabled = !containerSelect.value || !networkSelect.value || member;
        disconnect.disabled = !containerSelect.value || !networkSelect.value || !member;
    };

    const readContainer = async () => {
        const mine = ++ticket;
        joined = [];
        sync();
        if (!containerSelect.value) {
            current.replaceChildren();
            return;
        }
        current.replaceChildren(el('p', { class: 'mg-status busy sd-meta', dataset: { tone: 'pending' } }, 'Reading memberships…'));
        try {
            const data = await manage('inspect', { name: containerSelect.value });
            if (mine !== ticket) {
                return;
            }
            joined = memberships(data?.networks ?? data?.raw?.NetworkSettings?.Networks);
            current.replaceChildren(el('div', { class: 'label mg-sub' }, 'Currently connected to'),
                joined.length ? el('ul', { class: 'mg-list' }, joined.map((n) => el('li', { class: 'sd-num' }, n))) : el('p', { class: 'sd-empty' }, 'No networks.'));
        } catch (error) {
            if (mine === ticket) {
                current.replaceChildren(el('p', { class: 'mg-status sd-meta', dataset: { tone: 'danger' } }, `Could not read memberships: ${errorText(error)}`));
            }
        }
        sync();
    };

    containerSelect.addEventListener('change', readContainer);
    networkSelect.addEventListener('change', sync);

    const change = async (leave) => {
        const [name, net] = [containerSelect.value, networkSelect.value];
        const ok = await confirmAction({
            title: leave ? `Disconnect from ${net}?` : `Connect to ${net}?`,
            message: leave
                ? 'The container loses its interface and address on this network. Connections over it drop.'
                : 'The container gets an interface on this network and can reach its other members.',
            items: [`container ${titleOf(name)} · ${name}`, `network ${net}`],
            action: leave ? 'Disconnect' : 'Connect',
            tone: leave ? 'pink' : 'amber',
        });
        if (!ok) {
            return;
        }
        status(statusNode, 'busy', leave ? 'Disconnecting…' : 'Connecting…');
        try {
            const result = await manage('network-connect', { network: net, name, disconnect: leave, confirmed: true });
            status(statusNode, 'ok', result?.message ?? 'Done.');
        } catch (error) {
            status(statusNode, 'error', errorText(error));
        }
        readContainer();
    };

    containerSelect.append(new Option('Choose a container', ''), ...[...containers].sort((a, b) => a.title.localeCompare(b.title))
        .map((c) => new Option(`${c.title} (${c.state})`, c.name)));
    if (container && !containerByName(container)) {
        containerSelect.append(new Option(container, container));
    }
    containerSelect.value = container;
    networkSelect.append(new Option('Loading networks…', ''));
    manage('inventory', { kind: 'network' }).then((result) => {
        const names = (result?.items ?? []).map((row) => row.Name ?? row.name).filter(Boolean).sort();
        networkSelect.replaceChildren(new Option(names.length ? 'Choose a network' : 'No networks in this session', ''), ...names.map((n) => new Option(n, n)));
        networkSelect.value = names.includes(network) ? network : '';
        sync();
    }, (error) => {
        networkSelect.replaceChildren(new Option('Networks unavailable', ''));
        status(statusNode, 'error', `Could not list networks: ${errorText(error)}`);
    });
    readContainer();
}

// ---------- Long-running actions ----------

/** A dialog that runs one cancellable operation and then shows its message or error. */
function progressDialog({ title, message, run, tone = 'amber' }) {
    const id = operationId();
    const statusNode = statusLine();
    const dialog = openDialog({ title, tone, body: [el('p', {}, message), statusNode] });
    const cancel = cancelButton(id);
    const close = button('Close', () => dialog.close(), 'secondary', { disabled: true });
    append(dialog.foot, [cancel, close]);
    status(statusNode, 'busy', 'Working… Closing this dialog does not stop it; use Cancel.');

    return run(id).then((result) => {
        status(statusNode, 'ok', result?.message ?? 'Done.');
        return result;
    }, (error) => {
        status(statusNode, 'error', errorText(error));
        return null;
    }).finally(() => {
        cancel.remove();
        close.disabled = false;
        if (dialog.open) {
            close.focus();
        }
    });
}

const stamp = () => {
    const now = new Date();
    return `${day(now).replaceAll('-', '')}-${clock(now).replaceAll(':', '')}`;
};
const safeFileName = (value) => value.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '').slice(0, 80) || 'export';

/** Removes explicit objects one at a time and shows each outcome. targets: [{kind, name}]. Resolves the results, or null if declined. */
async function removeObjects(targets) {
    const nouns = [...new Set(targets.map((t) => t.kind))];
    const ok = await confirmAction({
        title: `Remove ${plural(targets.length, nouns.length === 1 ? nouns[0] : 'object')}?`,
        message: 'Each listed object is removed on its own. WSLc refuses anything still in use; Watcher never forces it.',
        items: targets.map((t) => `${t.kind} ${t.name}`),
        warning: 'This cannot be undone. A removed volume\'s data is gone; a removed image must be pulled or built again outside Watcher.',
        action: 'Remove',
    });
    if (!ok) {
        return null;
    }
    let stop = false;
    const results = [];
    const progress = el('p', { class: 'mg-status busy sd-meta', dataset: { tone: 'pending' }, role: 'status', 'aria-live': 'polite' });
    const holder = el('div', {});
    const dialog = openDialog({ title: 'Removing', tone: 'pink', body: [progress, holder] });
    const halt = button('Stop after current', () => {
        stop = true;
        halt.disabled = true;
    });
    const close = button('Close', () => dialog.close(), 'secondary', { disabled: true });
    append(dialog.foot, [halt, close]);
    for (const target of targets) {
        if (stop) {
            break;
        }
        progress.textContent = `Removing ${target.kind} ${target.name} (${results.length + 1} of ${targets.length})…`;
        const started = performance.now();
        try {
            const result = await manage('object-remove', { kind: target.kind, name: target.name, confirmed: true });
            results.push({ name: `${target.kind} ${target.name}`, ok: true, detail: result?.message ?? 'Removed.', ms: performance.now() - started });
        } catch (error) {
            results.push({ name: `${target.kind} ${target.name}`, ok: false, detail: errorText(error), ms: performance.now() - started });
        }
        holder.replaceChildren(outcomeTable(results));
    }
    const skipped = targets.length - results.length;
    status(progress, skipped ? 'error' : '', skipped ? `Stopped. ${skipped} not attempted.` : 'Finished.');
    halt.remove();
    close.disabled = false;
    close.focus();

    return results;
}

async function saveImage(name) {
    let picked;
    try {
        picked = await manage('pick-path', { kind: 'save', suggested: `${safeFileName(name)}.tar` });
    } catch (error) {
        progressDialog({ title: 'Save image', message: '', run: () => Promise.reject(error) });
        return;
    }
    if (!picked?.path) {
        return;
    }
    const ok = await confirmAction({
        title: `Save ${name}?`,
        message: 'Exports the existing image to an archive on Windows. Nothing is pulled, built or tagged.',
        items: [`image ${name}`, `to ${picked.path}`],
        warning: 'If this file already exists it is overwritten.',
        action: 'Save image',
        tone: 'amber',
    });
    if (ok) {
        progressDialog({ title: `Saving ${name}`, message: `Writing ${picked.path}. Large images take a while.`, run: (id) => manage('image-save', { name, path: picked.path, overwrite: true, confirmed: true }, id) });
    }
}

async function openObject(kind, name) {
    const holder = el('div', {}, el('p', { class: 'mg-status busy sd-meta', dataset: { tone: 'pending' } }, 'Reading…'));
    const dialog = openDialog({ title: `Inspect ${kind} ${name}`, wide: true, body: holder });
    append(dialog.foot, [
        kind === 'network' ? button('Membership…', () => openMembership({ network: name })) : null,
        kind === 'volume' ? button('Back up…', () => openBackup(name)) : null,
        kind === 'image' ? button('Save…', () => saveImage(name)) : null,
        el('span', { class: 'spacer' }),
        button('Close', () => dialog.close()),
    ]);
    try {
        const result = await manage('object-inspect', { kind, name });
        const raw = result?.raw;
        const members = kind === 'network' && isObject(raw?.Containers) ? raw.Containers : null;
        holder.replaceChildren(
            members ? [el('div', { class: 'label mg-sub' }, 'Connected containers'), shape(members, 'No containers are connected.')] : null,
            el('p', { class: 'hint' }, 'Environment and credential-like values are masked.'),
            jsonBlock(raw, `Raw ${kind} JSON`));
    } catch (error) {
        holder.replaceChildren(el('p', { class: 'mg-status sd-meta', dataset: { tone: 'danger' } }, `Could not inspect ${kind} ${name}: ${errorText(error)}`));
    }
}

function openBackup(volume) {
    const stopped = containers.filter((c) => !running(c)).sort((a, b) => a.title.localeCompare(b.title));
    const containerSelect = el('select', { class: 'mg-grow' },
        new Option(stopped.length ? 'Choose a stopped container' : 'No stopped containers', ''),
        stopped.map((c) => new Option(`${c.title} (${c.state})`, c.name)));
    const mountInfo = el('div', {});
    const destination = el('p', { class: 'num mg-path' }, 'No destination chosen.');
    const statusNode = statusLine();
    let containerPath = '';
    let hostPath = '';
    let ticket = 0;
    const dialog = openDialog({
        title: `Back up volume ${volume}`,
        body: [
            el('p', {}, 'Copies the volume\'s files out through an existing, stopped container that already mounts it. No helper container is created.'),
            el('p', { class: 'sd-note', dataset: { tone: 'warning' } }, 'Running containers are excluded, and live database backups are refused: stop the database first so its files are consistent.'),
            el('div', { class: 'mg-form' }, field('Container', containerSelect, 'only stopped containers are listed')),
            mountInfo,
            el('div', { class: 'mg-row-actions' }, button('Choose destination folder…', () => pick()), destination),
            statusNode,
        ],
    });
    const go = button('Back up…', () => run(), 'primary', { disabled: true });
    append(dialog.foot, [button('Close', () => dialog.close()), go]);
    const sync = () => (go.disabled = !containerSelect.value || !containerPath || !hostPath);

    containerSelect.addEventListener('change', async () => {
        const mine = ++ticket;
        containerPath = '';
        sync();
        if (!containerSelect.value) {
            mountInfo.replaceChildren();
            return;
        }
        mountInfo.replaceChildren(el('p', { class: 'mg-status busy sd-meta', dataset: { tone: 'pending' } }, 'Checking the container\'s mounts…'));
        try {
            const data = await manage('inspect', { name: containerSelect.value });
            if (mine !== ticket) {
                return;
            }
            const mounts = Array.isArray(data?.mounts) ? data.mounts : data?.raw?.Mounts ?? [];
            const mount = mounts.find((m) => m?.Name === volume || (m?.Type === 'volume' && String(m?.Source ?? '').includes(volume)));
            if (data?.raw?.State?.Running) {
                mountInfo.replaceChildren(el('p', { class: 'mg-status sd-meta', dataset: { tone: 'danger' } }, 'This container is running now. Stop it first.'));
            } else if (!mount) {
                mountInfo.replaceChildren(el('p', { class: 'mg-status sd-meta', dataset: { tone: 'danger' } }, `${containerSelect.value} does not mount ${volume}.`));
            } else {
                containerPath = mount.Destination ?? mount.Target ?? '';
                mountInfo.replaceChildren(facts([['Mounted at', el('span', { class: 'sd-num' }, containerPath)], ['Mode', mount.RW === false ? 'read-only' : mount.Mode || 'read-write']]));
            }
        } catch (error) {
            if (mine === ticket) {
                mountInfo.replaceChildren(el('p', { class: 'mg-status sd-meta', dataset: { tone: 'danger' } }, `Could not inspect: ${errorText(error)}`));
            }
        }
        sync();
    });

    const pick = async () => {
        try {
            const picked = await manage('pick-path', { kind: 'folder' });
            if (picked?.path) {
                hostPath = `${picked.path.replace(/\\+$/, '')}\\${safeFileName(volume.slice(0, 24))}-backup-${stamp()}`;
                destination.textContent = hostPath;
            }
        } catch (error) {
            status(statusNode, 'error', `Could not open the folder picker: ${errorText(error)}`);
        }
        sync();
    };

    const run = async () => {
        const container = containerSelect.value;
        const ok = await confirmAction({
            title: `Back up ${volume}?`,
            message: 'Copies the volume\'s current files to a new folder on Windows.',
            items: [`volume ${volume}`, `through ${container}:${containerPath}`, `to ${hostPath}`],
            warning: 'Keep the container stopped until this finishes. If the destination already exists, same-named files in it are overwritten.',
            action: 'Back up',
            tone: 'amber',
        });
        if (ok) {
            progressDialog({
                title: `Backing up ${volume}`, message: `Copying to ${hostPath}.`,
                run: (id) => manage('volume-backup', { name: volume, path: hostPath, container, containerPath, overwrite: true, confirmed: true }, id),
            });
        }
    };
}

// ---------- Images, volumes and networks ----------

const builtinNetworks = new Set(['bridge', 'host', 'none']);
const imageName = (row) => (row.Repository && row.Repository !== '<none>' && row.Tag && row.Tag !== '<none>'
    ? `${row.Repository}:${row.Tag}` : row.ID ?? row.Id ?? row.Name ?? '');
const shortId = (value) => (/^(sha256:)?[0-9a-f]{20,}$/.test(value ?? '') ? `${String(value).replace('sha256:', '').slice(0, 12)}…` : value);

const resources = {
    image: {
        tab: 'images', label: 'Images',
        intro: 'Images already in this session. Save one to an archive, inspect it, or remove it if nothing uses it. Pull, build, tag, push and import are not offered.',
        id: imageName,
        columns: [
            { label: 'Repository', value: (r) => r.Repository, class: 'sd-num' },
            { label: 'Tag', value: (r) => r.Tag, class: 'sd-num' },
            { label: 'ID', value: (r) => r.ID ?? r.Id, class: 'num mg-dim' },
            { label: 'Size', value: (r) => r.Size, class: 'sd-num' },
            { label: 'Created', value: (r) => r.CreatedSince ?? r.CreatedAt },
            { label: 'Containers', value: (r) => r.Containers, class: 'sd-num' },
        ],
        keys: ['Repository', 'ID'],
        actions: (name) => [button('Save…', () => saveImage(name), 'secondary', { 'aria-label': `Save image ${name}` })],
    },
    volume: {
        tab: 'volumes', label: 'Volumes',
        intro: 'Volumes already in this session. Back one up through a stopped container that mounts it, inspect it, or remove it if unused.',
        id: (r) => r.Name ?? r.name ?? '',
        columns: [
            { label: 'Name', value: (r) => el('span', { title: r.Name }, shortId(r.Name)), class: 'sd-num' },
            { label: 'Driver', value: (r) => r.Driver },
            { label: 'Scope', value: (r) => r.Scope },
            { label: 'Kind', value: (r) => (String(r.Labels ?? '').includes('com.docker.volume.anonymous') ? 'anonymous' : 'named') },
            { label: 'Mountpoint', value: (r) => el('span', { class: 'mg-output sd-code', title: r.Mountpoint }, text(r.Mountpoint)), class: 'num mg-dim' },
        ],
        keys: ['Name'],
        actions: (name) => [button('Back up…', () => openBackup(name), 'secondary', { 'aria-label': `Back up volume ${name}` })],
    },
    network: {
        tab: 'networks', label: 'Networks',
        intro: 'Networks already in this session. Change which containers belong to one, inspect it, or remove an unused one. New networks are not created here.',
        id: (r) => r.Name ?? r.name ?? '',
        columns: [
            { label: 'Name', value: (r) => r.Name, class: 'sd-num' },
            { label: 'Driver', value: (r) => r.Driver },
            { label: 'ID', value: (r) => r.ID ?? r.Id, class: 'num mg-dim' },
            { label: 'Scope', value: (r) => r.Scope },
            { label: 'Internal', value: (r) => r.Internal },
            { label: 'IPv6', value: (r) => r.IPv6 },
        ],
        keys: ['Name'],
        actions: (name) => [button('Membership…', () => openMembership({ network: name }), 'secondary', { 'aria-label': `Change membership of network ${name}` })],
        removable: (name) => !builtinNetworks.has(name),
    },
};

/** Rows the contract leaves shapeless: known columns when their keys are present, every key otherwise. */
function columnsFor(spec, items) {
    if (items.some((row) => spec.keys.some((key) => key in row))) {
        return spec.columns;
    }
    const keys = [...new Set(items.flatMap((row) => Object.keys(row)))];

    return keys.map((key) => ({ label: key, value: (row) => (typeof row[key] === 'object' ? JSON.stringify(row[key]) : row[key]) }));
}

const inventories = new Map();

function resourceTab(kind) {
    const spec = resources[kind];
    const state = { items: null, ticket: 0 };
    const filter = el('input', { type: 'search', class: 'mg-search', placeholder: `Filter ${spec.label.toLowerCase()}`, spellcheck: false, 'aria-label': `Filter ${spec.label.toLowerCase()}` });
    const count = el('span', { class: 'hint' });
    const statusNode = statusLine();
    const holder = el('div', {});
    const refresh = button('Refresh', () => load());
    const load = async () => {
        const mine = ++state.ticket;
        status(statusNode, 'busy', `Listing ${spec.label.toLowerCase()}…`);
        refresh.disabled = true;
        try {
            const result = await manage('inventory', { kind });
            if (mine !== state.ticket) {
                return;
            }
            state.items = Array.isArray(result?.items) ? result.items.filter(isObject) : [];
            inventories.set(kind, state.items);
            status(statusNode, '', `Listed at ${clock(Date.now())}.`);
            render();
        } catch (error) {
            if (mine === state.ticket) {
                status(statusNode, 'error', `Could not list ${spec.label.toLowerCase()}: ${errorText(error)}`);
            }
        } finally {
            refresh.disabled = false;
        }
    };
    const render = () => {
        if (state.items === null) {
            return;
        }
        const query = filter.value.trim().toLowerCase();
        const rows = state.items.filter((row) => !query || JSON.stringify(row).toLowerCase().includes(query));
        count.textContent = query ? `${rows.length} of ${state.items.length}` : plural(state.items.length, kind);
        if (rows.length === 0) {
            holder.replaceChildren(el('p', { class: 'sd-empty' }, state.items.length ? 'Nothing matches this filter.' : `No ${spec.label.toLowerCase()} in this session.`));
            return;
        }
        holder.replaceChildren(table(rows, [...columnsFor(spec, rows), {
            label: 'Actions', class: 'mg-actions-cell',
            value: (row) => {
                const name = spec.id(row);
                const removable = name && (spec.removable?.(name) ?? true);
                return el('div', { class: 'mg-row-actions' },
                    button('Inspect', () => openObject(kind, name), 'secondary', { disabled: !name, 'aria-label': `Inspect ${kind} ${name}` }),
                    name ? spec.actions(name) : null,
                    button('Remove…', async () => (await removeObjects([{ kind, name }])) && load(), 'danger', {
                        disabled: !removable,
                        title: removable ? `Remove ${kind} ${name}` : 'Built-in networks cannot be removed',
                        'aria-label': `Remove ${kind} ${name}`,
                    }));
            },
        }], { caption: spec.label }));
    };
    filter.addEventListener('input', render);
    const panel = addTab(spec.tab, spec.label, { shown: () => state.items === null && load() });
    append(panel, [
        el('p', { class: 'hint mg-lead' }, spec.intro),
        el('div', { class: 'toolbar mg-toolbar' }, filter, count, el('span', { class: 'spacer' }), refresh),
        statusNode,
        holder,
    ]);
}

resourceTab('image');
resourceTab('volume');
resourceTab('network');

// ---------- Storage and cleanup ----------

const storagePanel = addTab('storage', 'Storage', { shown: () => storageLoaded || loadStorage() });
let storageLoaded = false;
const storageStatus = statusLine();
const storageHolder = el('div', {});
const cleanupStatus = statusLine();
const cleanupHolder = el('div', {});
const cleanupPicked = new Set();
let cleanupItems = [];
const cleanupRemove = button('Remove selected…', () => cleanup(), 'danger', { disabled: true });

append(storagePanel, [
    el('section', { class: 'sd-card', dataset: { tone: 'extra' } },
        el('div', { class: 'sd-card-head' }, el('h2', {}, 'WSLc storage'),
            button('Refresh', () => loadStorage())),
        el('div', { class: 'sd-card-body' }, storageStatus, storageHolder)),
    el('section', { class: 'sd-card', dataset: { tone: 'danger' } },
        el('div', { class: 'sd-card-head' }, el('h2', {}, 'Cleanup'),
            el('div', { class: 'mg-row-actions' }, button('Tick unused images', () => tickUnused()), button('Clear', () => {
                cleanupPicked.clear();
                renderCleanup();
            }), cleanupRemove)),
        el('div', { class: 'sd-card-body' },
            el('p', { class: 'hint' }, 'Nothing is pruned automatically. Tick exactly what to remove; the confirmation lists every object, and WSLc refuses anything still in use.'),
            cleanupStatus, cleanupHolder)),
]);

async function loadStorage() {
    storageLoaded = true;
    status(storageStatus, 'busy', 'Reading storage…');
    try {
        const data = await manage('storage');
        const used = data?.totalBytes ? data.totalBytes - (data.freeBytes ?? 0) : 0;
        const share = data?.totalBytes ? Math.min(100, (used / data.totalBytes) * 100) : 0;
        const files = [...(data?.files ?? [])].sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0));
        storageHolder.replaceChildren(
            facts([
                ['Storage root (all known sessions)', el('span', { class: 'sd-num' }, text(data?.storageRoot))],
                ['Active session folder', el('span', { class: 'sd-num' }, data?.sessionFolder || 'Not reported by WSLc; a custom location may be in use.')],
                ['Root drive', data?.totalBytes ? `${bytes(data.freeBytes)} free of ${bytes(data.totalBytes)}` : 'not reported'],
            ]),
            data?.totalBytes ? el('div', { class: 'sd-progress', role: 'meter', 'aria-label': 'Drive space used', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(share), style: `--value: ${Math.round(share)}` }) : null,
            files.length
                ? table(files, [
                    { label: 'File', value: (f) => el('span', { class: 'mg-output sd-code' }, f.path), class: 'sd-num' },
                    { label: 'Size', value: (f) => (f.bytes == null ? 'unavailable' : bytes(f.bytes)), class: 'sd-num' },
                ], { caption: 'Storage files in all known session folders' })
                : el('p', { class: 'sd-empty' }, 'No WSLc storage files were found at the known locations.'),
            data?.note ? el('p', { class: 'sd-note', dataset: { tone: 'accent' } }, data.note) : null);
        status(storageStatus, '', `Read at ${clock(Date.now())}.`);
    } catch (error) {
        status(storageStatus, 'error', `Could not read storage: ${errorText(error)}`);
    }
    loadCleanup();
}

async function loadCleanup() {
    status(cleanupStatus, 'busy', 'Listing images, volumes and networks…');
    const found = [];
    const failures = [];
    for (const kind of ['image', 'volume', 'network']) {
        try {
            const result = await manage('inventory', { kind });
            for (const row of (result?.items ?? []).filter(isObject)) {
                const name = resources[kind].id(row);
                if (!name || (kind === 'network' && builtinNetworks.has(name))) {
                    continue;
                }
                const notes = kind === 'image'
                    ? [row.Containers === '0' ? 'no containers' : row.Containers ? `${row.Containers} containers` : '', row.Repository === '<none>' ? 'untagged' : '', row.Size ?? '']
                    : kind === 'volume' ? [String(row.Labels ?? '').includes('com.docker.volume.anonymous') ? 'anonymous' : 'named', row.Driver ?? '']
                        : [row.Driver ?? ''];
                found.push({ kind, name, label: kind === 'volume' ? shortId(name) : name, notes: notes.filter(Boolean), unused: kind === 'image' && row.Containers === '0' });
            }
        } catch (error) {
            failures.push(`${kind}s: ${errorText(error)}`);
        }
    }
    cleanupItems = found;
    const keys = new Set(found.map((item) => `${item.kind}\u0000${item.name}`));
    [...cleanupPicked].filter((key) => !keys.has(key)).forEach((key) => cleanupPicked.delete(key));
    status(cleanupStatus, failures.length ? 'error' : '', failures.length ? `Some lists failed. ${failures.join(' ')}` : '');
    renderCleanup();
}

function renderCleanup() {
    const key = (item) => `${item.kind}\u0000${item.name}`;
    cleanupHolder.replaceChildren(cleanupItems.length
        ? el('ul', { class: 'mg-pick-list', 'aria-label': 'Removable objects' }, cleanupItems.map((item) => {
            const box = el('input', { type: 'checkbox', checked: cleanupPicked.has(key(item)) });
            box.addEventListener('change', () => {
                box.checked ? cleanupPicked.add(key(item)) : cleanupPicked.delete(key(item));
                cleanupRemove.disabled = cleanupPicked.size === 0;
                cleanupRemove.textContent = cleanupPicked.size ? `Remove ${cleanupPicked.size} selected…` : 'Remove selected…';
            });
            return el('li', {}, el('label', { class: 'mg-inline', title: item.name }, box, badge(item.kind, item.unused ? 'amber' : ''),
                el('span', { class: 'sd-num' }, item.label), el('span', { class: 'hint' }, item.notes.join(' · '))));
        }))
        : el('p', { class: 'sd-empty' }, 'No images, volumes or custom networks to clean up.'));
    cleanupRemove.disabled = cleanupPicked.size === 0;
    cleanupRemove.textContent = cleanupPicked.size ? `Remove ${cleanupPicked.size} selected…` : 'Remove selected…';
}

function tickUnused() {
    cleanupItems.filter((item) => item.unused).forEach((item) => cleanupPicked.add(`${item.kind}\u0000${item.name}`));
    renderCleanup();
}

async function cleanup() {
    const targets = cleanupItems.filter((item) => cleanupPicked.has(`${item.kind}\u0000${item.name}`)).map(({ kind, name }) => ({ kind, name }));
    if (targets.length === 0) {
        return;
    }
    const results = await removeObjects(targets);
    if (results) {
        cleanupPicked.clear();
        loadStorage();
    }
}

// ---------- Runtime, sessions and events ----------

let runtimeCache = null;
let preferencesCache = null;
const sessionLabel = (session) => (session ? session : '(default session)');
const sameSession = (a, b) => (a || 'default') === (b || 'default');

const runtimePanel = addTab('runtime', 'Runtime', { shown: () => runtimeCache || loadRuntime() });
const runtimeStatus = statusLine();
const resumeMonitoring = button('Resume monitoring', async () => {
    try {
        await manage('session-resume');
        await loadRuntime();
    } catch (error) { status(runtimeStatus, 'error', errorText(error)); }
});
resumeMonitoring.hidden = true;
on('session-paused', ({ paused }) => {
    resumeMonitoring.hidden = !paused;
    if (preferencesCache) preferencesCache.sessionPaused = paused;
    status(runtimeStatus, paused ? 'error' : '', paused ? 'Monitoring paused. Resume monitoring may start the session again.' : 'Monitoring resumed.');
});
const runtimeHolder = el('div', {});
const sessionsHolder = el('div', {});
const infoHolder = el('div', {});
const terminateHolder = el('div', {});
const eventsSince = el('select', { 'aria-label': 'Events since' },
    new Option('Last 15 min', '900'), new Option('Last hour', '3600'), new Option('Last 6 h', '21600'), new Option('Last 24 h', '86400'));
eventsSince.value = '3600';
const eventsFilter = el('input', { type: 'search', class: 'mg-search', placeholder: 'Filter events', spellcheck: false, 'aria-label': 'Filter events' });
const eventsStatus = statusLine();
const eventsList = el('div', { class: 'mg-timeline', role: 'list', 'aria-label': 'Runtime event timeline' });
const eventsLoad = button('Load', () => loadEvents(false));
const eventsNewer = button('Load newer', () => loadEvents(true), 'secondary', { disabled: true });
// Windows of time asked for, in order: {from, to, entries} on success, {from, to, error} for a gap.
let timeline = [];

append(runtimePanel, [
    el('section', { class: 'sd-card', dataset: { tone: 'accent' } },
        el('div', { class: 'sd-card-head' }, el('h2', {}, 'Runtime and session'),
            el('div', { class: 'mg-row-actions' }, button('Refresh', () => loadRuntime()), button('Open runtime settings…', () => openSettings()))),
        el('div', { class: 'sd-card-body' }, runtimeStatus, resumeMonitoring, runtimeHolder)),
    el('section', { class: 'sd-card' },
        el('div', { class: 'sd-card-head' }, el('h2', {}, 'Events')),
        el('div', { class: 'sd-card-body' },
            el('p', { class: 'hint' }, 'Bounded reads of WSLc\'s event stream. A failed read is shown as a gap, so missing time is never mistaken for a quiet period.'),
            el('div', { class: 'toolbar mg-toolbar' }, eventsSince, eventsLoad, eventsNewer, el('span', { class: 'spacer' }), eventsFilter),
            eventsStatus, eventsList)),
    el('section', { class: 'sd-card' },
        el('div', { class: 'sd-card-head' }, el('h2', {}, 'Sessions')),
        el('div', { class: 'sd-card-body' }, sessionsHolder)),
    el('section', { class: 'sd-card', dataset: { tone: 'extra' } },
        el('div', { class: 'sd-card-head' }, el('h2', {}, 'System info')),
        el('div', { class: 'sd-card-body' }, infoHolder)),
    el('section', { class: 'sd-card', dataset: { tone: 'danger' } },
        el('div', { class: 'sd-card-head' }, el('h2', {}, 'Terminate session')),
        el('div', { class: 'sd-card-body' }, terminateHolder)),
]);
eventsFilter.addEventListener('input', () => renderEvents());

function capabilityRow(label, supported, yes, no) {
    return el('li', {}, badge(supported ? 'available' : 'not available', supported ? 'green' : 'neutral'),
        el('span', { class: 'mg-check-name' }, label), el('span', { class: 'hint' }, supported ? yes : no));
}

async function loadRuntime() {
    status(runtimeStatus, 'busy', 'Reading runtime information…');
    let runtimeError = '';
    try {
        runtimeCache = await manage('runtime');
    } catch (error) {
        runtimeError = errorText(error);
    }
    try {
        preferencesCache = await manage('preferences');
        resumeMonitoring.hidden = !preferencesCache?.sessionPaused;
    } catch (error) {
        runtimeError ||= `Could not read preferences: ${errorText(error)}`;
    }
    if (!runtimeCache) {
        status(runtimeStatus, 'error', `Could not read runtime information: ${runtimeError}`);
        renderTerminate();
        return;
    }
    const { info, sessions, session, capabilities = {}, settingsPath } = runtimeCache;
    const active = preferencesCache?.activeSession;
    runtimeHolder.replaceChildren(
        facts([
            ['Watcher targets', active === undefined ? 'unknown' : el('span', { class: 'sd-num' }, sessionLabel(active))],
            ['WSLc reports', el('span', { class: 'sd-num' }, sessionLabel(session))],
            ['Settings file', el('span', { class: 'sd-num' }, text(settingsPath))],
            ['Version', info?.Client?.Version ?? info?.ServerVersion ?? info?.Version ?? info?.version ?? null],
        ]),
        el('div', { class: 'label mg-sub' }, 'Capabilities of the installed wslc'),
        el('ul', { class: 'mg-checks' },
            capabilityRow('Events', capabilities.events, 'event timeline below', 'this wslc has no event stream; the timeline is unavailable'),
            capabilityRow('Health', capabilities.health, 'native health checks are reported in Inspect', 'health status is not reported; use Diagnose for reachability'),
            capabilityRow('Compose', capabilities.compose, 'detected, but Watcher does not launch or manage stacks', 'no Compose in this wslc; stacks are not supported')),
        el('p', { class: 'hint' }, 'Open runtime settings opens WSLc\'s YAML in your default editor. Watcher never resets or rewrites it. Changes may need the affected WSLc session restarted.'));
    sessionsHolder.replaceChildren(sessions?.trim()
        ? el('pre', { class: 'mg-json sd-code', tabIndex: 0, 'aria-label': 'Session list' }, sessions.trim())
        : el('p', { class: 'sd-empty' }, 'WSLc listed no sessions.'));
    const primitives = isObject(info) ? Object.entries(info).filter(([, v]) => v !== null && typeof v !== 'object') : [];
    infoHolder.replaceChildren(
        primitives.length ? facts(primitives.map(([k, v]) => [k, String(v)])) : el('p', { class: 'sd-empty' }, 'No system information was reported.'),
        info != null ? el('details', { class: 'mg-details' }, el('summary', {}, 'Raw info JSON'), jsonBlock(info, 'Raw system info JSON')) : null);
    eventsLoad.disabled = !capabilities.events;
    eventsNewer.disabled = !capabilities.events || timeline.length === 0;
    if (!capabilities.events) {
        status(eventsStatus, '', 'The installed wslc does not support events, so no timeline is read.');
    }
    status(runtimeStatus, runtimeError ? 'error' : '', runtimeError || `Read at ${clock(Date.now())}.`);
    renderTerminate();
}

async function openSettings() {
    status(runtimeStatus, 'busy', 'Opening WSLc settings…');
    try {
        const result = await manage('open-runtime-settings');
        status(runtimeStatus, 'ok', result?.message ?? 'Opened.');
    } catch (error) {
        status(runtimeStatus, 'error', `Could not open settings: ${errorText(error)}`);
    }
}

function renderTerminate() {
    const active = preferencesCache?.activeSession;
    const reported = runtimeCache?.session;
    const blocked = active === undefined
        ? 'Watcher could not read its active session, so it will not terminate anything.'
        : reported !== undefined && !sameSession(reported, active)
            ? `WSLc reports ${sessionLabel(reported)} but Watcher targets ${sessionLabel(active)}. Restart Watcher before terminating so the two agree.`
            : '';
    const action = button(`Terminate ${active === undefined ? 'session' : sessionLabel(active)}…`, () => terminate(active), 'danger', { disabled: Boolean(blocked) });
    terminateHolder.replaceChildren(
        el('p', {}, 'Stops the WSLc session Watcher monitors, and with it every container running in it. Other sessions are not touched.'),
        blocked ? el('p', { class: 'sd-note', dataset: { tone: 'warning' } }, blocked) : null,
        el('div', { class: 'mg-row-actions' }, action));
}

async function terminate(session) {
    const live = containers.filter(running);
    const ok = await confirmAction({
        title: `Terminate ${sessionLabel(session)}?`,
        message: `Session to terminate, exactly: "${session || 'default'}". Every workload in it stops now.`,
        items: live.length ? live.map((c) => `${c.title} · ${c.name} (running)`) : ['No containers are running in it right now.'],
        warning: 'Every running workload in the selected session is affected. Monitoring pauses until you choose Resume monitoring; resuming can start the session again.',
        action: 'Terminate session',
    });
    if (!ok) {
        return;
    }
    progressDialog({ title: `Terminating ${sessionLabel(session)}`, tone: 'pink', message: 'Sending terminate to the active session only.', run: (id) => manage('session-terminate', { session, confirmed: true }, id) });
}

function eventAt(row) {
    if (row.timeNano != null && Number(row.timeNano) > 0) {
        return Math.floor(Number(row.timeNano) / 1e6);
    }
    if (typeof row.time === 'number') {
        return row.time * 1000;
    }
    const parsed = Date.parse(row.time ?? row.Time ?? row.timestamp ?? '');

    return Number.isNaN(parsed) ? null : parsed;
}

function eventSummary(row) {
    const attributes = row.Actor?.Attributes ?? row.actor?.attributes ?? {};
    const type = row.Type ?? row.type ?? 'event';
    const action = row.Action ?? row.action ?? row.status ?? '';
    const who = attributes.name ?? shortId(row.Actor?.ID ?? row.id ?? '') ?? '';
    const exit = attributes.exitCode;
    const unhealthy = /unhealthy/.test(action);
    const tone = (action === 'die' && exit != null && String(exit) !== '0') || unhealthy || action === 'oom' ? 'pink'
        : /^(die|stop|kill)$/.test(action) ? 'amber'
            : /^(start|restart|health_status: healthy)$/.test(action) ? 'green' : 'neutral';

    return { type, action, who, exit, tone };
}

async function loadEvents(newer) {
    if (!runtimeCache?.capabilities?.events) {
        return;
    }
    const now = Date.now();
    const from = newer && timeline.length ? timeline.at(-1).to : now - Number(eventsSince.value) * 1000;
    if (!newer) {
        timeline = [];
    }
    const id = operationId();
    const cancel = cancelButton(id);
    eventsStatus.after(cancel);
    eventsLoad.disabled = eventsNewer.disabled = true;
    status(eventsStatus, 'busy', `Reading events since ${clock(from)}…`);
    try {
        const result = await manage('events', { since: String(Math.floor(from / 1000)) }, id);
        timeline.push({ from, to: now, entries: Array.isArray(result?.entries) ? result.entries : [] });
        status(eventsStatus, '', `Read up to ${clock(now)}.`);
    } catch (error) {
        timeline.push({ from, to: now, error: errorText(error) });
        status(eventsStatus, 'error', `Gap: events from ${clock(from)} to ${clock(now)} could not be read.`);
    } finally {
        cancel.remove();
        eventsLoad.disabled = false;
        eventsNewer.disabled = false;
    }
    renderEvents();
}

on('runtime-gap', ({ message }) => {
    if (timeline.length) {
        const at = Date.now();
        timeline.push({ from: at, to: at, error: `Background event capture failed: ${message ?? 'unknown error'}`, background: true });
        renderEvents();
    }
});

function renderEvents() {
    if (timeline.length === 0) {
        eventsList.replaceChildren(el('p', { class: 'sd-empty' }, runtimeCache?.capabilities?.events === false
            ? 'Events are not available in the installed wslc.'
            : 'Choose a range and press Load. Nothing is read until you ask.'));
        return;
    }
    const query = eventsFilter.value.trim().toLowerCase();
    const items = [];
    for (const window of timeline) {
        if (window.error) {
            items.push({ at: window.to, gap: window });
            continue;
        }
        const rows = window.entries.filter((row) => !query || JSON.stringify(row).toLowerCase().includes(query));
        rows.forEach((row) => items.push({ at: eventAt(row) ?? window.to, row }));
        if (window.entries.length === 0) {
            items.push({ at: window.to, quiet: window });
        }
    }
    items.sort((a, b) => b.at - a.at);
    eventsList.replaceChildren(...items.map((item) => {
        if (item.gap) {
            return el('div', { class: 'mg-event', dataset: { tone: 'danger' }, role: 'listitem' },
                el('span', { class: 'time sd-num' }, clock(item.at)), badge('gap', 'pink'),
                el('span', { class: 'mg-output sd-code' }, item.gap.background
                    ? item.gap.error
                    : `No data from ${day(item.gap.from)} ${clock(item.gap.from)} to ${clock(item.gap.to)}: ${item.gap.error}`));
        }
        if (item.quiet) {
            return el('div', { class: 'mg-event', role: 'listitem' },
                el('span', { class: 'time sd-num' }, clock(item.at)), badge('quiet'),
                el('span', { class: 'hint' }, `No events between ${clock(item.quiet.from)} and ${clock(item.quiet.to)}.`));
        }
        const summary = eventSummary(item.row);
        return el('details', { class: 'mg-event', dataset: { tone: toneOf(summary.tone) }, role: 'listitem' },
            el('summary', {},
                el('span', { class: 'time sd-num', title: `${day(item.at)} ${clock(item.at)}` }, clock(item.at)),
                badge(summary.type, summary.tone),
                el('span', { class: 'mg-check-name' }, summary.action),
                el('span', { class: 'sd-num' }, summary.who),
                summary.exit != null && String(summary.exit) !== '0' ? el('span', { class: 'mg-status sd-meta', dataset: { tone: 'danger' } }, `exit code ${summary.exit}`) : null),
            jsonBlock(item.row, 'Raw event JSON'));
    }));
    if (items.length === 0) {
        eventsList.replaceChildren(el('p', { class: 'sd-empty' }, 'No events match this filter.'));
    }
}

renderEvents();

// ---------- Preferences ----------

const preferencesPanel = addTab('preferences', 'Preferences', { shown: () => preferencesForm || loadPreferences() });
const preferencesStatus = statusLine();
const preferencesHolder = el('div', {}, el('p', { class: 'mg-status busy sd-meta', dataset: { tone: 'pending' } }, 'Reading preferences…'));
let preferencesForm = null;

append(preferencesPanel, [preferencesHolder, preferencesStatus]);

const alertFields = [
    { key: 'cpuHigh', label: 'CPU high', unit: '% of WSL', min: 1, max: 100, step: 'any' },
    { key: 'cpuRecovery', label: 'CPU recovered below', unit: '%', min: 0, max: 99, step: 'any' },
    { key: 'memoryHigh', label: 'Memory high', unit: '% of limit', min: 1, max: 100, step: 'any' },
    { key: 'memoryRecovery', label: 'Memory recovered below', unit: '%', min: 0, max: 99, step: 'any' },
    { key: 'samples', label: 'Sustained for', unit: 'samples', min: 1, max: 600, step: 1 },
    { key: 'cooldownSeconds', label: 'Cooldown', unit: 'seconds', min: 0, max: 86400, step: 1 },
];
const alertDefaults = { cpuHigh: 50, cpuRecovery: 25, memoryHigh: 90, memoryRecovery: 80, samples: 3, cooldownSeconds: 60, notifications: false, muted: false };

/** The same bounds the host enforces; '' when the rule is valid. */
function ruleProblem(rule) {
    const finite = alertFields.every((f) => Number.isFinite(rule[f.key]));
    if (!finite) {
        return 'Every alert field needs a number.';
    }
    if (rule.cpuHigh <= 0 || rule.cpuHigh > 100 || rule.memoryHigh <= 0 || rule.memoryHigh > 100) {
        return 'Thresholds must be above 0 and at most 100%.';
    }
    if (rule.cpuRecovery < 0 || rule.cpuRecovery >= rule.cpuHigh || rule.memoryRecovery < 0 || rule.memoryRecovery >= rule.memoryHigh) {
        return 'Each recovery level must be at least 0 and below its threshold.';
    }
    if (!Number.isInteger(rule.samples) || rule.samples < 1 || rule.samples > 600) {
        return 'Samples must be a whole number from 1 to 600.';
    }
    if (!Number.isInteger(rule.cooldownSeconds) || rule.cooldownSeconds < 0 || rule.cooldownSeconds > 86400) {
        return 'Cooldown must be a whole number of seconds from 0 to 86400.';
    }

    return '';
}

function alertEditor(rule, label) {
    const values = { ...alertDefaults, ...(rule ?? {}) };
    const inputs = {};
    const grid = el('div', { class: 'mg-form' }, alertFields.map((f) => {
        inputs[f.key] = el('input', { type: 'number', class: 'mg-narrow', min: f.min, max: f.max, step: f.step, value: String(values[f.key]) });
        return field(f.label, inputs[f.key], f.unit);
    }));
    inputs.notifications = el('input', { type: 'checkbox', checked: Boolean(values.notifications) });
    inputs.muted = el('input', { type: 'checkbox', checked: Boolean(values.muted) });
    const problem = el('p', { class: 'mg-status sd-meta', dataset: { tone: 'danger' }, role: 'alert', hidden: true });

    return {
        node: el('fieldset', { class: 'mg-fieldset' }, el('legend', { class: 'label' }, label), grid,
            el('div', { class: 'mg-row-actions' },
                el('label', { class: 'mg-inline' }, inputs.notifications, 'Show Windows notifications'),
                el('label', { class: 'mg-inline' }, inputs.muted, 'Mute (keep recording, no notifications)')),
            problem),
        read() {
            const next = Object.fromEntries(alertFields.map((f) => [f.key, inputs[f.key].value.trim() === '' ? NaN : Number(inputs[f.key].value)]));
            next.notifications = inputs.notifications.checked;
            next.muted = inputs.muted.checked;
            const message = ruleProblem(next);
            status(problem, message ? 'error' : '', message);
            return message ? null : next;
        },
    };
}

async function loadPreferences() {
    preferencesForm = null;
    status(preferencesStatus, '', '');
    preferencesHolder.replaceChildren(el('p', { class: 'mg-status busy sd-meta', dataset: { tone: 'pending' } }, 'Reading preferences…'));
    try {
        const prefs = await manage('preferences');
        preferencesCache = prefs;
        renderPreferences(prefs);
    } catch (error) {
        preferencesHolder.replaceChildren(el('p', { class: 'mg-status sd-meta', dataset: { tone: 'danger' } }, `Could not read preferences: ${errorText(error)}`),
            button('Try again', () => loadPreferences()));
    }
}

function renderPreferences(prefs) {
    const session = el('input', { type: 'text', class: 'mg-grow', value: prefs.session ?? '', placeholder: 'default session', spellcheck: false, autocomplete: 'off' });
    const keepRunning = el('input', { type: 'checkbox', checked: Boolean(prefs.keepRunning) });
    const startAtLogin = el('input', { type: 'checkbox', checked: Boolean(prefs.startAtLogin) });
    const general = alertEditor(prefs.alerts, 'Default alert rule');
    const overrides = new Map();
    const overrideHolder = el('div', {});
    const overridePick = el('select', { class: 'mg-grow', 'aria-label': 'Container to override' });

    const fillPick = () => {
        const names = [...new Set(containers.map((c) => c.name))].filter((name) => !overrides.has(name)).sort();
        const signature = names.join('\u0000');
        if (overridePick.dataset.names === signature && overridePick.options.length) {
            return;
        }
        const chosen = overridePick.value;
        overridePick.dataset.names = signature;
        overridePick.replaceChildren(new Option(names.length ? 'Choose a container' : 'Every listed container has an override', ''), ...names.map((name) => new Option(titleOf(name) === name ? name : `${titleOf(name)} (${name})`, name)));
        overridePick.value = names.includes(chosen) ? chosen : '';
    };
    const addOverride = (name, rule) => {
        const editor = alertEditor(rule ?? general.read() ?? alertDefaults, `Override for ${titleOf(name)}`);
        const remove = button('Remove override', () => {
            overrides.delete(name);
            box.remove();
            fillPick();
        }, 'secondary', { 'aria-label': `Remove the alert override for ${name}` });
        const box = el('div', { class: 'mg-override' }, editor.node, el('div', { class: 'mg-row-actions' },
            containerByName(name) ? null : el('span', { class: 'hint' }, 'Not in the current snapshot.'), remove));
        overrides.set(name, editor);
        overrideHolder.append(box);
        fillPick();
    };
    Object.entries(prefs.containerAlerts ?? {}).forEach(([name, rule]) => addOverride(name, rule));
    fillPick();

    const save = button('Save preferences', () => submit(), 'primary');
    const submit = async () => {
        const alerts = general.read();
        const containerAlerts = {};
        let invalid = !alerts;
        for (const [name, editor] of overrides) {
            const rule = editor.read();
            invalid ||= !rule;
            containerAlerts[name] = rule;
        }
        const name = session.value.trim();
        if (name.length > 200 || /[\u0000-\u001f]/.test(name)) {
            status(preferencesStatus, 'error', 'Session names are at most 200 characters with no control characters.');
            session.focus();
            return;
        }
        if (invalid) {
            status(preferencesStatus, 'error', 'Fix the highlighted alert rules before saving.');
            return;
        }
        status(preferencesStatus, 'busy', 'Saving…');
        try {
            const result = await busyWhile(save, 'Saving…', () => manage('save-preferences', {
                session: name, keepRunning: keepRunning.checked, startAtLogin: startAtLogin.checked, alerts, containerAlerts,
            }));
            status(preferencesStatus, result?.restartRequired ? 'busy' : 'ok', result?.message ?? 'Saved.');
            preferencesCache = { ...prefs, session: name, keepRunning: keepRunning.checked, startAtLogin: startAtLogin.checked, alerts, containerAlerts };
        } catch (error) {
            status(preferencesStatus, 'error', `Not saved: ${errorText(error)}`);
        }
    };

    preferencesForm = { fillPick };
    preferencesHolder.replaceChildren(
        el('section', { class: 'sd-card', dataset: { tone: 'accent' } },
            el('div', { class: 'sd-card-head' }, el('h2', {}, 'Session')),
            el('div', { class: 'sd-card-body' },
                el('div', { class: 'mg-form' }, field('WSLc session', session, 'empty uses the default session')),
                facts([['Active now', el('span', { class: 'sd-num' }, sessionLabel(prefs.activeSession))]]),
                el('p', { class: 'hint' }, 'Changing the session takes effect after Watcher restarts, so samples from two sessions never mix.'))),
        el('section', { class: 'sd-card' },
            el('div', { class: 'sd-card-head' }, el('h2', {}, 'Background')),
            el('div', { class: 'sd-card-body' },
                el('div', { class: 'mg-checks-stack' },
                    el('label', { class: 'mg-inline' }, keepRunning, 'Keep monitoring in the tray when the window is closed'),
                    el('label', { class: 'mg-inline' }, startAtLogin, 'Start Watcher when I sign in to Windows')),
                el('p', { class: 'hint' }, 'Both are off unless you turn them on.'))),
        el('section', { class: 'sd-card', dataset: { tone: 'pending' } },
            el('div', { class: 'sd-card-head' }, el('h2', {}, 'Alerts')),
            el('div', { class: 'sd-card-body' },
                general.node,
                el('div', { class: 'label mg-sub' }, 'Per-container overrides'),
                el('p', { class: 'hint' }, 'An override replaces the default rule for one container.'),
                overrideHolder,
                el('div', { class: 'mg-row-actions' }, overridePick, button('Add override', () => overridePick.value && addOverride(overridePick.value))))),
        el('div', { class: 'mg-row-actions' }, save, button('Discard changes', () => loadPreferences())));
}

snapshotListeners.add(() => preferencesForm && !managePage.hidden && currentTab === 'preferences' && document.activeElement?.tagName !== 'SELECT' && preferencesForm.fillPick());

// ---------- Logs ----------

const maxLines = 5000;
const followMs = 2500;
const timestamp = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))\s?([\s\S]*)$/;

const picked = new Set();
const pickerItems = new Map();
let lines = [];
let lineKeys = new Set();
let lineSeq = 0;
let latestMs = 0;
let droppedOld = false;
let cutByHost = false;
let following = false;
let paused = false;
let followTimer = null;
let logsBusy = false;
let logsTicket = 0;
let logsOperation = null;
let openOnShow = false;

const followState = el('div', { class: 'live mg-follow-state', role: 'status', 'aria-live': 'polite' }, el('span', { class: 'pulse' }), el('span', {}, 'Not following'));
const logsPage = page('logs', 'Logs',
    'Combined, timestamped logs from the containers you pick. Each read is a bounded snapshot; Follow polls only while this page is open.',
    followState);
const picker = el('div', { class: 'mg-picker', role: 'group', 'aria-label': 'Containers to read logs from' });
const pickerEmpty = el('p', { class: 'sd-empty' }, 'Waiting for the first snapshot from the monitor…');
const tail = el('input', { type: 'number', class: 'mg-narrow', min: 1, max: maxLines, step: 1, value: '200' });
const since = el('input', { type: 'datetime-local', step: 1 });
const until = el('input', { type: 'datetime-local', step: 1 });
const logSearch = el('input', { type: 'search', class: 'mg-search', placeholder: 'Search lines', spellcheck: false, 'aria-label': 'Search log lines' });
const fetchButton = button('Fetch', () => startLogs(false), 'primary');
const followButton = button('Follow', () => (following ? stopFollowing() : startLogs(true)), 'secondary', { 'aria-pressed': 'false' });
const pauseButton = button('Pause', () => setPaused(!paused), 'secondary', { 'aria-pressed': 'false', disabled: true });
const logsCancel = button('Cancel', () => logsOperation && cancelOperation(logsOperation), 'secondary', { hidden: true, 'aria-label': 'Cancel the running log read' });
const logsStatus = statusLine();
const logsSummary = el('p', { class: 'hint mg-log-summary', role: 'status', 'aria-live': 'polite' });
const logView = el('div', { class: 'mg-log sd-code', role: 'log', 'aria-label': 'Combined log lines', tabIndex: 0 });

append(logsPage, [
    el('div', { class: 'toolbar mg-toolbar' },
        el('span', { class: 'label' }, 'Containers'),
        button('Running', () => pickWhere(running)),
        button('All', () => pickWhere(() => true)),
        button('None', () => pickWhere(() => false))),
    picker,
    pickerEmpty,
    el('div', { class: 'toolbar mg-toolbar' },
        field('Tail', tail, 'lines each'),
        field('Since', since, 'local time, optional'),
        field('Until', until, 'ignored while following'),
        el('div', { class: 'mg-row-actions mg-bottom' }, fetchButton, followButton, pauseButton, logsCancel)),
    el('div', { class: 'toolbar mg-toolbar' },
        logSearch,
        el('span', { class: 'spacer' }),
        button('Clear', () => clearLogs()),
        button('Copy', () => exportLogs(false)),
        button('Download .log', () => exportLogs(true))),
    logsStatus,
    logsSummary,
    logView,
]);
logSearch.addEventListener('input', () => renderLogs(true));

function renderPicker() {
    const names = new Set(containers.map((c) => c.name));
    const wanted = [...[...containers].sort((a, b) => a.title.localeCompare(b.title)).map((c) => c.name), ...[...picked].filter((name) => !names.has(name))];
    for (const [name, item] of pickerItems) {
        if (!wanted.includes(name)) {
            item.remove();
            pickerItems.delete(name);
        }
    }
    wanted.forEach((name, index) => {
        if (!pickerItems.has(name)) {
            const box = el('input', { type: 'checkbox' });
            box.addEventListener('change', () => {
                box.checked ? picked.add(name) : picked.delete(name);
                renderPicker();
            });
            pickerItems.set(name, el('label', { class: 'mg-pick sd-chip' }, box, el('span', { class: 'marker sd-dot' }), el('span', { class: 'name' })));
        }
        const item = pickerItems.get(name);
        const c = containerByName(name);
        item.querySelector('input').checked = picked.has(name);
        item.setAttribute('aria-pressed', String(picked.has(name)));
        if (c && running(c)) {
            item.dataset.tone = 'success';
        } else {
            delete item.dataset.tone;
        }
        item.title = c ? `${name} · ${c.state}` : `${name} · not in the current snapshot`;
        setText(item.querySelector('.name'), c ? c.title : `${name} (not listed)`);
        if (picker.children[index] !== item) {
            picker.insertBefore(item, picker.children[index] ?? null);
        }
    });
    pickerEmpty.hidden = wanted.length > 0;
    pickerEmpty.textContent = snapshotSeen ? 'No containers in this session.' : 'Waiting for the first snapshot from the monitor…';
    fetchButton.disabled = followButton.disabled = picked.size === 0 && !following;
}

function pickWhere(test) {
    picked.clear();
    containers.filter(test).forEach((c) => picked.add(c.name));
    renderPicker();
}

snapshotListeners.add(() => !logsPage.hidden && renderPicker());

/** RFC 3339 seconds for a datetime-local value, or '' when empty. */
function rfc3339(input) {
    if (!input.value) {
        return '';
    }
    const at = new Date(input.value);

    return Number.isNaN(at.getTime()) ? null : at.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function parseLine(container, raw) {
    const match = timestamp.exec(raw);
    const stampText = match?.[1] ?? '';
    const ms = stampText ? Date.parse(stampText.replace(/(\.\d{3})\d+/, '$1')) : NaN;

    return { container, raw, stamp: stampText, message: match ? match[2] : raw, ms: Number.isNaN(ms) ? null : ms, seq: ++lineSeq };
}

/** Adds new lines once each, keeps them in time order and the buffer bounded. Returns how many were new. */
function mergeLines(entries) {
    let added = 0;
    for (const entry of entries) {
        const container = String(entry?.container ?? '');
        const raw = String(entry?.text ?? '');
        const key = `${container}\u0000${raw}`;
        if (lineKeys.has(key)) {
            continue;
        }
        lineKeys.add(key);
        const line = parseLine(container, raw);
        // An untimed line sorts with the latest line before it from the same container.
        line.ms ??= lines.findLast((other) => other.container === container)?.ms ?? latestMs;
        latestMs = Math.max(latestMs, line.ms ?? 0);
        lines.push(line);
        added++;
    }
    if (added) {
        lines.sort((a, b) => (a.ms ?? 0) - (b.ms ?? 0) || a.stamp.localeCompare(b.stamp) || a.seq - b.seq);
        if (lines.length > maxLines) {
            lines = lines.slice(lines.length - maxLines);
            lineKeys = new Set(lines.map((line) => `${line.container}\u0000${line.raw}`));
            droppedOld = true;
        }
    }

    return added;
}

function clearLogs() {
    logsTicket++;
    if (logsOperation) cancelOperation(logsOperation);
    logsOperation = null;
    logsBusy = false;
    logsCancel.hidden = true;
    fetchButton.disabled = picked.size === 0;
    lines = [];
    lineKeys = new Set();
    latestMs = 0;
    droppedOld = cutByHost = false;
    renderLogs(true);
    status(logsStatus, '', '');
    scheduleFollow();
}

function shownLines() {
    const query = logSearch.value.trim().toLowerCase();

    return query ? lines.filter((line) => `${line.container} ${line.raw}`.toLowerCase().includes(query)) : lines;
}

function renderLogs(force = false) {
    const nearBottom = logView.scrollHeight - logView.scrollTop - logView.clientHeight < 40;
    const shown = shownLines();
    const order = [...picked];
    if (shown.length === 0) {
        logView.replaceChildren(el('p', { class: 'sd-empty mg-log-empty' }, lines.length
            ? 'No line matches this search.'
            : picked.size ? 'No lines yet. Fetch reads a snapshot; Follow keeps reading while this page is open.' : 'Pick one or more containers, then Fetch or Follow.'));
    } else {
        const fragment = document.createDocumentFragment();
        for (const line of shown) {
            const index = order.indexOf(line.container);
            fragment.append(el('div', { class: 'mg-line' },
                el('span', { class: 'time', title: line.stamp || 'no timestamp' }, line.stamp ? `${day(line.ms)} ${clock(line.ms)}` : '—'),
                el('span', { class: `who mg-c${index < 0 ? 0 : index % 6}`, title: line.container }, titleOf(line.container)),
                el('span', { class: 'msg' }, line.message)));
        }
        logView.replaceChildren(fragment);
    }
    if (nearBottom || force) {
        logView.scrollTop = logView.scrollHeight;
    }
    const notes = [
        logSearch.value.trim() ? `${shown.length} of ${plural(lines.length, 'line')} match` : plural(lines.length, 'line'),
        droppedOld ? `oldest lines dropped to stay within ${maxLines}` : '',
        cutByHost ? 'a read hit WSLc\'s limit, so some lines in that range are missing' : '',
    ].filter(Boolean);
    logsSummary.textContent = notes.join(' · ');
    logsSummary.classList.toggle('mg-warn-text', droppedOld || cutByHost);
}

/** One bounded read. A follow read asks only for what came after the newest line already shown. */
async function readLogs(follow, ignoreUntil = false) {
    const names = [...picked];
    if (names.length === 0) {
        status(logsStatus, 'error', 'Pick at least one container.');
        return false;
    }
    const count = Number(tail.value);
    if (!Number.isInteger(count) || count < 1 || count > maxLines) {
        status(logsStatus, 'error', `Tail must be a whole number from 1 to ${maxLines}.`);
        tail.focus();
        return false;
    }
    const [from, to] = [rfc3339(since), following || ignoreUntil ? '' : rfc3339(until)];
    if (from === null || to === null) {
        status(logsStatus, 'error', 'Since and Until must be valid dates.');
        return false;
    }
    if (from && to && from >= to) {
        status(logsStatus, 'error', 'Since must be earlier than Until.');
        return false;
    }
    const parameters = follow && latestMs
        ? { names, tail: maxLines, since: String(Math.floor(latestMs / 1000) - 1), until: '' }
        : { names, tail: count, since: from, until: to };
    const mine = ++logsTicket;
    const id = operationId();
    logsBusy = true;
    logsOperation = id;
    logsCancel.hidden = false;
    fetchButton.disabled = true;
    if (!follow) {
        status(logsStatus, 'busy', `Reading ${plural(names.length, 'container')}…`);
    }
    try {
        const result = await manage('logs', parameters, id);
        if (mine !== logsTicket) {
            return true;
        }
        const added = mergeLines(Array.isArray(result?.entries) ? result.entries : []);
        cutByHost ||= Boolean(result?.truncated);
        if (!latestMs && follow) {
            latestMs = Date.now() - 5000;
        }
        if (added || !follow) {
            renderLogs(!follow);
        }
        status(logsStatus, '', follow ? '' : `Read at ${clock(Date.now())}.`);
        return true;
    } catch (error) {
        if (mine === logsTicket) {
            status(logsStatus, 'error', `${follow ? 'Follow read failed; lines from this interval may be missing' : 'Could not read logs'}: ${errorText(error)}`);
        }
        return false;
    } finally {
        if (mine === logsTicket) {
            logsBusy = false;
            logsOperation = null;
            logsCancel.hidden = true;
            fetchButton.disabled = picked.size === 0;
        }
    }
}

function syncFollow() {
    followButton.textContent = following ? 'Stop following' : 'Follow';
    followButton.setAttribute('aria-pressed', String(following));
    pauseButton.disabled = !following;
    pauseButton.textContent = paused ? 'Resume' : 'Pause';
    pauseButton.setAttribute('aria-pressed', String(paused));
    until.disabled = following;
    if (!following || paused) {
        followState.dataset.tone = 'pending';
    } else {
        delete followState.dataset.tone;
    }
    followState.lastElementChild.textContent = !following ? 'Not following' : paused ? 'Paused' : 'Following';
}

function scheduleFollow() {
    clearTimeout(followTimer);
    followTimer = null;
    if (following && !paused && visible(logsPage)) {
        followTimer = setTimeout(pollFollow, followMs);
    }
}

async function pollFollow() {
    followTimer = null;
    if (!following || paused || !visible(logsPage) || logsBusy) {
        return;
    }
    await readLogs(true);
    scheduleFollow();
}

async function startLogs(follow) {
    clearTimeout(followTimer);
    following = false;
    paused = false;
    syncFollow();
    clearLogs();
    const ok = await readLogs(false, follow);
    if (ok && follow) {
        following = true;
        if (!latestMs) {
            latestMs = Date.now() - 5000;
        }
        syncFollow();
        scheduleFollow();
    }
}

function stopFollowing() {
    following = false;
    paused = false;
    clearTimeout(followTimer);
    followTimer = null;
    syncFollow();
    renderPicker();
}

function setPaused(value) {
    paused = value;
    syncFollow();
    scheduleFollow();
}

async function exportLogs(download) {
    const shown = shownLines();
    if (shown.length === 0) {
        status(logsStatus, 'error', 'There are no lines to export.');
        return;
    }
    const body = `${shown.map((line) => `${line.stamp || '-'}\t${line.container}\t${line.message}`).join('\n')}\n`;
    try {
        if (download) {
            const url = URL.createObjectURL(new Blob([body], { type: 'text/plain;charset=utf-8' }));
            const link = el('a', { href: url, download: `watcher-logs-${stamp()}.log`, hidden: true });
            document.body.append(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 10_000);
            status(logsStatus, 'ok', `Downloaded ${plural(shown.length, 'line')}.`);
        } else {
            await navigator.clipboard.writeText(body);
            status(logsStatus, 'ok', `Copied ${plural(shown.length, 'line')} to the clipboard.`);
        }
    } catch (error) {
        status(logsStatus, 'error', `Export failed: ${errorText(error)}`);
    }
}

document.addEventListener('visibilitychange', () => (document.hidden ? clearTimeout(followTimer) : scheduleFollow()));

/** Opens the Logs page following one container, wherever it was asked from. */
function openLogsFor(name, range = {}) {
    stopFollowing();
    const localInput = (iso) => {
        const date = new Date(iso);
        return Number.isNaN(date.getTime()) ? '' : new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
    };
    since.value = range.since ? localInput(range.since) : '';
    until.value = range.until ? localInput(range.until) : '';
    picked.clear();
    picked.add(name);
    if (logsPage.hidden) {
        openOnShow = range.until ? 'range' : 'follow';
        location.hash = '#logs';
    } else {
        renderPicker();
        startLogs(!range.until);
    }
}

syncFollow();
renderLogs();

// ---------- Registration and row hooks ----------

registerPage('manage', {
    title: 'Manage',
    shown: () => selectTab(currentTab),
    hidden: () => tabs.get(currentTab)?.hidden(),
});

registerPage('logs', {
    title: 'Logs',
    shown: () => {
        renderPicker();
        renderLogs(true);
        if (openOnShow) {
            const follow = openOnShow === 'follow';
            openOnShow = false;
            startLogs(follow);
        } else {
            scheduleFollow();
        }
    },
    hidden: () => {
        clearTimeout(followTimer);
        followTimer = null;
    },
});

selectTab(currentTab);

const named = (handler) => (event) => {
    const name = event.detail?.name;
    if (typeof name === 'string' && name.trim() && !name.startsWith('-')) {
        handler(name, event.detail);
    }
};

window.addEventListener('watcher:inspect', named((name, detail) => detail?.tab === 'terminal' ? openTerminal(name) : openInspect(name)));
window.addEventListener('watcher:logs', named(openLogsFor));
window.addEventListener('watcher:files', named((name) => openFiles(name)));
