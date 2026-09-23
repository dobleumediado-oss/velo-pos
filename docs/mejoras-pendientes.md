# Mejoras pendientes — de la lista de doce

[← Volver a CLAUDE.md](../CLAUDE.md) · Relacionados: [Flujos y numeración documental](document-workflows.md) · [Corrección controlada de facturas](sale-corrections.md) · [Rendimiento y latencia](velo-performance-roadmap.md)

El 2026-09-21 el dueño pidió doce mejoras. **Nueve salieron en la 1.51.0**
(ver [CHANGELOG](../CHANGELOG.md)). Aquí quedan las **tres** que faltan, con lo
que ya está decidido, dónde vive el código y qué hay que resolver antes de
escribir una línea. El orden es el de la lista original, no el de prioridad.

> Las citas `archivo:línea` se verificaron contra el código en la 1.51.0.
> Compruébalas otra vez antes de afirmarlas: el archivo se mueve.

---

## Punto 1 — Anular una factura que ya tiene abonos

### Qué pidió el dueño
> "Anular facturas históricas: si está pagada o tiene un abono, preguntar qué
> hacer con ese abono: aplicarlo a otra deuda pendiente, dejarlo como crédito a
> favor, o anular todo incluido el abono. Que no lo deje como crédito a favor
> automáticamente."

### Qué hace hoy (verificado)
- Con abonos vigentes, **la anulación está bloqueada**: el botón "Solo anular"
  sale deshabilitado y el aviso manda a anular cada abono primero
  ([`src/js/ventas.js:2194`](../src/js/ventas.js) y el `disabled` en el pie del
  modal). Anular un abono restaura el balance del cliente y revierte su
  movimiento de caja: el dinero se trata como si nunca hubiera entrado.
- Si el cliente había pagado **de más**, la anulación deja el balance en 0 y solo
  avisa: *"excedente … a revisar manualmente (reembolso o crédito)"*
  ([`src/js/ventas.js:2301`](../src/js/ventas.js), cálculo en
  [`database.js:7380-7388`](../database.js)). Ese excedente sin destino es lo
  que el dueño llama "crédito a favor automático".

### Qué falta decidir con el dueño (preguntar, no asumir)
1. **Aplicar a otra deuda**: ¿el usuario elige la factura pendiente a mano, o
   VELO propone la más antigua? ¿Puede repartirse entre varias?
2. **Devolver el dinero**: ¿sale de caja en efectivo? Si sí, ¿exige caja abierta,
   genera egreso y recibo, y qué pasa si se anula en otro turno?
3. **Crédito a favor**: hoy no existe como saldo real (el balance se corta en 0).
   ¿Se quiere un saldo negativo del cliente, o un documento de nota de crédito?
4. **Con NCF**: una factura con comprobante entregado no se anula sin más; le
   toca nota de crédito B04 (ver [Corrección controlada](sale-corrections.md)).
   ¿La pregunta del abono aplica igual en ese caso?
5. **Permiso y rastro**: ¿quién puede elegir el destino del abono y qué queda en
   la auditoría?

### Dónde tocar
`openAnulacionModal` en [`src/js/ventas.js:2169`](../src/js/ventas.js) ·
`confirmarAnulacion` en [`src/js/ventas.js:2246`](../src/js/ventas.js) ·
handler `sales:cancel` en [`main.js:3610`](../main.js) · `salesRepo.cancel` en
[`database.js:7380`](../database.js) · pruebas en
`scripts/test-sale-corrections.js` y `scripts/test-pending-invoices.js`.

---

## Punto 5 — El buscador global no encuentra y se siente lento

### Qué pidió el dueño
> "Arreglar el buscador general: no encuentra las facturas correctas y va lento."

### Qué falta
Medir primero, con una copia de datos reales y el arnés de QA visual: cuánto
tarda cada tecla, qué consulta se lanza y con qué texto falla (¿número de
factura con ceros?, ¿NCF?, ¿nombre del cliente con Ñ?, ¿parte del número?).
Sin la medición no se sabe si el problema es la consulta, la falta de índice, el
límite de 8 resultados o que se dispara en cada tecla.

### Dónde tocar
`_openGSearch` en [`src/js/app.js:2216`](../src/js/app.js) (overlay, teclado y
pintado de resultados; las ventas se listan cerca de
[`src/js/app.js:2471`](../src/js/app.js)) · handler `sales:search` en
[`main.js:3422`](../main.js) · `salesRepo.search` en
[`database.js:7046`](../database.js) · presupuesto de latencia en
[Rendimiento](velo-performance-roadmap.md).

---

## Punto 9 — Regalo ("Oferta") dentro del carrito

### Qué pidió el dueño
> "Poner un botón de Oferta en el carrito que abra un modal con los artículos.
> Al presionar uno, su valor se reparte entre los artículos **no** seleccionados,
> el regalo aparece en 0 y **el total de la factura no cambia**. Contable e
> internamente eso debe quedar explicado."

Decisión ya tomada por el dueño: **el total no cambia**. El cliente ve el regalo
en 0 y paga lo mismo; por dentro debe quedar registrado cuánto absorbió cada
línea.

### Qué hay que resolver al implementarlo
- **Reparto y centavos**: repartir proporcional al importe de cada línea y
  cuadrar el último centavo contra el total original, que no puede moverse.
- **ITBIS**: si el regalo es gravado y las líneas que lo absorben no lo son (o al
  revés), la base imponible cambia aunque el total no. Hay que decidir si el
  reparto se hace solo entre líneas del mismo trato fiscal.
- **Un solo artículo en el carrito**: no hay entre quién repartir. El modal debe
  impedirlo y explicar por qué.
- **Rastro interno**: guardar por línea el valor regalado y el absorbido
  (migración aditiva sobre `sale_items`), para que el margen por producto y el
  costo de la promoción no mientan en los reportes.
- **Impresión**: la línea del regalo va en 0 con su etiqueta; los totales salen
  igual que hoy.
- **Devoluciones y correcciones**: qué pasa si se devuelve el artículo que
  absorbió el valor del regalo.

### Dónde tocar
Carrito y `renderCart` en [`src/js/pos.js`](../src/js/pos.js) (el modelo de línea
y `currentInv()`) · guardado de la venta en `sales:create`
([`main.js`](../main.js)) y `salesRepo.create` ([`database.js`](../database.js)) ·
plantillas en [`src/js/plantillas.js`](../src/js/plantillas.js) · asiento en
[`docs/accounting-module.md`](accounting-module.md) · pruebas en
`scripts/test-pos-interactions.js` y `scripts/test-additional-charges.js`.

---

## Cómo verificar cualquiera de los tres
Con la app real contra una **copia** de la base del cliente, nunca contra
`data/velo.db`. El procedimiento (snapshot de solo lectura, `--dev` por la
licencia, contraseña bcrypt en la copia, ventana 1366×689) está en la memoria del
proyecto como *QA visual con medidas*, y las copias se borran al terminar.
