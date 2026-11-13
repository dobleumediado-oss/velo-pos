# Apertura, cierre y cuadre de Caja en VELO SUITE

[← Volver a CLAUDE.md](../CLAUDE.md) · Relacionados: [Multi-terminal](multi-terminal-sync.md) · [Plan VELO SUITE](velo-suite-plan-fases.md)

Estas reglas operativas aplican tanto a **VELO POS** como a **VELO TECH POS**.

## Reglas operativas vigentes

- La caja pertenece a una **terminal**, no a toda la instalación. Cada consulta y cierre usa el `terminalId` actual.
- En **VELO POS** y **VELO TECH POS**, **Administrador** y **Cajero** necesitan una caja abierta para facturar en Punto de Venta. La interfaz orienta al usuario y el backend vuelve a validarlo antes de crear la venta.
- **Superadmin** está exento para conservar acceso de soporte y recuperación.
- Cerrar caja calcula el cuadre. El reporte queda disponible desde Caja y **no se abre ni imprime automáticamente**.
- Una caja abierta en otra terminal no convierte la caja local en abierta. Las sesiones huérfanas se concilian mediante el flujo existente y auditado.

## Horario de cierre

La configuración se muestra en ambos productos y es deliberadamente opcional hasta que el negocio defina su horario:

- `business_close_time`: hora local estricta `HH:MM`.
- `cash_close_required_after_hours`: `1` activa la regla; `0` la desactiva.

Cuando está activa:

1. Durante los cinco minutos anteriores al cierre se muestra una sola alerta no invasiva por terminal y día.
2. Antes de la hora, la alerta no impide continuar trabajando ni salir.
3. Desde la hora configurada, Administrador y Cajero no pueden cerrar sesión ni cerrar la aplicación si la caja de esa terminal sigue abierta.
4. Antes de decidir, el sistema consulta nuevamente el estado real de Caja. Si estaba abierta y la verificación falla, la aplicación permanece abierta de forma segura.
5. Tras cerrar y cuadrar la caja, la siguiente verificación permite salir normalmente.

La protección de la X/Alt+F4 usa un protocolo entre renderer y proceso principal: el renderer conoce usuario, horario y terminal; el proceso principal conserva la autoridad final para mostrar la confirmación y cerrar.

## Recibo de egreso

El espejo del **Recibo de ingreso**: constancia firmable del dinero que sale de la caja para pagar un gasto.

- **Dónde:** botón **«Recibo de egreso»** en la cabecera de Caja y tarjeta **«Recibos de egreso»** en la sesión abierta, con reimpresión. Solo aparece con el módulo **Gastos** activo y para **Administrador** o **Superadmin** (decisión del dueño, 13 nov 2026).
- **Qué registra:** un gasto pagado en el acto con el efectivo de la caja abierta de esta terminal (`expenses:create` con `from_cash_register`). No hay tabla nueva: queda en Gastos, en reportes y en Contabilidad como cualquier gasto, y baja lo esperado en el cuadre por el mismo movimiento de salida que ya usaba Gastos.
- **Protección en el proceso principal:** si la caja de la terminal ya no es la que mostraba la pantalla, si el método no es efectivo o si el usuario no es administrador, no se registra nada. Nunca cae a caja chica ni a banco.
- **Numeración:** conserva las secuencias existentes, `RGE` (persona identificada) y `PPR` (proveedor). Solo cambia el formato impreso.
- **Impresión:** todo pago de gasto, desde Caja o desde Gastos, imprime el **Recibo de egreso** (`buildExpenseReceiptHTML` en `src/js/caja.js`). En el Centro de impresión tiene su fila propia con carta, carta compacta, térmica de 80 mm y «Formato anterior». Sin plantilla elegida sigue el papel de Facturas y ventas: carta → carta, 72/80 mm → térmica de 80 mm, 58 mm → formato anterior (el diseño nuevo no cabe en ese rollo). Sale por el canal de ventas, igual que antes.
- **Anular desde Caja:** botón en la tarjeta de la sesión, con motivo obligatorio. Solo aparece cuando el recibo es todo el gasto y salió de esta sesión, porque anular un gasto revierte todos sus pagos; si no, la fila dice «Desde Gastos». Usa `expenses:cancel`: el dinero vuelve a la caja y se reversan los asientos.
- **Historial de recibos de egreso:** debajo del de ingresos, por fechas, búsqueda y anulados (`expenses:searchReceipts`, solo administrador). Incluye todos los pagos de gastos, de caja o de banco. Las fechas se muestran en hora local (`expense_payments.created_at` está en UTC).
- **Anular un gasto devuelve a la caja solo lo que salió de una caja** (pagos con `cash_movement_id`), en efectivo. Antes un gasto con pagos mixtos devolvía también lo pagado por banco. Los gastos de versiones viejas sin filas en `expense_payments` conservan la regla anterior. Al anular, los números `RGE` y `PPR` quedan anulados en la auditoría de documentos (antes solo `PPR`).
- **`cash_sessions.expected` mientras la caja está abierta** es un acumulado heredado que nadie lee: el cuadre usa `getSessionCashSummary`, y al cerrar la columna se sobrescribe con ese valor (`cashRepo.close`). Que se vea negativo con gastos durante la sesión no afecta el cuadre; por eso no se cambió.
- **Pruebas:** `npm run test:cash-expense`.

## Lista de regresión obligatoria

- Administrador sin caja no puede facturar.
- Cajero sin caja no puede facturar.
- Superadmin conserva acceso de soporte.
- Cotizaciones sin cobro no quedan bloqueadas por la regla de facturación.
- Caja abierta en otra terminal no bloquea el cierre de la terminal local.
- Aviso de cinco minutos no reemplaza una venta ni un modal activo.
- Antes de la hora se puede salir; desde la hora solo se bloquea si la caja local está abierta.
- Cerrar sesión no sirve como vía para eludir el cierre de caja.
- Cerrar caja no imprime automáticamente; el reporte sigue disponible bajo demanda.
- Modo Cliente consulta al servidor con el `terminalId` correcto y conserva la aplicación abierta si no puede verificar una caja que se sabía abierta.

## Roadmap seguro

### Fase C1 — Política básica (implementada)

- Apertura obligatoria para Administrador y Cajero en UI y backend.
- Horario único opt-in, recordatorio previo y bloqueo de salida después del cierre.
- Verificación local por terminal, pruebas puras y pruebas de integración estructural.

### Fase C2 — Calendario del negocio (futura)

- Horario por día de la semana, feriados y días sin operación.
- Vista previa que explique qué regla aplicará hoy antes de guardar.
- Migración únicamente aditiva y con fallback exacto al horario único de C1.

### Fase C3 — Supervisión multi-terminal (futura)

- Panel de cajas abiertas por sucursal/terminal con última actividad.
- Alertas de sesión huérfana y conciliación auditada sin cerrar una terminal conectada.
- No centralizar artificialmente el estado: Caja continúa siendo por terminal.

### Fase C4 — Métricas y control (futura)

- Historial de cierres tardíos, diferencias de cuadre y causas documentadas.
- Permisos explícitos para excepciones, con usuario, fecha, terminal y motivo.
- Canary y compuerta de upgrade antes de publicar a clientes.

Cada fase debe pasar `npm test`, `npm run release:check`, las invariantes de VELO SUITE y una prueba de upgrade sobre copia de datos reales. Publicar sigue siendo una decisión separada: nunca se crea ni empuja un tag `v*` como efecto de implementar estas reglas.
