// ══════════════════════════════════════════════
// pos.js — Punto de Venta
//          · Ventas via IPC → SQLite
//          · Transaccional (todo o nada)
//          · Múltiples facturas simultáneas
//          · Modal cobro con nombre/cédula
//          · Precios retail / mayorista
// ══════════════════════════════════════════════

let posSearch = '';

async function renderPOS(el) {
  try {
    await chkCaja();
    if (CFG.module_vendedores === '1' && window.api?.salespeople?.getAll) {
      try {
        const sellers = await window.api.salespeople.getAll({ status: 'activo' });
        DB.salespeople = Array.isArray(sellers) ? sellers : (sellers?.data || []);
      } catch { /* el POS sigue disponible si el módulo auxiliar no responde */ }
    }
    el.innerHTML = '';
    el.style.padding  = '0';
    el.style.overflow = 'hidden';

    if (!cajaOpen && user?.role === 'cajero') {
      el.innerHTML = `
        <div style="text-align:center;padding:70px 20px">
          <div style="width:56px;height:56px;background:var(--amber-bg);border-radius:13px;
               display:flex;align-items:center;justify-content:center;margin:0 auto 14px;
               color:var(--amber)">${svg('lock')}</div>
          <div style="font-weight:800;font-size:19px;margin-bottom:7px">Caja cerrada</div>
          <div style="color:var(--muted);margin-bottom:22px;font-size:13px">
            Debes abrir la caja antes de realizar ventas</div>
          <button class="btn btn-green btn-lg" onclick="routeTo('caja')">Abrir caja</button>
        </div>`;
      return;
    }

    const wrap = h('div', { class: 'pos-wrap' });

    // ── Panel izquierdo ─────────────────────────
    // pos-cat ahora es flex column — la barra queda fija y solo el grid scrollea
    const left = h('div', { class: 'pos-cat' });

    const topBar = h('div', { style: 'display:flex;gap:8px;margin-bottom:14px;flex-shrink:0' });
    topBar.innerHTML = `
      <div class="inp-ic" style="flex:1">
        <div class="ic">${svg('search')}</div>
        <input class="inp" id="pos-search" type="text"
               placeholder="Buscar producto, código..."
               value="${posSearch}"/>
      </div>
      <select class="inp" id="pos-cat" style="width:140px">
        <option value="">Todas</option>
        ${[{ v:'', l:'Todas' }, ...CATS.map(c => ({ v:c, l:c }))].map(o =>
            `<option value="${o.v}">${o.l}</option>`).join('')}
      </select>`;
    left.appendChild(topBar);

    const customerBar = h('div', {
      style: 'display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-shrink:0;position:relative'
    });
    customerBar.innerHTML = `
      <span style="font-size:11px;color:var(--muted);font-weight:600;flex-shrink:0">Cliente:</span>
      <div class="cli-search-wrap" style="flex:1;min-width:0">
        <div class="inp-ic">
          <div class="ic">${svg('user')}</div>
          <input class="inp" id="pos-customer-search" type="search" autocomplete="off"
                 placeholder="Consumidor Final · buscar nombre, RNC, teléfono o representante"
                 onfocus="this.select();posFilterCustomers(this.value,true)"
                 oninput="posFilterCustomers(this.value)"
                 onblur="setTimeout(()=>document.getElementById('pos-customer-dd')?.classList.remove('show'),180)"/>
        </div>
        <div id="pos-customer-dd" class="cli-dropdown"></div>
      </div>
      <div id="pos-customer-state" style="font-size:10.5px;color:var(--muted);white-space:nowrap;max-width:240px;overflow:hidden;text-overflow:ellipsis"></div>
      <button class="btn btn-out btn-sm" type="button" onclick="posSelectCustomer(1)" title="Volver a Consumidor Final">Limpiar</button>`;
    left.appendChild(customerBar);

    // Barra de sucursal de entrega: solo aparece si el cliente es una empresa
    // con sucursales registradas (se llena en renderPOSCustomerSelection).
    const branchBar = h('div', {
      id: 'pos-branch-bar',
      style: 'display:none;align-items:center;gap:8px;margin-bottom:10px;flex-shrink:0'
    });
    left.appendChild(branchBar);

    const modeBar = h('div', { style: 'display:flex;align-items:center;gap:8px;margin-bottom:12px;flex-shrink:0' });
    modeBar.innerHTML = `
      <span style="font-size:11px;color:var(--muted);font-weight:600">Precio:</span>
      <div class="tabs" id="pos-pmode-tabs" style="margin-bottom:0">
        <button class="tab ${currentInv().pmode !== 'wholesale' ? 'on' : ''}" data-pmode="retail"
                onclick="_setPosPmode('retail')">Detalle</button>
        <button class="tab ${currentInv().pmode === 'wholesale' ? 'on' : ''}" data-pmode="wholesale"
                onclick="_setPosPmode('wholesale')">Mayorista</button>
      </div>`;
    left.appendChild(modeBar);

    const grid = h('div', { id: 'pos-grid', class: 'prod-grid' });
    // Envolver el grid en un contenedor que haga el scroll
    const gridWrap = h('div', { style: 'flex:1;overflow-y:auto;min-height:0' });
    gridWrap.appendChild(grid);
    left.appendChild(gridWrap);

    // ── Panel derecho ───────────────────────────
    const right = h('div', { class: 'pos-side', id: 'pos-side' });
    const tabsEl = h('div', { class: 'invoice-tabs', id: 'inv-tabs' });
    right.appendChild(tabsEl);
    const cartEl = h('div', { id: 'cart-wrap',
      style: 'display:flex;flex-direction:column;flex:1;overflow:hidden' });
    right.appendChild(cartEl);

    wrap.appendChild(left);
    wrap.appendChild(right);
    el.appendChild(wrap);

    setTimeout(() => {
      const si = document.getElementById('pos-search');
      const sc = document.getElementById('pos-cat');
      if (si) {
        si.addEventListener('input', e => { posSearch = e.target.value; renderPOSGrid(); });
        // Enter en el buscador: resuelve el producto (código interno o de barras).
        si.addEventListener('keydown', e => {
          if (e.key === 'Enter') {
            e.preventDefault();
            _posResolveScan(si.value);
          }
        });
      }
      if (sc) sc.addEventListener('change', () => renderPOSGrid());
      document.getElementById('pos-search')?.focus();

      // ── Captura global del lector de código de barras ─────────────────
      // Un escaneo SIEMPRE debe agregar el producto — nunca debe caer como
      // cantidad en un campo enfocado. El lector USB "teclea" mucho más rápido
      // que una persona; detectamos esa ráfaga por el tiempo entre teclas y la
      // desviamos al alta de producto, bloqueando que contamine el campo de
      // cantidad (donde un código numérico se interpretaba como "todo el stock").
      // Se instala una sola vez y se limpia cuando el POS se desmonta.
      if (window._barcodeListenerAbort) {
        window._barcodeListenerAbort.abort(); // limpiar listener anterior
      }
      const barcodeAbort = new AbortController();
      window._barcodeListenerAbort = barcodeAbort;

      const SCAN_GAP_MS  = 30;   // teclas más rápidas que esto ⇒ lector, no humano
      const SCAN_MIN_LEN = 3;    // largo mínimo para considerarlo un escaneo
      let scanBuf = '';
      let scanLastTs = 0;

      document.addEventListener('keydown', (e) => {
        if (!document.getElementById('pos-search')) {
          // El POS ya no está montado — limpiar por si el abort no corrió.
          barcodeAbort.abort();
          return;
        }
        if (e.ctrlKey || e.metaKey || e.altKey) return;

        const now = Date.now();
        const gap = now - scanLastTs;
        scanLastTs = now;

        if (e.key === 'Enter') {
          // Escaneo = ráfaga con largo suficiente y el Enter llegó pegado.
          const isScan = scanBuf.length >= SCAN_MIN_LEN && gap <= SCAN_GAP_MS;
          const code   = scanBuf;
          scanBuf = '';
          if (isScan) {
            e.preventDefault();
            e.stopPropagation();     // que NO llegue al campo enfocado ni a su Enter
            _posHandleScan(code);
          }
          return;
        }

        if (e.key.length !== 1) return;

        // Tecla lenta ⇒ arranca una secuencia nueva (tecleo humano).
        if (gap > SCAN_GAP_MS) scanBuf = '';
        scanBuf += e.key;

        // En plena ráfaga sobre un campo que NO es el buscador (p.ej. la
        // cantidad del carrito), bloquea el carácter: así el código escaneado
        // no se escribe como cantidad. El 1er carácter puede filtrarse, pero
        // el carrito se redibuja al agregar y queda consistente.
        const el = document.activeElement;
        if (el && el.id !== 'pos-search' &&
            ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) &&
            gap <= SCAN_GAP_MS && scanBuf.length >= 2) {
          e.preventDefault();
        }
      }, { capture: true, signal: barcodeAbort.signal });
    }, 0);

    renderPOSGrid();
    renderInvTabs();
    renderCart();
    renderPOSCustomerSelection();
    if (window._pendingPOSResaleCart) {
      const pending = window._pendingPOSResaleCart;
      window._pendingPOSResaleCart = null;
      setTimeout(() => posLoadResaleCart(pending), 0);
    }
  } catch(e) {
    console.error('[renderPOS]', e);
    if (el) el.innerHTML = `<div style="padding:40px;text-align:center">
      <div style="color:var(--red);font-weight:700;margin-bottom:8px">Error al cargar el POS</div>
      <div style="font-size:12px;color:var(--muted2)">${e.message}</div>
      <button class="btn btn-dark" style="margin-top:16px" onclick="routeTo('pos')">Reintentar</button>
    </div>`;
  }
}

// ── Cambiar modo de precio (Detalle/Mayorista) ──
// Actualiza el modo, mueve el resaltado 'on' al botón activo y redibuja la
// grilla. Antes solo se redibujaba la grilla y el resaltado quedaba pegado.
function _setPosPmode(mode) {
  const inv = currentInv();
  mode = mode === 'wholesale' ? 'wholesale' : 'retail';
  inv.pmode = mode;
  if (!inv.checkoutOrderId) {
    inv.cart.forEach(item => {
      if (item.resale_source || item.manual_price) return;
      const product = DB.products.find(p => Number(p.id) === Number(item.pid || item.product_id));
      if (!product) return;
      const price = mode === 'wholesale' && Number(product.wholesale) > 0
        ? Number(product.wholesale) : Number(product.price);
      if (price > 0) {
        item.price = price;
        item.unit_price = price;
      }
    });
  }
  const tabs = document.getElementById('pos-pmode-tabs');
  if (tabs) {
    tabs.querySelectorAll('button[data-pmode]').forEach(btn => {
      btn.classList.toggle('on', btn.getAttribute('data-pmode') === mode);
    });
  }
  renderPOSGrid();
  renderInvTabs();
  renderCart();
}

// ── Grid de productos ─────────────────────────
function _posAvailableStock(product) {
  return Math.max(0, (Number(product?.stock) || 0) - (Number(product?.reserved_stock) || 0));
}

