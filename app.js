'use strict';

// Placeholder mode: generate() returns local images after a short delay.
const MOCK = true;

const MOCK_DELAY_MS = 2000;
const PLACEHOLDERS = {
  portrait: 'placeholders/level-0.jpeg',
  'level-1': 'placeholders/level-1.jpeg',
  'level-2': 'placeholders/level-2.jpeg',
  'level-3': 'placeholders/level-3.jpeg',
  'level-4': 'placeholders/level-4.jpeg',
  slash: 'placeholders/slash.jpeg',
};

/**
 * The single entry point for all image generation.
 * @param {"portrait"|"level-1"|"level-2"|"level-3"|"level-4"|"slash"} step
 * @param {string} inputImageDataUrl  the image this step transforms
 * @returns {Promise<string>} a URL (or data URL) for the generated image
 */
async function generate(step, inputImageDataUrl) {
  if (MOCK) {
    await sleep(MOCK_DELAY_MS);
    return PLACEHOLDERS[step];
  }
  // Real mode: send inputImageDataUrl and this step's prompt to Gemini
  // (through a server endpoint that holds the API key) and return the result.
  throw new Error(`No real generator for "${step}" yet`);
}

/* ---------- Copy ---------- */

const PAINTING_TEXT = 'The painter is at work…';
const PORTRAIT_NARRATION = 'The portrait is finished. It is the most beautiful thing you have ever seen. You would give your soul for it to grow old instead of you.';

const SINS = [
  null,
  {
    label: 'Break their heart',
    narration: 'Someone gave you their whole heart, and tonight it bored you. You tell them they are shallow and stupid, that they mean nothing to you, and that you never want to see them again. They plead. You walk away. By morning they have taken their own life. You glance at the portrait.',
  },
  {
    label: 'Surrender to pleasure',
    narration: 'Years pass in opium dens and gilded parlours. Your friends are ruined one by one, and the rumours follow you everywhere. Your face is untouched. You lock the attic door behind you.',
  },
  {
    label: 'Silence the painter',
    narration: 'The artist who painted you asks to see their masterpiece. You show them. Before they can leave, the knife is in your hand. You blackmail an old friend to make the body disappear, then lift the cloth.',
  },
  {
    label: 'Do one good deed',
    narration: 'You spare an innocent who would have been your next ruin, and for once feel almost virtuous. Surely the portrait has softened. You climb the stairs.',
  },
];

const SLASH = {
  label: 'Slash the portrait',
  narration: 'You take up the knife that killed the painter. One stroke, and you will be free. The household hears a terrible cry. They find a splendid portrait of you on the wall, young and beautiful as the day it was painted, and on the floor a withered, loathsome stranger. They know you only by your jewellery.',
};

/* ---------- Timing ---------- */

const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const CLOTH_DROP_MS = REDUCED_MOTION ? 300 : 1400;
const CLOTH_LIFT_MS = REDUCED_MOTION ? 300 : 1600;
const NARRATION_HOLD_MS = 4000;
const NARRATION_FADE_MS = 800;

/* ---------- Elements ---------- */

const $ = (id) => document.getElementById(id);
const el = {
  page: $('page'),
  landing: $('landing'),
  studio: $('studio'),
  sit: $('sit'),
  file: $('file'),
  stage: $('stage'),
  portrait: $('portrait'),
  slash: $('slash'),
  cloth: $('cloth'),
  stranger: $('stranger'),
  narration: $('narration'),
  next: $('next'),
  undo: $('undo'),
  download: $('download'),
  restart: $('restart'),
};

