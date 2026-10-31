// Motores de impresión de VELO Bridge. Cada impresora usa el que da mejor
// resultado en ella:
//   pdf     → PDF del tamaño exacto del papel, impreso por Acrobat (como el
//             sistema anterior del cliente: texto vectorial, nítido).
//   directo → Electron a la resolución real de la impresora (203/300 DPI).
//   zpl     → órdenes nativas Zebra (ZPL) enviadas en bruto al spooler, igual
//             que Zebra Designer: sin conversión a imagen ni pérdida de densidad.
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');

const ENGINES = ['auto', 'escpos', 'pdf', 'directo', 'zpl'];
const MICRONS_PER_PX = 25400 / 96;

// Se ejecuta dentro del documento térmico antes de imprimir: texto en negro
// puro (la térmica no tiene grises) y logos convertidos a blanco y negro con un
// umbral fijo, sin filtros CSS que obliguen a rasterizar la página.
const BLACK_WHITE_SCRIPT = `(async () => {
  const style = document.createElement('style');
  style.textContent = '*{color:#000!important;border-color:#000!important;text-shadow:none!important;opacity:1!important}img{filter:none!important;image-rendering:pixelated}';
  document.head.appendChild(style);
  for (const image of Array.from(document.images)) {
    try {
      if (image.decode) await image.decode().catch(() => {});
      if (!image.naturalWidth) continue;
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d');
      context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0);
      const data = context.getImageData(0, 0, canvas.width, canvas.height);
      for (let i = 0; i < data.data.length; i += 4) {
        const value = (0.299 * data.data[i] + 0.587 * data.data[i + 1] + 0.114 * data.data[i + 2]) < 160 ? 0 : 255;
        data.data[i] = data.data[i + 1] = data.data[i + 2] = value; data.data[i + 3] = 255;
      }
      context.putImageData(data, 0, 0);
      image.src = canvas.toDataURL('image/png');
      if (image.decode) await image.decode().catch(() => {});
    } catch { /* imagen de otro origen: se deja como está */ }
  }
  return true;
})()`;

function run(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 60_000, ...options }, (error, stdout, stderr) => {
      if (error) { error.stderr = String(stderr || ''); reject(error); } else resolve(String(stdout || ''));
    });
  });
}

// Acrobat (Reader o Pro). Primero el registro de Windows; después las rutas
// habituales de instalación.
let acrobatCache;
async function findAcrobat() {
  if (acrobatCache !== undefined) return acrobatCache;
  acrobatCache = null;
  if (process.platform !== 'win32') return acrobatCache;
  for (const exe of ['Acrobat.exe', 'AcroRd32.exe']) {
    try {
      const out = await run('reg', ['query', `HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`, '/ve'], { timeout: 5_000 });
      const match = /REG_SZ\s+(.+\.exe)/i.exec(out);
      if (match && fs.existsSync(match[1].trim().replace(/^"|"$/g, ''))) { acrobatCache = match[1].trim().replace(/^"|"$/g, ''); return acrobatCache; }
    } catch { /* no registrado */ }
  }
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean);
  const tails = ['Adobe/Acrobat DC/Acrobat/Acrobat.exe', 'Adobe/Acrobat Reader DC/Reader/AcroRd32.exe', 'Adobe/Acrobat Reader/Reader/AcroRd32.exe', 'Adobe/Reader 11.0/Reader/AcroRd32.exe'];
  for (const root of roots) for (const tail of tails) {
    const candidate = path.join(root, tail);
    if (fs.existsSync(candidate)) { acrobatCache = candidate; return acrobatCache; }
  }
  return acrobatCache;
}

// Etiquetadoras que entienden ZPL de forma nativa.
const ZEBRA = /zebra|zdesigner|\blp ?28\d\d|\btlp ?28\d\d|\bgk42\d|\bgx42\d|\bzd\d{3}|\bgc420/i;
function isZebra(printerName, driver = '') { return ZEBRA.test(`${printerName || ''} ${driver || ''}`); }

// Lenguaje de la Zebra. Las LP/TLP 2824 y 2844 originales (sin «Plus») solo
// entienden EPL2; las Plus, GK/GX/ZD y demás, ZPL. También manda lo que diga el
// driver de Windows: «(EPL)» o «(ZPL)». Se puede fijar a mano por impresora.
const EPL_ONLY = /\b(?:t?lp)\s?-?28[24]4\b|\(epl\)/i;
function zebraLanguage(printerName, driver = '', override = 'auto') {
  if (override === 'zpl' || override === 'epl') return override;
  const text = `${printerName || ''} ${driver || ''}`;
  if (/\(zpl\)|\bplus\b/i.test(text)) return 'zpl';
  return EPL_ONLY.test(text) ? 'epl' : 'zpl';
}

