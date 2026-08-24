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
