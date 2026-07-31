# Historial de versiones

## 1.35.1 — 2026-07-31

### Ventas, abonos y caja resilientes

- Las ventas y los abonos incorporan confirmaciones idempotentes: un doble clic,
  una respuesta perdida o un reintento de red ya no duplica documentos, cobros,
  inventario, caja ni cuentas por cobrar.
- La misma operación no puede reutilizarse alterando productos, cliente, monto,
  método, cuenta financiera o distribución entre facturas.
- El POS recupera ventas y recibos que SQLite ya confirmó, abre el display sin
  esperar recargas secundarias y evita quedar indefinidamente en «Procesando».
- Las anulaciones de ventas y abonos son recuperables y conservan sincronizados
  inventario, balance, caja, bancos y contabilidad.
- Abrir y cerrar caja tolera respuestas perdidas; cerrar caja ya no abre ni
  imprime automáticamente el reporte.
- Convertir una cotización en factura utiliza la misma protección contra cobros
  duplicados y no depende de una segunda consulta para mostrar el documento.

### Datos, diagnóstico e impresión

- Las recargas concurrentes descartan respuestas antiguas y cada consulta
  secundaria puede fallar de forma independiente sin vaciar clientes, abonos o
  sesiones que ya estaban visibles.
- El diagnóstico financiero entiende correctamente que el precio de venta ya
  incluye ITBIS y revisa operaciones duplicadas, trazabilidad de caja, bancos y
  residuos contables de anulaciones.
- Brother QL permanece en el canal independiente de etiquetas y Epson ET-4810
  se identifica como impresora de hojas; ninguna impresión se envía antes de
  pulsar «Imprimir» en el display.
- Se agregan regresiones automatizadas para respuestas perdidas, doble clic,
  carga fuera de orden, caja, diagnóstico financiero y perfiles de impresora.

## 1.34.2 — 2026-07-30

### Caja y anulaciones

- Corrige los resúmenes de caja que podían conservar en el total una factura
  anulada y mostrar el doble aunque el desglose por método estuviera correcto.
- Al anular una factura, el total y la cantidad de ventas de su sesión se
  reconstruyen desde las facturas vigentes en vez de restar sobre un cache.
- Migración automática para conciliar sesiones históricas ya afectadas sin
  eliminar facturas anuladas ni modificar su auditoría.
- El resumen visual y el diagnóstico del sistema usan la misma fuente vigente,
  excluyendo cotizaciones, devoluciones y documentos anulados.

### Clientes y WhatsApp

- Los teléfonos de clientes nuevos, números adicionales y representantes
  comienzan con el prefijo internacional `1`.
- Un número dominicano de 10 dígitos se normaliza automáticamente:
  `8091234567` pasa a `18091234567`.
- El prefijo no se duplica si el número ya comienza con `1`; un `1` sin número
  no se guarda como teléfono válido.
- Los clientes antiguos con teléfonos de 10 dígitos también se corrigen al
  abrir WhatsApp, sin reescribir sus datos históricos.

## 1.34.1 — 2026-07-30

### Abonos y cuentas por cobrar

- Corrige el caso donde anular un abono podía sumar su monto sobre un balance
  desfasado y producir una deuda mayor que las facturas realmente pendientes.
- La anulación reconstruye la CxC desde facturas, devoluciones y abonos vigentes
  cuando toda la cuenta posee trazabilidad documental.
- Migración automática y conservadora para reparar balances ya inflados: solo
  actúa cuando el exceso coincide exactamente con los abonos anulados y no
  existen saldos vivos sin factura.
- Caja vuelve a mostrar únicamente abonos vigentes; los anulados permanecen en
  «Ver historial» para auditoría y reimpresión.
- La opción de corregir un abono ahora aclara que primero anula y luego abre un
  formulario nuevo que el usuario debe revisar y confirmar.

### Precios e ITBIS

- El detalle de Ventas muestra el precio unitario final con ITBIS incluido, de
  forma consistente con el estado de cuenta y el precio realmente cobrado.
- El desglose fiscal se identifica claramente como «Base sin ITBIS»,
  «ITBIS» e «Importe», evitando presentar la base neta como precio de venta.
