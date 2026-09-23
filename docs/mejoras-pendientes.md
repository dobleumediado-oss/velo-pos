# Mejoras pendientes — de la lista de doce

[← Volver a CLAUDE.md](../CLAUDE.md) · Relacionados: [Flujos y numeración documental](document-workflows.md) · [Corrección controlada de facturas](sale-corrections.md) · [Rendimiento y latencia](velo-performance-roadmap.md)

El 2026-09-21 el dueño pidió doce mejoras. **Nueve salieron en la 1.51.0**
(ver [CHANGELOG](../CHANGELOG.md)) y los **puntos 1, 5 y 9** quedaron completos
para la 1.52.0 el 2026-09-23. La revisión final también reforzó los reportes
607/608 y la captura regional de descuentos. El orden es el de la lista
original, no el de prioridad.

> Las citas `archivo:línea` se verificaron contra el código en la 1.51.0.
> Compruébalas otra vez antes de afirmarlas: el archivo se mueve.

## Auditoría de los doce puntos — 2026-09-23

| # | Mejora | Estado comprobado | Cobertura principal |
|---|---|---|---|
| 1 | Anular factura con abonos y elegir destino | **Completa en esta rama**. Incluye facturas y abonos históricos; un abono importado se revierte en CxC sin inventar una salida de caja. | `test-sale-cancellation-payments` (36 casos) |
| 2 | ITBIS y estado PAGADA/PENDIENTE en Ventas | **Completa** en lista y exportación. | `test-sales-history-performance` |
| 3 | PDF/impresión en lote de facturas con comprobante | **Completa y verificada con datos**: consulta solo el período elegido por páginas y arma una factura por hoja. | `test-ncf`, `test-experience` |
| 4 | Comprobantes fuera de Configuración | **Completa y reforzada**: vive en Reportes; 607/608 valida permiso en `main`, filtra 607 por emisión y 608 por anulación, y presenta ITBIS. | `test-ncf`, `test-experience` |
| 5 | Buscador global correcto y rápido | **Completa**: número con/sin ceros, NCF, Ñ/tildes y fragmentos; consulta diferida 50 ms. | `test-global-search` |
| 6 | Rango personalizado en Ventas | **Completa**: ambos extremos incluidos, fechas invertidas e inválidas controladas. | `test-sales-history-performance` |
| 7 | Mostrar número NCF en la lista | **Completa**: aparece junto al tipo de comprobante. | `test-sales-history-performance` |
| 8 | Anticipar próximo NCF y próxima factura al cobrar | **Completa**. Es una vista previa; la asignación definitiva sigue siendo transaccional al confirmar. | `test-pos` |
| 9 | Oferta/regalo sin cobrarlo dos veces | **Completa**: la línea marcada queda en RD$0, las demás conservan su precio y el total suma solo lo efectivamente cobrado. Conserva trazabilidad, impresión e inventario. | `test-sale-offers` (22 casos) |
| 10 | Recibo de ingreso enlazable a cliente | **Completa**; también conserva el nombre libre de una persona no registrada. | `test-cash-income` (66 casos) |
| 11 | Preventa opcional desde Configuración | **Completa**; al apagarla desaparecen módulo y envío a caja. | `test-pos`, `test-cash-income` |
| 12 | Cobrar solo cargos adicionales | **Completa** en pantalla, guardado, impuestos y contabilidad. | `test-additional-charges` (42 casos) |

La auditoría encontró y corrigió el caso histórico del punto 1, la autorización
de proceso principal del punto 4 y el uso incorrecto de la fecha de emisión en
el 608. Los reportes fiscales ahora incluyen ITBIS y la descarga masiva tiene
una prueba real de rango. También se actualizó una prueba antigua que exigía
literalmente 100 ms aunque el buscador ahora espera 50 ms. No se tocó
`data/velo.db`.

---

## Punto 1 — Anular una factura que ya tiene abonos

> **Hecho por Codex el 2026-09-23** en la rama
> `fix/anulacion-con-abonos` (sin publicar): tres destinos trazables, registro
> persistente en la cuenta del cliente, auditoría, contabilidad e idempotencia.

### Qué pidió el dueño originalmente
> "Anular facturas históricas: si está pagada o tiene un abono, preguntar qué
> hacer con ese abono: aplicarlo a otra deuda pendiente, dejarlo como crédito a
> favor, o anular todo incluido el abono. Que no lo deje como crédito a favor
> automáticamente."

### Qué hace ahora (verificado)
- El modal carga los abonos vigentes y obliga a elegir uno de los tres destinos
  antes de anular. Reaplicar exige otra factura del mismo cliente con saldo
  suficiente para recibir el monto completo.
- La anotación a favor queda visible en el estado de cuenta sin alterar el
  balance ni el crédito disponible.
- Al anular el abono, un recibo compartido conserva las aplicaciones de las
  otras facturas. Caja, CxC, contabilidad, inventario y auditoría se actualizan
  en una sola operación idempotente.

