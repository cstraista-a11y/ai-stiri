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
  'https://diez.md/feed/',
  'https://mold-street.com/feed/',
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

// ── ANALYTICS DATA ────────────────────────────────────────
const analyticsData = { sessions: {}, daily: {}, total: 0 };
setInterval(() => {
  try { require('fs').writeFileSync(require('path').join(__dirname,'analytics.json'), JSON.stringify(analyticsData)); } catch(e) {}
}, 5 * 60 * 1000);

// ── CACHE RSS (5 minute) ──────────────────────────────────
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minute

// ── TRADUCERE SERVER-SIDE ─────────────────────────────────
// Traducere cu MyMemory API
async function translateText(text, from = 'en', to = 'ro') {
  try {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text.substring(0,500))}&langpair=${from}|${to}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.responseStatus === 200) return data.responseData.translatedText;
    return null;
  } catch(e) { return null; }
}

// Rezumare cu Gemini — un singur apel pentru toate articolele
async function summarizeArticles(articles) {
  try {
    const toSummarize = articles.slice(0, 12).map((a, i) => ({
      id: i,
      title: a.title,
      desc: a.desc || a.title // dacă nu există desc, folosim titlul
    }));

    const prompt = `Ești un redactor sportiv senior pentru cititorii din Moldova și România.
Pentru fiecare știre despre Cupa Mondială 2026 sau fotbal internațional, scrie un rezumat INFORMATIV și COMPLET de 4-5 propoziții în română.

Regulile tale:
- Scrie MINIM 4 propoziții complete
- NU copia și NU repeta titlul — dezvoltă informația
- Explică CE s-a întâmplat și DE CE e important
- Adaugă CONTEXT despre CM 2026 sau jucătorul/echipa respectivă
- Dacă știrea e vagă, completează cu informații relevante despre subiect
- Menționează grupa, stadionul sau data meciului dacă e relevant
- Folosește cifre concrete când există
- Scrie ca un jurnalist sportiv experimentat, nu ca un robot

Returnează DOAR JSON valid fără markdown: [{"id":0,"summary":"rezumat complet 4-5 propoziții"}]

Știri de rezumat:
${JSON.stringify(toSummarize)}`;

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 3000 }
        }),
        signal: AbortSignal.timeout(30000)
      }
    );

    if (!res.ok) {
      console.log('  ⚠️ Gemini summarize:', res.status);
      return articles;
    }

    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
    const summaries = JSON.parse(text.replace(/```json|```/g, '').trim());
    summaries.forEach(s => {
      if (articles[s.id]) articles[s.id].desc = s.summary;
    });
    console.log(`  ✅ Rezumate generate: ${summaries.length} articole`);
  } catch(e) {
    console.log('  ⚠️ Summarize error:', e.message?.substring(0, 50));
  }
  return articles;
}

async function translateArticles(articles) {
  if (!articles.length) return articles;
  const enArticles = articles.filter(a => a.lang === 'en');
  
  console.log(`  🔄 Se traduc ${enArticles.length} articole EN→RO via MyMemory...`);
  
  for (const article of enArticles) {
    try {
      const translatedTitle = await translateText(article.title);
      if (translatedTitle) article.title = translatedTitle;
      if (article.desc) {
        const translatedDesc = await translateText(article.desc);
        if (translatedDesc) article.desc = translatedDesc;
      }
      article.translated = true;
      article.lang = 'ro';
      await new Promise(r => setTimeout(r, 200));
    } catch(e) {
      console.log('  ⚠️ Translation error for:', article.title?.substring(0, 30));
    }
  }
  console.log(`  ✅ Traduse ${enArticles.filter(a => a.translated).length}/${enArticles.length} articole`);
  return articles;
}

// ── CACHE REZUMATE AI (15 minute) ─────────────────────────
const GEMINI_KEY = 'AIzaSyDBgA8T0iIMLV7zfsm1mTU4snNzAz6USDk';
const aiSummaryCache = new Map(); // id -> { title, summary, ts }
const AI_CACHE_TTL = 15 * 60 * 1000; // 15 minute
let aiGenerating = false;

