# CRM Cerebro → CRM de Ventas (ruta "tipo HubSpot")

[← Volver a CLAUDE.md](../CLAUDE.md) · Relacionados: [Visión general](overview.md) · [Clientes empresa](clientes-empresas.md) · [Preventa y Despacho](preventa-despacho.md)

Plan por fases para llevar el **CRM Cerebro** (ya existente, offline, apagado por
defecto) hacia un CRM de ventas con las piezas de HubSpot que **sí encajan** en
una tienda de mostrador RD sin nube. Continúa la numeración del CRM original
(F0 → F-Aprendizaje ya entregadas); estas fases nuevas son la **serie G**
(G = grande / ventas).

> **Principio rector:** no clonar HubSpot. Tomar lo que mueve la aguja en un
> micro-negocio offline y montarlo sobre primitivas que Velo ya tiene. Todo
> gated por `module_crm='1'`, apagado por defecto, migraciones idempotentes,
> explicable (sin caja negra), seguro en multi-terminal.

---

## Qué ya existe (la base — no se reinventa)

| Pieza HubSpot | En Velo hoy | Dónde |
|---|---|---|
| Contactos persona/empresa, sub-contactos, sucursales | ✅ | `customers`, `customer_contacts`, `customer_branches` |
| Scoring de contactos | ✅ RFM+ 6 ejes | `crmRepo.customer360` (`database.js`) |
| Ficha 360° | ✅ | `crm:customer360`, `src/js/crm.js` |
| Segmentación | ✅ VIP/frecuente/en riesgo/dormido/nuevo | `_crmSegmentOf` |
| Bitácora de actividad | ✅ parcial | `customer_interactions` |
| Tareas (proto) | ✅ "Contactar hoy" | `crmRepo.contactToday` |
| Email marketing | ⚠️ manual, 1-a-1 | `openWhatsAppModal` (`src/js/data.js`) |
| Vendedores/propietario de cuenta | ✅ existe módulo | `salespeople` / `salespeopleRepo` |
| Enriquecimiento de producto | ⚠️ tabla creada, sin cablear | `product_enrichment` |
| Caché de scoring | ⚠️ tabla creada, **sin usar** | `customer_scores` |

## Qué NO se hace (y por qué)
Formularios/landing web, tracking de sitio, secuencias de email automáticas,
integración con calendarios externos, gestión de anuncios. Requieren nube y un
equipo de marketing — peso muerto para una tienda de mostrador. Se omiten a
propósito.

---

## G0 — Mejoras inmediatas (1–2 días) · ⚡ arrancar ya

Cierran fugas ya detectadas en el código actual. Bajo riesgo, alto retorno.

1. **"Contactar hoy" deja de re-mostrar a quien ya contactaste.**
   `contactToday()` ya registra la interacción (`logInteraction`, kind `whatsapp`)
   pero **no la consulta**. Añadir `NOT EXISTS` contra `customer_interactions`
   con enfriamiento por motivo (crédito 3 d, dormido/recompra 7–14 d). La lista
   pasa a ser un pendiente que **se achica**.
2. **Ordenar "Contactar hoy" por conversión real.** `learningStats` ya calcula
   la tasa de compra por motivo; usarla para priorizar los motivos que de verdad
   funcionan en ESTE negocio.
3. **Cross-sell en el POS (canasta).** `product360.boughtWith` ya calcula "se
   vende junto con"; exponerlo al agregar un producto en `pos.js`.
4. **Resumen del día (badge 🔔).** Colgar de la campanita: "hoy N créditos vencen,
   M en riesgo, K por caducar" desde `atRisk` / `contactToday` / `warehouseReview`.

**DoD:** la lista de contacto no repite contactados; el POS sugiere complementos;
la campanita muestra el pulso del día. Sin cambios de esquema (salvo índice
opcional en `customer_interactions(customer_id, created_at)`).

---

