// Verificación de ForumPHs Speaks en un navegador real (Chromium vía Playwright).
//
// No toca producción: las llamadas a las Edge Functions (`fphs-session`, `fphs-chat`) se
// interceptan y se responden con datos simulados, así que el flujo completo —portada,
// selector, chat, acceso de propietario con código— se recorre sin escribir en la base.
//
// Mide dos cosas:
//   1. MAQUETACIÓN: el borde derecho de CADA elemento visible, en anchos de teléfono, con el
//      texto ampliado al 130 % y al 150 % y en escritorio. `overflow-x: hidden` oculta el
//      desborde en vez de impedirlo, así que no basta con mirar `scrollWidth`.
//   2. FUNCIONAMIENTO: que cada paso del flujo pinte lo que tiene que pintar, que lo que llega
//      del servidor o del visitante entre escapado, y que no haya errores de JavaScript.
//
// CÓMO SE CORRE:  node scripts/verify-ui.mjs
// Requiere Playwright. Si no está instalado en el proyecto, apuntar al global:
//                 PLAYWRIGHT_MODULE="$(npm root -g)/playwright/index.mjs" node scripts/verify-ui.mjs
// Con SHOTS=<carpeta> guarda capturas de cada paso.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png', '.js': 'text/javascript' };
const SHOTS = process.env.SHOTS || '';

let pw;
try { pw = await import(process.env.PLAYWRIGHT_MODULE || 'playwright'); }
catch { console.error('Playwright no está disponible. Ver la cabecera de este archivo.'); process.exit(2); }
const chromium = pw.chromium ?? pw.default?.chromium;

const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = normalize(join(ROOT, path === '/' ? 'index.html' : path));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  try { res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(await readFile(file)); }
  catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, r));
const url = `http://localhost:${server.address().port}/`;

// Nombre con HTML: si llega vivo a la página, el escape falló.
const HOSTILE = 'Ana <img src=x onerror="window.__xss=1">';
async function mockSupabase(page) {
  await page.route('**/functions/v1/fphs-session', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    const replies = {
      init: { session_id: 's1', questions_used: 1, is_unlimited: false, is_golden_pass: false },
      register: { ok: true, is_golden_pass: false },
      verify_owner: { found: true, name: HOSTILE, building: 'PH Prueba', unit: '4B', _dev_otp: '123456' },
      confirm_otp: { confirmed: true, name: HOSTILE, building: 'PH Prueba', unit: '4B', owner_context: { name: HOSTILE, building: 'PH Prueba', unit: '4B' } },
    };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(replies[body.action] ?? {}) });
  });
  await page.route('**/functions/v1/fphs-chat', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ reply: '**Respuesta** de prueba <img src=x onerror="window.__xss=1">.\n*ForumPHs aplica la Ley vigente de Régimen de Propiedad Horizontal desde el primer día.*', questions_used: 2, is_unlimited: false, is_golden_pass: false, needs_email: false }),
  }));
}

