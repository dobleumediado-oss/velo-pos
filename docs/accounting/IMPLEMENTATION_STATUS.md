# IMPLEMENTATION_STATUS — Contabilidad · Velo POS

> Estado por módulo (prompt maestro §7) y plan por fases. Fuente: auditoría Fase 1
> (`AUDIT_REPORT.md`). ✅ hecho · 🟡 parcial · ⛔ ausente. App `v1.14.0`, rama `main`.
> Progreso: **F1 ✅ · F2 ✅ · F3 ✅ · F4 ✅ (cuadres + 606) · F5 ✅ (conciliación bancaria)**.

## Matriz de estado

| Área (§7) | Estado | Nota |
|---|---|---|
| Dashboard contable (7.1) | 🟡 | `getDashboardStats` con ingresos/gastos/costo/saldos clave; faltan pasivos/patrimonio, ITBIS, flujo, alertas, filtros por sucursal |
| Catálogo de cuentas (7.2) | 🟡 | CRUD + jerarquía `parent_id` + `is_summary` (no mueve en agrupadoras). Falta naturaleza explícita, requiere-auxiliar/centro, saldo inicial |
| Motor de asientos automáticos (7.3) | 🟡 | **EN VIVO** venta/abono/gasto (devengo+pago)/**compra**/anulación/devolución. Falta notas de débito, ajustes de inventario, transferencias, comisiones, depreciación, retenciones |
| Config. reglas contables (7.4) | 🟡 | `accounting_config` por `key`→cuenta con fallback a código. Falta resolución por producto/categoría/sucursal/método y UI de alertas de cuenta faltante |
| Asientos y estados (7.5) | 🟡 | Estados `confirmado`/`anulado`/`borrador`; inmutables (sin edit/delete). Falta flujo borrador→revisión→aprobado, adjuntos, aprobador |
| Diario/Mayor/Auxiliares (7.6) | 🟡 | Mayor + balanza + drill-down. Falta diarios por tipo (ventas/compras/caja) formales |
| Cuentas por cobrar (7.7) | 🟡 | Auxiliar operativo (clientes) + abonos→contab. Falta antigüedad contable, conciliación auxiliar↔control, provisión incobrables |
| Cuentas por pagar (7.8) | 🟡 | **Contable devengado en vivo** (gasto/compra → Créd CxP 2101; pago → Déb CxP). Falta antigüedad de CxP, conciliación auxiliar↔control 2101, pago formal a proveedor por OC |
| Caja/Bancos/Tesorería (7.9) | 🟡 | Bancos (cuentas+movimientos+transfer) sano + **conciliación bancaria** (import CSV, auto/manual match, ignorar). Falta conciliación de caja (sesiones) e importación Excel directa |
| Impuestos/fiscal RD (7.10) | 🟡 | NCF + e-CF + 607/608 + **606 (compras con RNC)**. Falta libros venta/compra formales, cuadre ventas↔607 automático, IT-1/IR-17, retenciones |
| Centros de costo (7.11) | ⛔ | Diferido: no hay dato operativo que capturar (0 sucursales, ninguna tabla lleva branch_id, sin "sucursal activa"). Segmentar asientos sería infraestructura muerta hasta que exista el concepto en operaciones |
| Multiempresa/sucursal (7.12) | 🟡 | Multiempresa por **BD separada**. **Falta segmentación por sucursal en asientos + consolidación** |
| Presupuestos (7.13) | 🟡 | Presupuestos de **gastos** existen; no ligados a contabilidad ni real-vs-presupuesto contable |
| Activos fijos (7.14) | 🟡 | **Registro de activos + depreciación lineal** (`fixedAssetsRepo`, tablas fixed_assets/depreciation_entries): corrida mensual idempotente Déb 6119/Créd 1203, baja con pérdida, pestaña "Activos". Falta métodos acelerados y revaluación |
| Inventario contable (7.15) | 🟡 | Costo en venta (COGS/Inv) + **entrada por compra (Déb Inventario 1105)**. **Falta cuadre valor inventario operativo↔cuenta contable**, kardex valorizado contable |
| Nómina contable (7.16) | ⛔ | No existe nómina |
| Monedas (7.17) | ⛔ | Solo DOP; sin tasa/dif. cambiaria |
| Cierres (7.18) | 🟡 | **Cierre/reapertura de período + bloqueo de posteo** (F2). UI en pestaña "Períodos". Falta asiento de cierre de resultados a patrimonio |
| Estados financieros (7.19) | 🟡 | Resultados + balance general + balanza (correctos tras fix). Falta flujo de efectivo, cambios en patrimonio, comparativos, indicadores |
| Flujo de efectivo (7.20) | 🟡 | **Estado de flujo de efectivo (método directo)** `getCashFlow` + pestaña "Flujo Efectivo": operación/inversión/financiamiento, efectivo inicial→final. Falta comparativo entre períodos |
| Préstamos (7.21) | ⛔ | No implementado |
| Documentos/soportes (7.22) | ⛔ | Sin adjuntos en asientos |
| Flujos de aprobación (7.23) | 🟡 | Gastos tienen aprobación; asientos no |
| Roles y permisos (7.24) | 🟡 | **Handlers `accounting:*`/`financial:*` exigen admin** (F2); reabrir período solo superadmin. Falta granularidad por operación |
| Auditoría (7.25) | 🟡 | `audit()` registra acciones clave; falta valor anterior/nuevo en asientos y auditoría inmutable dedicada |
| Alertas (7.26) | 🟡 | **Cuadres auxiliar↔mayor con alerta de descuadre** (pestaña Cuadres, F4). Falta alerta de venta sin asiento y notificación proactiva |
| Importaciones/exportaciones (7.27) | 🟡 | Importador universal (ventas/clientes/gastos…). Falta import de catálogo/saldos/asientos contables |
| Apertura y migración (7.28) | ⛔ | Sin asistente de saldos iniciales contables |

