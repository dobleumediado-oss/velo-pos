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
        // Soporte para lector de código de barras USB (simula Enter al escanear)
        si.addEventListener('keydown', e => {
          if (e.key === 'Enter') {
            e.preventDefault();
            const q = si.value.trim();
            if (!q) return;
            // Buscar producto exacto por código interno O código de barras
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
              si.value  = '';
              posSearch = '';
              renderPOSGrid();
              toast(`✓ ${exacto.name} agregado`, 'ok');
            } else {
              // Si no hay coincidencia exacta, buscar parcial
              posSearch = q;
              renderPOSGrid();
              // Si hay un solo resultado, agregarlo automáticamente
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
                si.value  = '';
                posSearch = '';
                renderPOSGrid();
                toast(`✓ ${filtered[0].name} agregado`, 'ok');
              }
            }
          }
        });
      }
      if (sc) sc.addEventListener('change', () => renderPOSGrid());
      document.getElementById('pos-search')?.focus();

      // ── Focus global para lector de código de barras ──────────────────
      // El escáner USB envía teclas como si fuera teclado — si el foco está
      // en otro lado, redirigimos automáticamente al campo de búsqueda.
      // Se instala una sola vez y se limpia cuando el POS se desmonta.
      if (window._barcodeListenerAbort) {
        window._barcodeListenerAbort.abort(); // limpiar listener anterior
      }
      const barcodeAbort = new AbortController();
      window._barcodeListenerAbort = barcodeAbort;

      let _barcodeBuffer = '';
      let _barcodeTimer  = null;

      document.addEventListener('keydown', (e) => {
        const tag = document.activeElement?.tagName?.toLowerCase();
        const isPOSActive = !!document.getElementById('pos-search');
        if (!isPOSActive) {
          // El POS ya no está montado — el AbortController debería haberlo limpiado
          // pero por si acaso, limpiar manualmente
          barcodeAbort.abort();
          return;
        }
        if (['input','textarea','select'].includes(tag)) return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;

        if (e.key.length === 1) {
          _barcodeBuffer += e.key;
          clearTimeout(_barcodeTimer);
          _barcodeTimer = setTimeout(() => { _barcodeBuffer = ''; }, 100);
        }

        if (e.key === 'Enter' && _barcodeBuffer) {
          const si = document.getElementById('pos-search');
          if (si) {
            si.value  = _barcodeBuffer;
            posSearch = _barcodeBuffer;
            si.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          }
          _barcodeBuffer = '';
        }
      }, { signal: barcodeAbort.signal });
    }, 0);

    renderPOSGrid();
    renderInvTabs();
    renderCart();
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
  currentInv().pmode = mode;
  const tabs = document.getElementById('pos-pmode-tabs');
  if (tabs) {
    tabs.querySelectorAll('button[data-pmode]').forEach(btn => {
      btn.classList.toggle('on', btn.getAttribute('data-pmode') === mode);
    });
  }
  renderPOSGrid();
}

// ── Grid de productos ─────────────────────────
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
    const isOut  = p.stock <= 0;
    const isLow  = p.stock > 0 && p.stock <= p.stock_min;
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
          ${isOut ? 'Sin stock' : `${p.stock} disponibles`}
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
  addBtn.onclick     = () => { addInvoice(); renderInvTabs(); renderCart(); };
  wrap.appendChild(addBtn);
}

function posSetTab(idx) {
  activeInvoice = idx;
  renderInvTabs();
  renderCart();
  renderPOSGrid();
}

function posRemoveTab(idx) {
  removeInvoice(idx);
  renderInvTabs();
  renderCart();
  renderPOSGrid();
}