## G1 — Línea de tiempo unificada del cliente (fundación)

**Objetivo:** un solo feed cronológico por cliente con TODO: ventas, abonos,
cotizaciones, devoluciones, notas, WhatsApp, llamadas. Es el "contact timeline"
de HubSpot y la base visual de las fases siguientes.

- **Se apoya en:** `sales`, `payments`, `customer_interactions` (ya existen).
- **BD:** ninguna tabla nueva — es una **vista de agregación** en `crmRepo`.
- **Backend:** `crmRepo.timeline(customerId)` que une y ordena eventos con tipo,
  fecha, monto y referencia (nº de factura/recibo real, ver fix 1.40.3).
- **Frontend:** pestaña/timeline en la ficha 360° (`src/js/crm.js`).
- **Riesgo:** bajo (solo lectura).
- **DoD:** abrir un cliente muestra su historia completa en orden, con enlaces al
  documento origen.

---

## G2 — Tareas y recordatorios (con dueño y fecha)

**Objetivo:** formalizar el seguimiento. "Contactar hoy" es reactivo; esto añade
tareas **con fecha de vencimiento y vendedor asignado** ("Llamar a X el jueves").
Cada vendedor ve *sus* pendientes.

- **Se apoya en:** `salespeople`, `customer_interactions`, `contactToday`.
- **BD (migración):** tabla `crm_tasks` (id, customer_id, salesperson_id/user_id,
  title, due_date, status ['abierta','hecha','vencida'], source ['manual','auto'],
  reason, created_at, done_at). Idempotente, gated.
- **Backend:** CRUD en `crmRepo` + handlers `crm:tasks*` en `main.js`.
- **Frontend:** bandeja "Mis tareas" + botón "crear tarea" en la ficha 360° y en
  cada tarjeta de "Contactar hoy" (convierte una sugerencia en tarea con dueño).
- **Aprendizaje:** cerrar una tarea alimenta el bucle de efectividad ya existente.
- **Riesgo:** bajo-medio (tabla nueva, sin tocar ventas).
- **DoD:** un vendedor abre Velo y ve sus pendientes con fecha; marcar hecha
  reinicia el ciclo y queda en la timeline.

---

## G3 — Pipeline de oportunidades (kanban de negocios) · ⭐ la firma de HubSpot

**Objetivo:** convertir cotizaciones sueltas en **negocios en etapas** con valor
esperado y seguimiento. `Cotizado → En seguimiento → Ganado / Perdido`, con
antigüedad ("lleva 12 días sin moverse") y motivo de pérdida.

- **Se apoya en:** cotizaciones (`sales.type='cotizacion'`), `salespeople`,
  `checkout_orders` (preventa/despacho ya maneja estados — mismo patrón de máquina
  de estados).
- **BD (migración):** `crm_opportunities` (id, customer_id, salesperson_id,
  source_quote_id → sales, stage, expected_value, currency, probability, status
  ['abierta','ganada','perdida'], lost_reason, opened_at, closed_at, updated_at).
  Una cotización puede materializar una oportunidad; ganarla se enlaza a la
  factura resultante para medir conversión real.
- **Backend:** `crmRepo.pipeline()` (agrupado por etapa, con totales y aging),
  `moveStage`, `win`/`lose`. Handlers `crm:pipeline*`.
- **Frontend:** kanban arrastrable por etapas (reusar patrones de UI existentes),
  tarjeta con cliente, valor, días en etapa; cerrar → ganada (link a factura) o
  perdida (motivo).
- **Riesgo:** medio (concepto nuevo, pero no altera el flujo de venta; una
  oportunidad es una capa sobre la cotización, no la reemplaza).
- **DoD:** el dueño ve "RD$X en pipeline", qué se está enfriando, y su tasa de
  cierre. Cotizar deja de ser un PDF perdido.

---

## G4 — Campañas de WhatsApp por segmento (el "email marketing" versión RD)

