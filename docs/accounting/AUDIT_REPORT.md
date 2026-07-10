# AUDIT_REPORT — Departamento de Contabilidad · Velo POS Desktop

> Fase 1 (Descubrimiento y mapeo). Auditoría **solo lectura + correcciones críticas ya
> aplicadas y commiteadas** (ver §8). No hay refactor masivo. Verificado contra el código
> real (citas `archivo:línea`), no supuesto. App en `v1.14.0`, rama `main`.

## 1. Arquitectura encontrada (Verificado)
- **Electron v29**, `contextIsolation: true`, `nodeIntegration: false`. Proceso main maneja
  toda la BD vía `ipcMain.handle()`; el renderer llama por `contextBridge` (`window.api`).
- **better-sqlite3** (SQLite síncrono, WAL, FK ON). BD en `userData/data/velo.db`
  (packaged) o `./data/velo.db` (dev). `database.js:33`.
- **Patrón repositorio** (`database.js`, ~178 KB) + **migraciones** (`versioning.js`, array
  `MIGRATIONS`, tabla `db_migrations`, idempotentes con PRAGMA guard).
- **Frontend vanilla JS** (`src/js/*`), sin frameworks. Contabilidad: `src/js/contabilidad.js`
  (1186 líneas), Bancos: `src/js/bancos.js` (510).
- **Multiempresa = una BD por negocio** (`business:create` inicializa una BD propia en
  `data/negocios/<id>`, `main.js:3616`). No hay `company_id` en las tablas.

## 2. Componentes de Contabilidad (Verificado)
| Pieza | Ubicación |
|---|---|
| `accountingRepo` | `database.js:2924` |
| `financialAccountsRepo` (bancos) | `database.js:2766` |
| Handlers `accounting:*` (17) | `main.js:4424–4654` |
| Handlers `financial:*` (10) | `main.js:4315–4418` |
| Catálogo de cuentas (seed) | `seedAccountingCatalog()` `versioning.js:899`, migraciones 1.6.x |
| Tablas | `accounting_accounts`, `accounting_entries`, `accounting_entry_lines`, `accounting_config`, `accounting_periods`, `financial_accounts`, `financial_movements` |

**Modelo de saldo:** `accounting_accounts.balance += (debit − credit)` por línea
(`database.js:3018`). Los estados interpretan el signo por tipo de cuenta (activo/gasto
naturaleza deudora; pasivo/capital/ingreso acreedora). No hay `naturaleza` explícita por
cuenta — se infiere del `type`.

## 3. Flujo de una venta (trazado) — AHORA en tiempo real (tras §8)
```
sales:create (main.js) → salesRepo.create() [tx: venta + items + inventario + caja/CxC]
  → _acctHook(generateSaleEntry)  [post-commit, no bloqueante]
     → Déb Caja/Banco/CxC · Créd Ingresos + ITBIS · (Déb Costo / Créd Inventario)
```
Abono: `customers:addPayment → generatePaymentEntry` (Déb Caja/Banco · Créd CxC).
Gasto pagado: `expenses:pay/create → generateExpenseEntry`. Anulación: `reverseSourceEntry`.
Devolución: `sales:return → generateReturnEntry`.

## 4. Estado actual — LO QUE FUNCIONA (Verificado con tests)
- **Partida doble validada:** `createEntry` exige `Σdébito == Σcrédito` (±0.01),
  ≥2 líneas, cuentas activas (`database.js:2991`).
- **Contabilidad en tiempo real** (ventas, abonos, gastos pagados, anulaciones,
  devoluciones) — enganchada tras el commit, idempotente y gated por
  `module_contabilidad`. Validado 7/7 con el repo real.
- **Estados financieros correctos tras anular** (balanza, resultados, balance general,
  mayor) — incluyen `anulado` para que original+reverso neteen 0.
- **Reversión sin doble ajuste** (el asiento de reverso ajusta el saldo).
- **Bancos sano:** transferencia enlaza 2 patas (`transfer_group`), anular anula ambas,
  `addMovement` con signo consistente, `status` default `'activo'`.
- **Asientos inmutables:** no existe `updateEntry`/`deleteEntry` (solo `createEntry` y
  `reverseEntry`). `deleteAccount` bloquea si la cuenta tiene líneas.

## 5. HALLAZGOS — bugs y gaps (Verificado)

### 5.1 Corregidos en esta auditoría (§8)
- 🔴 `syncHistorical` llamaba `generateSaleEntry(sale.id)` con un **número** a un método
  que espera `{ saleId }` → **el sync NUNCA generó un asiento** (no-op silencioso).
- 🔴 Estados financieros **descuadraban al anular** (filtraban solo `confirmado`).
- 🔴 Abonos no llegaban a contabilidad (`generatePaymentEntry` era código muerto).
- 🔴 `no such column: now` al anular/pagar gastos (comillas dobles en `datetime`).