function renderPOSGrid() {
  const grid = document.getElementById('pos-grid');
  if (!grid) return;

  const qNorm = searchNorm(posSearch);
  const cat = document.getElementById('pos-cat')?.value || '';
  const inv = currentInv();
  const pm  = inv.pmode || 'retail';

  const prods = DB.products.filter(p => {
    const mCat = !cat || p.category === cat;
    const mQ   = !qNorm ||
      matchText(p.name, qNorm) ||
      matchText(p.code, qNorm) ||
      matchText(p.brand, qNorm) ||
      matchText(p.model, qNorm) ||
      matchText(p.barcode, qNorm);
    return mCat && mQ && p.active !== 0;
  });

  if (!prods.length) {
    grid.innerHTML = `
      <div style="grid-column:1/-1;text-align:center;padding:44px;color:var(--muted2)">
        <div style="margin-bottom:8px">${svg('search')}</div>
        <div style="font-weight:600">Sin resultados</div>
      </div>`;
    return;
  }

  // HTML de una tarjeta de producto
  const cardHTML = (p) => {
    const price  = (pm === 'wholesale' && p.wholesale > 0) ? p.wholesale : p.price;
    const available = _posAvailableStock(p);
    const reserved = Number(p.reserved_stock) || 0;
    const isOut  = available <= 0;
    const isLow  = available > 0 && available <= p.stock_min;
    const inCart = inv.cart.find(i => i.pid === p.id);
    return `
      <div class="prod-card ${isOut ? 'out' : ''}"
           onclick="${isOut ? '' : `posAddItem(${p.id})`}"
           id="pcard-${p.id}"
           style="cursor:${isOut ? 'not-allowed' : 'pointer'};opacity:${isOut ? '.4' : '1'}">
        <div class="pc-icon">${svg('pkg')}</div>
        <div class="pc-name">${p.name}</div>
        <div class="pc-code">${p.code}${p.condition && p.condition !== 'nuevo'
          ? ` · <span style="color:var(--amber);font-weight:700;font-size:9px;text-transform:uppercase">${
              p.condition === 'usado' ? 'USADO' :
              p.condition === 'reacondicionado' ? 'REACOND.' :
              p.condition === 'consignacion' ? 'CONSIG.' : 'ESPECIAL'
            }</span>` : ''}</div>
        <div class="pc-price">${fmt(price)}</div>
        ${p.taxable === 0 ? '' : `<div style="font-size:9.5px;font-weight:700;color:var(--blue);margin-top:1px">ITBIS incl.</div>`}
        ${p.model ? `<div style="font-size:10px;font-weight:600;color:var(--blue);margin-top:2px">${p.model}</div>` : ''}
        <div class="pc-stock" style="color:${isLow ? 'var(--red)' : 'var(--muted2)'}">
          ${isOut ? 'Sin disponibilidad' : `${available} disponibles`}${reserved > 0 ? ` · ${reserved} reservados` : ''}
        </div>
        ${inCart ? `<div style="margin-top:5px;font-size:10px;font-weight:700;
          color:var(--green);background:var(--green-bg);padding:2px 6px;
          border-radius:20px;display:inline-block">En carrito: ${inCart.qty}</div>` : ''}
      </div>`;
  };

  // ── Renderizado incremental ──────────────────────────────────────
  // Pintar 1200+ tarjetas de golpe congela la UI. Pintamos un lote inicial
  // y cargamos el resto al hacer scroll en el contenedor de la grilla.
  const BATCH = 60;
  let rendered = Math.min(BATCH, prods.length);
  grid.innerHTML = prods.slice(0, rendered).map(cardHTML).join('');

  if (rendered < prods.length) {
    const scroller = grid.closest('[style*="overflow"]') || grid.parentElement;
    const loadMore = () => {
      if (rendered >= prods.length) return;
      grid.insertAdjacentHTML('beforeend',
        prods.slice(rendered, rendered + BATCH).map(cardHTML).join(''));
      rendered += BATCH;
    };
    if (scroller) {
      // Listener nombrado para poder limpiarlo al re-renderizar la grilla.
      if (scroller._posScrollHandler) scroller.removeEventListener('scroll', scroller._posScrollHandler);
      scroller._posScrollHandler = () => {
        if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 400) loadMore();
      };
      scroller.addEventListener('scroll', scroller._posScrollHandler);
    }
  }
}

// ── Tabs de facturas ──────────────────────────
function renderInvTabs() {
  const wrap = document.getElementById('inv-tabs');
  if (!wrap) return;
  wrap.innerHTML = '';

  invoices.forEach((inv, idx) => {
    const total = calcTotals(inv).total;
    const tab   = document.createElement('div');
    tab.className = `inv-tab ${idx === activeInvoice ? 'on' : ''}`;
    tab.innerHTML = `
      <span>#${inv.id}${total > 0 ? ' ' + fmt(total) : ''}</span>
      <span class="inv-tab-close"
            onclick="event.stopPropagation();posRemoveTab(${idx})">×</span>`;
    tab.addEventListener('click', () => posSetTab(idx));
    wrap.appendChild(tab);
  });

  const addBtn = document.createElement('button');
  addBtn.className   = 'inv-tab-add';
  addBtn.title       = 'Nueva factura';
  addBtn.textContent = '+';
  addBtn.onclick     = () => { addInvoice(); renderInvTabs(); renderCart(); renderPOSGrid(); renderPOSCustomerSelection(); };
  wrap.appendChild(addBtn);
}

function posSetTab(idx) {
  activeInvoice = idx;
  renderInvTabs();
  renderCart();
  renderPOSGrid();
  renderPOSCustomerSelection();
}

function posRemoveTab(idx) {
  removeInvoice(idx);
  renderInvTabs();
  renderCart();
  renderPOSGrid();
  renderPOSCustomerSelection();
}

// ── Agregar al carrito ────────────────────────
// ── Resolución de escaneo / búsqueda por Enter ────────────────────────
// Busca coincidencia EXACTA por código interno o código de barras; si no
// hay, hace búsqueda parcial y agrega solo si el resultado es único.
// SIEMPRE agrega cantidad 1 (vía posAddItem). Reutilizada por el buscador
// y por la captura global del lector.
function _posResolveScan(q) {
  q = String(q == null ? '' : q).trim();
  if (!q) return;
  const si = document.getElementById('pos-search');
  const exacto = DB.products.find(p =>
    p.active !== 0 && (
      p.code?.toLowerCase()    === q.toLowerCase() ||
      p.code?.toLowerCase()    === q.toLowerCase().replace(/^0+/, '') ||
      p.barcode?.toLowerCase() === q.toLowerCase() ||
      p.barcode?.toLowerCase() === q.toLowerCase().replace(/^0+/, '')
    )
  );
  if (exacto) {
    posAddItem(exacto.id);
    if (si) si.value = '';
    posSearch = '';
    renderPOSGrid();
    toast(`✓ ${exacto.name} agregado`, 'ok');
    return;
  }
  // Sin coincidencia exacta: búsqueda parcial; se agrega solo si es única.
  posSearch = q;
  renderPOSGrid();
  const qN = searchNorm(q);
  const filtered = DB.products.filter(p =>
    p.active !== 0 && (
      matchText(p.name, qN) ||
      matchText(p.code, qN) ||
      matchText(p.barcode, qN) ||
      matchText(p.model, qN)
    )
  );
  if (filtered.length === 1) {
    posAddItem(filtered[0].id);
    if (si) si.value = '';
    posSearch = '';
    renderPOSGrid();
    toast(`✓ ${filtered[0].name} agregado`, 'ok');
  }
}

// Maneja un escaneo del lector: resuelve el producto y devuelve el foco al
// buscador para el siguiente escaneo.
function _posHandleScan(code) {
  _posResolveScan(code);
  document.getElementById('pos-search')?.focus();
}

function posAddItem(pid) {
  const inv  = currentInv();
  if (inv.checkoutOrderId) {
    toast('Esta orden de despacho esta bloqueada; cobrala o cierrala', 'w');
    return;
  }
  const prod = DB.products.find(p => p.id === pid);
  if (!prod || _posAvailableStock(prod) <= 0) { toast('Sin disponibilidad', 'err'); return; }

  // Animación en la tarjeta del producto
  const card = document.getElementById(`pcard-${pid}`);
  if (card) {
    card.classList.add('pos-card-pulse');
    setTimeout(() => card.classList.remove('pos-card-pulse'), 400);
  }

  const pm    = inv.pmode || 'retail';
  const price = (pm === 'wholesale' && prod.wholesale > 0) ? prod.wholesale : prod.price;

  // Validar precio mayorista no configurado
  if (pm === 'wholesale' && (!prod.wholesale || prod.wholesale === 0)) {
    toast(`⚠ "${prod.name}" no tiene precio mayorista — se usó precio de mostrador`, 'warn');
    // Usamos precio retail como fallback seguro (ya incluido en price por la expresión anterior)
  }
  // Nunca vender a RD$0 (cualquier modo)
  if (!price || price <= 0) {
    toast(`"${prod.name}" no tiene precio configurado — no se puede vender`, 'err');
    return;
  }

  const exist = inv.cart.find(i =>
    i.pid === pid &&
    !i.resale_source &&
    posMoneyEq(i.price, price)
  );

  if (exist) {
    const idx = inv.cart.indexOf(exist);
    const maxForLine = Math.max(0, _posAvailableStock(prod) - posCartQtyForProduct(pid, idx));
    if (exist.qty >= maxForLine) { toast('No hay más stock', 'err'); return; }
    exist.qty++;
  } else {
    inv.cart.push({
      pid,
      product_id:   prod.id,
      product_code: prod.code,
      product_name: prod.name,
      name:         prod.name,
      price,
      unit_price:   price,
      unit_cost:    prod.cost,
      cost:         prod.cost,
      taxable:      prod.taxable === 0 ? 0 : 1,
      tax_pct:      parseFloat(prod.tax_pct ?? CFG.itbis ?? 18) || 18,
      manual_price:  false,
      qty: 1
    });
  }
  renderInvTabs();
  renderCart();
}

// ── Render carrito ────────────────────────────
function renderCart() {
  const wrap = document.getElementById('cart-wrap');
  if (!wrap) return;

  const inv = currentInv();
  const checkoutLocked = !!inv.checkoutOrderId;
  const { subtotal, itbis, total, disc, discAmt, chargesTotal } = calcTotals(inv);

  let html = `
    <div class="cart-hdr">
      <div class="fxb">
        <div>
          <span style="font-weight:700;font-size:13px">${checkoutLocked ? `Orden ${posEscHtml(inv.checkoutOrderNumber || '')}` : `Factura #${inv.id}`}</span>
          <span style="font-size:10px;color:var(--muted);margin-left:8px">
            ${inv.cart.length} artículo${inv.cart.length !== 1 ? 's' : ''}
          </span>
        </div>
        <button class="btn btn-ghost btn-sm" onclick="${checkoutLocked ? 'posCloseCheckoutOrder()' : 'posLimpiar()'}">
          ${checkoutLocked ? 'Cerrar orden' : `${svg('trash')} Limpiar`}
        </button>
      </div>
      ${checkoutLocked ? `<div class="alrt g" style="margin-top:8px;padding:7px 9px"><div><div class="alrt-title">Lista para cobrar</div><div class="alrt-sub">Los articulos y precios estan bloqueados porque vienen de despacho.</div></div></div>` : `<div class="flex" style="margin-top:8px;gap:5px">
        ${(inv.replacesSaleId ? ['factura'] : ['factura','cotizacion']).map(t => `
          <button class="btn btn-sm ${inv.itype === t ? 'btn-dark' : 'btn-out'}"
                  style="font-size:10px;padding:3px 9px"
                  onclick="posSetType('${t}')">
            ${t === 'factura' ? 'Factura' : 'Cotización'}
          </button>`).join('')}
      </div>`}
      ${inv.replacesSaleId ? `
        <div style="margin-top:8px;padding:7px 9px;border:1px solid var(--amber-line);
                    border-radius:7px;background:var(--amber-bg);font-size:10.5px;color:var(--muted2)">
          <strong style="color:var(--text)">Registro sustitutivo · ${posEscHtml(inv.replacementDocumentNumber || '')}</strong>
          <span> — conserva únicamente el número comercial; la anulación original seguirá auditada.</span>
        </div>` : ''}
    </div>`;

  html += `<div class="cart-body">`;
  if (!inv.cart.length) {
    html += `
      <div class="cart-empty">
        <div>${svg('box')}</div>
        <p>Carrito vacío</p>
        <span style="font-size:11px;color:var(--muted2)">
          Selecciona productos del panel izquierdo
        </span>
      </div>`;
  } else {
    inv.cart.forEach((item, idx) => {
      html += `
        <div class="cart-item">
          <div class="ci-info">
            <div class="ci-name">${posEscHtml(item.name)}</div>
            <div class="ci-price" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
              <span style="font-size:10px;color:var(--muted2);font-weight:600">Precio final</span>
              ${checkoutLocked ? `<strong>${fmt(item.price)}</strong>` : `<input type="number" min="0" step="0.01" value="${Number(item.price || 0).toFixed(2)}"
                style="width:92px;text-align:right;font-size:12px;font-weight:700;
                       border:1px solid var(--line);border-radius:4px;padding:2px 5px;
                       font-family:inherit;background:var(--surface)"
                onchange="posSetPrice(${idx},this.value)"
                onkeydown="if(event.key==='Enter')this.blur()"
                onclick="this.select()"/>`}
              ${item.taxable === 0 ? '' : `<span style="font-size:10px;color:var(--blue);font-weight:700">ITBIS incl.</span>`}
            </div>
            ${item.resale_source?.saleId ? `
              <div style="font-size:10px;color:var(--green);font-weight:700;margin-top:3px">
                ${inv.replacesSaleId ? 'Línea de factura anulada' : 'Reventa de venta'} #${String(item.resale_source.saleId).padStart(5,'0')}
              </div>` : ''}
          </div>
          ${checkoutLocked ? `<div class="qc"><strong>x${item.qty}</strong></div>` : `<div class="qc">
            <button class="qb" onclick="posQty(${idx},-1)">−</button>
            <input type="number" min="1" value="${item.qty}"
              style="width:42px;text-align:center;font-size:12px;font-weight:700;
                     border:1px solid var(--line);border-radius:4px;padding:2px 4px;
                     font-family:inherit;background:var(--surface)"
              oninput="posSetQty(${idx},this)"
              onblur="posCommitQty(${idx},this)"
              onkeydown="if(event.key==='Enter')this.blur()"
              onclick="this.select()"/>
            <button class="qb" onclick="posQty(${idx},1)">+</button>
          </div>`}
          <div class="ci-total">${fmt(item.price * item.qty)}</div>
          ${checkoutLocked ? '' : `<button class="qb" style="margin-left:4px;color:var(--red)"
                  onclick="posRemItem(${idx})">×</button>`}
        </div>`;
    });
  }
  html += `</div>`;

  html += `
    <div class="cart-foot">
      ${checkoutLocked ? `
      <div class="tr" style="margin-bottom:8px"><span>Origen</span><strong>${posEscHtml(inv.checkoutOrderNumber || 'Orden de despacho')}</strong></div>
      <div style="font-size:10px;color:var(--green);margin-bottom:7px">Caja puede aplicar un descuento autorizado y cargos adicionales antes de cobrar.</div>
      ` : ''}
      <div class="flex" style="margin-bottom:8px;gap:6px;align-items:center">
        <span style="font-size:11px;color:var(--muted);flex:1">Descuento</span>
        <select class="inp" style="width:58px;padding:4px;font-size:12px"
                onchange="posDiscMode(this.value)" title="Tipo de descuento">
          <option value="pct" ${(inv.discMode || 'pct') !== 'amt' ? 'selected' : ''}>%</option>
          <option value="amt" ${inv.discMode === 'amt' ? 'selected' : ''}>RD$</option>
        </select>
        <input type="number" min="0" ${inv.discMode === 'amt' ? 'step="0.01"' : 'max="100"'}
               value="${inv.discMode === 'amt' ? (inv.discAmtInput || 0) : (inv.disc || 0)}"
               id="pos-discount-input" inputmode="decimal" autocomplete="off"
               class="inp" style="width:72px;padding:4px 7px;font-size:12px;text-align:right"
               onfocus="this.select()"
               oninput="posDiscConPin(this, this.value)"/>
      </div>
      ${inv.itype === 'factura' ? `
      <div style="border-top:1px solid var(--line2);padding-top:7px;margin-top:4px">
        ${(inv.charges || []).map((charge, idx) => `
          <div class="tr" style="font-size:11px">
            <span>${posEscHtml(charge.description)}
              <button class="btn btn-ghost btn-sm" style="padding:0 4px;color:var(--red)" onclick="posRemoveCharge(${idx})">×</button>
            </span>
            <span>${fmt(charge.amount)}</span>
          </div>`).join('')}
        <button class="btn btn-out btn-sm btn-fw" type="button" onclick="openPosChargeModal()"
                style="margin:3px 0 7px">${svg('plus')} Agregar envío u otro cargo</button>
      </div>` : ''}
      <div class="tr"><span>Subtotal sin ITBIS</span><span id="pos-subtotal-value">${fmt(subtotal)}</span></div>
      ${inv.itype === 'factura' && itbis > 0
        ? `<div class="tr"><span>ITBIS (${CFG.itbis}%)</span><span id="pos-itbis-value">${fmt(itbis)}</span></div>` : ''}
      <div class="tr" id="pos-discount-row" style="${disc > 0 ? '' : 'display:none'}">
        <span>Descuento</span><span id="pos-discount-value">−${fmt(discAmt)}</span>
      </div>
      <div class="tr" id="pos-charges-row" style="${chargesTotal > 0 ? '' : 'display:none'}">
        <span>Cargos adicionales</span><span id="pos-charges-value">${fmt(chargesTotal)}</span>
      </div>
      <div class="tr grand"><span>TOTAL</span><span id="pos-total-value">${fmt(total)}</span></div>
      <div style="margin-top:7px">
        <button class="btn btn-ghost btn-sm btn-fw" type="button" onclick="posToggleUsd()">
          ${inv.displayCurrency === 'USD' ? 'Mostrar total en pesos' : 'Convertir total a dólares'}
        </button>
        ${inv.displayCurrency === 'USD' ? `
          <div style="display:grid;grid-template-columns:1fr 88px;gap:7px;align-items:center;margin-top:6px;padding:7px 9px;background:var(--blue-bg);border:1px solid var(--blue-line);border-radius:7px">
            <div>
              <div style="font-size:10px;color:var(--muted)">Equivalente</div>
              <strong id="pos-usd-total">${_cbrMoney(total / (Number(inv.displayExchangeRate) || 1), 'USD')}</strong>
            </div>
            <div>
              <label style="display:block;font-size:9px;color:var(--muted)">Tasa venta</label>
              <input class="inp" type="number" min="20" max="500" step="0.01"
                     value="${Number(inv.displayExchangeRate || 0) || ''}"
                     oninput="posSetUsdRate(this.value)" style="padding:4px 6px;text-align:right"/>
            </div>
          </div>` : ''}
      </div>
      ${!checkoutLocked && inv.itype === 'factura' && preventaCanAccess() ? `<button class="btn btn-out btn-fw" id="pos-send-checkout-btn"
              style="margin-top:12px;font-size:12px;opacity:${inv.cart.length ? '1' : '.4'}"
              ${inv.cart.length ? '' : 'disabled'} onclick="openCheckoutSendModal(invoices[activeInvoice])">
        ${svg('send')} Enviar a caja
      </button>` : ''}
      <button class="btn btn-green btn-fw btn-lg" id="pos-charge-btn"
              style="margin-top:12px;font-size:14px;opacity:${inv.cart.length ? '1' : '.4'}"
              ${inv.cart.length ? '' : 'disabled'}
              onclick="openCobroModal(invoices[activeInvoice])">
        ${inv.itype === 'cotizacion'
          ? `${svg('receipt')} Cotizar ${fmt(total)}`
          : `${svg('cash')} ${checkoutLocked ? `Cobrar ${posEscHtml(inv.checkoutOrderNumber || '')}` : `Cobrar ${fmt(total)}`}`}
      </button>
    </div>`;

  wrap.innerHTML = html;
}

// ── Helpers carrito ───────────────────────────
function posLimpiar() {
  if (currentInv().checkoutOrderId) return posCloseCheckoutOrder();
  const inv = currentInv();
  inv.cart = [];
  inv.replacesSaleId = null;
  inv.replacementDocumentNumber = '';
  renderInvTabs();
  renderCart();
}

function posSetType(t) {
  if (currentInv().checkoutOrderId) return;
  if (currentInv().replacesSaleId && t !== 'factura') {
    toast('El reemplazo controlado debe registrarse como factura', 'w');
    return;
  }
  currentInv().itype = t;
  renderCart();
}

function posCloseCheckoutOrder() {
  removeInvoice(activeInvoice);
  renderInvTabs();
  renderCart();
  renderPOSGrid();
}

function openPosChargeModal() {
  const inv = currentInv();
  if (!inv || inv.itype !== 'factura') return;
  openModal(`
    <div class="modal-title">Agregar cargo a la factura</div>
    <div class="modal-sub">Para envío, instalación, transporte u otro servicio asociado a esta venta.</div>
    <div class="fg">
      <label class="lbl">Concepto *</label>
      <input class="inp" id="pos-charge-description" maxlength="120" placeholder="Ej: Envío a domicilio"/>
    </div>
    <div class="fg">
      <label class="lbl">Monto (RD$) *</label>
      <input class="inp" id="pos-charge-amount" type="number" min="0.01" max="9999999" step="0.01" placeholder="0.00"/>
    </div>
    <div class="modal-foot">
      <button class="btn btn-out" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-dark" onclick="posSaveCharge()">${svg('check')} Agregar cargo</button>
    </div>
  `);
  setTimeout(() => document.getElementById('pos-charge-description')?.focus(), 60);
}

function posSaveCharge() {
  const inv = currentInv();
  const description = document.getElementById('pos-charge-description')?.value?.replace(/\s+/g, ' ').trim() || '';
  const amount = _posRound2(document.getElementById('pos-charge-amount')?.value);
  if (!description) return toast('Indica el concepto del cargo', 'w');
  if (!(amount > 0) || amount > 9999999) return toast('Indica un monto válido', 'w');
  inv.charges = Array.isArray(inv.charges) ? inv.charges : [];
  if (inv.charges.length >= 20) return toast('La factura alcanzó el máximo de cargos adicionales', 'w');
  inv.charges.push({ description, amount });
  closeModal();
  renderInvTabs();
  renderCart();
}

function posRemoveCharge(index) {
  const inv = currentInv();
  if (!Array.isArray(inv.charges)) return;
  inv.charges.splice(index, 1);
  renderInvTabs();
  renderCart();
}

async function posToggleUsd() {
  const inv = currentInv();
  if (inv.displayCurrency === 'USD') {
    inv.displayCurrency = 'DOP';
    renderCart();
    return;
  }
  inv.displayCurrency = 'USD';
  if (!(Number(inv.displayExchangeRate) >= 20)) {
    const cached = Number((typeof _ratesData !== 'undefined' && _ratesData?.usd?.venta?.value) || 0);
    if (cached >= 20) inv.displayExchangeRate = cached;
    else {
      try {
        const res = await window.api?.banner?.getRates?.();
        const live = Number(res?.data?.usd?.venta?.value || 0);
        if (live >= 20) inv.displayExchangeRate = live;
      } catch {}
    }
  }
  renderCart();
}

function posSetUsdRate(value) {
  const inv = currentInv();
  inv.displayExchangeRate = Number(value) || 0;
  const totalEl = document.getElementById('pos-usd-total');
  const rate = Number(inv.displayExchangeRate);
  if (totalEl) totalEl.textContent = rate >= 20 && rate <= 500
    ? _cbrMoney(calcTotals(inv).total / rate, 'USD')
    : 'Tasa inválida';
}

function posCartQtyForProduct(productId, exceptIdx = -1) {
  return currentInv().cart.reduce((sum, item, idx) => {
    if (idx === exceptIdx) return sum;
    return Number(item.product_id || item.pid) === Number(productId)
      ? sum + (Number(item.qty) || 0)
      : sum;
  }, 0);
}

function posQty(idx, delta) {
  const inv  = currentInv();
  if (inv.checkoutOrderId) return;
  const item = inv.cart[idx];
  if (!item) return;
  const prod = DB.products.find(p => p.id === item.pid);
  const maxForLine = Math.max(0, (prod ? _posAvailableStock(prod) : 999) - posCartQtyForProduct(prod?.id || item.product_id || item.pid, idx));
  item.qty += delta;
  if (delta > 0 && item.qty > maxForLine) {
    item.qty = maxForLine;
    toast('Sin más stock', 'w');
  }
  if (item.qty <= 0) inv.cart.splice(idx, 1);
  renderInvTabs();
  renderCart();
}

function posSetQty(idx, input) {
  const inv  = currentInv();
  if (inv.checkoutOrderId) return;
  const item = inv.cart[idx];
  if (!item) return;
  const raw = typeof input === 'object' ? input.value : input;
  // Mientras el usuario reemplaza el valor, el campo puede quedar vacío por un
  // instante. No lo conviertas prematuramente a 1 ni redibujes el carrito.
  if (String(raw).trim() === '') return;
  const prod = DB.products.find(p => p.id === item.pid);
  const maxForLine = Math.max(0, (prod ? _posAvailableStock(prod) : 999) - posCartQtyForProduct(prod?.id || item.product_id || item.pid, idx));
  if (maxForLine <= 0) {
    inv.cart.splice(idx, 1);
    toast('Sin stock disponible para esa línea', 'w');
    renderInvTabs();
    renderCart();
  } else {
    const requested = Math.max(1, parseInt(raw, 10) || 1);
    item.qty = Math.min(requested, maxForLine);
    if (requested > maxForLine) {
      if (typeof input === 'object') input.value = item.qty;
      toast(`Máximo disponible: ${maxForLine}`, 'w');
    }
    posRefreshCartTotals();
  }
}

function posCommitQty(idx, input) {
  const item = currentInv()?.cart?.[idx];
  if (!item) return;
  if (!String(input?.value || '').trim()) {
    input.value = item.qty;
    return;
  }
  posSetQty(idx, input);
}

function posEscHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function posMoneyEq(a, b) {
  return Math.abs((Number(a) || 0) - (Number(b) || 0)) < 0.005;
}

function posLineCatalogPrices(item) {
  const prod = DB.products.find(p => p.id === (item?.product_id || item?.pid));
  if (!prod) return [];
  const retail = Math.round((Number(prod.price) || 0) * 100) / 100;
  const wholesaleRaw = Number(prod.wholesale) || 0;
  const wholesale = Math.round((wholesaleRaw > 0 ? wholesaleRaw : retail) * 100) / 100;
  return posMoneyEq(retail, wholesale)
    ? [{ label: 'Detalle', value: retail }]
    : [{ label: 'Detalle', value: retail }, { label: 'Mayorista', value: wholesale }];
}

function posFindPriceOverrides(items) {
  return (items || []).map(item => {
    const unitPrice = Math.round((Number(item?.unit_price ?? item?.price) || 0) * 100) / 100;
    const catalogPrices = posLineCatalogPrices(item);
    if (!catalogPrices.length || catalogPrices.some(p => posMoneyEq(p.value, unitPrice))) return null;
    return { item, unitPrice, catalogPrices };
  }).filter(Boolean);
}

function posAuthStillValid(holder) {
  return !!(
    holder?.priceChangeAuthToken &&
    holder?.priceChangeAuthExpiresAt &&
    Number(holder.priceChangeAuthExpiresAt) > Date.now() + 5000
  );
}

function posStorePriceAuth(holder, auth) {
  if (!holder || !auth) return;
  holder.priceChangeAuthToken = auth.token;
  holder.priceChangeAuthExpiresAt = auth.expiresAt;
  holder.priceChangeApprovedBy = auth.approvedBy?.id || null;
  holder.priceChangeApprovedName = auth.approvedBy?.name || '';
  holder.priceChangeApprovedRole = auth.approvedBy?.role || '';
}

async function posPromptPriceChangeAuth(changes, contextLabel = 'Cambio de precio en POS') {
  const first = changes[0];
  const itemName = first?.item?.product_name || first?.item?.name || 'Producto';
  const catalogText = (first?.catalogPrices || [])
    .map(p => `${p.label}: ${fmt(p.value)}`)
    .join(' · ');
  const detail = `${itemName}: ${catalogText || 'precio de catálogo'} -> ${fmt(first?.unitPrice || 0)}`;

  return new Promise(resolve => {
    let done = false;
    const finish = value => {
      if (done) return;
      done = true;
      resolve(value);
    };

    openModal(`
      <div class="modal-title">Autorizar cambio de precio</div>
      <div class="modal-sub">
        Esta operación requiere la clave especial de cambio de precio.
      </div>
      <div class="alrt a" style="margin-bottom:14px">
        <div class="alrt-dot a"></div>
        <div>
          <div class="alrt-title">${posEscHtml(contextLabel)}</div>
          <div class="alrt-sub">${posEscHtml(detail)}${changes.length > 1 ? ` · ${changes.length - 1} cambio(s) adicional(es)` : ''}</div>
        </div>
      </div>
      <div class="fg">
        <label class="lbl">Clave especial de cambio de precio</label>
        <div class="inp-ic">
          <div class="ic">${svg('lock')}</div>
          <input class="inp" id="price-auth-pass" type="password"
                 placeholder="Clave especial"/>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-out" id="price-auth-cancel">Cancelar</button>
        <button class="btn btn-dark" id="price-auth-ok">
          ${svg('check')} Autorizar precio
        </button>
      </div>
    `);

    const passEl = document.getElementById('price-auth-pass');
    const okBtn = document.getElementById('price-auth-ok');
    const cancelBtn = document.getElementById('price-auth-cancel');
    const submit = async () => {
      const password = passEl?.value?.trim();
      if (!password) { toast('Ingresa la contraseña', 'err'); return; }
      if (okBtn) {
        okBtn.disabled = true;
        okBtn.innerHTML = `${svg('clock')} Validando...`;
      }
      const res = await window.api.auth.authorizePrivilegedAction({
        action: 'pos_price_change',
        password,
        requestUserId: user.id,
        detail,
      }).catch(e => ({ ok: false, error: e?.message || 'No se pudo validar' }));
      if (!res?.ok) {
        toast(res?.error || 'Contraseña incorrecta', 'err');
        if (okBtn) {
          okBtn.disabled = false;
          okBtn.innerHTML = `${svg('check')} Autorizar precio`;
        }
        passEl?.select();
        return;
      }
      closeModal();
      finish(res);
    };

    okBtn?.addEventListener('click', submit);
    cancelBtn?.addEventListener('click', () => { closeModal(); finish(null); });
    passEl?.addEventListener('keydown', e => {
      if (e.key === 'Enter') submit();
      if (e.key === 'Escape') { closeModal(); finish(null); }
    });
    setTimeout(() => passEl?.focus(), 80);
  });
}

async function posEnsureSalePriceAuthorization(holder, items, contextLabel) {
  const changes = posFindPriceOverrides(items);
  if (!changes.length) return true;
  // Las ordenes compartidas son inmutables y el backend ya valido/aprobo sus
  // precios al enviarlas desde despacho.
  if (holder?.checkoutOrderId) return true;
  if (['admin', 'superadmin'].includes(user?.role)) return true;
  if (posAuthStillValid(holder)) return true;
  if (DB?.settings?.pos_price_change_password_set === '0') {
    toast('Configura primero la clave especial de cambio de precio en Configuración', 'err');
    return false;
  }

  const auth = await posPromptPriceChangeAuth(changes, contextLabel);
  if (!auth) return false;
  posStorePriceAuth(holder, auth);
  return true;
}

async function posSetPrice(idx, val) {
  const inv  = currentInv();
  if (inv.checkoutOrderId) return;
  const item = inv.cart[idx];
  if (!item) return;
  const price = Math.round(Math.max(0, parseFloat(val) || 0) * 100) / 100;
  if (price <= 0) {
    toast('El precio final debe ser mayor a 0', 'err');
    renderCart();
    return;
  }
  const ok = await posEnsureSalePriceAuthorization(
    inv,
    [{ ...item, unit_price: price, price }],
    `Producto: ${item.name || item.product_name || ''}`
  );
  if (!ok) {
    renderCart();
    return;
  }
  item.price = price;
  item.unit_price = price;
  item.manual_price = true;
  renderInvTabs();
  renderCart();
}

function posRemItem(idx) {
  if (currentInv().checkoutOrderId) return;
  currentInv().cart.splice(idx, 1);
  renderInvTabs();
  renderCart();
}

function posLoadResaleCart(payload = {}) {
  if (!document.getElementById('cart-wrap')) {
    window._pendingPOSResaleCart = payload;
    return false;
  }
  const rawItems = Array.isArray(payload.items) ? payload.items : [];
  if (!rawItems.length) { toast('No hay artículos de reventa para cargar', 'w'); return false; }

  const reserved = new Map();
  const skipped = [];
  const cart = [];

  rawItems.forEach(src => {
    const prod = DB.products.find(p =>
      p.active !== 0 && (
        Number(p.id) === Number(src.product_id) ||
        (src.product_code && String(p.code || '').trim().toLowerCase() === String(src.product_code).trim().toLowerCase())
      )
    );
    if (!prod) { skipped.push(src.product_name || 'Producto no vinculado'); return; }

    const used = reserved.get(prod.id) || 0;
    const available = Math.max(0, _posAvailableStock(prod) - used);
    const qty = Math.min(Math.max(1, Number.parseInt(src.qty, 10) || 1), available);
    const price = Math.round((Number(src.unit_price || src.price) || 0) * 100) / 100;
    if (qty <= 0) { skipped.push(prod.name); return; }
    if (price <= 0) { skipped.push(`${prod.name} sin precio`); return; }

    const taxable = src.taxable === undefined || src.taxable === null
      ? (prod.taxable === 0 ? 0 : 1)
      : (src.taxable === 0 || src.taxable === false || src.taxable === '0' ? 0 : 1);
    const taxPct = taxable
      ? (parseFloat(src.tax_pct ?? prod.tax_pct ?? CFG.itbis ?? 18) || 18)
      : 0;

    reserved.set(prod.id, used + qty);
    cart.push({
      pid:          prod.id,
      product_id:   prod.id,
      product_code: prod.code || src.product_code || '',
      product_name: src.product_name || prod.name,
      name:         src.product_name || prod.name,
      price,
      unit_price:   price,
      unit_cost:    prod.cost || 0,
      cost:         prod.cost || 0,
      taxable,
      tax_pct:      taxPct,
      qty,
      resale_source: {
        saleId: src.source_sale_id || null,
        itemId: src.source_item_id || null,
      },
    });
  });

  if (!cart.length) {
    toast('No se pudo cargar la reventa: los artículos no tienen stock disponible', 'err');
    return false;
  }

  let inv = currentInv();
  if (inv.cart.length) {
    addInvoice();
    inv = currentInv();
  }

  inv.cart = cart;
  inv.itype = 'factura';
  inv.pmode = payload.priceMode === 'wholesale' ? 'wholesale' : 'retail';
  inv.pmeth = 'efectivo';
  inv.disc = Math.max(0, Math.min(100, Number(payload.discountPct) || 0));
  inv.discAmtInput = 0;
  inv.charges = Array.isArray(payload.charges)
    ? payload.charges.map(row => ({
        description: String(row.description || ''),
        amount: Number(row.amount || 0),
      })).filter(row => row.description && row.amount > 0)
    : [];
  inv.notes = String(payload.notes || '');
  inv.replacesSaleId = Number(payload.replacementOfSaleId) || null;
  inv.replacementDocumentNumber = String(payload.replacementDocumentNumber || '');
  inv.priceChangeAuthToken = null;
  inv.priceChangeAuthExpiresAt = null;
  inv.priceChangeApprovedBy = null;

  if (payload.customer?.id) {
    inv.cliId = payload.customer.id;
    inv.cliName = payload.customer.name || '';
    inv.cliCedula = payload.customer.rnc || '';
  }

  renderInvTabs();
  renderCart();
  renderPOSGrid();
  if (typeof window.ventasClearResaleCart === 'function') window.ventasClearResaleCart(true);
  toast(inv.replacesSaleId
    ? `✓ ${inv.replacementDocumentNumber || 'Factura anulada'} lista para corregir y registrar nuevamente`
    : `✓ Reventa cargada en factura #${inv.id}${skipped.length ? ` · ${skipped.length} línea(s) omitida(s)` : ''}`);
  return true;
}

window.posLoadResaleCart = posLoadResaleCart;

function posDisc(val) {
  currentInv().disc = Math.min(100, Math.max(0, parseFloat(val) || 0));
  posRefreshCartTotals();
}

// Actualiza únicamente los importes del pie. Re-renderizar todo el carrito en
// cada `input` reemplazaba el campo activo y hacía perder el foco después del
// primer dígito, tanto en RD$ como en porcentaje.
function posRefreshCartTotals() {
  const inv = currentInv();
  if (!inv) return;
  const { subtotal, itbis, total, disc, discAmt, chargesTotal } = calcTotals(inv);
  const setText = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };
  setText('pos-subtotal-value', fmt(subtotal));
  setText('pos-itbis-value', fmt(itbis));
  setText('pos-discount-value', `−${fmt(discAmt)}`);
  setText('pos-total-value', fmt(total));
  setText('pos-charges-value', fmt(chargesTotal));

  const discRow = document.getElementById('pos-discount-row');
  if (discRow) discRow.style.display = disc > 0 ? '' : 'none';
  const chargesRow = document.getElementById('pos-charges-row');
  if (chargesRow) chargesRow.style.display = chargesTotal > 0 ? '' : 'none';
  const usdTotal = document.getElementById('pos-usd-total');
  if (usdTotal && inv.displayCurrency === 'USD') {
    const rate = Number(inv.displayExchangeRate);
    usdTotal.textContent = rate >= 20 && rate <= 500
      ? _cbrMoney(total / rate, 'USD') : 'Tasa inválida';
  }

  const chargeBtn = document.getElementById('pos-charge-btn');
  if (chargeBtn) {
    chargeBtn.disabled = !inv.cart.length;
    chargeBtn.style.opacity = inv.cart.length ? '1' : '.4';
    chargeBtn.innerHTML = inv.itype === 'cotizacion'
      ? `${svg('receipt')} Cotizar ${fmt(total)}`
      : `${svg('cash')} Cobrar ${fmt(total)}`;
  }

  // La pestaña muestra el total, pero vive fuera del carrito: puede repintarse
  // sin tocar ni desenfocar el campo de descuento.
  renderInvTabs();
}

