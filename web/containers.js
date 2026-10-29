import { $, ago, bytes, clock, day, on, percent, post, registerPage, request, share, size, whose } from './app.js';
import { setExpanded } from './vendor/signal/js/index.js';

const rows = new Map();
const groups = new Map();
const busy = new Set();
const expanded = new Set(JSON.parse(localStorage.getItem('expanded') ?? '[]'));
let containers = [];
let capacity = null;
let panelSeq = 0;

// ---------- Sorting ----------

const running = (c) => c.state === 'running';
const states = ['running', 'created', 'exited'];

/** dir is the first click's direction; a null value sorts last both ways. Uptime runs from created, so older is longer. */
const sorts = {
    created: { dir: -1, value: (c) => c.created ?? null },
    name: { dir: 1, value: (c) => c.title.toLowerCase() },
    port: { dir: 1, value: (c) => parseInt(c.port, 10) || null },
    cpu: { dir: -1, value: (c) => (running(c) ? c.cpu ?? null : null) },
    memory: { dir: -1, value: (c) => (running(c) ? c.memoryBytes ?? null : null) },
    uptime: { dir: -1, value: (c) => (running(c) && c.created ? -c.created : null) },
    state: { dir: 1, value: (c) => (states.includes(c.state) ? states.indexOf(c.state) : states.length) * 2 + (c.orphan ? 1 : 0) },
};

const saved = JSON.parse(localStorage.getItem('containers-sort') ?? 'null');
let sort = sorts[saved?.key] && Math.abs(saved.dir) === 1 ? saved : { key: 'created', dir: -1 };

function compare(a, b) {
    const [x, y] = [sorts[sort.key].value(a), sorts[sort.key].value(b)];
    if (x !== y && (x === null || y === null)) {
        return x === null ? 1 : -1;
    }
    if (x !== y) {
        return (x < y ? -1 : 1) * sort.dir;
    }

    return (b.created ?? 0) - (a.created ?? 0) || a.title.localeCompare(b.title);
}

function sortBy(key) {
    sort = sort.key === key ? { key, dir: -sort.dir } : { key, dir: sorts[key].dir };
    localStorage.setItem('containers-sort', JSON.stringify(sort));
    layout();
}

// ---------- Sections ----------

/** The group label as typed, else the folder's parent folder name, so sibling folders share a section. */
function sectionOf(c) {
    if (c.group) {
        return c.group;
    }
    const parts = (c.path ?? '').split(/[\\/]+/).filter(Boolean);

    return parts.length >= 2 ? parts.at(-2) : 'Other';
}

const bySectionName = (a, b) => (a === 'Other') - (b === 'Other') || a.localeCompare(b, undefined, { sensitivity: 'base' });

function groupElement(name) {
    if (!groups.has(name)) {
        const element = $('group-template').content.firstElementChild.cloneNode(true);
        element.querySelector('.group-name').textContent = name;
        element.querySelector('[role="region"]').setAttribute('aria-label', `${name} containers`);
        element.querySelectorAll('th[data-sort]').forEach((header) => {
            header.addEventListener('click', () => sortBy(header.dataset.sort));
            header.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    sortBy(header.dataset.sort);
                }
            });
        });
        groups.set(name, element);
    }

    return groups.get(name);
}

// ---------- Formatting ----------

const cpuTone = (cpu) => (cpu >= 50 ? 'danger' : cpu >= 25 ? 'pending' : 'success');
const memoryTone = (memory) => (memory >= 90 ? 'danger' : memory >= 75 ? 'pending' : 'success');

function tone(container) {
    if (container.orphan) {
        return 'pending';
    }

    return running(container) ? 'success' : 'neutral';
}

function setTone(element, value) {
    if (value) {
        element.dataset.tone = value;
    } else {
        delete element.dataset.tone;
    }
}

// Seconds between snapshots, smoothed, so the chart can say how much time it covers.
let interval = 2.3;
let lastSnapshot = 0;

function duration(samples) {
    const seconds = samples * interval;

    return seconds < 90 ? `last ${Math.round(seconds)} s` : `last ${Math.round(seconds / 60)} min`;
}

// A round chart ceiling so the scale label reads cleanly: 5, 10, 25, 50, 100, 200 …
function ceilingFor(peak) {
    const steps = [1, 2, 5, 10, 25, 50, 100];

    return steps.find((step) => step >= peak * 1.15) ?? 100;
}

