# Módulo de Contabilidad (v1.6.x)

[← Volver a CLAUDE.md](../CLAUDE.md) · Relacionados: [Visión general](overview.md) · [Impresión](printing-module.md)

Módulo completo de contabilidad + bancos, agregado en las migraciones v1.6.x.

## Activación
- Toggle `module_contabilidad` en Panel Dev (`superadmin.js`) → guarda en settings.
- El sidebar muestra "Bancos y Cuentas" + "Contabilidad" cuando `CFG.module_contabilidad === '1'`.
- Migraciones corren automáticamente en el primer arranque.

## Migraciones de BD (`versioning.js`)
- **1.6.0**: tablas `financial_accounts` + `financial_movements`; siembra Caja General + Banco Principal.
- **1.6.1**: tablas `accounting_accounts`, `accounting_entries`, `accounting_entry_lines`, `accounting_config`, `accounting_periods`.
- **1.6.2**: siembra catálogo de cuentas RD completo (códigos 1xxx–7xxx) + mapeos por defecto en `accounting_config`.
- **1.6.3**: agrega `module_contabilidad='0'` a settings.

## Repos (`database.js`)
- `financialAccountsRepo` — getAll/getById/create/update/toggleActive/getMovements/addMovement/transfer/cancelMovement/getSummary
- `accountingRepo` — getAccounts/createAccount/updateAccount/deleteAccount/getConfig/setConfig/createEntry/getEntries/getEntryById/reverseEntry/getLedger/getTrialBalance/getIncomeStatement/getBalanceSheet/getDashboardStats/generateSaleEntry/generateExpenseEntry

## Handlers IPC (`main.js`)
- 10 handlers `financial:*` + 15 handlers `accounting:*`.
- `_normalizeFinAcct()` y `_normalizeFinMov()` normalizan nombres de campo de la BD.
- `getIncomeStatement` reforma → `{ revenue_items, cogs_items, expense_items, total_revenue, total_cogs, total_expenses, gross_profit, net_income }`.
- `getBalanceSheet` reforma → `{ asset_items, liability_items, equity_items, total_assets, total_liabilities, total_equity }`.
- `getLedger` reforma filas planas → `{ account, lines[], total_debit, total_credit, closing_balance }`.
- `accounting:createEntry` mapea campos de UI: `description`→`concept`, `type`→`source_module`, `created_by`→`userId`.
- `accounting:reverseEntry` firma: `reverseEntry(entryId, userId, reason)` — `userId` antes de `reason`.

## Archivos frontend
- `src/js/bancos.js` — UI de bancos (tabs: Cuentas, Movimientos, Transferencias, Resumen) + impresión.
- `src/js/contabilidad.js` — UI de contabilidad (tabs: Dashboard, Catálogo, Asientos, Mayor, Bal.Comprobación, Resultados, Bal.General, CxC, CxP, Configuración) + impresión en cada reporte.
- `src/css/styles.css` — `.mod-tabs`, `.fin-card`, `.ledger-tbl`, `.trial-tbl`, `.fin-report`, `.entry-lines`, etc.

## Puntos de integración modificados
- `preload.js` — `window.api.financial.*` + `window.api.accounting.*`
- `src/js/data.js` — `CFG.module_contabilidad`
- `src/js/app.js` — nav items (bancos + contabilidad), títulos de topbar, casos del router
- `src/index.html` — `<script>` para bancos.js + contabilidad.js
- `src/js/superadmin.js` — entrada `module_contabilidad` en `modsDefs`

## Hechos clave
- `accounting_entries.concept` = campo descripción (NO `description`).
- `accounting_entries.source_module` = tipo de asiento (`venta`, `gasto`, `manual`, `abono`, etc.).
- Auto-asientos generados vía `generateSaleEntry`/`generateExpenseEntry` tras cada venta/gasto (silencioso, no bloqueante).
- `syncHistorical` (IPC) puede rellenar hasta 500 ventas + 500 gastos no sincronizados.
