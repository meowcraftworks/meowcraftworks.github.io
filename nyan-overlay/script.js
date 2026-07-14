'use strict';

/* =========================================================
   にゃんOverlay — Canvasのみで完結する二重露光風合成
   すべてブラウザ内で処理（外部送信なし）
   ========================================================= */

const MAX_LAYERS = 8;
const PREVIEW_MAX = 1000;   // プレビューcanvasの最長辺
const MASK_MAX = 1600;      // マスク済みオフスクリーンの最長辺
const EXPORT_MAX = 4000;    // 書き出し時の最長辺の上限
const CUT_LOW = 640;        // 切り抜きスライダー操作中の低解像度プレビュー
const CUT_EXPORT_MAX = 2400; // 書き出し時の切り抜き解像度の上限（処理時間の頭打ち用）

/* ---------- 状態 ---------- */
let bgImage = null;
const layers = [];
let selected = -1;
let uid = 0;

/* ---------- DOM ---------- */
const $ = (id) => document.getElementById(id);
const canvas = $('stage');
const ctx = canvas.getContext('2d');
const stageWrap = $('stageWrap');
const dropHint = $('dropHint');
const thumbsEl = $('thumbs');
const layerSelect = $('layerSelect');
const panel = $('panel');

const ctl = {
  posX: $('posX'), posY: $('posY'), scale: $('scale'), rotation: $('rotation'),
  opacity: $('opacity'), feather: $('feather'), maskCy: $('maskCy'),
  maskAspect: $('maskAspect'), blendMode: $('blendMode'),
  glowOn: $('glowOn'), glowStrength: $('glowStrength'),
  cutOn: $('cutOn'), cutTol: $('cutTol'), cutSoft: $('cutSoft'),
};

/* =========================================================
   画像読み込み
   ========================================================= */
function fileToImage(file) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type.startsWith('image/')) return reject(new Error('not image'));
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('load fail')); };
    img.src = url;
  });
}

$('bgInput').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    bgImage = await fileToImage(f);
    setupCanvasSize();
    dropHint.classList.add('hide');
    $('addOverlayBtn').disabled = layers.length >= MAX_LAYERS;
    $('downloadBtn').disabled = false;
    render();
  } catch (_) { alert('画像を読み込めませんでした'); }
  e.target.value = '';
});

$('addOverlayBtn').addEventListener('click', () => {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*';
  inp.onchange = async () => {
    const f = inp.files[0];
    if (f) await addOverlay(f);
  };
  inp.click();
});

async function addOverlay(file) {
  if (layers.length >= MAX_LAYERS) return;
  let img;
  try { img = await fileToImage(file); } catch (_) { return; }
  const layer = {
    image: img,
    x: 0.5, y: 0.42,
    scale: 1.0, rotation: 0, opacity: 0.85,
    blendMode: 'screen',
    feather: 0.35, maskCy: 0.45, maskAspect: 1.25,
    cutout: { enabled: true, tolerance: 0.18, edgeSoften: 1 },
    glow: { enabled: true, strength: 0.3 },
    zIndex: layers.length,
    id: ++uid,
    _masked: null, _dirty: true, _render: null,
    _cut: null, _cutDirty: true, _cutSize: 0, _cutMax: MASK_MAX,
  };
  layers.push(layer);
  selected = layers.length - 1;
  $('addOverlayBtn').disabled = layers.length >= MAX_LAYERS;
  rebuildLayerUI();
  syncControls();
  render();
}

/* =========================================================
   Canvasサイズ設定（背景アスペクトに合わせる）
   ========================================================= */
function setupCanvasSize() {
  if (!bgImage) return;
  const iw = bgImage.naturalWidth, ih = bgImage.naturalHeight;
  const s = Math.min(1, PREVIEW_MAX / Math.max(iw, ih));
  canvas.width = Math.max(1, Math.round(iw * s));
  canvas.height = Math.max(1, Math.round(ih * s));
}