// Right-aligned history, stretched across at least a dozen slots so a new container doesn't draw one wide wedge.
function spark(chart, history, ceiling, scale) {
    const line = chart.querySelector('.line');
    const area = chart.querySelector('.area');
    // Only the plot in the opened details has a scale and a span; the one in the row is the line alone.
    const label = (selector, value) => {
        const node = chart.querySelector(selector);
        if (node) {
            node.textContent = value;
        }
    };
    if (!history || history.length < 2) {
        line.setAttribute('points', '');
        area.setAttribute('points', '');
        label('.scale', '');
        label('.span', '');
        return;
    }
    const slots = Math.max(history.length, 12);
    const offset = slots - history.length;
    const points = history.map((value, index) => {
        const x = ((offset + index) / (slots - 1)) * 100;
        const y = 100 - Math.min(1, value / ceiling) * 100;
        return `${x.toFixed(2)},${y.toFixed(2)}`;
    });
    const first = ((offset / (slots - 1)) * 100).toFixed(2);
    line.setAttribute('points', points.join(' '));
    area.setAttribute('points', `${first},100 ${points.join(' ')} 100,100`);
    label('.scale', scale);
    label('.span', duration(history.length));
}

// ---------- Rows ----------

function createRow(name) {
    const row = $('row-template').content.firstElementChild.cloneNode(true);
    const panel = row.querySelector('.sd-expand');
    const toggle = row.querySelector('.toggle');
    panel.id = `detail-${++panelSeq}`;
    toggle.dataset.sdToggle = panel.id;
    toggle.setAttribute('aria-controls', panel.id);
    row.dataset.name = name;
    // Signal opens a row from its button; a click anywhere else on the row's line does the same.
    row.querySelector('.summary').addEventListener('click', (event) => {
        if (!event.target.closest('button')) {
            setExpanded(panel);
        }
    });
    row.querySelectorAll('[data-op]').forEach((button) =>
        button.addEventListener('click', () => act(name, button.dataset.op)));
    rows.set(name, row);

    return row;
}

const panelOf = (row) => row.querySelector('.sd-expand');

/** Signal owns whether a row is open (data-open, aria-expanded); this only reads it back to remember it. */
function rememberExpanded() {
    for (const [name, row] of rows) {
        panelOf(row).hasAttribute('data-open') ? expanded.add(name) : expanded.delete(name);
    }
    localStorage.setItem('expanded', JSON.stringify([...expanded]));
    updateExpandAll();
}

new MutationObserver(rememberExpanded).observe($('groups'), { subtree: true, attributes: true, attributeFilter: ['data-open'] });

function updateExpandAll() {
    const allOpen = containers.length > 0 && containers.every((c) => expanded.has(c.name));
    $('expand-all').textContent = allOpen ? 'Collapse all' : 'Expand all';
    $('expand-all').hidden = containers.length === 0;
}

$('expand-all').addEventListener('click', () => {
    const open = !containers.every((c) => expanded.has(c.name));
    containers.forEach((c) => rows.has(c.name) && setExpanded(panelOf(rows.get(c.name)), open));
});

function text(row, selector, value) {
    const element = row.querySelector(selector);
    if (element.textContent !== value) {
        element.textContent = value;
    }
}

function setBusy(row, on) {
    row.classList.toggle('busy', on);
    row.querySelector('.action-list').toggleAttribute('aria-busy', on);
}

