# Roadmap de velocidad y estabilidad de Velo Suite

## Objetivo

Mantener Velo rápido sin alterar saldos, documentos históricos ni funciones que ya están correctas. Cada mejora de rendimiento debe ser medible, reversible y cubierta por pruebas.

## Reglas que no se negocian

- Ninguna optimización visual puede escribir o recalcular datos reales.
- Los saldos históricos importados conservan su saldo de origen; los abonos de Velo se aplican después y con trazabilidad.
- Un recibo de abono nunca se presenta como factura ni usa conceptos de venta, impuestos o artículos.
- Facturas e historial de abonos se muestran de antiguo a reciente, con fecha e identificador como desempate.
- No se elimina una ruta anterior hasta que la nueva pase pruebas funcionales, financieras y de documentos.
- Las pruebas automatizadas usan bases temporales; nunca la base de producción.

## Presupuesto de experiencia

| Acción | Meta local | Límite aceptable en red |
|---|---:|---:|
| Abrir buscador global | menos de 100 ms | menos de 150 ms |
| Mostrar estructura de un modal | menos de 100 ms | menos de 150 ms |
| Estado de cuenta listo | menos de 500 ms | menos de 1.5 s |
| Resultados de búsqueda | menos de 300 ms | menos de 800 ms |
| Cambio entre pestañas ya cargadas | menos de 100 ms | menos de 150 ms |

Si una operación supera el límite, se registra qué consulta o render fue lento; no se oculta el problema con animaciones largas.

## Fases

### Fase 1 — Rutas rápidas y seguras

- Mantener consultas específicas para cada pantalla; evitar cargar artículos y cálculos que la vista no usa.
- Reutilizar durante unos segundos el estado de cuenta al cambiar de pestaña.
- Abrir primero el buscador y completar accesos recientes en el siguiente cuadro visual.
- Mantener “Atrás” mediante el estado real del modal anterior, sin reconstruir formularios.

### Fase 2 — Medición por módulo

- Medir apertura, primera respuesta y render de Clientes, Ventas, Inventario, CRM, Caja y Compras.
- Marcar consultas sin límite, recorridos repetidos y tareas que bloquean la interfaz.
- Revisar índices con planes de consulta sobre una copia de datos representativa.
- Establecer paginación para historiales grandes y render progresivo para listas extensas.

### Fase 3 — Trabajo en segundo plano

- Mover reportes, preparación de PDF y cálculos extensos fuera del hilo visual cuando superen el presupuesto.
- Actualizar cachés después de confirmar una operación, sin retrasar el comprobante principal.
- Cancelar búsquedas anteriores cuando el usuario continúa escribiendo.
- Mantener reintentos explícitos ante desconexión, sin duplicar pagos ni ventas.

### Fase 4 — Prevención continua

- Ejecutar pruebas financieras, documentos, búsqueda, servidor y experiencia antes de entregar cambios.
- Añadir una prueba de regresión por cada error confirmado.
- Comparar tiempos con la línea base y rechazar cambios que degraden una acción crítica más de 20 %.
- Hacer una revisión mensual de las cinco acciones más lentas registradas.

## Protocolo para cada cambio

1. Describir el problema y su resultado esperado.
2. Medir el comportamiento actual con datos temporales o una copia autorizada.
3. Cambiar la ruta mínima necesaria, sin mezclar correcciones ajenas.
4. Probar matemáticas, documentos, orden, navegación y desconexión.
5. Verificar que no se abrió ni modificó la base real durante las pruebas.
6. Registrar el resultado y una forma clara de revertirlo.

## Criterios de aceptación de esta ronda

- El buscador aparece de inmediato y busca inventario, ventas, clientes e historial.
- El estado de cuenta no muestra el reloj de preparación ni usa la consulta pesada de Ventas.
- Los modales secundarios ofrecen “Atrás” y restauran la pantalla anterior.
- El recibo de abono dice “Monto aplicado”, “Monto del abono” y “Balance después del abono”; no “Precio venta” ni “Total con impuestos”.
- Facturas pendientes, facturas del cliente e historial de abonos aparecen de antiguo a reciente en pantalla y PDF.

