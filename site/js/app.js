/* AETHER-01 · Phase 04 前端
 * 一切由 manifest.json / content/*.json / hotspots/*.json 驱动，UI 代码不写死片段编号。
 * 画面只来自 Canvas 帧序列（无 MP4 播放器）；单一全局 progress 0-1 决定主线帧号。
 */
'use strict';

const ASSET_BASE = '../aether-01/';
const $ = (s) => document.querySelector(s);
// 回退开关：URL 带 ?legacy=1 时禁用全部性能修复（加载器暂停/位图窗口/自适应分辨率/DPR 上限/进度条 transform），
// 行为回到修复前实现，便于同机 A/B 对比与紧急回退。
const LEGACY = new URLSearchParams(location.search).has('legacy');

const state = {
  manifest: null, chaptersData: null, parameters: null, references: null, hotspots: {},
  totalFrames: 0, fps: 30,
  progress: 0,               // 唯一全局进度 0-1
  frameFloat: 0,
  currentFrame: -1,          // 当前目标主线帧（整数）
  displayed: null,           // {kind:'frame'|'poster'|'branch', segId, local}
  mode: 'mainline',          // 'mainline' | 'branch'
  branch: null,              // {branchId, anchorId, savedFrame, savedProgress, startTs, framesTotal}
  reducedMotion: false,
  degraded: {},              // segId -> true（该段帧不可用，已降级 poster）
  ready: false,
};

/* ---------------- 性能状态（滚动流畅度修复） ----------------
 * 实测瓶颈（见 perf-fix-report.md）：全分辨率 WebP 单帧解码 ~190ms（本机软件渲染），
 * drawImage 未解码图会同步阻塞主线程。对策：半分辨率位图预解码窗口（滚动时用，
 * 静止后换回全分辨率原图保清晰度）+ 滚动时暂停后台加载器 + 自适应渲染分辨率。 */
let lastProgressChangeAt = 0;   // 最近一次进度变化时刻（performance.now 基准）
let scrollDir = 1;              // 最近滚动方向（+1 向前 / -1 向后）
const fullReady = new Set();    // 已完成 decode() 的全分辨率帧 key，静止时可无阻塞绘制

/* ---------------- 数据载入：fetch 优先，file:// 时用同源生成的内联镜像 ---------------- */
async function loadJSON(url, inlineVar) {
  try {
    const r = await fetch(url);
    if (r.ok) return await r.json();
    throw new Error('http ' + r.status);
  } catch (e) {
    if (window[inlineVar]) return window[inlineVar];
    throw e;
  }
}

/* ---------------- 帧定位（全部来自 manifest） ---------------- */
let segIndex = [];   // 主线段：{id, template, count, gStart, gEnd, poster}
let branchIndex = {}; // 支线：{id, template, count, poster, parentAnchor}
function frameURL(seg, local) {
  return ASSET_BASE + seg.template.replace('%06d', String(local).padStart(6, '0'));
}
function locateGlobal(g) {
  for (const s of segIndex) if (g >= s.gStart && g <= s.gEnd) return { seg: s, local: g - s.gStart };
  const last = segIndex[segIndex.length - 1];
  return { seg: last, local: last.count - 1 };
}