// Cambia entre descuento por porcentaje y por monto fijo. El modelo interno
// SIEMPRE es porcentaje (inv.disc) — el resto del flujo (cobro, servidor,
// recibos) no cambia; el modo monto solo convierte RD$ → % equivalente.
function posDiscMode(m) {
  const inv = currentInv();
  inv.discMode = m === 'amt' ? 'amt' : 'pct';
  inv.disc = 0;
  inv.discAmtInput = 0;
  inv.discApprovedBy = null;
  inv.discAuthToken = null;
  renderCart();
}

// Descuento con PIN para valores mayores al límite
const DISC_LIMIT = 10; // % máximo sin autorización del admin
function posDiscConPin(input, val) {
  const inv  = currentInv();
  const mode = inv.discMode || 'pct';
  let pct, amt = 0;
  if (mode === 'amt') {
    const gross = _posRound2(inv.cart.reduce((a, i) => a + ((Number(i.price) || 0) * (Number(i.qty) || 0)), 0));
    amt = Math.max(0, parseFloat(val) || 0);
    if (gross <= 0) { input.value = 0; return; }
    if (amt > gross) { amt = gross; input.value = amt; }
    pct = (amt / gross) * 100;
  } else {
    pct = Math.min(100, Math.max(0, parseFloat(val) || 0));
  }

  // Cualquier cambio invalida una autorización previa — debe re-autorizarse
  // si el nuevo valor también supera el límite.
  inv.discApprovedBy = null;
  inv.discAuthToken = null;

  const aplicar = () => { if (mode === 'amt') inv.discAmtInput = amt; posDisc(pct); };

  // Admin y superadmin no necesitan PIN; sin restricción bajo el límite
  if (['admin', 'superadmin'].includes(user?.role) || pct <= DISC_LIMIT) { aplicar(); return; }

  // Revertir el input visualmente y pedir autorización
  input.value = mode === 'amt' ? (inv.discAmtInput || 0) : (inv.disc || 0);
  const pctShow = Math.round(pct * 100) / 100;
  openModal(`
    <div class="modal-title">Descuento requiere autorización</div>
    <div class="modal-sub">
      Los descuentos mayores al ${DISC_LIMIT}% requieren aprobación de un admin o superadmin.
    </div>
    <div class="alrt a" style="margin-bottom:14px">
      <div class="alrt-dot a"></div>
      <div>
        <div class="alrt-title">Descuento solicitado: ${mode === 'amt' ? `${fmt(amt)} (${pctShow}%)` : `${pctShow}%`}</div>
        <div class="alrt-sub">Ingresa la contraseña de admin o superadmin para autorizar.</div>
      </div>
    </div>
    <div class="fg">
      <label class="lbl">Contraseña de admin o superadmin</label>
      <div class="inp-ic">
        <div class="ic">${svg('lock')}</div>
        <input class="inp" id="pin-pass" type="password"
               placeholder="Contraseña de admin o superadmin"/>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-out" id="pin-cancel">Cancelar</button>
      <button class="btn btn-dark" id="pin-ok">
        ${svg('check')} Autorizar descuento
      </button>
    </div>
  `);
  document.getElementById('pin-ok')?.addEventListener('click', () => autorizarDescuento(pct, mode, amt));
  document.getElementById('pin-cancel')?.addEventListener('click', closeModal);
  document.getElementById('pin-pass')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') autorizarDescuento(pct, mode, amt);
  });
  setTimeout(() => document.getElementById('pin-pass')?.focus(), 100);
}

async function autorizarDescuento(pct, mode = 'pct', amt = 0) {
  const pass = document.getElementById('pin-pass')?.value?.trim();
  if (!pass) { toast('Ingresa la contraseña', 'err'); return; }

  const pctShow = Math.round(pct * 100) / 100;
  const res = await window.api.auth.authorizePrivilegedAction({
    action: 'pos_discount_override',
    password: pass,
    requestUserId: user.id,
    detail: mode === 'amt' ? `Descuento ${fmt(amt)} (${pctShow}%)` : `Descuento ${pctShow}%`,
  }).catch(e => ({ ok: false, error: e?.message || 'No se pudo validar' }));

  if (!res?.ok) {
    toast(res?.error || 'Contraseña incorrecta', 'err');
    document.getElementById('pin-pass')?.select();
    return;
  }

  closeModal();
  const inv = currentInv();
  inv.discApprovedBy = res.approvedBy?.id || null;
  inv.discAuthToken = res.token || null;
  if (mode === 'amt') inv.discAmtInput = amt;
  const discountInput = document.getElementById('pos-discount-input');
  if (discountInput) discountInput.value = mode === 'amt' ? amt : pctShow;
  posDisc(pct);
  toast(`✓ Descuento de ${mode === 'amt' ? fmt(amt) : pctShow + '%'} autorizado`);
}

// ── Calcular totales ──────────────────────────
function _posRound2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function _posTaxPct(item) {
  const pct = parseFloat(item?.tax_pct ?? CFG.itbis ?? 18);
  return Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 18;
}

function _posTaxable(item) {
  return item?.taxable !== 0 && item?.taxable !== false && item?.taxable !== '0';
}

function calcTotals(inv) {
  const disc = Math.min(100, Math.max(0, parseFloat(inv.disc) || 0));
  const grossSubtotal = _posRound2(inv.cart.reduce((a, i) => a + ((Number(i.price) || 0) * (Number(i.qty) || 0)), 0));
  const discAmt = _posRound2(grossSubtotal * (disc / 100));
  const itemsTotal = _posRound2(grossSubtotal - discAmt);
  const chargesTotal = inv.itype === 'factura'
    ? _posRound2((inv.charges || []).reduce((sum, row) => sum + (Number(row.amount) || 0), 0))
    : 0;
  const total = _posRound2(itemsTotal + chargesTotal);
  const factor = 1 - (disc / 100);

  let taxAcc = 0;
  inv.cart.forEach(item => {
    const lineAfterDiscount = ((Number(item.price) || 0) * (Number(item.qty) || 0)) * factor;
    if (inv.itype !== 'factura' || !_posTaxable(item)) return;
    const pct = _posTaxPct(item);
    if (pct <= 0) return;
    const net = lineAfterDiscount / (1 + (pct / 100));
    taxAcc += (lineAfterDiscount - net);
  });

  const itbis = inv.itype === 'factura' ? _posRound2(taxAcc) : 0;
  const subtotal = _posRound2(itemsTotal - itbis);
  return { subtotal, grossSubtotal, discAmt, itbis, itemsTotal, chargesTotal, total, disc };
}

function invTotal(inv) { return calcTotals(inv).total; }

// ══════════════════════════════════════════════
// ENVIAR A CAJA — PREVENTA COMPARTIDA
// ══════════════════════════════════════════════
function pvCustomerMatches(customer, query) {
  if (!customer || customer.active === 0 || Number(customer.id) === 1) return false;
  const term = searchNorm(query);
  const termDigits = digitsOf(query);
  if (!term && !termDigits) return true;

  const searchable = searchNorm([
    customer.name, customer.trade_name, customer.rnc, customer.phone, customer.email, customer.billing_email,
    ...(customer.phones || []).map(p => p.phone),
  ].filter(Boolean).join(' '));
  if (term && searchable.includes(term)) return true;
  return termDigits.length > 0 && [customer.rnc, customer.phone, ...(customer.phones || []).map(p => p.phone)]
    .some(value => digitsOf(value).includes(termDigits));
}

function pvContactMatches(contact, query) {
  const term = searchNorm(query);
  const termDigits = digitsOf(query);
  const searchable = searchNorm([contact?.name, contact?.role, contact?.email].filter(Boolean).join(' '));
  if (term && searchable.includes(term)) return true;
  return termDigits.length > 0 && [contact?.document, contact?.phone]
    .some(value => digitsOf(value).includes(termDigits));
}

function pvCustomerOptions(query, showAll = false) {
  const typed = String(query || '').trim();
  const options = [];
  for (const customer of (DB.customers || [])) {
    if (!customer || customer.active === 0 || Number(customer.id) === 1) continue;
    if (showAll || pvCustomerMatches(customer, typed)) options.push({ customer, contact: null });
    if (!showAll && typed) {
      for (const contact of (customer.contacts || [])) {
        if (contact.active !== 0 && contact.can_order !== 0 && pvContactMatches(contact, typed)) options.push({ customer, contact });
      }
    }
    if (options.length >= 10) break;
  }
  return options.slice(0, 10);
}

// Selector permanente del POS. La identidad se guarda en la factura activa
// antes de agregar artículos, para que el catálogo y el carrito nazcan con el
// precio preferido del cliente (detalle o mayorista).
function renderPOSCustomerSelection() {
  const inv = currentInv();
  const input = document.getElementById('pos-customer-search');
  const state = document.getElementById('pos-customer-state');
  const customer = (DB.customers || []).find(c => Number(c.id) === Number(inv.cliId));
  const contact = (customer?.contacts || []).find(c => Number(c.id) === Number(inv.cliContactId));
  if (input) input.value = Number(inv.cliId) !== 1 && customer ? customer.name : 'Consumidor Final';
  if (state) {
    if (Number(inv.cliId) !== 1 && customer) {
      state.style.color = 'var(--green)';
      state.textContent = `${customer.customer_type === 'company' ? 'Empresa' : 'Cliente'}: ${customer.name}` +
        `${contact ? ` · ${contact.name}` : ''}${inv.cliBranchName ? ` · Entregar en: ${inv.cliBranchName}` : ''} · ${inv.pmode === 'wholesale' ? 'Mayorista' : 'Detalle'}`;
      state.title = state.textContent;
    } else {
      state.style.color = 'var(--muted)';
      state.textContent = 'Consumidor Final · Precio detalle';
      state.title = state.textContent;
    }
  }
  renderPOSBranchSelection(customer);
}

// Selector "Sucursal de entrega": visible solo para empresas con sucursales.
// La empresa sigue siendo dueña del RNC/crédito; esto solo elige dónde entregar.
function renderPOSBranchSelection(customer) {
  const bar = document.getElementById('pos-branch-bar');
  if (!bar) return;
  const inv = currentInv();
  const branches = (customer?.customer_type === 'company' ? (customer.branches || []) : [])
    .filter(b => b.active !== 0);
  if (!branches.length) {
    bar.style.display = 'none';
    bar.innerHTML = '';
    if (inv.cliBranchId) { inv.cliBranchId = null; inv.cliBranchName = ''; }
    return;
  }
  bar.style.display = 'flex';
  const locked = !!inv.checkoutOrderId;
  bar.innerHTML = `
    <span style="font-size:11px;color:var(--muted);font-weight:600;flex-shrink:0">Sucursal de entrega:</span>
    <select class="inp" style="flex:1;min-width:0;max-width:340px;font-size:12px;padding:5px 8px"
            ${locked ? 'disabled' : ''} onchange="posSelectBranch(this.value)">
      <option value="">Casa matriz / sin sucursal específica</option>
      ${branches.map(b => `<option value="${b.id}" ${Number(inv.cliBranchId) === Number(b.id) ? 'selected' : ''}>
        ${posEscHtml(b.name)}${b.code ? ` (Est. ${posEscHtml(b.code)})` : ''}${b.address ? ` · ${posEscHtml(b.address)}` : ''}
      </option>`).join('')}
    </select>`;
}

function posSelectBranch(branchId) {
  const inv = currentInv();
  if (inv.checkoutOrderId) return;
  const customer = (DB.customers || []).find(c => Number(c.id) === Number(inv.cliId));
  const branch = (customer?.branches || []).find(b => Number(b.id) === Number(branchId) && b.active !== 0);
  inv.cliBranchId = branch?.id || null;
  inv.cliBranchName = branch?.name || '';
  inv.cliBranchCode = branch?.code || '';
  inv.cliBranchAddress = branch?.address || '';
  inv.cliBranchPhone = branch?.phone || '';
  renderPOSCustomerSelection();
}