## Verificaciones de integridad (prompt §14/§19) — pendientes de automatizar
```
Débitos = Créditos                         ✅ garantizado por createEntry
accounts.balance = recálculo desde líneas  ✅ (tras fix reversión)
Inventario operativo = cuenta contable     ✅ getReconciliation (pestaña Cuadres)
CxC auxiliar = cuenta control CxC          ✅ getReconciliation (pestaña Cuadres)
CxP auxiliar = cuenta control CxP          ✅ getReconciliation (pestaña Cuadres)
Caja operativa = cuenta contable caja      ⛔ pendiente (sesiones de caja — F5/F7)
```

## Plan por fases (adaptado — sin refactor masivo, aditivo, con pruebas)

- **F1 — Auditoría** ✅ (este doc + AUDIT_REPORT.md). Correcciones críticas ya aplicadas.
- **F2 — Gobierno contable ✅:** control de rol en handlers `accounting:*`/`financial:*` (G2);
  cierre/reapertura de período + bloqueo de posteo en período cerrado (G4) + UI "Períodos".
- **F3 — Compras/gastos devengados ✅ (G1, G7):** `generateExpenseAccrualEntry` (Déb Gasto/
  Activo + ITBIS Acreditable · Créd CxP 2101) + `generateExpensePaymentEntry` (Déb CxP · Créd
  Caja/Banco, un asiento por pago) + `generatePurchaseEntry` (Déb Inventario 1105 + ITBIS
  Acreditable 1106 · Créd CxP, por recepción con delta idempotente). Enganchado en
  `expenses:create/pay/cancel` y `purchases:receive`; backfill + reconciliación en sync.
  Compatibilidad: no duplica sobre asientos legacy `gasto`. Excluye tipos retiro/aporte/traslado.
- **F4 — Cuadres + fiscal ✅:** `getReconciliation` (CxC↔1104, Inventario↔1105, CxP↔2101)
  con alerta de descuadre + pestaña "Cuadres"; reporte **606** (`get606`, compras con RNC)
  + pestaña "606" con rango e impresión. *Pendiente:* cuadre caja↔1101 (sesiones), libros
  formales de ventas/compras, cuadre ventas↔607 automático.
