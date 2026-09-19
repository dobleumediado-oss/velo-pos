# Roadmap de velocidad y estabilidad de Velo Suite

[← Volver a CLAUDE.md](../CLAUDE.md) · Relacionados: [Multi-terminal](multi-terminal-sync.md) · [Corrección de facturas](sale-corrections.md)

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
  anticipo, trade-in, corte de comisión ni documentos compensatorios se puede
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

### Revisión de alcance y sobreingeniería

- Se descartó crear un nuevo módulo, tabla, estado documental o migración de
  datos. La solución reutiliza `sales`, `sale_items`, `inventory_movements`,
  `sale_corrections` y la contabilidad ya existentes.
- Solo existen dos caminos: edición directa para crédito pendiente elegible y el
  flujo compensatorio existente para el resto. La selección se resuelve en el
  repositorio; la interfaz únicamente muestra el modo recibido.
- Se retiraron parámetros y comprobaciones duplicadas detectadas en la revisión.
  Los bloqueos restantes corresponden a efectos reales que no pueden reescribirse
  con seguridad: cobros, fiscalidad, seriales, conduces, cierres, importaciones y
  comisiones.
- El cambio de rendimiento añade un filtro de vista y un índice compuesto; no
  incorpora cachés, procesos residentes ni sincronización adicional.

## Ronda Permisos y clave operativa — 15 de septiembre de 2026

### Problema confirmado

- Permitir el módulo Clientes a un cajero no habilitaba de forma coherente todas
  sus operaciones: podía entrar al módulo, pero no actualizar información,
  contactos, sucursales o el límite de crédito del cliente.
- La clave especial para cambiar precios debía conservar exactamente las letras
  mayúsculas y minúsculas escritas al configurarla y al usarla en el POS.

### Ruta mínima aplicada

- El permiso Clientes es ahora la autoridad para administrar la ficha completa,
  representantes, sucursales y límite de crédito. La eliminación total del
  cliente permanece reservada al administrador y superadministrador.
- Los dos campos de configuración y el campo de autorización del POS quedan
  explícitamente fuera de la normalización a mayúsculas. El servidor conserva
  la comparación segura existente y distingue, por ejemplo, `Clave123` de
  `clave123`.
- No se añadieron roles, permisos, tablas ni migraciones. Se corrigieron las
  validaciones existentes y se documentó el comportamiento en la propia pantalla.

### Verificación y reversión

- Las pruebas de permisos cubren lectura y edición completa de Clientes para el
  cajero autorizado, rechazo cuando el módulo está bloqueado y eliminación solo
  administrativa.
- La prueba de normalización verifica que los tres campos de clave preserven el
  caso exacto. La revisión de publicación mantiene intactos inventario, ventas,
  clientes y documentos existentes.
- Reversión: retirar las excepciones de captura y las validaciones de permiso
  restaura la conducta anterior; no hay datos que convertir ni reparar.

## Ronda de latencia y refresco — 18 de septiembre de 2026

Diagnóstico medido sobre una copia de una base real (2,524 facturas, 2,710
abonos, 1,246 productos, 317 clientes) ejecutando los repositorios bajo el
runtime de Electron. Cinco fases, cada una con su commit y su regresión.

### Fase 1 — Consultas por fila (N+1)

- `customersRepo.getAll` resolvía contactos, sucursales y teléfonos con cinco
  consultas **por cliente**: ~1,585 consultas y **56.5 ms**. Agrupadas en tres
  consultas fijas: **3.9 ms**.
- `hydratePaymentAllocations` consultaba las aplicaciones **por abono**. Ya
  corregido en `getAllPayments` (**269 ms → 53 ms**), esta ronda cierra los tres
  puntos restantes: estado de cuenta del cliente, cierre de caja e historial por
  rango.
- `tableExists` consultaba `sqlite_master` en cada llamada —58 usos, varios
  dentro de bucles—. Se cachea **solo el resultado positivo**: una ausencia
  nunca se guarda, de modo que una tabla creada por una migración posterior se
  sigue detectando.

### Fase 2 — Trabajo repetido en el refresco

- Una misma recarga se disparaba varias veces en paralelo al encadenar acciones.
  Productos, clientes y abonos comparten ahora la consulta ya en vuelo.