function posFilterCustomers(query, showAll = false) {
  const dd = document.getElementById('pos-customer-dd');
  if (!dd) return;
  const inv = currentInv();
  const typed = String(query || '').trim();
  const selected = (DB.customers || []).find(c => Number(c.id) === Number(inv.cliId));
  const stillSelected = selected && Number(selected.id) !== 1 &&
    searchNorm(selected.name) === searchNorm(typed);

  if (!showAll && !stillSelected) {
    const hadRegisteredCustomer = Number(inv.cliId) !== 1;
    inv.cliId = 1;
    inv.cliName = typed || 'Consumidor Final';
    inv.cliCedula = '';
    inv.cliPhone = '';
    inv.cliPhoneType = 'celular';
    inv.cliPhoneId = null;
    inv.cliContactId = null;
    inv.cliContactName = '';
    inv.cliContactRole = '';
    inv.cliContactPhone = '';
    inv.cliBranchId = null;
    inv.cliBranchName = '';
    inv.cliBranchCode = '';
    inv.cliBranchAddress = '';
    inv.cliBranchPhone = '';
    if (hadRegisteredCustomer) _setPosPmode('retail');
    const state = document.getElementById('pos-customer-state');
    if (state) {
      state.style.color = typed ? 'var(--amber)' : 'var(--muted)';
      state.textContent = typed ? 'Selecciona un resultado para vincularlo' : 'Consumidor Final · Precio detalle';
    }
  }

  const normalized = searchNorm(typed);
  const showConsumerFinal = !normalized || normalized === 'consumidor final';
  const matches = pvCustomerOptions(showConsumerFinal && showAll ? '' : typed, showConsumerFinal && showAll);
  let html = showConsumerFinal ? `
    <div class="cli-opt" onmousedown="event.preventDefault()" onclick="posSelectCustomer(1)">
      <div class="cli-opt-name">Consumidor Final</div>
      <div class="cli-opt-meta">Venta sin cliente registrado · precio detalle</div>
    </div>` : '';
  html += matches.map(({ customer: c, contact }) => `
    <div class="cli-opt" onmousedown="event.preventDefault()" onclick="posSelectCustomer(${Number(c.id)},${contact ? Number(contact.id) : 'null'})">
      <div class="cli-opt-name">${contact
        ? `${posEscHtml(contact.name)} <span class="badge b">Representante</span>`
        : posEscHtml(c.name)}
        <span style="font-size:10px;color:${c.preferred_price_mode === 'wholesale' ? 'var(--blue)' : 'var(--muted)'};margin-left:6px">
          ${c.preferred_price_mode === 'wholesale' ? 'Mayorista' : 'Detalle'}
        </span>
      </div>
      <div class="cli-opt-meta">${contact
        ? `${posEscHtml(contact.role || 'Sin cargo')} · ${posEscHtml(c.name)} · ${posEscHtml(contact.phone || 'Sin teléfono')}`
        : `${posEscHtml(c.customer_type === 'company' ? 'Empresa' : 'Persona')} · ${posEscHtml(c.rnc || 'Sin RNC')} · ${posEscHtml(c.phone || 'Sin teléfono')}`}</div>
    </div>`).join('');
  if (!matches.length && !showConsumerFinal) {
    html = `<div class="cli-opt" style="cursor:default">
      <div class="cli-opt-name" style="color:var(--muted)">No se encontró “${posEscHtml(typed)}”</div>
      <div class="cli-opt-meta">Busca por nombre, documento, teléfono o representante</div>
    </div>`;
  }
  dd.innerHTML = html;
  dd.classList.toggle('show', Boolean(html));
}

function posSelectCustomer(id, contactId = null) {
  const inv = currentInv();
  if (inv.checkoutOrderId) {
    toast('La identidad de una orden enviada a caja no puede modificarse', 'w');
    return;
  }
  document.getElementById('pos-customer-dd')?.classList.remove('show');
  if (Number(id) === 1) {
    inv.cliId = 1;
    inv.cliName = 'Consumidor Final';
    inv.cliCedula = '';
    inv.cliContactId = null;
    inv.cliContactName = '';
    inv.cliContactRole = '';
    inv.cliContactPhone = '';
    inv.cliBranchId = null;
    inv.cliBranchName = '';
    inv.cliBranchCode = '';
    inv.cliBranchAddress = '';
    inv.cliBranchPhone = '';
    _setPosPmode('retail');
    renderPOSCustomerSelection();
    return;
  }
  const customer = (DB.customers || []).find(c => Number(c.id) === Number(id) && c.active !== 0);
  if (!customer) return;
  const contact = (customer.contacts || []).find(c =>
    Number(c.id) === Number(contactId) && c.active !== 0 && c.can_order !== 0
  );
  inv.cliId = customer.id;
  inv.cliName = customer.name;
  inv.cliCedula = customer.rnc || '';
  const primaryPhone = (customer.phones || []).find(p => p.is_primary) || (customer.phones || [])[0] || null;
  inv.cliPhone = primaryPhone?.phone || customer.phone || '';
  inv.cliPhoneType = primaryPhone?.phone_type || 'telefono';
  inv.cliPhoneId = primaryPhone?.id || null;
  inv.cliContactId = contact?.id || null;
  inv.cliContactName = contact?.name || '';
  inv.cliContactRole = contact?.role || '';
  inv.cliContactPhone = contact?.phone || '';
  // Al elegir (o reelegir) una empresa, la sucursal previa no aplica: se limpia
  // y el cajero elige la de entrega en su selector propio.
  inv.cliBranchId = null;
  inv.cliBranchName = '';
  inv.cliBranchCode = '';
  inv.cliBranchAddress = '';
  inv.cliBranchPhone = '';
  _setPosPmode(customer.preferred_price_mode === 'wholesale' ? 'wholesale' : 'retail');
  renderPOSCustomerSelection();
  toast(`✓ ${customer.name}${contact ? ` · ${contact.name}` : ''} · precio ${inv.pmode === 'wholesale' ? 'mayorista' : 'detalle'}`);
}

function pvUpdateCustomerState(customer = null, occasionalName = '', contact = null) {
  const el = document.getElementById('pv-customer-selected');
  if (!el) return;
  if (customer && Number(customer.id) !== 1) {
    el.className = 'is-registered';
    el.innerHTML = `${svg('check')} ${customer.customer_type === 'company' ? 'Empresa' : 'Cliente'} seleccionado${contact ? ` · ${posEscHtml(contact.name)}` : ''}`;
  } else if (occasionalName && searchNorm(occasionalName) !== 'consumidor final') {
    el.className = '';
    el.textContent = 'Cliente ocasional — no vinculado al registro de clientes';
  } else {
    el.className = '';
    el.textContent = 'Venta a Consumidor Final';
  }
}

function pvFilterCustomers(query, showAll = false) {
  const dd = document.getElementById('pv-customer-dd');
  if (!dd) return;
  const inv = currentInv();
  const typed = String(query || '').trim();
  const selected = (DB.customers || []).find(c => Number(c.id) === Number(inv.cliId));
  const stillSelected = selected && Number(selected.id) !== 1 &&
    searchNorm(selected.name) === searchNorm(typed);

  // En cuanto se modifica el texto, ya no se debe conservar silenciosamente el
  // ID ni el documento del cliente que estaba seleccionado antes.
  if (!stillSelected) {
    const hadRegisteredCustomer = Number(inv.cliId) !== 1;
    inv.cliId = 1;
    inv.cliName = typed || 'Consumidor Final';
    inv.cliContactId = null;
    inv.cliContactName = '';
    inv.cliContactRole = '';
    inv.cliContactPhone = '';
    inv.cliBranchId = null; inv.cliBranchName = ''; inv.cliBranchCode = '';
    inv.cliBranchAddress = ''; inv.cliBranchPhone = '';
    if (hadRegisteredCustomer) {
      inv.cliCedula = '';
      const rnc = document.getElementById('pv-customer-rnc');
      if (rnc) rnc.value = '';
    }
    pvUpdateCustomerState(null, inv.cliName);
  } else {
    const contact = (selected.contacts || []).find(c => Number(c.id) === Number(inv.cliContactId));
    pvUpdateCustomerState(selected, '', contact);
  }

  const normalized = searchNorm(typed);
  const showConsumerFinal = !normalized || normalized === 'consumidor final';
  const matches = pvCustomerOptions(showConsumerFinal && showAll ? '' : typed, showConsumerFinal && showAll);

  let html = showConsumerFinal ? `
    <div class="cli-opt" onmousedown="event.preventDefault()" onclick="pvSelectCustomer(1)">
      <div class="cli-opt-name">Consumidor Final</div>
      <div class="cli-opt-meta">Continuar sin vincular un cliente registrado</div>
    </div>` : '';

  html += matches.map(({ customer: c, contact }) => `
    <div class="cli-opt" onmousedown="event.preventDefault()" onclick="pvSelectCustomer(${Number(c.id)},${contact ? Number(contact.id) : 'null'})">
      <div class="cli-opt-name">${contact ? `${posEscHtml(contact.name)} <span class="badge b">Representante</span>` : posEscHtml(c.name)}
        ${Number(c.balance) > 0 ? `<span class="pv-customer-balance">Bal: ${fmt(c.balance)}</span>` : ''}
      </div>
      <div class="cli-opt-meta">${contact
        ? `${posEscHtml(contact.role || 'Sin cargo')} · ${posEscHtml(c.name)} · ${posEscHtml(contact.phone || 'Sin teléfono')}`
        : `${posEscHtml(c.customer_type === 'company' ? 'Empresa' : 'Persona')} · ${posEscHtml(c.rnc || 'Sin RNC')} · ${posEscHtml(c.phone || 'Sin teléfono')}`}</div>
    </div>`).join('');

  if (!matches.length && !showConsumerFinal) {
    html = `
      <div class="cli-opt" style="cursor:default" onmousedown="event.preventDefault()"
           onclick="document.getElementById('pv-customer-dd')?.classList.remove('show');document.getElementById('pv-customer-rnc')?.focus()">
        <div class="cli-opt-name" style="color:var(--muted)">No se encontró “${posEscHtml(typed)}”</div>
        <div class="cli-opt-meta">Puedes continuar como cliente ocasional o buscar con otro dato</div>
      </div>`;
  }

  dd.innerHTML = html;
  dd.classList.toggle('show', Boolean(html));
}

function pvSelectCustomer(id, contactId = null) {
  const inv = currentInv();
  const nameInput = document.getElementById('pv-customer-search');
  const rncInput = document.getElementById('pv-customer-rnc');
  const dd = document.getElementById('pv-customer-dd');

  if (Number(id) === 1) {
    inv.cliId = 1;
    inv.cliName = 'Consumidor Final';
    inv.cliCedula = '';
    inv.cliContactId = null;
    inv.cliContactName = '';
    inv.cliContactRole = '';
    inv.cliContactPhone = '';
    inv.cliBranchId = null; inv.cliBranchName = ''; inv.cliBranchCode = '';
    inv.cliBranchAddress = ''; inv.cliBranchPhone = '';
    if (nameInput) nameInput.value = inv.cliName;
    if (rncInput) rncInput.value = '';
    pvUpdateCustomerState();
    dd?.classList.remove('show');
    return;
  }

  const customer = (DB.customers || []).find(c => Number(c.id) === Number(id));
  if (!customer) return;
  inv.cliId = customer.id;
  inv.cliName = customer.name;
  inv.cliCedula = customer.rnc || '';
  const contact = (customer.contacts || []).find(c => Number(c.id) === Number(contactId) && c.can_order !== 0);
  inv.cliContactId = contact?.id || null;
  inv.cliContactName = contact?.name || '';
  inv.cliContactRole = contact?.role || '';
  inv.cliContactPhone = contact?.phone || '';
  inv.cliBranchId = null; inv.cliBranchName = ''; inv.cliBranchCode = '';
  inv.cliBranchAddress = ''; inv.cliBranchPhone = '';
  inv.pmode = customer.preferred_price_mode === 'wholesale' ? 'wholesale' : 'retail';
  if (nameInput) nameInput.value = customer.name;
  if (rncInput) rncInput.value = customer.rnc || '';
  pvUpdateCustomerState(customer, '', contact);
  dd?.classList.remove('show');
}

async function openCheckoutSendModal(inv) {
  if (!preventaCanAccess()) {
    toast('El módulo Preventa y Despacho está desactivado o no tienes acceso', 'w');
    return;
  }
  if (!inv || !inv.cart.length || inv.checkoutOrderId) return;
  if (inv.itype !== 'factura') {
    toast('Solo las facturas pueden enviarse a caja', 'w');
    return;
  }
  // Esta pantalla también puede abrirse inmediatamente después de iniciar sesión.
  // Actualizar aquí evita depender de que otra sección haya cargado los clientes.
  try { await reloadCustomers(); } catch (_) {
    toast('No se pudo actualizar la lista de clientes; se usará la información disponible', 'w');
  }
  const totals = calcTotals(inv);
  const minutes = Number(DB.settings?.checkout_reservation_minutes) || 30;
  openModal(`
    <div class="modal-title">Enviar orden a caja</div>
    <div class="modal-sub">Caja recibira la orden en tiempo real. La factura y el NCF se generan unicamente al cobrar.</div>
    <div class="alrt a" style="margin:12px 0"><div><div class="alrt-title">Reserva automatica por ${minutes} minutos</div><div class="alrt-sub">Si no se cobra a tiempo, los articulos vuelven a quedar disponibles.</div></div></div>
    <div class="card" style="background:var(--surface2);margin-bottom:12px">
      <div class="fg">
        <label class="lbl">Buscar cliente registrado
          <span style="font-weight:400;color:var(--muted);font-size:10px;margin-left:6px">— nombre, RNC, cédula o teléfono</span>
        </label>
        <div class="cli-search-wrap">
          <div class="inp-ic">
            <div class="ic">${svg('search')}</div>
            <input class="inp" id="pv-customer-search" type="search" autocomplete="off"
                   placeholder="Nombre, RNC, cédula o teléfono..."
                   value="${posEscHtml(inv.cliName || 'Consumidor Final')}"
                   onfocus="this.select();pvFilterCustomers(this.value,true)"
                   oninput="pvFilterCustomers(this.value)"
                   onblur="setTimeout(()=>document.getElementById('pv-customer-dd')?.classList.remove('show'),180)"/>
          </div>
          <div id="pv-customer-dd" class="cli-dropdown"></div>
        </div>
        <div class="pv-customer-state">
          <span id="pv-customer-selected">${inv.cliId && Number(inv.cliId) !== 1
            ? `${svg('check')} Cliente registrado seleccionado${inv.cliContactName ? ` · ${posEscHtml(inv.cliContactName)}` : ''}`
            : (inv.cliName && inv.cliName !== 'Consumidor Final' ? 'Cliente ocasional' : 'Venta a Consumidor Final')}</span>
          <button class="btn btn-out pv-customer-final" type="button" onclick="pvSelectCustomer(1)">Consumidor Final</button>
        </div>
      </div>
      <div class="fg" style="margin-bottom:0"><label class="lbl">Cedula / RNC</label>
        <input class="inp" id="pv-customer-rnc" inputmode="numeric" placeholder="Se completa al elegir el cliente"
               value="${posEscHtml(inv.cliCedula || '')}"/></div>
      <div style="display:grid;grid-template-columns:120px 1fr;gap:8px;margin-top:9px">
        <div class="fg" style="margin:0"><label class="lbl">Tipo</label>
          <select class="inp" id="pv-customer-phone-type">
            <option value="telefono" ${inv.cliPhoneType==='telefono'?'selected':''}>Teléfono</option>
            <option value="celular" ${inv.cliPhoneType==='celular'?'selected':''}>Celular</option>
            <option value="flota" ${inv.cliPhoneType==='flota'?'selected':''}>Flota</option>
          </select></div>
        <div class="fg" style="margin:0"><label class="lbl">Número para esta venta</label>
          <input class="inp" id="pv-customer-phone" inputmode="tel" maxlength="40"
            placeholder="809-555-0000" value="${posEscHtml(inv.cliPhone || '')}"></div>
      </div>
    </div>
    ${CFG.module_vendedores === '1' && (DB.salespeople||[]).length ? `
      <div class="fg"><label class="lbl">Vendedor asignado</label><select class="inp" id="pv-salesperson">
        <option value="">— Asignacion automatica —</option>
        ${(DB.salespeople||[]).filter(s=>s.status==='activo').map(s=>`<option value="${s.id}" ${Number(inv.salespersonId)===Number(s.id)?'selected':''}>${posEscHtml(s.code)} · ${posEscHtml(s.name)}</option>`).join('')}
      </select></div>` : ''}
    <div class="fg"><label class="lbl">Nota para caja / despacho <span style="font-weight:400;color:var(--muted)">(opcional)</span></label>
      <textarea class="inp" id="pv-notes" rows="2" maxlength="500" placeholder="Ej: Cliente espera en mostrador 2"></textarea></div>
    <div class="card" style="background:var(--surface2)">
      <div class="tr"><span>${inv.cart.length} articulo(s)</span><span>${fmt(totals.subtotal)}</span></div>
      ${totals.discAmt > 0 ? `<div class="tr"><span>Descuento</span><span>−${fmt(totals.discAmt)}</span></div>` : ''}
      <div class="tr"><span>ITBIS incluido</span><span>${fmt(totals.itbis)}</span></div>
      <div class="tr grand"><span>TOTAL</span><span>${fmt(totals.total)}</span></div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-out" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-green" id="pv-send-btn" onclick="posSubmitCheckoutOrder()">${svg('send')} Enviar a caja</button>
    </div>
  `, 'modal-lg');
}

function _posCheckoutItems(inv) {
  return inv.cart.map(i => ({
    product_id: i.product_id || i.pid,
    product_code: i.product_code || i.code || '',
    product_name: i.product_name || i.name,
    unit_price: Number(i.unit_price ?? i.price) || 0,
    taxable: _posTaxable(i) ? 1 : 0,
    tax_pct: _posTaxable(i) ? _posTaxPct(i) : 0,
    qty: Number(i.qty) || 0,
  }));
}

async function posSubmitCheckoutOrder() {
  const inv = currentInv();
  if (!inv?.cart?.length || inv.checkoutOrderId) return;
  const cliName = document.getElementById('pv-customer-search')?.value?.trim() || 'Consumidor Final';
  const cliCedula = document.getElementById('pv-customer-rnc')?.value?.trim() || '';
  const cliPhone = document.getElementById('pv-customer-phone')?.value?.trim() || '';
  const cliPhoneType = document.getElementById('pv-customer-phone-type')?.value || 'telefono';
  const salespersonId = Number(document.getElementById('pv-salesperson')?.value) || inv.salespersonId || null;
  const items = _posCheckoutItems(inv);
  const authorized = await posEnsureSalePriceAuthorization(inv, items, 'Orden para caja');
  if (!authorized) {
    openCheckoutSendModal(inv);
    return;
  }
  inv.cliName = cliName;
  inv.cliCedula = cliCedula;
  inv.cliPhone = cliPhone;
  inv.cliPhoneType = cliPhoneType;
  inv.salespersonId = salespersonId;
  let customer = { id: 1, name: cliName, rnc: cliCedula, phone: cliPhone, phone_type: cliPhoneType };
  if (inv.cliId && inv.cliId !== 1) {
    const found = DB.customers.find(c => Number(c.id) === Number(inv.cliId));
    if (found) {
      const contact = (found.contacts || []).find(c => Number(c.id) === Number(inv.cliContactId));
      customer = {
        id: found.id, name: found.name, rnc: found.rnc || '',
        phone: cliPhone || found.phone || '', phone_type: cliPhoneType,
        contact_id: contact?.id || null,
        contact: contact ? { id: contact.id, name: contact.name, document: contact.document || '',
          role: contact.role || '', phone: contact.phone || '', email: contact.email || '' } : null,
        branch_id: inv.cliBranchId || null,
        branch: inv.cliBranchId ? {
          id: inv.cliBranchId, name: inv.cliBranchName || '', code: inv.cliBranchCode || '',
          address: inv.cliBranchAddress || '', phone: inv.cliBranchPhone || ''
        } : null,
      };
    }
  }
  const button = document.getElementById('pv-send-btn');
  if (button) { button.disabled = true; button.innerHTML = `${svg('clock')} Enviando...`; }
  try {
    const res = await window.api.checkout.create({
      orderData: {
        customer, items, discountPct: inv.disc || 0, priceMode: inv.pmode || 'retail',
        salespersonId, priceChangeAuthToken: inv.priceChangeAuthToken || null,
        discountAuthToken: inv.discAuthToken || null,
        notes: document.getElementById('pv-notes')?.value?.trim() || '',
      },
      requestUserId: user.id,
    });
    if (!res?.ok) {
      if (button) { button.disabled = false; button.innerHTML = `${svg('send')} Enviar a caja`; }
      return toast(res?.error || 'No se pudo enviar la orden', 'err');
    }
    closeModal();
    window._preventaPendingCount = Number(window._preventaPendingCount || 0) + 1;
    if (typeof buildSidebar === 'function') buildSidebar();
    toast(`✓ ${res.data.number} enviada a caja — ${fmt(res.data.total)}`);
    await reloadProducts().catch(() => {});
    removeInvoice(activeInvoice);
    renderPOS(document.getElementById('page'));
  } catch (e) {
    toast('No se pudo conectar con caja: ' + e.message, 'err');
    if (button?.isConnected) { button.disabled = false; button.innerHTML = `${svg('send')} Enviar a caja`; }
  }
}

// ══════════════════════════════════════════════
// MODAL DE COBRO
// ══════════════════════════════════════════════
// Impresoras instaladas en ESTA terminal. Se cachean para poder ofrecer, al
// cobrar, un selector de impresora + plantilla (solo cuando hay más de una).
let _posPrintersCache = null;
function _posFilterDocumentPrinters(list) {
  return (Array.isArray(list) ? list : []).filter(p => {
    if (!p?.name) return false;
    if (p.name === DB?.settings?.barcode_printer) return false;
    if (typeof detectLabelPrinter !== 'function') return true;
    const confidence = detectLabelPrinter(p, DB?.settings || {}).confidence;
    return !['high', 'medium'].includes(confidence);
  });
}
async function _posLoadPrinters() {
  try {
    const list = typeof printerMonitorRefresh === 'function'
      ? await printerMonitorRefresh({ reason: 'pos-open' })
      : await window.api?.print?.getPrinters?.();
    _posPrintersCache = _posFilterDocumentPrinters(list);
  } catch { _posPrintersCache = []; }
  return _posPrintersCache;
}
function _posSaleTemplates() {
  return (typeof PLANTILLAS !== 'undefined' ? PLANTILLAS : []).filter(p => p && p.tipo !== 'etiqueta');
}