/* ---------------- 帧缓存：窗口 + 最远淘汰 ---------------- */
const CACHE_MAX = 96;
const cache = new Map(); // key -> {img, ok, lastUse}
let useTick = 0;
function cacheKey(kind, id, local) { return kind + ':' + id + ':' + local; }
function cacheGet(key) { const e = cache.get(key); if (e) e.lastUse = ++useTick; return e; }
function cachePut(key, entry) {
  entry.lastUse = ++useTick;
  cache.set(key, entry);
  if (cache.size > CACHE_MAX) evictCache();
}
function evictCache() {
  const cur = state.currentFrame;
  const scored = [];
  for (const [k, e] of cache) {
    if (k.startsWith('poster:') || k.startsWith('anchor:')) continue;
    if (state.mode === 'branch' && k.startsWith('branch:')) continue;
    let dist = 1e9;
    if (k.startsWith('main:')) {
      const g = e.globalFrame;
      if (typeof g === 'number') dist = Math.abs(g - cur);
    }
    scored.push([dist, k]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  let n = cache.size - CACHE_MAX;
  for (const [, k] of scored) { if (n-- <= 0) break; cache.delete(k); }
}

/* ---------------- 加载器：按 manifest.loadingPriority 顺序，真实计数 ---------------- */
const loader = {
  total: 0, settled: 0, failed: 0, queue: [], active: 0, concurrency: 6,
  mainlineReady: false, allDone: false, settledKeys: new Set(),
};
function planItem(kind, id, local, url, extra) {
  return Object.assign({ kind, id, local, url, key: cacheKey(kind, id, local) }, extra || {});
}
function buildLoadPlan() {
  const plan = [];
  const M = state.manifest;
  for (const s of M.segments) plan.push(planItem('poster', s.id, -1, ASSET_BASE + s.poster, { posterFor: s.id }));
  for (const b of M.branches) plan.push(planItem('poster', b.id, -1, ASSET_BASE + b.poster, { posterFor: b.id }));
  for (const a of M.anchors) plan.push(planItem('anchor', a.id, -1, ASSET_BASE + a.anchorFrameWebp, {}));
  for (const s of segIndex) for (let i = 0; i < s.count; i++)
    plan.push(planItem('main', s.id, i, frameURL(s, i), { globalFrame: s.gStart + i, gate: s.id === segIndex[0].id }));
  for (const b of M.branches) {
    const bi = branchIndex[b.id];
    for (let i = 0; i < bi.count; i++) plan.push(planItem('branch', b.id, i, frameURL(bi, i), {}));
  }
  plan.forEach((it, i) => { it.planOrder = i; });
  return plan;
}
function loadOne(item) {
  return new Promise((resolve) => {
    if (loader.settledKeys.has(item.key)) { resolve(true); return; }
    const img = new Image();
    img.onload = () => {
      loader.settledKeys.add(item.key);
      cachePut(item.key, { img, ok: true, globalFrame: item.globalFrame });
      resolve(true);
    };
    img.onerror = () => {
      loader.settledKeys.add(item.key);
      cachePut(item.key, { img: null, ok: false, globalFrame: item.globalFrame });
      if (item.kind === 'main') state.degraded[item.id] = true;
      loader.failed++;
      resolve(false);
    };
    img.src = item.url;
  });
}
let pumpTimer = null;
function onLoaderSettled(item) {
  loader.active--; loader.settled++;
  updateLoadUI(item);
  if (!loader.mainlineReady) checkGate();
  if (loader.settled >= loader.total) { loader.allDone = true; updateLoadUI(null); }
  pumpLoader();
}
// 播放头优先评分（慢网络补丁，2026-11-20）：后台加载不再死守 M01→M10 顺序，
// 而是优先补当前帧附近的帧——用户滚到哪儿，哪儿先就绪；poster/anchor 仍最优先
// （入口门与兜底需要），支线帧按其锚点与当前帧的距离排队。
function itemScore(item) {
  if (item.kind === 'poster' || item.kind === 'anchor') return -1e9 + (item.planOrder || 0);
  const cur = state.currentFrame || 0;
  if (item.kind === 'branch') {
    const a = (state.manifest.anchors || []).find(x => x.branchId === item.id);
    const anchorG = a ? a.globalRange[0] : 0;
    return 1e6 + Math.abs(anchorG - cur) + (item.local || 0);
  }
  return Math.abs((item.globalFrame ?? 0) - cur);
}
function pumpLoader() {
  if (LEGACY) { // ?legacy=1 保持原行为：FIFO、滚动不暂停
    while (loader.active < loader.concurrency && loader.queue.length) {
      const item = loader.queue.shift();
      loader.active++;
      loadOne(item).then(() => onLoaderSettled(item));
    }
    return;
  }
  // 带宽优先级（第二档，2026-11-20 晚）：滚动真正显示的是半幅位图窗口，全幅后台
  // 补帧只为静止清晰度——滚动中全幅让行（0 条），窗口忙时最多 1 条，静止且窗口
  // 空闲时 6 条全开。预载计数口径不变。
  const scrolling = performance.now() - lastProgressChangeAt < 200;
  const bmpBusy = bmpActive > 0 || bmpQueue.length > 0;
  const limit = scrolling ? 0 : (bmpBusy ? 1 : loader.concurrency);
  while (loader.active < limit && loader.queue.length) {
    let bi = 0, bs = Infinity;
    for (let i = 0; i < loader.queue.length; i++) {
      const sc = itemScore(loader.queue[i]);
      if (sc < bs) { bs = sc; bi = i; }
    }
    const item = loader.queue.splice(bi, 1)[0];
    loader.active++;
    loadOne(item).then(() => onLoaderSettled(item));
  }
  if (loader.queue.length && loader.active >= limit && !pumpTimer) {
    pumpTimer = setTimeout(() => { pumpTimer = null; pumpLoader(); }, 250);
  }
}
function urgentLoad(kind, id, local, url, globalFrame) {
  const key = cacheKey(kind, id, local);
  if (cache.has(key)) return;
  cachePut(key, { img: null, ok: false, pending: true, globalFrame });
  const img = new Image();
  img.onload = () => cachePut(key, { img, ok: true, globalFrame });
  img.onerror = () => { cachePut(key, { img: null, ok: false, globalFrame }); if (kind === 'main') state.degraded[id] = true; };
  img.src = url;
}
const GATE_FIRST_FRAMES = 120; // 慢网络补丁：入口门只等首段前 120 帧（原为整段 240），其余由播放头优先加载随后补齐
function checkGate() {
  // 里程碑 A 门：首段前 GATE_FIRST_FRAMES 帧 + 全部 poster 结算完毕即可进入
  const first = segIndex[0];
  const need = Math.min(first.count, GATE_FIRST_FRAMES);
  for (let i = 0; i < need; i++) if (!loader.settledKeys.has(cacheKey('main', first.id, i))) return;
  for (const s of state.manifest.segments) if (!loader.settledKeys.has(cacheKey('poster', s.id, -1))) return;
  loader.mainlineReady = true;
  state.ready = true;
  $('#preloader').classList.add('done');
  $('#pre-status').textContent = '首段就绪';
}
let lastUIAt = 0, lastUIPct = -1;
function updateLoadUI(lastItem) {
  const pct = loader.total ? Math.floor(100 * loader.settled / loader.total) : 0;
  // 节流：百分比未变且距上次写入 <150ms 时跳过 DOM 写入（加载期每帧结算都写会造成样式抖动）。
  // 百分比仍是真实结算计数，只是合并到至多 ~7 次/秒的写入节奏；完成时强制写入。
  const nowMs = performance.now();
  if (!loader.allDone && pct === lastUIPct && nowMs - lastUIAt < 150) return;
  lastUIAt = nowMs; lastUIPct = pct;
  $('#pre-pct').textContent = pct + '%';
  $('#pre-fill').style.width = pct + '%';
  $('#load-mini-pct').textContent = pct + '%';
  if (lastItem) {
    $('#pre-status').textContent = lastItem.kind === 'poster' ? '正在载入海报图…'
      : lastItem.kind === 'anchor' ? '正在载入锚点帧…'
      : lastItem.kind === 'branch' ? ('正在后台载入支线 ' + lastItem.id + '…')
      : ('正在载入主线 ' + lastItem.id + ' · ' + (lastItem.local + 1) + ' / ' + (segIndex.find(s => s.id === lastItem.id) || {}).count + ' 帧');
  }
  if (loader.allDone) { $('#pre-status').textContent = '全部素材载入完成'; $('#load-mini').style.display = 'none'; }
}

/* ---------------- 位图预解码窗口（半分辨率，滚动专用） ----------------
 * 帧文件另有一套 frames-half/（960×540，与 frames/ 同编号同帧号），解码成本约为全幅 1/4。
 * 滚动时提前把当前帧前方窗口内的半幅帧用 createImageBitmap 异步解码（不阻塞主线程），
 * 绘制直接用位图；滚动停稳 >250ms 后换回全分辨率原图（先 decode() 再画，不同步阻塞）。
 * frames-half 不存在时自动回退全幅解码，行为与原实现等价。 */
const BMP_AHEAD = 26, BMP_BEHIND = 6, BMP_MAX = 56, BMP_CONCURRENCY = 3;
const bmpCache = new Map();   // key -> {bmp, globalFrame, lastUse}
const bmpPending = new Set(); // key（排队或解码中）
const bmpQueue = [];          // {kind,id,local,seg,globalFrame,priority}
let bmpActive = 0;
const halfMissing = new Set();// 已确认无 frames-half 的段 id
function halfURL(seg, local) {
  return ASSET_BASE + seg.template.replace('/frames/', '/frames-half/').replace('%06d', String(local).padStart(6, '0'));
}
function bmpGet(key) { const e = bmpCache.get(key); if (e) e.lastUse = ++useTick; return e; }
function bmpPut(key, entry) {
  entry.lastUse = ++useTick;
  bmpCache.set(key, entry);
  if (bmpCache.size > BMP_MAX) {
    const cur = state.currentFrame;
    const scored = [...bmpCache.entries()].map(([k, e]) => [Math.abs((e.globalFrame ?? cur) - cur), k]);
    scored.sort((a, b) => b[0] - a[0]);
    let n = bmpCache.size - BMP_MAX;
    for (const [, k] of scored) { if (n-- <= 0) break; const e = bmpCache.get(k); if (e && e.bmp) e.bmp.close(); bmpCache.delete(k); }
  }
}
function queueBitmap(kind, id, local, seg, globalFrame, priority) {
  const key = cacheKey(kind, id, local);
  if (bmpCache.has(key) || bmpPending.has(key)) return;
  bmpPending.add(key);
  bmpQueue.push({ kind, id, local, seg, globalFrame, priority, key });
  pumpBmp();
}
function pumpBmp() {
  while (bmpActive < BMP_CONCURRENCY && bmpQueue.length) {
    // 慢网络补丁：优先级按与当前帧的实时距离重算，快速滚动时已被甩到身后
    // 40 帧以上的过期请求直接丢弃，不再浪费带宽取永远不会显示的帧。
    const cur = state.currentFrame;
    for (let i = bmpQueue.length - 1; i >= 0; i--) {
      const it = bmpQueue[i];
      if (typeof it.globalFrame !== 'number') continue;
      if (!state.branch && it.globalFrame < cur - 40) { bmpPending.delete(it.key); bmpQueue.splice(i, 1); }
      else it.priority = Math.abs(it.globalFrame - cur);
    }
    if (!bmpQueue.length) break;
    bmpQueue.sort((a, b) => a.priority - b.priority);
    const item = bmpQueue.shift();
    bmpActive++;
    decodeBitmap(item);
  }
}
async function decodeBitmap(item) {
  const useHalf = !halfMissing.has(item.id);
  const url = useHalf ? halfURL(item.seg, item.local) : frameURL(item.seg, item.local);
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error('http ' + r.status);
    const bmp = await createImageBitmap(await r.blob());
    bmpPut(item.key, { bmp, globalFrame: item.globalFrame });
  } catch (e) {
    if (useHalf) { // 该段没有半幅帧：标记后用全幅重试一次
      halfMissing.add(item.id);
      bmpPending.delete(item.key);
      bmpActive--;
      queueBitmap(item.kind, item.id, item.local, item.seg, item.globalFrame, item.priority);
      pumpBmp();
      return;
    }
    // 全幅也失败：交给原有 Image/poster 兜底链
  }
  bmpPending.delete(item.key);
  bmpActive--;
  pumpBmp();
}
function ensureWindow(g, dir) {
  const lo = dir >= 0 ? -BMP_BEHIND : -BMP_AHEAD;
  const hi = dir >= 0 ? BMP_AHEAD : BMP_BEHIND;
  for (let off = lo; off <= hi; off++) {
    const gg = g + off;
    if (gg < 0 || gg >= state.totalFrames) continue;
    const { seg, local } = locateGlobal(gg);
    queueBitmap('main', seg.id, local, seg, gg, Math.abs(off));
  }
}
function ensureBranchWindow(local) {
  const b = state.branch; if (!b) return;
  const bi = branchIndex[b.branchId];
  for (let off = 0; off <= 30; off++) {
    const l = local + off;
    if (l < 0 || l >= bi.count) continue;
    queueBitmap('branch', b.branchId, l, bi, undefined, off);
  }
}

/* ---------------- Canvas 绘制：与 manifest.renderVariants 同一 cover 变换 ---------------- */
const canvas = $('#screen'), ctx = canvas.getContext('2d');
let view = { w: 0, h: 0, dpr: 1, scale: 1 };
let coverCache = null;
let lastDrawn = null; // 'F|B:segId:local' 已绘制内容标识，避免同帧重复绘制
function fitCanvas() {
  view.dpr = Math.min(window.devicePixelRatio || 1, LEGACY ? 2 : 1.5); // 原上限 2：高分屏光栅面积过大，1.5 画质几乎无差
  view.w = window.innerWidth; view.h = window.innerHeight;
  canvas.width = Math.round(view.w * view.dpr * view.scale); canvas.height = Math.round(view.h * view.dpr * view.scale);
  coverCache = null;
  lastDrawn = null;
}
function coverTransform() {
  if (coverCache) return coverCache;
  const FW = state.manifest.frameSize.width, FH = state.manifest.frameSize.height;
  const scale = Math.max(view.w / FW, view.h / FH); // manifest: cover 公式（桌面/移动同式）
  coverCache = { scale, ox: (view.w - FW * scale) / 2, oy: (view.h - FH * scale) / 2, FW, FH };
  return coverCache;
}
function drawCover(img) {
  const t = coverTransform();
  ctx.setTransform(view.dpr * view.scale, 0, 0, view.dpr * view.scale, 0, 0);
  // cover 变换保证画面铺满视口（FW*scale>=w 且 FH*scale>=h），无需再全屏 fillRect 清底
  ctx.drawImage(img, t.ox, t.oy, t.FW * t.scale, t.FH * t.scale);
}
function drawCoverLegacy(img) { // 修复前 drawCover：含全屏清底
  const t = coverTransform();
  ctx.setTransform(view.dpr * view.scale, 0, 0, view.dpr * view.scale, 0, 0);
  ctx.fillStyle = '#05080e'; ctx.fillRect(0, 0, view.w, view.h);
  ctx.drawImage(img, t.ox, t.oy, t.FW * t.scale, t.FH * t.scale);
}
function legacyDrawMainline(g) { // 修复前 drawMainline 原样（?legacy=1 时使用）
  const { seg, local } = locateGlobal(g);
  const e = cacheGet(cacheKey('main', seg.id, local));
  if (e && e.ok && e.img) { drawCoverLegacy(e.img); state.displayed = { kind: 'frame', segId: seg.id, local }; return; }
  urgentLoad('main', seg.id, local, frameURL(seg, local), g);
  for (let d = 1; d <= 60; d++) {
    for (const cand of [local - d, local + d]) {
      if (cand < 0 || cand >= seg.count) continue;
      const ce = cacheGet(cacheKey('main', seg.id, cand));
      if (ce && ce.ok && ce.img) { drawCoverLegacy(ce.img); state.displayed = { kind: 'frame', segId: seg.id, local: cand, approx: true }; return; }
    }
  }
  const p = cacheGet(cacheKey('poster', seg.id, -1));
  if (p && p.ok && p.img) { drawCoverLegacy(p.img); state.displayed = { kind: 'poster', segId: seg.id, local: -1 }; }
}
function legacyDrawBranchFrame(local) { // 修复前 drawBranchFrame 原样
  const b = state.branch; if (!b) return;
  const bi = branchIndex[b.branchId];
  const e = cacheGet(cacheKey('branch', b.branchId, local));
  if (e && e.ok && e.img) { drawCoverLegacy(e.img); state.displayed = { kind: 'branch', segId: b.branchId, local }; return; }
  urgentLoad('branch', b.branchId, local, frameURL(bi, local));
  const p = cacheGet(cacheKey('poster', b.branchId, -1));
  if (p && p.ok && p.img && !state.displayed) { drawCoverLegacy(p.img); state.displayed = { kind: 'poster', segId: b.branchId, local: -1 }; }
}
function drawMainline(g) {
  if (LEGACY) { legacyDrawMainline(g); return; }
  const { seg, local } = locateGlobal(g);
  const key = cacheKey('main', seg.id, local);
  const idle = performance.now() - lastProgressChangeAt > 250;
  const e = cacheGet(key);
  // 静止时优先全分辨率原图保清晰度：先异步 decode()，就绪后再画（不阻塞主线程）
  if (idle && e && e.ok && e.img) {
    if (fullReady.has(key)) {
      if (lastDrawn !== 'F:' + key) { drawCover(e.img); lastDrawn = 'F:' + key; }
      state.displayed = { kind: 'frame', segId: seg.id, local };
      return;
    }
    if (!e.decoding) { e.decoding = true; e.img.decode().then(() => fullReady.add(key)).catch(() => {}); }
  }
  // 滚动时（或全幅未就绪时）用预解码位图：精确帧位图
  const be = bmpGet(key);
  if (be) {
    if (lastDrawn !== 'B:' + key) { drawCover(be.bmp); lastDrawn = 'B:' + key; }
    state.displayed = { kind: 'frame', segId: seg.id, local };
    if (idle) urgentLoad('main', seg.id, local, frameURL(seg, local), g); // 为静止换全幅做准备
    ensureWindow(g, scrollDir);
    return;
  }
  ensureWindow(g, scrollDir);
  // 精确帧未就绪：先紧急加载，再找同段最近已缓存帧/位图，仍无则用该段 poster —— 绝不清空画面
  urgentLoad('main', seg.id, local, frameURL(seg, local), g);
  for (let d = 1; d <= 60; d++) {
    for (const cand of [local - d, local + d]) {
      if (cand < 0 || cand >= seg.count) continue;
      const bk = cacheKey('main', seg.id, cand);
      const bb = bmpGet(bk);
      if (bb) { if (lastDrawn !== 'B:' + bk) { drawCover(bb.bmp); lastDrawn = 'B:' + bk; } state.displayed = { kind: 'frame', segId: seg.id, local: cand, approx: true }; return; }
      const ce = cacheGet(bk);
      if (ce && ce.ok && ce.img) { if (lastDrawn !== 'I:' + bk) { drawCover(ce.img); lastDrawn = 'I:' + bk; } state.displayed = { kind: 'frame', segId: seg.id, local: cand, approx: true }; return; }
    }
  }
  const p = cacheGet(cacheKey('poster', seg.id, -1));
  if (p && p.ok && p.img) { if (lastDrawn !== 'P:' + seg.id) { drawCover(p.img); lastDrawn = 'P:' + seg.id; } state.displayed = { kind: 'poster', segId: seg.id, local: -1 }; }
}
function drawBranchFrame(local) {
  if (LEGACY) { legacyDrawBranchFrame(local); return; }
  const b = state.branch; if (!b) return;
  const bi = branchIndex[b.branchId];
  ensureBranchWindow(local);
  const bk = cacheKey('branch', b.branchId, local);
  const bb = bmpGet(bk);
  if (bb) { if (lastDrawn !== 'B:' + bk) { drawCover(bb.bmp); lastDrawn = 'B:' + bk; } state.displayed = { kind: 'branch', segId: b.branchId, local }; return; }
  const e = cacheGet(bk);
  if (e && e.ok && e.img) { if (lastDrawn !== 'I:' + bk) { drawCover(e.img); lastDrawn = 'I:' + bk; } state.displayed = { kind: 'branch', segId: b.branchId, local }; return; }
  urgentLoad('branch', b.branchId, local, frameURL(bi, local));
  const p = cacheGet(cacheKey('poster', b.branchId, -1));
  if (p && p.ok && p.img && !state.displayed) { drawCover(p.img); lastDrawn = 'P:' + b.branchId; state.displayed = { kind: 'poster', segId: b.branchId, local: -1 }; }
}

/* ---------------- 章节 DOM（由 content 驱动生成） ---------------- */
let chapterEls = [], navEls = [];
function buildChapters() {
  const wrap = $('#panels'), nav = $('#chapter-nav');
  const params = state.parameters, refs = state.references;
  state.chaptersData.chapters.forEach((ch, i) => {
    const sec = document.createElement('section');
    sec.className = 'panel' + (ch.id === 'CH06' ? ' wide' : '');
    sec.dataset.chapter = ch.id;
    const d = ch.dom || {};
    let html = '<div class="ch-kicker">第 ' + ch.index + ' 章 · ' + (ch.lighting || '') + '</div>';
    html += '<h2>' + ch.title + '</h2>';
    if (d.heading) html += '<h3>' + d.heading + '</h3>';
    if (d.subheading) html += '<p class="dim">' + d.subheading + '</p>';
    if (d.intro) html += '<p>' + d.intro + '</p>';
    if (d.body) html += '<p>' + d.body + '</p>';
    if (d.techRiskNote) html += '<div class="note">' + d.techRiskNote + '</div>';
    if (d.sceneBoundaryNote) html += '<div class="note">' + d.sceneBoundaryNote + '</div>';
    if (d.hotspotEntry) {
      html += '<button type="button" class="hs-entry" data-goto-anchor="' + d.hotspotEntry.anchorId + '">'
        + d.hotspotEntry.label + '<small>先滚动到锚点静止区间，再点击画面中的热点进入支线</small></button>';
    }
    if (d.scrollCue) html += '<div class="scroll-cue">↓ ' + d.scrollCue + '</div>';
    if (ch.id === 'CH06') {
      for (const g of params.groups) {
        html += '<table><caption>' + g.title + '</caption>';
        for (const it of g.items) {
          const pending = it.status === '待核实';
          html += '<tr><td class="k">' + it.key + '</td><td class="' + (pending ? 'pending' : '') + '">' + it.value + '</td></tr>';
        }
        html += '</table>';
      }
      html += '<p class="dim">' + params.notice + '</p>';
      if (d.feasibility) html += '<p>' + d.feasibility + '</p>';
      if (d.marketNote) html += '<p>' + d.marketNote + '</p>';
      html += '<div class="refs"><strong>参考来源</strong><ul>';
      for (const s of refs.sources) html += '<li>' + s.id + ' · ' + s.title + '（' + s.status + '）— ' + s.supports + '</li>';
      html += '</ul><p>' + refs.notice + '</p></div>';
      if (d.footer) html += '<footer>' + d.footer + '</footer>';
    }
    sec.innerHTML = html;
    wrap.appendChild(sec); chapterEls.push(sec);
    const nb = document.createElement('button');
    nb.type = 'button'; nb.textContent = ch.index + ' ' + ch.title.split('·')[0];
    nb.title = ch.title;
    const mc = (state.manifest.chapters || []).find(c => c.id === ch.id) || ch;
    nb.addEventListener('click', () => gotoProgress(chapterStartFrame(mc) / (state.totalFrames - 1))); // BUG-L01 附带：落点=起始帧（原 progressRange[0]+0.001 恒偏移 +1~+3 帧）
    nav.appendChild(nb); navEls.push(nb);
  });
  wrap.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-goto-anchor]');
    if (!btn) return;
    const a = state.manifest.anchors.find(x => x.id === btn.dataset.gotoAnchor);
    if (a) gotoProgress((a.globalRange[0] + 15) / (state.totalFrames - 1));
  });
}
function chapterForFrame(g) {
  const chs = state.manifest.chapters;
  for (const c of chs) if (g >= c.globalStartFrame && g <= c.globalEndFrame) return c;
  return chs[chs.length - 1];
}
let activeChapter = null;
function syncChapterUI(g) {
  const ch = chapterForFrame(g);
  if (ch.id !== activeChapter) {
    activeChapter = ch.id;
    chapterEls.forEach(el => {
      const on = el.dataset.chapter === ch.id;
      if (on && !el.classList.contains('on')) {
        el.classList.add('on');
        if (!state.reducedMotion && window.gsap) gsap.fromTo(el, { opacity: 0, y: 26 }, { opacity: 1, y: 0, duration: 0.55, ease: 'power2.out', overwrite: true, clearProps: 'opacity,transform' });
      } else if (!on) el.classList.remove('on');
    });
    let activeNavEl = null;
    navEls.forEach((el, i) => {
      const on = state.manifest.chapters[i].id === ch.id;
      el.classList.toggle('active', on);
      if (on) activeNavEl = el;
    });
    // BUG-L02：移动端章节导航横滑时，把当前章节按钮滚入导航可视区中央；
    // 桌面内容不溢出（scrollWidth<=clientWidth）时不触发，布局行为不变。
    const navEl = $('#chapter-nav');
    if (navEl && activeNavEl && navEl.scrollWidth > navEl.clientWidth) {
      const nr = navEl.getBoundingClientRect(), br = activeNavEl.getBoundingClientRect();
      navEl.scrollLeft += (br.left + br.width / 2) - (nr.left + nr.width / 2);
    }
    $('#pg-label').textContent = '第 ' + ((state.chaptersData.chapters.find(c => c.id === ch.id) || {}).index || '') + ' 章 · ' + ch.title;
  }
  // 进度条用 transform: scaleX（合成器属性，不触发布局）；仅在进度实际变化时写。legacy 模式回原 width 写法。
  if (Math.abs(state.progress - lastProgShown) > 0.0002) {
    lastProgShown = state.progress;
    const fill = $('#progress-fill');
    if (LEGACY) { fill.style.transform = 'none'; fill.style.width = (state.progress * 100).toFixed(2) + '%'; }
    else fill.style.transform = 'scaleX(' + state.progress + ')';
  }
  if (g !== lastReadoutFrame) {
    lastReadoutFrame = g;
    $('#frame-readout').textContent = '帧 ' + g + ' / ' + (state.totalFrames - 1);
  }
}
let lastProgShown = -1, lastReadoutFrame = -1;

