const http = require('http');
const https = require('https');
// Folosim https nativ pentru Gemini API
function fetchJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const reqOptions = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    };
    const req = https.request(reqOptions, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ 
        ok: res.statusCode < 400, 
        status: res.statusCode,
        json: () => Promise.resolve(JSON.parse(data)), 
        text: () => Promise.resolve(data) 
      }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}
const { URL } = require('url');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;

const FEEDS = [
  // Moldova — surse verificate CJI
  'https://newsmaker.md/feed/',
  'https://tv8.md/feed/',
  'https://www.zdg.md/feed',
  'https://moldova.europalibera.org/api/epiooi_yit',
  'https://moldova1.md/rss',
  'https://www.ipn.md/rss',
  'https://www.publika.md/rss',
  'https://deschide.md/feed/',
  'https://publika.md/rss',
  // România
  'https://www.g4media.ro/feed',
  'https://www.hotnews.ro/rss',
  'https://www.digi24.ro/rss',
  'https://www.dw.com/ro/rss',
  // Internațional EN
  'https://feeds.bbci.co.uk/news/world/rss.xml',
  'https://feeds.reuters.com/reuters/worldNews',
  'https://www.theguardian.com/world/rss',
  'https://rsshub.app/apnews/topics/world-news',
  'https://feeds.skynews.com/feeds/rss/world.xml',
  'https://feeds.npr.org/1001/rss.xml',
  'https://rss.dw.com/rdf/rss-en-all',
  'https://www.politico.eu/feed/',
  'https://www.euractiv.com/feed/',
  'https://www.ft.com/rss/home',
  'https://www.economist.com/latest/rss.xml',
];

// ── CACHE RSS (5 minute) ──────────────────────────────────
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minute

async function fetchWithCache(url) {
  const now = Date.now();
  if (cache.has(url)) {
    const { data, ts } = cache.get(url);
    if (now - ts < CACHE_TTL) {
      console.log(`  📦 Cache hit: ${new URL(url).hostname}`);
      return data;
    }
  }
  const data = await fetchUrl(url);
  cache.set(url, { data, ts: now });
  console.log(`  🔄 Cache miss: ${new URL(url).hostname} (${data.length} bytes)`);
  return data;
}

// Curățăm cache-ul expirat la fiecare 10 minute
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [url, { ts }] of cache.entries()) {
    if (now - ts > CACHE_TTL) { cache.delete(url); cleaned++; }
  }
  if (cleaned > 0) console.log(`  🧹 Cache curățat: ${cleaned} intrări expirate`);
}, 10 * 60 * 1000);

function fetchUrl(targetUrl, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > 5) return reject(new Error('Too many redirects'));
    let parsed;
    try { parsed = new URL(targetUrl); } catch(e) { return reject(new Error('Bad URL')); }
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
        'Accept': 'application/rss+xml,application/xml,text/xml,*/*',
        'Accept-Language': 'ro-RO,ro;q=0.9,en;q=0.8',
      },
      timeout: 12000,
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let loc = res.headers.location;
        if (!loc.startsWith('http')) loc = `${parsed.protocol}//${parsed.hostname}${loc}`;
        res.resume();
        return fetchUrl(loc, hops + 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const u = new URL(req.url, `http://localhost:${PORT}`);
  console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${u.pathname}`);

  if (u.pathname === '/' || u.pathname === '/index.html') {
    try {
      const buf = fs.readFileSync(path.join(__dirname, 'index.html'));
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Length', buf.length);
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.writeHead(200); res.end(buf);
      console.log(`  → index.html (${buf.length} bytes)`);
    } catch(e) { res.writeHead(500); res.end('index.html lipsește: ' + e.message); }
    return;
  }

  if (u.pathname === '/ping') {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200); res.end(JSON.stringify({ ok: true, time: new Date().toISOString(), feeds: FEEDS.length }));
    return;
  }

  if (u.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }

  if (u.pathname === '/ai') {
    if (req.method !== 'POST') { res.writeHead(405); res.end('Method not allowed'); return; }
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { articles, profile } = JSON.parse(body);
        const langMap = {
          liceu: 'simplu și clar, fără jargon, fraze scurte',
          medii: 'accesibil, ușor de înțeles',
          facultate: 'standard, informativ',
          master: 'tehnic și detaliat'
        };
        const langStyle = langMap[profile?.edu] || 'standard';
        const zone = profile?.zone || 'Moldova';
        const age = profile?.age || 28;

        const prompt = `Ești editorul aplicației Ai Știri din Moldova. Pentru fiecare articol:
1. Dacă e în rusă sau engleză — traduce în română naturală
2. Rescrie TITLUL — concis, informativ, fără clickbait, max 12 cuvinte
3. Scrie un REZUMAT de 3-4 propoziții: CE s-a întâmplat, UNDE, CÂND, DE CE contează. Stil direct, jurnalistic. Limbaj: ${langStyle}. Cititor: ${age} ani din ${zone}.

Returnează DOAR JSON valid:
[{"id":"...","title":"...","summary":"..."}]

Articole:
${JSON.stringify(articles.map(a => ({ id: a.id, title: a.title, text: (a.summary || a.fullText || '').substring(0, 400), lang: a.lang })))}`;

        const geminiRes = await fetchJson(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { temperature: 0.3, maxOutputTokens: 4000 }
            })
          }
        );
        const geminiData = await geminiRes.json();
        const text = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
        const clean = text.replace(/```json|```/g, '').trim();
        const parsed = JSON.parse(clean);
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, articles: parsed }));
        console.log(`  🤖 AI rezumat: \${parsed.length} articole`);
      } catch(e) {
        console.error('AI error:', e.message);
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (u.pathname === '/privacy') {
    try {
      const buf = fs.readFileSync(path.join(__dirname, 'privacy.html'));
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Length', buf.length);
      res.writeHead(200); res.end(buf);
    } catch(e) { res.writeHead(404); res.end('Privacy page not found'); }
    return;
  }

  if (u.pathname === '/rss') {
    const feedUrl = u.searchParams.get('url');
    if (!feedUrl || !FEEDS.includes(feedUrl)) {
      res.writeHead(403); res.end(JSON.stringify({ error: 'Sursă nepermisă' })); return;
    }
    try {
      const xml = await fetchWithCache(feedUrl);
      res.setHeader('Content-Type', 'application/xml; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.writeHead(200); res.end(xml);
      console.log(`  ✅ RSS: ${new URL(feedUrl).hostname} (${xml.length} bytes)`);
    } catch(e) {
      console.log(`  ❌ RSS FAIL: ${feedUrl} — ${e.message}`);
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`\n✅ GATA Server pornit!`);
  console.log(`👉 http://localhost:${PORT}`);
  console.log(`📡 ${FEEDS.length} surse media configurate\n`);
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n❌ Portul ${PORT} e ocupat!`);
    console.error(`Rulează: kill $(lsof -t -i:${PORT})\n`);
  } else console.error('Eroare:', e.message);
});