// Tipo de impresión: 'carta' | '58mm' | '72mm' | '80mm' | 'label' | 'custom'.
// · Con impresora específica elegida → se infiere de SU nombre.
// · Sin impresora específica (global/predeterminada) → lo define la PLANTILLA
//   configurada en Configuración, para NO contradecir lo que el usuario ya eligió
//   (si tiene activa una plantilla carta, la salida por defecto es carta).
function _posPrinterType(printerName) {
  if (printerName) {
    try {
      if (typeof inferPrinterProfileId === 'function' && typeof PRINTER_PROFILES !== 'undefined'
          && typeof printerProfileLegacyType === 'function') {
        return printerProfileLegacyType(PRINTER_PROFILES[inferPrinterProfileId(printerName, 'ticket')]);
      }
    } catch {}
    return '80mm';
  }
  const globalTpl = DB?.settings?.print_template || '';
  const tpl = (typeof PLANTILLAS !== 'undefined') ? PLANTILLAS.find(p => p.id === globalTpl) : null;
  if (tpl && tpl.tipo) return tpl.tipo;
  try {
    if (typeof resolvePrinterProfile === 'function' && typeof printerProfileLegacyType === 'function') {
      return printerProfileLegacyType(resolvePrinterProfile('', 'ticket'));
    }
  } catch {}
  return '80mm';
}
// Plantillas de factura compatibles con el papel de la impresora
// (carta ↔ plantillas de hoja; térmica ↔ plantillas de ticket).
function _posTemplatesForPrinter(printerName) {
  const all = _posSaleTemplates();
  const sheet = _posPrinterType(printerName) === 'carta';
  const compat = all.filter(p => (sheet ? p.tipo === 'carta' : p.tipo !== 'carta'));
  return compat.length ? compat : all;
}
// Mejor plantilla por defecto para una impresora: la global si es compatible;
// si no, una acorde al tipo/ancho detectado.
function _posDefaultTemplateForPrinter(printerName) {
  const compat = _posTemplatesForPrinter(printerName).map(p => p.id);
  const global = DB?.settings?.print_template || '';
  if (global && compat.includes(global)) return global;
  const byType = { carta: 'carta_recibo', '58mm': 'termica_58_basica', '72mm': 'termica_72_clasica', '80mm': 'termica_80_clasica' };
  const pick = byType[_posPrinterType(printerName)];
  return (pick && compat.includes(pick)) ? pick : (compat[0] || 'termica_80_clasica');
}
function _posTemplateOptions(printerName, selectedId) {
  const sel = selectedId || _posDefaultTemplateForPrinter(printerName);
  return _posTemplatesForPrinter(printerName)
    .map(p => `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${posEscHtml(p.nombre)}</option>`).join('');
}
// Al cambiar la impresora, la plantilla se re-ajusta al papel correcto.
function posCbrPrinterChanged() {
  const printerEl = document.getElementById('cbr-printer');
  const tplEl = document.getElementById('cbr-template');
  const profileEl = document.getElementById('cbr-print-profile');
  if (!tplEl) return;
  // Una elección manual sale del perfil del canal y vuelve a detección automática.
  if (profileEl) profileEl.value = '';
  tplEl.innerHTML = _posTemplateOptions(printerEl ? printerEl.value : '', null);
  posUpdatePrintSummary();
}

function posTogglePrintOptions(force) {
  const panel = document.getElementById('cbr-print-options');
  const button = document.getElementById('cbr-print-change');
  if (!panel) return;
  const open = force !== undefined ? !!force : panel.style.display === 'none';
  panel.style.display = open ? 'block' : 'none';
  if (button) button.textContent = open ? 'Listo' : 'Cambiar';
}

function posUpdatePrintSummary() {
  const summary = document.getElementById('cbr-print-summary');
  const action = document.getElementById('cbr-print-action')?.value || 'print';
  const printer = document.getElementById('cbr-printer')?.value || '';
  const templateId = document.getElementById('cbr-template')?.value || '';
  const copies = Math.max(1, parseInt(document.getElementById('cbr-print-copies')?.value, 10) || 1);
  const template = _posSaleTemplates().find(p => p.id === templateId);
  const channel = document.getElementById('cbr-print-channel')?.value || '';
  const channelLabel = typeof PRINT_CHANNELS !== 'undefined' ? PRINT_CHANNELS[channel]?.label : '';
  if (!summary) return;
  summary.innerHTML = action === 'none'
    ? `<strong>No imprimir</strong><span style="color:var(--muted2)"> · la venta se guardará normalmente</span>`
    : `<strong>${posEscHtml(channelLabel || printer || 'Impresora predeterminada')}</strong>
       ${channelLabel ? `<span style="color:var(--muted2)"> · ${posEscHtml(printer || 'diálogo del sistema')}</span>` : ''}
       <span style="color:var(--muted2)"> · ${posEscHtml(template?.nombre || 'Plantilla general')}${copies > 1 ? ` · ${copies} copias` : ''}</span>`;
}

async function posRenderPrintOutput(inv, isQuote) {
  const host = document.getElementById('cbr-print-output');
  if (!host) return;
  window._posPrintOutputContext = { inv, isQuote };
  const list = await _posLoadPrinters();
  if (!document.getElementById('cbr-print-output')) return;
  const category = isQuote ? 'cotizacion' : 'ticket';
  const routeCfg = typeof _getCategoryConfig === 'function'
    ? _getCategoryConfig(category) : { printer: '', template: '', copies: 1, autoPrint: true };
  const configuredPrinter = inv.printPrinterName || routeCfg.printer || DB?.settings?.printer || '';
  const configuredInfo = list.find(p => p.name === configuredPrinter);
  const configuredRuntime = configuredInfo && typeof getPrinterRuntimeState === 'function'
    ? getPrinterRuntimeState(configuredInfo) : null;
  const printerAvailable = !configuredPrinter || !!configuredInfo;
  const effectivePrinter = printerAvailable ? configuredPrinter : '';
  const compatibleIds = _posTemplatesForPrinter(effectivePrinter).map(p => p.id);
  const preferredTemplate = inv.printTemplateId || routeCfg.template || DB?.settings?.print_template || '';
  const effectiveTemplate = compatibleIds.includes(preferredTemplate)
    ? preferredTemplate : _posDefaultTemplateForPrinter(effectivePrinter);
  const action = inv.printAction || (routeCfg.autoPrint === false ? 'none' : 'print');
  const copies = Math.max(1, Math.min(9, parseInt(inv.printCopies || routeCfg.copies, 10) || 1));
  const needsAttention = !!configuredPrinter &&
    (!printerAvailable || configuredRuntime?.reportedIssue);
  const effectiveProfile = inv.printProfileId || routeCfg.profileId || '';

  host.innerHTML = `
    <div class="card" style="margin-top:10px;padding:10px 12px;${needsAttention ? 'border-color:var(--amber)' : ''}">
      <div style="display:flex;align-items:center;gap:9px">
        <span style="color:${needsAttention ? 'var(--amber)' : 'var(--green)'}">${svg('print')}</span>
        <div id="cbr-print-summary" style="min-width:0;flex:1;font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></div>
        <button type="button" class="btn btn-out btn-sm" id="cbr-print-change"
                onclick="posTogglePrintOptions()">${needsAttention ? 'Resolver' : 'Cambiar'}</button>
      </div>
      ${needsAttention ? `<div style="font-size:10.5px;color:var(--amber);margin:7px 0 0 27px">
        ${!printerAvailable
          ? `La impresora configurada “${posEscHtml(configuredPrinter)}” no está disponible en esta terminal.`
          : `La impresora “${posEscHtml(configuredPrinter)}” reporta: ${posEscHtml(configuredRuntime?.stateReason || 'no acepta trabajos')}.`}
      </div>` : ''}
      <div id="cbr-print-options" style="display:${needsAttention ? 'block' : 'none'};margin-top:10px;padding-top:10px;border-top:1px solid var(--line)">
        <input type="hidden" id="cbr-print-channel" value="${posEscHtml(routeCfg.channel || '')}"/>
        <input type="hidden" id="cbr-print-profile" value="${posEscHtml(effectiveProfile)}"/>
        <div class="g2">
          <div class="fg" style="margin-bottom:8px"><label class="lbl">Al confirmar</label>
            <select class="inp" id="cbr-print-action" onchange="posUpdatePrintSummary()">
              <option value="print" ${action === 'print' ? 'selected' : ''}>Imprimir automáticamente</option>
              <option value="none" ${action === 'none' ? 'selected' : ''}>Guardar sin imprimir</option>
            </select>
          </div>
          <div class="fg" style="margin-bottom:8px"><label class="lbl">Impresora de documentos</label>
            <select class="inp" id="cbr-printer" onchange="posCbrPrinterChanged()">
              <option value="">Predeterminada / diálogo del sistema</option>
              ${list.map(p => `<option value="${posEscHtml(p.name)}" ${p.name === effectivePrinter ? 'selected' : ''}>
                ${posEscHtml(p.name)}${p.isDefault ? ' (predeterminada)' : ''}${typeof getPrinterRuntimeState === 'function' && getPrinterRuntimeState(p).reportedIssue ? ' · incidencia' : ''}</option>`).join('')}
            </select>
          </div>
          <div class="fg" style="margin-bottom:0"><label class="lbl">Plantilla compatible</label>
            <select class="inp" id="cbr-template" onchange="posUpdatePrintSummary()">
              ${_posTemplateOptions(effectivePrinter, effectiveTemplate)}
            </select>
          </div>
          <div class="fg" style="margin-bottom:0"><label class="lbl">Copias</label>
            <input class="inp" id="cbr-print-copies" type="number" min="1" max="9" step="1"
                   value="${copies}" oninput="posUpdatePrintSummary()"/>
          </div>
        </div>
        <div style="font-size:10.5px;color:var(--muted2);margin-top:7px">
          Las impresoras de etiquetas se administran aparte y nunca aparecen en esta lista.
        </div>
      </div>
    </div>`;
  posUpdatePrintSummary();
}

function _posCapturePrintOutput(inv) {
  if (!inv) return;
  inv.printAction = document.getElementById('cbr-print-action')?.value || inv.printAction;
  inv.printPrinterName = document.getElementById('cbr-printer')?.value || '';
  inv.printTemplateId = document.getElementById('cbr-template')?.value || inv.printTemplateId;
  inv.printCopies = Math.max(1,
    parseInt(document.getElementById('cbr-print-copies')?.value, 10) || inv.printCopies || 1);
  inv.printProfileId = document.getElementById('cbr-print-profile')?.value || '';
}

if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('velo:printers-changed', event => {
    _posPrintersCache = _posFilterDocumentPrinters(event.detail?.printers || []);
    const context = window._posPrintOutputContext;
    if (!context?.inv || !document.getElementById('cbr-print-output')) return;
    _posCapturePrintOutput(context.inv);
    posRenderPrintOutput(context.inv, context.isQuote).catch(() => {});
  });
}

function openCobroModal(inv) {
  if (!inv || !inv.cart.length) return;
  const { subtotal, itbis, total, discAmt, disc } = calcTotals(inv);
  const isQuote = inv.itype === 'cotizacion';
  window._cbrBaseTotals = { subtotal, itbis, total, discAmt, chargesTotal: calcTotals(inv).chargesTotal };

  openModal(`
    <div class="modal-title">${isQuote
      ? 'Crear cotización'
      : (inv.checkoutOrderId ? `Cobrar ${posEscHtml(inv.checkoutOrderNumber || 'orden de despacho')}` : 'Cobrar venta')}</div>
    <div class="modal-sub">${isQuote ? 'Valor cotizado' : 'Total a cobrar'}:
      <strong id="cbr-header-total">${fmt(total)}</strong>${inv.checkoutOrderId ? ' · preparada en despacho' : ''}
    </div>

    <div class="card" style="background:var(--surface2);margin-bottom:14px">
      <div style="font-weight:700;font-size:12px;margin-bottom:10px">Datos del cliente</div>
      <div class="fg">
        <label class="lbl">Nombre en factura
          <span style="font-weight:400;color:var(--muted);font-size:10px;margin-left:6px">
            — escribe libremente o busca un cliente registrado
          </span>
        </label>
        <div style="position:relative">
          <div class="inp-ic">
            <div class="ic">${svg('user')}</div>
            <input class="inp" id="cbr-name" type="text"
                   placeholder="Consumidor Final o nombre nuevo..."
                   autocomplete="off"
                   value="${inv.cliName || ''}"
                   ${inv.checkoutOrderId ? 'readonly' : ''}
                   oninput="cbrFilterCli(this.value)"
                   onblur="setTimeout(()=>{document.getElementById('cbr-cli-dd')?.classList.remove('show')},180)"/>
          </div>
          <div id="cbr-cli-dd" class="cli-dropdown"></div>
        </div>
      </div>
      <div class="fg" style="margin-bottom:0">
        <label class="lbl">Cédula / RNC</label>
        <div style="display:flex;gap:6px">
          <input class="inp" id="cbr-cedula" type="text"
                 placeholder="RNC 9 díg. · Cédula 11 díg."
                 value="${inv.cliCedula || ''}"
                 ${inv.checkoutOrderId ? 'readonly' : ''}
                 oninput="cbrDocHint()" style="flex:1;min-width:0"/>
          <button class="btn btn-out" type="button" onclick="cbrValidarDGII()"
                  title="Verificar en la DGII (requiere internet)" style="flex-shrink:0">DGII</button>
        </div>
        <div id="cbr-cedula-hint" style="font-size:10.5px;margin-top:4px;color:var(--muted2)"></div>
      </div>
      <div class="g2" style="margin-top:9px">
        <div class="fg" style="margin-bottom:0">
          <label class="lbl">Tipo de número</label>
          <select class="inp" id="cbr-phone-type" ${inv.checkoutOrderId ? 'disabled' : ''}>
            <option value="telefono" ${inv.cliPhoneType==='telefono'?'selected':''}>Teléfono</option>
            <option value="celular" ${inv.cliPhoneType==='celular'?'selected':''}>Celular</option>
            <option value="flota" ${inv.cliPhoneType==='flota'?'selected':''}>Flota</option>
          </select>
        </div>
        <div class="fg" style="margin-bottom:0">
          <label class="lbl">Número para esta factura</label>
          <input class="inp" id="cbr-phone" type="tel" maxlength="40"
                 placeholder="809-555-0000" value="${posEscHtml(inv.cliPhone || '')}"
                 ${inv.checkoutOrderId ? 'readonly' : ''}/>
        </div>
      </div>
      <div id="cbr-contact-selected" style="${inv.cliContactName ? '' : 'display:none;'}margin-top:9px;padding:8px 10px;border-radius:8px;background:var(--blue-bg);font-size:11px;color:var(--blue)">
        ${inv.cliContactName ? `Solicitado por <strong>${posEscHtml(inv.cliContactName)}</strong>${inv.cliContactRole ? ` · ${posEscHtml(inv.cliContactRole)}` : ''}` : ''}
      </div>
    </div>

    ${CFG.module_vendedores === '1' && (DB.salespeople||[]).length ? `
    <div class="fg">
      <label class="lbl">Vendedor asignado <span style="font-weight:400;color:var(--muted)">(opcional)</span></label>
      <select class="inp" id="cbr-salesperson" ${inv.checkoutOrderId ? 'disabled' : ''}>
        <option value="">— Venta de mostrador / asignación automática —</option>
        ${(DB.salespeople||[]).filter(s=>s.status==='activo').map(s=>`<option value="${s.id}" ${Number(inv.salespersonId)===Number(s.id)?'selected':''}>${posEscHtml(s.code)} · ${posEscHtml(s.name)} (${s.seller_type})</option>`).join('')}
      </select>
      <div style="font-size:10.5px;color:var(--muted2);margin-top:4px">Se utilizará para comisión y rendimiento; no cambia el cajero que factura.</div>
    </div>` : ''}

    ${isQuote ? `
    <div class="alrt b" style="margin-bottom:12px">
      <div class="alrt-dot b"></div>
      <div>
        <div class="alrt-title">Documento comercial sin cobro</div>
        <div class="alrt-sub">No mueve inventario, caja, crédito ni contabilidad. Podrás convertirlo en factura posteriormente.</div>
      </div>
    </div>` : ''}

    <div class="fg">
      <label class="lbl">Fecha del documento</label>
      <input class="inp" id="cbr-sale-date" type="date"
             value="${posEscHtml(inv.saleDate || new Date().toISOString().slice(0,10))}"/>
      <div style="font-size:10.5px;color:var(--muted2);margin-top:4px">La factura aparecerá en el historial y los reportes de esta fecha.</div>
    </div>

    <div class="fg" style="${isQuote ? 'display:none' : ''}">
      <label class="lbl">Método de pago</label>
      <select class="inp" id="cbr-pmeth" onchange="cbrTogglePago(this.value)">
        <option value="efectivo"      ${inv.pmeth==='efectivo'?'selected':''}>Efectivo</option>
        <option value="tarjeta"       ${inv.pmeth==='tarjeta'?'selected':''}>Tarjeta</option>
        <option value="transferencia" ${inv.pmeth==='transferencia'?'selected':''}>Transferencia</option>
        <option value="mixto"         ${inv.pmeth==='mixto'?'selected':''}>Pago Mixto</option>
        <option value="credito"       ${inv.pmeth==='credito'?'selected':''}>Crédito</option>
      </select>
    </div>

    <!-- Transferencia: cuenta bancaria receptora + conversión según moneda -->
    ${_cbrBankAccounts().length ? `
    <div class="fg" id="cbr-acct-wrap" style="display:${!isQuote && _cbrNeedsAccount(inv.pmeth) ? 'block' : 'none'}">
      <label class="lbl">Cuenta que recibe el pago</label>
      <select class="inp" id="cbr-account" onchange="cbrUpdatePaymentCurrency()">
        <option value="">— Selecciona la cuenta —</option>
        ${_cbrBankAccounts().map(a =>
          `<option value="${a.id}" ${Number(inv.financialAccountId)===Number(a.id)?'selected':''}>${posEscHtml(a.name)}${a.bank_name?` · ${posEscHtml(a.bank_name)}`:''}${a.currency&&a.currency!=='DOP'?` (${a.currency})`:''}</option>`
        ).join('')}
      </select>
      <div style="font-size:10.5px;color:var(--muted2);margin-top:4px">
        El dinero entra a esta cuenta en Bancos y Cuentas, y saldrá en la factura.
      </div>
      <div id="cbr-fx-wrap" class="card" style="display:none;background:var(--blue-bg);border-color:var(--blue-line);margin-top:9px;padding:10px 12px">
        <div class="g2" style="align-items:end">
          <div class="fg" style="margin-bottom:0">
            <label class="lbl">Tasa USD utilizada</label>
            <input class="inp" id="cbr-exchange-rate" type="number" min="20" max="500" step="0.01"
                   value="${Number(inv.exchangeRate || 0) || ''}" placeholder="Consultando..."
                   oninput="cbrUpdatePaymentCurrency()"/>
          </div>
          <div id="cbr-fx-detail" style="font-size:11px;color:var(--blue);padding-bottom:8px"></div>
        </div>
      </div>
      <div id="cbr-transfer-ref-wrap" style="display:${inv.pmeth === 'transferencia' ? 'block' : 'none'};margin-top:9px">
        <label class="lbl">Referencia de transferencia <span style="font-weight:400;color:var(--muted)">(opcional)</span></label>
        <input class="inp" id="cbr-transfer-ref" maxlength="80" value="${posEscHtml(inv.paymentReference || '')}"
               placeholder="Número o referencia bancaria"/>
      </div>
    </div>` : ''}

    <!-- Tarjeta: instrumento del cliente, no cuenta bancaria -->
    <div class="card" id="cbr-card-wrap" style="display:${!isQuote && inv.pmeth === 'tarjeta' ? 'block' : 'none'};background:var(--surface2);margin-bottom:12px">
      <div style="font-weight:700;font-size:12px;margin-bottom:10px">Datos de la tarjeta del cliente</div>
      <div class="g2">
        <div class="fg" style="margin-bottom:0">
          <label class="lbl">Tipo / marca *</label>
          <select class="inp" id="cbr-card-brand">
            <option value="">— Selecciona —</option>
            ${['Visa','Mastercard','American Express','Discover','Diners Club','UnionPay','ATH','Otra'].map(brand =>
              `<option value="${brand}" ${inv.cardBrand===brand?'selected':''}>${brand}</option>`
            ).join('')}
          </select>
        </div>
        <div class="fg" style="margin-bottom:0">
          <label class="lbl">Últimos 4 dígitos <span style="font-weight:400;color:var(--muted)">(opcional)</span></label>
          <input class="inp" id="cbr-card-last4" inputmode="numeric" maxlength="4"
                 value="${posEscHtml(inv.cardLast4 || '')}" placeholder="1234"
                 oninput="this.value=this.value.replace(/\\D/g,'').slice(0,4)"/>
        </div>
      </div>
      <div class="fg" style="margin:10px 0 0">
        <label class="lbl">Código de autorización <span style="font-weight:400;color:var(--muted)">(opcional)</span></label>
        <input class="inp" id="cbr-card-ref" maxlength="80" value="${posEscHtml(inv.paymentReference || '')}"
               placeholder="Referencia del voucher o autorización"/>
      </div>
      <div style="font-size:10.5px;color:var(--muted2);margin-top:5px">
        Por seguridad nunca se almacena el número completo de la tarjeta.
      </div>
    </div>

    <!-- Efectivo simple -->
    <div id="cbr-efec" style="display:${!isQuote && (!inv.pmeth || inv.pmeth==='efectivo') ? 'block' : 'none'}">
      <div class="fg">
        <label class="lbl">Monto recibido</label>
        <div class="inp-ic">
          <div class="ic">${svg('dollar')}</div>
          <input class="inp" id="cbr-received" type="number"
                 placeholder="${fmt(total)}"
                 value="${total.toFixed(2)}"
                 oninput="cbrCalcCambio()"
                 onfocus="this.select()"/>
        </div>
        <div id="cbr-cambio"
             style="font-size:13px;font-weight:700;margin-top:5px;color:var(--muted)"></div>
      </div>
    </div>

    <!-- Pago mixto -->
    <div id="cbr-mixto" style="display:${!isQuote && inv.pmeth==='mixto' ? 'block' : 'none'}">
      <div class="card" style="background:var(--blue-bg);border-color:var(--blue-line);margin-bottom:10px">
        <div style="font-weight:700;font-size:12px;margin-bottom:10px;color:var(--blue)">
          Pago Mixto — Total: ${fmt(total)}
        </div>
        <div class="g2">
          <div class="fg" style="margin-bottom:0">
            <label class="lbl">Efectivo</label>
            <div class="inp-ic">
              <div class="ic">${svg('cash')}</div>
              <input class="inp" id="cbr-mix-efec" type="number" min="0"
                     placeholder="0.00" value="0"
                     oninput="cbrCalcMixto()"/>
            </div>
          </div>
          <div class="fg" style="margin-bottom:0">
            <label class="lbl">Tarjeta / Transferencia</label>
            <div class="inp-ic">
              <div class="ic">${svg('card')}</div>
              <input class="inp" id="cbr-mix-card" type="number" min="0"
                     placeholder="0.00" value="0"
                     oninput="cbrCalcMixto()"/>
            </div>
          </div>
        </div>
        <div id="cbr-mix-status" style="margin-top:10px;font-size:12px;font-weight:700;
             padding:7px 10px;border-radius:6px;background:var(--surface);text-align:center">
          Ingresa los montos arriba
        </div>
      </div>
    </div>

    <!-- Crédito -->
    <div id="cbr-cred" style="display:${!isQuote && inv.pmeth==='credito' ? 'block' : 'none'}">
      <div class="alrt a" style="margin-bottom:10px">
        <div class="alrt-dot a"></div>
        <div>
          <div class="alrt-title">Venta a crédito</div>
          <div class="alrt-sub">Requiere un cliente registrado. El pago inicial entra a Caja como un abono de esta factura.</div>
        </div>
      </div>
      <div class="fg">
        <label class="lbl">Pago inicial recibido (RD$) <span style="font-weight:400;color:var(--muted)">(opcional)</span></label>
        <div class="inp-ic">
          <div class="ic">${svg('dollar')}</div>
          <input class="inp" id="cbr-initial-payment" type="number" min="0" max="${total.toFixed(2)}" step="0.01"
                 value="${Number(inv.initialPaymentAmount || 0).toFixed(2)}"
                 oninput="cbrCalcInitial()"/>
        </div>
        <div id="cbr-credit-balance" style="font-size:12px;color:var(--muted);margin-top:5px"></div>
      </div>
    </div>

    <div class="fg" style="margin-top:10px">
      <label class="lbl">Notas de la venta <span style="font-weight:400;color:var(--muted)">(opcional)</span></label>
      <textarea class="inp" id="cbr-notes" rows="2" maxlength="1000"
                placeholder="Observaciones que deben quedar guardadas e imprimirse en la factura">${posEscHtml(inv.notes || '')}</textarea>
    </div>

    <div class="card" style="background:var(--surface2);margin-top:10px">
        <div class="tr"><span>Subtotal sin ITBIS</span><span id="cbr-summary-subtotal">${fmt(subtotal)}</span></div>
      ${disc > 0
        ? `<div class="tr"><span>Descuento (${Math.round(disc*100)/100}%)</span>
           <span id="cbr-summary-discount">−${fmt(discAmt)}</span></div>` : ''}
      ${inv.itype === 'factura' && itbis > 0
        ? `<div class="tr"><span>ITBIS (${CFG.itbis}%)</span><span id="cbr-summary-itbis">${fmt(itbis)}</span></div>` : ''}
      ${Number(calcTotals(inv).chargesTotal) > 0
        ? `<div class="tr"><span>Cargos adicionales</span><span id="cbr-summary-charges">${fmt(calcTotals(inv).chargesTotal)}</span></div>` : ''}
      <div class="tr grand"><span id="cbr-total-label">TOTAL</span><span id="cbr-summary-total">${fmt(total)}</span></div>
      <div id="cbr-summary-base" style="display:none;text-align:right;font-size:10.5px;color:var(--muted);padding-top:5px"></div>
    </div>

    <div id="cbr-print-output"></div>

    ${inv.itype === 'factura' ? `
    <label style="display:flex;align-items:center;gap:9px;margin-top:12px;padding:10px 12px;
                  background:var(--surface2);border-radius:8px;cursor:pointer;font-size:13px">
      <input type="checkbox" id="cbr-conduce" style="width:16px;height:16px;cursor:pointer;flex-shrink:0"/>
      <span>
        <strong>Generar también un conduce</strong>
        <span style="color:var(--muted);font-size:11px;display:block">
          Se guarda en Conduces y se imprime después de la factura, <strong>sin precios</strong>.
        </span>
      </span>
    </label>` : ''}

    <div class="modal-foot">
      <button class="btn btn-out" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-green" id="btn-confirmar-venta"
              onclick="finalizarVenta()">
        ${svg('check')} ${isQuote ? 'Crear cotización' : 'Confirmar y cobrar'}
      </button>
    </div>
  `, 'modal-lg');

  // Inicializar cambio inmediatamente si método es efectivo
  setTimeout(() => {
    const pmeth = document.getElementById('cbr-pmeth')?.value;
    if (!pmeth || pmeth === 'efectivo') cbrCalcCambio(total);
    if (pmeth === 'credito') cbrCalcInitial(total);
    cbrUpdatePaymentCurrency();
  }, 50);

  // Reutilizar de inmediato la tasa ya visible en el topbar y refrescarla en
  // segundo plano. La tasa queda editable para confirmar el valor real acordado.
  const cachedUsd = Number(
    (typeof _ratesData !== 'undefined' && _ratesData?.usd?.venta?.value) || 0
  );
  if (cachedUsd > 0) {
    window._cbrUsdRate = cachedUsd;
    const rateInput = document.getElementById('cbr-exchange-rate');
    if (rateInput && !Number(rateInput.value)) rateInput.value = cachedUsd.toFixed(2);
  }
  window.api?.banner?.getRates?.().then(res => {
    const rate = Number(res?.data?.usd?.venta?.value || 0);
    if (rate > 0) {
      window._cbrUsdRate = rate;
      const rateInput = document.getElementById('cbr-exchange-rate');
      if (rateInput && !Number(rateInput.value)) rateInput.value = rate.toFixed(2);
      cbrUpdatePaymentCurrency();
    }
  }).catch(() => {});

  // VELO: resolver la ruta sin interrumpir el cobro. Las opciones permanecen
  // plegadas cuando la configuración es válida y solo se abren ante una incidencia.
  posRenderPrintOutput(inv, isQuote).catch(() => {});

  // Cargar los tipos de comprobante con secuencia disponible (para el preview
  // del NCF que se emitirá). Se cachea en window._ncfAvail; si falla, se asume
  // "desconocido" y el preview no advierte de secuencias faltantes.
  window._ncfAvail = null;
  if (inv.itype === 'factura' && CFG.fiscalEnabled && window.api?.ncf?.getSequences) {
    window.api.ncf.getSequences().then(seqs => {
      const avail = new Set();
      (seqs?.data || []).forEach(s => { if (s.active && s.current < s.to_num) avail.add(s.type); });
      window._ncfAvail = avail;
      cbrDocHint();
    }).catch(() => { window._ncfAvail = new Set(); cbrDocHint(); });
  }
  setTimeout(cbrDocHint, 40);
}