### Qué decidió el dueño (2026-09-23)
Al anular una factura con abonos, VELO **pregunta** en vez de bloquear, con tres
salidas:

1. **Aplicarlo a otra factura pendiente del mismo cliente**, que el usuario elige
   de una lista con los saldos a la vista. Una sola factura: repartir entre
   varias no entra por ahora.
2. **Dejarlo anotado a favor del cliente** sin tocar el balance ni inventar un
   saldo a favor. El registro debe quedar fijo en la cuenta del cliente y en la
   auditoría: un aviso que desaparece es plata que se olvida.
3. **Anular todo, incluido el abono**, revirtiendo el dinero como si nunca
   hubiera entrado. Es el caso más común: se anula por errores de digitación, se
   rehace la factura y se vuelve a cobrar.

Además:
- **De la anulación no sale efectivo.** Entregar billetes es un egreso
  deliberado desde Caja, como hoy.
- **Las facturas con NCF preguntan lo mismo**: la pregunta es por el dinero
  recibido; el camino fiscal del comprobante (nota de crédito, 608) no cambia.
- **Permiso**: el mismo que ya exige anular (`sales.cancel`).

### Turno de caja cerrado — decisión confirmada
El comportamiento existente se conserva: el turno original cerrado no se
modifica. Para **anular todo, incluido el abono**, debe existir una caja actual
abierta y el contramovimiento se registra allí. El dueño confirmó esta regla el
2026-09-23. Si el recibo estaba repartido, solo se revierte la parte aplicada a
la factura anulada.

### Dónde tocar
`openAnulacionModal` en [`src/js/ventas.js:2169`](../src/js/ventas.js) ·
`confirmarAnulacion` en [`src/js/ventas.js:2246`](../src/js/ventas.js) ·
handler `sales:cancel` en [`main.js:3610`](../main.js) · `salesRepo.cancel` en
[`database.js:7243`](../database.js) · pruebas en
`scripts/test-sale-corrections.js` y `scripts/test-pending-invoices.js`.

---

## Punto 5 — El buscador global no encuentra y se siente lento

> **Hecho por Codex el 2026-09-23** (`2b5de45`: `database.js`, `src/js/app.js`
> y `scripts/test-global-search.js`, enganchada a `test:tech-readiness`).
> Falta probarlo en vivo con el dueño y publicarlo en una versión.

### Qué pidió el dueño
> "Arreglar el buscador general: no encuentra las facturas correctas y va lento."

### Cómo se verificó
La prueba instrumentada mide desde la tecla hasta los resultados y registra las
consultas ejecutadas. Cubre `00002388`, `2388`, `B0200000407`, un nombre con Ñ y
tilde, el mismo nombre sin signos y un fragmento. Todas las variantes encuentran
la factura esperada sin consultar artículos cuando el texto ya identifica un
documento. La espera entre teclas es de 50 ms y solo la última consulta se
ejecuta.

### Dónde tocar
`_openGSearch` en [`src/js/app.js:2216`](../src/js/app.js) (overlay, teclado y
pintado de resultados; las ventas se listan cerca de
[`src/js/app.js:2471`](../src/js/app.js)) · handler `sales:search` en
[`main.js:3422`](../main.js) · `salesRepo.search` en
[`database.js:7046`](../database.js) · presupuesto de latencia en
[Rendimiento](velo-performance-roadmap.md).

### Prompt de entrega (copiar y pegar a otro agente)

> En el repositorio Velo POS (POS de escritorio en Electron, sin frameworks), el
> buscador global —la lupa de la barra superior, o ⌘K / Ctrl+K— no
> encuentra las facturas correctas y se siente lento al escribir. Arréglalo.
>
> Antes de cambiar nada, **mide**: instrumenta cuánto tarda cada tecla desde que
> se escribe hasta que se pintan los resultados, y qué consulta se ejecuta.
> Prueba al menos estos textos: el número de factura completo con ceros
> (`00002388`), el número sin ceros (`2388`), un NCF (`B0200000407`), un nombre
> de cliente con Ñ o tilde, y un fragmento del nombre. Anota qué se esperaba y
> qué devolvió cada uno. Pídele al dueño un ejemplo real que le haya fallado: es
> el camino más corto al bug.
>
> El código: `_openGSearch` en `src/js/app.js:2216` (overlay, teclado y pintado;
> las ventas se listan cerca de `src/js/app.js:2471`), el handler `sales:search`
> en `main.js:3422` y `salesRepo.search` en `database.js:7046`. Verifica esas
> líneas: se mueven.
>
> Reglas del repositorio, en `AGENTS.md`, y en particular: la base de datos se
> toca solo desde el proceso main vía IPC, nunca desde `src/js/`; no escribas en
> `data/velo.db` (datos de clientes reales, trabaja sobre una copia y bórrala);
> no uses `git add -A` ni `git commit -a`, porque el árbol tiene cambios ajenos
> sin commitear; y **no empujes ningún tag `v*`**, que eso publica la
> actualización a los clientes.
>
> Terminado significa: las búsquedas de la lista devuelven lo correcto, tienes
> el antes y el después en milisegundos, hay una prueba nueva en `scripts/` que
> falla con el código viejo, y `npm run test:tech-readiness` queda en verde.