/* ---------------- 热点层：与画面同一 cover 变换 ---------------- */
const hsLayer = $('#hotspot-layer');
let hsButtons = {}; // anchorId -> button
function buildHotspots() {
  for (const a of state.manifest.anchors) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'hotspot'; b.hidden = true;
    b.dataset.anchor = a.id;
    const entry = (state.chaptersData.chapters.find(c => c.id === (state.manifest.branches.find(x => x.id === a.branchId) || {}).chapter) || {}).dom;
    const label = (entry && entry.hotspotEntry && entry.hotspotEntry.label) || '进入支线';
    b.innerHTML = '<span class="hs-pulse"></span><span class="hs-tag">' + label + '</span>';
    b.setAttribute('aria-label', label + '（支线 ' + a.branchId + '）');
    b.addEventListener('click', () => enterBranch(a.id));
    hsLayer.appendChild(b); hsButtons[a.id] = b;
  }
}
const hsFrameMap = {}; // anchorId -> Map(localFrame -> frameEntry)，替代每 tick 线性 find
let lastHsKey = null;
function syncHotspots(g) {
  const hsKey = g + '|' + state.mode + '|' + view.w + 'x' + view.h;
  if (hsKey === lastHsKey) return; // 帧号/模式/视口未变时热点位置不可能变，整段跳过
  lastHsKey = hsKey;
  const t = coverTransform();
  for (const a of state.manifest.anchors) {
    const btn = hsButtons[a.id];
    const hs = state.hotspots[a.id];
    let show = false;
    if (state.mode === 'mainline' && hs && g >= a.globalRange[0] && g <= a.globalRange[1]) {
      const local = g - locateGlobal(g).seg.gStart;
      if (!hsFrameMap[a.id]) hsFrameMap[a.id] = new Map((hs.frames || []).map(f => [f.frame, f]));
      const fe = hsFrameMap[a.id].get(local);
      if (fe && fe.visible && fe.clickable) {
        const bb = fe.bbox;
        let x = t.ox + bb.xMin * t.FW * t.scale, y = t.oy + bb.yMin * t.FH * t.scale;
        let w = (bb.xMax - bb.xMin) * t.FW * t.scale, h = (bb.yMax - bb.yMin) * t.FH * t.scale;
        if (w < 48) { x -= (48 - w) / 2; w = 48; }   // 最小触控区 48px，不改中心
        if (h < 48) { y -= (48 - h) / 2; h = 48; }
        btn.style.left = x + 'px'; btn.style.top = y + 'px';
        btn.style.width = w + 'px'; btn.style.height = h + 'px';
        show = true;
        btn.hidden = false; // 先显示，clampHotspotVisuals 需要量标签尺寸
        clampHotspotVisuals(btn, x, y, w, h);
      }
    }
    btn.hidden = !show;
  }
}
/* BUG-L03 修复：热点框本体仍按 cover 公式定位（位置/可点判定不变），只钳制框内
 * 标签(.hs-tag)与脉冲(.hs-pulse)的呈现位置。竖屏 cover 裁切下框可宽达上千 px 且大半在屏外，
 * 原实现把标签/脉冲放在框几何中心/框底中央 → 中心在屏外或被底部章节面板盖住。
 * 改法：可见区 V = 框 ∩ 视口（四边内缩 8px），再扣掉当前章节面板占位（框在面板上方
 * 还有可见带时把 V 的下沿收紧到面板上沿之上）；脉冲移到 V 中心，标签移到 V 底边内侧
 * 且水平居中于 V（并钳制在视口内）。目标与默认位置重合（±1px）时不写行内样式，
 * 桌面常规情形行为与原实现一致。 */