// Solo cuentas bancarias: una tarjeta identifica el instrumento del cliente y
// no debe obligarlo a escoger la cuenta interna donde el adquirente liquidará.
function _cbrBankAccounts() {
  return (DB.financialAccounts || []).filter(a =>
    a.is_active !== false && a.type === 'banco');
}
// Transferencia y mixto necesitan destino; tarjeta se vincula automáticamente
// en el backend a una cuenta tipo Tarjeta cuando exista.
function _cbrNeedsAccount(pmeth) {
  return pmeth === 'transferencia' || pmeth === 'mixto';
}

function _cbrMoney(amount, currency = 'DOP') {
  const n = Number(amount) || 0;
  return currency === 'USD'
    ? `US$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : fmt(n);
}

function cbrUpdatePaymentCurrency() {
  const totals = window._cbrBaseTotals;
  if (!totals) return;
  const method = document.getElementById('cbr-pmeth')?.value || 'efectivo';
  const accountId = Number(document.getElementById('cbr-account')?.value || 0);
  const account = _cbrBankAccounts().find(a => Number(a.id) === accountId);
  const isUsd = !!account && String(account.currency || 'DOP').toUpperCase() === 'USD';
  const rateInput = document.getElementById('cbr-exchange-rate');
  if (isUsd && rateInput && !Number(rateInput.value) && Number(window._cbrUsdRate) > 0) {
    rateInput.value = Number(window._cbrUsdRate).toFixed(2);
  }
  const rate = Number(rateInput?.value || 0);
  const validRate = rate >= 20 && rate <= 500;
  const fxWrap = document.getElementById('cbr-fx-wrap');
  if (fxWrap) fxWrap.style.display = isUsd ? 'block' : 'none';

  const setText = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };
  const convertSummary = method === 'transferencia' && isUsd && validRate;
  const money = (dop) => convertSummary ? _cbrMoney(dop / rate, 'USD') : _cbrMoney(dop, 'DOP');
  setText('cbr-summary-subtotal', money(totals.subtotal));
  setText('cbr-summary-itbis', money(totals.itbis));
  setText('cbr-summary-discount', `−${money(totals.discAmt)}`);
  setText('cbr-summary-charges', money(totals.chargesTotal || 0));
  setText('cbr-summary-total', money(totals.total));
  setText('cbr-header-total', money(totals.total));
  setText('cbr-total-label', convertSummary ? 'TOTAL A TRANSFERIR (USD)' : 'TOTAL');

  const base = document.getElementById('cbr-summary-base');
  if (base) {
    base.style.display = convertSummary ? 'block' : 'none';
    base.textContent = convertSummary
      ? `Equivalente fiscal: ${fmt(totals.total)} · Tasa RD$${rate.toFixed(2)} por US$1`
      : '';
  }
  const detail = document.getElementById('cbr-fx-detail');
  if (detail) {
    if (!isUsd) detail.textContent = '';
    else if (!validRate) detail.textContent = 'Indica una tasa válida para calcular el depósito.';
    else if (method === 'mixto') {
      const nonCash = Number(document.getElementById('cbr-mix-card')?.value || 0);
      detail.textContent = `Parte no efectiva: ${fmt(nonCash)} → ${_cbrMoney(nonCash / rate, 'USD')}`;
    } else {
      detail.textContent = `${fmt(totals.total)} → ${_cbrMoney(totals.total / rate, 'USD')}`;
    }
  }
}

function cbrTogglePago(val) {
  document.getElementById('cbr-efec').style.display   = val === 'efectivo'  ? 'block' : 'none';
  document.getElementById('cbr-mixto').style.display  = val === 'mixto'     ? 'block' : 'none';
  document.getElementById('cbr-cred').style.display   = val === 'credito'   ? 'block' : 'none';
  const acctWrap = document.getElementById('cbr-acct-wrap');
  if (acctWrap) acctWrap.style.display = _cbrNeedsAccount(val) ? 'block' : 'none';
  const cardWrap = document.getElementById('cbr-card-wrap');
  if (cardWrap) cardWrap.style.display = val === 'tarjeta' ? 'block' : 'none';
  const transferRef = document.getElementById('cbr-transfer-ref-wrap');
  if (transferRef) transferRef.style.display = val === 'transferencia' ? 'block' : 'none';
  if (val === 'credito') {
    const received = Number(document.getElementById('cbr-received')?.value || 0);
    const total = calcTotals(currentInv()).total;
    const initial = document.getElementById('cbr-initial-payment');
    if (initial && received > 0 && received < total - 0.005 && Number(initial.value || 0) <= 0) {
      initial.value = received.toFixed(2);
    }
    cbrCalcInitial(total);
  }
  cbrUpdatePaymentCurrency();
}

// Mantener compatibilidad con llamadas existentes
function cbrToggleCredito(val) { cbrTogglePago(val); }

function cbrCalcMixto(total = calcTotals(currentInv()).total) {
  const efec = parseFloat(document.getElementById('cbr-mix-efec')?.value) || 0;
  const card = parseFloat(document.getElementById('cbr-mix-card')?.value) || 0;
  const suma = efec + card;
  const diff = suma - total;
  const el   = document.getElementById('cbr-mix-status');
  if (!el) return;

  if (Math.abs(diff) < 0.01) {
    el.style.background = 'var(--green-bg)';
    el.style.color      = 'var(--green)';
    el.textContent      = `✓ Cuadra exacto — ${fmt(total)}`;
  } else if (suma < total) {
    el.style.background = 'var(--red-bg)';
    el.style.color      = 'var(--red)';
    el.textContent      = `Faltan: ${fmt(total - suma)}`;
  } else {
    el.style.background = 'var(--amber-bg)';
    el.style.color      = 'var(--amber)';
    el.textContent      = `Cambio: ${fmt(diff)}`;
  }
  cbrUpdatePaymentCurrency();
}

function cbrCalcCambio(total = calcTotals(currentInv()).total) {
  const rec    = parseFloat(document.getElementById('cbr-received')?.value) || 0;
  const cambio = rec - total;
  const el     = document.getElementById('cbr-cambio');
  if (!el) return;
  el.textContent = cambio >= 0
    ? `Cambio: ${fmt(cambio)}`
    : `Faltan: ${fmt(Math.abs(cambio))}`;
  el.style.color = cambio >= 0 ? 'var(--green)' : 'var(--red)';
  clearTimeout(window._cbrAutoCreditTimer);
  if (rec > 0 && rec < total - 0.005) {
    window._cbrAutoCreditTimer = setTimeout(() => {
      const method = document.getElementById('cbr-pmeth');
      if (!method || method.value !== 'efectivo') return;
      const currentReceived = Number(document.getElementById('cbr-received')?.value || 0);
      if (!(currentReceived > 0 && currentReceived < total - 0.005)) return;
      method.value = 'credito';
      const initial = document.getElementById('cbr-initial-payment');
      if (initial) initial.value = currentReceived.toFixed(2);
      currentInv().initialPaymentAmount = currentReceived;
      cbrTogglePago('credito');
      toast(`Pago parcial detectado: ${fmt(currentReceived)} inicial y ${fmt(total - currentReceived)} a crédito`, 'ok');
    }, 450);
  }
}

function cbrCalcInitial(total = calcTotals(currentInv()).total) {
  const input = document.getElementById('cbr-initial-payment');
  const paid = Math.max(0, Number(input?.value || 0));
  const pending = Math.max(0, total - paid);
  currentInv().initialPaymentAmount = paid;
  const el = document.getElementById('cbr-credit-balance');
  if (el) {
    el.innerHTML = `Pago inicial: <strong>${fmt(paid)}</strong> · Quedará a crédito: <strong style="color:var(--amber)">${fmt(pending)}</strong>`;
  }
}

function cbrRefreshTotals(oldTotal = null) {
  const totals = calcTotals(currentInv());
  window._cbrBaseTotals = {
    subtotal: totals.subtotal, itbis: totals.itbis, total: totals.total,
    discAmt: totals.discAmt, chargesTotal: totals.chargesTotal,
  };
  const setText = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
  setText('cbr-header-total', fmt(totals.total));
  setText('cbr-summary-subtotal', fmt(totals.subtotal));
  setText('cbr-summary-discount', `−${fmt(totals.discAmt)}`);
  setText('cbr-summary-itbis', fmt(totals.itbis));
  setText('cbr-summary-charges', fmt(totals.chargesTotal));
  setText('cbr-summary-total', fmt(totals.total));
  const received = document.getElementById('cbr-received');
  if (received && (!received.value || oldTotal == null || Math.abs(Number(received.value) - Number(oldTotal)) < 0.01)) {
    received.value = totals.total.toFixed(2);
  }
  cbrCalcCambio(totals.total);
  cbrCalcMixto(totals.total);
  cbrUpdatePaymentCurrency();
}

function cbrFilterCli(q) {
  const dd = document.getElementById('cbr-cli-dd');
  if (!dd) return;
  const inv = currentInv();
  const selected = (DB.customers || []).find(c => Number(c.id) === Number(inv.cliId));
  if (selected && searchNorm(selected.name) !== searchNorm(q)) {
    const oldTotal = calcTotals(inv).total;
    inv.cliId = 1;
    inv.cliContactId = null;
    inv.cliContactName = '';
    inv.cliContactRole = '';
    inv.cliContactPhone = '';
    const contactEl = document.getElementById('cbr-contact-selected');
    if (contactEl) contactEl.style.display = 'none';
    _setPosPmode('retail');
    cbrRefreshTotals(oldTotal);
  }
  if (!q.trim() || q.trim().toLowerCase() === 'consumidor final') {
    dd.classList.remove('show'); return;
  }
  const matches = pvCustomerOptions(q, false).slice(0, 8);

  if (!matches.length) {
    dd.innerHTML = `
      <div class="cli-opt" style="cursor:default" onclick="document.getElementById('cbr-cli-dd').classList.remove('show');document.getElementById('cbr-cedula')?.focus()">
        <div class="cli-opt-name" style="color:var(--muted);font-style:italic">
          "${q}" — cliente no registrado
        </div>
        <div class="cli-opt-meta" style="color:var(--muted2)">Toca aquí o continúa — se usará como cliente ocasional</div>
      </div>`;
    dd.classList.add('show');
    return;
  }

  dd.innerHTML = matches.map(({ customer: c, contact }) => `
    <div class="cli-opt" onclick="cbrSelectCli(${c.id},${contact ? contact.id : 'null'})">
      <div class="cli-opt-name">${contact ? `${posEscHtml(contact.name)} <span class="badge b">Representante</span>` : posEscHtml(c.name)}
        ${c.balance > 0
          ? `<span style="font-size:10px;color:var(--amber);margin-left:6px">
             Bal: ${fmt(c.balance)}</span>`
          : ''}
      </div>
      <div class="cli-opt-meta">
        ${contact
          ? `${posEscHtml(contact.role || 'Sin cargo')} · ${posEscHtml(c.name)} · ${posEscHtml(contact.phone || 'Sin teléfono')}`
          : `${posEscHtml(c.customer_type === 'company' ? 'Empresa' : 'Persona')} · ${posEscHtml(c.rnc || 'Sin RNC')} · ${posEscHtml(c.phone || 'Sin teléfono')}`}
      </div>
    </div>`).join('');
  dd.classList.add('show');
}

function cbrSelectCli(id, contactId = null) {
  const c = DB.customers.find(c => c.id === id);
  if (!c) return;
  const inv     = currentInv();
  const oldTotal = calcTotals(inv).total;
  inv.cliId     = c.id;
  inv.cliName   = c.name;
  inv.cliCedula = c.rnc || '';
  const primaryPhone = (c.phones || []).find(p => p.is_primary) || (c.phones || [])[0] || null;
  inv.cliPhone = primaryPhone?.phone || c.phone || '';
  inv.cliPhoneType = primaryPhone?.phone_type || 'telefono';
  inv.cliPhoneId = primaryPhone?.id || null;
  const contact = (c.contacts || []).find(item => Number(item.id) === Number(contactId));
  inv.cliContactId = contact?.id || null;
  inv.cliContactName = contact?.name || '';
  inv.cliContactRole = contact?.role || '';
  inv.cliContactPhone = contact?.phone || '';
  _setPosPmode(c.preferred_price_mode === 'wholesale' ? 'wholesale' : 'retail');
  const sn = document.getElementById('cbr-name');
  const sc = document.getElementById('cbr-cedula');
  if (sn) sn.value = c.name;
  if (sc) sc.value = c.rnc || '';
  const phoneEl = document.getElementById('cbr-phone');
  const phoneTypeEl = document.getElementById('cbr-phone-type');
  if (phoneEl) phoneEl.value = inv.cliPhone;
  if (phoneTypeEl) phoneTypeEl.value = inv.cliPhoneType;
  const contactEl = document.getElementById('cbr-contact-selected');
  if (contactEl) {
    contactEl.style.display = contact ? 'block' : 'none';
    contactEl.innerHTML = contact
      ? `Solicitado por <strong>${posEscHtml(contact.name)}</strong>${contact.role ? ` · ${posEscHtml(contact.role)}` : ''}`
      : '';
  }
  document.getElementById('cbr-cli-dd')?.classList.remove('show');
  cbrRefreshTotals(oldTotal);
  renderPOSCustomerSelection();
  cbrDocHint();
}

// ── Detector de documento + preview de comprobante en el POS ──────────────
// Muestra si el documento es RNC/Cédula y QUÉ comprobante se emitirá (B01/B02),
// avisando si no hay secuencia registrada para ese tipo (saldrá sin NCF).
// Reutiliza los helpers globales _docKind, _rncChecksum y _cedulaChecksum.
function cbrDocHint() {
  const el   = document.getElementById('cbr-cedula');
  const hint = document.getElementById('cbr-cedula-hint');
  if (!el || !hint) return;
  const inv = currentInv();
  const d   = (el.value || '').replace(/\D/g, '');

  // Línea 1 — tipo/validez del documento
  let docLine = '';
  if (d) {
    if (d.length === 9) {
      docLine = (typeof _rncChecksum === 'function' && _rncChecksum(d))
        ? 'RNC válido — Persona jurídica' : 'RNC (9 díg.) — revisa el dígito verificador';
    } else if (d.length === 11) {
      docLine = (typeof _cedulaChecksum === 'function' && _cedulaChecksum(d))
        ? 'Cédula válida — Persona física' : 'Cédula (11 díg.) — revisa el dígito verificador';
    } else {
      docLine = `${d.length} dígitos — RNC usa 9, Cédula usa 11`;
    }
  }

  // Línea 2 — comprobante fiscal que se emitirá (solo factura con fiscal activo)
  let compLine = '';
  if (inv.itype === 'factura' && CFG.fiscalEnabled) {
    const tipo  = d.length === 9 ? 'B01' : 'B02';
    const label = tipo === 'B01' ? 'B01 Crédito Fiscal' : 'B02 Consumo';
    if (window._ncfAvail instanceof Set && !window._ncfAvail.has(tipo)) {
      compLine = `Comprobante ${label}: ⚠ sin secuencia ${tipo} registrada → saldrá SIN NCF`;
    } else {
      compLine = `Comprobante a emitir: ${label}`;
    }
  }

  hint.textContent = [docLine, compLine].filter(Boolean).join('  ·  ');
  hint.style.color = compLine.includes('SIN NCF') ? 'var(--amber)' : 'var(--muted2)';
}

// Verificación en línea del RNC/Cédula del cliente contra la DGII (best-effort).
async function cbrValidarDGII() {
  const el   = document.getElementById('cbr-cedula');
  const hint = document.getElementById('cbr-cedula-hint');
  if (!el) return;
  const d = (el.value || '').replace(/\D/g, '');
  if (d.length !== 9 && d.length !== 11) {
    toast('Ingresa un RNC (9 díg.) o Cédula (11 díg.)', 'err');
    return;
  }
  const esCedula = d.length === 11;
  if (hint) { hint.textContent = 'Consultando DGII…'; hint.style.color = 'var(--muted2)'; }
  try {
    const res = await window.api.ncf.validateRnc({ rnc: d });
    if (res?.ok) {
      if (hint) {
        hint.textContent = `✓ Inscrito en DGII: ${res.nombre || 'Contribuyente'} — ${res.estado || 'ACTIVO'}`;
        hint.style.color = 'var(--green)';
      }
      const nm = document.getElementById('cbr-name');
      if (nm && (!nm.value.trim() || nm.value.trim().toLowerCase() === 'consumidor final') && res.nombre) {
        nm.value = res.nombre;
        currentInv().cliName = res.nombre;
      }
      toast('Verificado en la DGII');
    } else if (hint) {
      if (esCedula) {
        hint.textContent = 'Cédula persona física · No figura como contribuyente en DGII (normal)';
        hint.style.color = 'var(--muted2)';
      } else {
        hint.textContent = '⚠ RNC no inscrito en la DGII — verifica el número';
        hint.style.color = 'var(--amber)';
      }
    }
  } catch (e) {
    if (hint) {
      hint.textContent = 'Sin conexión para verificar en la DGII (puedes continuar)';
      hint.style.color = 'var(--muted2)';
    }
  }
}

// ══════════════════════════════════════════════
// FINALIZAR VENTA — via IPC → SQLite
// ══════════════════════════════════════════════
async function finalizarVenta() {
  const inv       = currentInv();
  const isQuote   = inv.itype === 'cotizacion';
  const pmeth     = isQuote
    ? 'cotizacion'
    : (document.getElementById('cbr-pmeth')?.value || 'efectivo');
  const cliName   = document.getElementById('cbr-name')?.value?.trim()   || 'Consumidor Final';
  const cliCedula = document.getElementById('cbr-cedula')?.value?.trim() || '';
  const cliPhone = document.getElementById('cbr-phone')?.value?.trim() || '';
  const cliPhoneType = document.getElementById('cbr-phone-type')?.value || 'telefono';
  const saleDate = document.getElementById('cbr-sale-date')?.value || new Date().toISOString().slice(0,10);
  const checkoutPrintRoute = typeof _getCategoryConfig === 'function'
    ? _getCategoryConfig(isQuote ? 'cotizacion' : 'ticket')
    : { printer: '', template: '', profileId: '', copies: 1, autoPrint: true };
  const printerInput = document.getElementById('cbr-printer');
  const templateInput = document.getElementById('cbr-template');
  const profileInput = document.getElementById('cbr-print-profile');
  const actionInput = document.getElementById('cbr-print-action');
  const chosenPrinter = printerInput ? printerInput.value : (inv.printPrinterName || checkoutPrintRoute.printer || '');
  const chosenTemplate = templateInput ? templateInput.value : (inv.printTemplateId || checkoutPrintRoute.template || DB?.settings?.print_template || '');
  const chosenPrintProfile = profileInput ? profileInput.value : (inv.printProfileId || checkoutPrintRoute.profileId || '');
  const chosenPrintAction = actionInput ? actionInput.value
    : (inv.printAction || (checkoutPrintRoute.autoPrint === false ? 'none' : 'print'));
  const chosenPrintCopies = Math.max(1, Math.min(9,
    parseInt(document.getElementById('cbr-print-copies')?.value || inv.printCopies || checkoutPrintRoute.copies, 10) || 1));
  // Tipo de impresión que se tomó de la salida (lo define la plantilla elegida:
  // 'carta' para hoja, o el ancho térmico). Se guarda en la venta.
  const chosenPrintType = (typeof PLANTILLAS !== 'undefined'
    ? PLANTILLAS.find(p => p.id === chosenTemplate)?.tipo : '') || '';
  // Capturar AQUÍ (antes de closeModal): el DOM del modal se elimina al cerrar.
  const wantConduce = !!document.getElementById('cbr-conduce')?.checked;
  const selectedAccountId = parseInt(document.getElementById('cbr-account')?.value) || null;
  const finAcctId = _cbrNeedsAccount(pmeth) ? selectedAccountId : null;
  const selectedAccount = _cbrBankAccounts().find(a => Number(a.id) === Number(finAcctId));
  const accountCurrency = String(selectedAccount?.currency || 'DOP').toUpperCase();
  const exchangeRate = accountCurrency === 'USD'
    ? Number(document.getElementById('cbr-exchange-rate')?.value || 0) : 1;
  const cardBrand = pmeth === 'tarjeta'
    ? document.getElementById('cbr-card-brand')?.value || '' : '';
  const cardLast4 = pmeth === 'tarjeta'
    ? String(document.getElementById('cbr-card-last4')?.value || '').replace(/\D/g, '').slice(-4) : '';
  const paymentReference = pmeth === 'tarjeta'
    ? document.getElementById('cbr-card-ref')?.value?.trim() || ''
    : (pmeth === 'transferencia'
      ? document.getElementById('cbr-transfer-ref')?.value?.trim() || '' : '');
  const btnConfirmar = document.getElementById('btn-confirmar-venta');
  const salespersonId = parseInt(document.getElementById('cbr-salesperson')?.value) || null;
  const initialPaymentAmount = pmeth === 'credito'
    ? Number(document.getElementById('cbr-initial-payment')?.value || 0) : 0;
  const saleNotes = document.getElementById('cbr-notes')?.value?.trim() || '';

  // Transferencia sí requiere cuenta; tarjeta requiere la marca utilizada por el
  // cliente y el backend resuelve internamente la cuenta de liquidación.
  if (!isQuote && !finAcctId && _cbrBankAccounts().length && pmeth === 'transferencia') {
    toast('Selecciona la cuenta que recibe el pago', 'w');
    return;
  }
  if (!isQuote && pmeth === 'tarjeta' && !cardBrand) {
    toast('Selecciona el tipo o marca de la tarjeta', 'w');
    return;
  }
  if (!isQuote && accountCurrency === 'USD' && (exchangeRate < 20 || exchangeRate > 500)) {
    toast('Indica una tasa USD válida para calcular el monto que entra a la cuenta', 'w');
    return;
  }
  if (inv.displayCurrency === 'USD' &&
      (Number(inv.displayExchangeRate) < 20 || Number(inv.displayExchangeRate) > 500)) {
    toast('Indica una tasa de venta USD válida para la conversión de la factura', 'w');
    return;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(saleDate)) {
    toast('Selecciona una fecha válida para el documento', 'w');
    return;
  }
  inv.financialAccountId = finAcctId;
  inv.exchangeRate = exchangeRate;
  inv.cardBrand = cardBrand;
  inv.cardLast4 = cardLast4;
  inv.paymentReference = paymentReference;
  inv.salespersonId = salespersonId;
  inv.initialPaymentAmount = initialPaymentAmount;
  inv.notes = saleNotes;

  inv.pmeth = pmeth;
  inv.cliName = cliName;
  inv.cliCedula = cliCedula;
  inv.cliPhone = cliPhone;
  inv.cliPhoneType = cliPhoneType;
  inv.saleDate = saleDate;
  inv.printPrinterName = chosenPrinter;
  inv.printProfileId = chosenPrintProfile;
  inv.printTemplateId = chosenTemplate;
  inv.printType = chosenPrintType;
  inv.printAction = chosenPrintAction;
  inv.printCopies = chosenPrintCopies;

  if (!inv.cart.length) return;

  const currentTotal = calcTotals(inv).total;
  if (!isQuote && pmeth === 'credito') {
    if (!(inv.cliId && inv.cliId !== 1)) {
      toast('Selecciona un cliente registrado para realizar una venta a crédito', 'w');
      return;
    }
    if (initialPaymentAmount < 0 || initialPaymentAmount >= currentTotal - 0.005) {
      toast('El pago inicial debe ser menor que el total; si paga todo usa una venta al contado', 'w');
      return;
    }
  }

  // Validar pago mixto: los montos deben sumar el total
  if (!isQuote && pmeth === 'mixto') {
    const { total } = calcTotals(inv);
    const efec = parseFloat(document.getElementById('cbr-mix-efec')?.value) || 0;
    const card = parseFloat(document.getElementById('cbr-mix-card')?.value) || 0;
    const suma = efec + card;
    if (suma < total - 0.01) {
      toast(`Los montos no cubren el total. Faltan ${fmt(total - suma)}`, 'err');
      return;
    }
  }

  // Validar que el efectivo recibido cubra el total
  if (!isQuote && pmeth === 'efectivo') {
    const { total } = calcTotals(inv);
    const received = parseFloat(document.getElementById('cbr-received')?.value) || 0;
    if (received < total - 0.01) {
      toast(`El monto recibido (${fmt(received)}) no cubre el total (${fmt(total)})`, 'err');
      return;
    }
  }

  // Buscar cliente registrado o usar consumidor final
  let customer = { id: 1, name: cliName, rnc: cliCedula, phone: cliPhone, phone_type: cliPhoneType };
  if (inv.cliId && inv.cliId !== 1) {
    const c = DB.customers.find(c => c.id === inv.cliId);
    if (c) {
      const contact = (c.contacts || []).find(item => Number(item.id) === Number(inv.cliContactId));
      customer = {
        id: c.id, name: c.name, rnc: c.rnc || '', address: c.address || '',
        phone: cliPhone || c.phone || '', phone_type: cliPhoneType,
        phone_id: inv.cliPhoneId || null, email: c.billing_email || c.email || '',
        contact_id: contact?.id || null,
        branch_id: inv.cliBranchId || null,
        branch: inv.cliBranchId ? {
          id: inv.cliBranchId, name: inv.cliBranchName || '', code: inv.cliBranchCode || '',
          address: inv.cliBranchAddress || '', phone: inv.cliBranchPhone || ''
        } : null,
      };
    }
  }

  // Preparar items con snapshot de precios
  const items = inv.cart.map(i => ({
    product_id:   i.product_id || i.pid,
    product_code: i.product_code || i.code || '',
    product_name: i.product_name || i.name,
    unit_cost:    i.unit_cost || i.cost || 0,
    unit_price:   i.unit_price || i.price,
    taxable:      _posTaxable(i) ? 1 : 0,
    tax_pct:      _posTaxable(i) ? _posTaxPct(i) : 0,
    qty:          i.qty,
  }));

  // Para pago mixto capturar desglose
  let mixEfec = 0, mixCard = 0;
  if (pmeth === 'mixto') {
    mixEfec = parseFloat(document.getElementById('cbr-mix-efec')?.value) || 0;
    mixCard = parseFloat(document.getElementById('cbr-mix-card')?.value) || 0;
  }

  const priceAuthOk = await posEnsureSalePriceAuthorization(
    inv, items, isQuote ? 'Cotización actual' : 'Venta actual'
  );
  if (!priceAuthOk) {
    openCobroModal(inv);
    return;
  }

  // Deshabilitar botón para evitar doble click cuando el modal de cobro sigue abierto.
  if (btnConfirmar?.isConnected) {
    btnConfirmar.disabled   = true;
    btnConfirmar.innerHTML  = `${svg('clock')} Procesando...`;
  }

  const saleData = {
    customer,
    items,
    payment: {
      method:         pmeth,
      disc:           inv.disc || 0,
      discApprovedBy: inv.discApprovedBy || null,
      discountAuthToken: inv.discAuthToken || null,
      priceMode:      inv.pmode || 'retail',
      priceChangeAuthToken: inv.priceChangeAuthToken || null,
      mixEfec,
      mixCard,
      financialAccountId: finAcctId,
      exchangeRate,
      cardBrand,
      cardLast4,
      reference: paymentReference,
      salespersonId,
      charges: inv.charges || [],
      displayCurrency: inv.displayCurrency || 'DOP',
      displayExchangeRate: inv.displayCurrency === 'USD' ? Number(inv.displayExchangeRate) : 1,
      saleDate,
      printTemplateId: inv.printTemplateId || '',
      printPrinterType: inv.printType || '',
      printPrinterName: inv.printPrinterName || '',
      printProfileId: inv.printProfileId || '',
      printCopies: inv.printCopies || 1,
      printAction: inv.printAction || 'print',
      initialPaymentAmount,
      initialPaymentMethod: 'efectivo',
      notes: saleNotes,
      replacesSaleId: inv.replacesSaleId || null,
    },
    type: inv.itype || 'factura',
    session: cajaSession,
  };

  try {
    const result = inv.checkoutOrderId
      ? await window.api.checkout.pay({
          id: inv.checkoutOrderId,
          payment: saleData.payment,
          requestUserId: user.id,
        })
      : await window.api.sales.create({
          saleData,
          requestUserId: user.id,
        });

    if (!result.ok) {
      toast(result.error || 'Error al registrar la venta', 'err');
      if (btnConfirmar?.isConnected) {
        btnConfirmar.disabled  = false;
        btnConfirmar.innerHTML = `${svg('check')} ${isQuote ? 'Crear cotización' : 'Confirmar y cobrar'}`;
      } else {
        openCobroModal(inv);
      }
      return;
    }

    // Venta exitosa
    closeModal();
    const savedDocumentLabel = result.documentNumberFmt || `#${result.saleId}`;
    toast(isQuote
      ? `✓ Cotización ${savedDocumentLabel} creada — ${fmt(result.total)}`
      : (inv.checkoutOrderId
        ? `✓ ${inv.checkoutOrderNumber} cobrada · ${savedDocumentLabel} — ${fmt(result.total)}`
        : `✓ Venta ${savedDocumentLabel} registrada — ${fmt(result.total)}`));

	    // Recargar datos actualizados desde SQLite
	    await Promise.all([
	      reloadProducts(),
	      reloadCustomers(),
	      typeof reloadPayments === 'function' ? reloadPayments() : Promise.resolve(),
	    ]);
	    await reloadSales({ range: 'today' });
	    if (inv.checkoutOrderId && typeof preventaHandleSync === 'function') {
	      await preventaHandleSync();
	    }
	    const savedSale = await window.api.sales.getById({ id: result.saleId }).catch(() => null);
	    const printItems = savedSale?.items?.length
	      ? savedSale.items.map(i => ({
	          product_code:  i.product_code || '',
	          product_name:  i.product_name,
	          name:          i.product_name,
	          qty:           i.qty,
	          unit_price:    i.unit_price,
	          price:         i.unit_price,
	          unit_cost:     i.unit_cost || 0,
	          cost:          i.unit_cost || 0,
	          subtotal:      i.subtotal,
	          taxable:       i.taxable,
	          tax_pct:       i.tax_pct,
	          tax_amt:       i.tax_amt,
	          net_subtotal:  i.net_subtotal,
	        }))
	      : inv.cart.map(i => ({
	          product_code: i.product_code || i.code || '',
	          name:  i.name,
	          product_name: i.name,
	          qty:   i.qty,
	          price: i.price,
	          unit_price: i.price,
	          cost:  i.cost || 0,
	          unit_cost: i.cost || 0,
	        }));

	    // Reconstruir sale para previsualización
	    const saleForPrint = {
      id:           result.saleId,
      document_kind: savedSale?.document_kind || result.documentKind || '',
      document_number: savedSale?.document_number || result.documentNumber || null,
      document_number_fmt: savedSale?.document_number_fmt || result.documentNumberFmt || '',
      receipt_document_number: savedSale?.receipt_document_number || result.receiptDocumentNumber || null,
      receipt_document_number_fmt: savedSale?.receipt_document_number_fmt || result.receiptDocumentNumberFmt || '',
      receipt_number: savedSale?.last_receipt_number || result.receiptDocumentNumberFmt || '',
      date:         String(savedSale?.original_sale_date || savedSale?.sale_date || saleDate).slice(0, 10),
      time:         new Date().toLocaleTimeString('es-DO',
                      { hour: '2-digit', minute: '2-digit' }),
      type:         inv.itype,
      clientId:     customer.id,
      clientName:   savedSale?.customer_name || customer.name || cliName,
      clientCedula: savedSale?.customer_rnc || customer.rnc || cliCedula,
	      customer_type: savedSale?.customer_type || 'person',
	      customer_trade_name: savedSale?.customer_trade_name || '',
	      customer_contact_id: savedSale?.customer_contact_id || null,
	      customer_contact_name: savedSale?.customer_contact_name || '',
	      customer_contact_document: savedSale?.customer_contact_document || '',
	      customer_contact_role: savedSale?.customer_contact_role || '',
	      customer_contact_phone: savedSale?.customer_contact_phone || '',
	      customer_contact_email: savedSale?.customer_contact_email || '',
	      customer_branch_id: savedSale?.customer_branch_id || null,
	      customer_branch_name: savedSale?.customer_branch_name || '',
	      customer_branch_code: savedSale?.customer_branch_code || '',
	      customer_branch_address: savedSale?.customer_branch_address || '',
	      customer_branch_phone: savedSale?.customer_branch_phone || '',
      customer_phone: savedSale?.customer_phone || cliPhone,
      customer_phone_type: savedSale?.customer_phone_type || cliPhoneType,
	      items:        printItems,
      charges:      savedSale?.charges || inv.charges || [],
      additional_charges_total: savedSale?.additional_charges_total || result.additionalChargesTotal || 0,
      subtotal:  result.subtotal,
      disc:      inv.disc || 0,
      discAmt:   result.discAmt || 0,
      itbis:     result.taxAmt || 0,
      total:     result.total,
      pay:       pmeth,
      cajero:    user.name,
      ncf:       result.ncf || '',
      tax_pct:   result.taxPct ?? CFG.itbis,
      financial_account_id: result.financialAccountId || finAcctId,
      payment_currency: result.paymentCurrency || 'DOP',
      exchange_rate: result.exchangeRate || 1,
      account_amount: result.accountAmount || 0,
      display_currency: result.displayCurrency || inv.displayCurrency || 'DOP',
      display_exchange_rate: result.displayExchangeRate || inv.displayExchangeRate || 1,
      display_amount: result.displayAmount || 0,
      card_brand: result.cardBrand || cardBrand,
      card_last4: result.cardLast4 || cardLast4,
      payment_reference: result.paymentReference || paymentReference,
      salesperson_id: result.salespersonId || salespersonId,
      salesperson_name: (DB.salespeople||[]).find(s=>Number(s.id)===Number(result.salespersonId||salespersonId))?.name || '',
      notes: savedSale?.notes || saleNotes,
    };

    // Conduce opcional: se crea AHORA (queda guardado en Conduces con su número
    // y su relación con la factura) y se ENCADENA para imprimirse DESPUÉS de la
    // factura de forma automática — primero sale la factura, luego el conduce.
    let _conduceForPrint = null;
    if (wantConduce) {
      const conduceResult = await window.api.conduce.fromSale({
        saleId: result.saleId, requestUserId: user.id,
      });
      if (conduceResult?.ok && conduceResult.data) {
        _conduceForPrint = conduceResult.data;
        toast(`✓ Conduce ${conduceResult.data.number} guardado en Conduces`);
      } else {
        toast(`La venta se guardó, pero el conduce no pudo generarse: ${conduceResult?.error || 'error desconocido'}`, 'w');
      }
    }
    window._printAfter = _conduceForPrint && inv.printAction !== 'none'
      ? () => { if (typeof printConduceDoc === 'function') printConduceDoc(_conduceForPrint); }
      : null;

    // Imprimir la factura primero; al terminar, el hook imprime el conduce.
    if (inv.printAction !== 'none') printReceipt({
      ...saleForPrint,
      id:              result.saleId,
      type:            inv.itype,
      customer_id:      customer.id,
      customer_name:   savedSale?.customer_name || customer.name || cliName,
      customer_rnc:    savedSale?.customer_rnc || customer.rnc || cliCedula,
      customer_address: savedSale?.customer_address || customer.address || '',
      customer_phone:   savedSale?.customer_phone || customer.phone || '',
      customer_phone_type: savedSale?.customer_phone_type || customer.phone_type || 'telefono',
      customer_email:   savedSale?.customer_email || customer.email || '',
      payment_method:  pmeth,
      payment_amount:  isQuote ? 0 : (pmeth === 'credito' ? result.initialPaymentAmount : result.total),
      balance_after_payment: pmeth === 'credito' ? result.outstandingBalance : 0,
      transaction_number: result.documentNumberFmt || result.saleId,
      mix_efec:        mixEfec,
      mix_card:        mixCard,
      print_printer_name: inv.printPrinterName || '',
      print_profile_id: inv.printProfileId || '',
      print_template_id: inv.printTemplateId || '',
      print_copies: inv.printCopies || 1,
    });

    const returnToPreventa = !!inv.checkoutOrderId;
    // Limpiar factura y refrescar POS
    removeInvoice(activeInvoice);
    renderPOS(document.getElementById('page'));

    // Ofrecer WhatsApp después de la venta (opcional)
    // Toast con botón — no bloquea el flujo
    _posToastWhatsApp(saleForPrint);
    // Una orden compartida vuelve a la cola de caja para continuar con la
    // siguiente, sin iniciar otro cobro automáticamente.
    if (returnToPreventa && typeof routeTo === 'function') {
      setTimeout(() => routeTo('preventa'), 180);
    }

  } catch (e) {
    console.error('[finalizarVenta]', e);
    toast('Error inesperado al procesar la venta', 'err');
    if (btnConfirmar?.isConnected) {
      btnConfirmar.disabled  = false;
      btnConfirmar.innerHTML = `${svg('check')} ${isQuote ? 'Crear cotización' : 'Confirmar y cobrar'}`;
    } else {
      openCobroModal(inv);
    }
  }
}