- Nuevas pruebas reproducen dos abonos anulados, uno vigente, un balance
  previamente desfasado y la reparación automática sin inflar la deuda.

## 1.34.0 — 2026-07-30

### Centro de impresión inteligente

- Nuevo Centro de impresión que reúne impresoras, rutas por departamento,
  plantillas, etiquetas, calibración y diagnóstico en una sola área organizada.
- Facturas, recibos, reportes y etiquetas mantienen impresoras independientes;
  una impresora de etiquetas ya no se mezcla con la configurada para documentos.
- El POS permite elegir rápidamente entre las impresoras disponibles cuando hay
  más de una, sin alterar la preferencia permanente del negocio.
- Monitor en tiempo real que refresca impresoras al enfocar la aplicación y cada
  cuatro segundos, informa desconexión, pausa, falta de papel o error cuando el
  controlador lo reporta y bloquea envíos a colas no disponibles.
- La detección utiliza nombre, descripción, opciones del controlador y familia
  del modelo para separar impresoras térmicas, de documentos y de etiquetas.
- Diagnóstico de plantillas y rutas con vista previa para detectar medidas,
  destino o configuración incompatible antes de imprimir.

### Etiquetas y códigos de barras

- Se separan el ancho físico del rollo y el ancho real de cada etiqueta, evitando
  que la vista previa estire una etiqueta de 50 mm al medio detectado de 108 mm.
- Diseñador y salida física comparten el mismo motor de renderizado, medidas,
  márgenes, separación, DPI y calibración guardada por impresora y terminal.
- Vista previa compacta y proporcional, sin espacios de página engañosos, con
  centrado, límites seguros y eliminación del código humano duplicado.
- Preflight de impresora y medio antes de imprimir, con mensajes accionables y
  actualización automática al conectar, desconectar o cambiar una impresora.

### Documentos, abonos y operación

- Anulación profesional de abonos: revierte sus aplicaciones, restaura los
  balances de las facturas y retira el ingreso de Caja conservando el recibo
  anulado para auditoría; luego puede registrarse correctamente uno nuevo.
- Las ventas ajustadas conservan su documento original, muestran el resultado
  vigente en Ventas y permiten reimprimir la versión ajustada sin duplicarla.
- La numeración migrada conserva los identificadores originales y continúa su
  secuencia; los documentos nuevos usan la numeración predeterminada cuando no
  existe una migración aplicable.
- Solo una factura interna de consumidor final sin comprobante fiscal puede
  reutilizar de forma controlada su número tras anularse; NCF, recibos y demás
  documentos emitidos conservan su número ocupado para trazabilidad.
- Reportes segmentados por detalle, mayorista y empresa, con impresión y PDF
  coherentes con los filtros de gestión seleccionados.

### Calidad y compatibilidad

- Cobertura ampliada para perfiles de impresión, detección de etiquetas,
  preflight, abonos, correcciones, numeración y flujos multi-negocio.
- Release verificado contra la base migrada sin alterar ventas, pagos ni
  relaciones históricas.

## 1.33.1 — 2026-07-29

### Etiquetas e impresoras

- Corrige la regresión que sumaba el margen lateral al alto físico y podía
  desplazar el contenido hasta producir etiquetas en blanco. El avance vuelve a
  ser exclusivamente `alto de etiqueta + separación`.
- Nuevo asistente **Detectar y calibrar** dentro del módulo de Etiquetas:
  combina nombre, nombre visible y descripción del controlador para reconocer
  el modelo y sugerir perfil, ancho y DPI.
- La prueba física muestra marco, esquinas, cruz central, medidas y ajustes X/Y;
  el sistema solo confirma que fue enviada después de recibir una respuesta
  satisfactoria del proceso de impresión.
- Ancho, alto, separación, sensor, DPI y desplazamientos se guardan por
  impresora y por terminal. Cambiar de impresora recupera su propia calibración
  sin modificar la de las demás.
- Controles guiados de centrado en pasos de 0.5 mm, vista previa inmediata,
  indicador de confianza de detección y aviso cuando el controlador no puede
  conocer el rollo físico instalado.
