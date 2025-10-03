
import fs from 'fs';
import { fetch } from 'undici';

const API = 'https://linera-api.pulsar.money/api/v1/pulsar';
const ORIGIN = 'https://portal.linera.net';

function ts(){ return new Date().toISOString(); }
const sleep = (ms)=> new Promise(r=>setTimeout(r, ms));

function parseArgs() {
  const a = process.argv.slice(2);
  const i = a.indexOf('--every');
  const h = i >= 0 ? Number(a[i+1]) : 24;
  return { intervalHours: Number.isFinite(h) && h > 0 ? h : 24 };
}

function loadEnv() {
  const txt = fs.readFileSync('.env', 'utf8');
  const env = {};
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*'?(.*?)'?\s*$/);
    if (m) env[m[1]] = m[2];
  }
  if (!env.DYNAMIC_TOKEN) throw new Error('Isi .env dengan DYNAMIC_TOKEN');
  // OPTIONAL: kalau kamu punya X-Device-Signature, taruh juga di .env:
  // DEVICE_SIGNATURE='...'
  return env;
}

async function getJson(url, headers) {
  const r = await fetch(url, { headers });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: r.status, json, raw: text };
}
async function postJson(url, headers, body) {
  const r = await fetch(url, { method:'POST', headers:{...headers,'Content-Type':'application/json'}, body: JSON.stringify(body) });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: r.status, json };
}

async function runOnce() {
  const env = loadEnv(); // reload tiap run (kalau token/signature berubah)
  const headers = {
    Accept: 'application/json',
    Origin: ORIGIN,
    'X-Dynamic-Token': env.DYNAMIC_TOKEN,
  };
  if (env.ACCESS_TOKEN) headers['X-Access-Token'] = env.ACCESS_TOKEN;
  if (env.DEVICE_SIGNATURE) headers['X-Device-Signature'] = env.DEVICE_SIGNATURE; // opsional

  // Warm-up
  const warm = await fetch(`${API}/social-pay/me`, { headers: { ...headers, 'Cache-Control':'no-cache' }});
  console.log(`[${ts()}] Warm-up status: ${warm.status}`);
  if (warm.status === 401) throw new Error('401 (cek DYNAMIC_TOKEN/DEVICE_SIGNATURE di .env)');

  // Ambil task
  const tasks = await getJson(`${API}/challenges/linera/1`, { ...headers, 'Cache-Control':'no-cache' });
  if (tasks.status !== 200) throw new Error(`Fetch tasks gagal: ${tasks.status} ${String(tasks.raw).slice(0,160)}`);

  const list = tasks.json?.tasks || [];
  const re = /\bdaily\b|\bcheck[- ]?in\b/i;
  const cand = list
    .filter(t => t.isEnabled !== false && re.test([t.taskName||'', t.title||'', t.type||'', t.slug||''].join(' ')))
    .sort((a,b)=>(a.displayOrder ?? 1e9) - (b.displayOrder ?? 1e9))[0];
  if (!cand) throw new Error('Task daily/check-in tidak ditemukan');

  console.log(`[${ts()}] Daily: ${cand.title || cand.taskName || cand.id} ${cand.id}`);

  // Submit
  const res = await postJson(`${API}/challenges/do-task`, headers, { taskGuid: cand.id, extraArguments: [] });
  const msg = JSON.stringify(res.json || {});
  if (
    res.status === 201 || res.json?.status === true ||
    (res.status === 200 && /already/i.test(msg)) ||
    (res.status === 400 && /already/i.test(msg))
  ) {
    const state = res.json?.state ?? (/already/i.test(msg) ? 'ALREADY_CLAIMED' : 'OK');
    const points = res.json?.points ?? res.json?.pointsAwarded ?? null;
    console.log(`[${ts()}] Submit OK: ${state}${points ? ` (+${points})` : ''}`);
    return;
  }
  throw new Error(`Submit gagal: ${res.status} ${msg.slice(0,200)}`);
}

(async () => {
  const { intervalHours } = parseArgs();
  console.log(`[${ts()}] Daemon start — interval ${intervalHours} jam.`);
  process.on('SIGINT', ()=>{ console.log(`\n[${ts()}] Stop.`); process.exit(0); });
  process.on('SIGTERM', ()=>{ console.log(`\n[${ts()}] Stop.`); process.exit(0); });

  let attempt = 0;
  while (true) {
    try {
      await runOnce();
      attempt = 0;
      const jitterMs = Math.floor(Math.random()*30000); // jitter <=30s biar gak “terlalu pas”
      const waitMs = intervalHours*3600000 + jitterMs;
      console.log(`[${ts()}] Next run in ~${intervalHours}h`);
      await sleep(waitMs);
    } catch (e) {
      attempt += 1;
      const backoff = Math.min(60, 5*attempt); // 5s,10s,... max 60s
      console.error(`[${ts()}] ERROR: ${e.message || e}. Retry in ${backoff}s`);
      await sleep(backoff*1000);
    }
  }
})();