/* ---------- Helpers ---------- */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Could not load ${url.slice(0, 60)}`));
    img.src = url;
  });
}

async function preload(url) {
  await loadImage(url);
  return url;
}

async function toDataUrl(url) {
  if (url.startsWith('data:')) return url;
  const blob = await (await fetch(url)).blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// Downscale the upload so it is a sensible size to send for generation.
async function preparePhoto(file) {
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await loadImage(objectUrl);
    const MAX = 1600;
    const scale = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.9);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/* ---------- Generation jobs ----------
 * Keys: 0..4 for portrait levels, "slash" for the stranger.
 * Each job runs once per session and is cached; a failed job is forgotten
 * so it can be retried. Level n takes level n-1 as input; slash takes the photo.
 */

let session = null;

function newSession(photo) {
  return { photo, jobs: {}, images: {}, level: 0, slashed: false, busy: false };
}

function ensure(s, key) {
  if (!s.jobs[key]) {
    s.jobs[key] = runJob(s, key)
      .then((url) => (s.images[key] = url))
      .catch((err) => {
        delete s.jobs[key];
        throw err;
      });
  }
  return s.jobs[key];
}

async function runJob(s, key) {
  if (key === 0) return preload(await generate('portrait', s.photo));
  if (key === 'slash') {
    await ensure(s, 4).catch(() => {}); // queue behind the levels
    return preload(await generate('slash', s.photo));
  }
  const input = await toDataUrl(await ensure(s, key - 1));
  return preload(await generate(`level-${key}`, input));
}

/* ---------- Slash overlay geometry (shared by SVG and download canvas) ---------- */

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Coordinates are in a 300 × 400 box matching the 3:4 canvas.
const SLASH_LAYERS = (function buildSlash() {
  const rand = mulberry32(1890);
  const A = { x: 58, y: 34 };
  const C = { x: 190, y: 160 };
  const B = { x: 250, y: 372 };
  const N = 54;
  const pts = [];

  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const u = 1 - t;
    const x = u * u * A.x + 2 * u * t * C.x + t * t * B.x;
    const y = u * u * A.y + 2 * u * t * C.y + t * t * B.y;
    const dx = 2 * u * (C.x - A.x) + 2 * t * (B.x - C.x);
    const dy = 2 * u * (C.y - A.y) + 2 * t * (B.y - C.y);
    const len = Math.hypot(dx, dy);
    const nx = -dy / len;
    const ny = dx / len;
    const base = 15 * Math.pow(Math.sin(Math.PI * t), 0.6);
    const tip = i === 0 || i === N;
    // Ragged, independently torn sides with occasional sharp snags.
    const jag = () => (rand() - 0.5) * 3.2 + (rand() < 0.18 ? (rand() - 0.3) * 6 : 0);
    const wl = tip ? 0 : Math.max(0.4, base * (0.8 + rand() * 0.35) + jag());
    const wr = tip ? 0 : Math.max(0.4, base * (0.8 + rand() * 0.35) + jag());
    const cl = tip ? 0 : Math.min(wl * 0.7, 1.5 + rand() * 4.5);
    const cr = tip ? 0 : Math.min(wr * 0.7, 1.5 + rand() * 4.5);
    pts.push({ x, y, nx, ny, wl, wr, cl, cr });
  }

  const f = (n) => n.toFixed(1);
  const side = (sign, off) =>
    pts.map((p) => {
      const w = (sign > 0 ? p.wl : p.wr) + off(p);
      return [p.x + p.nx * sign * w, p.y + p.ny * sign * w];
    });
  const poly = (a, b) => {
    const all = a.concat(b.slice().reverse());
    return 'M' + all.map(([x, y]) => `${f(x)} ${f(y)}`).join(' L') + ' Z';
  };
  const line = (a) => 'M' + a.map(([x, y]) => `${f(x)} ${f(y)}`).join(' L');

  const L0 = side(1, () => 0);
  const R0 = side(-1, () => 0);
  const Lcurl = side(1, (p) => -p.cl);
  const Rcurl = side(-1, (p) => -p.cr);

  let threads = '';
  for (let i = 6; i < N - 6; i += 5 + Math.floor(rand() * 5)) {
    const j = i + Math.floor(rand() * 3) - 1;
    threads += `M${f(Lcurl[i][0])} ${f(Lcurl[i][1])} Q${f(pts[i].x + (rand() - 0.5) * 6)} ${f(pts[i].y + (rand() - 0.5) * 6)} ${f(Rcurl[j][0])} ${f(Rcurl[j][1])} `;
  }

  const linen = (dark) => ({
    x1: A.x, y1: A.y, x2: B.x, y2: B.y,
    stops: dark
      ? [[0, '#8a7655'], [0.5, '#5f4f36'], [1, '#7d6a4c']]
      : [[0, '#cbb991'], [0.45, '#a38f68'], [1, '#bba67e']],
  });

  return [
    { d: poly(side(1, () => 5), side(-1, () => 5)), fill: 'rgba(0,0,0,0.6)', blur: 2.4 },
    { d: poly(side(1, () => 1.4), side(-1, () => 1.4)), fill: 'rgba(255,226,170,0.22)' },
    { d: poly(L0, R0), fill: { x1: A.x, y1: A.y, x2: B.x, y2: B.y, stops: [[0, '#1d110a'], [0.5, '#050201'], [1, '#170b05']] } },
    { d: poly(L0, Lcurl), fill: linen(false) },
    { d: poly(R0, Rcurl), fill: linen(true) },
    { d: line(Lcurl) + ' ' + line(Rcurl), stroke: 'rgba(30,14,4,0.6)', width: 0.7 },
    { d: threads, stroke: 'rgba(214,195,152,0.7)', width: 0.45 },
  ];
})();

function renderSlashSvg() {
  const defs = [];
  const paths = SLASH_LAYERS.map((layer, i) => {
    let fill = 'none';
    if (typeof layer.fill === 'string') fill = layer.fill;
    else if (layer.fill) {
      const g = layer.fill;
      defs.push(
        `<linearGradient id="slash-g${i}" gradientUnits="userSpaceOnUse" x1="${g.x1}" y1="${g.y1}" x2="${g.x2}" y2="${g.y2}">` +
          g.stops.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join('') +
          '</linearGradient>'
      );
      fill = `url(#slash-g${i})`;
    }
    if (layer.blur) {
      defs.push(`<filter id="slash-f${i}" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="${layer.blur}"/></filter>`);
    }
    const stroke = layer.stroke ? ` stroke="${layer.stroke}" stroke-width="${layer.width}" stroke-linecap="round"` : '';
    const filter = layer.blur ? ` filter="url(#slash-f${i})"` : '';
    return `<path d="${layer.d}" fill="${fill}"${stroke}${filter}/>`;
  });
  el.slash.innerHTML = `<defs>${defs.join('')}</defs>${paths.join('')}`;
}