function render(row, c) {
    const live = running(c);
    setTone(row, tone(c));
    setBusy(row, busy.has(c.name));

    text(row, '.name', c.title);
    row.querySelector('.name').title = c.name;
    row.querySelector('.toggle').setAttribute('aria-label', `Details of ${c.title}`);
    const remove = row.querySelector('[data-op="remove"]');
    remove.setAttribute('aria-label', `Remove ${c.title} and its data`);
    remove.title = `Remove ${c.title} and its data`;
    row.querySelector('.action-list').setAttribute('aria-label', `${c.title} actions`);
    text(row, '.branch', c.orphan ? 'folder deleted' : c.branch ?? c.image);
    text(row, '.port', c.port || '—');
    text(row, '[data-f="port"]', c.port || '—');
    text(row, '.uptime', live ? c.uptime : '—');
    text(row, '[data-f="uptime"]', live ? c.uptime : '—');
    text(row, '.badge', c.orphan ? 'folder deleted' : c.state);
    row.querySelector('.badge').dataset.tone = tone(c);

    // Each metric has a cell in the row, with the value and a line, and a plot in the opened details.
    const [cpuCell, cpuPlot] = row.querySelectorAll('.metric.cpu');
    const [memoryCell, memoryPlot] = row.querySelectorAll('.metric.mem');
    if (live && c.cpu !== undefined) {
        const cpuShare = share(c.cpu, capacity.wsl.cpus);
        const cpuHistory = c.cpuHistory.map((cores) => share(cores, capacity.wsl.cpus));
        const cpuCeiling = ceilingFor(Math.max(...cpuHistory));
        const limit = c.memoryLimitBytes ? bytes(c.memoryLimitBytes).replace('.0 ', ' ') : '';
        text(cpuCell, '.value', percent(cpuShare));
        text(memoryCell, '.value', bytes(c.memoryBytes));
        text(memoryPlot, '.limit', limit ? `of ${limit}` : '');
        for (const cell of [cpuCell, cpuPlot]) {
            setTone(cell, cpuTone(cpuShare));
            spark(cell.querySelector('.chart'), cpuHistory, cpuCeiling, `${cpuCeiling}%`);
        }
        for (const cell of [memoryCell, memoryPlot]) {
            setTone(cell, memoryTone(c.memoryPercent));
            spark(cell.querySelector('.chart'), c.memoryHistory, 100, limit);
        }
    } else {
        text(cpuCell, '.value', '—');
        text(memoryCell, '.value', '—');
        text(memoryPlot, '.limit', '');
        for (const cell of [cpuCell, cpuPlot, memoryCell, memoryPlot]) {
            setTone(cell, null);
            spark(cell.querySelector('.chart'), null);
        }
    }

    // A phone has no room for these columns, so the opened details repeat them.
    text(row, '[data-f="state"]', c.orphan ? 'folder deleted' : c.state);
    text(row, '[data-f="cpu"]', cpuCell.querySelector('.value').textContent);
    text(row, '[data-f="memory"]', memoryCell.querySelector('.value').textContent);

    const facts = (field, value) => {
        const element = row.querySelector(`[data-f="${field}"]`);
        if (element.innerHTML !== value) {
            element.innerHTML = value;
        }
    };
    const dim = (value) => `<span class="dim">${value}</span>`;
    facts('net', live && c.netIn !== undefined ? `${dim('↓')}${bytes(c.netIn)}${dim('↑')}${bytes(c.netOut)}` : '—');
    facts('disk', live && c.diskRead !== undefined ? `${dim('R')}${bytes(c.diskRead)}${dim('W')}${bytes(c.diskWrite)}` : '—');
    facts('pids', live && c.pids ? c.pids : '—');
    text(row, '[data-f="created"]', c.created ? `${ago(c.created)} · ${day(c.created)} ${clock(c.created)}` : '—');
    text(row, '[data-f="image"]', c.image);
    text(row, '[data-f="path"]', c.path ?? '—');
    row.querySelector('[data-f="path"]').title = c.path ?? '';
    row.querySelector('.orphan-key').hidden = row.querySelector('.orphan-note').hidden = !c.orphan;

    text(row, '[data-op="toggle"]', live ? 'Stop' : 'Start');
    row.querySelector('[data-op="restart"]').disabled = !live;
    row.querySelector('[data-op="logs"]').disabled = false;
    row.querySelector('[data-op="folder"]').disabled = !c.hasPath || c.orphan;
}

// Keep each row element alive across refreshes, re-sorts and section moves so transitions and hover state survive.
function sync(holder, items) {
    const wanted = items.map((c) => {
        const row = rows.get(c.name) ?? createRow(c.name);
        render(row, c);
        return row;
    });
    wanted.forEach((row, index) => {
        if (holder.tBodies[index] !== row) {
            holder.insertBefore(row, holder.tBodies[index] ?? null);
        }
        // A saved row opens once it is in the page, because Signal updates the toggles it finds there.
        if (!row.dataset.restored) {
            row.dataset.restored = 'true';
            if (expanded.has(row.dataset.name)) {
                setExpanded(panelOf(row), true);
            }
        }
    });
    while (holder.tBodies.length > wanted.length) {
        holder.tBodies[holder.tBodies.length - 1].remove();
    }
}

