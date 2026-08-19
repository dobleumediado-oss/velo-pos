# VELO TECH POS · Taller y reparaciones

## Alcance

El taller profesional cubre el ciclo completo de un equipo tecnológico sin
duplicar caja, fiscalidad, inventario ni contabilidad:

`recepción → inspección → diagnóstico → presupuesto → aprobación → reserva de
piezas → reparación → control de calidad → entrega facturada → garantía`.

Admite celulares, tablets, laptops, PC, televisores, consolas,
electrodomésticos, instalaciones y visitas técnicas. Un equipo vendido por la
tienda puede enlazarse a `product_units`; un equipo externo conserva sus
identificadores directamente en la orden.

## Controles operativos

- La recepción conserva condición física, accesorios, pruebas iniciales,
  prioridad, fecha prometida y consentimiento.
- El IMEI/serial enlazado cambia a `servicio` mientras la orden está abierta y
  al cerrar la orden recupera su estado anterior (`vendido`, `en_stock`,
  `reservado` o `devuelto`).
- Cada presupuesto genera una versión inmutable. Un presupuesto enviado o
  aprobado no puede modificarse sin reabrirlo y crear otra versión.
- Al aprobar, las piezas fungibles se reservan. POS y Preventa descuentan esas
  reservas de la disponibilidad; el stock físico se consume una sola vez al
  facturar la entrega.
- El equipo no puede quedar `listo` sin un control de calidad completamente
  aprobado.
- La entrega genera una venta normal y reutiliza factura, NCF, caja, COGS y
  contabilidad.
- La garantía pertenece a la reparación y permite crear un reingreso enlazado
  a la orden original.

## Datos y trazabilidad

- `service_orders`: cabecera, equipo, recepción, flujo, aprobación, QC y
  garantía.
- `service_order_items`: piezas/mano de obra y ciclo de reserva/consumo.
- `service_order_events`: cronología operacional.
- `service_order_estimates`: versiones y evidencia de la decisión del cliente.
- `service_technicians`: técnicos, especialidad y comisión de referencia.

La interfaz permite imprimir el documento de servicio, compartir el estado por
WhatsApp y consultar indicadores de abiertas, atrasadas, entregadas, tiempo
promedio, reingresos y carga por técnico. El portal público sin nube, sus
enlaces/QR, aprobaciones y documentos de garantía se explican en
[Portal de clientes](velo-tech-portal-clientes.md).

## Seguridad y privacidad

VELO registra el consentimiento, pero no almacena PIN, patrón ni contraseña del
cliente en la orden. El cliente debe desbloquear el equipo cuando sea necesario.
Los permisos del módulo se controlan con `module_service_roles`; administración
y superadministración gestionan el catálogo de técnicos.

## Pruebas

`npm run test:service-orders` valida recepción, vínculo IMEI, transiciones,
presupuesto versionado, bloqueo posterior, reserva de piezas, protección frente
a venta concurrente, control de calidad, entrega idempotente, contabilidad,
garantía, cancelación, indicadores y los dos flujos visuales que estaban rotos.
`npm run test:service-portal` valida el recorrido público completo y su
privacidad.
