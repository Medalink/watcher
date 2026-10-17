import { $, basis, bytes, moment, percent, registerPage, request, share, size, whose } from './app.js';

const svgNs = 'http://www.w3.org/2000/svg';
const refreshMs = 30_000;
const ranges = ['1h', '24h', '7d', '30d'];

let range = ranges.includes(localStorage.getItem('stats-range')) ? localStorage.getItem('stats-range') : '24h';
let data = null;
let timer = null;
let loading = 0;
let sort = { key: 'cpuAvg', dir: -1 };

// ---------- Loading ----------

async function load() {
    const ticket = ++loading;
    try {
        const result = await request('stats', { range });
        if (ticket !== loading) {
            return;
        }
        data = result;
        $('stats-error').hidden = true;
        render();
    } catch (error) {
        $('stats-error').textContent = `Could not read the database: ${error.message}`;
        $('stats-error').hidden = false;
    }
}

function selectRange(next) {
    range = next;
    localStorage.setItem('stats-range', range);
    document.querySelectorAll('#stats-range button').forEach((b) => b.classList.toggle('current', b.dataset.range === range));
    load();
}

document.querySelectorAll('#stats-range button').forEach((button) =>
    button.addEventListener('click', () => selectRange(button.dataset.range)));
$('stats-open-folder').addEventListener('click', () => request('open-data-folder'));
window.addEventListener('resize', () => data && !$('stats-cpu').closest('section[data-page]').hidden && drawCharts());

registerPage('stats', {
    title: 'Stats',
    shown: () => {
        selectRange(range);
        timer = setInterval(load, refreshMs);
    },
    hidden: () => clearInterval(timer),
});

// ---------- Rendering ----------

const duration = (ms) => (ms >= 3_600_000 ? `${ms / 3_600_000} h` : ms >= 60_000 ? `${ms / 60_000} min` : `${ms / 1000} s`);
const count = (value) => value.toLocaleString('en-US');

function render() {
    const { peaks, series, events, capacity } = data;
    const { wsl, windows } = capacity;
    const empty = series.length === 0;
    const at = (time) => (time ? `at ${moment(time)}` : '');
    $('stats-peak-cpu').textContent = empty ? '—' : percent(share(peaks.cpu, wsl.cpus));
    $('stats-peak-cpu-at').textContent = empty ? '' : `of ${basis(capacity)} ${at(peaks.cpuAt)}`;
    $('stats-peak-memory').textContent = empty ? '—' : bytes(peaks.memory);
    $('stats-peak-memory-at').textContent = empty ? '' : `${percent(share(peaks.memory, wsl.memoryBytes))} of ${basis(capacity)} ${at(peaks.memoryAt)}`;
    $('stats-windows-cpu').textContent = empty ? '—' : percent(share(peaks.cpu, windows.cpus));
    $('stats-windows-cpu-at').textContent = empty ? '' : `of ${windows.cpus} processors ${at(peaks.cpuAt)}`;
    $('stats-windows-memory').textContent = empty ? '—' : percent(share(peaks.memory, windows.memoryBytes));
    $('stats-windows-memory-at').textContent = empty ? '' : `of ${bytes(windows.memoryBytes)} ${at(peaks.memoryAt)}`;
    $('stats-wsl-size').textContent = capacity.wslMeasured ? size(wsl) : 'not measured yet';
    $('stats-windows-size').textContent = size(windows);
    $('stats-running').textContent = empty ? '—' : (series.reduce((sum, p) => sum + p.running, 0) / series.length).toFixed(1);
    const kinds = Object.entries(events).sort((a, b) => b[1] - a[1]);
    $('stats-events').textContent = count(kinds.reduce((sum, [, n]) => sum + n, 0));
    $('stats-events-top').textContent = kinds.slice(0, 3).map(([kind, n]) => `${kind} ${n}`).join(' · ');
    $('stats-bucket').textContent = `sum of container averages per ${duration(data.bucketMs)}`;

    drawCharts();
    renderTable();
    renderDatabase();
}

function drawCharts() {
    const of = basis(data.capacity);
    chart($('stats-cpu'), (p) => share(p.cpu, data.capacity.wsl.cpus), percentAxis,
        (value) => `${percent(value)} of ${of}`, (value) => percent(value).replace('.0%', '%'), `% of ${of}`);
    chart($('stats-memory'), (p) => p.memory, bytesAxis, bytes, (value) => bytes(value).replace('.0 ', ' '));
}

// ---------- Charts ----------

/** A round step so four gridlines reach the peak: 1, 2, 2.5 or 5 × 10^n. */
function nice(peak) {
    const raw = peak / 4;
    const power = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= raw);

    return { step, max: step * 4 };
}

const percentAxis = (peak) => nice(Math.max(peak, 5));

/** The same in binary units, so labels read 256 MiB or 2 GiB rather than 238.4 MiB. */
function bytesAxis(peak) {
    const unit = 1024 ** Math.max(0, Math.floor(Math.log(Math.max(peak, 1)) / Math.log(1024)));
    const { step } = nice(Math.max(peak, 1) / unit);

    return { step: step * unit, max: step * unit * 4 };
}