- La antigua prueba del Diseñador utiliza ahora el mismo documento validado y
  deja de mostrar un éxito falso cuando el trabajo fue rechazado.

## 1.33.0 — 2026-07-29

### Ventas a crédito y abonos

- Las ventas a crédito permiten registrar un pago inicial y conservan en la
  factura el importe adelantado y el balance pendiente.
- Un importe recibido inferior al total convierte la operación en crédito,
  registra el cobro real en Caja y deja únicamente la diferencia en CxC.
- Los abonos pueden distribuirse entre varias facturas en un solo recibo,
  mostrando en vivo cuánto se aplicó, cuáles quedaron saldadas y qué balance
  conserva cada documento.
- Caja, Ventas, Clientes, Reportes y Contabilidad reflejan el mismo abono sin
  duplicar ingresos. El recibo enumera todas las facturas y montos aplicados.
- Una factura anulada no admite abonos y una factura con cobros aplicados no
  puede anularse sin procesar formalmente el reembolso o reverso.

### Reportes y administración

- Reportes financieros filtrables por ventas al detalle o mayoristas y por
  clientes persona o empresa, incluyendo combinaciones de ambos segmentos.
- Nuevos indicadores de ticket promedio, clientes principales y detalle de
  facturas incluidas; el PDF y la impresión respetan los filtros seleccionados.
- Los abonos multifactura se atribuyen a cada segmento solo por el importe
  realmente aplicado a sus facturas.
- Las correcciones de productos muestran cualquier excedente que quede a favor
  del cliente para evitar saldos ocultos o aplicaciones automáticas ambiguas.

### Impresión, PDF y comunicación

- Los recibos de abono utilizan la plantilla e impresora global configuradas y
  pueden reabrirse, reimprimirse o guardarse desde Clientes, Caja y Ventas.
- Etiquetas usa el generador de códigos local, valida que todos los SVG estén
  completos antes de imprimir y abre el selector del sistema si la impresora
  guardada ya no está instalada.
- El alto, ancho, separación y perfil físico de las etiquetas se conservan en
  el despacho de impresión para evitar páginas vacías o códigos recortados.
- Los botones de WhatsApp intentan abrir primero la aplicación instalada y
  conservan WhatsApp Web como alternativa segura.
- Los PDF usan el primer nombre, primer apellido y número documental del
  comprobante para producir nombres de archivo identificables.
- El POS incorpora una casilla de notas que queda guardada e impresa con la
  venta.

### Migración y verificación

- Nueva tabla de aplicaciones de pago para relacionar un único recibo con
  múltiples facturas, compatible con pagos históricos de una sola factura.
- La migración fue probada sobre una copia consistente de la base importada:
  2,494 ventas y 2,699 pagos históricos conservaron sus conteos, importes y
  huellas, sin registros huérfanos.
- Pruebas funcionales, financieras, de CxC, correcciones, impresión,
  empaquetado, multi-negocio y servicio Windows aprobadas antes del release.
- Se conserva sin modificar el NCF histórico duplicado `B0100000046` para que
  su conciliación fiscal se realice separadamente con los documentos fuente.

## 1.30.0 — 2026-07-27

### Corrección controlada de facturas

- Una factura emitida ya puede corregirse sin borrar ni reemplazar su identidad
  original: permite cambiar cantidades, quitar productos y agregar productos.
- Las reducciones generan la nota de crédito correspondiente y los aumentos
  quedan documentados y enlazados, manteniendo inventario, caja, crédito,
  contabilidad e impuestos consistentes.
- Ventas conserva una sola operación visible, marcada como `Ajustada`, con su
  total vigente; los documentos compensatorios permanecen disponibles en la
  auditoría sin duplicar la venta para el usuario.
- La factura ajustada puede reimprimirse o guardarse en PDF como copia
  consolidada, mostrando cantidades vigentes, créditos aplicados, total actual,
  referencia original y NCF original.
- La devolución física y la nota de crédito monetaria quedan diferenciadas: es
  posible acreditar un importe sin simular entrada de mercancía al inventario.

