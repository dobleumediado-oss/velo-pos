# Corrección controlada de facturas emitidas

## Alcance implementado

El módulo reemplaza el cambio destructivo de `sales.created_at` por un flujo
transaccional. Una factura conserva su identidad fiscal, sus importes, sus
artículos y las fechas reales de los movimientos relacionados.

### Fuentes de fecha

- `sales.created_at`: creación técnica real. Un trigger impide modificarla.
- `sales.original_sale_date`: fecha comercial al emitir/importar. Inmutable.
- `sales.sale_date`: fecha operativa usada por Ventas, dashboard, reportes
  comerciales, rentabilidad, cliente y comisiones.
- `sales.fiscal_issued_at`: emisión fiscal. Inmutable después de establecerse.
- `payments.created_at`: fecha real de cobro; nunca se refecha con la factura.
- `cash_movements.created_at`: fecha real de caja; nunca se refecha.
- `accounting_entries.date`: fecha de contabilización; un cambio comercial no
  modifica asientos confirmados.
- `inventory_movements.created_at`: movimiento físico real.
- `inventory_movements.operational_sale_date`: referencia comercial que sigue a
  `sales.sale_date`.
- `ncf_log.issued_at` / `ecf_log.emitido_at`: fuente de reportes fiscales.

## Esquema y migración

La migración `1.30.0-sale-corrections` es idempotente y se apoya en
`ensureSaleCorrectionsSchema()`. Antes de agregar la separación de fechas,
`initDB()` crea una copia `backups/velo_pre_sale_corrections_*.db`. Si no puede
crear el respaldo, la migración se detiene.

Tablas nuevas:

- `sale_corrections`: snapshot JSON anterior/posterior, módulos afectados,
  metadatos, solicitante, autorizador e idempotencia.
- `sale_correction_documents`: relación inmutable entre una corrección y las
  notas de crédito/facturas complementarias que produjo.
- `sale_date_history`: historial específico de fechas.
- `sale_correction_role_permissions`: permisos separados por rol.
- `commission_adjustments`: ajustes pendientes cuando una comisión ya estaba
  aprobada o pagada.

Triggers impiden actualizar o borrar los historiales y cambiar `created_at`,
`original_sale_date` o `fiscal_issued_at` una vez establecidos.

El backfill utiliza la fecha histórica de `created_at` para
`original_sale_date`/`sale_date`. Para documentos con NCF/e-CF,
`fiscal_issued_at` se obtiene primero del log fiscal y solo usa `created_at`
como compatibilidad para registros antiguos sin log.

## Flujo de cambio de fecha

`saleCorrectionsRepo.changeDate()` ejecuta en una sola transacción:

1. valida usuario y permisos;
2. valida formato, calendario y política de fechas futuras;
3. comprueba estado y revisión optimista;
4. evalúa caja cerrada, período cerrado, e-CF, pagos, devoluciones,
   conciliación, contabilidad y comisiones;
5. actualiza solo `sales.sale_date` y la referencia operativa de inventario;
6. recalcula cortes de comisión en borrador o crea un ajuste para cortes
   aprobados/pagados;
7. inserta snapshots en `sale_corrections` y `sale_date_history`;
8. inserta el evento en `audit_logs`;
9. confirma todo o revierte todo.

La clave `idempotency_key` evita doble aplicación. `sales.revision` implementa
control de concurrencia optimista.

## Permisos

- Cajero: `sales.view`, `sales.request_return`.
- Admin: corrección, fecha, datos internos, devolución/nota de crédito,
  anulación, reembolso, override de caja cerrada y auditoría.
- Superadmin: todos los permisos, incluido override de período contable.

Los permisos viven en datos y los handlers los consultan; no dependen de ocultar
botones en el renderer.

## Interfaz e impresión

El detalle de factura muestra fecha original, operativa y fiscal. El botón
**Corregir / ajustar factura** abre acciones habilitadas/bloqueadas según estado
y permisos. El modal de fecha presenta impacto por módulo y advertencias reales.

Después de confirmar una corrección, Velo no imprime silenciosamente:

- mantiene una sola factura visible con el distintivo **Ajustada**;
- ofrece **Reimprimir factura ajustada** como acción principal;
- consolida productos, cantidades, ITBIS y total vigentes;
- identifica la salida como copia consolidada y aclara que no sustituye los
  comprobantes fiscales relacionados.

La factura original permanece en **Ventas** con el distintivo **Ajustada** o
**Devuelta total**. La lista y sus métricas muestran el total neto de la
operación. Las notas de crédito continúan en **Devoluciones** y los documentos
internos de aumento permanecen enlazados en auditoría, pero no ocupan otra fila
en Ventas.

La reimpresión ajustada usa `original_sale_date`, conserva la referencia y el
NCF original, e imprime los artículos vigentes. Todas las plantillas muestran
**FACTURA AJUSTADA**, los documentos relacionados y el aviso de que no sustituye
los comprobantes fiscales emitidos.

Los cambios de productos/cantidades y las notas de crédito usan el flujo
compensatorio. El usuario trabaja desde un solo asistente:

- reducir una cantidad o llevarla a cero crea una devolución/nota de crédito;
- aumentar una línea conserva su precio histórico y crea una factura
  complementaria por la diferencia;
- agregar otro producto usa el precio actual autorizado y crea una factura
  complementaria;
- una corrección mixta crea ambos documentos dentro de una única transacción;
- el resumen previo muestra crédito, cargo y diferencia neta;
- inventario, caja/CxC, contabilidad, NCF e historial se enlazan a los documentos
  generados sin alterar la factura original.

Los descuentos posteriores, bonificaciones y errores exclusivamente monetarios
usan un flujo separado:

- el usuario indica el importe final de la nota de crédito y un motivo;
- se calcula el ITBIS proporcional al documento original;
- se emite una nota de crédito vinculada, B04 cuando corresponde;
- se registra el reembolso o la reducción de CxC según el pago original;
- no se crea ninguna entrada ni salida de inventario;
- el sistema limita el crédito al total original menos notas vigentes anteriores.

La factura complementaria recibe su propio número y, cuando corresponde, su
propio NCF autorizado. En e-CF no se simula una nota de débito electrónica: el
original permanece intacto y el aumento se documenta como factura relacionada
hasta disponer de un emisor e33 certificado.

Operaciones que requerirían sobrescribir pagos o emitir un documento fiscal no
soportado permanecen bloqueadas con una explicación explícita.

## Pruebas

`npm run test:sale-corrections` cubre 74 aserciones de integración:

- facturas pagadas y a crédito;
- mismo mes, otro mes/año, fecha anterior y futura;
- caja/período abierto o cerrado;
- e-CF aceptado y NCF inmutable;
- comisión pagada;
- idempotencia y concurrencia;
- datos administrativos;
- devolución parcial/total y B04;
- reportes comerciales/fiscales;
- inventario, pagos, contabilidad y auditoría inmutable.
- reducción, eliminación, aumento, adición y corrección mixta de productos;
- idempotencia documental, precio histórico y compensación bidireccional de
  inventario.
- reversión completa cuando falla cualquier parte de una corrección mixta.
- nota de crédito monetaria, ITBIS proporcional, límite acreditable,
  idempotencia, CxC, anulación y ausencia total de movimientos de inventario.
- agrupación visual con números documentales reales y total neto de la operación.
- operación única en Ventas y cantidades vigentes para la reimpresión ajustada.

`npm run test:financial` cubre además 128 aserciones, incluidas las ocho
plantillas de impresión de la factura ajustada.