// ══════════════════════════════════════════════
// WHATSAPP POST-VENTA — Toast opcional
// ══════════════════════════════════════════════

// ── WhatsApp desde ventana de previsualización ───────────────────
// El popup llama window.opener._waFromPreview(document)
window._waFromPreview = function(doc) {
  const docType  = ((doc.querySelector('.doc-type') || {}).textContent || 'DOCUMENTO').trim();
  const bizName  = ((doc.querySelector('.biz') || {}).textContent || CFG.biz).trim();
  const cliente  = ((doc.querySelector('.cv') || {}).textContent || 'Consumidor Final').trim();
  const totalEl  = doc.querySelector('.tr-grand span:last-child');
  const total    = totalEl ? totalEl.textContent.trim() : '';
  const ncfEl    = doc.querySelector('[style*="BBF7D0"]');
  const ncf      = ncfEl ? ncfEl.textContent.trim() : '';

  const rows  = doc.querySelectorAll('tbody tr');
  const lines = [];
  rows.forEach(r => {
    const cells = r.querySelectorAll('td');
    if (cells.length >= 5) {
      const nm = (cells[1].textContent || '').trim();
      const qt = (cells[2].textContent || '').trim();
      const sb = (cells[4].textContent || '').trim();
      if (nm) lines.push('  - ' + nm + ' x' + qt + ' - ' + sb);
    }
  });

  const fecha = new Date().toLocaleDateString('es-DO', {
    day: '2-digit', month: '2-digit', year: 'numeric'
  });

  const msg = [
    docType.trim() + ' - ' + bizName,
    'Fecha: ' + fecha,
    'Cliente: ' + cliente,
    '',
    'Detalle:',
    lines.join('\n'),
    '',
    total ? 'TOTAL: ' + total : '',
    ncf || '',
    '',
    'Gracias por su preferencia',
  ].filter(l => l !== undefined && l !== null).join('\n');

  // Buscar teléfono del cliente en la DB
  const clientObj = DB.customers.find(c => c.name === cliente);
  const defPhone  = clientObj?.phone
    ? clientObj.phone.replace(/\D/g, '')
    : (CFG.phone || '').replace(/\D/g, '');

  openWhatsAppModal(msg, defPhone, cliente);
};

