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

## Área imprimible térmica y firma VELO POS (septiembre 2026)

- **Ticket centrado en el papel.** Un rollo de 80 mm imprime unos 72 mm
  centrados (4–76 mm); uno de 58 mm, unos 48 mm (5–53 mm). El ticket empezaba a
  2 mm del borde y la impresora cortaba el costado izquierdo. Ahora el cuerpo se
  centra (`margin:0 auto`) y su ancho es el de la plantilla menos sus márgenes
  (`_thermalBodyWidth`).

  Medido sobre el PDF, con página del ancho del rollo y márgenes 0, como la
  impresión física:

  | Plantilla | Antes | Ahora |
  |---|---|---|
  | 80 mm | 2.1–77.9 mm | 4.2–76.1 mm |
  | 72 mm | 2.1–77.9 mm | 8.1–72.2 mm |
  | 58 mm | — | 5.3–53.1 mm |

- **El margen configurado estrecha el ticket.** El margen de cada plantilla
  (Configuración → estilo) descuenta ancho en lugar de empujar el contenido
  fuera del papel. Un valor sin unidad se ignora y se usan 2 mm.
- **Las separadoras no se salen.** Las líneas de guiones (42 caracteres) medían
  76.7 mm, más que el ticket de 72 mm. Ahora se recortan al ancho (`.sep`).
- **La firma no agrega hojas.** En las plantillas Carta (Moderna, Formal y NCF)
  la firma ocupa el espacio libre a la izquierda de los totales
  (`<!--velo-branding-slot-->`). Al pie sumaba ~58 px: con solo 54 px libres en
  una factura corta, mandaba el QR solo a una segunda hoja. Media Carta y las
  térmicas la mantienen al final.
- **Totales de la Formal.** El recuadro de totales crece con el monto; a 240 px
  fijos cortaba un total de seis cifras.
- `test:financial` (bloque K2) protege el centrado, el recorte de las
  separadoras, el hueco de la firma y el recuadro de totales.

## Ronda «vista previa = impresión» (después de v1.61.0, sin publicar)

- **Vista previa paginada** (`print:previewPdf`, `_printPreviewShowPdf`): en
  hojas Carta/A4 el display muestra el PDF del documento y su número de hojas.
  En rollos térmicos muestra HTML. La ventana principal habilita el visor de
  PDF (`plugins: true`).
- **Factura Carta Compacta**: la letra de «Letra y márgenes» es el máximo (sin
  elegir: 10 pt; multiplicada por «Tamaño de letra en factura»); baja sola hasta
  7.8 pt para caber en una hoja, midiendo al ancho imprimible y con 12 mm de
  holgura (la paginación del PDF difiere hasta ~30 px de la pantalla). Columnas
  al ancho de su contenido; la descripción baja de línea, nunca «…».
  `test:pdf-compatibility` casos 08/09 (3 y 35 artículos a 13 pt, márgenes 15/20).
- **Paridad con VELO Bridge**: «Térmica nítida · ESC/POS» (`print_engine =
  escpos`, cae a Windows si falla), tipo de rollo de la Zebra
  (`barcode_zebra_tracking`, ajuste de cada PC), «Ficha de la impresora»
  (`print:printerProfile`: tipo, papel, zona que no imprime, cortador, Zebra).
- Pendiente en Desktop: rollos guardados (Bridge 0.6.1 ya los tiene), el
  asistente de calibración con medición de Bridge 0.6.0, y pasar oscuridad /
  velocidad / lenguaje de la Zebra y el motor térmico a ajustes por PC (hoy son
  del negocio; moverlos exige migrar el valor a cada terminal).

## Reportes de comprobantes y copias

- El 607 y el 608 filtran por el día dominicano de emisión o anulación. El
  historial se consulta sin cambiar los registros guardados. Si el usuario
  cambia los filtros mientras carga el reporte, se descarta la respuesta anterior.
- El lote de copias usa el período fiscal. Incluye las facturas vigentes con
  NCF tradicional válido y los E31/E32 aceptados en producción. Usa el
  documento original para las copias y conserva el timbre electrónico.
- Cada copia del lote empieza en una hoja Carta nueva. Los formatos y el
  autoajuste se aplican dentro de cada factura. Una factura larga puede ocupar
  varias hojas.
- La vista previa PDF y la ficha del driver se generan en la terminal donde se
  abren. El Centro conserva las impresoras asignadas que estén temporalmente
  fuera de línea. Los reportes con destino de rollo o etiquetas abren el diálogo
  local para elegir una impresora de hojas. El destino en servidor requiere un
  canal compatible.
- El PDF del lote se prepara antes de abrir el display. Imprimir o guardar
  confirma una acción a la vez y reserva un solo folio de reporte.

## Display de impresión

- El display genera un PDF para documentos de hoja, incluida Carta cuando el
  HTML no declara un tamaño. En rollo muestra el HTML con el ancho resuelto
  para la impresora. La vista PDF muestra la paginación del documento.
- Cambiar el destino vuelve a preparar la vista con el papel del trabajo.
  Se descartan las respuestas de una selección anterior.
- Los reportes reservan en la vista el espacio del folio. El número se
  asigna al confirmar y ocupa el mismo espacio en la salida final.