function clampHotspotVisuals(btn, x, y, w, h) {
  const tag = btn.querySelector('.hs-tag');
  const pulse = btn.querySelector('.hs-pulse');
  if (!tag || !pulse) return;
  let vx0 = Math.max(x, 8), vy0 = Math.max(y, 8);
  let vx1 = Math.min(x + w, view.w - 8), vy1 = Math.min(y + h, view.h - 8);
  const panel = document.querySelector('.panel.on');
  if (panel) {
    const pr = panel.getBoundingClientRect();
    if (pr.width > 0 && pr.height > 0 && vx0 < pr.right && vx1 > pr.left && vy0 < pr.bottom && vy1 > pr.top) {
      if (vy0 < pr.top - 24) vy1 = Math.min(vy1, pr.top - 6);       // 面板上方有足够可见带：收紧到面板上沿
      else if (vx0 < pr.left - 24) vx1 = Math.min(vx1, pr.left - 6); // 框顶已在面板内但左侧露头：改用左侧带
    }
  }
  if (vx1 - vx0 < 24 || vy1 - vy0 < 24) { // 扣面板后可见带太小：退回纯视口钳制，至少保证在屏内
    vx0 = Math.max(x, 8); vy0 = Math.max(y, 8);
    vx1 = Math.min(x + w, view.w - 8); vy1 = Math.min(y + h, view.h - 8);
  }
  const pcx = (vx0 + vx1) / 2, pcy = (vy0 + vy1) / 2;
  // 脉冲：CSS 默认 left/top 50%（框中心）；行内 left/top 直接给出中心坐标（margin -7px 已对中）
  if (Math.abs(pcx - (x + w / 2)) > 1 || Math.abs(pcy - (y + h / 2)) > 1) {
    pulse.style.left = (pcx - x) + 'px';
    pulse.style.top = (pcy - y) + 'px';
  } else { pulse.style.left = ''; pulse.style.top = ''; }
  // 标签：默认由 flex 居于框底中央（底边距 8px）；用 transform 平移到目标位（不改布局/不改框）
  const tw = tag.offsetWidth, th = tag.offsetHeight;
  if (tw && th) {
    const natCx = x + w / 2, natCy = y + h - 8 - th / 2;
    let tgtCx = pcx;
    if (tw <= view.w - 16) tgtCx = Math.min(Math.max(tgtCx, 8 + tw / 2), view.w - 8 - tw / 2);
    const tgtCy = vy1 - 8 - th / 2;
    const dx = tgtCx - natCx, dy = tgtCy - natCy;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) tag.style.transform = 'translate(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px)';
    else tag.style.transform = '';
  }
}

