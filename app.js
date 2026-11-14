'use strict';

// Placeholder mode (add ?mock to the URL): generate() returns local images after a short delay.
const MOCK = new URLSearchParams(location.search).has('mock');

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
  const res = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ step, image: inputImageDataUrl }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.image) {
    const err = new Error(`generate("${step}") ${data.error || 'failed'} (${res.status})`);
    err.refused = res.status === 422;
    throw err;
  }
  return data.image;
}

/* ---------- Copy ---------- */

const PAINTING_TEXT = 'The painter is at work…';
const UNCHANGED_TEXT = 'The portrait will not change.';
const RETRY_LABEL = 'Try again';
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
const CLOTH_DROP_MS = REDUCED_MOTION ? 300 : 900;
const CLOTH_LIFT_MS = REDUCED_MOTION ? 300 : 1100;
const SLASH_WIPE_MS = 350;
const POLAROID_DELAY_MS = 1000;
const NARRATION_HOLD_MS = 4000;
const NARRATION_FADE_MS = 800;

/* ---------- Elements ---------- */

const $ = (id) => document.getElementById(id);
const el = {
  page: $('page'),
  landing: $('landing'),
  studio: $('studio'),
  sit: $('sit'),
  refusal: $('refusal'),
  file: $('file'),
  frameWrap: $('frame-wrap'),
  portrait: $('portrait'),
  slash: $('slash'),
  cloth: $('cloth'),
  polaroid: $('polaroid'),
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

// Re-encode any image as a JPEG data URL, at most `max` px on the long side,
// so requests stay well under Vercel's body limit.
async function toJpegDataUrl(url, max = 1024, quality = 0.85) {
  const img = await loadImage(url);
  const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}

async function preparePhoto(file) {
  const objectUrl = URL.createObjectURL(file);
  try {
    return await toJpegDataUrl(objectUrl);
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
  // stuck: the level (1–4, or 5 for the slash) whose reveal failed, awaiting "Try again".
  return { photo, jobs: {}, images: {}, level: 0, slashed: false, busy: false, stuck: null };
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

// Paint every later stage in the background, in order. Safe to call again:
// finished jobs are cached, and anything that failed is started afresh.
function paintAhead(s) {
  ensure(s, 4).catch((err) => console.error(err));
  ensure(s, 'slash').catch((err) => console.error(err));
}

async function runJob(s, key) {
  if (key === 0) return preload(await generate('portrait', s.photo));
  if (key === 'slash') {
    await ensure(s, 4).catch(() => {}); // queue behind the levels
    return preload(await generate('slash', s.photo));
  }
  const input = await toJpegDataUrl(await ensure(s, key - 1));
  return preload(await generate(`level-${key}`, input));
}

/* ---------- Downloads ---------- */

const FRAME_SRC = 'placeholders/baroque-frame.png';
// The frame's transparent opening, as fractions of its width/height (.frame-wrap --op-*).
const FRAME = { w: 877, h: 1080, l: 0.219, t: 0.176, r: 0.217, b: 0.179, bleed: 0.01 };
const EXPORT_SCALE = 2;

function drawCover(ctx, img, x, y, w, h) {
  const scale = Math.max(w / img.naturalWidth, h / img.naturalHeight);
  const sw = w / scale;
  const sh = h / scale;
  ctx.drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh, x, y, w, h);
}

function saveBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function canvasToJpeg(canvas) {
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not encode JPEG'))), 'image/jpeg', 0.92)
  );
}

// Before the slash: the current portrait in the frame.
async function downloadFramed(s) {
  const [portrait, frame] = await Promise.all([loadImage(s.images[s.level]), loadImage(FRAME_SRC)]);
  const W = FRAME.w * EXPORT_SCALE;
  const H = FRAME.h * EXPORT_SCALE;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#140d08';
  ctx.fillRect(0, 0, W, H);

  const ox = W * (FRAME.l - FRAME.bleed);
  const oy = H * (FRAME.t - FRAME.bleed);
  const ow = W * (1 - FRAME.l - FRAME.r + 2 * FRAME.bleed);
  const oh = H * (1 - FRAME.t - FRAME.b + 2 * FRAME.bleed);
  ctx.fillStyle = '#120b06';
  ctx.fillRect(ox, oy, ow, oh);
  drawCover(ctx, portrait, ox, oy, ow, oh);

  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.75)';
  ctx.shadowBlur = 26 * EXPORT_SCALE;
  ctx.shadowOffsetY = 22 * EXPORT_SCALE;
  ctx.drawImage(frame, 0, 0, W, H);
  ctx.restore();

  saveBlob(await canvasToJpeg(canvas), `dorian-gray-portrait-${s.level}.jpg`);
}

