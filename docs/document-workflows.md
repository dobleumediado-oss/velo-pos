# Flujos y numeración documental

[← Visión general](overview.md) · Relacionados: [Impresión](printing-module.md) · [Clientes empresa](clientes-empresas.md)

## Principio

El `id` de SQLite es una llave técnica y nunca debe presentarse como el número
oficial de un documento nuevo. Las familias documentales usan correlativos
independientes:

| Documento | Prefijo | Cuándo se emite |
|---|---:|---|
| Factura al contado | `FAC-` | Instalaciones nuevas sin facturas importadas |
| Factura a crédito | `FCR-` | Instalaciones nuevas sin facturas importadas |
| Factura con historial migrado | número histórico, sin prefijo | Continúa la secuencia compartida del sistema anterior |
| Cotización | `COT-` | Al guardar una cotización |
| Nota de crédito | `NCR-` | Al procesar una devolución |
| Abono | `ABO-` | Al registrar un pago sobre CxC |
| Recibo | `REC-` | Al cobrar una factura al contado |
| Pago a proveedor | `PPR-` | Al pagar un gasto o cuenta por pagar |
| Conduce | `CON-` | Al crear una nota de entrega |
| Reporte impreso/PDF | `REP-` | Al confirmar impresión o guardado del reporte |

Los NCF no forman parte de este contador. Continúan saliendo exclusivamente de
los rangos autorizados en `ncf_sequences`.

## Persistencia y auditoría

- `document_sequences` guarda el último número de cada familia.
- `document_issues` relaciona el correlativo con su registro de origen.
- Como regla general, un número emitido y anulado permanece consumido.
- Excepción comercial controlada: una factura **nativa**, de **Consumidor
  Final**, **sin NCF ni e-CF** puede usar “Anular y registrar nuevamente”. El
  mismo número interno pasa únicamente a su reemplazo vinculado; no queda libre
  para cualquier venta siguiente. La factura anulada permanece en la base y
  `document_reuse_log` conserva origen, reemplazo, usuario, motivo y fecha.
- La excepción no aplica a documentos importados, clientes registrados,
  recibos, abonos, notas de crédito, cotizaciones, conduces ni reportes. El
  recibo del reemplazo siempre recibe un correlativo `REC-` nuevo.
- Los documentos importados conservan su número histórico.
- Si existen facturas importadas con un número histórico válido, las nuevas
  facturas de contado y crédito comparten esa misma secuencia. Velo parte del
  número mayor importado más uno; por ejemplo, después de `00002363` emite
  `00002364`.
- `FAC-` y `FCR-` se mantienen como comportamiento predeterminado únicamente
  para negocios sin historial importado.
- En el historial de Ventas se conserva además la referencia corta reconocida
  por el personal (`#2499`, por ejemplo). Las ventas nativas muestran debajo su
  correlativo Velo (`FAC-000004`); las migradas se identifican como
  `Importada de FAPRO` y priorizan su número histórico.
- Las cotizaciones nuevas no mueven inventario, caja, crédito ni contabilidad.
- En el Punto de Venta, “Agregar envío u otro cargo” se mantiene separado de los
  artículos del carrito. El concepto aparece en **Cargos adicionales**, se suma
  al total y se guarda e imprime en factura, cotización y conduce; una
  cotización o un conduce continúan sin mover inventario, caja, crédito ni
  contabilidad.
- El selector **Conduce** del POS guarda directamente una nota de entrega en
  `delivery_notes`. No cobra, no calcula impuestos y no mueve inventario. Solo
  admite productos vinculados al inventario para que puedan facturarse después.
- Desde el detalle del conduce, **Convertir a venta** permite escoger cantidades
  pendientes y abre Punto de Venta con el cliente, artículos, precios y cargos
  del conduce. El documento conserva su estado hasta confirmar la factura.
- Las conversiones parciales se enlazan por línea. El cargo pendiente se aplica
  una sola vez, en la primera factura confirmada; los intentos repetidos no
  duplican venta, inventario ni cargo. Al completar todas las cantidades, el
  conduce cambia a `facturado`. Si se anula una factura vinculada, se liberan
  únicamente sus cantidades y cargos para mantener la trazabilidad.
- Administrador y superadministrador pueden anular un conduce desde el listado o
  desde su detalle. El motivo es obligatorio, el documento permanece almacenado
  y su número `CON-` no vuelve a utilizarse.
- Eliminar una cotización la retira inmediatamente de la operación y conserva
  solo su correlativo y el evento de auditoría.

## Facturas reajustadas y crédito

- Una factura corregida conserva en Ventas toda la trazabilidad: motivo,
  documentos compensatorios, fechas y referencias relacionadas. Esa información
  es interna y no se imprime ni se muestra como observación en la copia del
  cliente.
- La reimpresión conserva el tipo de pago y el NCF originales. Por eso, una
  factura que nació a crédito no cambia a “varios” ni aparece como pagada solo
  por haber sido reajustada.
- Toda plantilla de factura a crédito incluye dos espacios de firma:
  **Entregado por**, con el nombre del usuario que atendió la venta, y
  **Recibido por**, con el nombre del cliente.
- Cuando un cliente registrado todavía no tiene límite de crédito, Velo puede
  asignarle al confirmar la venta un límite igual a su balance existente más el
  nuevo monto financiado. Para cajeros esta asignación está limitada por
  `pos_cashier_auto_credit_limit_amount`; al excederla se requiere una clave de
  administrador o superadministrador. Esos dos roles no tienen la restricción.

## Continuidad de tickets del POS

- Los tickets abiertos se guardan automáticamente por usuario en la terminal y
  se reconstruyen después de cerrar inesperadamente o perder energía.
- La recuperación conserva artículos, cantidades, precios de la venta, cliente,
  descuento, cargos, tipo de documento y pestaña activa.
- No se recuperan órdenes ya enviadas a caja ni estados de una operación en
  curso. Tampoco se guardan claves, tokens o autorizaciones temporales: cualquier
  excepción de descuento, precio o crédito debe autorizarse nuevamente.
- El respaldo local expira a los 30 días, admite hasta 20 tickets y no altera la
  base comercial hasta que el usuario confirme el documento.

## PDF por WhatsApp

Facturas, cotizaciones y conduces generan el PDF desde la misma plantilla usada
para imprimir. El sistema abre el chat y muestra el PDF temporal en su carpeta
para adjuntarlo. WhatsApp Web/Desktop no ofrece una URL segura para adjuntar un
archivo local automáticamente; automatizar el envío completo requiere integrar
WhatsApp Business Cloud API y sus credenciales.

## Reglas de implementación

- Usar `facturaLabel()` para la etiqueta visible de ventas, cotizaciones y notas.
- Usar `reciboLabel()` para abonos.
- No construir números con `sale.id`, `payment.id` o `padStart()` en módulos de UI.
- No incluir `cotizacion` en consultas financieras o de rentabilidad.
- Toda impresión de reportes debe pasar por `printHTML()` o `_openPrintWindow()`.