### 5.2 Pendientes — gaps reales (NO corregidos aún)
| # | Gap | Evidencia | Impacto |
|---|---|---|---|
| G1 | **Compras NO generan asiento** | `generatePurchaseEntry` no existe; `purchasesRepo` `database.js:2130`, handlers `main.js:2936+` | CxP, entrada de inventario e ITBIS adelantado no se contabilizan |
| G2 | **Handlers de contabilidad SIN control de rol** | `main.js:4424–4654`: 0 chequeos `authRepo.findById`/role | Cualquier usuario puede crear/reversar asientos y ver estados |
| G3 | **Sin centros de costo** | no existe en BD/código | Prompt §7.11 no cubierto |
| G4 | **Cierres de período sin lógica** | tabla `accounting_periods` existe (`versioning.js:558`) pero no hay `closePeriod`/bloqueo | Períodos cerrados no se protegen |
| G5 | **606 (libro/reporte de compras DGII) ausente** | solo 607/608 vía `ncf_log` | Cumplimiento fiscal parcial |
| G6 | **Importes en `REAL` (float)** | 48 columnas `REAL`; `close_amount REAL`… | Riesgo de centavos; hoy mitigado con redondeo, no exacto |
| G7 | **Gasto "por pagar" sin CxP contable** | `generateExpenseEntry` solo actúa en `pagado` (Déb Gasto/Créd Caja) | No registra la Cuenta por Pagar intermedia (criterio de caja) |
| G8 | **Sin conciliación bancaria** | bancos tiene movimientos pero no import/match CSV | Prompt §7.9 no cubierto |
| G9 | **Sin activos fijos / depreciación, presupuestos↔contab, flujo de efectivo, multimoneda, préstamos, nómina contable** | no existen | Prompt §7.14/7.13/7.20/7.17/7.21/7.16 |
| G10 | **Contabilidad NO segmenta por sucursal/almacén** | `accounting_entries` sin `branch_id`/`warehouse_id` | Sin resultados por sucursal ni consolidación |
| G11 | **Idempotencia por existencia, no por llave de evento** | `generate*` chequean `source_module+source_id` | Suficiente hoy; sin versión de regla |

## 6. Fiscal (RD)
- **NCF/e-CF:** existe emisión NCF por secuencias e integración e-CF MSeller (`ecf:*`
  `main.js:3855+`). 607 (emitidos) / 608 (anulados) desde `ncf_log`.
- **Falta:** 606 (compras), libro de ventas/compras contable, cuadre ventas↔607 y
  compras↔606, IT-1/IR-17 preliminar, resumen de retenciones (ITBIS/ISR retenido).
- La contabilidad **no** deriva ITBIS adelantado de compras (ligado a G1).

## 7. Seguridad, integridad y rendimiento
- **Seguridad:** G2 (sin roles en accounting). Prepared statements en todo el repo (bien).
  IPC whitelisted (bien). No hay permisos granulares contables (prompt §7.24).
- **Integridad:** partida doble garantizada; `accounts.balance` cacheado coincide con
  recálculo desde líneas (tras el fix de reversión). Falta verificación automática
  auxiliar↔control (CxC/CxP/inventario vs mayor).
- **Rendimiento:** los estados recalculan desde líneas con subconsultas por cuenta
  (`getTrialBalance` `database.js:3111`) — aceptable a bajo volumen; a gran volumen conviene
  índice `(account_id, entry_id)` en `accounting_entry_lines` y/o tabla de saldos por período.

## 8. Correcciones críticas ya aplicadas (commiteadas en `main`)
Necesarias para que la contabilidad fuera auditable/funcional (documentadas):
1. `fix(gastos): "no such column: now"` — `datetime('now')` (commit `975f038`).
2. `fix(contabilidad): estados descuadraban tras anular` (`80c8c24`).
3. `fix(contabilidad): sync reversa anulados` (`a7597ae`).
4. `feat(contabilidad): tiempo real + abonos + bugfix sync no-op` (`99d92f9`).

## 9. Riesgos de migración / datos
- **NO tocar:** NCF emitidos, numeración de facturas, `old_id_factura`/import histórico,
  migraciones ya aplicadas. Multiempresa por BD separada — cualquier columna nueva contable
  debe migrarse en cada BD de negocio.
- Cambiar `REAL`→decimal (G6) exige migración de datos y política de redondeo — alto riesgo,
  fase tardía con respaldo.

## 10. Plan por fases (adaptado al repo) — ver IMPLEMENTATION_STATUS.md
Resumen: **F1 Auditoría (este doc)** → **F2 Roles+período (G2,G4)** → **F3 Compras→contab
(G1,G7,ITBIS adelantado)** → **F4 Cuadres auxiliar↔mayor + 606** → **F5 Conciliación
bancaria** → **F6 Centros de costo + sucursal (G3,G10)** → **F7 Activos/presupuestos/flujo**
→ **F8 Precisión decimal (G6) + rendimiento + E2E**.
Sin refactor masivo; cada fase incremental, migración aditiva, con pruebas.
