# Módulo de Impresión — overhaul v1.7.0

[← Volver a CLAUDE.md](../CLAUDE.md) · Relacionados: [Visión general](overview.md) · [Contabilidad](accounting-module.md) · [Release](release-process.md)

Enviado 2026-06-21/22 en 3 bloques escalonados (auditados primero, confirmando alcance con el usuario antes de cada bloque).

## Arquitectura (`src/js/print.js` — servicio central)
- `printHTML(html, category)` y `_openPrintWindow(html, jobType, referenceId, isReprint)` son los únicos puntos de entrada que los módulos deben llamar. **Nunca** llamar `window.api.print.html` directo desde un módulo de feature — siempre pasar por estos.
- **Categorías** (`PRINT_CATEGORIES`): `ticket`, `pago`, `caja`, `contabilidad`, `bancos`, `reporte`. Cada una con su override de impresora + toggles `preview`/`autoPrint`, guardadas como JSON en `settings.print_config` (leído vía `DB.settings.print_config`, guardado vía `window.api.print.saveConfig` — solo admin/superadmin).
- `_categoryForJobType(jobType)` mapea jobTypes térmicos (`ticket`, `abono`, `cierre`, `pago_proveedor`, `test`) → categoría. Para llamadas `printHTML` el 2º argumento ES la categoría directamente.
- `_printDispatch()` envuelve `window.api.print.html` con un guard de en-vuelo (Set con clave `jobType:referenceId`) para evitar doble-envío por doble-clicks rápidos.
- Los reportes reciben un correlativo `REP-XXXXXX` solo al confirmar imprimir o guardar PDF; abrir/cerrar la vista previa no consume números.
- `enviarDocumentoPDFWhatsApp()` reutiliza exactamente el HTML de impresión, genera un PDF temporal y abre el flujo de WhatsApp con el archivo listo para adjuntar.
- El handler `print:html` de `main.js` auto-reintenta una vez (1.2s delay) al fallar, pero **solo para impresiones silenciosas/térmicas** — los fallos no-silenciosos (diálogo) suelen ser cancelación explícita del usuario, nunca se reintentan.
- La "Cola de impresión" intencionalmente NO es una cola persistente de worker en background — es retry + dedup-guard + un panel de reintento manual (solo ticket, vía `reimprimirVenta`). Una cola persistente real requeriría guardar el HTML completo por job en `print_jobs`; se juzgó no valer la pena.

## Bugs encontrados y corregidos
- **Fabricación de NCF falso** (`B01+saleId` inventado al imprimir cuando `sale.ncf` estaba vacío) existía en 4 lugares: `plantillas.js _getNcf()`, fallback clásico de `print.js`, `pos.js previsualizarFactura`. Los NCF reales siempre se asignan+registran al crear la venta en `database.js`; inventar uno al imprimir era un riesgo real de integridad fiscal. Corregido: omitir la línea de NCF si falta, nunca fabricar.
- **Colisión de nombres de función**: `inventario.js` y `reportes.js` ambos declaraban global `exportInventarioPDF(...)` con firmas distintas — ganaba el último cargado (reportes.js), así que el botón "Exportar" de Inventario llamaba al equivocado y crasheaba. Renombrado el de reportes.js a `exportInventarioValorizadoPDF`.
- **Bugs de unwrap de respuesta IPC** en `gastos.js`: la tab Proveedores siempre salía vacía (nunca leía `.data` del wrapper `{ok,data}`), y el `<select>` de proveedor en "Nuevo gasto" nunca se poblaba (mismo bug). Ambos fallos silenciosos, sin error mostrado al usuario.
- 9+ call sites en `contabilidad.js`, `bancos.js`, `ventas.js`, `dashboard.js`, `importar.js` saltaban el servicio central con `window.api.print.html({...})` directo o `window.open()+document.write()` crudo — sin log de auditoría en print_jobs, sin fallback. Todos ruteados por `printHTML()` ahora.
- Sin escape de HTML de datos dinámicos (nombres, descripciones) en ~13 funciones de reportes — agregados `_esc()`/`_escHtml()`.

## Diferido (explícitamente, tras discutir necesidad con el usuario)
El usuario preguntó "¿estas fases son realmente necesarias, 100%?" — la respuesta fue no para las 4, juzgadas de bajo valor para este negocio:
- Módulos de plantilla reutilizables dedicados para reportes de contabilidad/caja/recibo de pago (vs. el enfoque actual de HTML-directo-por-función) — solo importa si quieren estilo de reporte personalizable como las 8 plantillas de ticket.
- Impresión para movimientos/ajustes/entrada-salida del Kardex de inventario (hoy solo existe export de lista de productos) — sin evidencia de que sea una necesidad real de flujo.
- Gate explícito de validación pre-impresión — juzgado redundante ya que la validación real (NCF, existencia de venta) ya ocurre al crear, no al imprimir.
- Doc formal de entregables estilo FASE-13 (listas de archivos, checklist de pruebas) — ofrecido, no solicitado antes de enviar.

No re-litigar esto salvo que el usuario plantee una necesidad concreta — fue una decisión deliberada de alcance, no un descuido.

## Brecha conocida
No se hizo QA interactivo en vivo (sin impresora real en el entorno de dev, sin automatización de UI). Solo `node --check` + smoke tests de arranque antes de enviar v1.7.0. Si aparecen bugs de impresión en campo, revisar primero la tab Proveedores y los nuevos paneles "Impresión por módulo" / "Impresiones fallidas" en Configuración — es el código menos probado en campo.