/* ---------------- 支线：保存帧 → 自动播放 → 精确回切 ---------------- */
function enterBranch(anchorId) {
  if (state.mode !== 'mainline') return; // 禁止嵌套
  const a = state.manifest.anchors.find(x => x.id === anchorId);
  if (!a) return;
  const g = state.currentFrame;
  if (g < a.globalRange[0] || g > a.globalRange[1]) return; // 区间外不可进
  const bi = branchIndex[a.branchId];
  state.branch = {
    branchId: a.branchId, anchorId, savedFrame: g, savedProgress: state.progress,
    startTs: performance.now(), framesTotal: bi.count,
  };
  state.mode = 'branch';
  ensureBranchWindow(0); // 预解码支线开头窗口，播放不卡在逐帧解码上
  if (window.__lenis) window.__lenis.stop();
  $('#branch-label').textContent = '支线 ' + a.branchId + ' · 播放中（结束自动返回主线帧 ' + g + '）';
  $('#branch-ui').hidden = false;
  syncHotspots(g);
}
function exitBranch() {
  const b = state.branch; if (!b) return;
  state.branch = null; state.mode = 'mainline';
  $('#branch-ui').hidden = true;
  if (window.__lenis) window.__lenis.start();
  // 精确恢复：进度与帧号都回到保存值（支线期间滚动已被锁定，进度本未改变）
  setScrollToProgress(b.savedProgress, true);
  state.progress = b.savedProgress;
  state.currentFrame = b.savedFrame;
  drawMainline(b.savedFrame);
  syncChapterUI(b.savedFrame); syncHotspots(b.savedFrame);
}
function tickBranch(now) {
  const b = state.branch; if (!b) return;
  // 支线期间锁定主线滚动位置（Lenis 停用/减少动态时以原生方式守住）
  const lockedY = b.savedProgress * maxScroll();
  if (Math.abs(window.scrollY - lockedY) > 1) window.scrollTo(0, lockedY);
  const elapsed = (now - b.startTs) / 1000;
  const f = Math.floor(elapsed * state.fps);
  if (f >= b.framesTotal) { exitBranch(); return; }
  drawBranchFrame(Math.min(f, b.framesTotal - 1));
}