// --- ZPL → EPL2 ---------------------------------------------------------------
// VELO arma las etiquetas en ZPL con pocas órdenes (^PW ^LL ^FO ^A0N ^FB ^FH ^FD
// ^BY ^BC ^GB ^GFA ^PQ). Para una Zebra EPL se traducen una por una: texto con la
// letra fija de EPL que mejor cabe, Code 128, líneas, logo (GW) y cantidad.
const EPL_FONTS = { 203: { 1: [8, 12], 2: [10, 16], 3: [12, 20], 4: [14, 24], 5: [32, 48] }, 300: { 1: [12, 20], 2: [16, 28], 3: [20, 36], 4: [24, 44], 5: [48, 80] } };
// Página de códigos 850 (EPL I8,1): letras con tilde, ñ y signos del español.
const CP850 = { 'Ç': 0x80, 'ü': 0x81, 'é': 0x82, 'â': 0x83, 'ä': 0x84, 'à': 0x85, 'ç': 0x87, 'ê': 0x88, 'è': 0x8a, 'ï': 0x8b, 'î': 0x8c, 'ì': 0x8d, 'Ä': 0x8e, 'É': 0x90, 'ô': 0x93, 'ö': 0x94, 'ò': 0x95, 'û': 0x96, 'ù': 0x97, 'Ö': 0x99, 'Ü': 0x9a, 'á': 0xa0, 'í': 0xa1, 'ó': 0xa2, 'ú': 0xa3, 'ñ': 0xa4, 'Ñ': 0xa5, 'ª': 0xa6, 'º': 0xa7, '¿': 0xa8, '¡': 0xad, 'Á': 0xb5, 'Â': 0xb6, 'À': 0xb7, 'Í': 0xd6, 'Ó': 0xe0, 'Ú': 0xe9, '°': 0xf8, '·': 0xfa };
function cp850(text) {
  return Buffer.from(Array.from(String(text)).map(char => { const code = char.charCodeAt(0); return code >= 0x20 && code < 0x7f ? code : CP850[char] ?? 0x3f; }));
}
const fieldValue = (raw, hex) => hex ? Buffer.from(raw.replace(/_([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8') : raw;
const eplQuote = buffer => Buffer.concat([Buffer.from('"'), Buffer.from(buffer.toString('latin1').replace(/\\/g, '\\\\').replace(/"/g, '\\"'), 'latin1'), Buffer.from('"')]);

function eplText({ x, y, height, boxWidth, align, text, dpi }) {
  const fonts = EPL_FONTS[Number(dpi) === 300 ? 300 : 203];
  // La combinación (letra, multiplicador) más alta que no pase el alto pedido y quepa en el ancho.
  let best = null;
  // La letra 5 de la EPL2 solo trae mayúsculas: con minúsculas o tildes sale basura.
  const capsOnly = /^[A-Z0-9 .,:\-/#$%()+]*$/.test(text);
  for (const [font, [cw, ch]] of Object.entries(fonts)) {
    if (font === '5' && !capsOnly) continue;
    for (let mult = 1; mult <= 4; mult++) {
      const th = ch * mult, tw = cw * mult * text.length;
      if (th > height * 1.12 && !(font === '1' && mult === 1)) continue;
      const fits = !boxWidth || tw <= boxWidth;
      // Mismo alto: la más angosta, para que quepa más texto.
      const score = (fits ? 10_000 : 0) + th * 10 - tw / 1_000;
      if (!best || score > best.score) best = { font, mult, cw, ch, th, tw, score, fits };
    }
  }
  let value = text;
  if (!best.fits && boxWidth) { const max = Math.max(1, Math.floor(boxWidth / (best.cw * best.mult))); value = text.length > max ? `${text.slice(0, Math.max(1, max - 1))}.` : text; }
  const width = best.cw * best.mult * value.length;
  const left = align === 'C' && boxWidth ? x + Math.max(0, Math.round((boxWidth - width) / 2)) : x;
  const top = y + Math.max(0, Math.round((height - best.th) / 2));
  return Buffer.concat([Buffer.from(`A${left},${top},0,${best.font},${best.mult},${best.mult},N,`), eplQuote(cp850(value)), Buffer.from('\n')]);
}

function zplToEpl(zpl, settings = {}) {
  const dpi = Number(settings.dpi) === 300 ? 300 : 203;
  const dpmm = dpi === 300 ? 12 : 8;
  const density = Math.max(0, Math.min(15, Math.round(Number(settings.darkness ?? 20) / 2)));
  const speed = Math.max(1, Math.min(4, Math.round(Number(settings.speed ?? 3)) - (Number(settings.speed) >= 5 ? 1 : 0)));
  const labels = String(zpl).split(/\^XA/).slice(1).map(part => part.split(/\^XZ/)[0]);
  const head = Number(settings.maxWidthMm) > 0 ? Math.round(Number(settings.maxWidthMm) * dpmm) : 0;
  const out = [];
  for (const body of labels) {
    const state = { x: 0, y: 0, height: 20, box: 0, align: 'L', hex: false, module: 2, barHeight: 50, barcode: false, gb: null, gf: null };
    let width = Math.round(Number(settings.labelWidthMm || 52) * dpmm), length = Math.round(Number(settings.labelHeightMm || 28) * dpmm), quantity = 1;
    const declared = /\^PW(\d+)/.exec(body);
    if (declared) width = Number(declared[1]) || width;
    // Etiqueta diseñada más ancha que el cabezal: se encoge a lo ancho para que
    // nada se salga (la EPL2 pinta lo que sobra en el borde izquierdo).
    const fit = head && width > head ? head / width : 1;
    const sx = value => Math.round(value * fit);
    // Desplazamiento del asistente (puede ser negativo: a la izquierda o hacia arriba).
    const dx = Math.round((Number(settings.offsetXmm) || 0) * dpmm), dy = Math.round((Number(settings.offsetYmm) || 0) * dpmm);
    const px = value => Math.max(0, sx(value) + dx), py = value => Math.max(0, value + dy);
    const parts = [];
    for (const token of body.split('^').filter(Boolean)) {
      const code = token.slice(0, 2).toUpperCase(), args = token.slice(2);
      const nums = args.split(',').map(value => Number(value));
      if (code === 'PW') continue;
      else if (code === 'LL') length = nums[0] || length;
      else if (code === 'PQ') quantity = Math.max(1, nums[0] || 1);
      else if (code === 'FO') { state.x = nums[0] || 0; state.y = nums[1] || 0; }
      else if (code === 'A0') { const [, h, w] = args.split(','); state.height = Number(h) || state.height; state.fontWidth = Number(w) || state.height; }
      else if (code === 'FB') { const fb = args.split(','); state.box = Number(fb[0]) || 0; state.align = (fb[3] || 'L').toUpperCase() === 'C' ? 'C' : 'L'; }
      else if (code === 'FH') state.hex = true;
      else if (code === 'BY') { state.module = nums[0] || 2; state.barHeight = nums[2] || state.barHeight; }
      else if (code === 'BC') { state.barcode = true; state.barHeight = Number(args.split(',')[1]) || state.barHeight; }
      else if (code === 'GB') state.gb = { w: nums[0] || 1, h: nums[1] || 1, t: nums[2] || 1 };
      else if (code === 'GF') { const [, , , bpr, hex] = args.split(','); state.gf = { bpr: Number(bpr), hex: hex || '' }; }
      else if (code === 'FD') state.data = args;
      else if (code === 'FS') {
        if (state.gf) {
          const bytes = Buffer.from(state.gf.hex, 'hex').map(byte => ~byte & 0xff); // EPL GW: 0 = punto negro
          parts.push(Buffer.from(`GW${px(state.x)},${py(state.y)},${state.gf.bpr},${Math.floor(bytes.length / state.gf.bpr)},`), Buffer.from(bytes), Buffer.from('\n'));
        } else if (state.gb) {
          const { w, h, t } = state.gb;
          parts.push(Buffer.from(t >= Math.min(w, h) ? `LO${px(state.x)},${py(state.y)},${Math.max(1, sx(w))},${h}\n` : `X${px(state.x)},${py(state.y)},${t},${px(state.x + w)},${py(state.y + h)}\n`));
        } else if (state.barcode && state.data != null) {
          const data = fieldValue(state.data, state.hex).replace(/></g, '>');
          parts.push(Buffer.from(`B${px(state.x)},${py(state.y)},0,1,${state.module},${state.module * 2},${state.barHeight},N,`), eplQuote(cp850(data)), Buffer.from('\n'));
        } else if (state.data != null) {
          // Sin ^FB el texto tampoco puede pasar del borde derecho de la etiqueta.
          const x = px(state.x), right = head ? Math.min(width, head) : width;
          const box = Math.max(dpmm, Math.min(state.box ? sx(state.box) : right - x - dpmm, right - x));
          parts.push(eplText({ x, y: py(state.y), height: state.height, boxWidth: box, align: state.box ? state.align : 'L', text: fieldValue(state.data, state.hex), dpi }));
        }
        Object.assign(state, { box: 0, align: 'L', hex: false, barcode: false, gb: null, gf: null, data: null });
      }
    }
    if (head) width = Math.min(width, head);
    // Tipo de rollo: espacio entre etiquetas (gap), marca negra al reverso o continuo.
    const tracking = settings.mediaTracking === 'mark' ? `B${3 * dpmm}` : settings.mediaTracking === 'continuous' ? '0' : String(3 * dpmm);
    out.push(Buffer.from(`\nN\nI8,1,001\nq${width}\nQ${length},${tracking}\nS${speed}\nD${density}\nZT\nR0,0\n`), ...parts, Buffer.from(`P${quantity}\n`));
  }
  return Buffer.concat(out);
}

// Motor efectivo para un trabajo: lo elegido en el menú o, en Automático, el
// mejor disponible para ese papel e impresora.
async function resolveEngine(settings, { printerName, format, media, escpos = false }) {
  if (format === 'zpl') return 'zpl';
  // Rollos térmicos: siempre directo, del largo exacto del ticket. Acrobat
  // centra la página corta dentro del papel del driver y deja espacio en
  // blanco arriba; queda para hojas Carta/A4.
  if (paperMm(media)) {
    const chosen = ENGINES.includes(settings?.engine) ? settings.engine : 'auto';
    if (chosen === 'escpos' || (chosen === 'auto' && escpos)) return 'escpos';
    return 'directo';
  }
  const chosen = ENGINES.includes(settings?.engine) ? settings.engine : 'auto';
  if (chosen === 'pdf') return (await findAcrobat()) ? 'pdf' : 'directo';
  if (chosen === 'directo' || chosen === 'zpl') return 'directo';
  if (media === 'label' || isZebra(printerName)) return 'directo';
  return (await findAcrobat()) ? 'pdf' : 'directo';
}

function paperMm(media) {
  const match = /^(\d{2,3})mm$/.exec(String(media || ''));
  return match ? Number(match[1]) : null;
}

function tempDir(userData) {
  const dir = path.join(userData, 'print-temp');
  fs.mkdirSync(dir, { recursive: true });
  // Limpia restos de trabajos anteriores (más de 10 minutos).
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    try { if (Date.now() - fs.statSync(file).mtimeMs > 600_000) fs.unlinkSync(file); } catch { /* en uso */ }
  }
  return dir;
}

// Abre el documento en una ventana oculta y mide su alto real. El HTML llega
// con CSP default-src 'none': sus propios scripts no corren; solo esta medición.
async function loadDocument(html, widthPx, thermal = false) {
  const { BrowserWindow } = require('electron');
  const win = new BrowserWindow({ show: false, width: widthPx, height: 1200, paintWhenInitiallyHidden: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true, webSecurity: true } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await win.webContents.executeJavaScript('Promise.all(Array.from(document.images).map(i => i.decode ? i.decode().catch(() => {}) : 0))');
  if (thermal) await win.webContents.executeJavaScript(BLACK_WHITE_SCRIPT).catch(() => {});
  const heightPx = await win.webContents.executeJavaScript('Math.ceil(Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0))');
  return { win, heightPx: Number(heightPx) || 1000 };
}

// Ojo: webContents.print mide el papel en micrones y printToPDF en pulgadas.
// Etiqueta en HTML (impresoras de etiquetas que no son Zebra): la página mide
// exactamente la etiqueta configurada en Bridge, nunca una hoja Carta.
function labelSize(media, label) {
  return media === 'label' && label && Number(label.widthMm) > 0 && Number(label.heightMm) > 0
    ? { widthMm: Number(label.widthMm), heightMm: Number(label.heightMm) } : null;
}
function pageFor(media, heightPx, label) {
  const tag = labelSize(media, label);
  if (tag) return { width: Math.round(tag.widthMm * 1000), height: Math.round(tag.heightMm * 1000) };
  const mm = paperMm(media);
  if (mm) return { width: mm * 1000, height: Math.max(30_000, Math.round(heightPx * MICRONS_PER_PX) + 3_000) };
  return media === 'a4' ? 'A4' : 'Letter';
}
function pdfPageFor(media, heightPx, label) {
  const page = pageFor(media, heightPx, label);
  return typeof page === 'string' ? page : { width: page.width / 25_400, height: page.height / 25_400 };
}

// Entrega un PDF a Acrobat y, en el mismo paso, vigila la cola de Windows: en
// cuanto el trabajo terminó de entrar al spooler cierra Acrobat y, si hace
// falta, manda el avance y corte. Antes se esperaban 9 s fijos y luego se
// arrancaba otro proceso para cortar (10-13 s de espera en el mostrador).
const acrobatScript = () => `
$ErrorActionPreference = 'Stop'
$printer = $env:VELO_PRINTER
$copies = [int]$env:VELO_COPIES
$cut = $env:VELO_CUT_FILE
function Get-PrinterJobs {
  # La coma conserva la lista vacía (sin ella PowerShell la convierte en $null).
  try { return ,@(Get-CimInstance -ClassName Win32_PrintJob -ErrorAction Stop | Where-Object { $_.Name.StartsWith($printer + ',') }) } catch { return $null }
}
for ($copy = 0; $copy -lt $copies; $copy++) {
  $snap = Get-PrinterJobs
  $before = @(if ($snap -is [array]) { $snap | ForEach-Object { $_.JobId } })
  $acroArgs = '/n /s /h /t "' + $env:VELO_FILE + '" "' + $printer + '"'
  $proc = Start-Process -FilePath $env:VELO_ACROBAT -ArgumentList $acroArgs -PassThru -WindowStyle Hidden
  if ($copy -eq 0 -and $cut) { ${RAW_LOADER} }
  $started = Get-Date; $seen = $false; $done = $false
  # Sin ver el trabajo en 9 s (o sin acceso a la cola) se sigue como antes.
  while ($true) {
    $elapsed = ((Get-Date) - $started).TotalSeconds
    if ((-not $seen -and $elapsed -gt 9) -or $elapsed -gt 20) { break }
    $jobs = Get-PrinterJobs
    if ($jobs -is [array]) {
      $mine = @($jobs | Where-Object { $before -notcontains $_.JobId })
      if ($mine.Count -gt 0) {
        $seen = $true
        # Sigue entrando a la cola mientras el bit 8 (JOB_STATUS_SPOOLING) esté activo.
        if (-not ($mine | Where-Object { ([uint32]$_.StatusMask -band 8) -or [string]$_.JobStatus -match 'Spool' })) { Start-Sleep -Milliseconds 250; $done = $true; break }
      } elseif ($seen) { $done = $true; break }
    }
    Start-Sleep -Milliseconds 150
  }
  try { if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force } } catch { }
  if ($cut) { [VeloRaw]::Send($printer, [System.IO.File]::ReadAllBytes($cut)) }
  Write-Output ($(if ($done) { 'spooled' } else { 'timeout' }))
}
`;
async function printPdfBuffer({ pdf, printerName, copies, userData, cut }) {
  const acrobat = await findAcrobat();
  if (!acrobat) throw new Error('Acrobat Reader no está instalado en esta computadora');
  const dir = tempDir(userData);
  const id = `${Date.now()}-${randomBytes(4).toString('hex')}`;
  const file = path.join(dir, `velo-${id}.pdf`);
  const script = path.join(dir, `velo-acrobat-${id}.ps1`);
  const cutFile = cut ? path.join(dir, `velo-cut-${id}.bin`) : '';
  fs.writeFileSync(file, pdf, { mode: 0o600 });
  fs.writeFileSync(script, acrobatScript(), { mode: 0o600 });
  if (cut) fs.writeFileSync(cutFile, cut, { mode: 0o600 });
  try {
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { timeout: 30_000 * copies + 10_000,
      env: { ...process.env, VELO_ACROBAT: acrobat, VELO_FILE: file, VELO_PRINTER: printerName, VELO_COPIES: String(copies), VELO_CUT_FILE: cutFile, VELO_RAW_DLL: rawDll(userData) } });
  } finally {
    for (const target of [script, cutFile].filter(Boolean)) { try { fs.unlinkSync(target); } catch { /* se limpia luego */ } }
    setTimeout(() => { try { fs.unlinkSync(file); } catch { /* se limpia luego */ } }, 120_000);
  }
}

async function printPdf({ html, printerName, copies, media, userData, label, cut }) {
  if (!(await findAcrobat())) throw new Error('Acrobat Reader no está instalado en esta computadora');
  const mm = labelSize(media, label)?.widthMm || paperMm(media);
  const { win, heightPx } = await loadDocument(html, mm ? Math.round(mm * 96 / 25.4) : 816, Boolean(mm));
  let pdf;
  try {
    pdf = await win.webContents.printToPDF({ pageSize: pdfPageFor(media, heightPx, label), printBackground: true,
      margins: mm ? { top: 0, bottom: 0, left: 0, right: 0 } : { marginType: 'default' }, preferCSSPageSize: !mm });
  } finally { if (!win.isDestroyed()) win.destroy(); }
  await printPdfBuffer({ pdf, printerName, copies, userData, cut });
}

async function printDirect({ html, printerName, copies, media, dpi, label, printableMm }) {
  const tag = labelSize(media, label);
  const mm = tag?.widthMm || paperMm(media);
  const { win, heightPx } = await loadDocument(html, mm ? Math.round(mm * 96 / 25.4) : 816, Boolean(mm));
  try {
    const resolution = [203, 300, 600].includes(Number(dpi)) ? Number(dpi) : (mm ? 203 : 600);
    // Rollo: Windows empieza a imprimir en el borde del área imprimible (72 mm
    // en un rollo de 80); el ticket se reduce a ese ancho para salir centrado.
    const roll = !tag && paperMm(media);
    const usable = roll ? printableWidthMm(roll, printableMm) : 0;
    const scale = roll ? usable / roll : 1;
    const pageSize = roll ? { width: Math.round(usable * 1000), height: Math.max(30_000, Math.round(heightPx * MICRONS_PER_PX * scale) + 3_000) } : pageFor(media, heightPx, label);
    await new Promise((resolve, reject) => win.webContents.print({
      silent: true, printBackground: true, copies, deviceName: printerName,
      margins: mm ? { marginType: 'custom', top: 0, bottom: 0, left: 0, right: 0 } : { marginType: 'default' },
      pageSize, dpi: { horizontal: resolution, vertical: resolution }, ...(roll ? { scaleFactor: Math.round(scale * 100) } : {}),
    }, (success, failureReason) => success ? resolve() : reject(new Error(failureReason || 'Windows rechazó el trabajo de impresión'))));
  } finally { if (!win.isDestroyed()) win.destroy(); }
}

// Ancho que la térmica imprime de verdad: 72 mm en rollos de 80, 64 en 72 y 48
// en 58 (cabezal de 576, 512 y 384 puntos a 203 DPI). Se puede ajustar por impresora.
function printableWidthMm(paper, override) {
  const custom = Number(override);
  if (custom >= 30 && custom <= paper) return custom;
  return paper >= 76 ? 72 : paper >= 68 ? 64 : 48;
}

// --- Térmicas ESC/POS en imagen ------------------------------------------------
// El ticket se dibuja con el mismo HTML de la vista previa, al ancho exacto del
// cabezal (576 puntos en 80 mm), se pasa a blanco y negro puro y se envía en
// lenguaje ESC/POS junto con el avance y el corte. Sin driver de por medio: la
// letra sale nítida (sin grises), centrada y sin espacio en blanco arriba.
async function renderThermalBitmap(html, { paper, printableMm, dpi = 203, offsetMm = 0 }) {
  const { BrowserWindow } = require('electron');
  const dotsPerMm = (Number(dpi) === 300 ? 300 : 203) / 25.4;
  const width = Math.round(printableWidthMm(paper, printableMm) * dotsPerMm / 8) * 8;
  const cssWidth = paper * 96 / 25.4;
  const zoom = width / cssWidth;
  const win = new BrowserWindow({ show: false, width, height: 1200, useContentSize: true, enableLargerThanScreen: true,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true, webSecurity: true } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    win.webContents.setZoomFactor(zoom);
    await win.webContents.executeJavaScript('Promise.all(Array.from(document.images).map(i => i.decode ? i.decode().catch(() => {}) : 0))');
    await win.webContents.executeJavaScript(BLACK_WHITE_SCRIPT).catch(() => {});
    await win.webContents.executeJavaScript("document.documentElement.style.overflow='hidden';true");
    const cssHeight = Number(await win.webContents.executeJavaScript('Math.ceil(Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0))')) || 600;
    const height = Math.min(16_000, Math.ceil(cssHeight * zoom) + 4);
    win.setContentSize(width, height);
    await new Promise(resolve => setTimeout(resolve, 250));
    win.webContents.invalidate();
    await new Promise(resolve => setTimeout(resolve, 150));
    let image = await win.webContents.capturePage({ x: 0, y: 0, width, height });
    // Con la pantalla escalada (125 %, 150 %, Retina) la captura sale más grande:
    // se lleva al ancho exacto del cabezal antes de pasarla a blanco y negro.
    if (image.getSize().width !== width) image = image.resize({ width, quality: 'best' });
    const size = image.getSize();
    return monochrome(image.toBitmap(), size.width, size.height, width, Math.round((Number(offsetMm) || 0) * dotsPerMm));
  } finally { if (!win.isDestroyed()) win.destroy(); }
}

// BGRA → filas de bits (1 = negro) al ancho del cabezal, sin filas blancas al
// principio ni al final. offset desplaza el ticket a la derecha (+) o izquierda (−).
function monochrome(bgra, sourceWidth, sourceHeight, width, offset = 0) {
  const bytesPerRow = width / 8;
  const rows = [];
  for (let y = 0; y < sourceHeight; y++) {
    const row = Buffer.alloc(bytesPerRow);
    let ink = false;
    for (let x = 0; x < width; x++) {
      const sx = x - offset;
      if (sx < 0 || sx >= sourceWidth) continue;
      const i = (y * sourceWidth + sx) * 4;
      const luma = 0.114 * bgra[i] + 0.587 * bgra[i + 1] + 0.299 * bgra[i + 2];
      if (bgra[i + 3] > 0 && luma < 160) { row[x >> 3] |= 0x80 >> (x & 7); ink = true; }
    }
    rows.push({ row, ink });
  }
  let first = rows.findIndex(r => r.ink); let last = rows.length - 1 - [...rows].reverse().findIndex(r => r.ink);
  if (first < 0) { first = 0; last = 0; }
  const kept = rows.slice(Math.max(0, first - 4), last + 1).map(r => r.row);
  return { width, height: kept.length, data: Buffer.concat(kept) };
}

// ESC @ (inicio) + imagen en franjas GS v 0 de 128 filas + avance y corte.
function escposRaster(bitmap, { cut = true, feedLines = 4 } = {}) {
  const bytesPerRow = bitmap.width / 8;
  const parts = [Buffer.from([0x1b, 0x40])];
  for (let y = 0; y < bitmap.height; y += 128) {
    const rows = Math.min(128, bitmap.height - y);
    parts.push(Buffer.from([0x1d, 0x76, 0x30, 0x00, bytesPerRow & 0xff, bytesPerRow >> 8, rows & 0xff, rows >> 8]));
    parts.push(bitmap.data.subarray(y * bytesPerRow, (y + rows) * bytesPerRow));
  }
  parts.push(cut ? escposFeedCut(feedLines) : Buffer.from([0x1b, 0x64, Math.max(0, Math.min(15, Math.round(Number(feedLines) || 0)))]));
  return Buffer.concat(parts);
}

async function printEscpos({ html, printerName, copies, media, settings = {}, userData, cut }) {
  const paper = paperMm(media) || 80;
  const bitmap = await renderThermalBitmap(html, { paper, printableMm: settings.printableMm, dpi: settings.dpi, offsetMm: settings.thermalOffsetMm });
  if (!bitmap.height) throw new Error('El ticket salió vacío');
  const data = escposRaster(bitmap, { cut, feedLines: settings.feedLines });
  for (let copy = 0; copy < copies; copy++) await printRaw({ printerName, data, userData });
  return bitmap;
}

// ZPL en bruto: el spooler de Windows lo entrega tal cual (tipo de datos RAW),
// como Zebra Designer. Ruta y nombre de la impresora viajan por variables de
// entorno, nunca dentro del script.
const RAW_TYPE = `using System; using System.Runtime.InteropServices;
public static class VeloRaw {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public class DOCINFO { public string pDocName; public string pOutputFile; public string pDataType; }
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool OpenPrinter(string name, out IntPtr handle, IntPtr defaults);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool ClosePrinter(IntPtr handle);
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)] public static extern int StartDocPrinter(IntPtr handle, int level, DOCINFO info);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool EndDocPrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool StartPagePrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool EndPagePrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool WritePrinter(IntPtr handle, byte[] data, int count, out int written);
  public static void Send(string printer, byte[] data) {
    IntPtr h; if (!OpenPrinter(printer, out h, IntPtr.Zero)) throw new Exception("No se pudo abrir la impresora");
    try {
      var info = new DOCINFO { pDocName = "VELO Bridge ZPL", pDataType = "RAW" };
      if (StartDocPrinter(h, 1, info) == 0) throw new Exception("La impresora rechazó el trabajo");
      try { StartPagePrinter(h); int w; if (!WritePrinter(h, data, data.Length, out w) || w != data.Length) throw new Exception("No se enviaron todos los datos"); EndPagePrinter(h); }
      finally { EndDocPrinter(h); }
    } finally { ClosePrinter(h); }
  }
}
`;
// El envío en bruto se compila una sola vez a una DLL en la carpeta de Bridge
// (compilar en cada trabajo tardaba segundos y retrasaba el corte del ticket).
const RAW_LOADER = `
$src = @"
${RAW_TYPE}
"@
$dll = $env:VELO_RAW_DLL
try {
  if ($dll -and -not (Test-Path -LiteralPath $dll)) {
    $tmp = $dll + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    Add-Type -TypeDefinition $src -OutputAssembly $tmp -OutputType Library
    try { Move-Item -LiteralPath $tmp -Destination $dll -ErrorAction Stop } catch { Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue }
  }
  if (-not ('VeloRaw' -as [type])) { Add-Type -Path $dll }
} catch {
  if (-not ('VeloRaw' -as [type])) { Add-Type -TypeDefinition $src }
}
`;
const RAW_SCRIPT = `
$ErrorActionPreference = 'Stop'
${RAW_LOADER}
[VeloRaw]::Send($env:VELO_PRINTER, [System.IO.File]::ReadAllBytes($env:VELO_FILE))
`;
const rawDll = userData => path.join(userData, `velo-raw-${createHash('sha256').update(RAW_TYPE).digest('hex').slice(0, 12)}.dll`);

async function printRaw({ printerName, data, userData }) {
  if (process.platform !== 'win32') throw new Error('La impresión ZPL directa requiere Windows');
  const dir = tempDir(userData);
  const id = `${Date.now()}-${randomBytes(4).toString('hex')}`;
  const script = path.join(dir, `velo-raw-${id}.ps1`);
  const file = path.join(dir, `velo-raw-${id}.zpl`);
  fs.writeFileSync(script, RAW_SCRIPT, { mode: 0o600 });
  fs.writeFileSync(file, data, { mode: 0o600 });
  try {
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
      { env: { ...process.env, VELO_PRINTER: printerName, VELO_FILE: file, VELO_RAW_DLL: rawDll(userData) }, timeout: 30_000 });
  } catch (error) {
    const line = String(error.stderr || '').split('\n').find(text => /No se pudo|rechazó|enviaron/.test(text));
    throw new Error(line ? line.replace(/^.*?(No se|La impresora)/, '$1').replace(/["']\s*$/, '').trim() : 'Windows no pudo enviar la etiqueta a la impresora');
  } finally {
    for (const target of [script, file]) { try { fs.unlinkSync(target); } catch { /* se limpia luego */ } }
  }
}

// Térmicas ESC/POS: al terminar el ticket, avanza el papel y corta. Windows
// cierra el trabajo donde termina el texto; sin esta orden el final queda
// antes de la cuchilla y hay que sacarlo a mano. ESC d n avanza n líneas;
// GS V 66 n lleva el papel hasta la cuchilla (+n) y hace corte parcial.
function escposFeedCut(lines = 4) {
  const n = Math.max(0, Math.min(15, Math.round(Number(lines) || 0)));
  return Buffer.from([0x1b, 0x64, n, 0x1d, 0x56, 0x42, 0x00]);
}

// Lo que Windows sabe de la impresora: driver, puerto, anchos de papel que
// acepta y si su controlador ofrece cortador. Se consulta con System.Printing.
const PROBE_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Printing
$server = New-Object System.Printing.LocalPrintServer
$queue = $server.GetPrintQueue($env:VELO_PRINTER)
$caps = New-Object System.IO.StreamReader($queue.GetPrintCapabilitiesAsXml())
$media = $null
try { $size = $queue.DefaultPrintTicket.PageMediaSize; if ($size) { $media = @{ width = $size.Width; height = $size.Height } } } catch { }
$ticket = ''
try { $ticket = (New-Object System.IO.StreamReader($queue.DefaultPrintTicket.GetXmlStream())).ReadToEnd() } catch { }
[pscustomobject]@{ driver = $queue.QueueDriver.Name; port = $queue.QueuePort.Name; capabilities = $caps.ReadToEnd(); media = $media; ticket = $ticket } | ConvertTo-Json -Compress
`;

// Tipo de rollo y método de impresión que el driver de Windows tiene elegidos
// (los ZDesigner los guardan en el PrintTicket con nombres propios).
function mediaFromTicket(ticket) {
  const pairs = [...String(ticket || '').matchAll(/<psf:Feature\s+name="([^"]+)"[^>]*>\s*<psf:Option\s+name="([^"]+)"/g)].map(m => [m[1], m[2]]);
  let tracking = null, method = null;
  for (const [feature, option] of pairs) {
    const text = `${feature} ${option}`;
    if (/media|track|sens|type/i.test(feature) && !tracking) {
      if (/mark|black/i.test(option)) tracking = 'mark';
      else if (/continu/i.test(option)) tracking = 'continuous';
      else if (/web|gap|notch|non-?continu|label/i.test(option)) tracking = 'gap';
    }
    if (/method|thermal|ribbon/i.test(text) && !method) {
      if (/direct/i.test(option)) method = 'direct';
      else if (/transfer|ribbon/i.test(option)) method = 'transfer';
    }
  }
  return { tracking, method };
}

function profileFromCapabilities(driver, port, xml, media = null, ticket = '') {
  const widths = [...String(xml || '').matchAll(/MediaSizeWidth"[^>]*>\s*<psf:Value[^>]*>(\d+)</g)].map(m => Number(m[1]) / 1000).filter(Boolean);
  const roll = widths.filter(mm => mm >= 40 && mm <= 120);
  const sheet = widths.some(mm => mm >= 200);
  const names = [...String(xml || '').matchAll(/name="([^"]+)"/g)].map(m => m[1]).join(' ');
  const cutter = /cut|corte|cortador|cutter/i.test(names);
  // Térmica de recibos: driver de rollo (anchos de 40 a 120 mm, sin hojas) que no es Zebra.
  const rollWidthMm = roll.length ? Math.max(...roll) : null;
  const escpos = Boolean(rollWidthMm) && !sheet && !isZebra(driver);
  // Papel predeterminado del driver (1/96 de pulgada): en una Zebra es la etiqueta configurada.
  const toMm = value => Math.round(Number(value) * 25.4 / 96 * 10) / 10;
  const defaultMedia = media && Number(media.width) > 0 && Number(media.height) > 0 ? { widthMm: toMm(media.width), heightMm: toMm(media.height) } : null;
  return { driver, port, rollWidthMm, sheet, cutter, escpos, defaultMedia, driverMedia: mediaFromTicket(ticket) };
}

async function probePrinter(printerName, userData) {
  if (process.platform !== 'win32') return null;
  const dir = tempDir(userData);
  const script = path.join(dir, `velo-probe-${Date.now()}-${randomBytes(4).toString('hex')}.ps1`);
  fs.writeFileSync(script, PROBE_SCRIPT, { mode: 0o600 });
  try {
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
      { env: { ...process.env, VELO_PRINTER: printerName }, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 });
    const data = JSON.parse(out.trim());
    return { ...profileFromCapabilities(data.driver, data.port, data.capabilities, data.media, data.ticket), checkedAt: new Date().toISOString() };
  } catch { return null; } finally { try { fs.unlinkSync(script); } catch { /* se limpia luego */ } }
}

// Estado real de varias impresoras en una sola consulta a Windows: listas,
// sin papel, desconectadas, atascadas, con tapa abierta o con trabajos
// detenidos. Muchas térmicas USB solo informan «desconectada»; el resto de
// avisos depende de que su driver los entregue.
const HEALTH_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Printing
$server = New-Object System.Printing.LocalPrintServer
$names = $env:VELO_PRINTERS | ConvertFrom-Json
$result = @()
foreach ($name in $names) {
  try {
    $q = $server.GetPrintQueue($name); $q.Refresh()
    $stuck = 0
    foreach ($job in $q.GetPrintJobInfoCollection()) { if ($job.IsInError -or $job.IsBlocked -or $job.IsPaperOut -or $job.IsOffline -or $job.IsUserInterventionRequired) { $stuck++ } }
    $result += [pscustomobject]@{ name = $name; offline = ($q.IsOffline -or $q.IsNotAvailable); paperOut = ($q.IsOutOfPaper -or $q.HasPaperProblem); jammed = $q.IsPaperJammed;
      door = $q.IsDoorOpened; error = ($q.IsInError -or $q.NeedUserIntervention); paused = $q.IsPaused; jobs = $q.NumberOfJobs; stuck = $stuck }
  } catch { $result += [pscustomobject]@{ name = $name; missing = $true } }
}
ConvertTo-Json -InputObject @($result) -Compress
`;

// Traduce lo que informa Windows a un estado y un mensaje para el cajero.
function healthFromWindows(row) {
  if (!row || row.missing) return { state: 'missing', message: 'No está instalada en Windows' };
  if (row.offline) return { state: 'offline', message: 'Desconectada o apagada' };
  if (row.paperOut) return { state: 'paper', message: 'Sin papel' };
  if (row.jammed) return { state: 'jammed', message: 'Papel atascado' };
  if (row.door) return { state: 'door', message: 'Tapa abierta' };
  if (row.paused) return { state: 'paused', message: 'En pausa en Windows' };
  if (row.error || row.stuck > 0) return { state: 'error', message: row.stuck > 0 ? `${row.stuck} trabajo(s) detenido(s) en Windows` : 'Requiere atención' };
  return { state: 'ready', message: row.jobs > 0 ? `Lista · ${row.jobs} en curso` : 'Lista' };
}

async function printerHealth(printerNames, userData) {
  const names = [...new Set(printerNames.filter(Boolean))];
  if (!names.length) return {};
  if (process.platform !== 'win32') return Object.fromEntries(names.map(name => [name, { state: 'unknown', message: 'Estado disponible solo en Windows' }]));
  const dir = tempDir(userData);
  const script = path.join(dir, `velo-health-${Date.now()}-${randomBytes(4).toString('hex')}.ps1`);
  fs.writeFileSync(script, HEALTH_SCRIPT, { mode: 0o600 });
  try {
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
      { env: { ...process.env, VELO_PRINTERS: JSON.stringify(names) }, timeout: 20_000 });
    const rows = JSON.parse(out.trim() || '[]');
    return Object.fromEntries(names.map(name => [name, { ...healthFromWindows((Array.isArray(rows) ? rows : [rows]).find(row => row.name === name)), checkedAt: new Date().toISOString() }]));
  } catch {
    return Object.fromEntries(names.map(name => [name, { state: 'unknown', message: 'No se pudo consultar a Windows' }]));
  } finally { try { fs.unlinkSync(script); } catch { /* se limpia luego */ } }
}

// Ajustes de la impresora Zebra que se anteponen a cada trabajo: oscuridad
// (~SD 00-30), velocidad (^PR 2-6 pulg/s) y desplazamiento del origen (^LH).
function zplWithSettings(zpl, settings = {}) {
  const darkness = Math.max(0, Math.min(30, Math.round(Number(settings.darkness ?? 20))));
  const speed = Math.max(2, Math.min(6, Math.round(Number(settings.speed ?? 3))));
  const dots = value => Math.round((Number(value) || 0) * (Number(settings.dpi) === 300 ? 12 : 8));
  const ox = dots(settings.offsetXmm), oy = dots(settings.offsetYmm);
  const origin = `^LH${Math.max(0, ox)},${Math.max(0, oy)}${oy < 0 ? `^LT${Math.max(-120, oy)}` : ''}`;
  // Hacia la izquierda se usa ^LS (desplaza todo el contenido); reemplaza el ^LS0 de la etiqueta.
  const body = ox < 0 ? zpl.replace(/\^LS-?\d+/g, '').replace(/\^XA/g, `^XA^LS${-ox}`) : zpl;
  const maxDots = Number(settings.maxWidthMm) > 0 ? Math.round(Number(settings.maxWidthMm) * (Number(settings.dpi) === 300 ? 12 : 8)) : 0;
  const clamped = maxDots ? body.replace(/\^PW(\d+)/g, (_, w) => `^PW${Math.min(Number(w), maxDots)}`) : body;
  const tracking = settings.mediaTracking === 'mark' ? '^MNM' : settings.mediaTracking === 'continuous' ? '^MNN' : settings.mediaTracking === 'gap' ? '^MNY' : '';
  return `~SD${String(darkness).padStart(2, '0')}\n` + clamped.replace(/\^XA/g, `^XA^PR${speed}${tracking}${origin}`);
}

function validZpl(zpl) {
  return typeof zpl === 'string' && zpl.length > 6 && zpl.length < 300_000 && /^\s*\^XA/.test(zpl) && /\^XZ\s*$/.test(zpl)
    && Array.from(zpl).every(char => char === '\t' || char === '\n' || char === '\r' || (char >= ' ' && char <= '~')) && !/~(?!SD\d\d)|\^(?:DF|IS|ID|DG|DY|HZ|JU|NC|NN|NT|NW|SE|WR)/i.test(zpl);
}

// --- Asistente de etiquetadora Zebra -------------------------------------------
// Detecta modelo, lenguaje y resolución por el nombre o el driver, y propone la
// oscuridad y la velocidad que recomienda Zebra para cada familia.
// maxWidthMm: ancho máximo que imprime el cabezal (LP/TLP 2824: 56 mm; 4"': 104 mm).
// Si se manda más ancho, la EPL2 «envuelve» lo que sobra al borde izquierdo.
const ZEBRA_MODELS = [
  { test: /\b(?:t?lp)\s?-?2824\b.*\bplus\b|\bplus\b.*\b(?:t?lp)\s?-?2824\b/i, model: 'LP 2824 Plus', darkness: 22, speed: 3, maxWidthMm: 56 },
  { test: /\b(?:t?lp)\s?-?2824\b/i, model: 'LP 2824 (EPL2)', darkness: 20, speed: 2, maxWidthMm: 56 },
  { test: /\b(?:t?lp)\s?-?2844\b.*\bplus\b|\bplus\b.*\b(?:t?lp)\s?-?2844\b/i, model: 'LP 2844 Plus', darkness: 22, speed: 3, maxWidthMm: 104 },
  { test: /\b(?:t?lp)\s?-?2844\b/i, model: 'LP 2844 (EPL2)', darkness: 20, speed: 2, maxWidthMm: 104 },
  { test: /\bg[kx]\s?4[23]0/i, model: 'GK/GX 420', darkness: 20, speed: 4, maxWidthMm: 104 },
  { test: /\bzd\s?\d{3}/i, model: 'ZD', darkness: 20, speed: 4, maxWidthMm: 104 },
  { test: /\bgc\s?420/i, model: 'GC420', darkness: 20, speed: 3, maxWidthMm: 104 },
];
function zebraProfile(printerName, driver = '', probe = null, override = 'auto') {
  const text = `${printerName || ''} ${driver || ''}`;
  const family = ZEBRA_MODELS.find(row => row.test.test(text)) || { model: 'Zebra', darkness: 20, speed: 3, maxWidthMm: 104 };
  const dpi = /300\s?dpi|-300\b|\(300\)/i.test(text) ? 300 : 203;
  const media = probe?.defaultMedia && probe.defaultMedia.widthMm >= 15 && probe.defaultMedia.widthMm <= 110 && probe.defaultMedia.heightMm >= 8 && probe.defaultMedia.heightMm <= 300 ? probe.defaultMedia : null;
  return { model: family.model, language: zebraLanguage(printerName, driver, override), dpi, labelSize: media, maxWidthMm: family.maxWidthMm, driverMedia: probe?.driverMedia || null,
    recommended: { darkness: family.darkness, speed: family.speed, dpi } };
}

// Orden de calibrar el sensor: la Zebra avanza unas etiquetas y mide el espacio
// entre ellas (ZPL ~JC; EPL2 «xa»). Solo la envía Bridge, nunca VELO Cloud.
// Solo ZPL: la Zebra termina de medir antes de imprimir lo que sigue. La EPL2
// (LP 2824 original) imprime mientras todavía mueve el papel con «xa»: la
// etiqueta sale estirada y, si no ve el espacio entre etiquetas, sigue sacando
// papel. En EPL2 el sensor se calibra con el botón (EPL_SENSOR_STEPS).
function zebraCalibrationCommand(language) {
  return language === 'epl' ? null : Buffer.from('~JC\n');
}
const EPL_SENSOR_STEPS = 'Apaga la Zebra, mantén pulsado el botón de avance y enciéndela; suelta cuando la luz parpadee una vez. Avanzará unas etiquetas para medirlas e imprimirá su configuración; pulsa el botón una vez más para que vuelva a la normalidad.';

// Etiqueta de medición: en cada borde, 5 rayitas paralelas a 1 mm (la primera
// justo en el filo). Contando cuántas se ven en cada lado, Bridge sabe en un solo
// intento cuántos mm está corrida la etiqueta y si el rollo es más chico o más
// grande de lo configurado. Se dibuja en ZPL (y se traduce a EPL) y como imagen.
const MEASURE_LINES = 5;
function labelArea(widthMm, heightMm, dpi) {
  const dpmm = Number(dpi) === 300 ? 12 : 8;
  return { dpmm, w: Math.round(widthMm * dpmm), h: Math.round(heightMm * dpmm), t: dpmm === 12 ? 3 : 2, margin: Math.round(6 * dpmm) };
}
function calibrationElements({ widthMm = 52, heightMm = 28, dpi = 203, darkness = 20, speed = 3 } = {}) {
  const { dpmm, w, h, t, margin } = labelArea(widthMm, heightMm, dpi);
  const elements = [];
  const side = Math.round(Math.min(6 * dpmm, h * 0.3)), across = Math.round(Math.min(8 * dpmm, w * 0.3));
  for (let i = 0; i < MEASURE_LINES; i++) {
    const step = i * dpmm;
    elements.push({ kind: 'fill', x: step, y: Math.round(h / 2 - side / 2), w: t, h: side },
      { kind: 'fill', x: w - t - step, y: Math.round(h / 2 - side / 2), w: t, h: side },
      { kind: 'fill', x: Math.round(w / 2 - across / 2), y: step, w: across, h: t },
      { kind: 'fill', x: Math.round(w / 2 - across / 2), y: h - t - step, w: across, h: t });
  }
  const box = Math.max(dpmm * 8, w - margin * 2);
  const big = Math.max(16, Math.min(40, Math.round(h * 0.12))), small = Math.max(12, Math.min(28, Math.round(h * 0.08)));
  let y = margin;
  elements.push({ kind: 'text', x: margin, y, size: big, box, text: 'VELO Bridge' }); y += big + 4;
  const narrow = box < 34 * dpmm; // etiquetas chicas: textos cortos para que quepan completos
  elements.push({ kind: 'text', x: margin, y, size: small, box, text: narrow ? `${widthMm}x${heightMm} ${dpi}dpi` : `${widthMm} x ${heightMm} mm - ${dpi} DPI` }); y += small + 4;
  elements.push({ kind: 'text', x: margin, y, size: small, box, text: narrow ? `Osc ${darkness} Vel ${speed}` : `Oscuridad ${darkness} - Vel ${speed}` }); y += small + 6;
  const room = h - margin - y;
  if (room >= 4 * dpmm) {
    const module = box >= 30 * dpmm ? 2 : 1;
    elements.push({ kind: 'barcode', x: margin, y, h: Math.min(Math.round(8 * dpmm), room), module, value: 'VELO123' });
  }
  return { w, h, elements };
}
function elementsZpl(elements) {
  return elements.map(row => row.kind === 'fill' ? `^FO${row.x},${row.y}^GB${row.w},${row.h},${Math.min(row.w, row.h)}^FS`
    : row.kind === 'text' ? `^FO${row.x},${row.y}^A0N,${row.size},${row.size}^FB${row.box},1,0,L,0^FD${row.text}^FS`
      : `^FO${row.x},${row.y}^BY${row.module},2.5,${row.h}^BCN,${row.h},N,N,N^FD${row.value}^FS`).join('');
}
function elementsSvg(w, h, elements) {
  const esc = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const parts = elements.map(row => row.kind === 'fill' ? `<rect x="${row.x}" y="${row.y}" width="${row.w}" height="${row.h}"/>`
    : row.kind === 'text' ? `<text x="${row.x}" y="${row.y + row.size * 0.85}" font-size="${row.size}" font-weight="700" font-family="Arial Narrow,Arial,sans-serif"${row.text.length * row.size * 0.55 > row.box ? ` textLength="${row.box}" lengthAdjust="spacingAndGlyphs"` : ''}>${esc(row.text)}</text>`
      : Array.from({ length: 24 }, (_, i) => `<rect x="${row.x + i * 5 * row.module}" y="${row.y}" width="${(i % 3 === 0 ? 2 : 1) * row.module}" height="${row.h}"/>`).join(''));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#fff"/><g fill="#111">${parts.join('')}</g></svg>`;
}
function calibrationLabelZpl(options = {}) {
  const { w, h, elements } = calibrationElements(options);
  return `^XA^CI28^PW${w}^LL${h}^LS0${elementsZpl(elements)}^PQ1,0,1,Y^XZ`;
}
function calibrationPreviewSvg(options = {}) {
  const { w, h, elements } = calibrationElements(options);
  return elementsSvg(w, h, elements);
}

// Corrección a partir de lo que se ve en cada borde: 0 a 5 rayitas (las que
// faltan son los mm que se cortan) o 6 = «las 5 y sobra papel» (≈1 mm de más).
// La EPL2 y las Zebra de escritorio centran la etiqueta en el cabezal: si cambia
// el ancho, cada lado se mueve la mitad.
function measureCorrection(settings, counts = {}, { headWidthMm = 0 } = {}) {
  const read = value => { const n = Math.round(Number(value)); return Number.isFinite(n) ? Math.max(0, Math.min(6, n)) : MEASURE_LINES; };
  const miss = side => { const n = read(counts[side]); return n === 6 ? -1 : MEASURE_LINES - n; };
  const [mL, mR, mT, mB] = ['left', 'right', 'top', 'bottom'].map(miss);
  const next = { ...settings }, notes = [];
  const mm = value => `${Math.abs(value)} mm${Math.abs(value) >= MEASURE_LINES ? ' o más' : ''}`;
  const width = headWidthMm ? Math.min(Number(settings.labelWidthMm), headWidthMm) : Number(settings.labelWidthMm);
  const height = Number(settings.labelHeightMm);
  let dx = 0, dy = 0, newWidth = width, newHeight = height;
  if (mL > 0 && mR > 0) { newWidth = width - mL - mR; dx = (mL - mR) / 2; notes.push(`Se cortan los dos lados: el rollo mide unos ${newWidth} mm de ancho, no ${width}. Ajusto el ancho.`); }
  else if (mL < 0 && mR < 0) { newWidth = width + 2; notes.push(`Sobra papel a los dos lados: el rollo es más ancho. Subo el ancho a ${newWidth} mm.`); }
  else if (mL > 0) { dx = mL; notes.push(`Se cortaba el borde izquierdo: salía corrida ${mm(mL)} a la izquierda. La muevo a la derecha.`); }
  else if (mR > 0) { dx = -mR; notes.push(`Se cortaba el borde derecho: salía corrida ${mm(mR)} a la derecha. La muevo a la izquierda.`); }
  else if (mL < 0) { newWidth = width + 1; dx = -0.5; notes.push('Sobra papel a la izquierda: el rollo es un poco más ancho. Ajusto ancho y posición.'); }
  else if (mR < 0) { newWidth = width + 1; dx = 0.5; notes.push('Sobra papel a la derecha: el rollo es un poco más ancho. Ajusto ancho y posición.'); }
  if (mT > 0 && mB > 0) { newHeight = height - mT - mB; dy = mT; notes.push(`Se cortan arriba y abajo: la etiqueta mide unos ${newHeight} mm de alto, no ${height}. Ajusto el alto.`); }
  else if (mT < 0 && mB < 0) { newHeight = height + 2; dy = -1; notes.push(`Sobra papel arriba y abajo: la etiqueta es más alta. Subo el alto a ${newHeight} mm.`); }
  else if (mT > 0) { dy = mT; notes.push(`Se cortaba arriba: salía ${mm(mT)} más arriba. La bajo.`); }
  else if (mB > 0) { dy = -mB; notes.push(`Se cortaba abajo: salía ${mm(mB)} más abajo. La subo.`); }
  else if (mT < 0) { newHeight = height + 1; dy = -1; notes.push('Sobra papel arriba: la etiqueta es un poco más alta. La subo y ajusto el alto.'); }
  else if (mB < 0) { newHeight = height + 1; notes.push('Sobra papel abajo: la etiqueta es un poco más alta. Ajusto el alto.'); }
  const clamp = (value, min, max) => Math.max(min, Math.min(max, Math.round(value * 2) / 2));
  next.offsetXmm = clamp((Number(settings.offsetXmm) || 0) + dx, -10, 10);
  next.offsetYmm = clamp((Number(settings.offsetYmm) || 0) + dy, -10, 10);
  if (newWidth !== width) next.labelWidthMm = clamp(newWidth, 20, headWidthMm || 110);
  if (newHeight !== height) next.labelHeightMm = clamp(newHeight, 10, 300);
  return { settings: next, notes, centered: !notes.length };
}

// Tres muestras de oscuridad numeradas (más clara, actual, más oscura): letra
// chica, bloque sólido y barras, para elegir la mejor de una vez.
function darknessSamples(settings) {
  const base = Math.max(4, Math.min(26, Math.round(Number(settings.darkness ?? 20))));
  const values = [base - 4, base, base + 4];
  const widthMm = Number(settings.labelWidthMm) || 52, heightMm = Number(settings.labelHeightMm) || 28;
  const { dpmm, w, h, margin } = labelArea(widthMm, heightMm, settings.dpi);
  const pad = Math.round(3 * dpmm), box = w - pad * 2;
  const labels = values.map((darkness, index) => {
    const digit = Math.min(Math.round(h * 0.5), Math.round(box * 0.35));
    const left = pad + digit + Math.round(2 * dpmm), inner = Math.max(dpmm * 8, w - left - pad);
    const small = Math.max(12, Math.min(24, Math.round(h * 0.075)));
    const elements = [{ kind: 'text', x: pad, y: pad, size: digit, box: digit, text: String(index + 1) },
      { kind: 'text', x: left, y: pad, size: small + 4, box: inner, text: `Oscuridad ${darkness}` },
      { kind: 'text', x: left, y: pad + small + 8, size: small, box: inner, text: 'Texto chico 0123456789' },
      { kind: 'fill', x: left, y: pad + small * 2 + 14, w: Math.min(inner, Math.round(12 * dpmm)), h: Math.round(3 * dpmm) }];
    const barTop = pad + small * 2 + 14 + Math.round(4 * dpmm);
    if (h - margin / 2 - barTop >= 4 * dpmm) elements.push({ kind: 'barcode', x: left, y: barTop, h: Math.min(Math.round(7 * dpmm), h - pad - barTop), module: inner >= 30 * dpmm ? 2 : 1, value: 'VELO123' });
    return { darkness, zpl: `^XA^CI28^PW${w}^LL${h}^LS0${elementsZpl(elements)}^PQ1,0,1,Y^XZ` };
  });
  return { values, labels };
}

// Lo que Bridge recomienda para esta etiquetadora, con el porqué de cada ajuste.
const TRACKING_TEXT = { gap: 'Etiquetas con espacio entre ellas', mark: 'Etiquetas con marca negra al reverso', continuous: 'Papel continuo (sin separación)' };
function labelRecommendations({ profile, settings, headWidthMm = 0, driverMedia = null }) {
  const width = Number(settings.labelWidthMm), rows = [];
  rows.push(['Lenguaje', profile.language === 'epl' ? 'EPL2' : 'ZPL', profile.language === 'epl' ? 'La LP 2824 original y las 2844 sin «Plus» solo entienden EPL2; Bridge traduce cada etiqueta.' : 'Lenguaje nativo de las Zebra modernas.']);
  rows.push(['Resolución', `${profile.dpi} DPI`, profile.dpi === 300 ? 'El nombre o el driver indican cabezal de 300 DPI.' : '203 DPI: 8 puntos por mm, lo normal en etiquetadoras de escritorio.']);
  if (headWidthMm) rows.push(['Ancho', `${Math.min(width, headWidthMm)} mm`, width > headWidthMm ? `Esta Zebra imprime como máximo ${headWidthMm} mm; el rollo de ${width} mm se usa a ${headWidthMm} mm, centrado.` : `El cabezal imprime hasta ${headWidthMm} mm; el rollo cabe completo.`]);
  rows.push(['Oscuridad', String(profile.recommended.darkness), 'Punto de partida de Zebra para térmica directa; luego se elige entre 3 muestras.']);
  rows.push(['Velocidad', `${profile.recommended.speed} pulg/s`, profile.language === 'epl' ? 'Más lenta = letras más nítidas en las EPL2.' : 'Equilibrio entre nitidez y rapidez para este modelo.']);
  const tracking = settings.mediaTracking || driverMedia?.tracking || 'gap';
  rows.push(['Tipo de rollo', TRACKING_TEXT[tracking], driverMedia?.tracking ? 'Según el driver de Windows.' : 'Lo más común. Si el reverso tiene rayas negras, elige «marca negra».']);
  return rows.map(([title, value, why]) => ({ title, value, why }));
}

// Ajuste según cómo salió la etiqueta de calibración.
function applyLabelFeedback(settings, outcome) {
  const step = 1; // mm
  const next = { ...settings };
  if (outcome === 'light') next.darkness = Math.min(30, (Number(settings.darkness) || 20) + 3);
  else if (outcome === 'dark') next.darkness = Math.max(0, (Number(settings.darkness) || 20) - 3);
  else if (outcome === 'right') next.offsetXmm = Math.max(-10, (Number(settings.offsetXmm) || 0) - step);
  else if (outcome === 'left') next.offsetXmm = Math.min(10, (Number(settings.offsetXmm) || 0) + step);
  else if (outcome === 'down') next.offsetYmm = Math.max(-10, (Number(settings.offsetYmm) || 0) - step);
  else if (outcome === 'up') next.offsetYmm = Math.min(10, (Number(settings.offsetYmm) || 0) + step);
  return next;
}

// Etiqueta de prueba para calibrar desde el menú de VELO Bridge.
function testLabelZpl({ widthMm = 52, heightMm = 28, dpi = 203 } = {}) {
  const dpmm = Number(dpi) === 300 ? 12 : 8;
  const w = Math.round(widthMm * dpmm), h = Math.round(heightMm * dpmm);
  return `^XA^CI28^PW${w}^LL${h}^FO8,8^GB${w - 16},${h - 16},2^FS^FO20,22^A0N,${Math.round(h * 0.16)},${Math.round(h * 0.16)}^FDVELO Bridge^FS`
    + `^FO20,${Math.round(h * 0.36)}^A0N,${Math.round(h * 0.1)},${Math.round(h * 0.1)}^FD${widthMm} x ${heightMm} mm - ${dpi} DPI^FS`
    + `^FO20,${Math.round(h * 0.55)}^BY2^BCN,${Math.round(h * 0.28)},N,N,N^FDVELO123456^FS^XZ`;
}

function testReceiptHtml(mm) {
  const width = mm || 80;
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`
    + `<style>@page{size:${width}mm auto;margin:0}body{margin:0;width:${width}mm;color:#000;font:600 12px/1.4 Menlo,Consolas,'Lucida Console',monospace}`
    + `.t{width:${width - 8}mm;margin:0 auto;padding:3mm 0}.c{text-align:center}.b{font-weight:800;font-size:15px}.row{display:flex;justify-content:space-between}hr{border:0;border-top:1px dashed #000}</style></head>`
    + `<body><div class="t"><div class="c b">VELO Bridge</div><div class="c">Página de prueba · ${width} mm</div><hr>`
    + `<div class="row"><span>Texto normal</span><span>RD$1,234.00</span></div><div class="row b"><span>TOTAL</span><span>RD$1,180.00</span></div><hr>`
    + `<div class="c">ÁÉÍÓÚ Ñ ¿? ¡! 0123456789</div><div class="c" style="font-size:9px">Letra pequeña para medir nitidez</div></div></body></html>`;
}

module.exports = { zebraProfile, zebraCalibrationCommand, EPL_SENSOR_STEPS, measureCorrection, darknessSamples, labelRecommendations, mediaFromTicket, MEASURE_LINES, calibrationLabelZpl, calibrationPreviewSvg, applyLabelFeedback, zebraLanguage, zplToEpl, printEscpos, renderThermalBitmap, monochrome, escposRaster, printableWidthMm, printerHealth, healthFromWindows, escposFeedCut, probePrinter, profileFromCapabilities, ENGINES, BLACK_WHITE_SCRIPT, pdfPageFor, findAcrobat, isZebra, resolveEngine, printPdf, printPdfBuffer, printDirect, printRaw, zplWithSettings, validZpl, testLabelZpl, testReceiptHtml, paperMm };