- Los abonos solo se recargan para las pantallas que los muestran —Ventas,
  Clientes y Caja—. Fuera de ellas queda pendiente y el router lo recupera al
  entrar a una que sí los use.

### Fase 3 — Repintado que descolocaba

- Caja, Ventas y Clientes reconstruían todo el DOM del módulo tras cada acción.
  Como `.page` es el contenedor que scrollea, la vista saltaba al tope y el
  campo enfocado se perdía: buena parte de lo que se percibe como lentitud.
- `veloRepaint` conserva posición de scroll, campo activo y posición del cursor.
  Navegar entre módulos no pasa por el helper: ahí empezar arriba es correcto.

### Fase 4 — Reactividad en modo local

- `setAfterMutation` solo se registraba en modo servidor, así que una
  instalación de una sola terminal nunca recibía `sync:changed`.
- El modo local registra su propio sink, que avisa únicamente a su renderer. El
  eco de la propia acción se descarta dentro de una ventana de 700 ms para no
  duplicar consultas; un aviso local se atiende en 120 ms en vez de 250.

### Fase 5 — Memoria acotada

- `DB.payments` sostenía todo el historial y crecía sin techo. Ahora se sostiene
  una ventana de los 3,000 más recientes, que cubre Caja y el detalle de un
  cliente; la pestaña de Abonos pide el historial completo antes de filtrar.

### Verificación

- `npm run test:sales-history-performance` pasó de 14 a **43 aserciones**. Entre
  ellas, tres cuentan consultas reales interceptando `db.prepare`: **3 para 400
  abonos** y **5 para 122 clientes** —una regresión al patrón N+1 falla la
  prueba—. Otras comprueban que la caché de tablas no congela una ausencia, que
  el repintado restaura scroll y foco, que el eco del aviso no duplica trabajo y
  que la ventana de abonos empieza por el más reciente.
- Sin cambios de comportamiento: `test:financial` (199), `test:sale-corrections`
  (106), `test:cash-income` (40), `test:customer-companies` (31), `test:business`
  (29), `test:documents` (43), `test:checkout` (24), `test:payment-ui` (16),
  `test:client-account`, `test:pending-invoices`, `test:pos`, `test:cash-ui`,
  `test:data-loader`, `test:experience`, `test:server-service` y
  `verify:integrity`.

### Pendiente de esta línea

- Repintado por fila en los módulos restantes: quedan ~78 puntos que reconstruyen
  el módulo completo; esta ronda solo los hizo inocuos, no los eliminó.
- Productos y clientes siguen cargándose completos en memoria. Con 1,246 y 317
  no molesta; conviene paginarlos antes de las ~20,000 referencias.
- El costo restante de un refresco tras mutación es ~91 ms cuando la pantalla
  necesita ventas, productos y clientes a la vez.

## Ronda Conciliación de correcciones heredadas — 15 de septiembre de 2026

### Alcance multiempresa

- La solución no contiene nombres de clientes, números de factura ni reglas para
  un negocio concreto. Cada base identifica sus propias notas de crédito y
  facturas de aumento mediante `sale_correction_documents` y `sale_corrections`.
- La actualización no borra, anula ni reescribe NCF/e-CF. Los documentos de
  respaldo permanecen inmutables y consultables desde Auditoría.

### Resultado operativo

- Clientes, Facturas pendientes y el detalle de la venta presentan una sola
  operación: artículos finales, total neto y suma del saldo repartido entre la
  factura raíz y los aumentos internos.
- Las notas creadas exclusivamente por el flujo anterior de corrección dejan de
  aparecer como devoluciones comerciales. Las devoluciones reales e independientes
  permanecen visibles y no se confunden con una corrección.
- No hay migración ni escritura al instalar. La conciliación se calcula al leer
  los vínculos existentes, por lo que funciona igual en VELO POS y VELO TECH POS
  y no modifica inventario, caja, CxC, contabilidad ni correlativos.

### Verificación

- La regresión reproduce una factura fiscal a crédito cuyo precio cambia de
  RD$118.00 a RD$100.00 mediante los documentos del flujo anterior. Comprueba
  una sola línea vigente, total y saldo RD$100.00, ausencia de la nota en
  Devoluciones y conservación completa en Auditoría.
- La cuenta del cliente verifica además el caso RD$306,600.00 + RD$166,040.00 −
  RD$185,600.00 = RD$287,040.00 sin depender del cliente que originó el reporte.

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