/* ---------------- 进度 / 滚动 ---------------- */
let lenis = null;
function maxScroll() { return Math.max(1, document.documentElement.scrollHeight - window.innerHeight); }
function scrollToY(y, immediate) {
  if (state.reducedMotion || immediate || !lenis) {
    if (lenis && immediate && !state.reducedMotion) lenis.scrollTo(y, { immediate: true, force: true });
    else window.scrollTo(0, y);
  } else lenis.scrollTo(y, { duration: 1.1 });
}
function setScrollToProgress(p, immediate) {
  exactFrameTarget = null; // 经 progress 的定位不以帧为基准：作废翻页器的精确帧累进基准，下一次步进改用 currentFrame
  scrollToY(p * maxScroll(), immediate);
}
/* BUG-L01 修复：以整数帧为基准定位，不再用浮点 progress 累进。
 * 每帧对应的滚动区间宽 maxScroll/(totalFrames-1) ≈ 2.6–3.3px > 1px，
 * 取 y = round(帧进度 × maxScroll) 时 |y − 理想位置| ≤ 0.5px，换算回帧误差 < 0.2 帧，
 * 主循环 round(scrollY/maxScroll × (totalFrames-1)) 必读回目标帧本身——连点 N 次即精确 ±N 帧，
 * 不再经「量化后的 progress 再出发」单向累积误差。exactFrameTarget 是步进的累进基准，
 * 不依赖 scrollY 回读；主循环发现实际帧号与它不一致（手动滚动/外部定位）时自动作废（见 mainLoop）。 */
