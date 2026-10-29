import { $, clock, day, on, registerPage, request } from './app.js';
import { icon } from './vendor/signal/js/icons.js';

const groups = {
    lifecycle: ['appeared', 'disappeared', 'state', 'orphaned', 'port'],
    alerts: ['cpu-high', 'cpu-normal', 'memory-high', 'memory-normal', 'limit'],
    actions: ['action'],
    monitor: ['monitor-started', 'monitor-stopped', 'wslc-offline', 'wslc-online'],
    runtime: ['runtime', 'runtime-gap'],
};
const pageSize = 200;
const chevron = icon('chevron-right');

const active = new Set(JSON.parse(localStorage.getItem('activity-groups') ?? 'null') ?? Object.keys(groups));
const expanded = new Set();
let events = [];
let more = false;
let loaded = false;
let ticket = 0;

// ---------- Filters ----------

/** null asks for every kind; an empty list for none. */
function kinds() {
    return active.size === Object.keys(groups).length ? null : [...active].flatMap((group) => groups[group]);
}

const filters = () => ({ kinds: kinds(), container: $('activity-container').value || null, search: $('activity-search').value.trim() || null });

/** The same test the host applies, for events pushed while the page is open. */
function matches(event) {
    const { kinds: wanted, container, search } = filters();
    const haystack = `${event.summary} ${event.container ?? ''} ${event.title ?? ''} ${event.detail ? JSON.stringify(event.detail) : ''}`.toLowerCase();

    return (!wanted || wanted.includes(event.kind)) && (!container || event.container === container) && (!search || haystack.includes(search.toLowerCase()));
}

function syncChips() {
    document.querySelectorAll('#activity-groups .chip').forEach((chip) => chip.setAttribute('aria-pressed', String(active.has(chip.dataset.group))));
}

document.querySelectorAll('#activity-groups .chip').forEach((chip) => chip.addEventListener('click', () => {
    active.has(chip.dataset.group) ? active.delete(chip.dataset.group) : active.add(chip.dataset.group);
    localStorage.setItem('activity-groups', JSON.stringify([...active]));
    syncChips();
    reload();
}));
$('activity-container').addEventListener('change', reload);
let typing = null;
$('activity-search').addEventListener('input', () => {
    clearTimeout(typing);
    typing = setTimeout(reload, 250);
});
$('activity-more').addEventListener('click', () => fetchPage(events.at(-1)?.id));

// ---------- Loading ----------

function reload() {
    events = [];
    expanded.clear();
    fetchPage(null);
}

async function fetchPage(before) {
    const mine = ++ticket;
    $('activity-more').disabled = true;
    try {
        const page = await request('activity', { ...filters(), before, limit: pageSize });
        if (mine !== ticket) {
            return;
        }
        events = before == null ? page.events : [...events, ...page.events];
        more = page.more;
        loaded = true;
        $('activity-error').hidden = true;
        render();
    } catch (error) {
        $('activity-error').textContent = `Could not read the database: ${error.message}`;
        $('activity-error').hidden = false;
    } finally {
        $('activity-more').disabled = false;
    }
}

async function loadContainers() {
    const select = $('activity-container');
    const chosen = select.value;
    const containers = await request('containers');
    select.replaceChildren(new Option('All containers', ''), ...containers.map((c) =>
        new Option(c.state === 'removed' ? `${c.title} (removed)` : c.title, c.name)));
    select.value = containers.some((c) => c.name === chosen) ? chosen : '';
}

registerPage('activity', {
    title: 'Activity',
    shown: () => {
        loadContainers().then(() => loaded || reload());
    },
});

on('event', ({ event }) => {
    if (loaded && matches(event) && !events.some((e) => e.id === event.id)) {
        events.unshift(event);
        render();
    }
});

syncChips();

// ---------- Rendering ----------

function tone(event) {
    const detail = event.detail ?? {};
    if (detail.whileClosed || event.kind === 'orphaned') {
        return 'amber';
    }
    switch (event.kind) {
        case 'action':
            return detail.ok ? 'cyan' : 'pink';
        case 'cpu-high':
        case 'memory-high':
        case 'limit':
        case 'wslc-offline':
            return 'pink';
        case 'appeared':
        case 'cpu-normal':
        case 'memory-normal':
        case 'wslc-online':
            return 'green';
        case 'state':
            return detail.to === 'running' ? 'green' : 'neutral';
        default:
            return 'neutral';
    }
}

