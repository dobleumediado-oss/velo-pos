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
runtime de Electron. Nueve fases, cada una con su commit y su regresión, más una ronda final de
cobertura sobre los recorridos que antes solo se comprobaban a mano.

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

### Fase 6 — Acceso y módulos restantes

- En la pantalla de acceso, marcar **Supervisor** llamaba a `build()`, que hacía
  `root.innerHTML = ''` y reconstruía toda la vista. El reloj volvía a su
  marcador `00:00:00` con la fecha vacía hasta 50 ms después: el bloque cambiaba
  de altura y empujaba la tarjeta, el navegador rasterizaba de nuevo el
  `backdrop-filter` de la card y el foco se perdía y volvía. Ese era el salto.
- Cambiar de rol solo afecta al botón activo, la etiqueta y el campo de usuario;
  ahora se actualizan esos tres nodos. El reloj arranca en el mismo cuadro.
- Los 51 repintados de módulo restantes pasan por `veloRepaint`. El POS y el
  asistente quedan fuera a propósito: manejan su propio foco.

### Fase 7 — Cada pantalla con su propia fuente

- `DB.sales` y `DB.payments` eran cachés compartidas con cuatro consumidores de
  necesidades distintas: la página de Ventas, la sesión de Caja, el día del panel
  y algunas búsquedas. **Quien las cargara de último decidía lo que veían los
  demás**, y por eso no se podían acotar. El resumen de una caja ya cerrada casi
  nunca encontraba sus ventas ahí.
- Caja consulta ahora sus ventas y sus abonos por el identificador de la sesión
  (`getSessionSales` y el nuevo `getSessionPayments`), y el panel pide las ventas
  del día. Mientras llega su consulta ambos usan lo que haya en memoria: nunca
  peor que antes, exacto en cuanto responde.
- Con las cachés libres, el refresco tras una mutación en Ventas trae la página
  visible en vez de 1,000 documentos, y la ventana de abonos baja a 500.

| Medición | Antes | Después |
|---|---:|---:|
| Refresco completo tras una mutación | ~90 ms | **~27 ms** |
| Ventas que necesita Caja | dependía de otra pantalla | **0.3 ms** |
| Abonos que necesita Caja | filtrado de 2,710 en memoria | **0.3 ms** |

### Fase 8 — Configuración y la excepción del POS

- Activar una licencia, guardar o eliminar el logo repintaba Configuración desde
  el principio. Esos tres puntos vivían en `wizard.js` y quedaron fuera de la
  fase 6 por el nombre del archivo, pero no son pasos de un asistente.
- El Punto de Venta se mantiene fuera del helper **por una razón verificada**:
  tras cobrar limpia la factura y `renderPOS` devuelve el foco al buscador para
  el siguiente escaneo. Restaurar el foco anterior desde afuera pelearía con eso.

### Fase 9 — La búsqueda deja de recalcular lo mismo

- `searchNorm` descompone el texto en Unicode y le aplica una expresión regular.
  El POS y el Inventario la invocaban por cada campo de cada producto en cada
  tecla: con 1,246 productos son **6,230 limpiezas por pulsación**, siempre sobre
  textos que no cambiaron desde la pulsación anterior.
- Ahora recuerda lo ya calculado. **No es una reescritura**: es la misma función
  con memoria, así que el resultado es idéntico por construcción y ningún
  producto puede dejar de aparecer. Por eso no necesitó prueba diferencial contra
  otra implementación, solo contra sí misma.
- **1.81 ms → 0.35 ms por tecla.** Alcanza a los 65 puntos de búsqueda de la
  aplicación y al buscador global del proceso principal.
- Las dos copias —renderer y proceso principal— se mantienen en paridad, como
  exige el encabezado de `lib/text-normalize.js`; ahora una prueba lo verifica.
  La tabla se vacía al llegar a 20,000 entradas.

### Cobertura de los recorridos completos

Cinco recorridos solo podían comprobarse usando la aplicación. Ahora cada uno
tiene su prueba de extremo a extremo; no eran defectos, eran huecos.

