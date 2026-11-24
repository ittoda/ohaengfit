// 오행핏 서버: 화면 파일 제공 + Pi 주소 확인 + Pi 로그인 확인 (프리미엄 결제는 다음 단계에서)
const http = require('http'), https = require('https'), fs = require('fs'), path = require('path');
const PORT = process.env.PORT || 8080;
const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'],
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