function dayLabel(at) {
    const today = day(Date.now());
    const yesterday = day(Date.now() - 86_400_000);
    const date = new Date(at).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

    return day(at) === today ? `Today · ${date}` : day(at) === yesterday ? `Yesterday · ${date}` : date;
}

function row(event) {
    const article = document.createElement('article');
    article.className = 'event';
    article.dataset.tone = tone(event);
    article.classList.toggle('expanded', expanded.has(event.id));
    article.innerHTML = `
        <div class="event-head">
            <span class="time sd-num"></span><span><span class="badge sd-badge"></span></span><span class="who"></span><span class="summary"></span>
            <span class="chev">${event.detail || event.container ? chevron : ''}</span>
        </div>${event.detail ? '<pre class="detail sd-code"></pre>' : ''}`;
    article.querySelector('.time').textContent = clock(event.at);
    article.querySelector('.badge').textContent = event.kind;
    article.querySelector('.who').textContent = event.title ?? event.container ?? '—';
    article.querySelector('.who').title = event.container ?? '';
    article.querySelector('.summary').textContent = event.summary;
    if (event.detail) {
        article.querySelector('.detail').textContent = JSON.stringify(event.detail, null, 2);
    }
    if (event.container) {
        const actions = document.createElement('div');
        actions.className = 'detail event-tools';
        const logs = document.createElement('button');
        logs.className = 'sd-btn';
        logs.textContent = 'Logs around this event';
        logs.addEventListener('click', () => window.dispatchEvent(new CustomEvent('watcher:logs', {
            detail: { name: event.container, since: new Date(event.at - 120_000).toISOString(), until: new Date(event.at + 120_000).toISOString() },
        })));
        const inspect = document.createElement('button');
        inspect.className = 'sd-btn';
        inspect.textContent = 'Inspect container';
        inspect.addEventListener('click', () => window.dispatchEvent(new CustomEvent('watcher:inspect', { detail: { name: event.container } })));
        actions.append(logs, inspect);
        article.append(actions);
    }
    if (event.detail || event.container) {
        const head = article.querySelector('.event-head');
        head.tabIndex = 0;
        head.setAttribute('role', 'button');
        const toggle = () => {
            expanded.has(event.id) ? expanded.delete(event.id) : expanded.add(event.id);
            article.classList.toggle('expanded', expanded.has(event.id));
            head.setAttribute('aria-expanded', String(expanded.has(event.id)));
        };
        head.setAttribute('aria-expanded', String(expanded.has(event.id)));
        head.addEventListener('click', toggle);
        head.addEventListener('keydown', (key) => {
            if (key.key === 'Enter' || key.key === ' ') { key.preventDefault(); toggle(); }
        });
    }

    return article;
}

function render() {
    const days = new Map();
    for (const event of events) {
        const key = day(event.at);
        days.set(key, [...(days.get(key) ?? []), event]);
    }
    $('activity-list').replaceChildren(...[...days.values()].map((list) => {
        const block = document.createElement('div');
        block.className = 'day';
        const head = document.createElement('div');
        head.className = 'day-head';
        head.innerHTML = `${dayLabel(list[0].at)}<span class="count">${list.length}${more && list === [...days.values()].at(-1) ? '+' : ''}</span>`;
        block.append(head, ...list.map(row));
        return block;
    }));
    $('activity-more').hidden = !more;
    const filtered = kinds() !== null || filters().container || filters().search;
    $('activity-empty').hidden = events.length > 0;
    $('activity-empty').textContent = filtered
        ? 'Nothing matches these filters.'
        : 'No activity yet. Events appear here as containers start, stop, change port, run hot, or are acted on from this app.';
}

// ---------- Copy for AI ----------

$('export').addEventListener('click', async () => {
    const button = $('export');
    const note = $('export-note');
    const range = $('export-range').value;
    button.disabled = true;
    button.textContent = 'Copying…';
    try {
        const { path, chars, copied } = await request('export', { range });
        note.textContent = copied
            ? `Copied ${chars.toLocaleString('en-US')} characters to the clipboard. Saved to ${path}`
            : `The clipboard was busy, so nothing was copied. Saved to ${path}`;
        note.classList.toggle('busy', !copied);
    } catch (error) {
        note.textContent = `Export failed: ${error.message}`;
        note.classList.add('busy');
    } finally {
        note.hidden = false;
        button.disabled = false;
        button.textContent = 'Copy for AI';
    }
});