function _posToastWhatsApp(sale) {
  // Solo mostrar si el cliente NO es consumidor final
  if (!sale.clientName || sale.clientName === 'Consumidor Final') return;

  // Toast especial con botón WhatsApp — aparece 800ms después del ticket
  setTimeout(() => {
    const t = document.createElement('div');
    t.style.cssText = [
      'position:fixed', 'bottom:80px', 'right:24px', 'z-index:9999',
      'background:#25D366', 'color:#fff', 'border-radius:12px',
      'padding:12px 16px', 'font-size:13px', 'font-weight:600',
      'box-shadow:0 4px 20px rgba(0,0,0,.25)', 'cursor:pointer',
      'display:flex', 'align-items:center', 'gap:10px',
      'animation:fi .3s ease', 'max-width:320px',
    ].join(';');
    t.innerHTML = `
      <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" style="flex-shrink:0">
        <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/>
        <path d="M12 0C5.373 0 0 5.373 0 12c0 2.124.557 4.118 1.529 5.847L0 24l6.335-1.501A11.934 11.934 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 21.818a9.801 9.801 0 01-5.002-1.367l-.359-.214-3.72.881.896-3.614-.234-.371A9.818 9.818 0 012.182 12C2.182 6.575 6.575 2.182 12 2.182S21.818 6.575 21.818 12 17.425 21.818 12 21.818z"/>
      </svg>
      <div>
        <div>PDF para ${sale.clientName?.split(' ')[0]}</div>
        <div style="font-size:11px;opacity:.85">Toca para preparar y abrir WhatsApp</div>
      </div>`;
    t.onclick = () => {
      t.remove();
      _posSendWhatsAppPDF(sale);
    };
    document.body.appendChild(t);
    // Auto-ocultar en 6 segundos
    setTimeout(() => { if (t.parentNode) t.remove(); }, 6000);
  }, 800);
}

function _posSendWhatsAppPDF(sale) {
  if (typeof enviarDocumentoPDFWhatsApp !== 'function') {
    toast('Envío de PDF no disponible', 'err');
    return;
  }
  const client = (DB.customers || []).find(c =>
    Number(c.id) === Number(sale.clientId || sale.customer_id)
  ) || (DB.customers || []).find(c => c.name === sale.clientName);
  const phone = (
    sale.customer_contact_phone ||
    sale.customer_phone ||
    client?.phone ||
    ''
  ).replace(/\D/g, '');
  const label = facturaLabel(sale);
  const message = [
    `${sale.type === 'cotizacion' ? 'Cotización' : 'Factura'} ${label} · ${CFG.biz}`,
    `Cliente: ${sale.clientName || 'Consumidor Final'}`,
    `Total: ${fmt(sale.total || 0)}`,
    'Adjuntamos el documento en formato PDF.',
  ].join('\n');
  const payload = {
    ...sale,
    customer_id: sale.clientId || sale.customer_id || null,
    customer_name: sale.clientName || sale.customer_name || 'Consumidor Final',
    customer_rnc: sale.clientCedula || sale.customer_rnc || '',
    payment_method: sale.pay || sale.payment_method || 'efectivo',
    discount_pct: sale.disc || sale.discount_pct || 0,
    discount_amt: sale.discAmt || sale.discount_amt || 0,
    tax_amt: sale.itbis || sale.tax_amt || 0,
    items: (sale.items || []).map(i => ({
      ...i,
      product_name: i.product_name || i.name,
      unit_price: i.unit_price ?? i.price,
      unit_cost: i.unit_cost ?? i.cost ?? 0,
    })),
  };
  enviarDocumentoPDFWhatsApp(
    () => printReceipt(payload, true),
    clientDocumentFilename(sale.clientName || sale.customer_name, label,
      sale.type === 'cotizacion' ? 'Cotizacion' : 'Factura'),
    { message, phone, clientName: sale.clientName || 'cliente' }
  );
}

function _posSendWhatsApp(sale) {
  const items = (sale.items || []).map(i =>
    '  - ' + i.name + ' x' + i.qty + ' - ' + fmt(i.price * i.qty)
  ).join('\n');

  const tipo = sale.type === 'cotizacion' ? 'COTIZACION' : 'FACTURA';
  const msg = [
    tipo + ' ' + facturaLabel(sale) + ' - ' + CFG.biz,
    'Fecha: ' + sale.date,
    'Cliente: ' + (sale.clientName || 'Consumidor Final'),
    '',
    'Detalle:',
    items,
    '',
    sale.itbis > 0 ? 'ITBIS (' + CFG.itbis + '%): ' + fmt(sale.itbis) : '',
    'TOTAL: ' + fmt(sale.total),
    sale.ncf ? 'NCF: ' + sale.ncf : '',
    '',
    CFG.biz,
    CFG.phone ? 'Tel: ' + CFG.phone : '',
    'Gracias por su preferencia',
  ].filter(l => l !== null && l !== undefined).join('\n');

  const client   = DB.customers.find(c => c.name === sale.clientName);
  const defPhone = client?.phone
    ? client.phone.replace(/\D/g,'')
    : (CFG.phone || '').replace(/\D/g,'');

  openWhatsAppModal(msg, defPhone, sale.clientName || 'cliente');
}


// ══════════════════════════════════════════════
// PREVISUALIZACIÓN DE FACTURA
// ══════════════════════════════════════════════
function previsualizarFactura(sale) {
  const isFactura    = sale.type === 'factura';
  const isCotizacion = sale.type === 'cotizacion';

  const itemsRows = sale.items.map((it, i) => `
    <tr>
      <td style="color:#9CA3AF">${i + 1}</td>
      <td style="font-weight:500">${_esc(it.name)}</td>
      <td style="text-align:center">${it.qty}</td>
      <td style="text-align:right">${fmt(it.price)}</td>
      <td style="text-align:right;font-weight:600">${fmt(it.price * it.qty)}</td>
    </tr>`).join('');

  const pdfName = `${isFactura ? 'Factura' : 'Cotizacion'}-${facturaLabel(sale).replace(/^#/, '')}`;

  // Script embebido como string concatenado (evita conflicto con template literal)
  const embeddedScript = [
    '<scr' + 'ipt>',
    'function savePDF(){',
    `  var suggestedName=${JSON.stringify(pdfName)};`,
    '  var clone=document.documentElement.cloneNode(true);',
    '  Array.prototype.slice.call(clone.querySelectorAll(".no-print,script")).forEach(function(el){el.remove();});',
    '  var html="<!DOCTYPE html>"+clone.outerHTML;',
    '  if(window.opener&&window.opener.api&&window.opener.api.print&&window.opener.api.print.toPDF){',
    '    window.opener.api.print.toPDF({html:html,suggestedName:suggestedName}).then(function(r){',
    '      if(!r||(!r.ok&&!r.canceled)) alert((r&&r.error)||"No se pudo guardar el PDF");',
    '    });',
    '    return;',
    '  }',
    '  var s=document.createElement("style");',
    '  s.textContent=".no-print{display:none!important}";',
    '  document.head.appendChild(s);',
    '  setTimeout(function(){window.print();setTimeout(function(){s.remove();},1000);},100);',
    '}',
    'function sendWhatsApp(){',
    '  if(window.opener&&window.opener._waFromPreview){',
    '    window.opener._waFromPreview(document);',
    '  }',
    '}',
    '</' + 'script>',
  ].join('\n');

  const html = `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8"/>
<title>${isFactura ? 'Factura' : 'Cotizaci&oacute;n'} #${sale.id}</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:Arial,sans-serif;font-size:13px;color:#0D0F12}
  .inv{max-width:720px;margin:0 auto;padding:32px}
  .no-print{margin-bottom:16px;display:flex;gap:8px;justify-content:flex-end}
  .btn-p{background:#0D0F12;color:#fff;border:none;padding:9px 20px;border-radius:7px;font-size:12px;font-weight:700;cursor:pointer}
  .btn-pdf{background:#2563EB;color:#fff;border:none;padding:9px 20px;border-radius:7px;font-size:12px;font-weight:700;cursor:pointer}
  .btn-wa{background:#25D366;color:#fff;border:none;padding:9px 20px;border-radius:7px;font-size:12px;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;gap:6px}
  .btn-c{background:#F3F4F6;color:#374151;border:none;padding:9px 20px;border-radius:7px;font-size:12px;font-weight:700;cursor:pointer}
  .hdr{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #E5E7EB;padding-bottom:18px;margin-bottom:20px}
  .biz{font-size:20px;font-weight:800;color:#16A34A}
  .biz-info{font-size:11px;color:#6B7280;margin-top:5px;line-height:1.8}
  .doc-type{font-size:22px;font-weight:800;text-align:right}
  .doc-meta{font-size:11px;color:#6B7280;text-align:right;margin-top:4px;line-height:1.8}
  .cbox{background:#F9FAFB;border:1px solid #E5E7EB;border-radius:8px;padding:14px;margin-bottom:18px}
  .cg{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
  .cl{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#9CA3AF;margin-bottom:3px}
  .cv{font-size:13px;font-weight:600}
  table{width:100%;border-collapse:collapse;margin-bottom:18px}
  th{text-align:left;padding:8px 11px;background:#F9FAFB;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#9CA3AF;border-bottom:2px solid #E5E7EB}
  td{padding:10px 11px;border-bottom:1px solid #F3F4F6;font-size:12px;color:#374151}
  .tots{margin-left:auto;width:260px}
  .tr-tot{display:flex;justify-content:space-between;padding:6px 0;font-size:12px;border-bottom:1px solid #F3F4F6}
  .tr-grand{font-size:18px;font-weight:800;color:#16A34A;border-top:2px solid #E5E7EB;border-bottom:none;padding-top:10px}
  .footer{margin-top:28px;padding-top:16px;border-top:1px solid #E5E7EB;text-align:center;font-size:10px;color:#9CA3AF;line-height:1.9}
  @media print{.no-print{display:none!important}.inv{padding:16px}}
</style>
</head>
<body>
<div class="inv">
  <div class="no-print">
    <button class="btn-c" onclick="window.close()">Cerrar</button>
    <button class="btn-wa" onclick="sendWhatsApp()">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
        <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/>
        <path d="M12 0C5.373 0 0 5.373 0 12c0 2.124.557 4.118 1.529 5.847L0 24l6.335-1.501A11.934 11.934 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 21.818a9.801 9.801 0 01-5.002-1.367l-.359-.214-3.72.881.896-3.614-.234-.371A9.818 9.818 0 012.182 12C2.182 6.575 6.575 2.182 12 2.182S21.818 6.575 21.818 12 17.425 21.818 12 21.818z"/>
      </svg>
      WhatsApp
    </button>
    <button class="btn-pdf" onclick="savePDF()">Guardar PDF</button>
    <button class="btn-p" onclick="window.print()">Imprimir</button>
  </div>
  <div class="hdr">
    <div>
      <div class="biz">${_esc(CFG.biz)}</div>
      <div class="biz-info">
        RNC: ${_esc(CFG.rnc)}<br>${_esc(CFG.addr)}<br>Tel: ${_esc(CFG.phone)}
      </div>
    </div>
    <div>
      <div class="doc-type">${isFactura ? 'FACTURA' : 'COTIZACI&Oacute;N'}</div>
      <div class="doc-meta">
        ${facturaLabel(sale)}<br>
        ${sale.date} ${sale.time}<br>
        Cajero: ${_esc(sale.cajero)}
      </div>
    </div>
  </div>
  <div class="cbox">
    <div class="cg">
      <div>
        <div class="cl">Cliente</div>
        <div class="cv">${_esc(sale.clientName)||'Consumidor Final'}</div>
      </div>
      ${sale.clientCedula
        ? `<div><div class="cl">RNC / C&eacute;dula</div>
           <div class="cv">${_esc(sale.clientCedula)}</div></div>` : ''}
      <div>
        <div class="cl">Método de pago</div>
        <div class="cv" style="text-transform:capitalize">${_esc(sale.pay)}</div>
      </div>
    </div>
    ${sale.customer_contact_name ? `<div style="margin-top:10px;padding-top:9px;border-top:1px solid #E5E7EB;font-size:11px;color:#2563EB">
      Solicitado por: <strong>${_esc(sale.customer_contact_name)}</strong>${sale.customer_contact_role ? ` · ${_esc(sale.customer_contact_role)}` : ''}${sale.customer_contact_document ? ` · Documento: ${_esc(sale.customer_contact_document)}` : ''}
    </div>` : ''}
  </div>
  <table>
    <thead>
      <tr>
        <th>#</th><th>Producto</th>
        <th style="text-align:center">Cant.</th>
        <th style="text-align:right">Precio</th>
        <th style="text-align:right">Subtotal</th>
      </tr>
    </thead>
    <tbody>${itemsRows}</tbody>
  </table>
  <div class="tots">
    <div class="tr-tot"><span>Subtotal sin ITBIS</span><span>${fmt(sale.subtotal)}</span></div>
    ${(sale.disc || 0) > 0
      ? `<div class="tr-tot"><span>Descuento (${Math.round((sale.disc||0)*100)/100}%)</span>
         <span style="color:#DC2626">-${fmt(sale.discAmt || 0)}</span></div>` : ''}
    ${isFactura && sale.itbis > 0
      ? `<div class="tr-tot"><span>ITBIS (${sale.tax_pct || CFG.itbis}%)</span>
         <span>${fmt(sale.itbis)}</span></div>` : ''}
    <div class="tr-tot tr-grand">
      <span>TOTAL</span><span>${fmt(sale.total)}</span>
    </div>
  </div>
  ${isFactura && sale.ncf
    ? `<div style="background:#F0FDF4;border:1px solid #BBF7D0;border-radius:6px;
                   padding:8px 12px;font-size:11px;color:#16A34A;font-weight:600;margin-top:12px">
         NCF: ${_esc(sale.ncf)}
       </div>` : ''}
  <div class="footer">
    ${_esc(CFG.biz)} · RNC: ${_esc(CFG.rnc)} · Tel: ${_esc(CFG.phone)}<br>
    ${_esc(CFG.addr)}<br>
    <strong>Gracias por su preferencia</strong>
  </div>
</div>
${embeddedScript}
</body></html>`;

  const win = window.open('', '_blank',
    'width=860,height=720,scrollbars=yes,resizable=yes');
  if (!win) { toast('Activa las ventanas emergentes para previsualizar', 'w'); return; }
  win.document.open();
  win.document.write(html);
  win.document.close();
  win.focus();
}