const IGNORE = '.splash-glow,.drawer,.drawer-overlay,.overlay,.auth-mini-overlay,.mob-switcher,.mob-chips';
async function overflow(page) {
  return page.evaluate((ignore) => {
    const cw = document.documentElement.clientWidth;
    const bad = [...document.querySelectorAll('body *')].filter((e) => {
      if (e.closest(ignore)) return false;
      const r = e.getBoundingClientRect();
      const st = getComputedStyle(e);
      return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && r.right > cw + 1;
    });
    return bad.filter((e) => !bad.includes(e.parentElement)).slice(0, 5).map((e) => `${e.id || e.className || e.tagName}→${Math.round(e.getBoundingClientRect().right)}px`);
  }, IGNORE);
}
async function scaleText(page, z) {
  if (z === 1) return;
  // Se amplía una sola vez cada elemento (los que aparecen en pasos posteriores se amplían al
  // aparecer): aplicarlo dos veces al mismo elemento multiplicaría el tamaño.
  await page.evaluate((k) => {
    const els = [...document.querySelectorAll('body, body *')].filter((e) => !e.dataset.scaled);
    const sizes = els.map((e) => parseFloat(getComputedStyle(e).fontSize));
    els.forEach((e, i) => { e.style.fontSize = `${sizes[i] * k}px`; e.dataset.scaled = '1'; });
  }, z);
}

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✔ ${name}`); } else { fail++; console.log(`  ✘ ${name} ${extra}`); }
}

const browser = await chromium.launch();

// ── 1 · Maquetación por pantalla ──
console.log('\n── 1 · Nada se sale de la pantalla ──');
const SCENARIOS = [[375, 1], [390, 1], [360, 1.3], [360, 1.5], [320, 1.5], [280, 1], [768, 1], [1280, 1]];
for (const [width, z] of SCENARIOS) {
  const ctx = await browser.newContext({ viewport: { width, height: 800 }, isMobile: width < 900, hasTouch: width < 900 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await mockSupabase(page);
  await page.goto(url, { waitUntil: 'networkidle' });
  const found = [];
  const step = async (label, fn) => { if (fn) await fn(); await page.waitForTimeout(450); await scaleText(page, z); const o = await overflow(page); if (o.length) found.push(`${label}: ${o.join(' | ')}`); };
  await step('portada');
  await step('selector', () => page.click('#cta-btn'));
  await step('chat', () => page.click('#ctx-card-consulta'));
  await page.waitForTimeout(700);
  await step('chat con nombre', async () => { await page.fill('#name-input', 'Ana'); await page.click('.name-submit'); });
  await step('respuesta', async () => { await page.fill('#input-field', '¿Pueden cortarme el agua?'); await page.click('#send-btn'); await page.waitForSelector('.bubble.agent'); });
  await step('propietarios', () => page.click('#tab-propietario'));
  const ok = found.length === 0 && errors.length === 0;
  check(`${width}px · texto ${Math.round(z * 100)}%`, ok, `${found.join(' ; ')} ${errors.join(' ; ')}`);
  await ctx.close();
}

// ── 2 · Flujo completo en un teléfono ──
console.log('\n── 2 · El flujo funciona igual que antes ──');
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await mockSupabase(page);
  await page.goto(url, { waitUntil: 'networkidle' });
  const shot = async (n) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/speaks-${n}.png` }); };
  await shot('1-portada');
  check('la portada nombra la ley por lo que es, no por su número', !(await page.content()).includes('284'));
  check('las tipografías salen del propio dominio', await page.evaluate(() => ![...document.styleSheets].some((s) => (s.href || '').includes('googleapis'))));
  check('Cinzel, EB Garamond y DM Sans cargadas', await page.evaluate(async () => { await document.fonts.ready; return ['Cinzel', 'EB Garamond', 'DM Sans'].every((f) => document.fonts.check(`16px "${f}"`)); }));
  check('sin nombres ni cargos personales: firma de ForumPHs y aviso legal', !(await page.content()).includes('Ivette') && (await page.textContent('.s-disclaimer')).includes('criterio jurídico por ForumPHs') && (await page.textContent('.s-disclaimer')).includes('puede cometer errores'));
  await page.click('#cta-btn'); await page.waitForTimeout(500); await shot('2-selector');
  check('el selector se muestra', await page.isVisible('#ctx-card-consulta'));
  check('el selector lleva el logotipo ForumPHs Speaks', await page.isVisible('#ctx-selector .speaks-lockup'));
  check('público y exclusivo se distinguen', (await page.textContent('#ctx-card-consulta')).includes('Consulta legal pública') && (await page.textContent('#ctx-card-propietario')).replace(/\s+/g, ' ').includes('Solo propietarios de PHs administrados por: ForumPHs') && await page.isVisible('#ctx-card-propietario .excl-callout'));
  await page.click('#ctx-card-consulta'); await page.waitForTimeout(1200); await shot('3-chat');
  check('el chat pide el nombre', await page.isVisible('#name-input'));
  check('el chat lleva el logotipo ForumPHs Speaks', await page.isVisible('.app-bar .speaks-lockup'));
  check('las pestañas se leen enteras', await page.evaluate(() => [...document.querySelectorAll('.t-label')].every((l) => l.scrollWidth <= l.clientWidth + 1)));
  const ph = await page.getAttribute('#input-field', 'placeholder');
  const phFits = await page.evaluate(() => { const f = document.getElementById('input-field'); return f.scrollHeight <= f.clientHeight + 2; });
  check('el texto de ayuda del campo cabe en una línea', phFits, ph);
  const covered = await page.evaluate(() => {
    const f = document.querySelector('.input-float').getBoundingClientRect();
    const x = f.left + f.width / 2, y = f.top + f.height / 2;
    const top = document.elementFromPoint(x, y);
    return top && !top.closest('.input-float') ? (top.id || top.className) : '';
  });
  check('nada tapa el campo de escritura', !covered, covered);
  await page.fill('#name-input', 'Ana'); await page.click('.name-submit'); await page.waitForTimeout(300);
  check('bienvenida con el texto de Sam', (await page.textContent('.name-bubble')).includes('puesto que estoy soportado sobre infraestructura tecnológica podría equivocarme'));
  check('saludo con tilde y signo de apertura', (await page.textContent('.name-bubble')).includes('¿Cuál es su consulta?'));
  await page.fill('#input-field', '¿Pueden cortarme el agua?'); await page.click('#send-btn');
  await page.waitForSelector('.bubble.agent'); await page.waitForTimeout(300); await shot('4-respuesta');
  const agentHtml = await page.innerHTML('.bubble.agent');
  check('la respuesta conserva negrita y cursiva', agentHtml.includes('<strong>Respuesta</strong>') && agentHtml.includes('<em>'));
  check('la respuesta no inyecta HTML', !agentHtml.includes('<img') && !(await page.evaluate(() => window.__xss)));
  check('la nota de consultas lleva su separador', (await page.textContent('#input-note')).includes(' · Enter para enviar'));
  // Pantalla baja (lo que queda útil con la barra del navegador): es donde la lista no cabe y
  // los renglones se montaban.
  await page.setViewportSize({ width: 390, height: 520 });
  await page.click('#drawer-trigger'); await page.waitForTimeout(450); await shot('5-faq');
  check('las preguntas frecuentes se abren', await page.evaluate(() => document.getElementById('questions-drawer').classList.contains('open')));
  const overlap = await page.evaluate(() => {
    const items = [...document.querySelectorAll('.drawer-item')];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.scrollHeight > it.clientHeight + 1) return `renglón cortado: «${it.textContent.slice(0, 30)}»`;
      if (i && items[i - 1].getBoundingClientRect().bottom > it.getBoundingClientRect().top + 0.5) return `montado: «${it.textContent.slice(0, 30)}»`;
    }
    return '';
  });
  check('preguntas frecuentes: ningún renglón se corta ni se monta', !overlap, overlap);
  await page.click('.drawer-close'); await page.waitForTimeout(400);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click('#tab-propietario'); await page.waitForTimeout(400); await shot('6-propietarios');
  check('propietarios lleva el logotipo ForumPHs Speaks', await page.isVisible('.app-bar .speaks-lockup'));
  check('un solo campo #owner-email en la página', (await page.$$('#owner-email')).length === 1);
  check('el botón del formulario tiene su rótulo', (await page.textContent('#owner-verify-btn')).trim() === 'Acceder a mi espacio');
  await page.fill('#owner-email', 'no-es-correo'); await page.click('#owner-verify-btn');
  check('correo inválido: mensaje con tilde', (await page.textContent('#owner-error')).includes('válido'));
  await page.fill('#owner-email', 'ana@example.com'); await page.click('#owner-verify-btn'); await page.waitForTimeout(400); await shot('7-codigo');
  const otpStep = await page.textContent('#owner-panel-content');
  check('paso del código: «código» y «dígitos» con tilde, sin marcadores de texto', otpStep.includes('código de 6 dígitos') && !otpStep.includes('[correo]'));
  await page.click('.owner-link'); await page.waitForTimeout(200);
  check('«Cambiar correo» vuelve al MISMO formulario', (await page.textContent('#owner-verify-btn')).trim() === 'Acceder a mi espacio' && (await page.$$('#owner-email')).length === 1);
  await page.fill('#owner-email', 'ana@example.com'); await page.click('#owner-verify-btn'); await page.waitForTimeout(300);
  await page.fill('#owner-otp', '123456'); await page.click('#owner-otp-btn'); await page.waitForTimeout(400); await shot('8-verificado');
  const okHtml = await page.innerHTML('#owner-panel-content');
  check('propietario verificado: nombre escapado', !okHtml.includes('<img') && okHtml.includes('&lt;img') && !(await page.evaluate(() => window.__xss)));
  check('propietario verificado: sin marcador [ok]', !okHtml.includes('[ok]') && okHtml.includes('<svg'));
  check('sin errores de JavaScript', errors.length === 0, errors.join(' ; '));
  await ctx.close();
}

await browser.close();
server.close();
console.log(`\n═══ ${pass} pasaron · ${fail} fallaron ═══`);
process.exit(fail ? 1 : 0);