/** One section per group, in name order with Other last; a lone section needs no header of its own. */
function layout() {
    const sections = new Map();
    for (const c of [...containers].sort(compare)) {
        const name = sectionOf(c);
        sections.set(name, [...(sections.get(name) ?? []), c]);
    }
    const names = [...sections.keys()].sort(bySectionName);
    const holder = $('groups');
    names.forEach((name, index) => {
        const element = groupElement(name);
        if (holder.children[index] !== element) {
            holder.insertBefore(element, holder.children[index] ?? null);
        }
        element.querySelector('.section-head').hidden = names.length === 1;
        element.querySelector('.count').textContent = sections.get(name).length;
        sync(element.querySelector('table'), sections.get(name));
    });
    for (const [name, element] of groups) {
        if (!sections.has(name)) {
            element.remove();
            groups.delete(name);
        }
    }
    holder.querySelectorAll('th[data-sort]').forEach((header) => {
        if (header.dataset.sort === sort.key) {
            header.setAttribute('aria-sort', sort.dir > 0 ? 'ascending' : 'descending');
        } else {
            header.removeAttribute('aria-sort');
        }
    });
    $('containers-empty').hidden = containers.length > 0;
}

function snapshot(message) {
    const now = performance.now();
    if (lastSnapshot) {
        interval = interval * 0.8 + ((now - lastSnapshot) / 1000) * 0.2;
    }
    lastSnapshot = now;
    containers = message.containers;
    const cpusBefore = capacity?.wsl.cpus;
    capacity = message.capacity;
    refreshRemoved(cpusBefore);
    const names = new Set(containers.map((c) => c.name));
    for (const name of rows.keys()) {
        if (!names.has(name)) {
            rows.delete(name);
        }
    }

    layout();

    const live = containers.filter(running);
    const orphans = containers.filter((c) => c.orphan);
    $('running').textContent = live.length;
    $('total').textContent = `/ ${containers.length}`;
    renderTotals(live.reduce((sum, c) => sum + (c.cpu ?? 0), 0), live.reduce((sum, c) => sum + (c.memoryBytes ?? 0), 0));
    $('orphans').textContent = orphans.length;
    setTone($('orphan-tile'), orphans.length ? 'pending' : null);
    $('reap').disabled = orphans.length === 0;

    $('live').dataset.tone = 'success';
    $('live-text').textContent = 'Live';
    $('error').hidden = true;
    updateExpandAll();
}

/** The CPU and memory tiles are shares of WSL; the Windows row under them shows the same totals against the PC. */
function renderTotals(cores, memoryBytes) {
    const { wsl, windows } = capacity;
    $('cpu-total').textContent = percent(share(cores, wsl.cpus));
    $('cpu-total-of').textContent = `of ${whose(capacity)} ${wsl.cpus} processors`;
    $('memory-total').textContent = bytes(memoryBytes);
    $('memory-total-of').textContent = `${percent(share(memoryBytes, wsl.memoryBytes))} of ${whose(capacity)} ${bytes(wsl.memoryBytes)}`;
    $('windows-cpu').textContent = percent(share(cores, windows.cpus));
    $('windows-cpu-of').textContent = `of ${windows.cpus} processors`;
    $('windows-memory').textContent = percent(share(memoryBytes, windows.memoryBytes));
    $('windows-memory-of').textContent = `of ${bytes(windows.memoryBytes)}`;
    $('wsl-size').textContent = capacity.wslMeasured ? size(wsl) : 'not measured yet';
    $('wsl-size-note').textContent = capacity.wslMeasured ? 'what containers see' : "Windows' size stands in";
}

// ---------- Actions ----------

