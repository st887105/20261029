(() => {
  'use strict';

  const MB = 1024 * 1024;
  const RATIOS = { free: null, '1:1': 1, '4:3': 4 / 3, '3:4': 3 / 4, '16:9': 16 / 9 };
  const $ = (s) => document.querySelector(s);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  const items = [];
  let uid = 0;
  let ed = null;
  let drag = null;
  let busy = false;

  function loadSettings() {
    const d = { target: 1.5, format: 'image/jpeg' };
    try { return Object.assign({}, d, JSON.parse(localStorage.getItem('imgtool-settings') || '{}')); }
    catch (e) { return d; }
  }
  const settings = loadSettings();
  function saveSettings() {
    try { localStorage.setItem('imgtool-settings', JSON.stringify(settings)); } catch (e) {}
  }

  function toast(msg) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    $('#toasts').appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => {
      t.classList.remove('show');
      setTimeout(() => t.remove(), 300);
    }, 2600);
  }

  const fmtSize = (b) => (b >= MB ? (b / MB).toFixed(2) + ' MB' : Math.round(b / 1024) + ' KB');

  function setMenu(open) { $('#drawer').hidden = !open; }

  function syncSheet() {
    $('#targetRange').value = settings.target;
    $('#targetVal').textContent = settings.target.toFixed(1) + ' MB';
    $('#fmtSelect').value = settings.format;
  }
  function openSheet(open) {
    $('#sheet').hidden = !open;
    if (open) syncSheet();
  }

  function download(blob, name) {
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function outName(it) {
    if (it.result === it.file) return it.file.name;
    const base = it.file.name.replace(/\.[^.]+$/, '');
    const ext = { 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/png': 'png' }[it.result.type] || 'jpg';
    return base + '_small.' + ext;
  }

  const isHeic = (f) => /^image\/heic|^image\/heif/.test(f.type) || /\.(heic|heif)$/i.test(f.name);
  const isImage = (f) => f.type.startsWith('image/') || isHeic(f);

  async function prepareFile(file) {
    if (!isHeic(file)) return file;
    if (typeof heic2any === 'undefined') throw new Error('HEIC converter not loaded');
    const out = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.92 });
    const blob = Array.isArray(out) ? out[0] : out;
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
  }

  async function addFiles(list) {
    const files = [...list].filter(isImage);
    if (!files.length) return toast('沒有找到圖片檔');
    const heicCount = files.filter(isHeic).length;
    if (heicCount) toast('正在轉換 ' + heicCount + ' 張 HEIC 圖片…');
    let added = 0;
    for (const raw of files) {
      try {
        const file = await prepareFile(raw);
        items.push({
          id: ++uid, file, url: URL.createObjectURL(file),
          rot: 0, crop: null, bitmap: null, result: null, status: '待處理',
        });
        added++;
      } catch (err) {
        console.error(err);
        toast('無法讀取：' + raw.name);
      }
      renderGrid();
    }
    if (added) toast('已加入 ' + added + ' 張圖片');
  }

  function removeItem(id) {
    const i = items.findIndex((x) => x.id === id);
    if (i < 0) return;
    const it = items.splice(i, 1)[0];
    if (ed && ed.it === it) closeEditor();
    URL.revokeObjectURL(it.url);
    if (it.bitmap && it.bitmap.close) it.bitmap.close();
    renderGrid();
  }

  function clearAll() {
    if (!items.length || !confirm('確定清除全部圖片？')) return;
    if (ed) closeEditor();
    items.forEach((it) => { URL.revokeObjectURL(it.url); if (it.bitmap && it.bitmap.close) it.bitmap.close(); });
    items.length = 0;
    setMenu(false);
    renderGrid();
  }

  function makeBtn(label, onClick, disabled, extra) {
    const b = document.createElement('button');
    b.className = 'btn sm ' + (extra || '');
    b.textContent = label;
    b.disabled = !!disabled;
    b.addEventListener('click', onClick);
    return b;
  }

  function renderGrid() {
    const g = $('#grid');
    g.innerHTML = '';
    $('#countLabel').textContent = items.length + ' 張';
    $('#dropzone').hidden = items.length > 0;

    for (const it of items) {
      const card = document.createElement('div');
      card.className = 'card';

      const thumb = document.createElement('div');
      thumb.className = 'thumb';
      const img = document.createElement('img');
      img.src = it.url;
      img.alt = '';
      thumb.appendChild(img);

      const meta = document.createElement('div');
      meta.className = 'meta';
      const name = document.createElement('b');
      name.textContent = it.file.name;
      const info = document.createElement('small');
      info.textContent = fmtSize(it.file.size) + (it.result ? ' → ' + fmtSize(it.result.size) : '') + ' · ' + it.status;
      meta.append(name, info);

      const acts = document.createElement('div');
      acts.className = 'card-actions';
      acts.append(
        makeBtn('編輯', () => openEditor(it.id)),
        makeBtn('壓縮', () => runOne(it)),
        makeBtn('下載', () => download(it.result, outName(it)), !it.result),
        makeBtn('✕', () => removeItem(it.id), false, 'danger')
      );

      card.append(thumb, meta, acts);
      g.appendChild(card);
    }
  }

  async function loadBitmap(file) {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch (e) { return await createImageBitmap(file); }
  }

  async function getBitmap(it) {
    if (!it.bitmap) it.bitmap = await loadBitmap(it.file);
    return it.bitmap;
  }

  function drawRotated(src, rot) {
    const swap = rot % 180 !== 0;
    const c = document.createElement('canvas');
    c.width = swap ? src.height : src.width;
    c.height = swap ? src.width : src.height;
    const x = c.getContext('2d');
    x.translate(c.width / 2, c.height / 2);
    x.rotate((rot * Math.PI) / 180);
    x.drawImage(src, -src.width / 2, -src.height / 2);
    return c;
  }

  function cropCanvas(c, crop) {
    if (!crop) return c;
    const sx = Math.round(crop.x * c.width);
    const sy = Math.round(crop.y * c.height);
    const sw = Math.max(1, Math.round(crop.w * c.width));
    const sh = Math.max(1, Math.round(crop.h * c.height));
    const o = document.createElement('canvas');
    o.width = sw;
    o.height = sh;
    o.getContext('2d').drawImage(c, sx, sy, sw, sh, 0, 0, sw, sh);
    return o;
  }

  function scaleCanvas(c, s) {
    const o = document.createElement('canvas');
    o.width = Math.max(1, Math.round(c.width * s));
    o.height = Math.max(1, Math.round(c.height * s));
    const x = o.getContext('2d');
    x.fillStyle = '#fff';
    x.fillRect(0, 0, o.width, o.height);
    x.imageSmoothingQuality = 'high';
    x.drawImage(c, 0, 0, o.width, o.height);
    return o;
  }

  const encode = (c, mime, q) => new Promise((resolve) => c.toBlob(resolve, mime, q));

  async function compressTo(canvas, target, mime) {
    let src = canvas;
    for (let pass = 0; pass < 6; pass++) {
      const top = await encode(src, mime, 0.95);
      if (top.size <= target) return top;

      let lo = 0.2;
      let hi = 0.95;
      const bottom = await encode(src, mime, lo);
      if (bottom.size <= target) {
        let found = bottom;
        for (let i = 0; i < 7; i++) {
          const m = (lo + hi) / 2;
          const b = await encode(src, mime, m);
          if (b.size <= target) { found = b; lo = m; } else { hi = m; }
        }
        return found;
      }
      src = scaleCanvas(src, 0.8);
    }
    return encode(src, mime, 0.2);
  }

  async function processItem(it) {
    const target = settings.target * MB;
    const edited = it.rot !== 0 || !!it.crop;
    if (!edited && it.file.size <= target) {
      it.result = it.file;
      it.status = '已小於目標，保留原檔';
      return;
    }
    const bmp = await getBitmap(it);
    const canvas = cropCanvas(drawRotated(bmp, it.rot), it.crop);
    it.result = await compressTo(canvas, target, settings.format);
    it.status = '完成';
  }

  async function runOne(it) {
    it.status = '處理中…';
    renderGrid();
    try {
      await processItem(it);
      toast(it.file.name + ' 完成');
    } catch (err) {
      console.error(err);
      it.status = '失敗';
      toast('處理失敗：' + it.file.name);
    }
    renderGrid();
  }

  async function batchProcess() {
    if (!items.length) return toast('請先加入圖片');
    if (busy) return;
    busy = true;
    setMenu(false);
    openSheet(false);
    for (const it of items) {
      it.status = '處理中…';
      renderGrid();
      try { await processItem(it); }
      catch (err) { console.error(err); it.status = '失敗'; }
      renderGrid();
    }
    busy = false;
    toast('批次處理完成');
  }

  async function downloadZip() {
    const done = items.filter((i) => i.result);
    setMenu(false);
    if (!done.length) return toast('請先執行壓縮');
    if (typeof JSZip === 'undefined') return toast('ZIP 元件載入失敗，請檢查網路');
    const zip = new JSZip();
    const used = new Set();
    for (const it of done) {
      let n = outName(it);
      while (used.has(n)) n = '_' + n;
      used.add(n);
      zip.file(n, it.result);
    }
    download(await zip.generateAsync({ type: 'blob' }), 'compressed_images.zip');
  }

  function getCrop() {
    return ed.crop || { x: 0, y: 0, w: 1, h: 1 };
  }

  function drawCropBox() {
    const c = getCrop();
    const box = $('#cropBox');
    box.style.left = c.x * 100 + '%';
    box.style.top = c.y * 100 + '%';
    box.style.width = c.w * 100 + '%';
    box.style.height = c.h * 100 + '%';
  }

  function drawEditor() {
    const full = drawRotated(ed.bmp, ed.rot);
    const s = Math.min(1, 1600 / Math.max(full.width, full.height));
    ed.preview = scaleCanvas(full, s);
    const cv = $('#prevCanvas');
    cv.width = ed.preview.width;
    cv.height = ed.preview.height;
    cv.getContext('2d').drawImage(ed.preview, 0, 0);
    drawCropBox();
  }

  async function openEditor(id) {
    const it = items.find((x) => x.id === id);
    if (!it) return;
    ed = { it, rot: it.rot, crop: it.crop ? Object.assign({}, it.crop) : null, bmp: null, preview: null };
    $('#editorName').textContent = it.file.name;
    $('#ratio').value = 'free';
    $('#editor').hidden = false;
    try {
      ed.bmp = await getBitmap(it);
    } catch (err) {
      console.error(err);
      toast('無法開啟這張圖片');
      closeEditor();
      return;
    }
    drawEditor();
  }

  function closeEditor() {
    ed = null;
    drag = null;
    $('#editor').hidden = true;
    renderGrid();
  }

  function rotate(dir) {
    ed.rot = (ed.rot + dir + 360) % 360;
    ed.crop = null;
    drawEditor();
    presetRatio();
  }

  function presetRatio() {
    if (!ed) return;
    const a = RATIOS[$('#ratio').value];
    if (!a) return;
    const c = getCrop();
    const pW = ed.preview.width;
    const pH = ed.preview.height;
    let w = 1;
    let h = (w * pW) / (a * pH);
    if (h > 1) { h = 1; w = (h * a * pH) / pW; }
    const cx = c.x + c.w / 2;
    const cy = c.y + c.h / 2;
    ed.crop = { w: w, h: h, x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - h / 2, 0, 1 - h) };
    drawCropBox();
  }

  function saveEdit() {
    if (!ed) return;
    const c = ed.crop;
    const full = !c || (c.w > 0.995 && c.h > 0.995);
    const it = ed.it;
    it.rot = ed.rot;
    it.crop = full ? null : Object.assign({}, c);
    it.result = null;
    it.status = '已編輯，待壓縮';
    toast('已套用編輯');
    closeEditor();
  }

  const box = $('#cropBox');
  box.addEventListener('pointerdown', (e) => {
    if (!ed) return;
    e.preventDefault();
    drag = { mode: e.target.dataset.h || 'move', sx: e.clientX, sy: e.clientY, start: Object.assign({}, getCrop()) };
    box.setPointerCapture(e.pointerId);
  });
  box.addEventListener('pointermove', (e) => {
    if (!drag || !ed) return;
    const r = $('#prevCanvas').getBoundingClientRect();
    const dx = (e.clientX - drag.sx) / r.width;
    const dy = (e.clientY - drag.sy) / r.height;
    const s = drag.start;
    let x = s.x, y = s.y, w = s.w, h = s.h;
    if (drag.mode === 'move') {
      x = clamp(s.x + dx, 0, 1 - s.w);
      y = clamp(s.y + dy, 0, 1 - s.h);
    } else {
      const MIN = 0.05;
      if (drag.mode.indexOf('e') >= 0) w = clamp(s.w + dx, MIN, 1 - s.x);
      if (drag.mode.indexOf('w') >= 0) { w = clamp(s.w - dx, MIN, s.x + s.w); x = s.x + s.w - w; }
      if (drag.mode.indexOf('s') >= 0) h = clamp(s.h + dy, MIN, 1 - s.y);
      if (drag.mode.indexOf('n') >= 0) { h = clamp(s.h - dy, MIN, s.y + s.h); y = s.y + s.h - h; }
    }
    ed.crop = { x: x, y: y, w: w, h: h };
    drawCropBox();
  });
  const endDrag = () => { drag = null; };
  box.addEventListener('pointerup', endDrag);
  box.addEventListener('pointercancel', endDrag);

  $('#menuBtn').addEventListener('click', () => setMenu(true));
  $('#fileInput').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
  $('#folderInput').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
  $('#ratio').addEventListener('change', presetRatio);

  $('#targetRange').addEventListener('input', (e) => {
    settings.target = Number(e.target.value);
    $('#targetVal').textContent = settings.target.toFixed(1) + ' MB';
    saveSettings();
  });
  $('#fmtSelect').addEventListener('change', (e) => {
    settings.format = e.target.value;
    saveSettings();
  });

  const dz = $('#dropzone');
  dz.addEventListener('click', () => $('#fileInput').click());
  dz.addEventListener('dragenter', (e) => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragover', (e) => e.preventDefault());
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    dz.classList.remove('over');
    addFiles(e.dataTransfer.files);
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const map = {
      pickFiles: () => { setMenu(false); $('#fileInput').click(); },
      pickFolder: () => { setMenu(false); $('#folderInput').click(); },
      openSettings: () => { setMenu(false); openSheet(true); },
      closeSheet: () => openSheet(false),
      closeMenu: () => setMenu(false),
      clearAll: () => clearAll(),
      batch: () => batchProcess(),
      zip: () => downloadZip(),
      closeEditor: () => closeEditor(),
      saveEdit: () => saveEdit(),
      rotate: () => rotate(Number(el.dataset.dir)),
      resetCrop: () => { if (ed) { ed.crop = null; $('#ratio').value = 'free'; drawCropBox(); } },
    };
    if (map[el.dataset.action]) map[el.dataset.action]();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (ed) closeEditor();
    else if (!$('#sheet').hidden) openSheet(false);
    else setMenu(false);
  });

  renderGrid();
  syncSheet();
})();
