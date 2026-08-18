# VELO SUITE — Arquitectura de plataforma multi-rubro

[← Volver a CLAUDE.md](../CLAUDE.md) · Relacionados: [Visión general](overview.md) · [Multi-terminal](multi-terminal-sync.md) · [Server service](server-service.md) · [CRM roadmap](crm-hubspot-roadmap.md)

Cómo convertir **VELO POS** (tienda de repuestos) en la base de **VELO SUITE**:
varios productos por rubro (**VELO TECH POS** para celulares/tecnología, y los que
vengan) sobre **un solo core compartido**, sin forks y sin romper lo que ya
funciona en producción.

> **Decisión central:** un core, N *vertical packs*. **NO** dos repos, **NO**
> `git clone`. El foso de la suite es el código compartido; cada fork lo destruye.

---

## 1. Principios rectores

1. **Un codebase, N productos.** Ya construyes 2 ediciones (Terminal/Server) de
   un mismo repo con configs distintas (`build/electron-builder-terminal.js`,
   `build/electron-builder-server.js`). El rubro es el mismo patrón extendido.
2. **El core es agnóstico al rubro.** Fiscal, contabilidad, caja, clientes,
   impresión, CRM, multi-terminal, licencia: idénticos en todo rubro.
3. **El rubro es una capa enchufable**, no una bifurcación del código.
4. **Una sola base de datos y un solo sistema de migraciones.** Las diferencias de
   rubro son columnas/tablas *opcionales*, nunca esquemas paralelos.
5. **Cada mejora beneficia a toda la suite a la vez.** Un fix fiscal, un parche de
   seguridad o el CRM llegan a todos los productos con el mismo commit.
6. **Refactor sin regresión:** tras cada fase, VELO POS compila y pasa su suite de
   tests **sin cambios**.

---

## 2. Qué comparten los verticales (el CORE — ~85%)

Todo esto se hereda tal cual, sin tocar:

- **Motor POS** (`salesRepo`, `pos.js`), **Caja** (`cashRepo`, `caja.js`)
- **Clientes** persona/empresa, contactos, sucursales (`customersRepo`)
- **Contabilidad completa** (`accountingRepo`) + **Bancos** (`financialAccountsRepo`)
- **Fiscal RD**: NCF, 607/608, **e-CF (MSeller)** (`ncfRepo`, `_msellerAuth`)
- **Impresión** (`print.js`, `plantillas.js`) — A4 y térmica
- **Reportes** (`reportsRepo`), **CRM Cerebro** (`crmRepo`)
- **Multi-terminal + server service** (`net-server.js` `/rpc`+`/events`, Tailscale)
- **Licencia** (ECDSA offline), **Importador**, **Auditoría**

## 3. Qué es específico de un rubro (~15%)

| Pieza | VELO POS (auto) | VELO TECH POS (tecnología) |
|---|---|---|
| Identidad/branding | Velo POS, verde | Velo Tech POS, su color |
| Terminología | "repuesto", "vehículo" | "equipo", "IMEI" |
| Modelo de producto | fungible (stock) | **serializado (IMEI/serial)** |
| Módulos extra | Vehículos, Conduces | **Servicio/Reparación**, Trade-in, Garantía |
| Catálogo default | familias de repuestos | marcas/modelos/capacidad/color |

---

## 4. La capa de rubro (*vertical pack*)

Un rubro se define en **un solo módulo de configuración** — enchufable, sin tocar
el core. Propuesta de ubicación: `src/verticals/<rubro>.js`.

```js
// src/verticals/tech.js  (equivalente: auto-parts.js con los valores actuales)
module.exports = {
  id: 'tech',
  product: {
    appId: 'do.velotechpos.app',
    name: 'Velo Tech POS',
    // ícono y artifactName los fija el build config (ver §7)
  },
  theme: {                     // se inyecta como CSS variables en :root (§4.2)
    brand:  '#2563eb',
    brand2: '#0ea5e9',
    // ...paleta completa
  },
  terminology: {               // mapa de labels (§4.3)
    product_singular: 'Equipo',
    product_plural:   'Equipos',
    code_label:       'IMEI / Serial',
    catalog_title:    'Inventario de equipos',
  },
  modules: {                   // qué se enciende por defecto (§4.4)
    service_orders: true,      // reparación
    trade_in:       true,
    vehicles:       false,     // apagado en TECH
    serialized:     true,      // modelo de producto serializado (§5)
  },
  defaultCatalog: 'tech',      // plantilla de categorías/atributos de arranque
};
```

**El core lee el vertical activo** desde una constante compilada al build
(`VELO_VERTICAL`, ver §7) con espejo en `settings.business_vertical` para el
comportamiento de datos. Auto-parts es el **default** — VELO POS no cambia.

