// ══════════════════════════════════════════════
// IMPORTACIÓN UNIVERSAL DE DATOS — Velo POS
// Soporta: Excel (.xlsx), CSV, JSON, SQLite (.db), PDF, TXT
// Usa Claude API para mapeo automático de columnas
// ══════════════════════════════════════════════

// ── Estado ────────────────────────────────────
let importState = {
  file:        null,
  rawData:     [],    // filas crudas del archivo
  headers:     [],    // columnas detectadas
  mapping:     {},    // { veloField: sourceColumn }
  tipo:        'productos', // 'productos' | 'clientes'
  importando:  false,
};

// ── Campos de Velo POS ────────────────────────
const VELO_FIELDS_PRODUCTS = [
  { key: 'name',      label: 'Nombre',       required: true  },
  { key: 'code',      label: 'Código',       required: false },
  { key: 'barcode',   label: 'Código barras',required: false },
  { key: 'price',     label: 'Precio venta', required: true  },
  { key: 'cost',      label: 'Costo',        required: false },
  { key: 'wholesale', label: 'Precio mayor', required: false },
  { key: 'stock',     label: 'Stock',        required: false },
  { key: 'stock_min', label: 'Stock mínimo', required: false },
  { key: 'category',  label: 'Categoría',    required: false },
  { key: 'brand',     label: 'Marca',        required: false },
  { key: 'unit',      label: 'Unidad',       required: false },
  { key: 'description',label: 'Descripción', required: false },
];

const VELO_FIELDS_CLIENTS = [
  { key: 'name',         label: 'Nombre',         required: true  },
  { key: 'phone',        label: 'Teléfono',        required: false },
  { key: 'email',        label: 'Email',           required: false },
  { key: 'rnc',          label: 'RNC/Cédula',      required: false },
  { key: 'address',      label: 'Dirección',       required: false },
  { key: 'credit_limit', label: 'Límite crédito',  required: false },
];

// ══════════════════════════════════════════════
// PASO 3 DEL WIZARD — Pantalla de importación
// ══════════════════════════════════════════════
function wizardStepImportar() {
  openModal(`
    <div style="text-align:center;margin-bottom:20px">
      <div style="font-size:36px;margin-bottom:8px">📂</div>
      <div class="modal-title">¿Tienes datos de otro sistema?</div>
      <div class="modal-sub">Importa tus productos y clientes automáticamente</div>
    </div>

    <div style="display:flex;gap:6px;margin-bottom:20px;justify-content:center">
      ${[1,2,3,4].map((i,idx) => `
        <div style="width:28px;height:5px;border-radius:3px;
             background:${idx < 3 ? 'var(--green)' : 'var(--line)'}"></div>
      `).join('')}
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px">
      <div class="card" style="text-align:center;cursor:pointer;border:2px solid var(--line);padding:16px"
           id="imp-tipo-prod"
           onclick="setImportTipo('productos')">
        <div style="font-size:24px;margin-bottom:6px">📦</div>
        <div style="font-weight:500;font-size:13px">Productos</div>
        <div style="font-size:11px;color:var(--muted2)">Inventario y precios</div>
      </div>
      <div class="card" style="text-align:center;cursor:pointer;border:2px solid var(--line);padding:16px"
           id="imp-tipo-cli"
           onclick="setImportTipo('clientes')">
        <div style="font-size:24px;margin-bottom:6px">👥</div>
        <div style="font-weight:500;font-size:13px">Clientes</div>
        <div style="font-size:11px;color:var(--muted2)">Contactos y crédito</div>
      </div>
    </div>

    <div style="border:2px dashed var(--line);border-radius:var(--r-md);padding:20px;
         text-align:center;cursor:pointer;margin-bottom:16px"
         onclick="document.getElementById('imp-file-input').click()"
         id="imp-drop-zone">
      <div style="font-size:28px;margin-bottom:6px">⬆</div>
      <div style="font-weight:500;font-size:13px;margin-bottom:4px">
        Arrastra tu archivo aquí o haz clic para seleccionar
      </div>
      <div style="font-size:11px;color:var(--muted2)">
        Excel (.xlsx), CSV, JSON, SQLite (.db), PDF, TXT — máximo 10MB
      </div>
      <input type="file" id="imp-file-input" style="display:none"
             accept=".xlsx,.xls,.csv,.json,.db,.sqlite,.pdf,.txt"
             onchange="onImportFileSelected(this)"/>
    </div>

    <div id="imp-file-info" style="display:none;margin-bottom:12px"></div>

    <div class="modal-foot">
      <button class="btn btn-out" onclick="wizardStep=4;renderWizardStep()">
        Omitir — empezar desde cero
      </button>
      <button class="btn btn-dark" id="imp-btn-analizar"
              onclick="analizarArchivoConIA()" disabled
              style="opacity:.4">
        ✨ Analizar con IA
      </button>
    </div>
  `, 'modal-xl');

  // Drag & drop
  setTimeout(() => {
    const zone = document.getElementById('imp-drop-zone');
    if (!zone) return;
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.style.borderColor = 'var(--green)'; });
    zone.addEventListener('dragleave', () => { zone.style.borderColor = 'var(--line)'; });
    zone.addEventListener('drop', e => {
      e.preventDefault();
      zone.style.borderColor = 'var(--line)';
      const file = e.dataTransfer.files[0];
      if (file) procesarArchivoSeleccionado(file);
    });
    // Seleccionar productos por defecto
    setImportTipo('productos');
  }, 50);
}