// Pre-generăm rezumate pentru primele 12 articole
async function preGenerateSummaries(articles) {
  if (aiGenerating || !articles.length) return;
  aiGenerating = true;
  
  // Filtrăm articolele care nu au rezumat în cache
  const toProcess = articles.filter(a => {
    const cached = aiSummaryCache.get(a.id);
    return !cached || (Date.now() - cached.ts > AI_CACHE_TTL);
  }).slice(0, 12);
  
  if (!toProcess.length) { aiGenerating = false; return; }
  
  try {
    const prompt = `Ești editorul Ai Știri Moldova. Pentru fiecare articol:
1. Dacă e în rusă/engleză — TRADUCE COMPLET în română
2. Rescrie TITLUL — max 12 cuvinte, informativ, fără clickbait
3. REZUMAT 3-4 propoziții: CE, UNDE, CÂND, DE CE contează. NU repeta titlul. Stil jurnalistic direct.

Returnează DOAR JSON valid:
[{"id":"...","title":"...","summary":"..."}]

Articole:
${JSON.stringify(toProcess.map(a => ({ id: a.id, title: a.title, text: (a.summary || '').substring(0, 400), lang: a.lang || 'ro' })))}`;

    const res = await fetchJson(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=\${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 4000 }
        })
      }
    );
    
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    
    parsed.forEach(item => {
      aiSummaryCache.set(item.id, {
        title: item.title,
        summary: item.summary,
        ts: Date.now()
      });
    });
    
    console.log(`  🤖 AI pre-generat: \${parsed.length} rezumate în cache`);
  } catch(e) {
    console.warn('  ⚠️  AI pre-generate error:', e.message);
  } finally {
    aiGenerating = false;
  }
}

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
  // Curățăm și cache-ul AI
  for (const [id, { ts }] of aiSummaryCache.entries()) {
    if (now - ts > AI_CACHE_TTL * 2) { aiSummaryCache.delete(id); cleaned++; }
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

  // PWA fișiere
  if (u.pathname === '/manifest.json') {
    try {
      const buf = fs.readFileSync(path.join(__dirname, 'manifest.json'));
      res.setHeader('Content-Type', 'application/manifest+json');
      res.writeHead(200); res.end(buf);
    } catch(e) { res.writeHead(404); res.end(); }
    return;
  }
  if (u.pathname === '/sw.js') {
    try {
      const buf = fs.readFileSync(path.join(__dirname, 'sw.js'));
      res.setHeader('Content-Type', 'application/javascript');
      res.setHeader('Service-Worker-Allowed', '/');
      res.writeHead(200); res.end(buf);
    } catch(e) { res.writeHead(404); res.end(); }
    return;
  }
  if (u.pathname === '/icon-192.png' || u.pathname === '/icon-512.png') {
    // Servim logo.svg ca icon (browserul îl acceptă)
    try {
      const buf = fs.readFileSync(path.join(__dirname, 'logo.svg'));
      res.setHeader('Content-Type', 'image/svg+xml');
      res.writeHead(200); res.end(buf);
    } catch(e) { res.writeHead(404); res.end(); }
    return;
  }

  if (u.pathname === '/ai-cache') {
    // Returnează rezumatele pre-generate din cache
    const result = {};
    aiSummaryCache.forEach((val, key) => {
      if (Date.now() - val.ts < AI_CACHE_TTL) {
        result[key] = { title: val.title, summary: val.summary };
      }
    });
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.writeHead(200);
    res.end(JSON.stringify(result));
    return;
  }

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


  // ── ANALYTICS ──────────────────────────────────────────
  if (u.pathname === '/analytics' && req.method === 'POST') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const today = new Date().toISOString().split('T')[0];
        if (!analyticsData.sessions[data.sid]) {
          analyticsData.sessions[data.sid] = { first: Date.now(), zone: data.zone, age: data.age, device: data.device, ref: data.ref, interests: data.interests, pwa: data.pwa };
          analyticsData.total++;
        }
        analyticsData.sessions[data.sid].last = Date.now();
        analyticsData.sessions[data.sid].cat = data.cat;
        if (!analyticsData.daily[today]) analyticsData.daily[today] = { visitors: [], zones: {}, devices: {} };
        const day = analyticsData.daily[today];
        if (!day.visitors.includes(data.sid)) day.visitors.push(data.sid);
        day.zones[data.zone] = (day.zones[data.zone] || 0) + 1;
        day.devices[data.device] = (day.devices[data.device] || 0) + 1;
        res.writeHead(200); res.end('{"ok":true}');
      } catch(e) { res.writeHead(400); res.end('{}'); }
    });
    return;
  }

  if (u.pathname === '/analytics/stats') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    const today = new Date().toISOString().split('T')[0];
    const day = analyticsData.daily[today] || {};
    const last7 = Array.from({length:7}, (_, i) => {
      const d = new Date(Date.now() - i * 86400000).toISOString().split('T')[0];
      const dd = analyticsData.daily[d] || {};
      return { date: d, visitors: (dd.visitors||[]).length };
    }).reverse();
    const zones = {}, devices = {};
    Object.values(analyticsData.sessions).forEach(s => {
      zones[s.zone] = (zones[s.zone]||0)+1;
      devices[s.device] = (devices[s.device]||0)+1;
    });
    res.writeHead(200);
    res.end(JSON.stringify({ total: analyticsData.total, today: (day.visitors||[]).length, last7, zones, devices, pwa: Object.values(analyticsData.sessions).filter(s=>s.pwa).length }));
    return;
  }

  if (u.pathname === '/mondial') {
    try {
      const buf = fs.readFileSync(path.join(__dirname, 'mondial.html'));
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.writeHead(200); res.end(buf);
    } catch(e) { res.writeHead(404); res.end('Mondial page not found'); }
    return;
  }

  if (u.pathname === '/mondial-news') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    // Cache 15 minute
    const cacheKey = 'mondial_news';
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < 30 * 60 * 1000) {
      res.writeHead(200);
      res.end(JSON.stringify(cached.data));
      return;
    }

    // Cuvinte cheie CM 2026 — titlu SAU descriere
    // Cuvinte cheie CM 2026 cu word boundaries pentru precizie
    const WC_PHRASES = [
      'mondial','world cup','cm 2026','cupa mondiala','fifa 2026',
      'mexic vs','africa de sud','coreea de sud',
      'anglia vs','croatia vs','brazilia vs','argentina vs',
      'mbappe','neymar','vinicius jr','lewandowski','bellingham',
      'yamal','pedri','wirtz','musiala','griezmann','rashford',
      'raphinha','rodrygo','camavinga','tchouameni',
      'estadio azteca','metlife stadium','sofi stadium',
      'lot national','convocati','convocari','cupa mondiala',
      'grupe cm','optimi mondiale','sferturi mondiale'
    ];
    // Cuvinte standalone (cu word boundaries)
    const WC_WORDS = [
      'messi','ronaldo','kane','modric','salah','benzema',
      'scaloni','southgate','deschamps','nagelsmann','ancelotti',
      'azteca','metlife','mundial','fifa','concacaf','conmebol'
    ];
    const WC_KW_PHRASES = new RegExp(WC_PHRASES.join('|'), 'i');
    const WC_KW_WORDS = new RegExp('\\b(' + WC_WORDS.join('|') + ')\\b', 'i');
    const WC_KW = { test: (s) => WC_KW_PHRASES.test(s) || WC_KW_WORDS.test(s) };
    
    const FEEDS = [
      // România — sport (cele mai bune surse RO)
      { url: 'https://www.gsp.ro/rss/', lang: 'ro' },
      { url: 'https://www.prosport.ro/feed/', lang: 'ro' },
      { url: 'https://www.digisport.ro/rss/', lang: 'ro' },
      { url: 'https://www.sport.ro/rss/sport.xml', lang: 'ro' },
      { url: 'https://www.orangesport.ro/rss/', lang: 'ro' },
      // Internațional EN — fotbal mondial
      { url: 'https://feeds.bbci.co.uk/sport/football/rss.xml', lang: 'en' },
      { url: 'https://www.goal.com/feeds/en/news', lang: 'en' },
      { url: 'https://www.90min.com/posts.rss', lang: 'en' },
      { url: 'https://www.espn.com/espn/rss/soccer/news', lang: 'en' },
      { url: 'https://www.skysports.com/rss/12040', lang: 'en' },
      { url: 'https://rss.dw.com/rdf/rss-en-sports', lang: 'en' },
    ];

    let items = [];
    
    for (const feed of FEEDS) {
      const feedUrl = feed.url;
      try {
        const r = await fetch(feedUrl, { 
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AiStiri/1.0; +https://aistiri.com)' },
          signal: AbortSignal.timeout(8000)
        });
        if (!r.ok) continue;
        const xml = await r.text();
        const src = new URL(feedUrl).hostname.replace('www.', '');
        
        // Parsăm XML simplu
        const itemMatches = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
        itemMatches.slice(0, 50).forEach(item => {
          const title = (item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || item.match(/<title>(.*?)<\/title>/) || [])[1] || '';
          const desc = (item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/) || item.match(/<description>(.*?)<\/description>/) || [])[1] || '';
          const link = (item.match(/<link>(.*?)<\/link>/) || [])[1] || '#';
          const img = (item.match(/url="([^"]*\.(jpg|jpeg|png|webp))"/) || [])[1] || null;
          const pubDate = (item.match(/<pubDate>(.*?)<\/pubDate>/) || [])[1] || '';
          
          const cleanDesc = desc.replace(/<[^>]+>/g, '').substring(0, 400);
          const cleanTitle = title.replace(/<[^>]+>/g, '').trim();
          
          if (cleanTitle && (WC_KW.test(cleanTitle) || WC_KW.test(cleanDesc))) {
            items.push({ title: cleanTitle, desc: cleanDesc, link, img, src, pubDate, lang: feed.lang });
          }
        });
      } catch(e) {
        console.log('  ⚠️ Feed error:', feed.url, e.message?.substring(0,50));
      }
    }

    // Păstrăm știrile din ultimele 48 de ore (2 zile)
    const cutoff = Date.now() - 48 * 60 * 60 * 1000;
    items = items.filter(a => {
      if (!a.pubDate) return true; // fără dată = includem
      return new Date(a.pubDate).getTime() > cutoff;
    });
    items.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
    items = items.slice(0, 15);

    // Traducem + rezumăm pe server (o singură dată, nu per utilizator)
    const translatedItems = await translateArticles(items);
    const summarizedItems = await summarizeArticles(translatedItems);
    
    cache.set(cacheKey, { data: summarizedItems, ts: Date.now() });
    res.writeHead(200);
    res.end(JSON.stringify(summarizedItems));
    return;
  }

  if (u.pathname === '/admin') {
    try {
      const buf = fs.readFileSync(path.join(__dirname, 'admin.html'));
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Length', buf.length);
      res.writeHead(200); res.end(buf);
    } catch(e) { res.writeHead(404); res.end('Admin page not found'); }
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
