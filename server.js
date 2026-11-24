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
async function uidOf(token){if(!token)return null;const c=ME_CACHE.get(token);if(c&&Date.now()-c.t<3600e3){stPi(c.uid);return c.uid}const me=await piMe(String(token));if(!me)return null;ME_CACHE.set(token,{uid:me.uid,t:Date.now()});stPi(me.uid);if(me.username)redis(['HSET','oh:names',me.uid,me.username]).catch(()=>{});return me.uid}
// ===== 프리미엄: 항목별 0.1π 또는 100토큰, 오늘 하루 열림 (한국 자정에 다시 잠김) =====
const AD_PT = 10, AD_MAX = 20; // 광고 1회 10토큰, 하루 20회
function rankSet(uid, bal) { return redis(['ZADD', 'oh:rank', String(bal || 0), uid]).catch(() => null) } // 토큰 순위
const PREM_ITEMS = ['body', 'food', 'ex', 'nut', 'palm'], PREM_PI = 0.1, PREM_TOKENS = 100;
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
  if ((await redis(['SET', SP + 'paid:' + paymentId, '1', 'NX', 'EX', '2592000'])) === 'OK') { stIncr('pay'); stIncr('payPi', Number(p.amount) || 0); redis(['HINCRBY', SP + 'item', item, '1']).catch(() => {}) }
  return addUnlock(p.user_uid, item);
}
// ===== 테스트넷 전용: 앱 → 사용자 테스트 파이 보내기 (메인넷 지갑 신청 조건: 5명) =====
// Render 테스트넷 서비스에서 TESTNET=1, PI_API_KEY(테스트넷 앱 키), PI_WALLET_SEED(테스트넷 지갑 S...) 를 넣으면 작동
const IS_TESTNET = !!upEnv('testnet');
let PIB = null; function piBackend() { if (PIB) return PIB; try { const m = require('pi-backend'); const P = m.default || m; PIB = new P(upEnv('piapikey'), upEnv('piwalletseed')); } catch (e) { console.log('pi-backend', e.message) } return PIB }
// ===== 사장님만 보는 통계 (/stats?key=...) — 맞고와 같은 방식, Upstash에 계속 저장 =====
const STATS_KEY = upEnv('statskey') || 'a7c31e94';
const SP = 'oh:st:' + (IS_TESTNET ? 't:' : ''); // 테스트넷 기록은 따로
const stIncr = (k, n) => { const d = kstDay(); const c = n == null ? 'INCR' : 'INCRBYFLOAT', a = n == null ? [] : [String(n)]; redis([c, SP + k + ':' + d, ...a]).catch(() => {}); redis([c, SP + k + ':all', ...a]).catch(() => {}) };
const stAdd = async (k, v) => { const d = kstDay(); redis(['SADD', SP + k + ':' + d, v]).catch(() => {}); return redis(['SADD', SP + k + ':all', v]).catch(() => 0) };
const PI_SEEN = new Map(); // uid → 마지막으로 센 날짜
function stPi(uid) { const d = kstDay(); if (PI_SEEN.get(uid) === d) return; PI_SEEN.set(uid, d); if (PI_SEEN.size > 20000) PI_SEEN.clear(); stAdd('pi', uid) }
const A2U_DONE = new Set(); const A2U_NAMES = new Map();
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
  if (url === '/checkin' && req.method === 'POST') { // 출석 체크: 하루 10토큰, 7일째 +30 (7일 = 100토큰), 한국 날짜 기준. run = 끊기지 않은 전체 연속 출석일(출석왕 이벤트용)
    const q = await body(req); const uid = await uidOf(q.token); res.setHeader('Content-Type', 'application/json');
    if (!uid) { res.writeHead(401); return res.end('{"ok":false}'); }
    const today = kstDay(), yest = new Date(Date.now() + 9 * 3600e3 - 864e5).toISOString().slice(0, 10);
    let st = { bal: 0, streak: 0, last: '', run: 0, adDay: '', adN: 0 }; try { const v = await redis(['GET', 'oh:pt:' + uid]); if (v) st = Object.assign(st, JSON.parse(v)) } catch (e) {}
    if (st.last !== today && st.last !== yest) { st.streak = 0; st.run = 0 } // 하루 빠지면 처음부터
    const out = (done, award) => JSON.stringify({ ok: true, bal: st.bal, streak: st.streak, run: st.run || 0, done, award, adN: st.adDay === today ? st.adN : 0, adMax: AD_MAX, un: null });
    if (q.peek || st.last === today) { if (st.bal > 0) rankSet(uid, st.bal); const o = JSON.parse(out(st.last === today, 0)); o.un = await unlocks(uid); res.writeHead(200); return res.end(JSON.stringify(o)); }
    st.streak = st.streak >= 7 ? 1 : st.streak + 1; st.run = (st.run || 0) + 1; const award = 10 + (st.streak === 7 ? 30 : 0);
    st.bal += award; st.last = today;
    const r = await redis(['SET', 'oh:pt:' + uid, JSON.stringify(st)]);
    if (r !== 'OK') { res.writeHead(500); return res.end('{"ok":false}'); }
    rankSet(uid, st.bal); stIncr('ck');
    const o = JSON.parse(out(true, award)); o.un = await unlocks(uid); res.writeHead(200); return res.end(JSON.stringify(o));
  }
  if (url === '/rank' && req.method === 'POST') { // 토큰 순위 상위 20명 + 내 순위 (아이디는 일부 가려서)
    const q = await body(req); const uid = await uidOf(q.token); res.setHeader('Content-Type', 'application/json');
    const z = await redis(['ZREVRANGE', 'oh:rank', '0', '19', 'WITHSCORES']) || [];
    const ids = [], top = []; for (let i = 0; i < z.length; i += 2) { ids.push(z[i]); top.push({ s: +z[i + 1] }) }
    const nm = ids.length ? (await redis(['HMGET', 'oh:names', ...ids]) || []) : [];
    const mask = n => { n = String(n || 'pioneer'); return n.length <= 3 ? n[0] + '**' : n.slice(0, Math.ceil(n.length / 2)) + '*'.repeat(Math.min(4, Math.floor(n.length / 2))) };
    top.forEach((t, i) => { t.n = mask(nm[i]); t.me = ids[i] === uid });
    let me = null; if (uid) { const rk = await redis(['ZREVRANK', 'oh:rank', uid]); const sc = await redis(['ZSCORE', 'oh:rank', uid]); if (rk !== null && rk !== undefined) me = { r: +rk + 1, s: +sc } }
    res.writeHead(200); return res.end(JSON.stringify({ ok: true, top, me }));
  }
  if (url === '/ad/reward' && req.method === 'POST') { // 보상형 광고 1회 = 10토큰, 하루 10회. Pi 서버로 광고 시청을 확인한 뒤에만 지급
    const q = await body(req); const uid = await uidOf(q.token); res.setHeader('Content-Type', 'application/json');
    if (!uid) { res.writeHead(401); return res.end('{"ok":false}'); }
    const adId = String(q.adId || '').replace(/[^\w-]/g, '').slice(0, 120);
    const today = kstDay(); let st = await getJSON('oh:pt:' + uid, { bal: 0, streak: 0, last: '' });
    if (st.adDay !== today) { st.adDay = today; st.adN = 0 }
    if (st.adN >= AD_MAX) { res.writeHead(200); return res.end(JSON.stringify({ ok: false, why: 'max', bal: st.bal, adN: st.adN, adMax: AD_MAX })); }
    if (adId) { // 광고 번호가 있으면 Pi 서버에서 확인 (확인이 늦게 올 수 있어 몇 번 다시 물어봐요)
      let ad = null; for (let i = 0; i < 4; i++) { ad = await piApi('GET', '/ads_network/status/' + encodeURIComponent(adId)); if (ad && ad.mediator_ack_status) break; await new Promise(r => setTimeout(r, 1500)) }
      if (!ad || ad.mediator_ack_status !== 'granted') { res.writeHead(200); return res.end('{"ok":false,"why":"verify"}'); }
      const used = await redis(['SET', 'oh:ad:' + adId, uid, 'NX', 'EX', '172800']); // 같은 광고로 두 번 받기 방지
      if (used !== 'OK') { res.writeHead(200); return res.end('{"ok":false,"why":"used"}'); }
    } // 광고 승인 전에는 Pi가 광고 번호를 안 줘요 → 하루 20회 제한만 두고 지급 (맞고와 같은 방식, 앱 안 토큰일 뿐)
    st.adN++; st.bal = (st.bal || 0) + AD_PT;
    if ((await redis(['SET', 'oh:pt:' + uid, JSON.stringify(st)])) !== 'OK') { res.writeHead(500); return res.end('{"ok":false}'); }
    rankSet(uid, st.bal); stIncr('ad'); res.writeHead(200); return res.end(JSON.stringify({ ok: true, award: AD_PT, bal: st.bal, adN: st.adN, adMax: AD_MAX }));
  }
  if (url === '/premium/token' && req.method === 'POST') { // 100토큰으로 열기
    const q = await body(req); const uid = await uidOf(q.token); res.setHeader('Content-Type', 'application/json');
    if (!uid || PREM_ITEMS.indexOf(q.item) < 0) { res.writeHead(400); return res.end('{"ok":false}'); }
    let un = await unlocks(uid); const st = await getJSON('oh:pt:' + uid, { bal: 0, streak: 0, last: '' });
    if (un.indexOf(q.item) >= 0) { res.writeHead(200); return res.end(JSON.stringify({ ok: true, bal: st.bal, un })); }
    if ((st.bal || 0) < PREM_TOKENS) { res.writeHead(200); return res.end(JSON.stringify({ ok: false, why: 'bal', bal: st.bal || 0, un })); }
    st.bal -= PREM_TOKENS; if ((await redis(['SET', 'oh:pt:' + uid, JSON.stringify(st)])) !== 'OK') { res.writeHead(500); return res.end('{"ok":false}'); }
    rankSet(uid, st.bal); stIncr('tk'); redis(['HINCRBY', SP + 'item', q.item, '1']).catch(() => {}); un = await addUnlock(uid, q.item); res.writeHead(200); return res.end(JSON.stringify({ ok: true, bal: st.bal, un }));
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
  if (url === '/hit' && req.method === 'POST') { // 방문 기기 수 (기기마다 한 번씩, 이름·개인정보 없음)
    const q = await body(req); const dev = String(q.d || '').replace(/[^\w-]/g, '').slice(0, 40);
    if (dev) { const isNew = await stAdd('dev', dev); if (isNew === 1) redis(['HINCRBY', SP + 'lang', String(q.l || '?').replace(/[^\w-]/g, '').slice(0, 8) || '?', '1']).catch(() => {}) }
    res.writeHead(204); return res.end();
  }
  if (url === '/stats') { // 사장님만 보는 통계
    const q = new URL(req.url, 'http://x').searchParams;
    if (q.get('key') !== STATS_KEY) { res.writeHead(404); return res.end('Not found'); }
    const num = async k => Number(await redis(['GET', SP + k]) || 0), card = async k => Number(await redis(['SCARD', SP + k]) || 0);
    const hash = async k => { const f = await redis(['HGETALL', SP + k]) || []; const o = []; for (let i = 0; i < f.length; i += 2) o.push([f[i], +f[i + 1]]); return o.sort((a, b) => b[1] - a[1]) };
    const days = []; for (let i = 0; i < 7; i++) days.push(new Date(Date.now() + 9 * 3600e3 - i * 864e5).toISOString().slice(0, 10));
    const row = async d => [d, await card('dev:' + d), await card('pi:' + d), await num('ck:' + d), await num('ad:' + d), await num('tk:' + d), await num('pay:' + d), Math.round(await num('payPi:' + d) * 100) / 100];
    const [rows, T, items, langs, ranked] = await Promise.all([Promise.all(days.map(row)), row('all'), hash('item'), hash('lang'), redis(['ZCARD', 'oh:rank'])]);
    const ok = !!upEnv('upstashredisresturl');
    const IT = { body: '나의 몸', food: '음식', ex: '운동', nut: '영양', palm: '손금' };
    const td = rows.map(r => '<tr>' + r.map(x => '<td>' + x + '</td>').join('') + '</tr>').join('');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>오행핏 통계</title><style>body{font-family:sans-serif;background:#241446;color:#f3eeff;padding:16px;line-height:1.6}table{border-collapse:collapse;width:100%;font-size:13px}td,th{border-bottom:1px solid #4a3480;padding:7px 3px;text-align:center}th{color:#c9b6ff;font-weight:600}b{color:#ffd66b;font-size:1.35em}.n{opacity:.65;font-size:.85em}.c{background:#33205e;border-radius:14px;padding:12px 14px;margin:12px 0}</style>
<h2>🌿 오행핏 통계${IS_TESTNET ? ' (테스트넷)' : ''}</h2>
<div class=c>누적 방문 기기 <b>${T[1]}</b> · 누적 Pi 로그인 <b>${T[2]}</b><br>출석 체크 <b>${T[3]}</b>회 · 광고 보상 <b>${T[4]}</b>회<br>토큰으로 열기 <b>${T[5]}</b>회 · 파이 결제 <b>${T[6]}</b>건 (<b>${T[7]}</b> π)<br>토큰 순위에 오른 사람 <b>${ranked || 0}</b>명</div>
<table><tr><th>날짜</th><th>방문</th><th>Pi 로그인</th><th>출석</th><th>광고</th><th>토큰열기</th><th>결제</th><th>π</th></tr>${td}</table>
<div class=c>프리미엄 많이 연 항목: ${items.length ? items.map(([k, v]) => (IT[k] || k) + ' <b>' + v + '</b>').join(' · ') : '아직 없어요'}</div>
<div class=c>처음 방문한 기기 언어: ${langs.length ? langs.slice(0, 10).map(([k, v]) => k + ' <b>' + v + '</b>').join(' · ') : '아직 없어요'}</div>
<p class=n>날짜는 한국 시간 기준 · 저장: ${ok ? 'Upstash (계속 유지)' : '저장소 연결 안 됨'} · 방문은 이 기능을 넣은 뒤부터 세요</p>`);
  }
  if (url === '/auth' && req.method === 'POST') {
    const { token } = await body(req); const me = token ? await piMe(String(token)) : null;
    res.writeHead(me ? 200 : 401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(me ? { ok: true, uid: me.uid, username: me.username } : { ok: false }));
  }
  if (IS_TESTNET && (url === '/' || url === '/index.html')) { // 테스트넷 주소로 열면 테스트 파이 받기 화면
    fs.readFile(path.join(__dirname, 'testpi.html'), (e, b) => { res.writeHead(e ? 404 : 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }); res.end(e ? 'Not found' : b) }); return;
  }
  if (IS_TESTNET && url === '/a2u/count') {
    let names = [...A2U_NAMES.values()], db = false;
    try { const k = await redis(['KEYS', 'oh:a2u:*']); if (Array.isArray(k)) { db = true; const ids = k.map(x => x.slice(7)); const nm = ids.length ? (await redis(['HMGET', 'oh:names', ...ids]) || []) : []; names = ids.map((id, i) => nm[i] || A2U_NAMES.get(id) || '?'); } } catch (e) {}
    const mask = u => u.length <= 2 ? u[0] + '*' : u.slice(0, 2) + '*'.repeat(Math.min(4, u.length - 2));
    res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ n: names.length, names: names.map(mask), db }));
  }
  if (IS_TESTNET && url === '/a2u' && req.method === 'POST') {
    const q = await body(req); res.setHeader('Content-Type', 'application/json');
    const me = q.token ? await piMe(String(q.token)) : null;
    if (!me) { res.writeHead(401); return res.end('{"ok":false,"why":"login"}'); }
    const done = (await redis(['GET', 'oh:a2u:' + me.uid])) || A2U_DONE.has(me.uid);
    if (done) { res.writeHead(200); return res.end(JSON.stringify({ ok: true, again: true, user: me.username })); }
    const pi = piBackend(); if (!pi) { res.writeHead(500); return res.end('{"ok":false,"why":"setup"}'); }
    try {
      const pid = await pi.createPayment({ amount: 0.01, memo: 'Ohaengfit test reward', metadata: { kind: 'a2u-test' }, uid: me.uid });
      const txid = await pi.submitPayment(pid); await pi.completePayment(pid, txid);
      A2U_DONE.add(me.uid); A2U_NAMES.set(me.uid, me.username || '?'); redis(['SET', 'oh:a2u:' + me.uid, txid]).catch(() => {}); if (me.username) redis(['HSET', 'oh:names', me.uid, me.username]).catch(() => {});
      res.writeHead(200); return res.end(JSON.stringify({ ok: true, user: me.username, txid }));
    } catch (e) {
      console.log('a2u', e && (e.response && JSON.stringify(e.response.data) || e.message));
      try { const inc = await pi.getIncompleteServerPayments(); for (const p of inc || []) { try { if (p.transaction && p.transaction.txid) await pi.completePayment(p.identifier, p.transaction.txid); else await pi.cancelPayment(p.identifier) } catch (x) {} } } catch (x) {}
      res.writeHead(200); return res.end(JSON.stringify({ ok: false, why: 'pay', msg: String((e && e.response && e.response.data && JSON.stringify(e.response.data)) || (e && e.message) || e).slice(0, 300) }));
    }
  }
  const f = FILES[url];
  if (!f) { res.writeHead(404); return res.end('Not found'); }
  fs.readFile(path.join(__dirname, f[0]), (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': f[1], 'Cache-Control': f[1].startsWith('audio') ? 'public, max-age=86400' : 'no-cache', 'Content-Length': buf.length });
    res.end(buf);
  });
}).listen(PORT, () => console.log('ohaengfit on', PORT));