---

## Punto 9 — Regalo ("Oferta") dentro del carrito

> **Hecho por Codex el 2026-09-23** en la rama `feat/regalo-oferta`. El reparto
> vive en un motor compartido por renderer y main, y su prueba
> `scripts/test-sale-offers.js` quedó enganchada a `test:tech-readiness`.

### Qué pidió el dueño
> "Poner un botón de Oferta en el carrito que abra un modal con los artículos.
> Al presionar uno, su valor se reparte entre los artículos **no** seleccionados,
> el regalo aparece en 0 y **el total de la factura no cambia**. Contable e
> internamente eso debe quedar explicado."

### Regla final confirmada el 2026-09-23

El precio de los artículos no marcados **ya incluye comercialmente el regalo**.
Por eso VELO no vuelve a sumar el valor del regalo: la línea seleccionada se
muestra y se guarda en RD$0, las demás conservan exactamente su precio y el total
es la suma de las líneas cobradas. Ejemplo confirmado: RD$1,050 de regalo +
RD$2,950 cobrados = total RD$2,950, no RD$4,000.

### Cómo quedó resuelto
- **Precio y total**: el regalo queda en cero y ninguna otra línea cambia de
  precio. El reparto proporcional existe solo como trazabilidad interna de qué
  líneas incluyen el valor promocional; nunca vuelve a sumarse al cobro.
- **Selección**: se regala la cantidad completa de cada línea y se permiten
  varias líneas de oferta en una misma factura.
- **ITBIS**: se recalcula sobre el importe realmente cobrado. La trazabilidad se
  limita a líneas del mismo trato fiscal y la interfaz informa si no existe una
  compatible.
- **Un solo artículo en el carrito**: no hay entre quién repartir. El modal debe
  impedirlo y explicar por qué.
- **Rastro interno**: guardar por línea el valor regalado y el absorbido
  (migración aditiva sobre `sale_items`), para que el margen por producto y el
  costo de la promoción no mientan en los reportes.
- **Impresión**: la línea del regalo va en RD$0 con la etiqueta **OFERTA**; el
  resto conserva su precio y el total impreso coincide con el cobro.
- **Devoluciones y correcciones**: queda pendiente una política promocional
  específica. Por ahora, una devolución usa el importe registrado en la línea:
  el regalo devuelve RD$0 y una línea que incluye la promoción devuelve su
  importe registrado. No se redistribuye la promoción automáticamente.

### Dónde tocar
Carrito y `renderCart` en [`src/js/pos.js`](../src/js/pos.js) (el modelo de línea
y `currentInv()`) · guardado de la venta en `sales:create`
([`main.js`](../main.js)) y `salesRepo.create` ([`database.js`](../database.js)) ·
plantillas en [`src/js/plantillas.js`](../src/js/plantillas.js) · asiento en
[`docs/accounting-module.md`](accounting-module.md) · pruebas en
`scripts/test-pos-interactions.js` y `scripts/test-additional-charges.js`.

---

## QA en la app real — 2026-09-23

Con una copia de la base de un cliente (2,526 ventas, 1,246 productos):

- **Oferta de punta a punta**: carrito de RD$1,050 + RD$2,950, se marca el
  primero como regalo → total **RD$2,950**, ITBIS RD$450 sobre RD$2,500. La venta
  guardada deja el regalo en `unit_price` 0 con `offer_original_amount` 1,050 y
  la otra línea con `offer_absorbed_amount` 1,050.
- **Se encontró y se corrigió un fallo**: la etiqueta OFERTA **no llegaba a la
  factura**. `printReceipt` copia cada artículo a la plantilla con una lista fija
  de campos y `offer_is_gift` no estaba en ella, así que el regalo se imprimía en
  RD$0 sin ninguna explicación, en térmica y en A4. Se agregó el campo en
  [`src/js/print.js`](../src/js/print.js) y, en el ticket térmico, la marca pasó a
  la línea del precio porque el nombre se recorta al ancho del rollo y se comía la
  palabra ([`_termicaItems`](../src/js/plantillas.js)). Verificado después:
  `1 x RD$0 · OFERTA` en térmica y `… · OFERTA` en la A4.
- **Anulación con abonos**: una factura con 2 abonos por RD$18,160 abre el modal
  con las tres salidas (`reapply`, `favor`, `void`), el selector de factura
  destino y el botón ya habilitado. Antes quedaba bloqueado.

## Cómo verificar cualquiera de los tres
Con la app real contra una **copia** de la base del cliente, nunca contra
`data/velo.db`. El procedimiento (snapshot de solo lectura, `--dev` por la
licencia, contraseña bcrypt en la copia, ventana 1366×689) está en la memoria del
proyecto como *QA visual con medidas*, y las copias se borran al terminar.