| Recorrido | Dónde | Qué fija |
|---|---|---|
| Ciclo de caja con las fuentes nuevas | `test:cash-income` | Abrir, vender de contado y a crédito, cobrar un abono, cuadrar, cerrar y **volver a consultar la sesión cerrada** |
| Recibo en dólares de punta a punta | `test:cash-income` | Crear, corregir la tasa sin perder el número, efecto exacto en caja, hallarlo en el historial y tras el cierre |
| Corrección sin comprobante fiscal | `test:sale-corrections` | El efectivo esperado refleja **exactamente** la diferencia |
| Producto recién guardado | `test:sales-history-performance` | Su página en los bordes y que los filtros lo esconderían |
| Cambio de rol en el acceso | `test:experience` | Identificador y foco del campo, error limpiado, vuelta a Cajero |

### Verificación

- `npm run test:sales-history-performance` pasó de 14 a **59 aserciones**;
  `test:cash-income` de 14 a **59** y `test:sale-corrections` de 98 a **108**. Entre
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

- Una prueba recorre `src/js` y falla nombrando cualquier módulo que reconstruya
  su pantalla sin pasar por el helper, así que la regla no se erosiona.
- El cambio de rol del acceso se ejercita en `test:experience`: comprueba que el
  botón activo se traslada, que el campo pasa a correo y que el reloj **no**
  vuelve a `00:00:00`.

- `test:cash-income` comprueba que Caja consulta su sesión y que el panel no
  depende de la colección compartida; una regresión a `DB.sales`/`DB.payments`
  para cuadrar falla la prueba.

### Pendiente de esta línea, con su disparador

Ninguno de estos es urgente hoy. Se anota **cuándo** dejarán de serlo, para no
optimizar antes de tiempo ni descubrirlo tarde.

- **Catálogo y clientes completos en memoria** — 8.8 ms y 3.4 ms medidos con
  1,246 productos y 317 clientes. El POS busca sobre el catálogo en memoria, así
  que paginarlo exige primero mover esa búsqueda al backend. *Disparador:
  ~20,000 referencias, o si `products.getAll` pasa de 50 ms.*
- **Repintado por fila** — los módulos siguen reconstruyendo su pantalla; la
  línea los hizo inocuos —sin salto ni pérdida de foco— pero no eliminó el
  trabajo de DOM. Con 100 filas por página ese trabajo no se percibe. Inventario
  es la excepción: parchea la fila. *Disparador: una tabla que supere las ~300
  filas visibles o un repintado que se note al confirmar.*
- **Búsqueda en memoria del catálogo** — el POS y el Inventario siguen filtrando
  en memoria, ahora a 0.35 ms por tecla. Llevarla al backend exigiría reescribir
  la comparación en SQL, donde `LIKE` no quita tildes ni maneja la Ñ igual: eso
  sí puede hacer que un producto no aparezca. *Si algún día se hace, el requisito
  es una prueba diferencial sobre el catálogo real —prefijos, tildes, Ñ, códigos
  y códigos de barras— que exija coincidencia total antes de cambiar nada.*

## Ronda Pantallas de 1366×768 — 19 de septiembre de 2026

Un cliente trabaja en un portátil HP con Windows 11 a 1366×768. Descontando la
barra de tareas y el marco quedan **1366×689 px** útiles. Todo se midió en la app
real —posiciones del DOM, no a ojo— con una copia de los datos de ese negocio
(1,246 productos, 317 clientes); nunca sobre la base de producción.

Regla de la ronda, decidida por el dueño: se gana espacio en relleno y adornos,
**nunca ocultando datos ni indicadores**. Los combustibles de la barra no se
ocultan en pantallas angostas.

### Problema confirmado