// ── Agregar al carrito ────────────────────────
function posAddItem(pid) {
  const inv  = currentInv();
  const prod = DB.products.find(p => p.id === pid);
  if (!prod || prod.stock <= 0) { toast('Sin stock', 'err'); return; }

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
    const maxForLine = Math.max(0, (Number(prod.stock) || 0) - posCartQtyForProduct(pid, idx));
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
  const { subtotal, itbis, total, disc, discAmt } = calcTotals(inv);

  let html = `
    <div class="cart-hdr">
      <div class="fxb">
        <div>
          <span style="font-weight:700;font-size:13px">Factura #${inv.id}</span>
          <span style="font-size:10px;color:var(--muted);margin-left:8px">
            ${inv.cart.length} artículo${inv.cart.length !== 1 ? 's' : ''}
          </span>
        </div>
        <button class="btn btn-ghost btn-sm" onclick="posLimpiar()">
          ${svg('trash')} Limpiar
        </button>
      </div>
      <div class="flex" style="margin-top:8px;gap:5px">
        ${['factura','cotizacion'].map(t => `
          <button class="btn btn-sm ${inv.itype === t ? 'btn-dark' : 'btn-out'}"
                  style="font-size:10px;padding:3px 9px"
                  onclick="posSetType('${t}')">
            ${t === 'factura' ? 'Factura' : 'Cotización'}
          </button>`).join('')}
      </div>
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
              <input type="number" min="0" step="0.01" value="${Number(item.price || 0).toFixed(2)}"
                style="width:92px;text-align:right;font-size:12px;font-weight:700;
                       border:1px solid var(--line);border-radius:4px;padding:2px 5px;
                       font-family:inherit;background:var(--surface)"
                onchange="posSetPrice(${idx},this.value)"
                onkeydown="if(event.key==='Enter')this.blur()"
                onclick="this.select()"/>
              ${item.taxable === 0 ? '' : `<span style="font-size:10px;color:var(--blue);font-weight:700">ITBIS incl.</span>`}
            </div>
            ${item.resale_source?.saleId ? `
              <div style="font-size:10px;color:var(--green);font-weight:700;margin-top:3px">
                Reventa de venta #${String(item.resale_source.saleId).padStart(5,'0')}
              </div>` : ''}
          </div>
          <div class="qc">
            <button class="qb" onclick="posQty(${idx},-1)">−</button>
            <input type="number" min="1" value="${item.qty}"
              style="width:42px;text-align:center;font-size:12px;font-weight:700;
                     border:1px solid var(--line);border-radius:4px;padding:2px 4px;
                     font-family:inherit;background:var(--surface)"
              oninput="posSetQty(${idx},this.value)"
              onclick="this.select()"/>
            <button class="qb" onclick="posQty(${idx},1)">+</button>
          </div>
          <div class="ci-total">${fmt(item.price * item.qty)}</div>
          <button class="qb" style="margin-left:4px;color:var(--red)"
                  onclick="posRemItem(${idx})">×</button>
        </div>`;
    });
  }
  html += `</div>`;

  html += `
    <div class="cart-foot">
      <div class="flex" style="margin-bottom:8px;gap:6px;align-items:center">
        <span style="font-size:11px;color:var(--muted);flex:1">Descuento</span>
        <select class="inp" style="width:58px;padding:4px;font-size:12px"
                onchange="posDiscMode(this.value)" title="Tipo de descuento">
          <option value="pct" ${(inv.discMode || 'pct') !== 'amt' ? 'selected' : ''}>%</option>
          <option value="amt" ${inv.discMode === 'amt' ? 'selected' : ''}>RD$</option>
        </select>
        <input type="number" min="0" ${inv.discMode === 'amt' ? 'step="0.01"' : 'max="100"'}
               value="${inv.discMode === 'amt' ? (inv.discAmtInput || 0) : (inv.disc || 0)}"
               class="inp" style="width:72px;padding:4px 7px;font-size:12px;text-align:right"
               oninput="posDiscConPin(this, this.value)"/>
      </div>
      <div class="tr"><span>Subtotal sin ITBIS</span><span>${fmt(subtotal)}</span></div>
      ${inv.itype === 'factura' && itbis > 0
        ? `<div class="tr"><span>ITBIS (${CFG.itbis}%)</span><span>${fmt(itbis)}</span></div>` : ''}
      ${disc > 0
        ? `<div class="tr"><span>Descuento</span><span>−${fmt(discAmt)}</span></div>` : ''}
      <div class="tr grand"><span>TOTAL</span><span>${fmt(total)}</span></div>
      <button class="btn btn-green btn-fw btn-lg"
              style="margin-top:12px;font-size:14px;opacity:${inv.cart.length ? '1' : '.4'}"
              ${inv.cart.length ? '' : 'disabled'}
              onclick="openCobroModal(invoices[activeInvoice])">
        ${svg('cash')} Cobrar ${fmt(total)}
      </button>
    </div>`;

  wrap.innerHTML = html;
}