let exactFrameTarget = null;
function setScrollToFrame(g, immediate) {
  const f = Math.min(state.totalFrames - 1, Math.max(0, Math.round(g)));
  exactFrameTarget = f;
  scrollToY(Math.round((f / (state.totalFrames - 1)) * maxScroll()), immediate);
  // 同步状态：即使下一 tick 前连点，步进基准也已是精确帧；主循环读回同一帧，与此自洽
  state.currentFrame = f;
  state.progress = Math.min(1, Math.max(0, window.scrollY / maxScroll()));
  state.frameFloat = state.progress * (state.totalFrames - 1);
}
function chapterStartFrame(ch) {
  // 章节起始帧以 manifest 的 globalStartFrame 为准（progressRange 只有两位小数，
  // 0.67×2999=2009 还落在上一章；旧代码靠 +0.0005/+0.001 偏移补偿，结果恒为起始帧+1/+2）
  if (typeof ch.globalStartFrame === 'number') return ch.globalStartFrame;
  return Math.round(ch.progressRange[0] * (state.totalFrames - 1));
}
function gotoProgress(p) { setScrollToProgress(Math.min(1, Math.max(0, p)), false); }

/* 鼠标拖拽：与滚轮/触摸共用同一 progress；拖拽直接映射，松手带惯性，反向不被吞 */
function initDrag() {
  const stage = $('#stage');
  let drag = null;
  stage.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse') return;
    if (e.target.closest('button')) return;
    if (state.mode !== 'mainline') return;
    drag = { y: e.clientY, scroll: window.scrollY, lastY: e.clientY, lastT: performance.now(), vel: 0 };
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dy = e.clientY - drag.y;
    const now = performance.now(), dt = Math.max(1, now - drag.lastT);
    drag.vel = 0.7 * drag.vel + 0.3 * ((drag.lastY - e.clientY) / dt) * 16.7;
    drag.lastY = e.clientY; drag.lastT = now;
    const y = Math.min(maxScroll(), Math.max(0, drag.scroll - dy * 2.4));
    if (lenis) lenis.scrollTo(y, { immediate: true }); else window.scrollTo(0, y);
  });
  const end = () => {
    if (!drag) return;
    const fling = drag.vel * 14;
    drag = null;
    if (Math.abs(fling) > 4 && lenis && !state.reducedMotion)
      lenis.scrollTo(Math.min(maxScroll(), Math.max(0, window.scrollY + fling)), { duration: 0.7 });
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
}

/* ---------------- 减少动态模式 ---------------- */
function createLenis() {
  if (!window.Lenis || !window.gsap || lenis) return;
  lenis = new Lenis({ lerp: 0.09, smoothWheel: true });
  window.__lenis = lenis;
  if (window.ScrollTrigger) lenis.on('scroll', ScrollTrigger.update);
}
function applyReducedMotion(on) {
  state.reducedMotion = on;
  $('#motion-toggle').setAttribute('aria-pressed', String(on));
  $('#pager').hidden = !on;
  if (on) {
    if (lenis) { lenis.destroy(); lenis = null; window.__lenis = null; }
  } else {
    createLenis();
    if (state.mode === 'branch' && lenis) lenis.stop();
  }
  document.documentElement.style.scrollBehavior = on ? 'auto' : '';
}
function initPager() {
  // BUG-L01：±1 帧步进以精确帧号累进（基准 exactFrameTarget，回落 currentFrame），不经 progress/像素往返
  const step = (df) => {
    const base = exactFrameTarget !== null ? exactFrameTarget : state.currentFrame;
    setScrollToFrame(base + df, true);
  };
  $('#pg-next-f').addEventListener('click', () => step(1));
  $('#pg-prev-f').addEventListener('click', () => step(-1));
  $('#pg-next-ch').addEventListener('click', () => {
    const chs = state.manifest.chapters;
    const cur = chapterForFrame(state.currentFrame);
    const nxt = chs[Math.min(chs.length - 1, chs.indexOf(cur) + 1)];
    setScrollToFrame(chapterStartFrame(nxt), true); // 落点收紧到章节起始帧（原 +0.0005 偏移恒为 +1 帧）
  });
  $('#pg-prev-ch').addEventListener('click', () => {
    const chs = state.manifest.chapters;
    const cur = chapterForFrame(state.currentFrame);
    const prv = chs[Math.max(0, chs.indexOf(cur) - 1)];
    setScrollToFrame(chapterStartFrame(prv), true);
  });
  $('#motion-toggle').addEventListener('click', () => applyReducedMotion(!state.reducedMotion));
}

/* ---------------- 主循环 ---------------- */
const SCALE_STEPS = [1, 0.8, 0.66, 0.5];
let scaleIdx = 0, lastScaleAdjust = 0, lastTickAt = 0;
const tickDeltas = [];
let lastNoteFrame = -1;
function adaptScale(now, scrolling) {
  if (LEGACY) return;
  // 自适应渲染分辨率：滚动中持续帧时间 >26ms 则逐级降低画布光栅（0.8/0.66/0.5），
  // 静止 300ms 后恢复全分辨率并重绘最终帧（静止画质与原版一致）。
  if (scrolling) {
    if (tickDeltas.length < 24) return;
    const avg = tickDeltas.reduce((a, b) => a + b, 0) / tickDeltas.length;
    if (avg > 26 && scaleIdx < SCALE_STEPS.length - 1 && now - lastScaleAdjust > 600) {
      scaleIdx++; lastScaleAdjust = now;
      view.scale = SCALE_STEPS[scaleIdx];
      fitCanvas();
    }
  } else if (scaleIdx > 0 && now - lastProgressChangeAt > 300 && now - lastScaleAdjust > 300) {
    scaleIdx = 0; lastScaleAdjust = now;
    view.scale = 1;
    fitCanvas();
  }
}
function mainLoop(now) {
  if (state.mode === 'branch') { tickBranch(now); return; }
  if (!state.ready) return;
  const p = Math.min(1, Math.max(0, window.scrollY / maxScroll()));
  const g = Math.round(p * (state.totalFrames - 1));
  const scrolling = g !== state.currentFrame || Math.abs(p - state.progress) > 0.0005;
  if (scrolling) {
    if (g !== state.currentFrame) scrollDir = g > state.currentFrame ? 1 : -1;
    lastProgressChangeAt = now;
    if (lastTickAt) { tickDeltas.push(now - lastTickAt); if (tickDeltas.length > 30) tickDeltas.shift(); }
  }
  lastTickAt = now;
  state.progress = p;
  state.frameFloat = p * (state.totalFrames - 1);
  state.currentFrame = g;
  // BUG-L01：实际帧号偏离精确目标（手动滚动/拖拽/外部定位）时作废累进基准，下一次步进改用 currentFrame
  if (exactFrameTarget !== null && g !== exactFrameTarget) exactFrameTarget = null;
  adaptScale(now, scrolling);
  drawMainline(g); // 每 tick 检查：目标帧后加载完成时自动补上，不留空画面（同帧已绘时内部直接返回）
  syncChapterUI(g);
  syncHotspots(g);
  if (g !== lastNoteFrame) {
    lastNoteFrame = g;
    const note = $('#degraded-notice');
    const badSegs = Object.keys(state.degraded).filter(id => state.degraded[id] && locateGlobal(g).seg.id === id);
    if (badSegs.length) {
      note.hidden = false;
      note.textContent = '提示：本段（' + badSegs[0] + '）帧素材暂时不可用，已以海报图呈现；文字内容不受影响。';
    } else note.hidden = true;
  }
}