/* =========================================================
   背景の切り抜き（フラッドフィル / マジックワンド方式）
   画像の四辺から同系色の領域を連結成分ごとにたどって透明化する。
   外部APIもライブラリも使わずに済む反面、背景が単色〜緩やかな
   グラデーションの写真に向く。
   ========================================================= */
function buildCutCanvas(layer, maxSize) {
  const img = layer.image;
  let w = img.naturalWidth, h = img.naturalHeight;
  const s = Math.min(1, maxSize / Math.max(w, h));
  w = Math.max(1, Math.round(w * s));
  h = Math.max(1, Math.round(h * s));

  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, w, h);

  const id = g.getImageData(0, 0, w, h);
  const d = id.data;
  const n = w * h;
  const tol = layer.cutout.tolerance * 255;
  const tol2 = tol * tol * 3;               // 二乗距離で比較（sqrt を避ける）

  const visited = new Uint8Array(n);
  const stack = new Int32Array(n);           // 各ピクセルは高々1回しか積まれない

  // 四辺のピクセルを種にする
  const seeds = [];
  for (let x = 0; x < w; x++) { seeds.push(x, (h - 1) * w + x); }
  for (let y = 0; y < h; y++) { seeds.push(y * w, y * w + w - 1); }

  for (const seed of seeds) {
    if (visited[seed]) continue;
    // 連結成分ごとに種ピクセルの色を基準にする（背景が複数色でも対応できる）
    const si = seed * 4;
    const sr = d[si], sg = d[si + 1], sb = d[si + 2];
    let sp = 0;
    stack[sp++] = seed;
    visited[seed] = 1;
    while (sp > 0) {
      const p = stack[--sp];
      const i = p * 4;
      const dr = d[i] - sr, dg = d[i + 1] - sg, db = d[i + 2] - sb;
      if (dr * dr + dg * dg + db * db > tol2) continue; // 被写体側 → ここで止める
      d[i + 3] = 0;
      const x = p % w, y = (p / w) | 0;
      if (x > 0 && !visited[p - 1]) { visited[p - 1] = 1; stack[sp++] = p - 1; }
      if (x < w - 1 && !visited[p + 1]) { visited[p + 1] = 1; stack[sp++] = p + 1; }
      if (y > 0 && !visited[p - w]) { visited[p - w] = 1; stack[sp++] = p - w; }
      if (y < h - 1 && !visited[p + w]) { visited[p + w] = 1; stack[sp++] = p + w; }
    }
  }

  const soften = layer.cutout.edgeSoften | 0;
  if (soften > 0) blurAlpha(d, w, h, soften);
  g.putImageData(id, 0, 0);
  return c;
}

