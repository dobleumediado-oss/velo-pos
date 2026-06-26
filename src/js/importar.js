// ══════════════════════════════════════════════
// IMPORTACIÓN UNIVERSAL DE DATOS — Velo POS
// v2.0 — Migrador completo empresarial
// Soporta: xlsx, xls, ods, csv, tsv, txt, json,
//          db, sqlite, bak, sql, xml, zip, pdf
// 10 tipos de datos · IA mapeo · Rollback · Dedup
// ══════════════════════════════════════════════

// ── Estado ────────────────────────────────────
let importState = {
  file:        null,
  rawData:     [],
  headers:     [],
  mapping:     {},
  tipo:        'productos',
  importando:  false,
  _sessionIds: [], // IDs insertados — para rollback
};

// ── Utilidad limpieza numérica ────────────────
function _impCleanNum(v) {
  if (!v && v !== 0) return 0;
  const s = String(v).replace(/[^0-9.,]/g, '');
  if (s.includes(',') && s.includes('.')) return parseFloat(s.replace(/\./g,'').replace(',','.')) || 0;
  if (s.includes(',')) return parseFloat(s.replace(',','.')) || 0;
  return parseFloat(s) || 0;
}
function _impCleanInt(v) { return Math.round(Math.abs(_impCleanNum(v))); }

// ── Normalizar fecha a yyyy-mm-dd ─────────────
function _impNormDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  // yyyy-mm-dd ya OK
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0,10);
  // dd/mm/yyyy o dd-mm-yyyy
  const m1 = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (m1) return `${m1[3]}-${m1[2].padStart(2,'0')}-${m1[1].padStart(2,'0')}`;
  // mm/dd/yyyy
  const m2 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m2) {
    const y = m2[3].length === 2 ? '20'+m2[3] : m2[3];
    return `${y}-${m2[1].padStart(2,'0')}-${m2[2].padStart(2,'0')}`;
  }
  // Excel serial number
  const n = parseFloat(s);
  if (!isNaN(n) && n > 40000 && n < 60000) {
    const d = new Date((n - 25569) * 86400 * 1000);
    return d.toISOString().split('T')[0];
  }
  return null;
}

// ── Campos por tipo ────────────────────────────
const VELO_FIELDS = {
  productos: [
    { key: 'name',        label: 'Nombre',         required: true  },
    { key: 'code',        label: 'Código',          required: false },
    { key: 'barcode',     label: 'Código barras',   required: false },
    { key: 'price',       label: 'Precio venta',    required: true  },
    { key: 'cost',        label: 'Costo',           required: false },
    { key: 'wholesale',   label: 'Precio mayor',    required: false },
    { key: 'stock',       label: 'Stock',           required: false },
    { key: 'stock_min',   label: 'Stock mínimo',    required: false },
    { key: 'category',    label: 'Categoría',       required: false },
    { key: 'brand',       label: 'Marca',           required: false },
    { key: 'unit',        label: 'Unidad',          required: false },
    { key: 'description', label: 'Descripción',     required: false },
  ],
  clientes: [
    { key: 'name',         label: 'Nombre',                          required: true  },
    { key: 'phone',        label: 'Teléfono',                        required: false },
    { key: 'email',        label: 'Email',                           required: false },
    { key: 'rnc',          label: 'RNC/Cédula',                      required: false },
    { key: 'address',      label: 'Dirección',                       required: false },
    { key: 'credit_limit', label: 'Límite crédito',                  required: false },
    { key: 'balance',      label: 'Deuda actual',                    required: false },
    { key: 'credit_days',  label: 'Días de crédito',                 required: false },
    { key: 'credit_due',   label: 'Fecha vencimiento',               required: false },
    { key: 'status',       label: 'Estado (activo/bloqueado/moroso)', required: false },
  ],
  ventas: [
    { key: 'date',           label: 'Fecha',           required: true  },
    { key: 'customer_name',  label: 'Cliente',         required: false },
    { key: 'total',          label: 'Total',           required: true  },
    { key: 'payment_method', label: 'Método de pago',  required: false },
    { key: 'product_name',   label: 'Producto',        required: false },
    { key: 'qty',            label: 'Cantidad',        required: false },
    { key: 'unit_price',     label: 'Precio unitario', required: false },
    { key: 'subtotal',       label: 'Subtotal',        required: false },
    { key: 'tax_amt',        label: 'ITBIS',           required: false },
    { key: 'discount_pct',   label: 'Descuento %',     required: false },
    { key: 'ncf',            label: 'NCF',             required: false },
    { key: 'cajero',         label: 'Cajero',          required: false },
    { key: 'type',           label: 'Tipo doc.',       required: false },
  ],
  cuentas_cobrar: [
    { key: 'customer_name', label: 'Nombre del cliente',             required: true  },
    { key: 'balance',       label: 'Deuda pendiente',                required: true  },
    { key: 'credit_limit',  label: 'Límite de crédito',              required: false },
    { key: 'credit_due',    label: 'Fecha vencimiento',              required: false },
    { key: 'credit_days',   label: 'Días de crédito',                required: false },
    { key: 'status',        label: 'Estado (activo/bloqueado/moroso)',required: false },
    { key: 'phone',         label: 'Teléfono',                       required: false },
    { key: 'rnc',           label: 'RNC/Cédula',                     required: false },
  ],
  proveedores: [
    { key: 'name',    label: 'Nombre',    required: true  },
    { key: 'contact', label: 'Contacto', required: false },
    { key: 'phone',   label: 'Teléfono', required: false },
    { key: 'email',   label: 'Email',    required: false },
    { key: 'rnc',     label: 'RNC',      required: false },
    { key: 'address', label: 'Dirección',required: false },
    { key: 'notes',   label: 'Notas',    required: false },
  ],
  compras: [
    { key: 'supplier_name', label: 'Proveedor',       required: true  },
    { key: 'product_name',  label: 'Producto',        required: true  },
    { key: 'unit_cost',     label: 'Costo unitario',  required: true  },
    { key: 'qty',           label: 'Cantidad',        required: true  },
    { key: 'date',          label: 'Fecha',           required: false },
    { key: 'notes',         label: 'Notas',           required: false },
  ],
  gastos: [
    { key: 'description',    label: 'Descripción',      required: true  },
    { key: 'total',          label: 'Monto',            required: true  },
    { key: 'date',           label: 'Fecha',            required: false },
    { key: 'category',       label: 'Categoría',        required: false },
    { key: 'payment_method', label: 'Método de pago',   required: false },
    { key: 'supplier_name',  label: 'Proveedor',        required: false },
    { key: 'notes',          label: 'Notas',            required: false },
    { key: 'status',         label: 'Estado',           required: false },
  ],
  abonos: [
    { key: 'customer_name',  label: 'Cliente',          required: true  },
    { key: 'amount',         label: 'Monto del abono',  required: true  },
    { key: 'date',           label: 'Fecha',            required: true  },
    { key: 'invoice_ref',    label: 'N° Factura',       required: false },
    { key: 'payment_method', label: 'Método de pago',   required: false },
    { key: 'notes',          label: 'Nota / Concepto',  required: false },
  ],
  // ── Facturas a crédito con detalle de artículos ──
  // Una fila por artículo. Varias filas con el mismo
  // cliente + referencia de factura = una sola venta.
  facturas_credito: [
    { key: 'customer_name',  label: 'Cliente',               required: true  },
    { key: 'invoice_ref',    label: 'N° / Referencia factura',required: false },
    { key: 'date',           label: 'Fecha factura',          required: false },
    { key: 'product_name',   label: 'Artículo / Producto',    required: true  },
    { key: 'qty',            label: 'Cantidad',               required: false },
    { key: 'unit_price',     label: 'Precio unitario',        required: true  },
    { key: 'total',          label: 'Total / Balance factura (total_factura)', required: false },
    { key: 'phone',          label: 'Teléfono cliente',       required: false },
    { key: 'rnc',            label: 'RNC / Cédula cliente',   required: false },
    { key: 'credit_days',    label: 'Días de crédito',        required: false },
  ],
};

// ── Etiquetas legibles por tipo ────────────────
const TIPO_LABELS = {
  productos:        'Productos',
  clientes:         'Clientes',
  ventas:           'Historial de Ventas',
  cuentas_cobrar:   'Cuentas por Cobrar',
  proveedores:      'Proveedores',
  compras:          'Compras / Entradas',
  gastos:           'Gastos',
  facturas_credito: 'Facturas a Crédito (con detalle)',
  abonos:           'Abonos a Clientes',
};