// ── Helpers carrito ───────────────────────────
function posLimpiar() {
  currentInv().cart = [];
  renderInvTabs();
  renderCart();
}

function posSetType(t) {
  currentInv().itype = t;
  renderCart();
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
  const item = inv.cart[idx];
  if (!item) return;
  const prod = DB.products.find(p => p.id === item.pid);
  const maxForLine = Math.max(0, (prod?.stock || 999) - posCartQtyForProduct(prod?.id || item.product_id || item.pid, idx));
  item.qty += delta;
  if (delta > 0 && item.qty > maxForLine) {
    item.qty = maxForLine;
    toast('Sin más stock', 'w');
  }
  if (item.qty <= 0) inv.cart.splice(idx, 1);
  renderInvTabs();
  renderCart();
}

function posSetQty(idx, val) {
  const inv  = currentInv();
  const item = inv.cart[idx];
  if (!item) return;
  const prod = DB.products.find(p => p.id === item.pid);
  const maxForLine = Math.max(0, (prod?.stock || 999) - posCartQtyForProduct(prod?.id || item.product_id || item.pid, idx));
  if (maxForLine <= 0) {
    inv.cart.splice(idx, 1);
    toast('Sin stock disponible para esa línea', 'w');
  } else {
    item.qty = Math.max(1, Math.min(parseInt(val) || 1, maxForLine));
  }
  renderInvTabs();
  renderCart();
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
  renderInvTabs();
  renderCart();
}

function posRemItem(idx) {
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
    const available = Math.max(0, (Number(prod.stock) || 0) - used);
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
  inv.pmode = 'retail';
  inv.pmeth = 'efectivo';
  inv.disc = 0;
  inv.discAmtInput = 0;
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
  toast(`✓ Reventa cargada en factura #${inv.id}${skipped.length ? ` · ${skipped.length} línea(s) omitida(s)` : ''}`);
  return true;
}

window.posLoadResaleCart = posLoadResaleCart;

function posDisc(val) {
  currentInv().disc = Math.min(100, Math.max(0, parseFloat(val) || 0));
  renderCart();
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
  if (mode === 'amt') inv.discAmtInput = amt;
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
  const total = _posRound2(grossSubtotal - discAmt);
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
  const subtotal = _posRound2(total - itbis);
  return { subtotal, grossSubtotal, discAmt, itbis, total, disc };
}

function invTotal(inv) { return calcTotals(inv).total; }