### 4.1 Selección del rubro
- **Identidad del producto (appId, nombre, ícono): build-time.** Cada instalador
  ES un producto (como Terminal/Server hoy). Un cliente instala "Velo Tech POS".
- **Comportamiento de datos (serializado, módulos): runtime**, derivado del
  vertical compilado y persistido en `settings.business_vertical` en el primer
  arranque (para que las migraciones y repos sepan cómo actuar).

### 4.2 Tema
Los colores ya son variables CSS. Hoy están fijos; el cambio es cargar la paleta
del `theme` del vertical en `:root` al iniciar el renderer (`app.js`/`data.js`).
Auto-parts = paleta actual → **cero cambio visual para VELO POS**.

### 4.3 Terminología
Un helper `t('product_singular')` que resuelve contra `vertical.terminology`, con
fallback a las etiquetas actuales. Se aplica gradualmente en la UI; sin migrar,
todo sigue diciendo lo de hoy.

### 4.4 Módulos
Ya gateas módulos por `settings.module_xxx` leídos por el router (`app.js`) y el
sidebar, definidos en `modsDefs` (`superadmin.js`). El vertical solo aporta el
**set por defecto** de qué viene encendido. Mecanismo idéntico al existente.

---

## 5. Modelo de datos serializado (la única adición estructural)

Hoy `products` es **fungible** (stock numérico). TECH necesita rastrear **cada
unidad por IMEI**. Se agrega como **capa opcional sobre `products`**, en la misma
base y el mismo sistema de migraciones.

```sql
-- Migración (idempotente, patrón MIGRATIONS de versioning.js)
ALTER TABLE products ADD COLUMN serialized INTEGER DEFAULT 0;

CREATE TABLE IF NOT EXISTS product_units (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id    INTEGER NOT NULL REFERENCES products(id),
  imei          TEXT,
  serial        TEXT,
  condition     TEXT DEFAULT 'nuevo',   -- nuevo | usado | reacondicionado
  status        TEXT DEFAULT 'en_stock' -- en_stock | reservado | vendido | servicio | devuelto
                  CHECK(status IN ('en_stock','reservado','vendido','servicio','devuelto')),
  unit_cost     REAL DEFAULT 0,         -- cada equipo tiene su propio costo
  color         TEXT DEFAULT '',
  capacity      TEXT DEFAULT '',
  warranty_until TEXT,
  sale_id       INTEGER REFERENCES sales(id),
  received_at   TEXT DEFAULT (datetime('now','localtime')),
  sold_at       TEXT,
  notes         TEXT DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_product_units_imei
  ON product_units(imei) WHERE imei IS NOT NULL AND TRIM(imei)<>'';
CREATE INDEX IF NOT EXISTS idx_product_units_lookup
  ON product_units(product_id, status);
```

**Reglas de comportamiento (solo cuando `products.serialized=1`):**
- **Stock** de un producto serializado = `COUNT(product_units WHERE status='en_stock')`
  (no el campo `stock`). Un helper de stock centraliza esto para que el resto del
  core no cambie.
- **Vender** exige elegir una **unidad concreta** (IMEI). La venta enlaza
  `product_units.sale_id` y marca `status='vendido'`, `sold_at`.
- **Costo** por unidad (el POS ya guarda `unit_cost` por línea → el asiento de
  costo/COGS funciona sin cambios).
- **Auto-parts:** `serialized=0` en todos los productos → `product_units` queda
  vacía y el flujo es idéntico al actual. **Cero impacto.**

---

## 6. Módulos específicos de TECH POS

### 6.1 Órdenes de servicio / reparación ⭐
Máquina de estados: `recepción → diagnóstico → presupuesto → aprobado → reparando
→ listo → entregado`. Reutiliza el **patrón que ya existe** en `maintenanceRepo`
/ Preventa-Despacho (estados, permisos, snapshots).

```sql
CREATE TABLE service_orders (
  id, customer_id, device_desc, imei, problem, diagnosis,
  quote_amount, status, technician_id, approved_at, delivered_at, ...);
CREATE TABLE service_order_items (   -- repuestos + mano de obra
  service_order_id, kind /*parte|mano_obra*/, description, qty, unit_price, ...);
```
Al entregar, genera una venta normal (repuestos descuentan inventario; mano de
obra es servicio) → **fiscal, contable y de impresión reutilizados**.

### 6.2 Compra de usados / trade-in
Entrada de un equipo usado → crea un `product_unit` (`condition='usado'`) y aplica
su valor como pago/crédito en la venta. Un solo flujo nuevo; el resto es core.