// ══════════════════════════════════════════════
// WIZARD STEP — Pantalla principal del importador
// ══════════════════════════════════════════════
function wizardStepImportar() {
  openModal(`
    <div style="text-align:center;margin-bottom:16px">
      <div style="font-size:32px;margin-bottom:6px">📂</div>
      <div class="modal-title">Migrador Universal — Velo POS</div>
      <div class="modal-sub">Importa desde cualquier sistema · IA detecta columnas automáticamente</div>
    </div>

    <div style="display:flex;gap:6px;margin-bottom:16px;justify-content:center">
      ${[1,2,3,4].map((i,idx) => `
        <div style="width:28px;height:5px;border-radius:3px;
             background:${idx < 3 ? 'var(--green)' : 'var(--line)'}"></div>
      `).join('')}
    </div>

    <div style="margin-bottom:10px">
      <div style="font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">¿Qué deseas importar?</div>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:8px">
        ${[
          { id:'productos',      icon:'📦', label:'Productos',         sub:'Inventario y precios' },
          { id:'clientes',       icon:'👥', label:'Clientes',          sub:'Contactos y crédito' },
          { id:'ventas',         icon:'📊', label:'Historial Ventas',  sub:'Migrar ventas pasadas' },
          { id:'cuentas_cobrar', icon:'💳', label:'Cuentas x Cobrar', sub:'Deudas activas' },
        ].map(t => `
          <div class="card" style="text-align:center;cursor:pointer;border:2px solid var(--line);padding:12px"
               id="imp-tipo-${t.id}" onclick="setImportTipo('${t.id}')">
            <div style="font-size:22px;margin-bottom:4px">${t.icon}</div>
            <div style="font-weight:600;font-size:12px">${t.label}</div>
            <div style="font-size:10px;color:var(--muted2)">${t.sub}</div>
          </div>`).join('')}
      </div>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px">
        ${[
          { id:'proveedores',       icon:'🏭', label:'Proveedores',          sub:'Catálogo de suplidores' },
          { id:'compras',           icon:'📥', label:'Compras',              sub:'Historial de compras' },
          { id:'gastos',            icon:'💸', label:'Gastos',               sub:'Egresos históricos' },
          { id:'facturas_credito',  icon:'🧾', label:'Facturas a Crédito',   sub:'Con artículos y fechas' },
          { id:'abonos',            icon:'💰', label:'Abonos a Clientes',    sub:'Pagos a cuentas por cobrar' },
        ].map(t => `
          <div class="card" style="text-align:center;cursor:pointer;border:2px solid var(--line);padding:12px"
               id="imp-tipo-${t.id}" onclick="setImportTipo('${t.id}')">
            <div style="font-size:22px;margin-bottom:4px">${t.icon}</div>
            <div style="font-weight:600;font-size:12px">${t.label}</div>
            <div style="font-size:10px;color:var(--muted2)">${t.sub}</div>
          </div>`).join('')}
      </div>
    </div>

    <div style="border:2px dashed var(--line);border-radius:var(--r-md);padding:18px;
         text-align:center;cursor:pointer;margin-bottom:10px"
         onclick="document.getElementById('imp-file-input').click()"
         id="imp-drop-zone">
      <div style="font-size:24px;margin-bottom:4px">⬆</div>
      <div style="font-weight:500;font-size:13px;margin-bottom:3px">
        Arrastra tu archivo o haz clic para seleccionar
      </div>
      <div style="font-size:10px;color:var(--muted2)">
        Excel (.xlsx .xls .ods) · CSV / TSV · JSON · XML · SQLite (.db .sqlite .bak) · SQL · ZIP · PDF · TXT
      </div>
      <input type="file" id="imp-file-input" style="display:none"
             accept=".xlsx,.xls,.ods,.csv,.tsv,.json,.xml,.db,.sqlite,.bak,.sql,.zip,.pdf,.txt"
             onchange="onImportFileSelected(this)"/>
    </div>

    <div style="display:flex;gap:8px;margin-bottom:10px;align-items:center;flex-wrap:wrap">
      <label style="font-size:12px;color:var(--muted);cursor:pointer;display:flex;align-items:center;gap:4px">
        <input type="checkbox" id="imp-check-dedup" checked style="cursor:pointer"/>
        Detectar duplicados
      </label>
      <label style="font-size:12px;color:var(--muted);cursor:pointer;display:flex;align-items:center;gap:4px">
        <input type="checkbox" id="imp-check-preview" checked style="cursor:pointer"/>
        Vista previa antes de importar
      </label>
      <label style="font-size:12px;color:var(--muted);cursor:pointer;display:flex;align-items:center;gap:4px">
        <input type="checkbox" id="imp-check-rollback" checked style="cursor:pointer"/>
        Permitir deshacer
      </label>
    </div>

    <div id="imp-file-info" style="display:none;margin-bottom:10px"></div>

    <div class="modal-foot">
      <button class="btn btn-out" onclick="wizardStep=4;renderWizardStep()">
        Omitir — empezar desde cero
      </button>
      <button class="btn btn-out" id="imp-btn-manual"
              onclick="abrirMapeoManual()" disabled style="opacity:.4">
        🗂 Mapeo Manual
      </button>
      <button class="btn btn-dark" id="imp-btn-analizar"
              onclick="analizarArchivoConIA()" disabled style="opacity:.4">
        ✨ Analizar con IA
      </button>
    </div>
  `, 'modal-xl');

  setTimeout(() => {
    const zone = document.getElementById('imp-drop-zone');
    if (zone) {
      zone.addEventListener('dragover', e => { e.preventDefault(); zone.style.borderColor = 'var(--green)'; });
      zone.addEventListener('dragleave', () => { zone.style.borderColor = 'var(--line)'; });
      zone.addEventListener('drop', e => {
        e.preventDefault();
        zone.style.borderColor = 'var(--line)';
        const file = e.dataTransfer.files[0];
        if (file) procesarArchivoSeleccionado(file);
      });
    }
    setImportTipo('productos');
  }, 50);
}

function setImportTipo(tipo) {
  importState.tipo = tipo;
  Object.keys(TIPO_LABELS).forEach(t => {
    document.getElementById(`imp-tipo-${t}`)?.style.setProperty(
      'border-color', t === tipo ? 'var(--green)' : 'var(--line)'
    );
  });
}

function onImportFileSelected(input) {
  const file = input.files[0];
  if (file) procesarArchivoSeleccionado(file);
}