| Pantalla | Antes (1366×698) | Causa |
|---|---|---|
| Cobro | Confirmar en y=1085: fuera de la pantalla | el formulario mide 1,108 px en una caja de 638 |
| POS | la página se pasaba 6 px del alto, en **cualquier** pantalla | `.pos-wrap` restaba 58 px y la barra mide 64 |
| Barra superior | título y reloj montados 53 px; los indicadores pedían 441 px y había 366 | zona central centrada que se derramaba a ambos lados |
| Inventario | primera fila en y=666, ningún producto completo; la tabla pedía 1,150 px y había 1,037, con las acciones fuera de vista | encabezado de 117 px más métricas; 13 px de relleno por celda |
| Clientes | tabla 49 px más ancha que su espacio; con una empresa en la lista, 287 px | los botones de empresa en la misma fila que el resto |
| Contabilidad | 3 de las 16 pestañas fuera de vista (273 px) | pestañas en una sola fila con desplazamiento lateral |
| Configuración | tabla de secuencias NCF 159 px más ancha que su columna | 9 columnas en una columna de 609 px |

### Ruta mínima aplicada

1. **Pie de modal fijo** — los botones quedan pegados al borde inferior del modal
   y el contenido pasa por detrás.
2. **POS** — `.pos-wrap` toma el alto de su área (`height:100%`); con 780 px de
   alto o menos, el pie de cobro se compacta.
3. **Barra superior** — `fitTopbar()` mide y suma niveles solo mientras no cabe
   (5 niveles acumulativos). Ninguno oculta la tasa ni los combustibles; el
   último retira "Crear rápidamente" (sigue en Ctrl+J) y la guía, igual que la
   app ya hacía bajo 1180 px.
4. **Módulos en pantallas bajas** — encabezado, métricas, paginación de
   Inventario y barra de registros con las medidas del modo compacto (`.ui-compact`).
5. **Tablas a 1440 px o menos** — relleno lateral de 13 a 9 px y botones de fila
   más ajustados; en Inventario, modelos y categorías largos bajan de línea.
6. **Columna de acciones fija** (`.velo-sticky-actions`) en Inventario y NCF. Si
   una página aún no cabe —montos de 7 cifras, datos largos—, los botones siguen
   a la vista. La sombra de borde la mueve el desplazamiento real de la tabla
   (`animation-timeline: scroll()`), así que no aparece cuando la tabla cabe.
7. **Clientes** — los botones de empresa van en su propio grupo, que baja de línea.
8. **Pestañas de módulo** (`.mod-tabs`) — bajan de fila a 1440 px o menos.

### Medición y seguridad

| Pantalla | Después (1366×689) |
|---|---|
| Cobro | Confirmar en y=606–640, visible |
| POS | Cobrar termina en 681 (8 px de margen) y la página no se desplaza; la lista del carrito pasa de 130 a 195 px (1366×698) |
| Barra | título y reloj separados 21 px; 3/3 indicadores en los 6 escenarios: 1920, 1440, 1366, 1280 y fuente ancha a 1366 y 1280 |
| Inventario | primera fila completa (y=578–674); la tabla cabe (0 px de desborde) |
| Inventario, peor caso | montos de 7 cifras más un modelo largo: 37 px de desborde, acciones a la vista, sombra solo mientras hay contenido debajo |
| Clientes | cabe; ninguna fila normal partida; la empresa en dos líneas |
| Contabilidad | 16 de 16 pestañas visibles, en dos filas |
| NCF | "Administrar" siempre visible; la barra de desplazamiento queda justo debajo |

A 1920×1000 lo único visible es que, en Clientes, la fila de una empresa lleva
sus dos botones propios en una segunda línea. Sin errores de consola en ningún
tamaño.

- `test:experience` protege las reglas. Ejecuta `fitTopbar()` sobre una barra
  simulada: suelta niveles viejos, se detiene al caber y no pasa del 5. Además
  comprueba que ningún nivel oculte indicadores. Cuatro roturas deliberadas
  —ocultar combustibles, quitar la columna fija, no soltar niveles, juntar los
  botones de empresa— hacen fallar la prueba.