// ══════════════════════════════════════════════
// MODAL DE COBRO
// ══════════════════════════════════════════════
function openCobroModal(inv) {
  if (!inv || !inv.cart.length) return;
  const { subtotal, itbis, total, discAmt, disc } = calcTotals(inv);

  openModal(`
    <div class="modal-title">Cobrar Venta</div>
    <div class="modal-sub">Total a cobrar: <strong>${fmt(total)}</strong></div>

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
                 oninput="cbrDocHint()" style="flex:1;min-width:0"/>
          <button class="btn btn-out" type="button" onclick="cbrValidarDGII()"
                  title="Verificar en la DGII (requiere internet)" style="flex-shrink:0">DGII</button>
        </div>
        <div id="cbr-cedula-hint" style="font-size:10.5px;margin-top:4px;color:var(--muted2)"></div>
      </div>
    </div>

    <div class="fg">
      <label class="lbl">Método de pago</label>
      <select class="inp" id="cbr-pmeth" onchange="cbrTogglePago(this.value)">
        <option value="efectivo"      ${inv.pmeth==='efectivo'?'selected':''}>Efectivo</option>
        <option value="tarjeta"       ${inv.pmeth==='tarjeta'?'selected':''}>Tarjeta</option>
        <option value="transferencia" ${inv.pmeth==='transferencia'?'selected':''}>Transferencia</option>
        <option value="mixto"         ${inv.pmeth==='mixto'?'selected':''}>Pago Mixto</option>
        <option value="credito"       ${inv.pmeth==='credito'?'selected':''}>Crédito</option>
      </select>
    </div>

    <!-- Efectivo simple -->
    <div id="cbr-efec" style="display:${!inv.pmeth || inv.pmeth==='efectivo' ? 'block' : 'none'}">
      <div class="fg">
        <label class="lbl">Monto recibido</label>
        <div class="inp-ic">
          <div class="ic">${svg('dollar')}</div>
          <input class="inp" id="cbr-received" type="number"
                 placeholder="${fmt(total)}"
                 value="${total.toFixed(2)}"
                 oninput="cbrCalcCambio(${total})"
                 onfocus="this.select()"/>
        </div>
        <div id="cbr-cambio"
             style="font-size:13px;font-weight:700;margin-top:5px;color:var(--muted)"></div>
      </div>
    </div>

    <!-- Pago mixto -->
    <div id="cbr-mixto" style="display:${inv.pmeth==='mixto' ? 'block' : 'none'}">
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
                     oninput="cbrCalcMixto(${total})"/>
            </div>
          </div>
          <div class="fg" style="margin-bottom:0">
            <label class="lbl">Tarjeta / Transferencia</label>
            <div class="inp-ic">
              <div class="ic">${svg('card')}</div>
              <input class="inp" id="cbr-mix-card" type="number" min="0"
                     placeholder="0.00" value="0"
                     oninput="cbrCalcMixto(${total})"/>
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
    <div id="cbr-cred" style="display:${inv.pmeth==='credito' ? 'block' : 'none'}">
      <div class="alrt a">
        <div class="alrt-dot a"></div>
        <div>
          <div class="alrt-title">Venta a crédito</div>
          <div class="alrt-sub">El saldo se agregará al balance del cliente.</div>
        </div>
      </div>
    </div>

    <div class="card" style="background:var(--surface2);margin-top:10px">
        <div class="tr"><span>Subtotal sin ITBIS</span><span>${fmt(subtotal)}</span></div>
      ${disc > 0
        ? `<div class="tr"><span>Descuento (${Math.round(disc*100)/100}%)</span>
           <span>−${fmt(discAmt)}</span></div>` : ''}
      ${inv.itype === 'factura' && itbis > 0
        ? `<div class="tr"><span>ITBIS (${CFG.itbis}%)</span><span>${fmt(itbis)}</span></div>` : ''}
      <div class="tr grand"><span>TOTAL</span><span>${fmt(total)}</span></div>
    </div>

    ${inv.itype === 'factura' ? `
    <label style="display:flex;align-items:center;gap:9px;margin-top:12px;padding:10px 12px;
                  background:var(--surface2);border-radius:8px;cursor:pointer;font-size:13px">
      <input type="checkbox" id="cbr-conduce" style="width:16px;height:16px;cursor:pointer;flex-shrink:0"/>
      <span>
        <strong>Generar también un conduce</strong>
        <span style="color:var(--muted);font-size:11px;display:block">
          Se imprime después de la factura, con las mismas líneas pero <strong>sin precios</strong>.
        </span>
      </span>
    </label>` : ''}

    <div class="modal-foot">
      <button class="btn btn-out" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-green" id="btn-confirmar-venta"
              onclick="finalizarVenta()">
        ${svg('check')} Confirmar y Cobrar
      </button>
    </div>
  `, 'modal-lg');

  // Inicializar cambio inmediatamente si método es efectivo
  setTimeout(() => {
    const pmeth = document.getElementById('cbr-pmeth')?.value;
    if (!pmeth || pmeth === 'efectivo') cbrCalcCambio(total);
  }, 50);

  // Cargar los tipos de comprobante con secuencia disponible (para el preview
  // del NCF que se emitirá). Se cachea en window._ncfAvail; si falla, se asume
  // "desconocido" y el preview no advierte de secuencias faltantes.
  window._ncfAvail = null;
  if (inv.itype === 'factura' && CFG.fiscalEnabled && window.api?.ncf?.getSequences) {
    window.api.ncf.getSequences().then(seqs => {
      const avail = new Set();
      (seqs || []).forEach(s => { if (s.active && s.current < s.to_num) avail.add(s.type); });
      window._ncfAvail = avail;
      cbrDocHint();
    }).catch(() => { window._ncfAvail = new Set(); cbrDocHint(); });
  }
  setTimeout(cbrDocHint, 40);
}

function cbrTogglePago(val) {
  document.getElementById('cbr-efec').style.display   = val === 'efectivo'  ? 'block' : 'none';
  document.getElementById('cbr-mixto').style.display  = val === 'mixto'     ? 'block' : 'none';
  document.getElementById('cbr-cred').style.display   = val === 'credito'   ? 'block' : 'none';
}