function drawSlash(ctx, x, y, w, h) {
  const sx = w / 300;
  const sy = h / 400;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(sx, sy);
  for (const layer of SLASH_LAYERS) {
    const path = new Path2D(layer.d);
    ctx.filter = layer.blur ? `blur(${layer.blur * sx}px)` : 'none';
    if (layer.fill) {
      if (typeof layer.fill === 'string') ctx.fillStyle = layer.fill;
      else {
        const g = layer.fill;
        const grad = ctx.createLinearGradient(g.x1, g.y1, g.x2, g.y2);
        g.stops.forEach(([o, c]) => grad.addColorStop(o, c));
        ctx.fillStyle = grad;
      }
      ctx.fill(path);
    }
    if (layer.stroke) {
      ctx.strokeStyle = layer.stroke;
      ctx.lineWidth = layer.width;
      ctx.lineCap = 'round';
      ctx.stroke(path);
    }
  }
  ctx.restore();
}

/* ---------- Download canvas (frame mirrors styles.css) ---------- */

const FRAME_CSS_PX = 30; // --fw in styles.css
const FRAME_RINGS = [ // [from, to] in CSS px inward from the outer edge
  [0, 2, 'rgba(255,245,200,0.7)'],
  [2, 5, '#6b440e'],
  [5, 9, '#e8c766'],
  [9, 11, '#7a4f12'],
];
const SIGHT_RINGS = [ // [from, to] in CSS px outward from the picture edge
  [0, 2, '#3a2405'],
  [2, 5, '#d9b45a'],
  [5, 7, '#5a3a0a'],
  [7, 8, 'rgba(255,240,190,0.4)'],
];
const ROSETTE = [[0, 2, '#fff4c0'], [3, 5, '#e9c560'], [6, 7, '#7a4f12'], [8, 10, '#f1d47a'], [11, 12, '#5c3a0a']];

function drawCover(ctx, img, x, y, w, h) {
  const scale = Math.max(w / img.naturalWidth, h / img.naturalHeight);
  const sw = w / scale;
  const sh = h / scale;
  ctx.drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh, x, y, w, h);
}

function ringRect(ctx, x, y, w, h, from, to, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = to - from;
  const m = from + (to - from) / 2;
  ctx.strokeRect(x + m, y + m, w - 2 * m, h - 2 * m);
}