// After the slash: just the ruined photo, at full resolution.
async function downloadRuined(s) {
  const url = s.images.slash;
  const blob = await (await fetch(url)).blob();
  if (blob.type === 'image/jpeg') {
    saveBlob(blob, 'dorian-gray-ruined.jpg');
    return;
  }
  const img = await loadImage(url);
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.getContext('2d').drawImage(img, 0, 0);
  saveBlob(await canvasToJpeg(canvas), 'dorian-gray-ruined.jpg');
}

async function downloadPortrait() {
  const s = session;
  if (!s) return;
  if (s.slashed) {
    if (s.images.slash) await downloadRuined(s);
  } else if (s.images[s.level]) {
    await downloadFramed(s);
  }
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
  const stuck = showing && s.stuck !== null;
  const canSin = showing && !s.slashed && !stuck;

  el.next.hidden = !(canSin || stuck);
  if (stuck) el.next.textContent = RETRY_LABEL;
  else if (canSin) el.next.textContent = s.level < 4 ? SINS[s.level + 1].label : SLASH.label;
  el.undo.hidden = !(canSin && s.level >= 1);
  el.download.hidden = !showing || stuck;
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

function showLanding(refused = false) {
  el.refusal.hidden = !refused;
  el.page.classList.add('is-landing');
  el.landing.hidden = false;
  el.studio.hidden = true;
}

function showStudio() {
  el.page.classList.remove('is-landing');
  el.landing.hidden = true;
  el.studio.hidden = false;
}

function reset(refused = false) {
  session = null;
  el.file.value = '';
  el.cloth.classList.remove('down');
  setPortrait(null);
  el.slash.classList.remove('cut');
  el.frameWrap.classList.remove('shake');
  el.polaroid.classList.remove('shown');
  el.stranger.removeAttribute('src');
  hideNarration();
  el.narration.textContent = '';
  renderActions();
  showLanding(refused);
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
  el.refusal.hidden = true;
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
    paintAhead(s);
  } catch (err) {
    console.error(err);
    if (s === session) reset(true);
  }
}

async function commitNext() {
  const s = session;
  if (!s || s.busy) return;
  if (s.stuck !== null) return retryStep();
  if (s.slashed) return;
  const target = s.level + 1;

  s.busy = true;
  renderActions();
  hideNarration();
  await dropCloth();
  if (s !== session) return;
  await reveal(s, target);
}

// Retry only the step that failed; the cloth is still down.
async function retryStep() {
  const s = session;
  const target = s.stuck;
  s.stuck = null;
  s.busy = true;
  renderActions();
  hideNarration();
  await sleep(NARRATION_FADE_MS);
  if (s !== session) return;
  await reveal(s, target);
}

// With the cloth down: narrate, wait for the image, then lift to reveal it.
async function reveal(s, target) {
  const isSlash = target > 4;
  const ready = isSlash ? Promise.all([ensure(s, 0), ensure(s, 'slash')]) : ensure(s, target);
  ready.catch(() => {});

  setNarration(isSlash ? SLASH.narration : SINS[target].narration);

  try {
    await Promise.all([sleep(NARRATION_FADE_MS + NARRATION_HOLD_MS), ready]);
  } catch (err) {
    console.error(err);
    if (s !== session) return;
    s.stuck = target;
    s.busy = false;
    setNarration(UNCHANGED_TEXT);
    renderActions();
    return;
  }
  if (s !== session) return;

  if (isSlash) {
    s.slashed = true;
    setPortrait(s.images[0]);
    el.stranger.src = s.images.slash;
  } else {
    s.level = target;
    setPortrait(s.images[target]);
    paintAhead(s); // picks the chain up again if an earlier failure broke it
  }

  await liftCloth();
  if (s !== session) return;
  if (isSlash) {
    await cutPortrait();
    if (s !== session) return;
  }
  s.busy = false;
  renderActions();
}

// The knife stroke: wipe the slash across the canvas, shake the frame,
// then the ruined photo drops in, pinned over the frame.
async function cutPortrait() {
  el.slash.classList.add('cut');
  el.frameWrap.classList.add('shake');
  await sleep(SLASH_WIPE_MS);
  el.frameWrap.classList.remove('shake');
  await sleep(POLAROID_DELAY_MS - SLASH_WIPE_MS);
  el.polaroid.classList.add('shown');
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

el.sit.addEventListener('click', () => el.file.click());
el.file.addEventListener('change', () => sitForPortrait(el.file.files[0]));
el.next.addEventListener('click', commitNext);
el.undo.addEventListener('click', undo);
el.download.addEventListener('click', () => downloadPortrait().catch((err) => console.error(err)));
el.restart.addEventListener('click', reset);