function setImportTipo(tipo) {
  importState.tipo = tipo;
  document.getElementById('imp-tipo-prod')?.style.setProperty(
    'border-color', tipo === 'productos' ? 'var(--green)' : 'var(--line)'
  );
  document.getElementById('imp-tipo-cli')?.style.setProperty(
    'border-color', tipo === 'clientes' ? 'var(--green)' : 'var(--line)'
  );
}

function onImportFileSelected(input) {
  const file = input.files[0];
  if (file) procesarArchivoSeleccionado(file);
}

function procesarArchivoSeleccionado(file) {
  if (file.size > 10 * 1024 * 1024) {
    toast('El archivo es mayor a 10MB', 'err'); return;
  }
  importState.file = file;
  const info = document.getElementById('imp-file-info');
  if (info) {
    info.style.display = 'block';
    info.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;padding:10px 12px;
           background:var(--surface2);border-radius:var(--r-sm)">
        <span style="font-size:20px">${fileEmoji(file.name)}</span>
        <div>
          <div style="font-weight:500;font-size:13px">${file.name}</div>
          <div style="font-size:11px;color:var(--muted2)">${(file.size/1024).toFixed(1)} KB</div>
        </div>
        <span style="margin-left:auto;color:var(--green);font-size:18px">✓</span>
      </div>`;
  }
  const btn = document.getElementById('imp-btn-analizar');
  if (btn) { btn.disabled = false; btn.style.opacity = '1'; }
}

function fileEmoji(name) {
  const ext = name.split('.').pop().toLowerCase();
  const map = { xlsx:'📊', xls:'📊', csv:'📄', json:'📋', db:'🗃️', sqlite:'🗃️', pdf:'📑', txt:'📝' };
  return map[ext] || '📁';
}

// ══════════════════════════════════════════════
// LECTURA DEL ARCHIVO
// ══════════════════════════════════════════════
async function leerArchivo(file) {
  const ext = file.name.split('.').pop().toLowerCase();

  if (ext === 'csv' || ext === 'txt') {
    return leerCSV(file);
  } else if (ext === 'json') {
    return leerJSON(file);
  } else if (ext === 'xlsx' || ext === 'xls') {
    return leerExcel(file);
  } else if (ext === 'db' || ext === 'sqlite') {
    return leerSQLite(file);
  } else if (ext === 'pdf') {
    return leerPDF(file);
  }
  throw new Error(`Formato .${ext} no soportado`);
}

function leerCSV(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const text  = e.target.result;
        const lines = text.split(/\r?\n/).filter(l => l.trim());
        if (lines.length < 2) throw new Error('El archivo está vacío o tiene solo encabezados');

        // Detectar delimitador
        const delimiters = [',', ';', '\t', '|'];
        const counts     = delimiters.map(d => (lines[0].match(new RegExp(`\\${d}`, 'g')) || []).length);
        const delim      = delimiters[counts.indexOf(Math.max(...counts))];

        const headers = lines[0].split(delim).map(h => h.trim().replace(/^["']|["']$/g, ''));
        const rows    = lines.slice(1).map(line => {
          const vals = line.split(delim).map(v => v.trim().replace(/^["']|["']$/g, ''));
          const row  = {};
          headers.forEach((h, i) => { row[h] = vals[i] || ''; });
          return row;
        });
        resolve({ headers, rows });
      } catch(err) { reject(err); }
    };
    reader.onerror = reject;
    reader.readAsText(file, 'UTF-8');
  });
}

function leerJSON(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        let data = JSON.parse(e.target.result);
        if (!Array.isArray(data)) {
          // Buscar el primer array dentro del JSON
          const key = Object.keys(data).find(k => Array.isArray(data[k]));
          if (key) data = data[key];
          else throw new Error('No se encontró un array de datos en el JSON');
        }
        if (!data.length) throw new Error('El JSON está vacío');
        const headers = Object.keys(data[0]);
        resolve({ headers, rows: data });
      } catch(err) { reject(err); }
    };
    reader.onerror = reject;
    reader.readAsText(file);
  });
}

async function leerExcel(file) {
  // Cargar SheetJS desde CDN si no está disponible
  if (typeof XLSX === 'undefined') {
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
      s.onload = res;
      s.onerror = () => rej(new Error('No se pudo cargar el lector de Excel. Verifica tu conexión a internet.'));
      document.head.appendChild(s);
    });
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(e.target.result, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];

        // ── Detección inteligente de encabezados ──────────────────
        // Leer todas las filas como arrays para analizar la estructura
        const rawRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
        if (!rawRows.length) throw new Error('La hoja de Excel está vacía');

        // Palabras clave que indican una fila de encabezados real
        const HEADER_KEYWORDS = [
          'nombre','name','articulo','producto','cliente','descripcion','description',
          'precio','price','costo','cost','codigo','code','barcode','stock','cantidad',
          'existencia','telefono','phone','email','rnc','cedula','categoria','category',
          'id','clasificacion','tipo','type','marca','brand','proveedor','supplier',
          'unidad','unit','referencia','sku','pvp','importe','monto','valor',
          'NOMBRE','ARTICULO','PRODUCTO','PRECIO','CODIGO','CLIENTE','DESCRIPCION',
          'ID','CLASIFICACION','TIPO','EXISTENCIA','CANTIDAD',
        ];

        // Función para puntuar cuánto parece una fila de encabezados
        const scoreRow = (row) => {
          let score = 0;
          for (const cell of row) {
            const val = String(cell || '').trim().toLowerCase();
            if (!val) continue;
            if (HEADER_KEYWORDS.some(k => val.includes(k.toLowerCase()))) score += 3;
            // Penalizar filas con números (datos, no encabezados)
            if (/^\d+([.,]\d+)?$/.test(val)) score -= 2;
            // Penalizar filas con direcciones o info de negocio
            if (val.includes('tel') && val.includes(':')) score -= 5;
            if (val.includes('rnc:') || val.includes('ruc:')) score -= 5;
            // Bonificar celdas cortas (encabezados suelen ser cortos)
            if (val.length < 25 && val.length > 1) score += 1;
          }
          return score;
        };

        // Buscar la fila con mayor puntaje en las primeras 10 filas
        let bestRow = 0;
        let bestScore = -99;
        const searchLimit = Math.min(10, rawRows.length);
        for (let i = 0; i < searchLimit; i++) {
          const score = scoreRow(rawRows[i]);
          if (score > bestScore) { bestScore = score; bestRow = i; }
        }

        // Si la primera fila ya es buena (score > 0), usarla directamente
        // Si no, usar la fila detectada como encabezado
        const headerRow = rawRows[bestRow];

        // Limpiar encabezados: quitar vacíos, normalizar
        const headers = headerRow.map((h, i) => {
          const clean = String(h || '').trim().replace(/\s+/g, '_');
          return clean || `COL_${i + 1}`;
        });

        // Construir filas de datos desde la fila siguiente al encabezado
        const dataRows = rawRows.slice(bestRow + 1).filter(row =>
          row.some(cell => String(cell || '').trim() !== '')
        );

        const rows = dataRows.map(row => {
          const obj = {};
          headers.forEach((h, i) => { obj[h] = row[i] !== undefined ? row[i] : ''; });
          return obj;
        });

        if (!rows.length) throw new Error('No se encontraron datos después del encabezado');

        // Filtrar encabezados vacíos del resultado
        const validHeaders = headers.filter(h => !h.startsWith('COL_') || rows.some(r => r[h]));

        console.log(`[Excel] Encabezado detectado en fila ${bestRow + 1} (score: ${bestScore}):`, validHeaders);
        resolve({ headers: validHeaders, rows });
      } catch(err) { reject(err); }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

async function leerSQLite(file) {
  // Leer SQLite vía IPC (el main process puede acceder a better-sqlite3)
  const arrayBuffer = await file.arrayBuffer();
  const uint8       = new Uint8Array(arrayBuffer);
  const result      = await window.api.importar.readSQLite({ data: Array.from(uint8) });
  if (!result.ok) throw new Error(result.error);
  return result.data; // { headers, rows, tables }
}

async function leerPDF(file) {
  const arrayBuffer = await file.arrayBuffer();
  const uint8       = new Uint8Array(arrayBuffer);
  const result      = await window.api.importar.readPDF({ data: Array.from(uint8) });
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

// ══════════════════════════════════════════════
// ANÁLISIS CON IA (Claude API)
// ══════════════════════════════════════════════
async function analizarArchivoConIA() {
  const btn = document.getElementById('imp-btn-analizar');
  if (btn) { btn.disabled = true; btn.innerHTML = '⏳ Analizando...'; }

  try {
    // 1. Leer el archivo
    const { headers, rows } = await leerArchivo(importState.file);
    importState.headers = headers;
    importState.rawData = rows;

    // 2. Tomar muestra de las primeras 5 filas para enviar a Claude
    const muestra = rows.slice(0, 5);
    const tipo    = importState.tipo;
    const campos  = (tipo === 'productos' ? VELO_FIELDS_PRODUCTS : VELO_FIELDS_CLIENTS)
                    .map(f => `${f.key} (${f.label}${f.required ? ', requerido' : ''})`).join(', ');

    // 3. Llamar a Claude API via IPC (main process tiene acceso a la red)
    const aiResult = await window.api.importar.analyzeWithAI({
      headers,
      rows: muestra,
      tipo,
    });

    if (!aiResult.ok) throw new Error(aiResult.error || 'Error al analizar con IA');

    const parsed = aiResult.data;
    importState.mapping     = parsed.mapping    || {};
    importState._confidence = parsed.confidence || 1;

    // 4. Mostrar pantalla de confirmación
    mostrarConfirmacionMapeo(parsed.notas);

  } catch (err) {
    toast(`Error al analizar: ${err.message}`, 'err');
    if (btn) { btn.disabled = false; btn.innerHTML = '✨ Analizar con IA'; }
  }
}

// ══════════════════════════════════════════════
// PANTALLA DE CONFIRMACIÓN DEL MAPEO
// ══════════════════════════════════════════════
function mostrarConfirmacionMapeo(notas) {
  const tipo   = importState.tipo;
  const fields = tipo === 'productos' ? VELO_FIELDS_PRODUCTS : VELO_FIELDS_CLIENTS;
  const hdrs   = importState.headers;
  const total  = importState.rawData.length;
  const preview= importState.rawData.slice(0, 3);

  const mappingRows = fields.map(f => {
    const mapped = importState.mapping[f.key] || '';
    const opts   = hdrs.map(h => `<option value="${h}" ${h === mapped ? 'selected' : ''}>${h}</option>`).join('');
    return `
      <tr>
        <td style="font-size:12px">
          <b>${f.label}</b>
          ${f.required ? '<span style="color:var(--red)">*</span>' : ''}
        </td>
        <td>
          <select class="inp" style="font-size:12px;padding:4px 8px"
                  id="map-${f.key}" onchange="updateMapping('${f.key}',this.value)">
            <option value="">— No importar —</option>
            ${opts}
          </select>
        </td>
        <td style="font-size:11px;color:var(--muted2)">
          ${mapped && preview[0] ? (preview[0][mapped] || '—') : '—'}
        </td>
      </tr>`;
  }).join('');

  openModal(`
    <div class="modal-title">✨ Mapeo detectado por IA</div>
    <div class="modal-sub" style="margin-bottom:12px">${notas || 'Revisa y ajusta si es necesario'}</div>
    ${importState._confidence < 0.7 ? `
    <div style="background:rgba(245,158,11,.1);border:1px solid var(--amber,#f59e0b);border-radius:8px;
                padding:10px 14px;font-size:12px;color:var(--amber,#f59e0b);margin-bottom:12px">
      ⚠ Confianza del mapeo: ${Math.round((importState._confidence||0)*100)}% — Revisa cuidadosamente antes de importar
    </div>` : ''}

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px">
      <div style="background:var(--surface2);border-radius:var(--r-sm);padding:10px;font-size:12px">
        <div style="font-weight:600;margin-bottom:3px">📊 Archivo</div>
        <div>${importState.file?.name}</div>
        <div style="color:var(--muted2)">${total.toLocaleString()} registros · ${hdrs.length} columnas</div>
      </div>
      <div style="background:var(--surface2);border-radius:var(--r-sm);padding:10px;font-size:12px">
        <div style="font-weight:600;margin-bottom:3px">🎯 Importando</div>
        <div>${tipo === 'productos' ? 'Productos' : 'Clientes'}</div>
        <div style="color:var(--muted2)">Ajusta el mapeo si algo está incorrecto</div>
      </div>
    </div>

    <table class="tbl" style="margin-bottom:12px">
      <thead><tr><th>Campo Velo POS</th><th>Columna del archivo</th><th>Ejemplo</th></tr></thead>
      <tbody>${mappingRows}</tbody>
    </table>

    <div class="modal-foot">
      <button class="btn btn-out" onclick="wizardStepImportar()">← Volver</button>
      <button class="btn btn-dark" onclick="ejecutarImportacion()">
        ⬆ Importar ${total.toLocaleString()} registros
      </button>
    </div>
  `, 'modal-xl');
}

function updateMapping(field, value) {
  if (value) {
    importState.mapping[field] = value;
  } else {
    delete importState.mapping[field];
  }
}

// ══════════════════════════════════════════════
// IMPORTACIÓN CON BARRA DE PROGRESO
// ══════════════════════════════════════════════
async function ejecutarImportacion() {
  const tipo    = importState.tipo;
  const mapping = importState.mapping;
  const rows    = importState.rawData;

  // Validar campos requeridos
  const fields  = tipo === 'productos' ? VELO_FIELDS_PRODUCTS : VELO_FIELDS_CLIENTS;
  const missing = fields.filter(f => f.required && !mapping[f.key]);
  if (missing.length) {
    toast(`Falta mapear: ${missing.map(f => f.label).join(', ')}`, 'err');
    return;
  }

  // Pantalla de progreso
  openModal(`
    <div style="text-align:center;padding:20px">
      <div style="font-size:32px;margin-bottom:12px">⏳</div>
      <div class="modal-title">Importando datos...</div>
      <div class="modal-sub" id="imp-prog-sub">Preparando...</div>
      <div style="background:var(--line);border-radius:6px;height:8px;margin:16px 0">
        <div id="imp-prog-bar" style="background:var(--green);height:8px;border-radius:6px;width:0%;transition:.2s"></div>
      </div>
      <div id="imp-prog-count" style="font-size:13px;color:var(--muted2)">0 / ${rows.length}</div>
    </div>
  `, 'modal-lg');

  const errores  = [];
  let importados = 0;

  // Generar código único para productos sin código
  let codeCounter = Date.now();
  const genCode   = () => `IMP-${++codeCounter}`;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    // Actualizar progreso cada 10 registros
    if (i % 10 === 0) {
      const pct = Math.round((i / rows.length) * 100);
      document.getElementById('imp-prog-bar') &&
        (document.getElementById('imp-prog-bar').style.width = pct + '%');
      document.getElementById('imp-prog-sub') &&
        (document.getElementById('imp-prog-sub').textContent = `Procesando fila ${i + 1}...`);
      document.getElementById('imp-prog-count') &&
        (document.getElementById('imp-prog-count').textContent = `${i} / ${rows.length}`);
      await new Promise(r => setTimeout(r, 0)); // ceder al render
    }

    try {
      if (tipo === 'productos') {
        let name    = String(row[mapping.name] || '').trim();
        const price = parseFloat(String(row[mapping.price] || '0').replace(/[^0-9.,-]/g,'').replace(',','.')) || 0;

        // Si no hay nombre, generar uno provisional para no perder el registro
        if (!name) {
          name = `Producto sin nombre (fila ${i+2})`;
          errores.push({ fila: i+2, nombre: name, campo: 'nombre', error: 'Sin nombre — importado con nombre provisional', tipo: 'ajuste' });
        }

        // Limpiar precio — acepta enteros, decimales, con comas o puntos
        const cleanNum = (v) => {
          if (!v && v !== 0) return 0;
          const s = String(v).replace(/[^0-9.,]/g, '');
          // Si tiene coma como separador decimal (ej: 1.500,75 → 1500.75)
          if (s.includes(',') && s.includes('.')) {
            return parseFloat(s.replace(/\./g,'').replace(',','.')) || 0;
          }
          // Si solo tiene coma (ej: 1500,75 → 1500.75)
          if (s.includes(',')) return parseFloat(s.replace(',','.')) || 0;
          return parseFloat(s) || 0;
        };

        const cleanInt = (v) => Math.round(Math.abs(cleanNum(v)));

        const ajustes = []; // avisos de campos que se importaron con valor por defecto
        if (price <= 0) ajustes.push('precio pendiente de ajuste');

        const data = {
          name,
          code:      mapping.code      ? (String(row[mapping.code]||'').trim() || genCode()) : genCode(),
          barcode:   mapping.barcode   ? String(row[mapping.barcode]||'').trim() : '',
          price:     price > 0 ? price : 0,       // importar aunque sea 0
          cost:      mapping.cost      ? cleanNum(row[mapping.cost])      : 0,
          wholesale: mapping.wholesale ? cleanNum(row[mapping.wholesale])  : (price > 0 ? price : 0),
          stock:     mapping.stock     ? cleanInt(row[mapping.stock])     : 0,
          stock_min: mapping.stock_min ? cleanInt(row[mapping.stock_min]) : 0,
          category:  mapping.category  ? String(row[mapping.category]||'').trim() : '',
          brand:     mapping.brand     ? String(row[mapping.brand]||'').trim()    : '',
          unit:      mapping.unit      ? String(row[mapping.unit]||'').trim()     : 'und',
          description: mapping.description ? String(row[mapping.description]||'').trim() : '',
        };

        let result = await window.api.products.create({ data, requestUserId: user.id });
        // Si falla, intentar con datos mínimos (solo nombre y precio 0)
        if (!result.ok) {
          const dataMinima = { name, code: genCode(), price: 0, cost: 0, wholesale: 0,
            stock: 0, stock_min: 0, barcode: '', category: '', brand: '', unit: 'und', description: '' };
          result = await window.api.products.create({ data: dataMinima, requestUserId: user.id });
          if (result.ok) {
            importados++;
            errores.push({ fila: i+2, nombre: name, campo: 'datos', error: 'Importado con datos mínimos — revisar precio, código y categoría', tipo: 'ajuste' });
          } else {
            // Último recurso: registrar como ajuste de todas formas (no bloquear)
            errores.push({ fila: i+2, nombre: name, campo: 'sistema', error: result.error + ' — revisar manualmente', tipo: 'ajuste' });
          }
        } else {
          importados++;
          if (ajustes.length) errores.push({ fila: i+2, nombre: name, campo: 'precio', error: `Importado con ${ajustes.join(', ')}`, tipo: 'ajuste' });
        }

      } else {
        // Clientes
        // Intentar extraer nombre de cualquier columna disponible
        let name = mapping.name ? String(row[mapping.name] || '').trim() : '';
        if (!name) {
          // Buscar en todas las columnas alguna que parezca un nombre
          for (const col of Object.keys(row)) {
            const v = String(row[col] || '').trim();
            if (v.length > 3 && v.length < 80 && /[A-Za-záéíóúñÑÁÉÍÓÚ]/.test(v) && !/^\d+$/.test(v)) {
              name = v;
              break;
            }
          }
        }
        // Si no hay nombre reconocible, generar nombre provisional
        if (!name) {
          name = `Cliente sin nombre (fila ${i+2})`;
          errores.push({ fila: i+2, nombre: name, campo: 'nombre', error: 'Sin nombre reconocible — importado con nombre provisional', tipo: 'ajuste' });
        }

        // Limpiar nombre (quitar caracteres no imprimibles)
        name = name.replace(/[^ -~áéíóúñÁÉÍÓÚÑüÜ]/g, ' ').replace(/\s+/g,' ').trim();

        const ajustesC = [];
        const phone = mapping.phone ? String(row[mapping.phone]||'').trim() : '';
        const email = mapping.email ? String(row[mapping.email]||'').trim() : '';
        const rnc   = mapping.rnc   ? String(row[mapping.rnc]||'').trim()   : '';

        if (!phone && !email && !rnc) ajustesC.push('sin teléfono/email/RNC');

        const data = {
          name,
          phone,
          email,
          rnc,
          address:      mapping.address      ? String(row[mapping.address]||'').trim()      : '',
          credit_limit: mapping.credit_limit ? parseFloat(String(row[mapping.credit_limit]||'0').replace(/[^0-9.]/g,'')) || 0 : 0,
          credit_days:  30,
        };

        let result = await window.api.customers.create({ data, requestUserId: user.id });
        // Si falla, intentar solo con nombre
        if (!result.ok) {
          const dataMinima = { name, phone: '', email: '', rnc: '', address: '', credit_limit: 0, credit_days: 30 };
          result = await window.api.customers.create({ data: dataMinima, requestUserId: user.id });
          if (result.ok) {
            importados++;
            errores.push({ fila: i+2, nombre: name, campo: 'datos', error: 'Importado solo con nombre — completar teléfono, email y RNC', tipo: 'ajuste' });
          } else {
            errores.push({ fila: i+2, nombre: name, campo: 'sistema', error: result.error + ' — revisar manualmente', tipo: 'ajuste' });
          }
        } else {
          importados++;
          if (ajustesC.length) errores.push({ fila: i+2, nombre: name, campo: 'contacto', error: `Importado — ${ajustesC.join(', ')}`, tipo: 'ajuste' });
        }
      }
    } catch(e) {
      errores.push({ fila: i+2, error: e.message });
    }
  }

  // Recargar datos
  await reloadProducts();
  await reloadCustomers();

  // Pantalla de resultado
  mostrarResultadoImportacion(importados, errores, rows.length);
}

// ══════════════════════════════════════════════
// RESULTADO FINAL
// ══════════════════════════════════════════════
function mostrarResultadoImportacion(importados, errores, total) {
  const exitosos = importados;
  // Separar errores reales de ajustes pendientes
  const soloAjustes = errores.filter(e => e.tipo === 'ajuste');
  const soloErrores = errores.filter(e => e.tipo !== 'ajuste');
  const fallidos    = soloErrores.length;
  const color    = fallidos === 0 ? 'green' : fallidos < total * 0.1 ? 'var(--amber)' : 'var(--red)';

  // Guardar en estado para el PDF
  importState._lastResult = { importados, errores, total, tipo: importState.tipo,
    archivo: importState.file?.name || 'archivo', fecha: new Date().toLocaleString('es-DO') };

  const ajustesHtml = soloAjustes.slice(0,20).map(e =>
    `<tr style="background:#fffbeb">
      <td style="color:var(--muted2);font-size:11px;padding:4px 6px">Fila ${e.fila}</td>
      <td style="font-size:11px;padding:4px 6px;font-weight:500">${e.nombre||''}</td>
      <td style="color:#92400e;font-size:11px;padding:4px 6px">${e.error}</td>
    </tr>`).join('');

  const errHtml = soloErrores.slice(0,10).map(e =>
    `<tr style="background:#fef2f2">
      <td style="color:var(--muted2);font-size:11px;padding:4px 6px">Fila ${e.fila}</td>
      <td style="font-size:11px;padding:4px 6px;font-weight:500">${e.nombre||''}</td>
      <td style="color:var(--red);font-size:11px;padding:4px 6px">${e.error}</td>
    </tr>`).join('');

  openModal(`
    <div style="text-align:center;margin-bottom:16px">
      <div style="font-size:40px;margin-bottom:8px">${fallidos === 0 ? '🎉' : soloAjustes.length > 0 ? '✅' : '⚠️'}</div>
      <div class="modal-title">Importación completada</div>
      <div class="modal-sub">${importState.file?.name}</div>
    </div>

    <div style="display:grid;grid-template-columns:repeat(${soloAjustes.length>0?'4':'3'},1fr);gap:8px;margin-bottom:16px">
      <div style="text-align:center;background:var(--surface2);border-radius:var(--r-md);padding:12px">
        <div style="font-size:24px;font-weight:700;color:var(--green)">${exitosos.toLocaleString()}</div>
        <div style="font-size:11px;color:var(--muted2)">Importados</div>
      </div>
      ${soloAjustes.length > 0 ? `
      <div style="text-align:center;background:#fffbeb;border-radius:var(--r-md);padding:12px">
        <div style="font-size:24px;font-weight:700;color:#92400e">${soloAjustes.length.toLocaleString()}</div>
        <div style="font-size:11px;color:#92400e">Ajustar precio</div>
      </div>` : ''}
      <div style="text-align:center;background:var(--surface2);border-radius:var(--r-md);padding:12px">
        <div style="font-size:24px;font-weight:700;color:${color}">${fallidos.toLocaleString()}</div>
        <div style="font-size:11px;color:var(--muted2)">Con errores</div>
      </div>
      <div style="text-align:center;background:var(--surface2);border-radius:var(--r-md);padding:12px">
        <div style="font-size:24px;font-weight:700">${total.toLocaleString()}</div>
        <div style="font-size:11px;color:var(--muted2)">Total filas</div>
      </div>
    </div>

    ${soloAjustes.length > 0 ? `
      <div style="margin-bottom:10px">
        <div style="font-weight:600;font-size:12px;color:#92400e;margin-bottom:6px">
          ⚡ ${soloAjustes.length} importados — ajustar precio u otros datos:
        </div>
        <table class="tbl" style="font-size:11px">
          <thead><tr><th>Fila</th><th>Nombre</th><th>Pendiente</th></tr></thead>
          <tbody>${ajustesHtml}</tbody>
        </table>
        ${soloAjustes.length > 20 ? `<div style="font-size:11px;color:var(--muted2);margin-top:4px">
          ...y ${soloAjustes.length-20} más — ver reporte PDF completo</div>` : ''}
      </div>` : ''}

    ${soloErrores.length > 0 ? `
      <div style="margin-bottom:10px">
        <div style="font-weight:600;font-size:12px;color:var(--red);margin-bottom:6px">
          ⚠ ${soloErrores.length} registros que necesitan revisión manual:
        </div>
        <table class="tbl" style="font-size:11px">
          <thead><tr><th>Fila</th><th>Nombre</th><th>Error</th></tr></thead>
          <tbody>${errHtml}</tbody>
        </table>
        ${soloErrores.length > 10 ? `<div style="font-size:11px;color:var(--muted2);margin-top:4px">
          ...y ${soloErrores.length-10} más — descarga el reporte PDF para verlos todos</div>` : ''}
      </div>` : ''}

    <div class="modal-foot">
      <button class="btn btn-out" onclick="wizardStepImportar()">
        Importar otro archivo
      </button>
      <button class="btn btn-out" onclick="importarDescargarPDF()" style="color:var(--blue);border-color:var(--blue)">
        ${svg('download')} Reporte PDF
      </button>
      <button class="btn btn-dark" onclick="wizardStep=4;renderWizardStep()">
        ${svg('check')} Continuar
      </button>
    </div>
  `, 'modal-xl');
}

// ── Generar y descargar PDF del resultado ─────
async function importarDescargarPDF() {
  const r = importState._lastResult;
  if (!r) { toast('Sin resultado de importación para exportar', 'err'); return; }

  const fecha    = r.fecha;
  const archivo  = r.archivo;
  const tipo     = r.tipo === 'productos' ? 'Productos' : 'Clientes';
  const ok       = r.importados;
  const fail     = r.errores.length;
  const total    = r.total;
  const pct      = total > 0 ? Math.round((ok / total) * 100) : 0;

  // Separar ajustes de errores reales para el PDF
  const pdfAjustes = (r.errores||[]).filter(e => e.tipo === 'ajuste');
  const pdfErrores = (r.errores||[]).filter(e => e.tipo !== 'ajuste');

  const ajusteRows = pdfAjustes.map((e, i) => `
    <tr style="background:${i%2===0?'#fffbeb':'#fef9c3'}">
      <td style="padding:6px 10px;color:#6b7280;font-size:11px;border-bottom:1px solid #fde68a">Fila ${e.fila}</td>
      <td style="padding:6px 10px;color:#374151;font-size:11px;border-bottom:1px solid #fde68a;font-weight:500">${e.nombre || ''}</td>
      <td style="padding:6px 10px;color:#92400e;font-size:11px;border-bottom:1px solid #fde68a">${e.error || ''}</td>
      <td style="padding:6px 10px;color:#6b7280;font-size:11px;border-bottom:1px solid #fde68a">${e.campo || ''}</td>
    </tr>`).join('');

  const errRows = pdfErrores.map((e, i) => `
    <tr style="background:${i%2===0?'#fef2f2':'#fee2e2'}">
      <td style="padding:6px 10px;color:#6b7280;font-size:11px;border-bottom:1px solid #fecaca">Fila ${e.fila}</td>
      <td style="padding:6px 10px;color:#374151;font-size:11px;border-bottom:1px solid #fecaca;font-weight:500">${e.nombre || ''}</td>
      <td style="padding:6px 10px;color:#dc2626;font-size:11px;border-bottom:1px solid #fecaca">${e.error || 'Error desconocido'}</td>
      <td style="padding:6px 10px;color:#6b7280;font-size:11px;border-bottom:1px solid #fecaca">${e.campo || ''}</td>
    </tr>`).join('');

  const html = `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8">
<title>Reporte Importación — ${archivo}</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:Arial,sans-serif; font-size:13px; color:#111; padding:32px; }
  .header { border-bottom:3px solid #16A34A; padding-bottom:16px; margin-bottom:20px; }
  .logo { font-size:20px; font-weight:800; color:#16A34A; margin-bottom:4px; }
  .doc-title { font-size:15px; font-weight:700; color:#111; }
  .doc-sub { font-size:11px; color:#6b7280; margin-top:2px; }
  .metrics { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; margin-bottom:20px; }
  .ajuste-box { background:#fffbeb; border:1px solid #fde68a; border-radius:8px; padding:14px; margin-bottom:20px; }
  .error-box  { background:#fef2f2; border:1px solid #fecaca; border-radius:8px; padding:14px; margin-bottom:20px; }
  .box-title  { font-weight:700; font-size:13px; margin-bottom:8px; }
  .metric { background:#f9fafb; border:1px solid #e5e7eb; border-radius:8px; padding:12px; text-align:center; }
  .metric-val { font-size:26px; font-weight:800; }
  .metric-lbl { font-size:10px; color:#6b7280; margin-top:2px; text-transform:uppercase; letter-spacing:.05em; }
  .section-title { font-size:13px; font-weight:700; margin-bottom:10px; color:#111; }
  table { width:100%; border-collapse:collapse; }
  th { background:#f3f4f6; padding:8px 10px; text-align:left; font-size:11px; font-weight:700;
       text-transform:uppercase; letter-spacing:.05em; color:#6b7280; border-bottom:2px solid #e5e7eb; }
  .success-box { background:#f0fdf4; border:1px solid #bbf7d0; border-radius:8px;
                 padding:14px; margin-bottom:20px; color:#166534; font-size:12px; }
  .footer { margin-top:28px; padding-top:12px; border-top:1px solid #e5e7eb;
            font-size:10px; color:#9ca3af; text-align:center; }
  @media print { body { padding:16px; } }
</style>
</head><body>

<div class="header">
  <div class="logo">Velo POS</div>
  <div class="doc-title">Reporte de Importación — ${tipo}</div>
  <div class="doc-sub">Archivo: ${archivo} &nbsp;·&nbsp; Fecha: ${fecha} &nbsp;·&nbsp; ${CFG.biz || 'Velo POS'}</div>
</div>

<div class="metrics">
  <div class="metric">
    <div class="metric-val" style="color:#16A34A">${ok.toLocaleString()}</div>
    <div class="metric-lbl">Importados</div>
  </div>
  <div class="metric" style="${pdfAjustes.length>0?'background:#fffbeb;border-color:#fde68a':''}">
    <div class="metric-val" style="color:${pdfAjustes.length>0?'#92400e':'#16A34A'}">${pdfAjustes.length.toLocaleString()}</div>
    <div class="metric-lbl">Ajustar precio</div>
  </div>
  <div class="metric" style="${pdfErrores.length>0?'background:#fef2f2;border-color:#fecaca':''}">
    <div class="metric-val" style="color:${pdfErrores.length>0?'#DC2626':'#16A34A'}">${pdfErrores.length.toLocaleString()}</div>
    <div class="metric-lbl">No importados</div>
  </div>
  <div class="metric">
    <div class="metric-val">${total.toLocaleString()}</div>
    <div class="metric-lbl">Total filas</div>
  </div>
  <div class="metric">
    <div class="metric-val" style="color:${pct===100?'#16A34A':pct>=90?'#D97706':'#DC2626'}">${pct}%</div>
    <div class="metric-lbl">Éxito</div>
  </div>
</div>

${pdfAjustes.length === 0 && pdfErrores.length === 0 ? `
<div class="success-box">
  ✓ Importación perfecta — todos los registros se importaron sin errores.
</div>` : ''}

${pdfAjustes.length > 0 ? `
<div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:14px;margin-bottom:20px">
  <div style="font-weight:700;font-size:13px;color:#92400e;margin-bottom:6px">⚡ ${pdfAjustes.length} importados — Requieren completar datos</div>
  <p style="font-size:11px;color:#78350f;margin-bottom:10px">
    Estos registros se guardaron en el sistema. Ve a Inventario o Clientes en Velo POS para completar los campos faltantes.
  </p>
  <table>
    <thead><tr><th style="width:60px">Fila</th><th>Nombre</th><th>Pendiente</th><th>Campo</th></tr></thead>
    <tbody>${ajusteRows}</tbody>
  </table>
</div>` : ''}

${pdfErrores.length > 0 ? `
<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:14px;margin-bottom:20px">
  <div style="font-weight:700;font-size:13px;color:#dc2626;margin-bottom:6px">⚠ ${pdfErrores.length} registros — revisar manualmente</div>
  <p style="font-size:11px;color:#991b1b;margin-bottom:10px">
    Estos registros se importaron con datos mínimos. Búscalos en el sistema y completa su información.
  </p>
  <table>
    <thead><tr><th style="width:60px">Fila</th><th>Nombre</th><th>Error</th><th>Campo</th></tr></thead>
    <tbody>${errRows}</tbody>
  </table>
</div>` : ''}

<div class="footer">
  ${CFG.biz || 'Velo POS'} · Generado el ${fecha} · velo-pos v${window._appVersion || ''}
</div>

<script>window.onload=()=>window.print()<\/script>
</body></html>`;

  // Abrir en ventana nueva para imprimir/guardar
  const win = window.open('', '_blank', 'width=900,height=700,scrollbars=yes');
  if (!win) { toast('Activa las ventanas emergentes para descargar el PDF', 'w'); return; }
  win.document.open();
  win.document.write(html);
  win.document.close();
  toast('✓ Reporte abierto — usa Ctrl+P / Cmd+P para guardar como PDF', 'ok');
}

// ══════════════════════════════════════════════
// IMPORTACIÓN DESDE CONFIGURACIÓN (cualquier momento)
// ══════════════════════════════════════════════
function abrirImportarDesdeConfig() {
  importState = { file: null, rawData: [], headers: [], mapping: {}, tipo: 'productos', importando: false };
  wizardStepImportar();
  // Quitar el botón de "Omitir" cuando se accede desde configuración
  setTimeout(() => {
    const omitirBtn = document.querySelector('.modal-foot .btn-out');
    if (omitirBtn && omitirBtn.textContent.includes('Omitir')) {
      omitirBtn.style.display = 'none';
    }
  }, 100);
}