/* ---------------- 启动 ---------------- */
async function boot() {
  try {
    state.manifest = await loadJSON(ASSET_BASE + 'manifest.json', '__AETHER_MANIFEST__');
    state.chaptersData = await loadJSON(ASSET_BASE + state.manifest.content.chapters, '__AETHER_CHAPTERS__');
    state.parameters = await loadJSON(ASSET_BASE + state.manifest.content.parameters, '__AETHER_PARAMETERS__');
    state.references = await loadJSON(ASSET_BASE + state.manifest.content.references, '__AETHER_REFERENCES__');
    for (const h of state.manifest.hotspots)
      state.hotspots[h.anchorId] = await loadJSON(ASSET_BASE + h.file, null).catch(() => (window.__AETHER_HOTSPOTS__ || {})[h.anchorId]);
  } catch (e) {
    $('#preloader').style.display = 'none';
    $('#fatal-fallback').hidden = false;
    return;
  }
  const M = state.manifest;
  state.totalFrames = M.totalFrames.mainline;
  state.fps = M.globalFps;
  segIndex = M.segments.map(s => ({
    id: s.id, template: s.framesPathTemplate, count: s.frameCount,
    gStart: s.globalStartFrame, gEnd: s.globalEndFrame, poster: s.poster,
  }));
  for (const b of M.branches) branchIndex[b.id] = { id: b.id, template: b.framesPathTemplate, count: b.frameCount, poster: b.poster, parentAnchor: b.parentAnchor };

  buildChapters();
  buildHotspots();
  fitCanvas();
  window.addEventListener('resize', () => { fitCanvas(); if (state.currentFrame >= 0 && state.mode === 'mainline') drawMainline(state.currentFrame); });

  // Lenis 平滑滚动（减少动态时销毁停用）+ GSAP ticker 驱动
  if (window.gsap) {
    if (window.ScrollTrigger) gsap.registerPlugin(ScrollTrigger);
    createLenis();
    gsap.ticker.add((t) => { if (lenis) lenis.raf(t * 1000); mainLoop(performance.now()); });
    gsap.ticker.lagSmoothing(0);
  } else {
    createLenis();
    const raf = (t) => { if (lenis) lenis.raf(t); mainLoop(t); requestAnimationFrame(raf); };
    requestAnimationFrame(raf);
  }

  initDrag();
  initPager();
  $('#branch-exit').addEventListener('click', exitBranch);

  const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (mq.matches) applyReducedMotion(true);
  if (mq.addEventListener) mq.addEventListener('change', (e) => applyReducedMotion(e.matches));

  // 启动加载（按 manifest.loadingPriority 的顺序即计划顺序）
  const plan = buildLoadPlan();
  loader.total = plan.length; loader.queue = plan.slice();
  updateLoadUI(null);
  pumpLoader();
  state.currentFrame = 0;
  drawMainline(0); syncChapterUI(0); syncHotspots(0);
}

/* ---------------- 测试/调试接口（验收脚本使用） ---------------- */
window.__AETHER__ = {
  state, loader, cache,
  getProgress: () => state.progress,
  getFrame: () => state.currentFrame,
  getDisplayed: () => state.displayed,
  getMode: () => state.mode,
  getBranch: () => state.branch,
  isReduced: () => state.reducedMotion,
  loadStats: () => ({ settled: loader.settled, total: loader.total, failed: loader.failed, displayedPct: parseInt(($('#pre-pct').textContent || '0'), 10), allDone: loader.allDone, ready: state.ready }),
  setProgress(p, immediate = true) { setScrollToProgress(p, immediate); },
  enterBranch, exitBranch,
  coverTransform,
  hotspotRect(anchorId) {
    const b = hsButtons[anchorId];
    if (!b || b.hidden) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
  },
  // 把当前 Canvas 内容与指定主线帧逐像素比对（降采样 480x270 加速），返回差异统计
  async compareCanvasToFrame(g) {
    const { seg, local } = locateGlobal(g);
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = frameURL(seg, local); });
    const W = 480, H = 270;
    const c1 = document.createElement('canvas'); c1.width = W; c1.height = H;
    const x1 = c1.getContext('2d'); x1.drawImage(canvas, 0, 0, W, H);
    const c2 = document.createElement('canvas'); c2.width = W; c2.height = H;
    const x2 = c2.getContext('2d');
    const t = coverTransform();
    x2.drawImage(img, t.ox * W / view.w, t.oy * H / view.h, t.FW * t.scale * W / view.w, t.FH * t.scale * H / view.h);
    const d1 = x1.getImageData(0, 0, W, H).data, d2 = x2.getImageData(0, 0, W, H).data;
    let max = 0, sum = 0;
    for (let i = 0; i < d1.length; i += 4) {
      const d = Math.max(Math.abs(d1[i] - d2[i]), Math.abs(d1[i + 1] - d2[i + 1]), Math.abs(d1[i + 2] - d2[i + 2]));
      if (d > max) max = d; sum += d;
    }
    return { maxDiff: max, meanDiff: sum / (d1.length / 4) };
  },
  // 支线第 0 帧与锚帧 WebP 逐像素比对（原始分辨率采样）
  async compareBranch0ToAnchor(anchorId) {
    const a = state.manifest.anchors.find(x => x.id === anchorId);
    const bi = branchIndex[a.branchId];
    const load = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
    const [anchorImg, branchImg] = await Promise.all([load(ASSET_BASE + a.anchorFrameWebp), load(frameURL(bi, 0))]);
    const W = 480, H = 270;
    const mk = (img) => { const c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d'); x.drawImage(img, 0, 0, W, H); return x.getImageData(0, 0, W, H).data; };
    const d1 = mk(anchorImg), d2 = mk(branchImg);
    let max = 0;
    for (let i = 0; i < d1.length; i++) { const d = Math.abs(d1[i] - d2[i]); if (d > max) max = d; }
    return { maxDiff: max };
  },
};

document.addEventListener('DOMContentLoaded', boot);