function procesarArchivoSeleccionado(file) {
  if (file.size > 30 * 1024 * 1024) {
    toast('El archivo es mayor a 30MB — considera dividirlo', 'err'); return;
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
          <div style="font-size:11px;color:var(--muted2)">${(file.size/1024).toFixed(1)} KB · ${file.name.split('.').pop().toUpperCase()}</div>
        </div>
        <span style="margin-left:auto;color:var(--green);font-size:18px">✓</span>
      </div>`;
  }
  const btn = document.getElementById('imp-btn-analizar');
  if (btn) { btn.disabled = false; btn.style.opacity = '1'; }
  const btnM = document.getElementById('imp-btn-manual');
  if (btnM) { btnM.disabled = false; btnM.style.opacity = '1'; }
}

function fileEmoji(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const map = {
    xlsx:'📊', xls:'📊', ods:'📊',
    csv:'📄', tsv:'📄', txt:'📝',
    json:'📋', xml:'📋',
    db:'🗃️', sqlite:'🗃️', bak:'🗃️',
    sql:'🗃️', zip:'📦', pdf:'📑',
  };
  return map[ext] || '📁';
}

// ══════════════════════════════════════════════
// LECTURA DEL ARCHIVO — todos los formatos
// ══════════════════════════════════════════════
async function leerArchivo(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();

  if (['csv','txt','tsv'].includes(ext)) return leerCSV(file);
  if (ext === 'json')                    return leerJSON(file);
  if (['xlsx','xls','ods'].includes(ext)) return leerExcel(file);
  if (['db','sqlite'].includes(ext))     return leerSQLite(file);
  if (ext === 'pdf')                     return leerPDF(file);
  if (ext === 'xml')                     return leerXML(file);
  if (ext === 'sql')                     return leerSQL(file);
  if (ext === 'bak')                     return leerBAK(file);
  if (ext === 'zip')                     return leerZIP(file);

  throw new Error(`Formato .${ext} no soportado. Convierte a Excel o CSV primero.`);
}

function leerCSV(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const text  = e.target.result;
        const lines = text.split(/\r?\n/).filter(l => l.trim());
        if (lines.length < 2) throw new Error('El archivo está vacío o tiene solo encabezados');

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
  if (typeof XLSX === 'undefined') {
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
      s.onload = res;
      s.onerror = () => rej(new Error('No se pudo cargar el lector de Excel. Verifica tu conexión.'));
      document.head.appendChild(s);
    });
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(e.target.result, { type: 'array', cellDates: true });
        const ws = wb.Sheets[wb.SheetNames[0]];

        const rawRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
        if (!rawRows.length) throw new Error('La hoja de Excel está vacía');

        const HEADER_KEYWORDS = [
          'nombre','name','articulo','producto','cliente','descripcion','description',
          'precio','price','costo','cost','codigo','code','barcode','stock','cantidad',
          'existencia','telefono','phone','email','rnc','cedula','categoria','category',
          'id','clasificacion','tipo','type','marca','brand','proveedor','supplier',
          'unidad','unit','referencia','sku','pvp','importe','monto','valor','fecha','date',
        ];

        const scoreRow = (row) => {
          let score = 0;
          for (const cell of row) {
            const val = String(cell || '').trim().toLowerCase();
            if (!val) continue;
            if (HEADER_KEYWORDS.some(k => val.includes(k))) score += 3;
            if (/^\d+([.,]\d+)?$/.test(val)) score -= 2;
            if (val.includes('tel') && val.includes(':')) score -= 5;
            if (val.includes('rnc:') || val.includes('ruc:')) score -= 5;
            if (val.length < 25 && val.length > 1) score += 1;
          }
          return score;
        };

        let bestRow = 0, bestScore = -99;
        const searchLimit = Math.min(10, rawRows.length);
        for (let i = 0; i < searchLimit; i++) {
          const score = scoreRow(rawRows[i]);
          if (score > bestScore) { bestScore = score; bestRow = i; }
        }

        const headerRow = rawRows[bestRow];
        const headers   = headerRow.map((h, i) => {
          const clean = String(h || '').trim().replace(/\s+/g, '_');
          return clean || `COL_${i + 1}`;
        });

        const dataRows = rawRows.slice(bestRow + 1).filter(row =>
          row.some(cell => String(cell || '').trim() !== '')
        );

        const rows = dataRows.map(row => {
          const obj = {};
          headers.forEach((h, i) => {
            let v = row[i] !== undefined ? row[i] : '';
            // Convertir fechas de Excel a string
            if (v instanceof Date) {
              v = v.toISOString().split('T')[0];
            }
            obj[h] = v;
          });
          return obj;
        });

        if (!rows.length) throw new Error('No se encontraron datos después del encabezado');
        const validHeaders = headers.filter(h => !h.startsWith('COL_') || rows.some(r => r[h]));
        resolve({ headers: validHeaders, rows });
      } catch(err) { reject(err); }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

async function leerSQLite(file) {
  const arrayBuffer = await file.arrayBuffer();
  const uint8       = new Uint8Array(arrayBuffer);
  const result      = await window.api.importar.readSQLite({ data: Array.from(uint8) });
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

async function leerPDF(file) {
  const arrayBuffer = await file.arrayBuffer();
  const uint8       = new Uint8Array(arrayBuffer);
  const result      = await window.api.importar.readPDF({ data: Array.from(uint8) });
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

// XML — parsear estructura tabular
function leerXML(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const parser = new DOMParser();
        const doc    = parser.parseFromString(e.target.result, 'text/xml');
        const root   = doc.documentElement;

        // Buscar el nodo con más hijos repetidos (tabla)
        let bestNode = null, bestCount = 0;
        const walk = (node) => {
          const childNames = Array.from(node.children).map(c => c.tagName);
          const unique = new Set(childNames);
          if (unique.size === 1 && childNames.length > bestCount) {
            bestCount = childNames.length; bestNode = node;
          }
          Array.from(node.children).forEach(walk);
        };
        walk(root);

        if (!bestNode) throw new Error('No se encontró estructura tabular en el XML');

        const itemNodes = Array.from(bestNode.children);
        if (!itemNodes.length) throw new Error('XML vacío');

        // Extraer campos del primer nodo
        const headers = [];
        const addFields = (node, prefix='') => {
          Array.from(node.children).forEach(c => {
            if (c.children.length === 0) headers.push(prefix + c.tagName);
            else addFields(c, prefix + c.tagName + '_');
          });
          if (node.children.length === 0 && node.textContent.trim()) {
            headers.push(prefix || node.tagName);
          }
        };
        addFields(itemNodes[0]);

        const rows = itemNodes.map(node => {
          const row = {};
          const fill = (n, prefix='') => {
            Array.from(n.children).forEach(c => {
              if (c.children.length === 0) row[prefix + c.tagName] = c.textContent.trim();
              else fill(c, prefix + c.tagName + '_');
            });
            if (n.children.length === 0 && n.textContent.trim()) {
              row[prefix || n.tagName] = n.textContent.trim();
            }
          };
          fill(node);
          return row;
        });

        resolve({ headers: [...new Set(headers)], rows });
      } catch(err) { reject(err); }
    };
    reader.onerror = reject;
    reader.readAsText(file, 'UTF-8');
  });
}

// SQL — extraer INSERT INTO statements
function leerSQL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const text = e.target.result;
        // Buscar la tabla con más INSERTs
        const tableMatches = text.match(/INSERT\s+INTO\s+`?(\w+)`?\s*\(/gi) || [];
        const tableCounts  = {};
        tableMatches.forEach(m => {
          const t = m.match(/INTO\s+`?(\w+)`?/i)?.[1] || '';
          tableCounts[t] = (tableCounts[t] || 0) + 1;
        });
        const bestTable = Object.entries(tableCounts).sort((a,b) => b[1]-a[1])[0]?.[0];
        if (!bestTable) throw new Error('No se encontraron INSERT INTO en el archivo SQL');

        // Extraer columnas del primer INSERT
        const colMatch = text.match(new RegExp(`INSERT\\s+INTO\\s+\`?${bestTable}\`?\\s*\\(([^)]+)\\)`, 'i'));
        const headers  = colMatch
          ? colMatch[1].split(',').map(c => c.trim().replace(/`/g,''))
          : [];

        // Extraer valores
        const valRegex = new RegExp(
          `INSERT\\s+INTO\\s+\`?${bestTable}\`?[^(]*\\([^)]+\\)\\s*VALUES\\s*\\(([^;]+?)\\)\\s*;`,
          'gi'
        );
        const rows = [];
        let m;
        while ((m = valRegex.exec(text)) !== null && rows.length < 2000) {
          try {
            // Parsear los valores respetando strings con comas
            const vals = [];
            let cur = '', inStr = false, strChar = '';
            for (const ch of m[1]) {
              if (!inStr && (ch === "'" || ch === '"')) { inStr = true; strChar = ch; }
              else if (inStr && ch === strChar) { inStr = false; }
              else if (!inStr && ch === ',') { vals.push(cur.trim().replace(/^['"]|['"]$/g,'')); cur = ''; continue; }
              else cur += ch;
            }
            vals.push(cur.trim().replace(/^['"]|['"]$/g,''));
            if (vals.length && vals.some(v => v !== 'NULL' && v !== '')) {
              const row = {};
              headers.forEach((h, i) => { row[h] = vals[i] === 'NULL' ? '' : (vals[i] || ''); });
              rows.push(row);
            }
          } catch {}
        }

        if (!rows.length) throw new Error('No se pudieron extraer registros del archivo SQL');
        resolve({ headers, rows, nota: `Tabla detectada: ${bestTable}` });
      } catch(err) { reject(err); }
    };
    reader.onerror = reject;
    reader.readAsText(file, 'UTF-8');
  });
}

// BAK — detectar formato y delegar
async function leerBAK(file) {
  const arrayBuffer = await file.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer.slice(0, 16));

  // Firma SQLite: "SQLite format 3"
  const sqliteSig = [83,81,76,105,116,101,32,102,111,114,109,97,116,32,51,0];
  const isSQLite  = sqliteSig.every((b, i) => bytes[i] === b);
  if (isSQLite) return leerSQLite(file);

  // Firma ZIP: PK\x03\x04
  if (bytes[0] === 0x50 && bytes[1] === 0x4B) return leerZIP(file);

  // Asumir texto (SQL dump, CSV, etc.)
  const text = await file.text();
  if (text.includes('INSERT INTO') || text.includes('CREATE TABLE')) {
    return leerSQL(new File([text], 'backup.sql', { type: 'text/plain' }));
  }
  if (text.includes(',') || text.includes(';') || text.includes('\t')) {
    return leerCSV(new File([text], 'backup.csv', { type: 'text/plain' }));
  }

  throw new Error('Formato BAK no reconocido. Prueba exportar a CSV o Excel desde tu sistema.');
}

// ZIP — buscar el archivo más útil adentro
async function leerZIP(file) {
  const result = await window.api.importar.readZIP({
    data: Array.from(new Uint8Array(await file.arrayBuffer())),
    name: file.name,
  });
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

// ══════════════════════════════════════════════
// ANÁLISIS CON IA
// ══════════════════════════════════════════════
// ══════════════════════════════════════════════
// DIÁLOGO — IA no disponible, continuar sin ella
// Devuelve Promise<boolean>: true = continuar,
// false = el usuario canceló.
// ══════════════════════════════════════════════
function _confirmarFallbackMapeo() {
  return new Promise(resolve => {
    openModal(`
      <div style="text-align:center;padding:8px 0 4px">
        <div style="font-size:36px;margin-bottom:10px">⚠️</div>
        <div class="modal-title">IA no disponible</div>
        <div class="modal-sub" style="margin-bottom:16px">
          La API key de Claude no está configurada o no es válida.
        </div>
      </div>

      <div class="alrt a" style="margin-bottom:16px">
        <div class="alrt-dot a"></div>
        <div>
          <div class="alrt-title">Se usará mapeo automático por nombre de columna</div>
          <div class="alrt-sub">
            El sistema detectará las columnas por su nombre y las asignará automáticamente.
            Podrás revisar y corregir el mapeo antes de importar.
          </div>
        </div>
      </div>

      <div style="font-size:12px;color:var(--muted);margin-bottom:16px;line-height:1.6">
        Para restaurar el análisis con IA, actualiza la clave <code>ANTHROPIC_API_KEY</code>
        en el archivo <code>.env</code> del proyecto y reinicia la aplicación.
      </div>

      <div class="modal-foot">
        <button class="btn btn-out" onclick="closeModal();window._fallbackResolve(false)">
          Cancelar
        </button>
        <button class="btn btn-dark" onclick="closeModal();window._fallbackResolve(true)">
          Continuar sin IA
        </button>
      </div>
    `);
    window._fallbackResolve = resolve;
  });
}

async function analizarArchivoConIA() {
  const btn = document.getElementById('imp-btn-analizar');
  if (btn) { btn.disabled = true; btn.innerHTML = '⏳ Analizando...'; }

  try {
    const { headers, rows, nota } = await leerArchivo(importState.file);
    importState.headers = headers;
    importState.rawData = rows;
    if (nota) toast(nota, 'ok');

    const tipo   = importState.tipo;
    const campos = (VELO_FIELDS[tipo] || VELO_FIELDS.productos)
      .map(f => `${f.key} (${f.label}${f.required ? ', requerido' : ''})`).join(', ');

    let mapping    = {};
    let confidence = 1;
    let notas      = '';
    let usedAI     = false;

    // ── Intentar con IA ───────────────────────
    try {
      const aiResult = await window.api.importar.analyzeWithAI({
        headers, rows: rows.slice(0, 5), tipo, campos,
      });
      if (aiResult.ok) {
        mapping    = aiResult.data.mapping    || {};
        confidence = aiResult.data.confidence || 1;
        notas      = aiResult.data.notas      || '';
        usedAI     = true;
      } else if (aiResult.authError) {
        // API key inválida o ausente — preguntar al usuario qué desea hacer
        if (btn) { btn.disabled = false; btn.innerHTML = '✨ Analizar con IA'; }
        const continuar = await _confirmarFallbackMapeo();
        if (!continuar) return; // usuario canceló
        if (btn) { btn.disabled = true; btn.innerHTML = '⏳ Mapeando...'; }
      }
    } catch (_) { /* IA no disponible — continuar con mapeo automático */ }

    // ── Mapeo automático por nombre de columna ─
    // Se usa cuando la IA no está disponible o el usuario confirma continuar sin ella.
    if (!usedAI || Object.keys(mapping).length === 0) {
      const fields = VELO_FIELDS[tipo] || VELO_FIELDS.productos;
      _aplicarMapeoAutomatico(fields, headers, mapping);
      confidence = 0.85;
      notas = '✓ Mapeo automático por nombre de columna — revisa y ajusta si es necesario.';
      toast('IA no disponible — mapeo automático aplicado', 'w');
    }

    importState.mapping     = mapping;
    importState._confidence = confidence;
    mostrarVistaPrevia(notas);

  } catch (err) {
    toast(`Error al analizar: ${err.message}`, 'err');
    if (btn) { btn.disabled = false; btn.innerHTML = '✨ Analizar con IA'; }
  }
}

// ══════════════════════════════════════════════
// VISTA PREVIA + MAPEO + REPORTE DE ANÁLISIS
// ══════════════════════════════════════════════
function mostrarVistaPrevia(notas) {
  const tipo    = importState.tipo;
  const fields  = VELO_FIELDS[tipo] || VELO_FIELDS.productos;
  const hdrs    = importState.headers;
  const rows    = importState.rawData;
  const total   = rows.length;
  const preview = rows.slice(0, 3);

  // ── Detección de duplicados en preview ────────
  const checkDedup = document.getElementById('imp-check-dedup')?.checked !== false;
  let dupInfo = '';
  if (checkDedup && tipo === 'productos') {
    const names = rows.map(r => {
      const col = importState.mapping.name;
      return col ? String(r[col]||'').trim().toLowerCase() : '';
    }).filter(Boolean);
    const dups = names.filter((n, i) => names.indexOf(n) !== i);
    if (dups.length) {
      dupInfo = `<div class="alrt a" style="margin-bottom:10px">
        <div class="alrt-dot a"></div>
        <div><div class="alrt-title">${dups.length} posibles duplicados detectados en el archivo</div>
        <div class="alrt-sub">Se omitirán los que ya existen en Velo por código o nombre.</div></div>
      </div>`;
    }
  }

  const mappingRows = fields.map(f => {
    const mapped = importState.mapping[f.key] || '';
    const opts   = hdrs.map(h =>
      `<option value="${h}" ${h === mapped ? 'selected' : ''}>${h}</option>`
    ).join('');
    const ejemplo = mapped && preview[0] ? (String(preview[0][mapped] || '—').slice(0,30)) : '—';
    return `
      <tr>
        <td style="font-size:12px;white-space:nowrap">
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
        <td style="font-size:11px;color:var(--muted2);max-width:120px;overflow:hidden;text-overflow:ellipsis">
          ${ejemplo}
        </td>
      </tr>`;
  }).join('');

  const confColor = (importState._confidence || 1) >= 0.8 ? 'var(--green)' :
                    (importState._confidence || 1) >= 0.6 ? 'var(--amber)' : 'var(--red)';

  openModal(`
    <div class="modal-title">✨ Mapeo IA — ${TIPO_LABELS[tipo] || tipo}</div>
    <div class="modal-sub" style="margin-bottom:10px">${notas || 'Revisa y ajusta si es necesario'}</div>

    ${importState._confidence < 0.7 ? `
    <div class="alrt a" style="margin-bottom:10px">
      <div class="alrt-dot a"></div>
      <div>
        <div class="alrt-title">Confianza del mapeo: ${Math.round((importState._confidence||0)*100)}%</div>
        <div class="alrt-sub">Revisa cuidadosamente los campos antes de importar.</div>
      </div>
    </div>` : ''}

    ${dupInfo}

    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:12px">
      <div style="background:var(--surface2);border-radius:var(--r-sm);padding:10px;font-size:12px">
        <div style="font-weight:600;margin-bottom:3px">📊 Archivo</div>
        <div style="color:var(--muted2);font-size:11px">${importState.file?.name}</div>
        <div style="font-size:13px;font-weight:700;margin-top:4px">${total.toLocaleString()} registros</div>
      </div>
      <div style="background:var(--surface2);border-radius:var(--r-sm);padding:10px;font-size:12px">
        <div style="font-weight:600;margin-bottom:3px">🎯 Tipo</div>
        <div style="color:var(--muted2);font-size:11px">${TIPO_LABELS[tipo]}</div>
        <div style="font-size:13px;font-weight:700;margin-top:4px">${hdrs.length} columnas</div>
      </div>
      <div style="background:var(--surface2);border-radius:var(--r-sm);padding:10px;font-size:12px">
        <div style="font-weight:600;margin-bottom:3px">🤖 Confianza IA</div>
        <div style="font-size:20px;font-weight:800;color:${confColor}">
          ${Math.round((importState._confidence||1)*100)}%
        </div>
      </div>
    </div>

    <div style="border:1px solid var(--line);border-radius:8px;overflow:hidden;margin-bottom:12px">
      <div style="overflow-y:auto;max-height:300px">
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="background:var(--surface2)">
              <th style="padding:8px;text-align:left;font-size:11px;border-bottom:1px solid var(--line)">Campo Velo POS</th>
              <th style="padding:8px;text-align:left;font-size:11px;border-bottom:1px solid var(--line)">Columna del archivo</th>
              <th style="padding:8px;text-align:left;font-size:11px;border-bottom:1px solid var(--line)">Ejemplo</th>
            </tr>
          </thead>
          <tbody>${mappingRows}</tbody>
        </table>
      </div>
    </div>

    <div class="modal-foot">
      <button class="btn btn-out" onclick="wizardStepImportar()">← Volver</button>
      <button class="btn btn-out" onclick="abrirMapeoManual()" style="color:var(--muted)">
        🗂 Manual
      </button>
      <button class="btn btn-out" onclick="mostrarVistaPrevia('')" style="color:var(--blue)">
        🔄 Re-analizar
      </button>
      <button class="btn btn-dark" onclick="ejecutarImportacion()">
        ⬆ Importar ${total.toLocaleString()} registros
      </button>
    </div>
  `, 'modal-xl');
}

// También mantener nombre anterior por compatibilidad con wizard
function mostrarConfirmacionMapeo(notas) { mostrarVistaPrevia(notas); }

function updateMapping(field, value) {
  if (value) importState.mapping[field] = value;
  else delete importState.mapping[field];
}

// ══════════════════════════════════════════════
// IMPORTACIÓN CON BARRA DE PROGRESO + ROLLBACK
// ══════════════════════════════════════════════
async function ejecutarImportacion() {
  const tipo    = importState.tipo;
  const mapping = importState.mapping;
  const rows    = importState.rawData;
  const dedup   = document.getElementById('imp-check-dedup')?.checked !== false;
  const allowRollback = document.getElementById('imp-check-rollback')?.checked !== false;

  const fields  = VELO_FIELDS[tipo] || VELO_FIELDS.productos;
  const missing = fields.filter(f => f.required && !mapping[f.key]);
  if (missing.length) {
    toast(`Falta mapear: ${missing.map(f => f.label).join(', ')}`, 'err');
    return;
  }

  importState._sessionIds = [];
  const sessionIds = importState._sessionIds;

  openModal(`
    <div style="text-align:center;padding:20px">
      <div style="font-size:32px;margin-bottom:12px">⏳</div>
      <div class="modal-title">Importando ${TIPO_LABELS[tipo] || tipo}...</div>
      <div class="modal-sub" id="imp-prog-sub">Preparando...</div>
      <div style="background:var(--line);border-radius:6px;height:8px;margin:16px 0">
        <div id="imp-prog-bar" style="background:var(--green);height:8px;border-radius:6px;width:0%;transition:.3s"></div>
      </div>
      <div id="imp-prog-count" style="font-size:13px;color:var(--muted2)">0 / ${rows.length}</div>
      <div id="imp-prog-dup" style="font-size:11px;color:var(--amber);margin-top:4px"></div>
    </div>
  `, 'modal-lg');

  const errores   = [];
  let importados  = 0;
  let duplicados  = 0;

  // ── Procesamiento especial para facturas_credito ──
  // Agrupa filas por (cliente + referencia_factura) ANTES del loop
  // para crear una sola venta con todos sus artículos.
  if (tipo === 'facturas_credito') {
    const grouped = new Map(); // key: "cliente||ref"

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const customerName = (mapping.customer_name ? String(row[mapping.customer_name]||'') : '').trim();
      if (!customerName) {
        errores.push({ fila:i+2, campo:'cliente', error:'Cliente vacío — fila omitida', tipo:'error' });
        continue;
      }
      const invoiceRef = mapping.invoice_ref
        ? String(row[mapping.invoice_ref]||'').trim()
        : '';
      // Clave de agrupación: cliente + ref (o cliente + precio total si no hay ref)
      const groupKey  = `${customerName.toLowerCase()}||${invoiceRef || _impCleanNum(mapping.total ? row[mapping.total] : 0)}`;

      if (!grouped.has(groupKey)) {
        // Tomar total de la primera fila del grupo (es el balance de la factura,
        // igual en todas las filas de la misma factura — no acumular).
        const totalFila = _impCleanNum(mapping.total ? row[mapping.total] : 0);
        grouped.set(groupKey, {
          customerName,
          phone:       mapping.phone       ? String(row[mapping.phone]||'').trim()       : '',
          rnc:         mapping.rnc         ? String(row[mapping.rnc]||'').trim()         : '',
          invoiceRef,
          date:        _impNormDate(mapping.date ? row[mapping.date] : '') || new Date().toISOString().split('T')[0],
          total:       totalFila,   // fijo desde primera fila — no se sobreescribe
          creditDays:  mapping.credit_days ? _impCleanInt(row[mapping.credit_days]) : 30,
          items:       [],
          filas:       [],
        });
      }

      const g = grouped.get(groupKey);
      const productName = (mapping.product_name ? String(row[mapping.product_name]||'').trim() : '').trim();
      const qty         = mapping.qty       ? Math.max(1, _impCleanInt(row[mapping.qty]))   : 1;
      const unitPrice   = _impCleanNum(mapping.unit_price ? row[mapping.unit_price] : 0);

      if (productName && unitPrice >= 0) {
        g.items.push({ name: productName, qty, price: unitPrice });
      }
      g.filas.push(i + 2);
    }

    // Si no vino total explícito, calcularlo desde la suma de items
    for (const g of grouped.values()) {
      if (g.total <= 0 && g.items.length) {
        g.total = Math.round(g.items.reduce((s, it) => s + it.price * it.qty, 0) * 100) / 100;
      }
    }

    // Procesar cada grupo como una venta
    const grupos = Array.from(grouped.values());
    let gi = 0;
    for (const g of grupos) {
      gi++;
      const pct = Math.round((gi / grupos.length) * 100);
      const bar = document.getElementById('imp-prog-bar');
      const sub = document.getElementById('imp-prog-sub');
      const cnt = document.getElementById('imp-prog-count');
      if (bar) bar.style.width = pct + '%';
      if (sub) sub.textContent = `Factura ${gi} de ${grupos.length} — ${g.customerName}`;
      if (cnt) cnt.textContent = `${importados} importadas · ${errores.filter(e=>e.tipo==='error').length} errores`;
      await new Promise(r => setTimeout(r, 0));

      if (!g.items.length) {
        errores.push({ fila: g.filas[0], nombre: g.customerName,
          campo: 'artículos', error: 'Sin artículos válidos — factura omitida', tipo:'error' });
        continue;
      }
      if (g.total <= 0) {
        errores.push({ fila: g.filas[0], nombre: g.customerName,
          campo: 'total', error: 'Total inválido — factura omitida', tipo:'error' });
        continue;
      }

      try {
        const result = await window.api.importar.importarFacturaCredito({
          customerName: g.customerName,
          phone:        g.phone,
          rnc:          g.rnc,
          invoiceRef:   g.invoiceRef,
          date:         g.date,
          items:        g.items,
          total:        g.total,
          creditDays:   g.creditDays,
          requestUserId: user.id,
        });

        if (result.ok) {
          if (result.skipped) {
            duplicados++;
            errores.push({ fila: g.filas[0], nombre: g.customerName,
              campo:'duplicado', error:`Factura ${g.invoiceRef||'sin ref'} ya importada — omitida`, tipo:'dup' });
          } else {
            importados++;
            sessionIds.push({ tabla:'sales',     id: result.saleId    });
            if (result.customerCreated) {
              sessionIds.push({ tabla:'customers', id: result.customerId });
            }
          }
        } else {
          errores.push({ fila: g.filas[0], nombre: g.customerName,
            campo:'factura', error: result.error || 'Error', tipo:'error' });
        }
      } catch(e) {
        errores.push({ fila: g.filas[0], nombre: g.customerName,
          campo:'excepción', error: e.message, tipo:'error' });
      }
    }

    // Recargar y mostrar resultado — saltamos el loop principal
    await reloadCustomers().catch(()=>{});
    if (window.api?.customers?.getAllPayments) {
      try { DB.payments = await window.api.customers.getAllPayments(); } catch {}
    }
    await reloadSales({ range: 'all' }).catch(()=>{});
    mostrarResultadoImportacion(importados, errores, grupos.length, duplicados, allowRollback);
    return; // ← salir de ejecutarImportacion, no entrar al loop
  }

  let codeCounter = Date.now();
  const genCode   = () => `IMP-${++codeCounter}`;

  // Índices para detección de duplicados
  const existingProductNames = dedup
    ? new Set(DB.products.map(p => p.name.trim().toLowerCase())) : new Set();
  const existingProductCodes = dedup
    ? new Set(DB.products.map(p => p.code.trim().toLowerCase())) : new Set();
  const existingClientNames  = dedup
    ? new Set(DB.customers.map(c => c.name.trim().toLowerCase())) : new Set();
  const existingClientRNCs   = dedup
    ? new Set(DB.customers.map(c => (c.rnc||'').trim()).filter(Boolean)) : new Set();
  const existingSupplierNames = dedup
    ? new Set((window._suppliersCache||[]).map(s => s.name.trim().toLowerCase())) : new Set();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    if (i % 5 === 0) {
      const pct = Math.round((i / rows.length) * 100);
      const bar = document.getElementById('imp-prog-bar');
      const sub = document.getElementById('imp-prog-sub');
      const cnt = document.getElementById('imp-prog-count');
      const dup = document.getElementById('imp-prog-dup');
      if (bar) bar.style.width = pct + '%';
      if (sub) sub.textContent = `Procesando ${i + 1} de ${rows.length}...`;
      if (cnt) cnt.textContent = `${importados} importados · ${errores.filter(e=>e.tipo!=='ajuste').length} errores`;
      if (dup && duplicados > 0) dup.textContent = `${duplicados} duplicados omitidos`;
      await new Promise(r => setTimeout(r, 0));
    }

    try {
      // ── PRODUCTOS ──────────────────────────────
      if (tipo === 'productos') {
        let name  = String(row[mapping.name] || '').trim();
        const code = mapping.code ? String(row[mapping.code]||'').trim() : '';

        if (!name) {
          name = `Producto sin nombre (fila ${i+2})`;
          errores.push({ fila:i+2, nombre:name, campo:'nombre', error:'Sin nombre — provisional', tipo:'ajuste' });
        }

        // Detección de duplicados
        if (dedup) {
          const nameLow = name.toLowerCase();
          const codeLow = code.toLowerCase();
          if (existingProductNames.has(nameLow) || (code && existingProductCodes.has(codeLow))) {
            duplicados++;
            errores.push({ fila:i+2, nombre:name, campo:'duplicado',
              error:'Ya existe en Velo — omitido', tipo:'dup' });
            continue;
          }
        }

        const data = {
          name,
          code:        code || genCode(),
          barcode:     mapping.barcode    ? String(row[mapping.barcode]||'').trim()    : '',
          price:       _impCleanNum(mapping.price    ? row[mapping.price]    : 0),
          cost:        _impCleanNum(mapping.cost     ? row[mapping.cost]     : 0),
          wholesale:   _impCleanNum(mapping.wholesale? row[mapping.wholesale]: 0),
          stock:       _impCleanInt(mapping.stock    ? row[mapping.stock]    : 0),
          stock_min:   _impCleanInt(mapping.stock_min? row[mapping.stock_min]: 0),
          category:    mapping.category   ? String(row[mapping.category]||'').trim()   : '',
          brand:       mapping.brand      ? String(row[mapping.brand]||'').trim()      : '',
          unit:        mapping.unit       ? String(row[mapping.unit]||'').trim()       : 'und',
          description: mapping.description? String(row[mapping.description]||'').trim(): '',
        };
        if (data.wholesale === 0) data.wholesale = data.price;

        let result = await window.api.products.create({ data, requestUserId: user.id });
        if (!result.ok) {
          data.code = genCode();
          result = await window.api.products.create({ data, requestUserId: user.id });
        }
        if (result.ok) {
          importados++;
          sessionIds.push({ tabla: 'products', id: result.id });
          existingProductNames.add(name.toLowerCase());
          if (data.code) existingProductCodes.add(data.code.toLowerCase());
          if (data.price <= 0) errores.push({ fila:i+2, nombre:name, campo:'precio',
            error:'Precio pendiente de ajuste', tipo:'ajuste' });
        } else {
          errores.push({ fila:i+2, nombre:name, campo:'sistema',
            error:result.error||'Error desconocido', tipo:'error' });
        }

      // ── CLIENTES ───────────────────────────────
      } else if (tipo === 'clientes') {
        let name = mapping.name ? String(row[mapping.name]||'').trim() : '';
        if (!name) {
          for (const col of Object.keys(row)) {
            const v = String(row[col]||'').trim();
            if (v.length > 2 && v.length < 80 && /[A-Za-záéíóúñÑ]/.test(v) && !/^\d+$/.test(v)) {
              name = v; break;
            }
          }
        }
        if (!name) {
          name = `Cliente sin nombre (fila ${i+2})`;
          errores.push({ fila:i+2, nombre:name, campo:'nombre', error:'Sin nombre — provisional', tipo:'ajuste' });
        }
        name = name.replace(/[^ -~áéíóúñÁÉÍÓÚÑüÜ]/g,' ').replace(/\s+/g,' ').trim();

        const rnc = mapping.rnc ? String(row[mapping.rnc]||'').trim() : '';
        if (dedup) {
          if (existingClientNames.has(name.toLowerCase()) ||
              (rnc && existingClientRNCs.has(rnc))) {
            duplicados++;
            errores.push({ fila:i+2, nombre:name, campo:'duplicado',
              error:'Ya existe en Velo — omitido', tipo:'dup' });
            continue;
          }
        }

        const balance     = _impCleanNum(mapping.balance      ? row[mapping.balance]      : 0);
        const creditLimit = _impCleanNum(mapping.credit_limit ? row[mapping.credit_limit] : 0);
        const creditDays  = mapping.credit_days ? _impCleanInt(row[mapping.credit_days]) : 30;
        const creditDue   = mapping.credit_due
          ? _impNormDate(row[mapping.credit_due]) : null;
        let status = 'activo';
        if (mapping.status) {
          const rs = String(row[mapping.status]||'').toLowerCase();
          if (rs.includes('bloq') || rs.includes('block')) status = 'bloqueado';
          else if (rs.includes('mor') || rs.includes('late')) status = 'moroso';
        }

        const data = {
          name, rnc,
          phone:        mapping.phone    ? String(row[mapping.phone]||'').trim()   : '',
          email:        mapping.email    ? String(row[mapping.email]||'').trim()   : '',
          address:      mapping.address  ? String(row[mapping.address]||'').trim() : '',
          credit_limit: Math.max(balance, creditLimit),
          credit_days:  creditDays || 30,
        };

        let result = await window.api.customers.create({ data, requestUserId: user.id });
        if (result.ok) {
          importados++;
          sessionIds.push({ tabla: 'customers', id: result.id });
          existingClientNames.add(name.toLowerCase());
          if (rnc) existingClientRNCs.add(rnc);
          // Si tiene balance, importar como crédito
          if (balance > 0) {
            await window.api.importar.importarCredito({
              customerName: name, balance, creditLimit: data.credit_limit,
              creditDays: data.credit_days, creditDue, phone: data.phone,
              rnc, status, requestUserId: user.id,
            });
          }
        } else {
          errores.push({ fila:i+2, nombre:name, campo:'sistema',
            error:result.error||'Error', tipo:'error' });
        }

      // ── CUENTAS POR COBRAR ─────────────────────
      } else if (tipo === 'cuentas_cobrar') {
        const customerName = mapping.customer_name
          ? String(row[mapping.customer_name]||'').trim() : '';
        if (!customerName) {
          errores.push({ fila:i+2, campo:'cliente',
            error:'Nombre de cliente vacío — omitido', tipo:'error' }); continue;
        }
        const balance     = _impCleanNum(mapping.balance      ? row[mapping.balance]      : 0);
        const creditLimit = _impCleanNum(mapping.credit_limit ? row[mapping.credit_limit] : balance);
        const creditDays  = mapping.credit_days ? _impCleanInt(row[mapping.credit_days]) : 30;
        const creditDue   = mapping.credit_due ? _impNormDate(row[mapping.credit_due]) : null;
        const phone       = mapping.phone ? String(row[mapping.phone]||'').trim() : '';
        const rnc         = mapping.rnc   ? String(row[mapping.rnc]||'').trim()   : '';
        let status = 'activo';
        if (mapping.status) {
          const rs = String(row[mapping.status]||'').toLowerCase();
          if (rs.includes('bloq')) status = 'bloqueado';
          else if (rs.includes('mor')) status = 'moroso';
        }

        const result = await window.api.importar.importarCredito({
          customerName, balance, creditLimit, creditDays, creditDue,
          phone, rnc, status, requestUserId: user.id,
        });
        if (result.ok) {
          importados++;
          if (result.created) errores.push({ fila:i+2, nombre:customerName, campo:'info',
            error:`Cliente nuevo creado con deuda RD$${balance.toLocaleString('es-DO')}`, tipo:'ajuste' });
        } else {
          errores.push({ fila:i+2, nombre:customerName, campo:'credito',
            error:result.error||'Error', tipo:'error' });
        }

      // ── VENTAS HISTÓRICAS ──────────────────────
      } else if (tipo === 'ventas') {
        let rawDate = mapping.date ? String(row[mapping.date]||'').trim() : '';
        rawDate = _impNormDate(rawDate) || new Date().toISOString().split('T')[0];

        const total    = _impCleanNum(mapping.total       ? row[mapping.total]       : 0);
        if (total <= 0) {
          errores.push({ fila:i+2, campo:'total',
            error:'Total inválido — omitido', tipo:'error' }); continue;
        }

        const ventaData = {
          date:           rawDate,
          customer_name:  mapping.customer_name  ? String(row[mapping.customer_name]||'').trim() : 'Consumidor Final',
          total,
          subtotal:       mapping.subtotal ? _impCleanNum(row[mapping.subtotal]) : total,
          tax_amt:        mapping.tax_amt  ? _impCleanNum(row[mapping.tax_amt])  : 0,
          discount_pct:   mapping.discount_pct ? _impCleanNum(row[mapping.discount_pct]) : 0,
          payment_method: mapping.payment_method
            ? String(row[mapping.payment_method]||'efectivo').trim().toLowerCase() : 'efectivo',
          cajero:         'Importación histórica',
          invoice_ref:    mapping.invoice_ref ? String(row[mapping.invoice_ref]||'').trim() : '',
          ncf:            mapping.ncf    ? String(row[mapping.ncf]||'').trim()    : '',
          type:           (() => { const t = (mapping.type ? String(row[mapping.type]||'') : '').trim().toLowerCase(); return ['factura','cotizacion','devolucion'].includes(t) ? t : 'factura'; })(),
          items: [{
            product_name: mapping.product_name ? String(row[mapping.product_name]||'').trim() : 'Venta importada',
            qty:          mapping.qty ? Math.max(1, _impCleanInt(row[mapping.qty])) : 1,
            unit_price:   mapping.unit_price ? _impCleanNum(row[mapping.unit_price]) : total,
            product_code: 'IMP', unit_cost: 0,
          }],
        };

        const result = await window.api.importar.importarVenta({ venta: ventaData, requestUserId: user.id });
        if (result.ok) {
          if (result.skipped) {
            duplicados++;
          } else {
            importados++;
            sessionIds.push({ tabla: 'sales', id: result.saleId });
          }
        } else {
          errores.push({ fila:i+2, nombre:ventaData.customer_name, campo:'venta',
            error:result.error||'Error', tipo:'error' });
        }

      // ── PROVEEDORES ────────────────────────────
      } else if (tipo === 'proveedores') {
        const name = mapping.name ? String(row[mapping.name]||'').trim() : '';
        if (!name) {
          errores.push({ fila:i+2, campo:'nombre', error:'Sin nombre — omitido', tipo:'error' }); continue;
        }
        if (dedup && existingSupplierNames.has(name.toLowerCase())) {
          duplicados++;
          errores.push({ fila:i+2, nombre:name, campo:'duplicado',
            error:'Proveedor ya existe — omitido', tipo:'dup' }); continue;
        }

        const data = {
          name,
          contact: mapping.contact ? String(row[mapping.contact]||'').trim() : '',
          phone:   mapping.phone   ? String(row[mapping.phone]||'').trim()   : '',
          email:   mapping.email   ? String(row[mapping.email]||'').trim()   : '',
          rnc:     mapping.rnc     ? String(row[mapping.rnc]||'').trim()     : '',
          address: mapping.address ? String(row[mapping.address]||'').trim() : '',
          notes:   mapping.notes   ? String(row[mapping.notes]||'').trim()   : '',
        };

        const result = await window.api.suppliers.create({ data, requestUserId: user.id });
        if (result.ok) {
          importados++;
          existingSupplierNames.add(name.toLowerCase());
          sessionIds.push({ tabla: 'suppliers', id: result.id });
        } else {
          errores.push({ fila:i+2, nombre:name, campo:'sistema',
            error:result.error||'Error', tipo:'error' });
        }

      // ── COMPRAS / ENTRADAS ─────────────────────
      } else if (tipo === 'compras') {
        const supplierName = mapping.supplier_name
          ? String(row[mapping.supplier_name]||'').trim() : 'Proveedor Importado';
        const productName  = mapping.product_name
          ? String(row[mapping.product_name]||'').trim()  : '';
        if (!productName) {
          errores.push({ fila:i+2, campo:'producto', error:'Sin nombre de producto — omitido', tipo:'error' }); continue;
        }

        const unitCost = _impCleanNum(mapping.unit_cost ? row[mapping.unit_cost] : 0);
        const qty      = Math.max(1, _impCleanInt(mapping.qty ? row[mapping.qty] : 1));
        const date     = _impNormDate(mapping.date ? row[mapping.date] : '') ||
                         new Date().toISOString().split('T')[0];

        // Buscar producto por nombre para obtener su ID
        const prod = DB.products.find(p =>
          p.name.trim().toLowerCase() === productName.trim().toLowerCase());

        const result = await window.api.importar.importarCompra({
          supplierName, productName,
          productId:   prod?.id || null,
          productCode: prod?.code || 'IMP',
          unitCost, qty, date,
          notes: mapping.notes ? String(row[mapping.notes]||'').trim() : '',
          requestUserId: user.id,
          skipStock: true, // Importación histórica — stock ya viene correcto del CSV de productos
        });
        if (result.ok) {
          importados++;
          sessionIds.push({ tabla: 'purchase_orders', id: result.poId });
        } else {
          errores.push({ fila:i+2, nombre:productName, campo:'compra',
            error:result.error||'Error', tipo:'error' });
        }

      // ── FACTURAS A CRÉDITO ─────────────────────
      // Las filas ya vienen agrupadas en _facturasAgrupadas,
      // este bloque procesa cada grupo (una venta por grupo).
      } else if (tipo === 'facturas_credito') {
        // (procesado por lote antes del loop — ver más abajo)
        continue;

      // ── GASTOS ─────────────────────────────────
      } else if (tipo === 'abonos') {
        const customerName = mapping.customer_name
          ? String(row[mapping.customer_name]||'').trim() : '';
        if (!customerName) {
          errores.push({ fila:i+2, campo:'cliente', error:'Cliente vacío — omitido', tipo:'error' }); continue;
        }
        const amount = _impCleanNum(mapping.amount ? row[mapping.amount] : 0);
        if (amount <= 0) {
          errores.push({ fila:i+2, nombre:customerName, campo:'monto',
            error:'Monto inválido — omitido', tipo:'error' }); continue;
        }
        const date = _impNormDate(mapping.date ? row[mapping.date] : '') ||
                     new Date().toISOString().split('T')[0];
        const invoiceRef = mapping.invoice_ref
          ? String(row[mapping.invoice_ref]||'').trim() : '';
        const payMethod = mapping.payment_method
          ? String(row[mapping.payment_method]||'efectivo').trim().toLowerCase() : 'efectivo';
        const notes = mapping.notes
          ? String(row[mapping.notes]||'').trim() : 'Abono importado';

        const result = await window.api.importar.importarAbono({
          customerName, amount, date, invoiceRef,
          paymentMethod: payMethod,
          notes: notes || 'Abono importado',
          requestUserId: user.id,
        });
        if (result.ok) {
          importados++;
          sessionIds.push({ tabla:'payments', id: result.id });
        } else {
          errores.push({ fila:i+2, nombre:customerName, campo:'abono',
            error:result.error||'Error', tipo:'error' });
        }

      } else if (tipo === 'gastos') {
        const description = mapping.description
          ? String(row[mapping.description]||'').trim() : '';
        if (!description) {
          errores.push({ fila:i+2, campo:'descripcion', error:'Sin descripción — omitido', tipo:'error' }); continue;
        }

        const total = _impCleanNum(mapping.total ? row[mapping.total] : 0);
        if (total <= 0) {
          errores.push({ fila:i+2, nombre:description, campo:'monto',
            error:'Monto inválido — omitido', tipo:'error' }); continue;
        }

        const date = _impNormDate(mapping.date ? row[mapping.date] : '') ||
                     new Date().toISOString().split('T')[0];

        const result = await window.api.importar.importarGasto({
          description, total, date,
          category:       mapping.category       ? String(row[mapping.category]||'').trim()       : '',
          payment_method: mapping.payment_method ? String(row[mapping.payment_method]||'efectivo').trim() : 'efectivo',
          supplier_name:  mapping.supplier_name  ? String(row[mapping.supplier_name]||'').trim()  : '',
          notes:          mapping.notes          ? String(row[mapping.notes]||'').trim()          : '',
          status:         mapping.status         ? String(row[mapping.status]||'pagado').trim()   : 'pagado',
          requestUserId: user.id,
        });
        if (result.ok) {
          importados++;
          sessionIds.push({ tabla: 'expenses', id: result.id });
        } else {
          errores.push({ fila:i+2, nombre:description, campo:'gasto',
            error:result.error||'Error', tipo:'error' });
        }
      }

    } catch(e) {
      errores.push({ fila:i+2, error:e.message, tipo:'error' });
    }
  }

  // ── Recargar datos en tiempo real ─────────────
  await reloadProducts().catch(()=>{});
  await reloadCustomers().catch(()=>{});
  if (tipo === 'ventas') {
    await reloadSales({ range: 'today' }).catch(()=>{});
    await reloadSales({ range: 'month' }).catch(()=>{});
    await reloadSales({ range: 'all'   }).catch(()=>{});
  }
  if (['cuentas_cobrar','clientes'].includes(tipo)) {
    if (window.api?.customers?.getAllPayments) {
      try { DB.payments = await window.api.customers.getAllPayments(); } catch {}
    }
  }
  if (['productos','compras'].includes(tipo)) {
    await reloadCategories().catch(()=>{});
  }

  mostrarResultadoImportacion(importados, errores, rows.length, duplicados, allowRollback);
}

// ══════════════════════════════════════════════
// RESULTADO FINAL + ROLLBACK
// ══════════════════════════════════════════════
function mostrarResultadoImportacion(importados, errores, total, duplicados = 0, allowRollback = false) {
  const soloAjustes = errores.filter(e => e.tipo === 'ajuste');
  const soloDups    = errores.filter(e => e.tipo === 'dup');
  const soloErrores = errores.filter(e => e.tipo === 'error');
  const fallidos    = soloErrores.length;
  const pct         = total > 0 ? Math.round((importados/total)*100) : 0;
  const color       = fallidos === 0 ? 'var(--green)' :
                      fallidos < total * 0.1 ? 'var(--amber)' : 'var(--red)';

  importState._lastResult = {
    importados, errores, total,
    tipo: importState.tipo,
    archivo: importState.file?.name || 'archivo',
    fecha: new Date().toLocaleString('es-DO'),
    duplicados,
  };

  const tieneRollback = allowRollback && importState._sessionIds.length > 0;

  const ajustesHtml = soloAjustes.slice(0,15).map(e =>
    `<tr style="background:#fffbeb">
      <td style="padding:4px 6px;color:var(--muted2);font-size:11px">Fila ${e.fila||'—'}</td>
      <td style="padding:4px 6px;font-size:11px;font-weight:500">${e.nombre||''}</td>
      <td style="padding:4px 6px;color:#92400e;font-size:11px">${e.error}</td>
    </tr>`).join('');

  const errHtml = soloErrores.slice(0,10).map(e =>
    `<tr style="background:#fef2f2">
      <td style="padding:4px 6px;color:var(--muted2);font-size:11px">Fila ${e.fila||'—'}</td>
      <td style="padding:4px 6px;font-size:11px;font-weight:500">${e.nombre||''}</td>
      <td style="padding:4px 6px;color:var(--red);font-size:11px">${e.error}</td>
    </tr>`).join('');

  openModal(`
    <div style="text-align:center;margin-bottom:14px">
      <div style="font-size:36px;margin-bottom:6px">
        ${fallidos === 0 ? '🎉' : soloAjustes.length > 0 ? '✅' : '⚠️'}
      </div>
      <div class="modal-title">Importación completada</div>
      <div class="modal-sub">${importState.file?.name} · ${TIPO_LABELS[importState.tipo]||''}</div>
    </div>

    <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin-bottom:14px">
      ${[
        { val: importados, label: 'Importados', color: 'var(--green)' },
        { val: soloAjustes.length, label: 'Pendientes', color: '#92400e' },
        { val: fallidos,  label: 'Errores', color: fallidos>0?'var(--red)':'var(--green)' },
        { val: duplicados, label: 'Duplicados', color: duplicados>0?'var(--amber)':'var(--muted2)' },
        { val: pct+'%',   label: 'Éxito', color: pct>=95?'var(--green)':pct>=80?'var(--amber)':'var(--red)' },
      ].map(m => `
        <div style="text-align:center;background:var(--surface2);border-radius:var(--r-md);padding:10px">
          <div style="font-size:22px;font-weight:800;color:${m.color}">${m.val}</div>
          <div style="font-size:10px;color:var(--muted2)">${m.label}</div>
        </div>`).join('')}
    </div>

    ${soloAjustes.length > 0 ? `
      <div style="margin-bottom:10px">
        <div style="font-weight:600;font-size:12px;color:#92400e;margin-bottom:6px">
          ⚡ ${soloAjustes.length} importados con datos pendientes de completar:
        </div>
        <table class="tbl" style="font-size:11px">
          <thead><tr><th>Fila</th><th>Nombre</th><th>Pendiente</th></tr></thead>
          <tbody>${ajustesHtml}</tbody>
        </table>
        ${soloAjustes.length > 15 ? `<div style="font-size:11px;color:var(--muted2);margin-top:4px">
          ...y ${soloAjustes.length-15} más — ver reporte PDF completo</div>` : ''}
      </div>` : ''}

    ${soloErrores.length > 0 ? `
      <div style="margin-bottom:10px">
        <div style="font-weight:600;font-size:12px;color:var(--red);margin-bottom:6px">
          ⚠ ${soloErrores.length} registros no importados:
        </div>
        <table class="tbl" style="font-size:11px">
          <thead><tr><th>Fila</th><th>Nombre</th><th>Error</th></tr></thead>
          <tbody>${errHtml}</tbody>
        </table>
        ${soloErrores.length > 10 ? `<div style="font-size:11px;color:var(--muted2);margin-top:4px">
          ...y ${soloErrores.length-10} más — ver reporte PDF</div>` : ''}
      </div>` : ''}

    <div class="modal-foot" style="flex-wrap:wrap;gap:6px">
      <button class="btn btn-out" onclick="wizardStepImportar()">
        Importar otro
      </button>
      ${tieneRollback ? `
        <button class="btn btn-out" style="color:var(--red);border-color:var(--red)"
                onclick="confirmarRollback()">
          ↩ Deshacer importación
        </button>` : ''}
      <button class="btn btn-out" onclick="importarDescargarPDF()" style="color:var(--blue);border-color:var(--blue)">
        ${svg('download')} Reporte PDF
      </button>
      <button class="btn btn-dark" onclick="wizardStep=4;renderWizardStep()">
        ${svg('check')} Continuar
      </button>
    </div>
  `, 'modal-xl');
}

// ── Rollback — deshacer la última importación ──
async function confirmarRollback() {
  const ids   = importState._sessionIds || [];
  const count = ids.length;
  if (!count) { toast('Nada que deshacer', 'w'); return; }

  confirmModal(
    `¿Deshacer la importación de <strong>${count} registros</strong>?
     <br><span style="font-size:11px;color:var(--muted)">
       Esta acción eliminará permanentemente los registros importados en esta sesión.
     </span>`,
    async () => {
      const result = await window.api.importar.rollback({ ids, requestUserId: user.id });
      if (result.ok) {
        importState._sessionIds = [];
        await reloadProducts().catch(()=>{});
        await reloadCustomers().catch(()=>{});
        closeModal();
        toast(`✓ Importación deshecha — ${result.deleted} registros eliminados`);
      } else {
        toast(result.error || 'Error al deshacer', 'err');
      }
    },
    'Deshacer importación',
    'btn-red'
  );
}

// ── Reporte PDF ────────────────────────────────
async function importarDescargarPDF() {
  const r = importState._lastResult;
  if (!r) { toast('Sin resultado de importación', 'err'); return; }

  const soloAjustes = (r.errores||[]).filter(e => e.tipo === 'ajuste');
  const soloErrores = (r.errores||[]).filter(e => e.tipo === 'error');
  const soloDups    = (r.errores||[]).filter(e => e.tipo === 'dup');
  const pct         = r.total > 0 ? Math.round((r.importados/r.total)*100) : 0;
  const tipoLabel   = TIPO_LABELS[r.tipo] || r.tipo;

  const rowsHtml = (arr, colColor) => arr.map((e,i) => `
    <tr style="background:${i%2===0?'#f9fafb':'#fff'}">
      <td style="padding:5px 8px;font-size:11px;color:#6b7280">Fila ${_esc(e.fila)||'—'}</td>
      <td style="padding:5px 8px;font-size:11px;font-weight:500">${_esc(e.nombre)}</td>
      <td style="padding:5px 8px;font-size:11px;color:${colColor}">${_esc(e.error)}</td>
      <td style="padding:5px 8px;font-size:11px;color:#6b7280">${_esc(e.campo)}</td>
    </tr>`).join('');

  const html = `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8">
<title>Reporte Importación — ${_esc(r.archivo)}</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:Arial,sans-serif;font-size:12px;color:#111;padding:28px}
  .header{border-bottom:3px solid #16A34A;padding-bottom:14px;margin-bottom:18px}
  .logo{font-size:18px;font-weight:800;color:#16A34A;margin-bottom:3px}
  .metrics{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-bottom:18px}
  .metric{background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:10px;text-align:center}
  .metric-val{font-size:22px;font-weight:800}
  .metric-lbl{font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:.04em}
  table{width:100%;border-collapse:collapse;margin-bottom:14px}
  th{background:#f3f4f6;padding:7px 8px;text-align:left;font-size:10px;font-weight:700;
     text-transform:uppercase;color:#6b7280;border-bottom:2px solid #e5e7eb}
  .section{margin-bottom:16px}
  .section-title{font-size:12px;font-weight:700;margin-bottom:8px}
  .footer{margin-top:24px;padding-top:10px;border-top:1px solid #e5e7eb;
          font-size:10px;color:#9ca3af;text-align:center}
  @media print{body{padding:14px}}
</style>
</head><body>
<div class="header">
  <div class="logo">Velo POS — Reporte de Migración</div>
  <div style="font-size:13px;font-weight:600">${_esc(tipoLabel)} · ${_esc(r.archivo)}</div>
  <div style="font-size:11px;color:#6b7280">${_esc(r.fecha)} · ${_esc(CFG.biz)||'Velo POS'}</div>
</div>
<div class="metrics">
  <div class="metric">
    <div class="metric-val" style="color:#16A34A">${r.importados}</div>
    <div class="metric-lbl">Importados</div>
  </div>
  <div class="metric">
    <div class="metric-val" style="color:${soloAjustes.length>0?'#92400e':'#16A34A'}">${soloAjustes.length}</div>
    <div class="metric-lbl">Pendientes</div>
  </div>
  <div class="metric">
    <div class="metric-val" style="color:${soloErrores.length>0?'#DC2626':'#16A34A'}">${soloErrores.length}</div>
    <div class="metric-lbl">Errores</div>
  </div>
  <div class="metric">
    <div class="metric-val" style="color:${(r.duplicados||0)>0?'#D97706':'#6b7280'}">${r.duplicados||0}</div>
    <div class="metric-lbl">Duplicados</div>
  </div>
  <div class="metric">
    <div class="metric-val" style="color:${pct>=95?'#16A34A':pct>=80?'#D97706':'#DC2626'}">${pct}%</div>
    <div class="metric-lbl">Éxito</div>
  </div>
</div>
${soloAjustes.length > 0 ? `
<div class="section">
  <div class="section-title" style="color:#92400e">⚡ ${soloAjustes.length} registros con datos pendientes</div>
  <table><thead><tr><th>Fila</th><th>Nombre</th><th>Pendiente</th><th>Campo</th></tr></thead>
  <tbody>${rowsHtml(soloAjustes,'#92400e')}</tbody></table>
</div>` : ''}
${soloErrores.length > 0 ? `
<div class="section">
  <div class="section-title" style="color:#DC2626">⚠ ${soloErrores.length} registros no importados</div>
  <table><thead><tr><th>Fila</th><th>Nombre</th><th>Error</th><th>Campo</th></tr></thead>
  <tbody>${rowsHtml(soloErrores,'#DC2626')}</tbody></table>
</div>` : ''}
${soloDups.length > 0 ? `
<div class="section">
  <div class="section-title" style="color:#D97706">🔄 ${soloDups.length} duplicados omitidos</div>
  <table><thead><tr><th>Fila</th><th>Nombre</th><th>Razón</th><th>Campo</th></tr></thead>
  <tbody>${rowsHtml(soloDups,'#D97706')}</tbody></table>
</div>` : ''}
<div class="footer">${_esc(CFG.biz)||'Velo POS'} · v${_esc(window._appVersion)} · ${_esc(r.fecha)}</div>
</body></html>`;

  printHTML(html, 'reporte');
}

// ══════════════════════════════════════════════
// IMPORTACIÓN DESDE CONFIGURACIÓN
// ══════════════════════════════════════════════
function abrirImportarDesdeConfig() {
  importState = { file:null, rawData:[], headers:[], mapping:{},
    tipo:'productos', importando:false, _sessionIds:[] };
  wizardStepImportar();
  setTimeout(() => {
    const omitirBtn = document.querySelector('.modal-foot .btn-out');
    if (omitirBtn && omitirBtn.textContent.includes('Omitir')) {
      omitirBtn.style.display = 'none';
    }
  }, 100);
}

// ══════════════════════════════════════════════
// MAPEO MANUAL — sin IA, sin archivo previo
// Permite al usuario asignar columnas a mano
// para cualquier tipo de datos del migrador.
// Si ya hay un archivo cargado, usa sus headers.
// Si no, el usuario pega sus columnas como texto.
// ══════════════════════════════════════════════
function abrirMapeoManual() {
  const tipo    = importState.tipo || 'productos';
  const fields  = VELO_FIELDS[tipo] || VELO_FIELDS.productos;
  const hdrs    = importState.headers || [];
  const tieneArchivo = hdrs.length > 0;

  // Si no hay archivo cargado, pedir columnas manualmente
  if (!tieneArchivo) {
    openModal(`
      <div class="modal-title">🗂 Mapeo Manual</div>
      <div class="modal-sub">Pega las columnas de tu archivo para comenzar el mapeo</div>

      <div class="fg" style="margin-bottom:12px">
        <label class="lbl">
          Columnas de tu archivo (separadas por coma o punto y coma)
        </label>
        <textarea class="inp" id="man-cols-input" rows="3"
                  placeholder="Ej: nombre, precio, codigo, stock, categoria"
                  style="resize:vertical;font-family:monospace;font-size:12px"></textarea>
        <div style="font-size:11px;color:var(--muted2);margin-top:4px">
          Copia el encabezado de tu Excel o CSV y pégalo aquí.
        </div>
      </div>

      <div class="modal-foot">
        <button class="btn btn-out" onclick="closeModal()">Cancelar</button>
        <button class="btn btn-dark" onclick="
          const raw = document.getElementById('man-cols-input')?.value || '';
          const cols = raw.split(/[,;\\t]+/).map(c => c.trim()).filter(Boolean);
          if (!cols.length) { toast('Ingresa al menos una columna', 'err'); return; }
          importState.headers = cols;
          importState.rawData = importState.rawData.length ? importState.rawData : [];
          importState.mapping = {};
          _mostrarMapeoManual();
        ">
          Continuar →
        </button>
      </div>
    `);
    return;
  }

  // Tiene archivo — ir directo al mapeo
  importState.mapping = importState.mapping || {};
  _mostrarMapeoManual();
}

function _mostrarMapeoManual() {
  const tipo   = importState.tipo || 'productos';
  const fields = VELO_FIELDS[tipo] || VELO_FIELDS.productos;
  const hdrs   = importState.headers || [];
  const rows   = importState.rawData || [];
  const mapping = importState.mapping || {};

  // Aplicar mapeo automático como punto de partida si no hay ninguno
  if (Object.keys(mapping).length === 0) {
    _aplicarMapeoAutomatico(fields, hdrs, mapping);
  }

  const preview = rows.slice(0, 2);

  const mappingRows = fields.map(f => {
    const mapped  = mapping[f.key] || '';
    const opts    = hdrs.map(h =>
      `<option value="${h}" ${h === mapped ? 'selected' : ''}>${h}</option>`
    ).join('');
    const ejemplo = mapped && preview[0]
      ? String(preview[0][mapped] || '—').slice(0, 35)
      : '—';

    return `
      <tr>
        <td style="font-size:12px;white-space:nowrap;padding:6px 8px">
          <b>${f.label}</b>
          ${f.required ? '<span style="color:var(--red)">*</span>' : ''}
          <div style="font-size:10px;color:var(--muted2);font-weight:400">${f.key}</div>
        </td>
        <td style="padding:4px 8px">
          <select class="inp" style="font-size:12px;padding:4px 8px"
                  id="map-${f.key}"
                  onchange="updateMapping('${f.key}',this.value)">
            <option value="">— No importar —</option>
            ${opts}
          </select>
        </td>
        <td style="font-size:11px;color:var(--muted2);padding:6px 8px;
                   max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
          ${ejemplo}
        </td>
      </tr>`;
  }).join('');

  const reqs    = fields.filter(f => f.required);
  const mapped  = reqs.filter(f => mapping[f.key]);
  const pctReq  = reqs.length ? Math.round((mapped.length / reqs.length) * 100) : 100;
  const color   = pctReq === 100 ? 'var(--green)' : pctReq >= 50 ? 'var(--amber)' : 'var(--red)';

  openModal(`
    <div class="modal-title">🗂 Mapeo Manual — ${TIPO_LABELS[tipo] || tipo}</div>
    <div class="modal-sub">
      Asigna cada campo de Velo POS a la columna correcta de tu archivo.
      Los campos con <span style="color:var(--red)">*</span> son requeridos.
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:14px">
      <div style="background:var(--surface2);border-radius:var(--r-sm);padding:10px;font-size:12px">
        <div style="font-weight:600;margin-bottom:3px">📋 Columnas</div>
        <div style="font-size:20px;font-weight:800">${hdrs.length}</div>
        <div style="font-size:10px;color:var(--muted2)">en el archivo</div>
      </div>
      <div style="background:var(--surface2);border-radius:var(--r-sm);padding:10px;font-size:12px">
        <div style="font-weight:600;margin-bottom:3px">📊 Registros</div>
        <div style="font-size:20px;font-weight:800">${(importState.rawData||[]).length.toLocaleString()}</div>
        <div style="font-size:10px;color:var(--muted2)">a importar</div>
      </div>
      <div style="background:var(--surface2);border-radius:var(--r-sm);padding:10px;font-size:12px">
        <div style="font-weight:600;margin-bottom:3px">✅ Requeridos</div>
        <div style="font-size:20px;font-weight:800;color:${color}">${pctReq}%</div>
        <div style="font-size:10px;color:var(--muted2)">${mapped.length} de ${reqs.length} mapeados</div>
      </div>
    </div>

    <div style="border:1px solid var(--line);border-radius:8px;overflow:hidden;margin-bottom:12px">
      <div style="overflow-y:auto;max-height:320px">
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="background:var(--surface2)">
              <th style="padding:8px;text-align:left;font-size:11px;
                         border-bottom:1px solid var(--line)">Campo Velo POS</th>
              <th style="padding:8px;text-align:left;font-size:11px;
                         border-bottom:1px solid var(--line)">Columna del archivo</th>
              <th style="padding:8px;text-align:left;font-size:11px;
                         border-bottom:1px solid var(--line)">Ejemplo</th>
            </tr>
          </thead>
          <tbody>${mappingRows}</tbody>
        </table>
      </div>
    </div>

    ${hdrs.length > 0 ? `
    <div style="margin-bottom:10px">
      <div style="font-size:11px;font-weight:600;color:var(--muted);margin-bottom:6px">
        Columnas disponibles en tu archivo:
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:4px">
        ${hdrs.map(h => `
          <span style="background:var(--surface2);border:1px solid var(--line);
                       border-radius:4px;padding:2px 8px;font-size:11px;
                       font-family:monospace">${h}</span>
        `).join('')}
      </div>
    </div>` : ''}

    <div class="modal-foot">
      <button class="btn btn-out" onclick="wizardStepImportar()">← Volver</button>
      <button class="btn btn-out"
              onclick="importState.mapping={};_mostrarMapeoManual()"
              style="color:var(--muted)">
        ↺ Reiniciar mapeo
      </button>
      <button class="btn btn-dark"
              onclick="_validarYEjecutarDesdeManual()">
        ⬆ Importar ${(importState.rawData||[]).length.toLocaleString()} registros
      </button>
    </div>
  `, 'modal-xl');
}

// Aplicar mapeo automático por sinónimos — reutilizado por manual y fallback IA
function _aplicarMapeoAutomatico(fields, hdrs, mappingObj) {
  const SYNONYMS = {
    name:           ['name','nombre','cliente','customer_name'],
    phone:          ['phone','telefono','teléfono','celular','tel','movil'],
    email:          ['email','correo','mail'],
    rnc:            ['rnc','cedula','cédula','rnc_cedula'],
    address:        ['address','direccion','dirección'],
    credit_limit:   ['credit_limit','limite','limite_credito'],
    credit_days:    ['credit_days','dias_credito','dias','plazo'],
    balance:        ['balance','deuda','saldo','balance_pendiente'],
    status:         ['status','estado'],
    credit_due:     ['credit_due','vencimiento','fecha_vencimiento'],
    code:           ['code','codigo','sku','referencia'],
    barcode:        ['barcode','codigo_barras','barras'],
    price:          ['price','precio','precio_venta','pvp'],
    cost:           ['cost','costo','costo_compra'],
    wholesale:      ['wholesale','precio_mayor','mayoreo'],
    stock:          ['stock','existencia','cantidad','inventario'],
    stock_min:      ['stock_min','minimo','stock_minimo'],
    category:       ['category','categoria','clasificacion'],
    brand:          ['brand','marca'],
    unit:           ['unit','unidad'],
    description:    ['description','descripcion','observaciones'],
    customer_name:  ['customer_name','cliente','nombre','name'],
    invoice_ref:    ['invoice_ref','factura','codigo_factura','referencia','invoice','numero'],
    date:           ['date','fecha','fecha_factura','fecha_insercion'],
    product_name:   ['product_name','articulo','producto','item','descripcion'],
    qty:            ['qty','cantidad','cant','quantity'],
    unit_price:     ['unit_price','precio','precio_unitario','price','valor'],
    total:          ['total','total_factura','balance_pendiente','balance','monto','importe'],
    payment_method: ['payment_method','forma_pago','metodo','pago'],
    amount:         ['amount','monto','abono','pago','valor'],
    ncf:            ['ncf','comprobante'],
    cajero:         ['cajero','vendedor','usuario'],
    supplier_name:  ['supplier_name','proveedor','suplidor'],
    unit_cost:      ['unit_cost','costo','costo_unitario'],
    notes:          ['notes','notas','nota','observaciones'],
    contact:        ['contact','contacto'],
    tax_amt:        ['tax_amt','itbis','impuesto','tax'],
    discount_pct:   ['discount_pct','descuento','discount'],
    subtotal:       ['subtotal','sub_total'],
    type:           ['type','tipo','tipo_doc'],
  };

  const hdrsLow = hdrs.map(h => h.toLowerCase().trim().replace(/\s+/g,'_'));
  fields.forEach(f => {
    if (mappingObj[f.key]) return; // ya mapeado
    const syns = SYNONYMS[f.key] || [f.key];
    const idx  = hdrsLow.findIndex(h =>
      syns.some(s => h === s || h.includes(s) || s.includes(h))
    );
    if (idx !== -1) mappingObj[f.key] = hdrs[idx];
  });
}

// Validar requeridos y ejecutar desde mapeo manual
function _validarYEjecutarDesdeManual() {
  const tipo    = importState.tipo;
  const fields  = VELO_FIELDS[tipo] || VELO_FIELDS.productos;
  const mapping = importState.mapping;
  const missing = fields.filter(f => f.required && !mapping[f.key]);

  if (missing.length) {
    toast(`Falta mapear: ${missing.map(f => f.label).join(', ')}`, 'err');
    return;
  }
  if (!importState.rawData || !importState.rawData.length) {
    toast('No hay datos para importar. Carga un archivo primero.', 'err');
    return;
  }
  ejecutarImportacion();
}