## Ronda Ventas y Caja — 15 de septiembre de 2026

### Problema confirmado

- “Ver todas” limitaba el resultado después de ejecutar las uniones y los
  cálculos de ajustes, devoluciones y pagos sobre todo el historial. En una
  copia representativa con 2,523 ventas activas, pedir solo 100 filas tardaba
  entre 2.9 y 3.3 segundos porque la base procesaba primero todos los documentos.
- La pantalla intentaba construir el historial recibido completo y una respuesta
  lenta podía llegar después de que el usuario eligiera otro período.
- El recibo de ingreso estaba implementado en Caja, pero su prueba específica no
  formaba parte del comando general de pruebas y podía quedar fuera de una
  revisión de publicación.

### Ruta mínima aplicada

- Ventas selecciona primero una página de 100 identificadores por `sale_date` e
  `id`; únicamente después calcula el detalle financiero de esos documentos.
- “Hoy”, “Este mes”, “Todas”, método, facturas/cotizaciones y búsqueda se aplican
  en SQLite antes de paginar. La búsqueda sigue recorriendo el historial
  completo, incluidos nombre y código de artículos, aunque el resultado esté en
  una página antigua.
- La interfaz muestra Anterior/Siguiente y descarta respuestas obsoletas cuando
  el usuario cambia de filtro antes de que termine una consulta anterior.
- La prueba de Recibo de ingreso quedó registrada en la suite general: cubre
  efectivo, transferencia, cuadre, cuenta financiera, contabilidad, anulación,
  desaparición de la vista operativa e impresión del comprobante interno.

### Medición y seguridad

- Copia de la base representativa: “Este mes” quedó entre 16.6 y 24.4 ms; “Ver
  todas”, página de 100, quedó entre 214 y 236 ms. El conteo y la suma de las
  2,524 filas totales permanecieron idénticos antes y después de todas las
  consultas: 2,524 documentos y RD$133,930,366.62.
- Prueba sintética con 2,500 facturas, de las cuales más de 1,250 pertenecen al
  mes actual: “Ver todas” en 412.3 ms y “Este mes” en 437.1 ms, contador completo
  correcto, búsqueda profunda por cliente/producto y cero cambios en ventas,
  totales o artículos.
- La medición abrió exclusivamente copias temporales. No escribió ni corrigió la
  base original.
- Reversión: retirar los controles de página devuelve la presentación anterior;
  no existe migración de datos que revertir porque el cambio solo modifica cómo
  se consultan y muestran documentos ya existentes.

## Ronda Corrección de crédito y Devoluciones — 15 de septiembre de 2026

### Problema confirmado

- Corregir una factura a crédito todavía sin abonos podía crear una factura
  complementaria al aumentar o una devolución/nota de crédito al reducir. Eso
  duplicaba documentos comerciales para corregir un error antes de cobrar.
- Devoluciones cargaba el historial completo de Ventas antes de pintar su
  pantalla. Además, las subconsultas de ajustes repetían recorridos de las notas
  de crédito: con 2,500 facturas y 300 devoluciones la primera página llegó a
  20.3 segundos.

### Ruta segura aplicada

- Una factura a crédito sin abonos, NCF/e-CF, equipos serializados, conduce,
  anticipo, trade-in, comisión liquidada ni documentos compensatorios se puede
  corregir directamente. Conserva número y fecha; actualiza cantidades, precios,
  ITBIS, total, inventario y CxC dentro de una sola transacción y registra la
  corrección en auditoría.
- Si ya hubo cobro o compromiso documental/fiscal, Velo mantiene la ruta de nota
  de crédito y complemento. Una corrección nunca se disfraza de devolución en
  la ruta directa; sus movimientos de inventario se identifican como `ajuste`.
- El asiento de la factura corregida se retira de los libros vigentes y se genera
  nuevamente con el total y costo actuales, conservando el asiento anterior
  anulado para auditoría.