function element(name, attributes, parent) {
    const node = document.createElementNS(svgNs, name);
    Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, value));
    parent?.appendChild(node);

    return node;
}

function ticks(from, to) {
    const span = to - from;
    const hour = 3_600_000;
    const step = span <= hour ? 10 * 60_000 : span <= 24 * hour ? 4 * hour : span <= 7 * 24 * hour ? 24 * hour : 5 * 24 * hour;
    const offset = -new Date(from).getTimezoneOffset() * 60_000;
    const result = [];
    for (let at = Math.ceil((from + offset) / step) * step - offset; at <= to; at += step) {
        result.push(at);
    }

    return result;
}

function tickLabel(at, span) {
    const date = new Date(at);
    return span <= 24 * 3_600_000
        ? `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
        : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Consecutive buckets join into one segment; a missing bucket starts a new one, so gaps stay empty. */
function segments(points, bucketMs) {
    const result = [];
    for (const point of points) {
        const last = result.at(-1);
        if (last && point.at - last.at(-1).at <= bucketMs) {
            last.push(point);
        } else {
            result.push([point]);
        }
    }

    return result;
}

/** read gives a point's value; unit, when set, titles the value axis. */
function chart(holder, read, axis, format, label = format, unit = '') {
    const { series, from, to, bucketMs } = data;
    holder.replaceChildren();
    if (series.length === 0) {
        const note = document.createElement('div');
        note.className = 'empty-note';
        note.textContent = 'No samples in this range yet. The monitor records one every few seconds while it is open.';
        holder.appendChild(note);
        return;
    }

    const width = holder.clientWidth;
    const height = holder.clientHeight;
    const pad = { left: 70, right: 12, top: 10, bottom: 24 };
    const plotWidth = width - pad.left - pad.right;
    const plotHeight = height - pad.top - pad.bottom;
    const { step, max } = axis(Math.max(...series.map(read)));
    const x = (at) => pad.left + ((at - from) / (to - from)) * plotWidth;
    const y = (value) => pad.top + plotHeight - (Math.min(value, max) / max) * plotHeight;
    const svg = element('svg', { viewBox: `0 0 ${width} ${height}` }, holder);

    for (let value = 0; value <= max + step / 2; value += step) {
        element('line', { class: value === 0 ? 'base' : 'grid', x1: pad.left, x2: width - pad.right, y1: y(value), y2: y(value) }, svg);
        element('text', { x: pad.left - 10, y: y(value) + 3.5, 'text-anchor': 'end' }, svg).textContent = label(value);
    }
    for (const at of ticks(from, to)) {
        element('text', { x: x(at), y: height - 6, 'text-anchor': 'middle' }, svg).textContent = tickLabel(at, to - from);
    }
    if (unit) {
        const middle = pad.top + plotHeight / 2;
        element('text', { class: 'unit', x: 12, y: middle, 'text-anchor': 'middle', transform: `rotate(-90 12 ${middle})` }, svg).textContent = unit;
    }

    const base = y(0);
    for (const segment of segments(series, bucketMs)) {
        if (segment.length === 1) {
            element('circle', { class: 'dot', cx: x(segment[0].at), cy: y(read(segment[0])), r: 2.5 }, svg);
            continue;
        }
        const line = segment.map((p) => `${x(p.at).toFixed(1)},${y(read(p)).toFixed(1)}`).join(' L');
        element('path', { class: 'area', d: `M${x(segment[0].at).toFixed(1)},${base} L${line} L${x(segment.at(-1).at).toFixed(1)},${base} Z` }, svg);
        element('path', { class: 'line', d: `M${line}` }, svg);
    }

    const cross = element('line', { class: 'cross', y1: pad.top, y2: pad.top + plotHeight, visibility: 'hidden' }, svg);
    const marker = element('circle', { class: 'marker-dot', r: 3, visibility: 'hidden' }, svg);
    const readout = document.createElement('div');
    readout.className = 'readout';
    readout.hidden = true;
    holder.appendChild(readout);

    svg.addEventListener('mousemove', (event) => {
        const box = svg.getBoundingClientRect();
        const px = event.clientX - box.left;
        if (px < pad.left || px > width - pad.right) {
            hide();
            return;
        }
        const at = from + ((px - pad.left) / plotWidth) * (to - from);
        const nearest = series.reduce((best, p) => (Math.abs(p.at - at) < Math.abs(best.at - at) ? p : best));
        const hit = Math.abs(nearest.at - at) <= bucketMs;
        const cx = hit ? x(nearest.at) : px;
        cross.setAttribute('x1', cx);
        cross.setAttribute('x2', cx);
        cross.setAttribute('visibility', 'visible');
        marker.setAttribute('visibility', hit ? 'visible' : 'hidden');
        if (hit) {
            marker.setAttribute('cx', cx);
            marker.setAttribute('cy', y(read(nearest)));
        }
        readout.innerHTML = hit
            ? `${moment(nearest.at)}<span class="num">${format(read(nearest))}</span>`
            : `${moment(at)}<span class="num">no data</span>`;
        readout.hidden = false;
        const left = cx + 12 + readout.offsetWidth > width ? cx - 12 - readout.offsetWidth : cx + 12;
        readout.style.left = `${left}px`;
    });
    svg.addEventListener('mouseleave', hide);

    function hide() {
        cross.setAttribute('visibility', 'hidden');
        marker.setAttribute('visibility', 'hidden');
        readout.hidden = true;
    }
}

// ---------- Containers table ----------

/** CPU columns arrive as cores and show as a share of WSL. */
const cpuShare = (cores) => percent(share(cores, data.capacity.wsl.cpus));
const cpuTitle = () => `% of ${whose(data.capacity)} ${data.capacity.wsl.cpus} processors`;

const columns = [
    { key: 'title', label: 'Container', text: true },
    { key: 'samples', label: 'Samples', format: count },
    { key: 'cpuAvg', label: 'CPU avg', title: cpuTitle, format: cpuShare },
    { key: 'cpuP95', label: 'CPU p95 *', title: cpuTitle, format: cpuShare },
    { key: 'cpuMax', label: 'CPU max', title: cpuTitle, format: cpuShare },
    { key: 'memAvg', label: 'Mem avg', format: bytes },
    { key: 'memMax', label: 'Mem max', format: bytes },
    { key: 'memLimit', label: 'Limit', format: (v) => (v ? bytes(v) : '—') },
    { key: 'netIn', label: 'Net in', format: bytes },
    { key: 'netOut', label: 'Net out', format: bytes },
    { key: 'diskRead', label: 'Disk read', format: bytes },
    { key: 'diskWrite', label: 'Disk write', format: bytes },
    { key: 'uptimePct', label: 'Uptime', title: 'Share of watched time running: minutes with a sample out of the minutes Watcher was watching', format: percent },
    { key: 'restarts', label: 'Restarts', format: count },
];

function renderTable() {
    const table = $('stats-table');
    const rows = [...data.containers].sort((a, b) => {
        const column = columns.find((c) => c.key === sort.key);
        const order = column.text ? a[sort.key].localeCompare(b[sort.key]) : a[sort.key] - b[sort.key];
        return order * sort.dir;
    });
    const head = `<thead><tr>${columns.map((c) =>
        `<th data-key="${c.key}"${c.title ? ` title="${escape(typeof c.title === 'function' ? c.title() : c.title)}"` : ''} class="${c.key === sort.key ? `sorted${sort.dir > 0 ? ' asc' : ''}` : ''}">${c.label}</th>`).join('')}</tr></thead>`;
    const body = rows.map((row) => `<tr>${columns.map((c) => c.text
        ? `<td title="${escape(row.name)}">${escape(row.title)}${row.title !== row.name ? `<span class="sub">${escape(row.name)}</span>` : ''}</td>`
        : `<td class="num">${c.format(row[c.key])}</td>`).join('')}</tr>`).join('');
    table.innerHTML = `${head}<tbody>${body}</tbody>`;
    table.hidden = rows.length === 0;
    $('stats-table-empty').hidden = rows.length > 0;
    $('stats-count').textContent = rows.length || '';
    $('stats-p95-note').textContent = rows.length ? `* p95 of the ${duration(data.bucketMs)} bucket averages, not of raw samples. Uptime is the share of watched time running.` : '';
    table.querySelectorAll('th').forEach((th) => th.addEventListener('click', () => {
        const key = th.dataset.key;
        sort = sort.key === key ? { key, dir: -sort.dir } : { key, dir: columns.find((c) => c.key === key).text ? 1 : -1 };
        renderTable();
    }));
}

const escape = (value) => String(value).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// ---------- Database ----------

function renderDatabase() {
    const db = data.db;
    const facts = [
        ['Path', escape(db.path), false],
        ['Size', bytes(db.sizeBytes), true],
        ['Rows', `${count(db.samples)} samples · ${count(db.minutes)} minutes · ${count(db.events)} events`, false],
        ['Oldest data', db.oldestAt ? moment(db.oldestAt) : 'none yet', false],
        ['Retention', `raw samples ${db.retentionHours} h · minute rollups and events forever`, false],
        ['Sample interval', db.intervalMs ? `${(db.intervalMs / 1000).toFixed(1)} s` : 'measuring…', true],
        ['Snapshot write', db.writeMsAvg ? `last ${db.writeMsLast.toFixed(2)} ms · avg ${db.writeMsAvg.toFixed(2)} ms` : 'no writes yet', false],
    ];
    $('stats-db').innerHTML = facts.map(([label, value, mono]) => `<dt>${label}</dt><dd${mono ? ' class="num"' : ''}>${value}</dd>`).join('');
}