### 6.3 Garantía por IMEI
`warranty_until` por unidad + una consulta "buscar por IMEI" que muestra venta,
cliente y estado de garantía. Alimenta también al CRM (historial del equipo).

---

## 7. Build y distribución

Extiende el patrón multi-edición actual con un config por rubro:

```js
// build/electron-builder-tech.js  (hermano de -terminal.js / -server.js)
module.exports = {
  appId: 'do.velotechpos.app',
  productName: 'Velo Tech POS',
  // icono propio, artifactName propio
  extraMetadata: { veloVertical: 'tech' },   // → VELO_VERTICAL en runtime
  // canal de update propio (latest-tech.yml) para no mezclar auto-updates
};
```

- **Scripts:** `build:win:tech`, `release:win:tech` (espejo de los actuales).
- **Auto-update aislado:** cada producto publica su propio `latest-*.yml` →
  electron-updater nunca cruza un instalador de un producto a otro (mismo
  principio que Terminal vs Server hoy).
- **Un tag → un producto**, o un workflow que compile los que cambiaron.

## 8. Licencia de suite

El sistema de licencia ya existe (ECDSA offline). Extenderlo para que el token
declare **qué producto(s)** habilita el cliente (`velo_pos`, `velo_tech_pos`) y
gate el vertical. Un cliente puede tener uno o ambos.

> ⚠️ **Prerrequisito:** arreglar la vulnerabilidad de licencia ya identificada en
> la auditoría **antes** de la suite — una vez arreglada, protege a TODOS los
> productos con el mismo código. Ver [auditoría pendiente].

---

## 9. Orden de refactor — sin romper VELO POS

Invariante de cada fase: **VELO POS compila y pasa toda su suite de tests sin
cambios de comportamiento.** Auto-parts es siempre el default.

| Fase | Qué | Riesgo | DoD |
|---|---|---|---|
| **R0** | Costura del vertical: `src/verticals/auto-parts.js` con los valores ACTUALES + constante `VELO_VERTICAL` (default `auto_parts`). Refactor puro, sin cambio de comportamiento. | Bajo | Tests actuales pasan; VELO POS idéntico. |
| **R1** | Tema por variables CSS desde `vertical.theme` (auto-parts = paleta actual). | Bajo | Sin cambio visual en POS. |
| **R2** | Terminología: helper `t()` con fallback a labels actuales; se adopta gradual. | Bajo | Nada cambia hasta migrar cada label. |
| **R3** | Modelo de producto: `products.serialized` + tabla `product_units` + `productUnitsRepo`, **apagado** para auto-parts. Helper de stock centralizado. | Medio | `serialized=0` ⇒ flujo actual intacto; tests de ventas verdes. |
| **R4** | Build `electron-builder-tech.js` + scripts + `src/verticals/tech.js` (branding, tema, terminología, módulos). Primer instalador **Velo Tech POS**. | Medio | Instalador TECH arranca con su identidad y tema. |
| **R5** | Módulo Servicio/Reparación (§6.1) sobre el patrón de maintenance/preventa. | Medio | Orden de servicio → venta fiscalmente correcta. |
| **R6** | Trade-in (§6.2) + Garantía por IMEI (§6.3). | Medio | Comprar usado y buscar por IMEI funcionan. |
| **R7** | Licencia por producto (§8). | Medio | El token habilita/gatea el vertical. |

**R0–R3 son la plataforma** (se hacen dentro de VELO POS sin sacar nada nuevo).
**R4–R7 son VELO TECH POS** como primer *vertical pack*.

---

## 10. Anti-patrones (lo que NO se hace)

- ❌ **Clonar el repo.** Dos codebases que divergen para siempre; cada fix se porta
  a mano. Mata la suite.
- ❌ **Dos bases de datos / esquemas paralelos.** Una sola base; el rubro son
  columnas/tablas opcionales.
- ❌ **Extraer un "framework de suite" perfecto de entrada.** Abstraer con un solo
  ejemplo es tan malo como clonar. Haz la costura (R0–R3), construye TECH como el
  **primer** ejemplo real, y extrae a paquete compartido solo cuando un **tercer**
  vertical lo justifique.
- ❌ **Meter lógica de rubro en el core con `if (vertical === 'tech')` regado.**
  El rubro se expresa por configuración (vertical pack) y por flags de datos
  (`serialized`), no por condicionales dispersos.

## 11. Veredicto

VELO TECH POS **no es un proyecto nuevo**: es un *vertical pack* (branding + tema +
terminología + módulos) + **inventario serializado** + **módulo de servicio**,
todo sobre el core que ya existe y está probado. Con esta estructura, meses se
vuelven semanas y **cada mejora futura llega a toda VELO SUITE con un solo commit.**