- Devoluciones usa `view: returns`, primera página de 100 y contador independiente.
  Buscar facturas consulta SQLite directamente y ya no reemplaza `DB.sales`.
- Se agregó el índice `sales(original_sale_id,type,status)` para que los ajustes
  relacionados no obliguen a recorrer todo el historial por cada factura.

### Medición y seguridad

- Prueba sintética: “Ver todas” bajó de 20.3 s a 10.8 ms y Devoluciones quedó en
  5.9 ms con 2,500 facturas y 300 devoluciones. Las consultas no cambiaron ventas,
  totales ni líneas.
- 84 pruebas de correcciones verifican ahora edición directa de cantidad, precio
  y producto, balance, inventario, contabilidad, idempotencia y retorno automático
  a documentos compensatorios después de un abono.
- Las suites financiera (199), POS (29), flujo comercial (17), serializados (10),
  recibos de ingreso (13), clientes, caja y carga resiliente permanecen verdes.
- No se eliminan automáticamente documentos históricos ya emitidos por versiones
  anteriores. Cualquier reparación de esos casos requiere identificar la factura
  exacta y validar primero pagos, inventario, fiscalidad y contabilidad.

## Ronda documental del POS — 26 de agosto de 2026

### Problema y resultado esperado

- “Agregar envío u otro cargo” debe conservarse separado de los artículos del carrito, pero estar disponible, sumarse, guardarse e imprimirse tanto en factura como en cotización, sin afectar inventario.
- El carrito tenía ancho fijo. Debe poder ajustarse entre un tamaño compacto y uno amplio, y recordar la preferencia al reiniciar la aplicación.
- Generar conduce estaba oculto dentro del cobro de una factura. El POS debe permitir preparar un conduce directamente como documento no fiscal, guardarlo en el módulo Conduces y no mover inventario, caja, impuestos ni contabilidad.
- La anulación existía únicamente dentro del detalle del conduce. Administrador y superadministrador deben verla también en el listado, con motivo obligatorio y auditoría.

### Ruta mínima aplicada

- El cargo se conserva en `inv.charges` y se persiste en `sale_charges`; no crea una línea en el carrito ni en `sale_items`. La misma ruta admite factura, cotización y cobro de órdenes enviadas a caja.
- El ancho del panel se conserva como preferencia local de interfaz; no se escribe en SQLite ni se modifica información comercial.
- El botón Conduce reutiliza `conduce:create`, su secuencia `CON-`, sus validaciones de cliente y su tabla de artículos. No reutiliza `sales:create`.
- Anular desde el listado reutiliza `conduce:cancel`; no elimina el registro ni libera el correlativo.

### Verificación y reversión

- Verificado: interacción del POS; matemática y persistencia de cargos separados en factura, cotización y cola de caja; creación/anulación de conduce; núcleo financiero; correcciones de venta; seguridad de actualización; integridad SQLite y sintaxis.
- Todas las pruebas usan una base temporal. La preferencia de ancho se prueba como almacenamiento local y nunca abre la base real.
- La prueba de actualización comparó la base real antes y después usando una copia temporal: ventas, facturación, clientes, productos, existencias y débitos/créditos permanecieron idénticos; `integrity_check` quedó en `ok` y no hubo violaciones de claves foráneas.
- Reversión: retirar el selector Conduce y el divisor visual no cambia documentos guardados; los cargos emitidos permanecen en `sale_charges`, las líneas de servicio creadas por versiones anteriores siguen siendo `sale_items` válidos y los conduces anulados conservan su trazabilidad.

## Conversión de conduces y cargos — 27 de agosto de 2026

### Problema y resultado esperado

- El cargo de envío, obra u otro concepto debía poder registrarse también en un
  conduce, mantenerse separado de los productos y acompañarlo al imprimirlo y
  convertirlo.
- “Facturar” desde Conduces creaba la venta directamente, sin pasar por las
  opciones completas de cobro del Punto de Venta. El flujo debe cargar el
  documento en el POS como hace una cotización y confirmar allí método de pago,
  comprobante y demás datos.