### Seguridad, fechas y auditoría

- La fecha operativa puede corregirse sin alterar la fecha fiscal, el NCF, la
  fecha técnica de creación ni las fechas reales de cobro, caja e inventario.
- Nuevos permisos por rol, motivo obligatorio, prevención de doble confirmación,
  control de concurrencia e historial inmutable de cada corrección.
- Se crean respaldos automáticos antes de activar correcciones de facturas,
  correcciones de productos o realinear una numeración histórica.

### Numeración e impresión

- Cuando existen facturas importadas, las nuevas facturas continúan la
  numeración histórica máxima compartida entre contado y crédito. Una
  instalación sin datos importados conserva la numeración predeterminada
  `FAC-000001` / `FCR-000001`.
- Las facturas importadas se identifican por su número documental real y no por
  el ID técnico interno de la base de datos.
- El encabezado de factura/recibo en A4 y Carta es más compacto y discreto.

### Verificación

- Pruebas de regresión para correcciones de fecha, productos, inventario,
  devoluciones, notas de crédito, reimpresión, numeración importada, documentos,
  finanzas y servicio multi-terminal.

## 1.29.4 — 2026-07-24

### Corregido

- Los módulos activados desde el panel (p. ej. Conduces) ya no desaparecen del
  menú al reiniciar la aplicación: la activación de cualquier módulo se carga
  correctamente al arrancar.

## 1.29.3 — 2026-07-24

### Etiquetas

- Calibrador de posición en el diseñador: ajuste fino horizontal y vertical en
  milímetros para centrar el contenido en la etiqueta física, con vista previa
  en vivo y una impresión de prueba (marco del tamaño de la etiqueta con cruz al
  centro) para verificar y afinar la posición.

## 1.29.2 — 2026-07-24

### Etiquetas

- El código de barras ahora escala al ancho disponible de la etiqueta (viewBox
  responsivo): con un margen configurado ya no se recorta el código ni el texto.

## 1.29.1 — 2026-07-24

### Etiquetas

- El "Margen de página" del diseñador ahora sí se aplica (margen horizontal),
  sin alterar la altura de página para no provocar deriva entre etiquetas.
- El ancho de la etiqueta es una sola fuente de verdad: sincronizado entre el
  módulo Etiquetas, el diseñador y la impresión.
- El preview del diseñador detecta la impresora seleccionada (ancho/DPI del
  medio), se muestra a tamaño real aproximado y avisa si el diseño no coincide
  con el medio, con opción de igualarlo.

### Conduce

- Al cobrar con "Generar conduce", primero se imprime la factura y luego, de
  forma automática y sin solaparse, el conduce (que ya queda guardado en el
  módulo Conduces).
- Nuevo botón "Generar conduce" en el detalle de una venta ya realizada: crea el
  conduce, lo guarda en Conduces y lo imprime. Es idempotente: no duplica si la
  factura ya tenía uno.

### Facturación

- Las "Observaciones" de la factura A4 se pueden personalizar desde
  Configuración, conservando el texto por defecto si se deja vacío.

## 1.29.0 — 2026-07-24

### Impresión y facturación

- Tamaño del logo en la factura configurable en tres opciones (pequeño, mediano,
  grande) para las plantillas de hoja (A4/Carta), con vista previa en vivo.
- La tasa de cambio ya no se imprime en la factura: solo el equivalente en USD.
- Salida de impresión coherente al cobrar: si no se elige una impresora, la
  plantilla por defecto es la configurada en Configuración (carta o térmica);
  al elegir una impresora, el sistema detecta su tipo y ajusta la plantilla
  compatible. La plantilla usada queda guardada en la venta y se respeta al
  reimprimir.
- Densidad de impresión térmica configurable (normal, oscura, máxima) para
  cuando la impresión térmica sale muy clara.

### Etiquetas

- El ancho configurado en milímetros es ahora el ancho real de la etiqueta: el
  código de barras y el texto se ajustan a ese ancho y ya no desbordan el papel.

### Interfaz

- Modal de detalle de venta y otros modales con tablas anchas: contenido
  compactado que cabe sin desplazamiento horizontal y con los botones siempre
  visibles.
