'use strict';

/* =========================================================
   二重露光メーカー — Canvasのみで完結する画像合成
   すべてブラウザ内で処理（外部送信なし）
   ========================================================= */

const MAX_LAYERS = 8;
const PREVIEW_MAX = 1000;   // プレビューcanvasの最長辺
const MASK_MAX = 1600;      // マスク済みオフスクリーンの最長辺
const EXPORT_MAX = 4000;    // 書き出し時の最長辺の上限

/* ---------- 状態 ---------- */
let bgImage = null;
const layers = [];          // { image, x, y, scale, rotation, opacity, blendMode,
                            //   feather, maskCy, maskAspect, glow:{enabled,strength},
                            //   zIndex, _masked, _dirty, _render }
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
    feather: 0.55, maskCy: 0.45, maskAspect: 1.25,
    glow: { enabled: true, strength: 0.3 },
    zIndex: layers.length,
    id: ++uid,
    _masked: null, _dirty: true, _render: null,
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
   マスク済みオフスクリーン生成（フェザー/楕円マスク）
   ========================================================= */
function buildMaskedCanvas(layer, maxSize) {
  const img = layer.image;
  let w = img.naturalWidth, h = img.naturalHeight;
  const s = Math.min(1, maxSize / Math.max(w, h));
  w = Math.max(1, Math.round(w * s));
  h = Math.max(1, Math.round(h * s));

  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const cx2 = c.getContext('2d');
  cx2.drawImage(img, 0, 0, w, h);

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
    layer._masked = buildMaskedCanvas(layer, MASK_MAX);
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
    // 書き出し時は必要な描画ピクセル数に合わせた解像度でマスクを作り直す
    // （プレビュー用キャッシュは最大 MASK_MAX なので流用すると拡大でぼやける）
    const mc = isExport
      ? buildMaskedCanvas(layer, Math.max(1, Math.ceil(Math.min(W, H) * 0.7 * layer.scale)))
      : ensurePreviewMask(layer);

    const anchorX = layer.x * W;
    const anchorY = layer.y * H;
    const fit = (Math.min(W, H) * 0.7) / Math.max(mc.width, mc.height);
    const drawScale = fit * layer.scale;
    const dw = mc.width * drawScale;
    const dh = mc.height * drawScale;
    // マスク中心をアンカー位置に合わせるためのオフセット
    const offY = (layer.maskCy - 0.5) * dh;

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
    g.drawImage(mc, -dw / 2, -dh / 2 - offY, dw, dh);
    g.restore();
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';

    // ヒットテスト・選択枠用メトリクス（プレビュー描画時のみ）
    if (!isExport) {
      layer._render = {
        ax: anchorX, ay: anchorY, r: Math.max(dw, dh) * 0.5,
        dw, dh, offY,
      };
    }
  }

  // 選択枠は全レイヤーの上に描く（背面レイヤー選択時に枠が隠れないように）
  const sel = layers[selected];
  if (!isExport && sel && sel._render) {
    const m = sel._render;
    g.save();
    g.translate(m.ax, m.ay);
    g.rotate(sel.rotation * Math.PI / 180);
    g.strokeStyle = 'rgba(110,168,255,0.9)';
    g.lineWidth = 2;
    g.setLineDash([8, 6]);
    g.strokeRect(-m.dw / 2, -m.dh / 2 - m.offY, m.dw, m.dh);
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
   Canvas上のドラッグで位置移動 & 選択
   ========================================================= */
let dragging = false;
let dragOffX = 0, dragOffY = 0;

function toCanvasCoords(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (clientX - rect.left) * (canvas.width / rect.width),
    y: (clientY - rect.top) * (canvas.height / rect.height),
  };
}

function pickLayer(px, py) {
  // 前面（zIndex大）から順にヒットテスト
  const sorted = layers.map((l, i) => ({ l, i }))
    .sort((a, b) => b.l.zIndex - a.l.zIndex);
  for (const { l, i } of sorted) {
    if (!l._render) continue;
    const dx = px - l._render.ax, dy = py - l._render.ay;
    if (Math.hypot(dx, dy) <= l._render.r) return i;
  }
  return -1;
}

canvas.addEventListener('pointerdown', (e) => {
  if (!bgImage) return;
  const p = toCanvasCoords(e.clientX, e.clientY);
  const hit = pickLayer(p.x, p.y);
  if (hit >= 0) {
    selected = hit;
    dragging = true;
    canvas.setPointerCapture(e.pointerId);
    const l = layers[hit];
    dragOffX = p.x - l.x * canvas.width;
    dragOffY = p.y - l.y * canvas.height;
    layerSelect.value = String(hit);
    syncControls();
    updateThumbActive();
    render();
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (!dragging || selected < 0) return;
  const p = toCanvasCoords(e.clientX, e.clientY);
  const l = layers[selected];
  l.x = Math.min(1.2, Math.max(-0.2, (p.x - dragOffX) / canvas.width));
  l.y = Math.min(1.2, Math.max(-0.2, (p.y - dragOffY) / canvas.height));
  ctl.posX.value = l.x; ctl.posY.value = l.y;
  $('posXo').textContent = Math.round(l.x * 100) + '%';
  $('posYo').textContent = Math.round(l.y * 100) + '%';
  requestRender();
});

function endDrag(e) {
  if (dragging) {
    dragging = false;
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
  }
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

/* =========================================================
   レイヤー選択UI（ドロップダウン＋サムネイル）
   ========================================================= */
function rebuildLayerUI() {
  // ドロップダウン
  layerSelect.innerHTML = '';
  layers.forEach((_, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = `猫${i + 1}`;
    layerSelect.appendChild(o);
  });
  if (selected >= 0) layerSelect.value = String(selected);

  // サムネイル
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
  ctl.posX.value = l.x; $('posXo').textContent = Math.round(l.x * 100) + '%';
  ctl.posY.value = l.y; $('posYo').textContent = Math.round(l.y * 100) + '%';
  ctl.scale.value = l.scale; $('scaleo').textContent = l.scale.toFixed(2) + 'x';
  ctl.rotation.value = l.rotation; $('rotationo').textContent = Math.round(l.rotation) + '°';
  ctl.opacity.value = l.opacity; $('opacityo').textContent = Math.round(l.opacity * 100) + '%';
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
  // zIndexを詰め直す
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
    // 最初の1枚を背景に
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
  const iw = bgImage.naturalWidth, ih = bgImage.naturalHeight;
  const s = Math.min(1, EXPORT_MAX / Math.max(iw, ih));
  const W = Math.max(1, Math.round(iw * s));
  const H = Math.max(1, Math.round(ih * s));

  const out = document.createElement('canvas');
  out.width = W; out.height = H;
  const g = out.getContext('2d');
  renderTo(g, W, H, true);

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
});

function tstamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/* 初期化 */
rebuildLayerUI();