function drawFrame(ctx, W, H, k) {
  const sheen = ctx.createLinearGradient(0, 0, W, H);
  [[0, '#f3d77c'], [0.22, '#a97726'], [0.45, '#f6e39a'], [0.68, '#8a5c18'], [0.88, '#e8c466'], [1, '#9b6b20']]
    .forEach(([o, c]) => sheen.addColorStop(o, c));
  ctx.fillStyle = sheen;
  ctx.fillRect(0, 0, W, H);

  for (const [a, b, c] of FRAME_RINGS) ringRect(ctx, 0, 0, W, H, a * k, b * k, c);
  ringRect(ctx, 0, 0, W, H, 0, k * 0.6, '#2b1a04');

  // Rope moulding between 13 and 18 CSS px.
  const r0 = 13 * k;
  const r1 = 18 * k;
  ctx.save();
  ctx.beginPath();
  ctx.rect(r0, r0, W - 2 * r0, H - 2 * r0);
  ctx.rect(r1, r1, W - 2 * r1, H - 2 * r1);
  ctx.clip('evenodd');
  const period = 6 * k * Math.SQRT2;
  const band = [['#fbe7a1', 0], ['#c99a3c', 2], ['#6d470f', 4]];
  for (let s = -H; s < W + H; s += period) {
    for (const [color, off] of band) {
      const o = off * k * Math.SQRT2;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(s + o, 0);
      ctx.lineTo(s + o + period / 3, 0);
      ctx.lineTo(s + o + period / 3 + H, H);
      ctx.lineTo(s + o + H, H);
      ctx.closePath();
      ctx.fill();
    }
  }
  ctx.restore();

  // Corner rosettes centred 15.5 CSS px in from each corner.
  const c = 15.5 * k;
  const R = 12.5 * k;
  for (const [cx, cy] of [[c, c], [W - c, c], [c, H - c], [W - c, H - c]]) {
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
    for (const [a, b, col] of ROSETTE) {
      g.addColorStop((a * k) / R, col);
      g.addColorStop((b * k) / R, col);
    }
    g.addColorStop((12 * k) / R, '#5c3a0a');
    g.addColorStop(1, 'rgba(92,58,10,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawInnerShadow(ctx, x, y, w, h, size) {
  const edges = [
    [x, y, x, y + size, [x, y, w, size]],
    [x, y + h, x, y + h - size, [x, y + h - size, w, size]],
    [x, y, x + size, y, [x, y, size, h]],
    [x + w, y, x + w - size, y, [x + w - size, y, size, h]],
  ];
  for (const [x1, y1, x2, y2, rect] of edges) {
    const g = ctx.createLinearGradient(x1, y1, x2, y2);
    g.addColorStop(0, 'rgba(0,0,0,0.5)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(...rect);
  }
}

async function downloadPortrait() {
  const s = session;
  if (!s) return;
  const url = s.slashed ? s.images[0] : s.images[s.level];
  if (!url) return;
  const img = await loadImage(url);

  const PW = 900;
  const PH = 1200;
  const k = 3.2;
  const B = FRAME_CSS_PX * k;
  const W = PW + 2 * B;
  const H = PH + 2 * B;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  drawFrame(ctx, W, H, k);

  ctx.save();
  ctx.beginPath();
  ctx.rect(B, B, PW, PH);
  ctx.clip();
  ctx.fillStyle = '#120b06';
  ctx.fillRect(B, B, PW, PH);
  drawCover(ctx, img, B, B, PW, PH);
  drawInnerShadow(ctx, B, B, PW, PH, 28 * k);
  if (s.slashed) drawSlash(ctx, B, B, PW, PH);
  ctx.restore();

  for (const [a, b, c] of SIGHT_RINGS) {
    ringRect(ctx, B - b * k, B - b * k, PW + 2 * b * k, PH + 2 * b * k, 0, (b - a) * k, c);
  }

  canvas.toBlob(
    (blob) => {
      if (!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = s.slashed ? 'dorian-gray-slashed.jpg' : `dorian-gray-portrait-${s.level}.jpg`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    },
    'image/jpeg',
    0.92
  );
}

/* ---------- View ---------- */

let narrationToken = 0;

async function setNarration(text) {
  const token = ++narrationToken;
  if (el.narration.classList.contains('shown')) {
    el.narration.classList.remove('shown');
    await sleep(NARRATION_FADE_MS);
    if (token !== narrationToken) return;
  }
  el.narration.textContent = text;
  if (text) {
    void el.narration.offsetWidth;
    el.narration.classList.add('shown');
  }
}

function hideNarration() {
  narrationToken++;
  el.narration.classList.remove('shown');
}

function narrationFor(level) {
  return level === 0 ? PORTRAIT_NARRATION : SINS[level].narration;
}

function setPortrait(url) {
  if (url) {
    el.portrait.src = url;
    el.portrait.classList.add('shown');
  } else {
    el.portrait.classList.remove('shown');
    el.portrait.removeAttribute('src');
  }
}

async function crossfadePortrait(url) {
  el.portrait.classList.remove('shown');
  await sleep(300);
  setPortrait(url);
}

function renderActions() {
  const s = session;
  const showing = !!s && !s.busy && s.images[0] !== undefined;
  const canSin = showing && !s.slashed;

  el.next.hidden = !canSin;
  if (canSin) el.next.textContent = s.level < 4 ? SINS[s.level + 1].label : SLASH.label;
  el.undo.hidden = !(canSin && s.level >= 1);
  el.download.hidden = !showing;
  el.restart.hidden = !(showing && s.slashed);
}

async function dropCloth() {
  el.cloth.classList.add('down');
  await sleep(CLOTH_DROP_MS);
}

async function liftCloth() {
  el.cloth.classList.remove('down');
  await sleep(CLOTH_LIFT_MS);
}

/* ---------- Flow ---------- */

function showLanding() {
  el.page.classList.add('is-landing');
  el.landing.hidden = false;
  el.studio.hidden = true;
}

function showStudio() {
  el.page.classList.remove('is-landing');
  el.landing.hidden = true;
  el.studio.hidden = false;
}

function reset() {
  session = null;
  el.file.value = '';
  el.cloth.classList.remove('down');
  setPortrait(null);
  el.slash.setAttribute('hidden', '');
  el.stage.classList.remove('is-slashed');
  el.stranger.classList.remove('shown');
  el.stranger.hidden = true;
  el.stranger.removeAttribute('src');
  hideNarration();
  el.narration.textContent = '';
  renderActions();
  showLanding();
  window.scrollTo({ top: 0 });
}

async function sitForPortrait(file) {
  if (!file || !file.type.startsWith('image/')) return;
  let photo;
  try {
    photo = await preparePhoto(file);
  } catch (err) {
    console.error(err);
    el.file.value = '';
    return;
  }

  const s = (session = newSession(photo));
  showStudio();
  setPortrait(null);
  renderActions();
  setNarration(PAINTING_TEXT);

  try {
    const url = await ensure(s, 0);
    if (s !== session) return;
    setPortrait(url);
    setNarration(PORTRAIT_NARRATION);
    renderActions();
    // Paint every later stage in the background, in order.
    ensure(s, 'slash').catch((err) => console.error(err));
  } catch (err) {
    console.error(err);
    if (s === session) reset();
  }
}

async function commitNext() {
  const s = session;
  if (!s || s.busy || s.slashed) return;
  const target = s.level + 1;
  const isSlash = target > 4;
  const ready = isSlash ? Promise.all([ensure(s, 0), ensure(s, 'slash')]) : ensure(s, target);
  ready.catch(() => {});

  s.busy = true;
  renderActions();
  hideNarration();
  await dropCloth();
  if (s !== session) return;

  setNarration(isSlash ? SLASH.narration : SINS[target].narration);

  try {
    await Promise.all([sleep(NARRATION_FADE_MS + NARRATION_HOLD_MS), ready]);
  } catch (err) {
    console.error(err);
    if (s !== session) return;
    setNarration(narrationFor(s.level));
    await liftCloth();
    s.busy = false;
    renderActions();
    return;
  }
  if (s !== session) return;

  if (isSlash) {
    s.slashed = true;
    setPortrait(s.images[0]);
    el.slash.removeAttribute('hidden'); // SVG elements have no .hidden property
    el.stage.classList.add('is-slashed');
    el.stranger.src = s.images.slash;
    el.stranger.hidden = false;
  } else {
    s.level = target;
    setPortrait(s.images[target]);
  }

  await liftCloth();
  if (s !== session) return;
  if (isSlash) el.stranger.classList.add('shown');
  s.busy = false;
  renderActions();
}

async function undo() {
  const s = session;
  if (!s || s.busy || s.slashed || s.level < 1) return;
  s.level -= 1;
  setNarration(narrationFor(s.level));
  await crossfadePortrait(s.images[s.level]);
  renderActions();
}

/* ---------- Wiring ---------- */

renderSlashSvg();

el.sit.addEventListener('click', () => el.file.click());
el.file.addEventListener('change', () => sitForPortrait(el.file.files[0]));
el.next.addEventListener('click', commitNext);
el.undo.addEventListener('click', undo);
el.download.addEventListener('click', () => downloadPortrait().catch((err) => console.error(err)));
el.restart.addEventListener('click', reset);
