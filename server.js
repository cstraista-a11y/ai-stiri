const http = require('http');
const https = require('https');
const { URL } = require('url');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;

const FEEDS = [
  // Moldova — surse verificate CJI
  'https://newsmaker.md/feed/',
  'https://tv8.md/feed/',
  'https://www.zdg.md/feed',
  'https://agora.md/ro/rss',
  'https://moldova.europalibera.org/api/epiooi_yit',
  'https://moldova1.md/rss',
  'https://nokta.md/feed/',
  'https://www.ipn.md/rss',
  'https://www.protv.md/rss',
  'https://deschide.md/feed/',
  'https://publika.md/rss',
  // România
  'https://www.g4media.ro/feed',
  'https://www.hotnews.ro/rss',
  'https://www.digi24.ro/rss',
  'https://www.libertatea.ro/rss',
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

  if (u.pathname === '/rss') {
    const feedUrl = u.searchParams.get('url');
    if (!feedUrl || !FEEDS.includes(feedUrl)) {
      res.writeHead(403); res.end(JSON.stringify({ error: 'Sursă nepermisă' })); return;
    }
    try {
      const xml = await fetchUrl(feedUrl);
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