### Ruta mínima aplicada

- `delivery_note_charges` conserva los cargos del conduce y la factura que los
  consumió. Un cargo pendiente viaja una sola vez, incluso cuando se factura por
  partes.
- La conversión conserva el conduce y carga en el POS cliente, representante,
  sucursal, líneas pendientes, precios y cargos. Cada artículo mantiene el id de
  su línea documental para validar en servidor producto y cantidad.
- La factura, los enlaces por línea, el consumo del cargo y el estado del conduce
  se confirman en una sola transacción. Los reintentos usan la misma protección
  contra duplicados del cobro normal.
- Anular una factura vinculada repone inventario y libera solo sus enlaces del
  conduce; cualquier factura parcial anterior permanece registrada.

### Verificación y reversión

- Verificado con base temporal: creación sin movimiento de inventario,
  conversión parcial y total, cargo aplicado una vez, reintento idempotente y
  reapertura correcta al anular la factura vinculada.
- Reversión: ocultar la acción de conversión no altera conduces ni facturas ya
  confirmadas. La tabla de cargos es aditiva y los enlaces existentes conservan
  la trazabilidad documental.

## Ronda de continuidad, crédito y reimpresión — 26 de agosto de 2026

### Problema y resultado esperado

- Un apagón podía eliminar varios tickets todavía no confirmados. Deben
  recuperarse en la misma terminal sin convertir el respaldo local en una venta
  ni conservar autorizaciones sensibles.
- El cajero necesitaba márgenes distintos para subir y bajar temporalmente el
  precio de una unidad. El cambio debe seguir siendo precio de esa venta, nunca
  un descuento contable, y solo pedir clave al sobrepasar el monto configurado.
- Un cliente sin límite obligaba a abandonar el cobro a crédito. Velo debe poder
  asignar el monto necesario al finalizar, con un máximo configurable por
  cliente para el cajero y autorización administrativa al excederlo.
- Las copias reajustadas exponían referencias internas y podían cambiar una
  factura a crédito a “Pagada”. El cliente debe recibir una factura normal con
  su NCF y condición de crédito originales; la auditoría completa permanece en
  Ventas.
- Los detalles de factura, cotización y conduce deben conservar encabezado y
  acciones visibles, usando el desplazamiento para el contenido y los artículos.

### Ruta mínima aplicada

- El espacio de trabajo del POS se serializa en almacenamiento local por usuario
  y terminal, con límite de 20 tickets y vencimiento de 30 días. Se excluyen
  tokens, operaciones en curso y órdenes ya enviadas a caja.
- La política del POS calcula por unidad la diferencia contra el menor y el
  mayor precio de catálogo. `pos_price_max_reduction_amount` y
  `pos_price_max_increase_amount` se validan también en el proceso principal.
- `pos_cashier_auto_credit_limit_amount` controla la primera asignación de
  crédito. La base vuelve a calcular balance más exposición dentro de la misma
  transacción y solo acepta una autorización temporal ligada al cajero, cliente
  y monto máximo.
- La impresión conserva el método original y omite de todas las plantillas las
  notas y relaciones técnicas del reajuste. Las facturas a crédito reciben las
  líneas **Entregado por** y **Recibido por**.
- Los modales comparten un contenedor de altura controlada, encabezado y pie
  fijos, tabla desplazable y botones compactos.

### Verificación y reversión

- Pruebas aisladas cubren restauración de varios tickets y eliminación de
  autorizaciones; umbrales de aumento/rebaja; crédito automático dentro y fuera
  del máximo; persistencia financiera; correcciones y las nueve plantillas de
  impresión.
- La asignación de límite y la venta se confirman en una sola transacción. Un
  error revierte ambas; el respaldo local nunca escribe clientes, inventario,
  caja ni ventas.
- Reversión: desactivar los límites deja los valores en cero y vuelve a exigir
  autorización al cajero. Retirar la restauración local no modifica tickets ya
  facturados. Las facturas y límites previamente confirmados permanecen como
  registros comerciales auditables.