- Corrección: los cargos adicionales dejaban de imprimirse dos veces en la
  factura.

## 1.28.0 — 2026-07-24

### POS y facturación

- Conversión opcional del total de DOP a USD con la tasa de venta vigente,
  modificación manual y recálculo inmediato; la tasa y el equivalente quedan
  congelados en la factura y aparecen en todas las plantillas.
- Cargos adicionales por envío u otros conceptos, integrados al total, caja,
  crédito, reimpresión, PDF e historial.
- Fecha de emisión seleccionable al cobrar y cambio histórico auditado por
  administradores, manteniendo alineados venta, caja, bancos y NCF.
- Teléfono ocasional tipado en el cobro y teléfonos múltiples por cliente
  (`Teléfono`, `Celular` y `Flota`) con número principal.
- Órdenes de despacho cobradas en caja admiten descuentos autorizados y cargos
  sin desbloquear artículos o precios reservados.

### Documentos, impresión y comunicación

- WhatsApp vuelve a abrirse localmente en todas las terminales; el mensaje
  predeterminado ahora puede editarse antes de enviarlo.
- Los conduces solicitados al cobrar se guardan formalmente en el módulo,
  conservan su relación con la factura y luego se imprimen.
- Destinos de impresión configurables para elegir impresora, perfil de papel y
  plantilla en cada venta.
- Secuencia de facturas al contado personalizable junto a la configuración NCF,
  sin permitir reutilizar números ya emitidos.
- Facturas importadas de Equiparts conservan el mismo número histórico en
  ventas, reimpresión, PDF y factura.

### Caja, etiquetas y seguridad

- Las sesiones de caja cuentan las unidades vendidas en lugar de mostrar cero.
- Impresión de etiquetas centralizada, previsualización endurecida y perfil
  validado para 2Connect 2C-LP427B de 108 mm/203 dpi.
- Validación de descuentos superiores al 10% también en el proceso principal,
  con autorización de un administrador, token de un solo uso y auditoría.
- Fechas inválidas, rutas ajenas al PDF temporal de WhatsApp y formatos horarios
  incompatibles con SQLite quedan rechazados.
- Pruebas de regresión para teléfonos, cargos, USD, fechas, caja, numeración y
  conduces.

## 1.27.0 — 2026-07-23

### Corregido

- Las cantidades del POS aceptan varios dígitos sin perder el foco.
- Las cotizaciones se eliminan realmente y ya no pasan por la anulación de facturas.
- Crear una cotización no mueve inventario, caja, crédito, cuentas financieras ni contabilidad.
- Los reportes financieros excluyen cotizaciones.
- Convertir una cotización genera la factura y elimina correctamente el documento de origen.
- Facturar un conduce genera también el asiento contable de la factura.
- Los reportes de abonos muestran el correlativo documental y no el ID técnico.
- El reinicio total y la migración integral reinician correctamente los correlativos
  internos sin mezclar documentos de dos negocios.
- La interfaz usa “Cotizar/Crear cotización” en vez de “Cobrar” cuando corresponde.

### Nuevo

- **Velo POS Server Service** para Windows: mantiene datos y terminales disponibles
  aunque la interfaz de la PC servidor esté cerrada.
- Supervisor con un worker SQLite aislado por negocio, gateway único en el puerto
  8443 y recuperación automática ante fallos.
- Dos instaladores independientes: Servidor y Terminal, con canales de actualización
  separados para impedir que una edición reemplace accidentalmente a la otra.
- Migración segura al instalar Servidor: respaldo previo, copia sin borrar el origen
  y conservación de datos/backups al desinstalar.
- Negocio seleccionado por terminal; cambiarlo ya no reinicia ni modifica el servidor
  o las demás cajas.
- Asignación de cada terminal a todos los negocios o a un negocio específico.
- Prueba automatizada del gateway, autenticación, aislamiento y routing multi-negocio.
- Secuencias independientes para facturas al contado, facturas a crédito, cotizaciones,
  notas de crédito, abonos, recibos, pagos a proveedores, conduces y reportes.
