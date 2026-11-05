/* NR 노트 — phone study app for the NR neurology notes.
   Data: manifest.json (public) + data/notes.bin and img/*.bin (AES-256-GCM, key = PBKDF2-SHA256(password, salt, iter)). */
'use strict';
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const LS = {
  get(k, d) { try { const v = localStorage.getItem('nr.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('nr.' + k, JSON.stringify(v)); } catch (e) {} },
  del(k) { try { localStorage.removeItem('nr.' + k); } catch (e) {} },
};
const b64 = { dec: s => Uint8Array.from(atob(s), c => c.charCodeAt(0)), enc: u => btoa(String.fromCharCode(...new Uint8Array(u))) };

const S = { man: null, key: null, notes: [], byId: {}, byKey: {}, gloss: {}, idx: null, imgUrl: {} };

/* ---------- crypto ---------- */
async function deriveKey(pw, man) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: b64.dec(man.salt), iterations: man.iter, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, true, ['decrypt']);
}
async function dec(key, buf) {
  const u = new Uint8Array(buf);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: u.slice(0, 12) }, key, u.slice(12));
}
async function gunzip(buf) {
  const ds = new DecompressionStream('gzip');
  return new Response(new Blob([buf]).stream().pipeThrough(ds)).arrayBuffer();
}
async function checkKey(key, man) {
  try { return new TextDecoder().decode(await dec(key, b64.dec(man.check))) === 'nrnote-ok'; } catch (e) { return false; }
}

/* ---------- boot ---------- */
async function boot() {
  applySettings();
  try {
    const r = await fetch('manifest.json', { cache: 'no-cache' });
    S.man = await r.json();
    LS.set('man', S.man);
  } catch (e) {
    S.man = LS.get('man', null);
    if (!S.man) return fatal('처음 실행은 인터넷 연결이 필요해요.');
  }
  const saved = LS.get('key', null);
  if (saved && saved.salt === S.man.salt) {
    try {
      const key = await crypto.subtle.importKey('raw', b64.dec(saved.raw), 'AES-GCM', true, ['decrypt']);
      if (await checkKey(key, S.man)) { S.key = key; return load(); }
    } catch (e) {}
  }
  lockScreen();
}
function fatal(msg) { $('#app').innerHTML = `<div class="lock"><div class="box"><h1>NR 노트</h1><p>${esc(msg)}</p></div></div>`; }

function lockScreen(err = '') {
  $('#app').innerHTML = `<div class="lock"><form class="box" id="lf">
    <h1>NR 노트</h1><p>신경과 학습노트 ${S.man.notes.length}개 · 비밀번호를 입력하세요</p>
    <input type="password" id="pw" autocomplete="current-password" placeholder="비밀번호" autofocus>
    <label><input type="checkbox" id="rem" checked> 이 기기에서 기억하기</label>
    <button class="btn" id="go">열기</button><div class="err" id="er">${esc(err)}</div>
    <div class="hint">아이폰: Safari 공유 버튼 → ‘홈 화면에 추가’로 앱처럼 쓸 수 있어요. 한 번 열면 인터넷 없이도 열립니다.</div>
  </form></div>`;
  $('#lf').onsubmit = async ev => {
    ev.preventDefault();
    const pw = $('#pw').value; if (!pw) return;
    $('#go').textContent = '여는 중…'; $('#go').disabled = true;
    const key = await deriveKey(pw, S.man);
    if (!(await checkKey(key, S.man))) { $('#go').disabled = false; $('#go').textContent = '열기'; $('#er').textContent = '비밀번호가 맞지 않아요.'; return; }
    S.key = key;
    if ($('#rem').checked) LS.set('key', { salt: S.man.salt, raw: b64.enc(await crypto.subtle.exportKey('raw', key)) });
    load();
  };
}