- **F5 — Conciliación bancaria ✅ (G8):** migración `1.14.1-conciliacion` (columnas
  `reconciled`/`reconciled_at` + tabla `bank_statement_lines`); `bankReconRepo`
  (importStatement con dedup, autoMatch por monto-con-signo±ventana, manualMatch, unmatch,
  ignoreLine, clearBatch, getReconciliation); handlers `bank:*`; pestaña "Conciliación" en
  bancos.js con import CSV (mapeo de columnas, monto con signo o débito/crédito), auto/manual.
  *Nota:* versión de migración con sufijo para no colisionar con el `1.14.1` de feat/multi-terminal.
  *Pendiente:* import Excel directo, conciliación de sesiones de caja.
- **F6 — DIFERIDO (centros de costo/sucursal, G3/G10) + Flujo de efectivo ✅:** la parte de
  sucursal/centro de costo se difiere con justificación (no hay dato operativo: 0 sucursales,
  ninguna tabla operativa lleva `branch_id`, sin "sucursal activa"; sería infraestructura
  muerta). En su lugar se entregó el **Estado de Flujo de Efectivo** (`getCashFlow`, método
  directo; pestaña "Flujo Efectivo"), el 3er estado financiero básico que faltaba — read-only,
  sin migración ni riesgo.
- **F7 — Activos fijos + depreciación ✅ (G9 parcial):** migración `1.14.2-activos`
  (fixed_assets + depreciation_entries); `fixedAssetsRepo` (create/update, monthlyAmount
  línea recta con tope, runDepreciation idempotente por (activo,período) → Déb 6119/Créd 1203
  respetando bloqueo de período, dispose con pérdida a 6120); handlers `assets:*`; pestaña
  "Activos" (registro, resumen, depreciar mes, baja). *Pendiente:* presupuestos↔contabilidad
  (real vs presupuesto), métodos de depreciación acelerada.
- **F8 — Precisión decimal (G6) — NO INICIADA (proyecto aparte):** migración de ~48 columnas
  `REAL`/float de dinero a enteros de centavos + reescritura de la aritmética monetaria +
  índices/rendimiento + E2E. **Única fase NO aditiva (toca datos existentes)** → alto riesgo en
  producción; requiere respaldo, rama dedicada y QA. Mitigado hoy por redondeo. Se recomienda
  tratarla fuera de este hilo de fases.

**Regla:** no avanzar de fase con errores críticos abiertos. Cada fase: inspeccionar →
implementar aditivo → migración idempotente → pruebas (incl. integridad) → commit.

## Cierre — resumen de entrega (parada en F7)

**7 fases cerradas y commiteadas en `main` (sin tag/release, pendientes de QA visual).**

| Fase | Commit | Entregable |
|---|---|---|
| F1 | `732b39b` | Auditoría + 4 correcciones críticas (sync no-op, descuadre por anulación, abonos muertos, `datetime('now')`) |
| F2 | `54f2059` | Roles en handlers contables/bancos (G2) + cierre/bloqueo de período (G4) |
| F3 | `f9f748b` | Devengado: gastos y compras → CxP contable + ITBIS acreditable (G1, G7) |
| F4 | `b609033` | Cuadres auxiliar↔mayor con alerta + reporte 606 (G5) |
| F5 | `5453e47` | Conciliación bancaria: import CSV, auto/manual match (G8) |
| F6 | `97b02eb` | Estado de flujo de efectivo (centros de costo diferidos con justificación) |
| F7 | `fcbc68f` | Activos fijos + depreciación lineal (7.14, G9 parcial) |

**Gaps cerrados:** G1, G2, G4, G5, G7, G8, G9(parcial). **Verificaciones de integridad**
(§14/§19): CxC/Inventario/CxP automatizadas (falta caja↔1101).
**Diferido con justificación:** G3/G10 (centros de costo/sucursal — sin dato operativo).
**Pendiente mayor:** G6 (F8, precisión decimal — proyecto aparte).

**Método por fase:** repo real (better-sqlite3, BD sembrada) + contrato IPC 3 capas +
`node --check` + boot. **Pendiente antes de release:** QA visual en GUI de las pestañas nuevas
(Períodos, Cuadres, 606, Flujo Efectivo, Activos) y del flujo devengado de gastos/compras y la
conciliación bancaria. ⚠️ `git tag v*` = despliegue en vivo a clientes (ver docs/release-process.md).