- Números documentales anulados o eliminados no se reutilizan.
- PDF por WhatsApp desde facturas, cotizaciones y conduces, reutilizando la plantilla de impresión.
- Pruebas de regresión específicas para numeración, cotizaciones no financieras,
  eliminación, cantidades y exclusión de reportes.

## 1.26.1 — 2026-07-22

### Nuevo

- Clientes de tipo **Persona** o **Empresa**, conservando como personas todos los registros existentes.
- Representantes empresariales con cargo, documento, teléfono, correo, contacto principal y permisos operativos.
- Búsqueda de empresas por razón social, nombre comercial, RNC o representante.
- Precio preferido de detalle/mayorista y correo de facturación por empresa.
- Importación opcional de empresas con representante principal.
- Selector permanente de cliente en el POS antes de agregar artículos, con búsqueda por empresa, persona o representante.

### Integrado

- POS, cotizaciones, Preventa y Despacho, facturas, crédito, conduces y envíos mantienen la empresa y su representante.
- Las cuentas por cobrar y los abonos permanecen consolidados en la empresa.
- El precio preferido cambia automáticamente el catálogo y recalcula las líneas no modificadas del carrito; los precios autorizados manualmente se respetan.
- Plantillas térmicas, carta, media carta, NCF, conduce, reimpresión y PDF muestran `Solicitado por` cuando corresponde.
- Abonos y recibos guardan y muestran `Pagado por`; estados de cuenta y facturas pendientes identifican al representante de cada operación.
- Ventas, conduces, envíos y búsqueda global encuentran operaciones por representante.
- Clientes separa Personas y Empresas; cada empresa ofrece un panel de representantes con facturas, cotizaciones, crédito pendiente y abonos atribuidos.

### Seguridad e historial

- Empresa y representante se validan nuevamente en el proceso principal; no se confía en texto enviado por la interfaz.
- Snapshots documentales conservan razón social, dirección, contacto y representante aunque se editen o desactiven después.
- Los abonos conservan su propio snapshot del representante, independiente de cambios posteriores en el contacto.
- Solo flujos internos verificados pueden reutilizar snapshots históricos.
- Reinicio total, importación y rollback incluyen correctamente la nueva tabla de representantes y los conduces relacionados.

### Verificación

- Pruebas específicas cubren empresa, representante, documento único, selector y precios del POS, preventa, crédito, abonos, conduce, envío y persistencia histórica.
- 284 comprobaciones automatizadas aprobadas; migraciones y estructura del instalador verificadas para Velo POS 1.26.1.

## 1.25.0 — 2026-07-22

### Nuevo

- Módulo **Preventa y Despacho** para preparar órdenes en una terminal, cobrarlas en caja y confirmar la entrega.
- Órdenes compartidas `OC-XXXXXX` con reserva temporal de inventario y sincronización multi-terminal.
- Colas separadas de Caja, Entrega, Todo activo e Historial.
- Búsqueda por orden, cliente, RNC/cédula, artículo y vendedor.
- Avisos visuales y sonoros para nuevas órdenes y mercancía lista para entregar.
- Activación del módulo, permisos por rol, tiempo de reserva y sonido configurables por Superadmin.
- Detalle completo y trazabilidad de terminales, usuarios y estados.

### Mejorado

- Búsqueda de clientes registrados al enviar órdenes a caja.
- Regreso automático a la cola después de cobrar una orden compartida.
- Disponibilidad del POS calculada descontando reservas activas.
- Numeración de tickets reutilizable: al cerrar todos vuelve correctamente a Factura #1.
- Campos de descuento porcentual y por monto permiten escritura continua sin perder el foco.

### Corregido

- El indicador de Preventa desaparece inmediatamente al cancelar, cobrar, entregar o vencer la última orden aplicable.
- Protección contra doble cobro y contra ventas directas que consuman inventario reservado.
- Cancelar una factura vinculada retira también su orden del flujo de entrega.

### Verificación

- 254 comprobaciones automatizadas aprobadas antes de preparar la publicación.
- Validación de empaquetado confirma todos los módulos del proceso principal incluidos en el instalador.