// Mantener compatibilidad con llamadas existentes
function cbrToggleCredito(val) { cbrTogglePago(val); }

function cbrCalcMixto(total) {
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
}

function cbrCalcCambio(total) {
  const rec    = parseFloat(document.getElementById('cbr-received')?.value) || 0;
  const cambio = rec - total;
  const el     = document.getElementById('cbr-cambio');
  if (!el) return;
  el.textContent = cambio >= 0
    ? `Cambio: ${fmt(cambio)}`
    : `Faltan: ${fmt(Math.abs(cambio))}`;
  el.style.color = cambio >= 0 ? 'var(--green)' : 'var(--red)';
}

function cbrFilterCli(q) {
  const dd = document.getElementById('cbr-cli-dd');
  if (!dd) return;
  if (!q.trim() || q.trim().toLowerCase() === 'consumidor final') {
    dd.classList.remove('show'); return;
  }
  const matches = DB.customers.filter(c =>
    c.active !== 0 && c.id !== 1 && (
      c.name.toLowerCase().includes(q.toLowerCase()) ||
      (c.rnc && c.rnc.includes(q)) ||
      (c.phone && c.phone.includes(q))
    )
  ).slice(0, 8);

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

  dd.innerHTML = matches.map(c => `
    <div class="cli-opt" onclick="cbrSelectCli(${c.id})">
      <div class="cli-opt-name">${c.name}
        ${c.balance > 0
          ? `<span style="font-size:10px;color:var(--amber);margin-left:6px">
             Bal: ${fmt(c.balance)}</span>`
          : ''}
      </div>
      <div class="cli-opt-meta">
        ${c.rnc || 'Sin RNC'} · ${c.phone || 'Sin teléfono'}
      </div>
    </div>`).join('');
  dd.classList.add('show');
}

