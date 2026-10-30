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
const { randomBytes } = require('node:crypto');

const ENGINES = ['auto', 'pdf', 'directo', 'zpl'];
const MICRONS_PER_PX = 25400 / 96;

// Se ejecuta dentro del documento térmico antes de imprimir: texto en negro
// puro (la térmica no tiene grises) y logos convertidos a blanco y negro con un
// umbral fijo, sin filtros CSS que obliguen a rasterizar la página.
const BLACK_WHITE_SCRIPT = `(async () => {
  const style = document.createElement('style');
  style.textContent = '*{color:#000!important;text-shadow:none!important;opacity:1!important}img{filter:none!important;image-rendering:pixelated}';
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
function isZebra(printerName) { return ZEBRA.test(String(printerName || '')); }

// Motor efectivo para un trabajo: lo elegido en el menú o, en Automático, el
// mejor disponible para ese papel e impresora.
async function resolveEngine(settings, { printerName, format, media }) {
  if (format === 'zpl') return 'zpl';
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
function pageFor(media, heightPx) {
  const mm = paperMm(media);
  if (mm) return { width: mm * 1000, height: Math.max(30_000, Math.round(heightPx * MICRONS_PER_PX) + 3_000) };
  return media === 'a4' ? 'A4' : 'Letter';
}
function pdfPageFor(media, heightPx) {
  const page = pageFor(media, heightPx);
  return typeof page === 'string' ? page : { width: page.width / 25_400, height: page.height / 25_400 };
}

// Entrega un PDF a Acrobat para que lo imprima en la impresora indicada.
async function printPdfBuffer({ pdf, printerName, copies, userData }) {
  const acrobat = await findAcrobat();
  if (!acrobat) throw new Error('Acrobat Reader no está instalado en esta computadora');
  const file = path.join(tempDir(userData), `velo-${Date.now()}-${randomBytes(4).toString('hex')}.pdf`);
  fs.writeFileSync(file, pdf, { mode: 0o600 });
  // /n instancia nueva · /s sin pantalla de bienvenida · /h minimizado · /t imprime en la impresora indicada y sale.
  for (let copy = 0; copy < copies; copy++) {
    const child = execFile(acrobat, ['/n', '/s', '/h', '/t', file, printerName], { windowsHide: true });
    // Acrobat Reader no siempre se cierra tras /t: se termina cuando ya entregó el trabajo al spooler.
    await new Promise(resolve => setTimeout(resolve, 9_000));
    try { child.kill(); } catch { /* ya salió */ }
  }
  setTimeout(() => { try { fs.unlinkSync(file); } catch { /* se limpia luego */ } }, 120_000);
}

async function printPdf({ html, printerName, copies, media, userData }) {
  if (!(await findAcrobat())) throw new Error('Acrobat Reader no está instalado en esta computadora');
  const mm = paperMm(media);
  const { win, heightPx } = await loadDocument(html, mm ? Math.round(mm * 96 / 25.4) : 816, Boolean(mm));
  let pdf;
  try {
    pdf = await win.webContents.printToPDF({ pageSize: pdfPageFor(media, heightPx), printBackground: true,
      margins: mm ? { top: 0, bottom: 0, left: 0, right: 0 } : { marginType: 'default' }, preferCSSPageSize: !mm });
  } finally { if (!win.isDestroyed()) win.destroy(); }
  await printPdfBuffer({ pdf, printerName, copies, userData });
}

async function printDirect({ html, printerName, copies, media, dpi }) {
  const mm = paperMm(media);
  const { win, heightPx } = await loadDocument(html, mm ? Math.round(mm * 96 / 25.4) : 816, Boolean(mm));
  try {
    const resolution = [203, 300, 600].includes(Number(dpi)) ? Number(dpi) : (mm ? 203 : 600);
    await new Promise((resolve, reject) => win.webContents.print({
      silent: true, printBackground: true, copies, deviceName: printerName,
      margins: mm ? { marginType: 'custom', top: 0, bottom: 0, left: 0, right: 0 } : { marginType: 'default' },
      pageSize: pageFor(media, heightPx), dpi: { horizontal: resolution, vertical: resolution },
    }, (success, failureReason) => success ? resolve() : reject(new Error(failureReason || 'Windows rechazó el trabajo de impresión'))));
  } finally { if (!win.isDestroyed()) win.destroy(); }
}

// ZPL en bruto: el spooler de Windows lo entrega tal cual (tipo de datos RAW),
// como Zebra Designer. Ruta y nombre de la impresora viajan por variables de
// entorno, nunca dentro del script.
const RAW_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
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
"@
[VeloRaw]::Send($env:VELO_PRINTER, [System.IO.File]::ReadAllBytes($env:VELO_FILE))
`;

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
      { env: { ...process.env, VELO_PRINTER: printerName, VELO_FILE: file }, timeout: 30_000 });
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
[pscustomobject]@{ driver = $queue.QueueDriver.Name; port = $queue.QueuePort.Name; capabilities = $caps.ReadToEnd() } | ConvertTo-Json -Compress
`;

function profileFromCapabilities(driver, port, xml) {
  const widths = [...String(xml || '').matchAll(/MediaSizeWidth"[^>]*>\s*<psf:Value[^>]*>(\d+)</g)].map(m => Number(m[1]) / 1000).filter(Boolean);
  const roll = widths.filter(mm => mm >= 40 && mm <= 120);
  const sheet = widths.some(mm => mm >= 200);
  const names = [...String(xml || '').matchAll(/name="([^"]+)"/g)].map(m => m[1]).join(' ');
  const cutter = /cut|corte|cortador|cutter/i.test(names);
  // Térmica de recibos: driver de rollo (anchos de 40 a 120 mm, sin hojas) que no es Zebra.
  const rollWidthMm = roll.length ? Math.max(...roll) : null;
  const escpos = Boolean(rollWidthMm) && !sheet && !isZebra(driver);
  return { driver, port, rollWidthMm, sheet, cutter, escpos };
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
    return { ...profileFromCapabilities(data.driver, data.port, data.capabilities), checkedAt: new Date().toISOString() };
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
  const origin = `^LH${Math.max(0, dots(settings.offsetXmm))},${Math.max(0, dots(settings.offsetYmm))}`;
  return `~SD${String(darkness).padStart(2, '0')}\n` + zpl.replace(/\^XA/g, `^XA^PR${speed}${origin}`);
}

function validZpl(zpl) {
  return typeof zpl === 'string' && zpl.length > 6 && zpl.length < 300_000 && /^\s*\^XA/.test(zpl) && /\^XZ\s*$/.test(zpl)
    && Array.from(zpl).every(char => char === '\t' || char === '\n' || char === '\r' || (char >= ' ' && char <= '~')) && !/~(?!SD\d\d)|\^(?:DF|IS|ID|DG|DY|HZ|JU|NC|NN|NT|NW|SE|WR)/i.test(zpl);
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

module.exports = { printerHealth, healthFromWindows, escposFeedCut, probePrinter, profileFromCapabilities, ENGINES, BLACK_WHITE_SCRIPT, pdfPageFor, findAcrobat, isZebra, resolveEngine, printPdf, printPdfBuffer, printDirect, printRaw, zplWithSettings, validZpl, testLabelZpl, testReceiptHtml, paperMm };
