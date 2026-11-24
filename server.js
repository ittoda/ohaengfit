// 오행핏 서버: 화면 파일 제공 + Pi 주소 확인 + Pi 로그인 확인 (프리미엄 결제는 다음 단계에서)
const http = require('http'), https = require('https'), fs = require('fs'), path = require('path');
const PORT = process.env.PORT || 8080;
const FILES = {
  '/': ['app.html', 'text/html; charset=utf-8'], '/index.html': ['app.html', 'text/html; charset=utf-8'],
  '/app.html': ['app.html', 'text/html; charset=utf-8'], '/premium.html': ['premium.html', 'text/html; charset=utf-8'],
  '/privacy.html': ['privacy.html', 'text/html; charset=utf-8'], '/terms.html': ['terms.html', 'text/html; charset=utf-8'],
  '/privacy': ['privacy.html', 'text/html; charset=utf-8'], '/terms': ['terms.html', 'text/html; charset=utf-8'],
  '/bgm.mp3': ['bgm.mp3', 'audio/mpeg'],
};
function piMe(token) { // Pi 서버에 이 로그인 토큰이 진짜인지 물어봐요
  return new Promise(res => {
    const rq = https.request({ host: 'api.minepi.com', path: '/v2/me', headers: { Authorization: 'Bearer ' + token }, timeout: 8000 }, r => {
      let b = ''; r.on('data', d => b += d); r.on('end', () => { try { res(r.statusCode === 200 ? JSON.parse(b) : null) } catch (e) { res(null) } });
    });
    rq.on('error', () => res(null)); rq.on('timeout', () => { rq.destroy(); res(null) }); rq.end();
  });
}

// Pi 계정별 저장 (Upstash Redis) — 생년월일·사진·설정을 앱을 닫아도 다시 불러오게
function upEnv(n){const k=Object.keys(process.env).find(x=>x.replace(/[^a-z]/gi,'').toLowerCase()===n);return k?String(process.env[k]).trim():''}
function redis(cmd){const url=upEnv('upstashredisresturl'),tok=upEnv('upstashredisresttoken');if(!url||!tok)return Promise.resolve(null);
  return new Promise(res=>{const u=new URL(url),body=JSON.stringify(cmd);
    const rq=https.request({host:u.host,path:u.pathname==='/'?'/':u.pathname,method:'POST',headers:{Authorization:'Bearer '+tok,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)},timeout:8000},r=>{let b='';r.on('data',d=>b+=d);r.on('end',()=>{try{res(JSON.parse(b).result)}catch(e){res(null)}})});
    rq.on('error',()=>res(null));rq.on('timeout',()=>{rq.destroy();res(null)});rq.end(body)})}
const ME_CACHE=new Map(); // 토큰 → uid (잠깐 기억해서 Pi 서버에 매번 묻지 않게)
async function uidOf(token){if(!token)return null;const c=ME_CACHE.get(token);if(c&&Date.now()-c.t<3600e3)return c.uid;const me=await piMe(String(token));if(!me)return null;ME_CACHE.set(token,{uid:me.uid,t:Date.now()});return me.uid}
function body(req) { return new Promise(res => { let b = ''; req.on('data', d => { b += d; if (b.length > 1e4) req.destroy() }); req.on('end', () => { try { res(JSON.parse(b || '{}')) } catch (e) { res({}) } }) }) }
http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/healthz') { res.writeHead(200); return res.end('ok'); }
  if (url === '/validation-key.txt') {
    const ek = Object.keys(process.env).find(k => k.replace(/[^a-z]/gi, '').toLowerCase() === 'pivalidationkey'); // 대소문자·띄어쓰기 달라도 찾기
    let key = String((ek && process.env[ek]) || '').trim();
    if (!key) { try { key = fs.readFileSync(path.join(__dirname, 'validation-key.txt'), 'utf8').trim() } catch (e) {} }
    if (!key) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end(key);
  }
  if (url === '/me' && req.method === 'POST') { // {token} → 불러오기, {token, data} → 저장
    let q; try { q = await new Promise((ok) => { let b = ''; req.on('data', d => { b += d; if (b.length > 600000) req.destroy() }); req.on('end', () => { try { ok(JSON.parse(b || '{}')) } catch (e) { ok({}) } }) }) } catch (e) { q = {} }
    const uid = await uidOf(q.token); res.setHeader('Content-Type', 'application/json');
    if (!uid) { res.writeHead(401); return res.end('{"ok":false}'); }
    if (q.data && typeof q.data === 'object') { const r = await redis(['SET', 'oh:me:' + uid, JSON.stringify(q.data).slice(0, 500000)]); res.writeHead(200); return res.end(JSON.stringify({ ok: r === 'OK' })); }
    const v = await redis(['GET', 'oh:me:' + uid]); let data = null; try { data = v ? JSON.parse(v) : null } catch (e) {}
    res.writeHead(200); return res.end(JSON.stringify({ ok: true, data }));
  }
  if (url === '/auth' && req.method === 'POST') {
    const { token } = await body(req); const me = token ? await piMe(String(token)) : null;
    res.writeHead(me ? 200 : 401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(me ? { ok: true, uid: me.uid, username: me.username } : { ok: false }));
  }
  const f = FILES[url];
  if (!f) { res.writeHead(404); return res.end('Not found'); }
  fs.readFile(path.join(__dirname, f[0]), (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': f[1], 'Cache-Control': f[1].startsWith('audio') ? 'public, max-age=86400' : 'no-cache', 'Content-Length': buf.length });
    res.end(buf);
  });
}).listen(PORT, () => console.log('ohaengfit on', PORT));