/* アルファチャンネルだけをボックスブラー（切り抜きのギザギザを馴染ませる） */
function blurAlpha(d, w, h, r) {
  const n = w * h;
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = d[i * 4 + 3];
  const tmp = new Float32Array(n);
  const win = r * 2 + 1;

  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += a[row + Math.min(w - 1, Math.max(0, k))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / win;
      sum += a[row + Math.min(w - 1, x + r + 1)] - a[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += tmp[Math.min(h - 1, Math.max(0, k)) * w + x];
    for (let y = 0; y < h; y++) {
      d[(y * w + x) * 4 + 3] = sum / win;
      sum += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
}

/* 切り抜き結果のキャッシュ（パラメータが変わった時だけ作り直す） */
function ensureCut(layer, maxSize) {
  if (layer._cutDirty || !layer._cut || layer._cutSize !== maxSize) {
    layer._cut = buildCutCanvas(layer, maxSize);
    layer._cutSize = maxSize;
    layer._cutDirty = false;
  }
  return layer._cut;
}

function sourceFor(layer, maxSize, isExport) {
  if (!layer.cutout.enabled) return layer.image;
  if (isExport) return buildCutCanvas(layer, Math.min(maxSize, CUT_EXPORT_MAX));
  return ensureCut(layer, Math.min(maxSize, layer._cutMax));
}

/* =========================================================
   フェザー / 楕円マスクの適用
   ========================================================= */
function buildMaskedCanvas(layer, maxSize, isExport) {
  const src = sourceFor(layer, maxSize, isExport);
  let w = src.naturalWidth || src.width;
  let h = src.naturalHeight || src.height;
  const s = Math.min(1, maxSize / Math.max(w, h));
  w = Math.max(1, Math.round(w * s));
  h = Math.max(1, Math.round(h * s));

  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const cx2 = c.getContext('2d');
  cx2.drawImage(src, 0, 0, w, h);

  // マスクを destination-in で適用
  cx2.globalCompositeOperation = 'destination-in';
  const cx = w * 0.5;
  const cy = h * layer.maskCy;
  const aspect = layer.maskAspect;              // >1 で縦長
  const rBase = Math.max(w, h) * 0.62;
  const feather = Math.min(0.999, Math.max(0, layer.feather));

  cx2.save();
  cx2.translate(cx, cy);
  cx2.scale(1, aspect);
  const grad = cx2.createRadialGradient(0, 0, 0, 0, 0, rBase);
  grad.addColorStop(0, 'rgba(0,0,0,1)');
  grad.addColorStop(Math.max(0.001, 1 - feather), 'rgba(0,0,0,1)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  cx2.fillStyle = grad;
  cx2.fillRect(-w * 2, -h * 3, w * 4, h * 6);
  cx2.restore();
  cx2.globalCompositeOperation = 'source-over';
  return c;
}

/* プレビュー用マスクのキャッシュ（変更のあったレイヤーだけ再生成） */
function ensurePreviewMask(layer) {
  if (layer._dirty || !layer._masked) {
    layer._masked = buildMaskedCanvas(layer, MASK_MAX, false);
    layer._dirty = false;
  }
  return layer._masked;
}

/* =========================================================
   合成描画
   ========================================================= */
function coverRect(iw, ih, W, H) {
  const s = Math.max(W / iw, H / ih);
  const w = iw * s, h = ih * s;
  return { x: (W - w) / 2, y: (H - h) / 2, w, h };
}

function renderTo(g, W, H, isExport) {
  g.clearRect(0, 0, W, H);
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);

  if (bgImage) {
    const r = coverRect(bgImage.naturalWidth, bgImage.naturalHeight, W, H);
    g.drawImage(bgImage, r.x, r.y, r.w, r.h);
  }

  const sorted = layers.slice().sort((a, b) => a.zIndex - b.zIndex);
  for (const layer of sorted) {
    if (!layer.image) continue;
    // 書き出し時は必要な描画ピクセル数に合わせて作り直す
    // （プレビュー用キャッシュは最大 MASK_MAX なので流用すると拡大でぼやける）
    const mc = isExport
      ? buildMaskedCanvas(layer, Math.max(1, Math.ceil(Math.min(W, H) * 0.7 * layer.scale)), true)
      : ensurePreviewMask(layer);

    const anchorX = layer.x * W;
    const anchorY = layer.y * H;
    const fit = (Math.min(W, H) * 0.7) / Math.max(mc.width, mc.height);
    const drawScale = fit * layer.scale;
    const dw = mc.width * drawScale;
    const dh = mc.height * drawScale;
    // マスク中心をアンカー位置に合わせるためのオフセット
    const offY = (layer.maskCy - 0.5) * dh;
    const top = -dh / 2 - offY;

    g.save();
    g.translate(anchorX, anchorY);
    g.rotate(layer.rotation * Math.PI / 180);

    // グロー（後光）
    if (layer.glow.enabled && layer.glow.strength > 0) {
      const gr = Math.max(dw, dh) * 0.62;
      const a = layer.glow.strength * 0.55;
      const gg = g.createRadialGradient(0, 0, gr * 0.08, 0, 0, gr);
      gg.addColorStop(0, `rgba(255,255,255,${a})`);
      gg.addColorStop(1, 'rgba(255,255,255,0)');
      g.globalCompositeOperation = 'lighten';
      g.fillStyle = gg;
      g.beginPath();
      g.arc(0, 0, gr, 0, Math.PI * 2);
      g.fill();
    }

    g.globalCompositeOperation = layer.blendMode;
    g.globalAlpha = layer.opacity;
    g.drawImage(mc, -dw / 2, top, dw, dh);
    g.restore();
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';

    // ヒットテスト・枠描画用メトリクス（プレビュー描画時のみ）
    if (!isExport) {
      layer._render = { ax: anchorX, ay: anchorY, dw, dh, top, mc };
    }
  }

  // 選択枠とハンドルは全レイヤーの上に描く（背面レイヤー選択時に隠れないように）
  const sel = layers[selected];
  if (!isExport && sel && sel._render) {
    const m = sel._render;
    g.save();
    g.translate(m.ax, m.ay);
    g.rotate(sel.rotation * Math.PI / 180);
    g.strokeStyle = 'rgba(110,168,255,0.9)';
    g.lineWidth = 2 * cssToCanvas();
    g.setLineDash([8, 6]);
    g.strokeRect(-m.dw / 2, m.top, m.dw, m.dh);
    g.setLineDash([]);

    const hr = handleRadius();
    g.fillStyle = '#6ea8ff';
    g.strokeStyle = '#fff';
    g.lineWidth = Math.max(1, hr * 0.22);
    for (const [hx, hy] of cornersOf(m)) {
      g.beginPath();
      g.arc(hx, hy, hr, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    }
    g.restore();
  }
}

function render() {
  renderTo(ctx, canvas.width, canvas.height, false);
}

/* 高頻度イベント（ドラッグ・スライダー）用: 1フレーム1回に描画を集約 */
let _rafId = 0;
function requestRender() {
  if (_rafId) return;
  _rafId = requestAnimationFrame(() => { _rafId = 0; render(); });
}

/* =========================================================
   Canvas上の操作（移動 / 四隅ハンドル・ピンチ・ホイールで拡大縮小）
   ========================================================= */
const pointers = new Map();
let mode = null;          // 'move' | 'resize' | 'pinch'
let pinch = null;
let resizeStart = null;
let dragOffX = 0, dragOffY = 0;

/* CSSピクセル → canvas内部ピクセルの比率（枠やハンドルを画面上で一定サイズに保つ） */
function cssToCanvas() {
  const rect = canvas.getBoundingClientRect();
  return rect.width ? canvas.width / rect.width : 1;
}
function handleRadius() { return 9 * cssToCanvas(); }

function toCanvasCoords(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (clientX - rect.left) * (canvas.width / rect.width),
    y: (clientY - rect.top) * (canvas.height / rect.height),
  };
}

/* 回転を打ち消してレイヤーのローカル座標に変換 */
function toLocal(layer, px, py) {
  const m = layer._render;
  const dx = px - m.ax, dy = py - m.ay;
  const a = -layer.rotation * Math.PI / 180;
  return { x: dx * Math.cos(a) - dy * Math.sin(a), y: dx * Math.sin(a) + dy * Math.cos(a) };
}

function cornersOf(m) {
  return [
    [-m.dw / 2, m.top], [m.dw / 2, m.top],
    [m.dw / 2, m.top + m.dh], [-m.dw / 2, m.top + m.dh],
  ];
}

function hitRect(l, px, py) {
  if (!l._render) return false;
  const p = toLocal(l, px, py);
  const m = l._render;
  return p.x >= -m.dw / 2 && p.x <= m.dw / 2 && p.y >= m.top && p.y <= m.top + m.dh;
}

function alphaAt(l, px, py) {
  const m = l._render;
  const p = toLocal(l, px, py);
  const u = Math.floor((p.x + m.dw / 2) / m.dw * m.mc.width);
  const v = Math.floor((p.y - m.top) / m.dh * m.mc.height);
  if (u < 0 || v < 0 || u >= m.mc.width || v >= m.mc.height) return 0;
  return m.mc.getContext('2d').getImageData(u, v, 1, 1).data[3];
}

function zOrder() {
  return layers.map((l, i) => ({ l, i })).sort((a, b) => b.l.zIndex - a.l.zIndex);
}

/* まず不透明部分で判定 → 見つからなければ枠内で判定（薄い部分も掴めるように） */
function pickLayer(px, py) {
  const order = zOrder();
  for (const { l, i } of order) if (hitRect(l, px, py) && alphaAt(l, px, py) > 10) return i;
  for (const { l, i } of order) if (hitRect(l, px, py)) return i;
  return -1;
}
function pickLayerRect(px, py) {
  for (const { l, i } of zOrder()) if (hitRect(l, px, py)) return i;
  return -1;
}

function pickHandle(px, py) {
  const l = layers[selected];
  if (!l || !l._render) return false;
  const p = toLocal(l, px, py);
  const hr = handleRadius() * 1.8; // 指でも押しやすいよう判定は見た目より広め
  for (const [hx, hy] of cornersOf(l._render)) {
    if (Math.hypot(p.x - hx, p.y - hy) <= hr) return true;
  }
  return false;
}

function setScale(l, v) {
  l.scale = Math.min(3, Math.max(0.1, v));
  ctl.scale.value = l.scale;
  $('scaleo').textContent = l.scale.toFixed(2) + 'x';
}
function clampPos(v) { return Math.min(1.2, Math.max(-0.2, v)); }
function syncPosUI(l) {
  ctl.posX.value = l.x; ctl.posY.value = l.y;
  $('posXo').textContent = Math.round(l.x * 100) + '%';
  $('posYo').textContent = Math.round(l.y * 100) + '%';
}

canvas.addEventListener('pointerdown', (e) => {
  if (!bgImage) return;
  const p = toCanvasCoords(e.clientX, e.clientY);
  pointers.set(e.pointerId, p);
  try { canvas.setPointerCapture(e.pointerId); } catch (_) {}

  // 2本指 → ピンチで拡大縮小＋移動
  if (pointers.size === 2 && selected >= 0) {
    const [a, b] = [...pointers.values()];
    const l = layers[selected];
    pinch = {
      dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      scale: l.scale,
      mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2,
      lx: l.x, ly: l.y,
    };
    mode = 'pinch';
    return;
  }
  if (pointers.size !== 1) return;

  // 四隅ハンドル → 拡大縮小
  if (selected >= 0 && pickHandle(p.x, p.y)) {
    const l = layers[selected];
    resizeStart = { d: Math.hypot(p.x - l._render.ax, p.y - l._render.ay) || 1, scale: l.scale };
    mode = 'resize';
    return;
  }

  const hit = pickLayer(p.x, p.y);
  if (hit >= 0) {
    selected = hit;
    const l = layers[hit];
    dragOffX = p.x - l.x * canvas.width;
    dragOffY = p.y - l.y * canvas.height;
    mode = 'move';
    layerSelect.value = String(hit);
    syncControls();
    updateThumbActive();
    render();
  } else {
    mode = null;
  }
});

canvas.addEventListener('pointermove', (e) => {
  const p = toCanvasCoords(e.clientX, e.clientY);

  if (!pointers.has(e.pointerId)) {
    if (e.pointerType === 'mouse' && bgImage) {
      canvas.style.cursor = (selected >= 0 && pickHandle(p.x, p.y)) ? 'nwse-resize'
        : (pickLayerRect(p.x, p.y) >= 0 ? 'move' : 'default');
    }
    return;
  }
  pointers.set(e.pointerId, p);
  const l = layers[selected];
  if (!l) return;

  if (mode === 'pinch' && pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    setScale(l, pinch.scale * (dist / pinch.dist));
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    l.x = clampPos(pinch.lx + (mx - pinch.mx) / canvas.width);
    l.y = clampPos(pinch.ly + (my - pinch.my) / canvas.height);
    syncPosUI(l);
    requestRender();
  } else if (mode === 'resize') {
    const d = Math.hypot(p.x - l._render.ax, p.y - l._render.ay) || 1;
    setScale(l, resizeStart.scale * (d / resizeStart.d));
    requestRender();
  } else if (mode === 'move') {
    l.x = clampPos((p.x - dragOffX) / canvas.width);
    l.y = clampPos((p.y - dragOffY) / canvas.height);
    syncPosUI(l);
    requestRender();
  }
});

function endPointer(e) {
  if (!pointers.delete(e.pointerId)) return;
  try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
  if (pointers.size === 0) { mode = null; pinch = null; resizeStart = null; }
  else if (mode === 'pinch' && pointers.size < 2) { mode = null; pinch = null; }
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
// キャプチャが取れなかった場合に指を離したことを取りこぼすと、
// 以降の1本指ドラッグが幻のピンチ扱いになるため window でも拾っておく
window.addEventListener('pointerup', endPointer);
window.addEventListener('pointercancel', endPointer);
canvas.addEventListener('lostpointercapture', endPointer);

canvas.addEventListener('wheel', (e) => {
  const l = layers[selected];
  if (!l) return;
  e.preventDefault();
  setScale(l, l.scale * (1 - e.deltaY * 0.0015));
  requestRender();
}, { passive: false });

/* =========================================================
   レイヤー選択UI（ドロップダウン＋サムネイル）
   ========================================================= */
function rebuildLayerUI() {
  layerSelect.innerHTML = '';
  layers.forEach((_, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = `猫${i + 1}`;
    layerSelect.appendChild(o);
  });
  if (selected >= 0) layerSelect.value = String(selected);

  thumbsEl.innerHTML = '';
  layers.forEach((l, i) => {
    const t = document.createElement('div');
    t.className = 'thumb' + (i === selected ? ' active' : '');
    if (l.image) t.style.backgroundImage = `url(${thumbURL(l.image)})`;
    t.innerHTML = `<span class="idx">${i + 1}</span>`;
    t.addEventListener('click', () => {
      selected = i;
      layerSelect.value = String(i);
      syncControls();
      updateThumbActive();
      render();
    });
    thumbsEl.appendChild(t);
  });

  panel.classList.toggle('panel-disabled', selected < 0 || layers.length === 0);
  $('layerCount').textContent = `${layers.length} / ${MAX_LAYERS}`;
}

const _thumbCache = new WeakMap();
function thumbURL(img) {
  if (_thumbCache.has(img)) return _thumbCache.get(img);
  const c = document.createElement('canvas');
  const s = 56 / Math.max(img.naturalWidth, img.naturalHeight);
  c.width = Math.max(1, img.naturalWidth * s);
  c.height = Math.max(1, img.naturalHeight * s);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  const url = c.toDataURL('image/png');
  _thumbCache.set(img, url);
  return url;
}

function updateThumbActive() {
  [...thumbsEl.children].forEach((el, i) =>
    el.classList.toggle('active', i === selected));
}

layerSelect.addEventListener('change', () => {
  selected = parseInt(layerSelect.value, 10);
  syncControls();
  updateThumbActive();
  render();
});

/* =========================================================
   コントロール同期
   ========================================================= */
function syncControls() {
  const l = layers[selected];
  panel.classList.toggle('panel-disabled', !l);
  if (!l) return;
  syncPosUI(l);
  ctl.scale.value = l.scale; $('scaleo').textContent = l.scale.toFixed(2) + 'x';
  ctl.rotation.value = l.rotation; $('rotationo').textContent = Math.round(l.rotation) + '°';
  ctl.opacity.value = l.opacity; $('opacityo').textContent = Math.round(l.opacity * 100) + '%';
  ctl.cutOn.checked = l.cutout.enabled;
  ctl.cutTol.value = l.cutout.tolerance; $('cutTolo').textContent = Math.round(l.cutout.tolerance * 100) + '%';
  ctl.cutSoft.value = l.cutout.edgeSoften; $('cutSofto').textContent = l.cutout.edgeSoften + 'px';
  ctl.feather.value = l.feather; $('feathero').textContent = Math.round(l.feather * 100) + '%';
  ctl.maskCy.value = l.maskCy; $('maskCyo').textContent = Math.round(l.maskCy * 100) + '%';
  ctl.maskAspect.value = l.maskAspect; $('maskAspecto').textContent = l.maskAspect.toFixed(2);
  ctl.blendMode.value = l.blendMode;
  ctl.glowOn.checked = l.glow.enabled;
  ctl.glowStrength.value = l.glow.strength;
  $('glowStrengtho').textContent = Math.round(l.glow.strength * 100) + '%';
}

function withLayer(fn, markDirty) {
  const l = layers[selected];
  if (!l) return;
  fn(l);
  if (markDirty) l._dirty = true;
  requestRender(); // input イベントは連続発火するため rAF に集約
}

/* スライダー配線 */
ctl.posX.addEventListener('input', () => withLayer(l => {
  l.x = +ctl.posX.value; $('posXo').textContent = Math.round(l.x * 100) + '%';
}));
ctl.posY.addEventListener('input', () => withLayer(l => {
  l.y = +ctl.posY.value; $('posYo').textContent = Math.round(l.y * 100) + '%';
}));
ctl.scale.addEventListener('input', () => withLayer(l => {
  l.scale = +ctl.scale.value; $('scaleo').textContent = l.scale.toFixed(2) + 'x';
}));
ctl.rotation.addEventListener('input', () => withLayer(l => {
  l.rotation = +ctl.rotation.value; $('rotationo').textContent = Math.round(l.rotation) + '°';
}));
ctl.opacity.addEventListener('input', () => withLayer(l => {
  l.opacity = +ctl.opacity.value; $('opacityo').textContent = Math.round(l.opacity * 100) + '%';
}));

/* 切り抜き: 再計算が重いのでドラッグ中は低解像度、指を離したら本解像度で作り直す */
ctl.cutOn.addEventListener('change', () => withLayer(l => {
  l.cutout.enabled = ctl.cutOn.checked;
  l._cutDirty = true;
}, true));
ctl.cutTol.addEventListener('input', () => withLayer(l => {
  l.cutout.tolerance = +ctl.cutTol.value;
  $('cutTolo').textContent = Math.round(l.cutout.tolerance * 100) + '%';
  l._cutMax = CUT_LOW; l._cutDirty = true;
}, true));
ctl.cutTol.addEventListener('change', () => withLayer(l => {
  l._cutMax = MASK_MAX; l._cutDirty = true;
}, true));
ctl.cutSoft.addEventListener('input', () => withLayer(l => {
  l.cutout.edgeSoften = +ctl.cutSoft.value;
  $('cutSofto').textContent = l.cutout.edgeSoften + 'px';
  l._cutMax = CUT_LOW; l._cutDirty = true;
}, true));
ctl.cutSoft.addEventListener('change', () => withLayer(l => {
  l._cutMax = MASK_MAX; l._cutDirty = true;
}, true));

ctl.feather.addEventListener('input', () => withLayer(l => {
  l.feather = +ctl.feather.value; $('feathero').textContent = Math.round(l.feather * 100) + '%';
}, true));
ctl.maskCy.addEventListener('input', () => withLayer(l => {
  l.maskCy = +ctl.maskCy.value; $('maskCyo').textContent = Math.round(l.maskCy * 100) + '%';
}, true));
ctl.maskAspect.addEventListener('input', () => withLayer(l => {
  l.maskAspect = +ctl.maskAspect.value; $('maskAspecto').textContent = l.maskAspect.toFixed(2);
}, true));
ctl.blendMode.addEventListener('change', () => withLayer(l => { l.blendMode = ctl.blendMode.value; }));
ctl.glowOn.addEventListener('change', () => withLayer(l => { l.glow.enabled = ctl.glowOn.checked; }));
ctl.glowStrength.addEventListener('input', () => withLayer(l => {
  l.glow.strength = +ctl.glowStrength.value;
  $('glowStrengtho').textContent = Math.round(l.glow.strength * 100) + '%';
}));

/* 重ね順・削除 */
$('frontBtn').addEventListener('click', () => reorder(+1));
$('backBtn').addEventListener('click', () => reorder(-1));
function reorder(dir) {
  const l = layers[selected];
  if (!l) return;
  const target = l.zIndex + dir;
  const other = layers.find(o => o.zIndex === target);
  if (other) { other.zIndex = l.zIndex; l.zIndex = target; }
  render();
}

$('deleteBtn').addEventListener('click', () => {
  if (selected < 0) return;
  layers.splice(selected, 1);
  layers.slice().sort((a, b) => a.zIndex - b.zIndex).forEach((l, i) => l.zIndex = i);
  selected = layers.length ? Math.min(selected, layers.length - 1) : -1;
  $('addOverlayBtn').disabled = layers.length >= MAX_LAYERS;
  rebuildLayerUI();
  syncControls();
  render();
});

/* =========================================================
   ドラッグ&ドロップ読み込み
   ========================================================= */
['dragenter', 'dragover'].forEach(ev =>
  stageWrap.addEventListener(ev, (e) => { e.preventDefault(); stageWrap.classList.add('dragover'); }));
['dragleave', 'drop'].forEach(ev =>
  stageWrap.addEventListener(ev, (e) => { e.preventDefault(); stageWrap.classList.remove('dragover'); }));

stageWrap.addEventListener('drop', async (e) => {
  const files = [...(e.dataTransfer?.files || [])].filter(f => f.type.startsWith('image/'));
  if (!files.length) return;
  if (!bgImage) {
    try {
      bgImage = await fileToImage(files[0]);
      setupCanvasSize();
      dropHint.classList.add('hide');
      $('addOverlayBtn').disabled = false;
      $('downloadBtn').disabled = false;
      render();
    } catch (_) {}
    files.shift();
  }
  for (const f of files) {
    if (layers.length >= MAX_LAYERS) break;
    await addOverlay(f);
  }
});

/* =========================================================
   PNG書き出し（元解像度で再合成）
   ========================================================= */
$('downloadBtn').addEventListener('click', () => {
  if (!bgImage) return;
  const btn = $('downloadBtn');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '書き出し中…';
  // 切り抜きの再計算で固まるので、ラベルを描き終えてから処理を始める。
  // requestAnimationFrame は描画が止まっているタブでは発火せず書き出しごと
  // 止まってしまうため、描画状態に依存しない setTimeout を使う。
  setTimeout(() => {
    try { doExport(); } finally { btn.disabled = false; btn.textContent = label; }
  }, 50);
});

function doExport() {
  const iw = bgImage.naturalWidth, ih = bgImage.naturalHeight;
  const s = Math.min(1, EXPORT_MAX / Math.max(iw, ih));
  const W = Math.max(1, Math.round(iw * s));
  const H = Math.max(1, Math.round(ih * s));

  const out = document.createElement('canvas');
  out.width = W; out.height = H;
  renderTo(out.getContext('2d'), W, H, true);

  out.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `composite_${tstamp()}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, 'image/png');
}

function tstamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/* 初期化 */
rebuildLayerUI();
