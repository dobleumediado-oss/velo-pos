# Flujos y numeración documental

[← Visión general](overview.md) · Relacionados: [Impresión](printing-module.md) · [Clientes empresa](clientes-empresas.md)

## Principio

El `id` de SQLite es una llave técnica y nunca debe presentarse como el número
oficial de un documento nuevo. Las familias documentales usan correlativos
independientes:

| Documento | Prefijo | Cuándo se emite |
|---|---:|---|
| Factura al contado | `FAC-` | Al completar una factura no financiada |
| Factura a crédito | `FCR-` | Al completar una factura a crédito |
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
- Un número anulado o eliminado se marca, pero nunca se reutiliza.
- Los documentos importados conservan su número histórico.
- Las cotizaciones nuevas no mueven inventario, caja, crédito ni contabilidad.
- Eliminar una cotización la retira inmediatamente de la operación y conserva
  solo su correlativo y el evento de auditoría.

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