function act(name, op) {
    const c = containers.find((item) => item.name === name);
    if (!c) {
        return;
    }
    switch (op) {
        case 'remove':
            confirm({
                title: `Remove ${c.title}?`,
                message: 'The container is stopped and deleted.',
                detail: `wslc remove --force ${name}`,
                action: 'Remove',
            }).then((ok) => ok && post({ type: 'container', name, op: 'remove' }));
            break;
        case 'toggle':
            post({ type: 'container', name, op: running(c) ? 'stop' : 'start' });
            break;
        case 'restart':
            post({ type: 'container', name, op: 'restart' });
            break;
        case 'logs':
            window.dispatchEvent(new CustomEvent('watcher:logs', { detail: { name } }));
            break;
        case 'inspect':
        case 'shell':
        case 'files':
            window.dispatchEvent(new CustomEvent(`watcher:${op === 'shell' ? 'inspect' : op}`, { detail: { name, tab: op === 'shell' ? 'terminal' : undefined } }));
            break;
        case 'folder':
            post({ type: 'folder', path: c.path });
            break;
    }
}

$('reap').addEventListener('click', () => {
    const orphans = containers.filter((c) => c.orphan);
    confirm({
        title: `Reap ${orphans.length} orphaned ${orphans.length === 1 ? 'container' : 'containers'}?`,
        message: 'Their folders were deleted. Each container is stopped and deleted.',
        detail: orphans.map((c) => c.name).join('\n'),
        action: 'Reap',
    }).then((ok) => ok && orphans.forEach((c) => post({ type: 'container', name: c.name, op: 'remove', source: 'reap' })));
});

// ---------- Removed containers ----------

const removedPageSize = 10;
const removals = {
    reap: { label: 'Reaped', tone: 'pending' },
    limit: { label: 'Over a limit', tone: 'danger' },
    watcher: { label: 'Removed in Watcher', tone: 'neutral' },
    outside: { label: 'Removed outside Watcher', tone: 'neutral' },
};
let removedOpen = localStorage.getItem('removed-open') === 'true';
let removedOffset = 0;
let removedTotal = 0;
// Null until a page is fetched while open, so a reopened list never flashes the empty state.
let removedItems = null;
let removedTicket = 0;

/** 40 s, 12 min, 5 h, 3 days. */
function lifetime(ms) {
    const minutes = Math.floor(ms / 60_000);
    if (minutes < 1) {
        return `${Math.max(0, Math.round(ms / 1000))} s`;
    }
    if (minutes < 60) {
        return `${minutes} min`;
    }
    const hours = Math.floor(minutes / 60);

    return hours < 48 ? `${hours} h` : `${Math.floor(hours / 24)} days`;
}

const avgCpu = (c) => (c.avgCpuCores == null || !capacity ? '—' : percent(share(c.avgCpuCores, capacity.wsl.cpus)));

function removedRow(c) {
    const row = $('removed-template').content.firstElementChild.cloneNode(true);
    const how = removals[c.removedBy] ?? removals.outside;
    row.dataset.tone = how.tone;
    row.querySelector('.name').textContent = c.title;
    row.querySelector('.name').title = c.name;
    row.querySelector('.sub').textContent = c.path ?? c.image;
    row.querySelector('.sub').title = c.path ?? c.image;
    row.querySelector('.group-cell').textContent = sectionOf(c);
    row.querySelector('.port').textContent = c.port || '—';
    const badge = row.querySelector('.badge');
    badge.textContent = how.label;
    badge.dataset.tone = how.tone;
    const at = row.querySelector('.at');
    at.dataset.at = c.removedAt;
    at.textContent = ago(c.removedAt);
    at.title = `${day(c.removedAt)} ${clock(c.removedAt)}`;
    row.querySelector('.lifetime').textContent = lifetime(c.removedAt - c.firstSeen);
    row.querySelector('.peak').textContent = c.peakMemory == null ? '—' : bytes(c.peakMemory);
    row.querySelector('.avg').textContent = avgCpu(c);
    if (c.hasFolder) {
        row.classList.add('opens');
        row.title = `Open ${c.path}`;
        row.addEventListener('click', () => post({ type: 'folder', path: c.path }));
    }

    return row;
}

function renderRemoved() {
    const items = removedItems ?? [];
    const loaded = removedItems !== null;
    $('removed').classList.toggle('open', removedOpen);
    $('removed-toggle').setAttribute('aria-expanded', String(removedOpen));
    $('removed-count').textContent = removedTotal;
    $('removed-body').hidden = !removedOpen;
    $('removed-rows').replaceChildren(...items.map(removedRow));
    $('removed-table').hidden = items.length === 0;
    $('removed-empty').hidden = !loaded || removedTotal > 0;
    $('removed-pager').hidden = !loaded || removedTotal <= removedPageSize;
    $('removed-range').textContent = `${removedOffset + 1}–${removedOffset + items.length} of ${removedTotal}`;
    $('removed-prev').disabled = removedOffset === 0;
    $('removed-next').disabled = removedOffset + items.length >= removedTotal;
}