- Sin cambios de comportamiento: `test:sales-history-performance` (60),
  `test:financial` (199), `test:customer-companies` (31),
  `test:additional-charges` (33), `test:payment-ui` (16), `test:ncf`,
  `test:printing`, `test:pos`, `test:cash-ui`, `test:client-account`,
  `test:input-normalization`, `test:suite-invariants` y `verify:integrity`.
- `test:sales-history-performance` tenía una verificación de texto desactualizada
  desde `04626dc`: buscaba una línea que ese commit movió a `invPageForFocus`. Se
  corrigió para apuntar al código actual; el comportamiento ya lo cubrían las
  pruebas de esa función.
- `verify:marker` falla también sobre `HEAD` limpio desde `4fe59ee` (v1.46.0):
  confunde una nota en pantalla de Clientes con el marcador histórico. No lo
  causa esta ronda; queda como tarea aparte.

### Pendiente de esta línea, con su disparador

- **Fuente DM Sans desde internet** — se descarga de Google Fonts; sin conexión,
  Windows usa `system-ui` (Segoe UI). La barra se probó con Verdana, que aquí
  ocupa más que DM Sans: a 1366 px usa los niveles 1 a 3 y todo cabe. *Disparador: textos cortados
  en un equipo sin internet; entonces se empaqueta la fuente con la app.*
- **Ventana restaurada de 1280×800** — la app abre maximizada, pero si el
  usuario la restaura en una pantalla de 768 px, el borde inferior queda fuera.
  *Disparador: un cliente que trabaje sin maximizar; entonces el tamaño inicial
  se ajusta al área de trabajo de la pantalla.*
- **Avisos sobre el botón Cobrar** — los avisos salen abajo a la derecha y, en el
  POS, tapan el botón mientras duran. *Disparador: un cajero que lo reporte;
  entonces se mueven arriba en el POS.*
- **Recorrido completo a 1280×720** — la barra está probada ahí y las tablas
  usan la misma densidad, pero no se midieron todos los módulos a ese tamaño.

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

## Ronda del buscador global — 23 de septiembre de 2026

### Problema confirmado

- La consulta de ventas usaba `lower()` para encontrar clientes. SQLite solo
  transforma de forma nativa las letras ASCII, por lo que nombres almacenados
  en mayúsculas con tildes o Ñ no llegaban al filtrado normalizado final.
- Una factura directa por número o NCF recorría también `sale_items`, aunque el
  identificador ya era suficiente. La interfaz esperaba además 100 ms después
  de la última tecla antes de iniciar cualquier consulta.
- Con 6,000 facturas sintéticas, número y NCF tardaban entre 113.4 y 136.1 ms;
  `José Peña Núñez`, `Jose Pena` y `pena` tardaban entre 117.3 y 133.0 ms y no
  devolvían la factura esperada.

### Ruta mínima aplicada

- La conexión SQLite registra `VELO_SEARCH_NORM`, que comparte la misma función
  pura del proceso principal y no modifica datos. Solo los campos de texto
  humano de la búsqueda de ventas la usan para comparar sin mayúsculas, tildes
  ni Ñ.
- Los números de factura y NCF inequívocos omiten la consulta de artículos
  cuando el catálogo local no encontró un producto coincidente. El resto de las
  búsquedas conserva productos, clientes, vendedores, notas y recibos.
- El debounce baja de 100 a 50 ms; se conserva la cancelación por secuencia y el
  mismo overlay, teclado y presentación visual.

### Medición y seguridad

- Sobre la misma base temporal, `00002388`, `2388` y `B0200000407` quedaron
  entre 73.5 y 88.0 ms con dos consultas (`cabeceras → detalle`). Los tres
  nombres quedaron entre 80.9 y 84.1 ms con tres consultas y devolvieron la
  factura correcta.
- `scripts/test-global-search.js` mide desde la tecla hasta el pintado, informa
  las consultas y cubre los seis casos. Falla con la comparación anterior y
  pasa con la normalización nueva.
- La prueba crea y elimina su propia base temporal. No abre ni escribe
  `data/velo.db`; no hay migración ni información que revertir.