async function load() {
  $('#app').innerHTML = '<div class="lock"><div class="box"><p>노트를 여는 중…</p></div></div>';
  let buf;
  try {
    const r = await fetch('data/notes.bin?v=' + S.man.version);
    if (!r.ok) throw new Error(r.status);
    buf = await r.arrayBuffer();
  } catch (e) { return fatal('노트 파일을 받지 못했어요. 인터넷 연결을 확인해 주세요.'); }
  let data;
  try { data = JSON.parse(new TextDecoder().decode(await gunzip(await dec(S.key, buf)))); }
  catch (e) { LS.del('key'); return lockScreen('노트를 열지 못했어요. 비밀번호를 다시 입력해 주세요.'); }
  S.notes = data.notes; S.gloss = data.glossary || {};
  S.notes.forEach(n => { S.byId[n.id] = n; S.byKey[n.key] = n; });
  markUpdates();
  window.addEventListener('hashchange', route);
  route();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

/* ---------- updates: which notes changed since last seen ---------- */
function markUpdates() {
  const seen = LS.get('seen', null);
  S.changed = new Set();
  if (seen) S.man.notes.forEach(m => { if (seen[m.id] && seen[m.id] !== m.hash) S.changed.add(m.id); if (!seen[m.id]) S.changed.add(m.id); });
  if (!seen) LS.set('seen', Object.fromEntries(S.man.notes.map(m => [m.id, m.hash])));
  if (S.changed.size) toast(`노트 ${S.changed.size}개가 업데이트됐어요`);
}
function markSeen(id) {
  const seen = LS.get('seen', {}); const m = S.man.notes.find(x => x.id === id);
  if (m) { seen[id] = m.hash; LS.set('seen', seen); S.changed.delete(id); }
}

/* ---------- inline formatting ---------- */
function inl(t, hl) {
  let s = esc(t).replace(/([·\/])/g, '$1<wbr>').replace(/\(/g, '<wbr>(');
  s = s.replace(/==(.+?)==/g, '<mark class="hl">$1</mark>');
  s = s.replace(/!!(.+?)!!/g, '<span class="danger">$1</span>');
  s = s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  s = s.replace(/§(\d)\.([A-Za-z][A-Za-z0-9_]*)/g, (m, n, k) => {
    const note = S.byKey['§' + n + '.' + k] || S.notes.find(x => x.key.startsWith('§' + n + '.' + k));
    return note ? `<a class="xref" data-x="${esc(note.id)}" href="#/n/${encodeURIComponent(note.id)}">${m}</a>` : m;
  });
  if (hl && hl.length) s = highlight(s, hl);
  return s;
}
function highlight(html, terms) {
  const re = new RegExp('(' + terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'gi');
  return html.split(/(<[^>]+>)/).map(p => p.startsWith('<') ? p : p.replace(re, '<mark>$1</mark>')).join('');
}
const nice = s => String(s).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' · ');
const plain = t => String(t).replace(/!!|\*\*|==/g, '');

/* ---------- views ---------- */
function route() {
  closeSheet();
  const h = decodeURIComponent(location.hash.slice(1) || '/');
  const [, view, a, b] = h.split('/');
  if (view === 'n' && S.byId[a]) return noteView(S.byId[a], b);
  if (view === 'c') return catView(a);
  if (view === 's') return searchView(a || '');
  if (view === 'set') return settingsView();
  homeView();
}
function rowHtml(n, extra = '') {
  return `<div class="row" data-go="#/n/${encodeURIComponent(n.id)}"><div class="t">
    <div class="en">${esc(nice(n.en))} <span class="mark">${n.mark}</span>${S.changed.has(n.id) ? '<span class="dot"></span>' : ''}</div>
    <div class="ko">${esc(n.ko)}${extra}</div></div><div class="meta">${n.num}.${esc(n.numLabel)}</div></div>`;
}
function wireRows(el) { el.querySelectorAll('[data-go]').forEach(r => r.onclick = () => location.hash = r.dataset.go); }

function homeView() {
  window.scrollTo(0, 0);
  const cats = {}; S.notes.forEach(n => (cats[n.cat] = cats[n.cat] || { label: n.catLabel, n: 0 }).n++);
  const recent = LS.get('recent', []).map(id => S.byId[id]).filter(Boolean).slice(0, 6);
  const changed = S.notes.filter(n => S.changed.has(n.id));
  $('#app').innerHTML = `
  <div class="bar"><div class="bar-row"><h1>NR 노트</h1><button class="icon-btn" data-go="#/set" aria-label="설정">⚙︎</button></div>
    <div class="search" style="margin:4px 0 4px"><span>🔎</span><input id="q" type="search" placeholder="질환·약·검사·약어 검색 (예: GBS, 길랑, ㄱㄹㅂㄹ)" enterkeyhint="search"></div></div>
  <div class="wrap">
    ${changed.length ? `<div class="h2">업데이트된 노트 ${changed.length}</div><div class="card list">${changed.slice(0, 8).map(n => rowHtml(n)).join('')}</div>` : ''}
    ${recent.length ? `<div class="h2">최근 본 노트</div><div class="card list">${recent.map(n => rowHtml(n)).join('')}</div>` : ''}
    <div class="h2">분야 · 노트 ${S.notes.length}개</div>
    <div class="cat-grid">${Object.entries(cats).map(([c, v]) => `<div class="card cat" data-go="#/c/${encodeURIComponent(c)}"><b>${esc(v.label)}</b><span>${v.n}개 노트</span></div>`).join('')}</div>
    <div class="h2">표시</div><div class="card" style="padding:12px 14px;font-size:.86em;color:var(--sub)">★ 정밀 검증 · ☆ 핵심 숫자 대조 · <span class="dot" style="margin:0 4px 0 0"></span>지난번 본 뒤 바뀐 노트</div>
  </div>`;
  wireRows($('#app')); $('#app').querySelectorAll('.cat,[data-go="#/set"]').forEach(r => r.onclick = () => location.hash = r.dataset.go);
  const q = $('#q'); q.onkeydown = e => { if (e.key === 'Enter' && q.value.trim()) location.hash = '#/s/' + encodeURIComponent(q.value.trim()); };
}

function catView(cat) {
  window.scrollTo(0, 0);
  const list = S.notes.filter(n => n.cat === cat);
  const label = list[0] ? list[0].catLabel : cat;
  const filt = LS.get('catFilt', 'all');
  const show = list.filter(n => filt === 'all' || n.mark === filt);
  const groups = {}; show.forEach(n => (groups[n.num] = groups[n.num] || []).push(n));
  $('#app').innerHTML = `<div class="bar"><div class="bar-row"><button class="icon-btn" onclick="history.back()" aria-label="뒤로">‹</button><h1>${esc(label)}</h1></div>
    <div class="seg" style="margin:4px 0">${[['all', '전체'], ['★', '★ 정밀'], ['☆', '☆ 핵심']].map(([k, t]) => `<button data-f="${k}" class="${filt === k ? 'on' : ''}">${t}</button>`).join('')}</div></div>
    <div class="wrap">${Object.keys(groups).sort().map(k => `<div class="h2">${k}. ${esc(groups[k][0].numLabel)}</div><div class="card list">${groups[k].map(n => rowHtml(n)).join('')}</div>`).join('') || '<div class="empty">해당하는 노트가 없어요</div>'}</div>`;
  wireRows($('#app'));
  $('#app').querySelectorAll('[data-f]').forEach(b => b.onclick = () => { LS.set('catFilt', b.dataset.f); catView(cat); });
}

const SEC_SHORT = ['정의', '핵심', '접근', '검사', '감별', '치료', '숫자', '최신', '기출', '문헌'];
function secLabel(h, i) {
  const m = h.match(/^(\d+)\.\s*(.+)$/); const n = m ? m[1] : String(i + 1);
  return { n, short: SEC_SHORT[+n - 1] || (m ? m[2] : h).slice(0, 6), full: m ? m[2] : h };
}

function blockHtml(b, hl) {
  if (b.p) return `<p>${inl(b.p, hl)}</p>`;
  if (b.subhead) return `<div class="sub">${inl(b.subhead, hl)}</div>`;
  if (b.note) return `<div class="notebox">${inl(b.note, hl)}</div>`;
  if (b.bullets) {
    const ul = `<ul>${b.bullets.map(x => `<li>${inl(x, hl)}</li>`).join('')}</ul>`;
    return b.key ? `<div class="key">${ul}</div>` : ul;
  }
  if (b.table) {
    const t = b.table, cols = (t.header || t.rows[0] || []).length;
    return `<div class="tw${cols >= 4 ? ' wide' : ''}"><table>${t.header ? `<thead><tr>${t.header.map(c => `<th>${inl(c, hl)}</th>`).join('')}</tr></thead>` : ''}
      <tbody>${t.rows.map(r => `<tr>${r.map(c => `<td>${inl(c, hl)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }
  if (b.image) {
    const im = b.image;
    return `<figure><div class="ph" data-img="${im.id}" style="aspect-ratio:${im.w}/${im.h}">그림 불러오는 중…</div>
      ${b.caption ? `<figcaption>${inl(b.caption, hl)}</figcaption>` : ''}</figure>`;
  }
  return '';
}

function noteView(n, sec) {
  const quick = LS.get('quick', false);
  const recent = LS.get('recent', []).filter(x => x !== n.id); recent.unshift(n.id); LS.set('recent', recent.slice(0, 20));
  const hl = (sessionStorage.getItem('nr.hl') || '').split('\u0001').filter(Boolean);
  const secs = n.sections.map((s, i) => ({ s, i, lab: secLabel(s.h, i) }));
  const shown = quick ? secs.filter(x => ['2', '7'].includes(x.lab.n)) : secs;
  $('#app').innerHTML = `
  <div class="bar"><div class="bar-row"><button class="icon-btn" onclick="history.length>1?history.back():location.hash='#/'" aria-label="뒤로">‹</button>
    <h1>${esc(nice(n.en))} <span class="mark">${n.mark}</span></h1>
    <button class="icon-btn" id="qk" aria-label="빠른 보기" title="빠른 보기(핵심+숫자)">${quick ? '📖' : '⚡'}</button></div>
    <div class="chips">${shown.map(x => `<button class="chip" data-s="${x.lab.n}">${x.lab.n} ${esc(x.lab.short)}</button>`).join('')}</div></div>
  <div class="note-head"><div class="tag">${esc(n.catLabel)} · ${n.num}.${esc(n.numLabel)} · ${esc(n.key)}${n.updated ? ' · ' + esc(n.updated) : ''}</div>
    <h2>${inl(n.title)}</h2></div>
  ${n.subtitle && !quick ? `<div class="lead"><p>${inl(n.subtitle, hl)}</p></div>` : ''}
  ${quick ? '<div class="lead" style="font-size:.85em;color:var(--sub)">⚡ 빠른 보기: 핵심(2절)과 숫자(7절)만 — 위 📖 버튼으로 전체 보기</div>' : ''}
  ${shown.map(x => `<details class="sec" id="s${x.lab.n}" open><summary><span class="n">${x.lab.n}</span><span>${esc(x.lab.full)}</span><span class="chev">▾</span></summary>
     <div class="body">${x.s.blocks.map(b => blockHtml(b, hl)).join('')}</div></details>`).join('')}
  <div class="wrap" style="margin-top:12px"><button class="btn ghost" onclick="window.scrollTo({top:0,behavior:'smooth'})">↑ 맨 위로</button></div>`;
  markSeen(n.id);
  $('#qk').onclick = () => { LS.set('quick', !quick); noteView(n, sec); };
  $('#app').querySelectorAll('.chip').forEach(c => c.onclick = () => { const el = document.getElementById('s' + c.dataset.s); el.open = true; el.scrollIntoView({ behavior: 'smooth' }); });
  $('#app').querySelectorAll('a.xref').forEach(a => a.onclick = e => { e.preventDefault(); peek(S.byId[a.dataset.x]); });
  lazyImages();
  if (sec) setTimeout(() => { const el = document.getElementById('s' + sec); if (el) { el.open = true; el.scrollIntoView(); } const m = $('mark', el || document); if (m) m.scrollIntoView({ block: 'center' }); }, 30);
  else window.scrollTo(0, 0);
  sessionStorage.removeItem('nr.hl');
}

function peek(n) {
  if (!n) return;
  const key = n.sections.find(s => /^2\./.test(s.h));
  const bullets = key ? key.blocks.filter(b => b.bullets).flatMap(b => b.bullets).slice(0, 5) : [];
  const sh = $('#sheet');
  sh.innerHTML = `<div class="panel"><div class="grab"></div>
    <div style="font-size:.8em;color:var(--sub)">${esc(n.catLabel)} · ${esc(n.key)}</div>
    <h3 style="margin:4px 0 8px;line-height:1.3">${esc(nice(n.en))} <span class="mark">${n.mark}</span><br><span style="font-size:.8em;color:var(--sub);font-weight:500">${esc(n.ko)}</span></h3>
    <div class="body"><div class="key"><ul>${bullets.map(x => `<li>${inl(x)}</li>`).join('')}</ul></div></div>
    <button class="btn" id="po">노트 열기</button></div>`;
  sh.hidden = false;
  sh.onclick = e => { if (e.target === sh) closeSheet(); };
  $('#po').onclick = () => { closeSheet(); location.hash = '#/n/' + encodeURIComponent(n.id); };
  sh.querySelectorAll('a.xref').forEach(a => a.onclick = e => { e.preventDefault(); peek(S.byId[a.dataset.x]); });
}
function closeSheet() { const sh = $('#sheet'); if (sh) { sh.hidden = true; sh.innerHTML = ''; } }

/* ---------- images: download + decrypt when they come into view ---------- */
let io;
function lazyImages() {
  if (io) io.disconnect();
  io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { io.unobserve(e.target); showImg(e.target); } }), { rootMargin: '600px 0px' });
  document.querySelectorAll('[data-img]').forEach(el => io.observe(el));
}
async function imgUrl(id) {
  if (S.imgUrl[id]) return S.imgUrl[id];
  const r = await fetch('img/' + id + '.bin');
  const raw = await dec(S.key, await r.arrayBuffer());
  return (S.imgUrl[id] = URL.createObjectURL(new Blob([raw], { type: 'image/webp' })));
}
async function showImg(el) {
  try {
    const url = await imgUrl(el.dataset.img);
    el.innerHTML = `<img src="${url}" alt="">`; el.style.aspectRatio = '';
    el.onclick = () => openViewer(url);
  } catch (e) { el.textContent = '그림을 불러오지 못했어요 (오프라인이면 한 번 연결된 뒤 다시)'; }
}
function openViewer(url) {
  const v = $('#viewer'); let z = 1;
  v.innerHTML = `<button class="zoom" id="vz">확대 ＋</button><button class="x" id="vx">닫기 ✕</button><img src="${url}" alt="">`;
  v.hidden = false; document.body.style.overflow = 'hidden';
  const img = $('img', v);
  $('#vz').onclick = () => { z = z >= 3 ? 1 : z + 1; img.style.width = (100 * z) + '%'; $('#vz').textContent = z >= 3 ? '맞춤 ↺' : '확대 ＋'; };
  img.ondblclick = () => $('#vz').click();
  $('#vx').onclick = () => { v.hidden = true; v.innerHTML = ''; document.body.style.overflow = ''; };
}

/* ---------- search ---------- */
const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
function chosung(s) { return Array.from(s).map(c => { const k = c.charCodeAt(0) - 0xac00; return k >= 0 && k < 11172 ? CHO[Math.floor(k / 588)] : c; }).join(''); }
const isCho = s => /^[ㄱ-ㅎ]+$/.test(s);
function flat(b) {
  if (b.p) return b.p; if (b.subhead) return b.subhead; if (b.note) return b.note;
  if (b.bullets) return b.bullets.join('\n'); if (b.table) return [(b.table.header || []).join(' | ')].concat(b.table.rows.map(r => r.join(' | '))).join('\n');
  if (b.caption) return b.caption; return '';
}
function buildIndex() {
  S.idx = S.notes.map(n => ({
    n, head: (n.en + ' ' + n.ko + ' ' + n.key + ' ' + n.title).toLowerCase(), cho: chosung(n.ko + ' ' + n.title),
    secs: n.sections.map((s, i) => ({ i, lab: secLabel(s.h, i), text: plain([s.h].concat(s.blocks.map(flat)).join('\n')) })),
    sub: plain(n.subtitle || ''),
  }));
  S.galias = {};
  for (const [ab, g] of Object.entries(S.gloss)) {
    const a = ab.toLowerCase(), f = g.full.toLowerCase();
    (S.galias[a] = S.galias[a] || new Set()).add(f);
    (S.galias[f] = S.galias[f] || new Set()).add(a);
    if (g.ko) { const k = g.ko.toLowerCase(); (S.galias[k] = S.galias[k] || new Set()).add(a); (S.galias[a]).add(k); }
  }
}
function expand(tok) {
  const t = tok.toLowerCase(); const out = new Set([t]);
  if (S.galias[t]) S.galias[t].forEach(x => out.add(x));
  return [...out];
}
function search(q) {
  if (!S.idx) buildIndex();
  const toks = q.trim().split(/\s+/).filter(Boolean); if (!toks.length) return { res: [], terms: [] };
  const whole = q.trim().toLowerCase();
  const groups = (toks.length > 1 && S.galias[whole]) ? [{ alts: expand(whole) }] : toks.map(t => isCho(t) ? { cho: t, alts: [t] } : { alts: expand(t) });
  const res = [];
  for (const e of S.idx) {
    let score = 0, ok = true; const secHits = {}; const secGroups = {};
    for (const g of groups) {
      let hit = false;
      if (g.cho) { if (e.cho.includes(g.cho)) { score += 30; hit = true; } }
      for (const a of g.alts) {
        if (e.head.includes(a)) { score += 200; hit = true; }
        if (e.sub.toLowerCase().includes(a)) { score += 6; hit = true; }
        for (const s of e.secs) {
          const tl = s.text.toLowerCase(); let p = tl.indexOf(a), c = 0;
          while (p >= 0 && c < 30) { c++; p = tl.indexOf(a, p + a.length); }
          if (c) { hit = true; score += Math.min(c, 8) * (s.lab.n === '2' ? 3 : 1); secHits[s.i] = (secHits[s.i] || 0) + c * (s.lab.n === '2' ? 2 : 1); (secGroups[s.i] = secGroups[s.i] || new Set()).add(g); }
        }
      }
      if (!hit) { ok = false; break; }
    }
    if (!ok) continue;
    if (groups.length > 1) { const together = Object.values(secGroups).filter(x => x.size === groups.length).length; score += together * 25; }
    const best = Object.entries(secHits).sort((a, b) => b[1] - a[1])[0];
    res.push({ e, score, best: best ? +best[0] : null });
  }
  res.sort((a, b) => b.score - a.score);
  return { res, terms: [...new Set(groups.flatMap(g => g.cho ? [] : g.alts))].filter(x => x.length >= 2) };
}
function snippet(text, terms) {
  const tl = text.toLowerCase(); let p = -1;
  for (const t of terms) { p = tl.indexOf(t); if (p >= 0) break; }
  if (p < 0) return esc(text.slice(0, 90));
  const lineStart = Math.max(text.lastIndexOf('\n', p) + 1, p - 50), end = Math.min(text.length, p + 90);
  return highlight(esc((lineStart > 0 ? '…' : '') + text.slice(lineStart, end).replace(/\n/g, ' · ') + (end < text.length ? '…' : '')), terms);
}
function searchView(q) {
  window.scrollTo(0, 0);
  $('#app').innerHTML = `<div class="bar"><div class="bar-row"><button class="icon-btn" onclick="location.hash='#/'" aria-label="처음">‹</button>
    <div class="search" style="flex:1"><span>🔎</span><input id="q" type="search" value="${esc(q)}" placeholder="검색" enterkeyhint="search"></div></div></div><div class="wrap" id="rs"></div>`;
  const q$ = $('#q'); let tm;
  const run = () => {
    const { res, terms } = search(q$.value);
    const shown = res.slice(0, 40);
    $('#rs').innerHTML = !q$.value.trim() ? '<div class="empty">질환명·약·검사·약어(GBS, 길랑, ㄱㄹㅂㄹ)로 찾아보세요</div>'
      : !res.length ? '<div class="empty">찾은 노트가 없어요</div>'
      : `<div class="h2">${res.length}개 노트</div><div class="card list">${shown.map(r => {
          const s = r.best != null ? r.e.secs[r.best] : null;
          return `<div class="res" data-id="${esc(r.e.n.id)}" data-s="${s ? s.lab.n : ''}"><div class="en"><b>${esc(nice(r.e.n.en))}</b> <span class="mark">${r.e.n.mark}</span> <span style="color:var(--sub);font-size:.86em">${esc(r.e.n.ko)}</span></div>
          ${s ? `<div class="where">${s.lab.n}절 ${esc(s.lab.full)}</div><div class="snip">${snippet(s.text, terms)}</div>` : ''}</div>`;
        }).join('')}</div>`;
    $('#rs').querySelectorAll('.res').forEach(el => el.onclick = () => {
      sessionStorage.setItem('nr.hl', terms.join('\u0001'));
      location.hash = '#/n/' + encodeURIComponent(el.dataset.id) + (el.dataset.s ? '/' + el.dataset.s : '');
    });
  };
  q$.oninput = () => { clearTimeout(tm); tm = setTimeout(() => { history.replaceState(null, '', '#/s/' + encodeURIComponent(q$.value)); run(); }, 180); };
  run(); if (!q) q$.focus();
}

/* ---------- settings ---------- */
function applySettings() {
  const st = LS.get('settings', {});
  document.documentElement.dataset.fs = st.fs || 'm';
  if (st.theme && st.theme !== 'auto') document.documentElement.dataset.theme = st.theme; else delete document.documentElement.dataset.theme;
}
function settingsView() {
  const st = LS.get('settings', {});
  const seg = (k, opts, cur) => `<div class="seg">${opts.map(([v, t]) => `<button data-k="${k}" data-v="${v}" class="${cur === v ? 'on' : ''}">${t}</button>`).join('')}</div>`;
  $('#app').innerHTML = `<div class="bar"><div class="bar-row"><button class="icon-btn" onclick="history.back()" aria-label="뒤로">‹</button><h1>설정</h1></div></div>
  <div class="wrap">
    <div class="h2">글자 크기</div>${seg('fs', [['s', '작게'], ['m', '보통'], ['l', '크게'], ['xl', '아주 크게']], st.fs || 'm')}
    <div class="h2">화면</div>${seg('theme', [['auto', '자동'], ['light', '밝게'], ['dark', '어둡게']], st.theme || 'auto')}
    <div class="h2">자료</div><div class="card" style="padding:12px 14px;font-size:.9em">노트 ${S.notes.length}개 · 판 ${esc(S.man.version)}<br><span style="color:var(--sub)">노트가 고쳐지면 앱을 열 때 자동으로 새 판을 받아요.</span></div>
    <div class="h2">그림 미리 받기</div><button class="btn ghost" id="dl">모든 그림을 이 기기에 저장 (오프라인용, 약 ${Math.round(S.man.imgMB || 30)} MB)</button>
    <div class="h2">잠금</div><button class="btn ghost" id="lo">이 기기에서 비밀번호 잊기</button>
  </div>`;
  $('#app').querySelectorAll('[data-k]').forEach(b => b.onclick = () => { st[b.dataset.k] = b.dataset.v; LS.set('settings', st); applySettings(); settingsView(); });
  $('#lo').onclick = () => { LS.del('key'); location.reload(); };
  $('#dl').onclick = async () => {
    const ids = [...new Set(S.notes.flatMap(n => n.sections.flatMap(s => s.blocks.filter(b => b.image).map(b => b.image.id))))];
    let k = 0; const btn = $('#dl');
    for (const id of ids) { try { await fetch('img/' + id + '.bin'); } catch (e) {} k++; if (k % 10 === 0) btn.textContent = `저장 중 ${k}/${ids.length}`; }
    btn.textContent = `완료 — 그림 ${ids.length}개 저장`;
  };
}

function toast(msg) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}
document.addEventListener('click', e => { const g = e.target.closest('[data-go]'); if (g && !g.classList.contains('row') && !g.classList.contains('cat')) location.hash = g.dataset.go; });
boot();