**Objetivo:** en vez de email masivo, elegir un **segmento** (dormidos, VIP, en
riesgo), redactar el mensaje una vez y enviarlo cliente por cliente (o en cola) —
**manual**, como ya se hace, sin spam ni riesgo de bloqueo.

- **Se apoya en:** segmentación (`_crmSegmentOf`), `openWhatsAppModal`,
  `customer_interactions`.
- **BD (migración):** `crm_campaigns` (id, name, segment_filter, template,
  created_at) + `crm_campaign_sends` (campaign_id, customer_id, status, sent_at).
- **Backend:** construir la lista del segmento, plantilla con variables
  ({nombre}, {producto habitual}, {saldo}); registrar cada envío como interacción
  (alimenta el aprendizaje).
- **Frontend:** "Nueva campaña" → elige segmento → previsualiza N destinatarios →
  enviar de a uno con el texto listo; barra de progreso (enviados/total).
- **Riesgo:** medio (respetar el envío manual del usuario; nunca auto-enviar).
- **DoD:** "mandarle a los 40 dormidos el mensaje de reactivación" toma minutos,
  y a los 30 días se ve cuántos volvieron a comprar.

---

## G5 — Dashboard y reportes CRM

**Objetivo:** los reportes de los que vive HubSpot, a tu escala: tasa de
conversión de cotizaciones, valor del pipeline, ingreso en riesgo, desempeño por
vendedor, efectividad de campañas.

- **Se apoya en:** todo lo anterior + módulo Reportes existente.
- **BD:** ninguna (agregación de lectura).
- **Frontend:** panel con tarjetas + tendencias; filtro por vendedor y período.
- **Riesgo:** bajo.
- **DoD:** el dueño abre un tablero y entiende su embudo sin exportar a Excel.

---

## G6 — Refinamientos (cuando sobre tiempo)

- **Dinero en la segmentación:** `_crmSegmentOf` hoy usa solo frecuencia+recencia;
  incorporar `monetary`/`margin` para que "VIP" signifique valor real.
- **Detector de clientes duplicados:** por teléfono/RNC (hay dupes reales en data
  importada) + merge asistido; mejora TODA métrica aguas arriba.
- **Activar la caché `customer_scores`:** recomputar throttled y leer de ahí para
  escalar a miles de clientes sin recalcular en cada apertura.
- **Guard de margen con costo 0:** evitar clasificar como "estrella" productos sin
  costo cargado (data importada).
- **Enriquecimiento web de productos:** cablear `product_enrichment` (opt-in,
  offline-cache) — nombre/imagen/specs por código de barras.

---

## Orden recomendado y dependencias

```
G0 (ya)  →  G1 timeline  →  G2 tareas  →  G3 pipeline  →  G4 campañas  →  G5 dashboard
                     └──────────────┴─────── G3 y G4 alimentan G5 ───────┘
G6 refinamientos: en paralelo, oportunistas.
```

- **G0** primero: momentum + arregla fugas ya visibles.
- **G1** antes que G2/G3: la timeline es la superficie donde tareas, oportunidades
  y campañas se muestran.
- **G3** es el salto de mayor valor "tipo HubSpot"; hacerlo tras G1/G2 para que
  descanse sobre timeline + tareas.

## Reglas transversales (para toda la serie G)
- Gated por `module_crm`, **apagado por defecto**; cero impacto si el módulo no
  está activo.
- Cada fase = una migración idempotente y guardada (patrón `MIGRATIONS` en
  `versioning.js`), reversible en lo posible, nunca toca montos/fiscal.
- Reutilizar helpers existentes (`openWhatsAppModal`, `print.js`, numeración
  documental real de 1.40.3, `salespeopleRepo`).
- Explicable: umbrales visibles, nada de "magia".
- Seguro en multi-terminal (RPC/interceptor ya existentes).
- Cada fase se entrega con su test en `scripts/test-crm-*.js`.
```
