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
for (const n of ["done", "eight", "eighteen", "eleven", "fifteen", "five", "four", "fourteen", "letsgo", "next", "nine", "nineteen", "one", "rest", "seven", "seventeen", "six", "sixteen", "ten", "thirteen", "three", "twelve", "twenty", "two","beat"]) FILES['/voice/' + n + '.mp3'] = ['voice/' + n + '.mp3', 'audio/mpeg'];
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
// ===== 프리미엄: 항목별 0.1π 또는 50토큰, 오늘 하루 열림 (한국 자정에 다시 잠김) =====
const PREM_ITEMS = ['body', 'food', 'ex', 'nut', 'palm'], PREM_PI = 0.1, PREM_TOKENS = 50;
async function getJSON(k, d) { try { const v = await redis(['GET', k]); return v ? JSON.parse(v) : d } catch (e) { return d } }
const kstDay = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); // 한국 날짜
async function unlockMap(uid) { const m = await getJSON('oh:un:' + uid, {}); return m && !Array.isArray(m) && typeof m === 'object' ? m : {} }
async function unlocks(uid) { const m = await unlockMap(uid), d = kstDay(); return Object.keys(m).filter(k => m[k] === d) } // 오늘 연 항목만 (자정에 다시 잠김)
async function addUnlock(uid, item) { const m = await unlockMap(uid); m[item] = kstDay(); await redis(['SET', 'oh:un:' + uid, JSON.stringify(m)]); return unlocks(uid) }
function piApi(method, p, data) { // Pi 서버 결제 API (앱 키는 Render 환경변수 PI_API_KEY)
  const key = upEnv('piapikey'); if (!key) return Promise.resolve(null);
  return new Promise(res => { const b = data ? JSON.stringify(data) : '';
    const rq = https.request({ host: 'api.minepi.com', path: '/v2' + p, method, headers: { Authorization: 'Key ' + key, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) }, timeout: 15000 }, r => { let t = ''; r.on('data', d => t += d); r.on('end', () => { try { res(r.statusCode < 300 ? JSON.parse(t) : null) } catch (e) { res(null) } }) });
    rq.on('error', () => res(null)); rq.on('timeout', () => { rq.destroy(); res(null) }); rq.end(b) });
}
async function finishPay(paymentId, txid) { // 결제 완료 처리 + 항목 열기
  const p = await piApi('GET', '/payments/' + encodeURIComponent(paymentId)); if (!p) return null;
  const item = p.metadata && p.metadata.item; if (PREM_ITEMS.indexOf(item) < 0 || Number(p.amount) < PREM_PI) return null;
  if (!(p.status && p.status.developer_completed)) { const tx = txid || (p.transaction && p.transaction.txid); if (!tx) return null; const c = await piApi('POST', '/payments/' + encodeURIComponent(paymentId) + '/complete', { txid: tx }); if (!c) return null }
  return addUnlock(p.user_uid, item);
}
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
  if (url === '/checkin' && req.method === 'POST') { // 출석 체크: 하루 10토큰, 7일째 +30 (7일 = 100토큰), 한국 날짜 기준
    const q = await body(req); const uid = await uidOf(q.token); res.setHeader('Content-Type', 'application/json');
    if (!uid) { res.writeHead(401); return res.end('{"ok":false}'); }
    const day = o => new Date(Date.now() + 9 * 3600e3 - o * 864e5).toISOString().slice(0, 10), today = day(0), yest = day(1);
    let st = { bal: 0, streak: 0, last: '' }; try { const v = await redis(['GET', 'oh:pt:' + uid]); if (v) st = Object.assign(st, JSON.parse(v)) } catch (e) {}
    if (st.last !== today && st.last !== yest) st.streak = 0; // 하루 빠지면 처음부터
    if (q.peek || st.last === today) { res.writeHead(200); return res.end(JSON.stringify({ ok: true, bal: st.bal, streak: st.streak, done: st.last === today, award: 0, un: await unlocks(uid) })); }
    st.streak = st.streak >= 7 ? 1 : st.streak + 1; const award = 10 + (st.streak === 7 ? 30 : 0);
    st.bal += award; st.last = today;
    const r = await redis(['SET', 'oh:pt:' + uid, JSON.stringify(st)]);
    if (r !== 'OK') { res.writeHead(500); return res.end('{"ok":false}'); }
    res.writeHead(200); return res.end(JSON.stringify({ ok: true, bal: st.bal, streak: st.streak, done: true, award, un: await unlocks(uid) }));
  }
  if (url === '/premium/token' && req.method === 'POST') { // 50토큰으로 열기
    const q = await body(req); const uid = await uidOf(q.token); res.setHeader('Content-Type', 'application/json');
    if (!uid || PREM_ITEMS.indexOf(q.item) < 0) { res.writeHead(400); return res.end('{"ok":false}'); }
    let un = await unlocks(uid); const st = await getJSON('oh:pt:' + uid, { bal: 0, streak: 0, last: '' });
    if (un.indexOf(q.item) >= 0) { res.writeHead(200); return res.end(JSON.stringify({ ok: true, bal: st.bal, un })); }
    if ((st.bal || 0) < PREM_TOKENS) { res.writeHead(200); return res.end(JSON.stringify({ ok: false, why: 'bal', bal: st.bal || 0, un })); }
    st.bal -= PREM_TOKENS; if ((await redis(['SET', 'oh:pt:' + uid, JSON.stringify(st)])) !== 'OK') { res.writeHead(500); return res.end('{"ok":false}'); }
    un = await addUnlock(uid, q.item); res.writeHead(200); return res.end(JSON.stringify({ ok: true, bal: st.bal, un }));
  }
  if (url === '/pay/approve' && req.method === 'POST') { // Pi 결제 승인
    const q = await body(req); const uid = await uidOf(q.token); res.setHeader('Content-Type', 'application/json');
    const p = q.paymentId ? await piApi('GET', '/payments/' + encodeURIComponent(q.paymentId)) : null;
    const ok = uid && p && p.user_uid === uid && PREM_ITEMS.indexOf(p.metadata && p.metadata.item) >= 0 && Number(p.amount) >= PREM_PI && await piApi('POST', '/payments/' + encodeURIComponent(q.paymentId) + '/approve');
    res.writeHead(ok ? 200 : 400); return res.end(JSON.stringify({ ok: !!ok }));
  }
  if ((url === '/pay/complete' || url === '/pay/incomplete') && req.method === 'POST') { // Pi 결제 완료 → 항목 열기
    const q = await body(req); res.setHeader('Content-Type', 'application/json');
    const un = q.paymentId ? await finishPay(String(q.paymentId), q.txid && String(q.txid)) : null;
    res.writeHead(un ? 200 : 400); return res.end(JSON.stringify({ ok: !!un, un }));
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