/** Collapsed, only the count is asked for. A page that live removals emptied steps back to the last one. */
async function loadRemoved() {
    const mine = ++removedTicket;
    const open = removedOpen;
    try {
        const page = await request('removed', open ? { offset: removedOffset, limit: removedPageSize } : { offset: 0, limit: 0 });
        if (mine !== removedTicket) {
            return;
        }
        if (open && page.items.length === 0 && removedOffset > 0) {
            removedOffset = Math.max(0, Math.ceil(page.total / removedPageSize) - 1) * removedPageSize;
            loadRemoved();
            return;
        }
        removedTotal = page.total;
        if (open) {
            removedItems = page.items;
        }
        $('removed-error').hidden = true;
        renderRemoved();
    } catch (error) {
        $('removed-error').textContent = `Could not read the database: ${error.message}`;
        $('removed-error').hidden = false;
    }
}

$('removed-toggle').addEventListener('click', () => {
    removedOpen = !removedOpen;
    localStorage.setItem('removed-open', String(removedOpen));
    removedItems = null;
    renderRemoved();
    removedOpen ? loadRemoved() : ++removedTicket;
});
$('removed-prev').addEventListener('click', () => {
    removedOffset = Math.max(0, removedOffset - removedPageSize);
    loadRemoved();
});
$('removed-next').addEventListener('click', () => {
    removedOffset += removedPageSize;
    loadRemoved();
});

/** Relative times age and WSL's size can change; neither needs the list fetched again. */
function refreshRemoved(cpusBefore) {
    if (removedItems && capacity.wsl.cpus !== cpusBefore) {
        renderRemoved();
        return;
    }
    $('removed-rows').querySelectorAll('[data-at]').forEach((element) => {
        const value = ago(Number(element.dataset.at));
        if (element.textContent !== value) {
            element.textContent = value;
        }
    });
}

// A remove action can land just after the snapshot that saw the container go, and that changes how it was removed.
const changesRemoved = (event) =>
    event.kind === 'disappeared' || event.kind === 'appeared' || (event.kind === 'action' && event.detail?.op === 'remove');

renderRemoved();
loadRemoved();

// ---------- Dialog ----------

let settle = null;

function confirm({ title, message, detail = '', action = null }) {
    settle?.(false);
    $('modal-title').textContent = title;
    $('modal-message').textContent = message;
    $('modal-detail').textContent = detail;
    $('modal-confirm').hidden = action === null;
    $('modal-confirm').textContent = action ?? '';
    $('modal-cancel').textContent = action === null ? 'Close' : 'Cancel';
    $('modal').showModal();
    (action === null ? $('modal-cancel') : $('modal-confirm')).focus();

    return new Promise((resolve) => {
        settle = (ok) => {
            settle = null;
            $('modal').close();
            resolve(ok);
        };
    });
}

$('modal-cancel').addEventListener('click', () => settle?.(false));
$('modal-confirm').addEventListener('click', () => settle?.(true));
// Clicks on the ::backdrop are delivered to the dialog element itself.
$('modal').addEventListener('mousedown', (event) => event.target === $('modal') && settle?.(false));
// Escape closes a native dialog on its own; settle the promise via the close event.
$('modal').addEventListener('close', () => settle?.(false));

// ---------- Host messages ----------

registerPage('containers', { title: 'Containers' });

on('snapshot', snapshot);
on('event', ({ event }) => changesRemoved(event) && loadRemoved());
on('busy', (data) => {
    data.busy ? busy.add(data.name) : busy.delete(data.name);
    const row = rows.get(data.name);
    if (row) {
        setBusy(row, data.busy);
    }
});
on('error', (data) => confirm({ title: data.title, message: 'wslc reported an error.', detail: data.message }));
on('missing', () => {
    $('missing').hidden = false;
    $('missing').closest('.page').classList.add('no-wslc');
});
on('offline', (data) => {
    $('live').dataset.tone = 'danger';
    $('live-text').textContent = 'Offline';
    $('error').textContent = data.message;
    $('error').hidden = false;
});
