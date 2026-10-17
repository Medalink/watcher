import { readFile, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

const [instancePath, action, input, output] = process.argv.slice(2);
const instance = JSON.parse(await readFile(instancePath, 'utf8'));
if (!instance.endpoint?.startsWith('http://127.0.0.1:')) throw new Error('An owned loopback WebView endpoint is required.');
const targets = await fetch(`${instance.endpoint}/json/list`).then(response => response.json());
const target = targets.find(item => item.type === 'page' && item.url.startsWith('https://app.watcher/'));
if (!target) throw new Error('The owned Watcher page is not ready.');
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
let sequence = 0;
const pending = new Map();
socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const settle = pending.get(message.id);
    if (!settle) return;
    pending.delete(message.id);
    message.error ? settle.reject(new Error(JSON.stringify(message.error))) : settle.resolve(message.result);
});
async function command(method, params) {
    const id = ++sequence;
    const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    socket.send(JSON.stringify({ id, method, params }));
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${method} timed out.`)), 45000); })]); }
    finally { clearTimeout(timer); }
}
try {
    if (action === 'screenshot') {
        const result = await command('Page.captureScreenshot', { format: 'png' });
        await writeFile(input, Buffer.from(result.data, 'base64'));
        console.log(JSON.stringify({ screenshot: input, url: target.url }));
    } else if (action === 'downloads') {
        const folder = resolve(input);
        if (!folder.toLowerCase().startsWith((resolve(instance.root) + sep).toLowerCase())) throw new Error('Downloads must stay in the owned proof folder.');
        await command('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: folder });
        console.log(JSON.stringify({ downloadFolder: folder }));
    } else if (action === 'evaluate') {
        const expression = `globalThis.__watcherProof=${JSON.stringify(instance)};\n${await readFile(input, 'utf8')}`;
        const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
        if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
        const value = result.result.value ?? null;
        if (output) { await writeFile(output, JSON.stringify(value, null, 2)); console.log(JSON.stringify({ saved: output, ok: value?.ok ?? true, checks: value?.checks?.length })); }
        else console.log(JSON.stringify(value));
    } else throw new Error('Use evaluate <script> or screenshot <path>.');
} finally { socket.close(); }