function cbrSelectCli(id) {
  const c = DB.customers.find(c => c.id === id);
  if (!c) return;
  const inv     = currentInv();
  inv.cliId     = c.id;
  inv.cliName   = c.name;
  inv.cliCedula = c.rnc || '';
  const sn = document.getElementById('cbr-name');
  const sc = document.getElementById('cbr-cedula');
  if (sn) sn.value = c.name;
  if (sc) sc.value = c.rnc || '';
  document.getElementById('cbr-cli-dd')?.classList.remove('show');
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
  const pmeth     = document.getElementById('cbr-pmeth')?.value    || 'efectivo';
  const cliName   = document.getElementById('cbr-name')?.value?.trim()   || 'Consumidor Final';
  const cliCedula = document.getElementById('cbr-cedula')?.value?.trim() || '';
  // Capturar AQUÍ (antes de closeModal): el DOM del modal se elimina al cerrar.
  const wantConduce = !!document.getElementById('cbr-conduce')?.checked;
  const btnConfirmar = document.getElementById('btn-confirmar-venta');

  inv.pmeth = pmeth;
  inv.cliName = cliName;
  inv.cliCedula = cliCedula;

  if (!inv.cart.length) return;

  // Validar pago mixto: los montos deben sumar el total
  if (pmeth === 'mixto') {
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
  if (pmeth === 'efectivo') {
    const { total } = calcTotals(inv);
    const received = parseFloat(document.getElementById('cbr-received')?.value) || 0;
    if (received < total - 0.01) {
      toast(`El monto recibido (${fmt(received)}) no cubre el total (${fmt(total)})`, 'err');
      return;
    }
  }

  // Buscar cliente registrado o usar consumidor final
  let customer = { id: 1, name: cliName, rnc: cliCedula };
  if (inv.cliId && inv.cliId !== 1) {
    const c = DB.customers.find(c => c.id === inv.cliId);
    if (c) customer = { id: c.id, name: cliName || c.name, rnc: cliCedula || c.rnc || '',
                        address: c.address || '', phone: c.phone || '', email: c.email || '' };
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

  const priceAuthOk = await posEnsureSalePriceAuthorization(inv, items, 'Venta actual');
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
      priceMode:      inv.pmode || 'retail',
      priceChangeAuthToken: inv.priceChangeAuthToken || null,
      mixEfec,
      mixCard,
    },
    type: inv.itype || 'factura',
    session: cajaSession,
  };

  try {
    const result = await window.api.sales.create({
      saleData,
      requestUserId: user.id,
    });

    if (!result.ok) {
      toast(result.error || 'Error al registrar la venta', 'err');
      if (btnConfirmar?.isConnected) {
        btnConfirmar.disabled  = false;
        btnConfirmar.innerHTML = `${svg('check')} Confirmar y Cobrar`;
      } else {
        openCobroModal(inv);
      }
      return;
    }

    // Venta exitosa
    closeModal();
    toast(`✓ Venta #${result.saleId} registrada — ${fmt(result.total)}`);

	    // Recargar datos actualizados desde SQLite
	    await Promise.all([reloadProducts(), reloadCustomers()]);
	    await reloadSales({ range: 'today' });
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
      date:         new Date().toISOString().split('T')[0],
      time:         new Date().toLocaleTimeString('es-DO',
                      { hour: '2-digit', minute: '2-digit' }),
      type:         inv.itype,
      clientId:     customer.id,
      clientName:   cliName,
      clientCedula: cliCedula,
	      items:        printItems,
      subtotal:  result.subtotal,
      disc:      inv.disc || 0,
      discAmt:   result.discAmt || 0,
      itbis:     result.taxAmt || 0,
      total:     result.total,
      pay:       pmeth,
      cajero:    user.name,
      ncf:       result.ncf || '',
      tax_pct:   result.taxPct ?? CFG.itbis,
    };

    // Imprimir ticket 80mm en impresora térmica
    printReceipt({
      ...saleForPrint,
      id:              result.saleId,
      type:            inv.itype,
      customer_id:      customer.id,
      customer_name:   cliName,
      customer_rnc:    cliCedula,
      customer_address: customer.address || '',
      customer_phone:   customer.phone   || '',
      customer_email:   customer.email   || '',
      payment_method:  pmeth,
      payment_amount:  pmeth === 'credito' ? 0 : result.total,
      balance_after_payment: pmeth === 'credito' ? result.total : 0,
      transaction_number: result.saleId,
      mix_efec:        mixEfec,
      mix_card:        mixCard,
    });

    // Conduce opcional: solo si el usuario marcó la casilla. Se imprime DESPUÉS
    // de la factura, con las mismas líneas pero sin precios (nota de entrega).
    if (wantConduce && typeof printConduce === 'function') {
      printConduce({
        ...saleForPrint,
        id:            result.saleId,
        customer_name: cliName,
        customer_rnc:  cliCedula,
      });
    }

    // Limpiar factura y refrescar POS
    removeInvoice(activeInvoice);
    renderPOS(document.getElementById('page'));

    // Ofrecer WhatsApp después de la venta (opcional)
    // Toast con botón — no bloquea el flujo
    _posToastWhatsApp(saleForPrint);

  } catch (e) {
    console.error('[finalizarVenta]', e);
    toast('Error inesperado al procesar la venta', 'err');
    if (btnConfirmar?.isConnected) {
      btnConfirmar.disabled  = false;
      btnConfirmar.innerHTML = `${svg('check')} Confirmar y Cobrar`;
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
        <div>Enviar a ${sale.clientName?.split(' ')[0]}</div>
        <div style="font-size:11px;opacity:.85">Toca para enviar ${sale.type === 'cotizacion' ? 'cotización' : 'factura'} por WhatsApp</div>
      </div>`;
    t.onclick = () => {
      t.remove();
      _posSendWhatsApp(sale);
    };
    document.body.appendChild(t);
    // Auto-ocultar en 6 segundos
    setTimeout(() => { if (t.parentNode) t.remove(); }, 6000);
  }, 800);
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

  const pdfName = `${isFactura ? 'Factura' : 'Cotizacion'}-${String(sale.id).padStart(5, '0')}`;

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
<title>${isFactura ? 'Factura' : 'Cotización'} #${sale.id}</title>
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
      <div class="doc-type">${isFactura ? 'FACTURA' : 'COTIZACIÓN'}</div>
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
        ? `<div><div class="cl">RNC / Cédula</div>
           <div class="cv">${_esc(sale.clientCedula)}</div></div>` : ''}
      <div>
        <div class="cl">Método de pago</div>
        <div class="cv" style="text-transform:capitalize">${_esc(sale.pay)}</div>
      </div>
    </div>
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
