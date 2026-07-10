# IMPLEMENTATION_STATUS — Contabilidad · Velo POS

> Estado por módulo (prompt maestro §7) y plan por fases. Fuente: auditoría Fase 1
> (`AUDIT_REPORT.md`). ✅ hecho · 🟡 parcial · ⛔ ausente. App `v1.14.0`, rama `main`.
> Progreso: **F1 ✅ · F2 ✅ (roles + cierre de período) · F3 ✅ (compras/gastos devengados)**.

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
| Caja/Bancos/Tesorería (7.9) | 🟡 | Bancos (cuentas+movimientos+transfer) sano. **Falta conciliación bancaria (CSV/match)** |
| Impuestos/fiscal RD (7.10) | 🟡 | NCF + e-CF + 607/608. **Falta 606**, libros venta/compra, cuadres, IT-1/IR-17, retenciones |
| Centros de costo (7.11) | ⛔ | No implementado |
| Multiempresa/sucursal (7.12) | 🟡 | Multiempresa por **BD separada**. **Falta segmentación por sucursal en asientos + consolidación** |
| Presupuestos (7.13) | 🟡 | Presupuestos de **gastos** existen; no ligados a contabilidad ni real-vs-presupuesto contable |
| Activos fijos (7.14) | ⛔ | No implementado |
| Inventario contable (7.15) | 🟡 | Costo en venta (COGS/Inv) + **entrada por compra (Déb Inventario 1105)**. **Falta cuadre valor inventario operativo↔cuenta contable**, kardex valorizado contable |
| Nómina contable (7.16) | ⛔ | No existe nómina |
| Monedas (7.17) | ⛔ | Solo DOP; sin tasa/dif. cambiaria |
| Cierres (7.18) | 🟡 | **Cierre/reapertura de período + bloqueo de posteo** (F2). UI en pestaña "Períodos". Falta asiento de cierre de resultados a patrimonio |
| Estados financieros (7.19) | 🟡 | Resultados + balance general + balanza (correctos tras fix). Falta flujo de efectivo, cambios en patrimonio, comparativos, indicadores |
| Flujo de efectivo (7.20) | ⛔ | No implementado |
| Préstamos (7.21) | ⛔ | No implementado |
| Documentos/soportes (7.22) | ⛔ | Sin adjuntos en asientos |
| Flujos de aprobación (7.23) | 🟡 | Gastos tienen aprobación; asientos no |
| Roles y permisos (7.24) | 🟡 | **Handlers `accounting:*`/`financial:*` exigen admin** (F2); reabrir período solo superadmin. Falta granularidad por operación |
| Auditoría (7.25) | 🟡 | `audit()` registra acciones clave; falta valor anterior/nuevo en asientos y auditoría inmutable dedicada |
| Alertas (7.26) | ⛔ | No hay alertas contables (descuadre/venta sin asiento/etc.) |
| Importaciones/exportaciones (7.27) | 🟡 | Importador universal (ventas/clientes/gastos…). Falta import de catálogo/saldos/asientos contables |
| Apertura y migración (7.28) | ⛔ | Sin asistente de saldos iniciales contables |

## Verificaciones de integridad (prompt §14/§19) — pendientes de automatizar
```
Débitos = Créditos                         ✅ garantizado por createEntry
accounts.balance = recálculo desde líneas  ✅ (tras fix reversión)
Inventario operativo = cuenta contable     ⛔ sin verificación
CxC auxiliar = cuenta control CxC          ⛔ sin verificación
CxP auxiliar = cuenta control CxP          ⛔ sin verificación
Caja operativa = cuenta contable caja      ⛔ sin verificación
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
- **F4 — Cuadres + fiscal:** verificaciones automáticas auxiliar↔mayor (CxC/CxP/inventario/
  caja) con alertas; reporte **606** + libros de ventas/compras + cuadre ventas↔607.
- **F5 — Conciliación bancaria (G8):** import CSV/Excel, mapeo, match por monto/fecha/ref,
  manual, diferencias, cierre.
- **F6 — Centros de costo + sucursal (G3, G10):** `cost_center` y `branch_id` en líneas/
  asientos; resultados por sucursal + consolidación (dentro de la BD del negocio).
- **F7 — Activos fijos + presupuestos↔contab + flujo de efectivo (G9).**
- **F8 — Precisión decimal (G6)** (migración a enteros de centavos o decimal seguro) +
  índices/tablas de resumen (rendimiento) + suite E2E + documentación fiscal.

**Regla:** no avanzar de fase con errores críticos abiertos. Cada fase: inspeccionar →
implementar aditivo → migración idempotente → pruebas (incl. integridad) → commit.
