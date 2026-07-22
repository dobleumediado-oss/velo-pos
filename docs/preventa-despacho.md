# Preventa y Despacho

[← Volver a CLAUDE.md](../CLAUDE.md) · Relacionados: [Visión general](overview.md) · [Release](release-process.md)

Módulo operativo para negocios con un área que prepara la orden y otra caja que cobra. Las terminales comparten la misma cola en tiempo real cuando trabajan conectadas al mismo servidor de Velo POS.

## Flujo operativo

1. Despacho prepara los artículos desde el Punto de Venta.
2. Selecciona un cliente registrado o usa Consumidor Final.
3. Pulsa **Enviar a caja**. Se crea una orden `OC-000001`, sin emitir factura ni NCF.
4. Caja recibe la orden en su cola, la abre y realiza el cobro normal.
5. El cobro crea la venta definitiva, emite el comprobante correspondiente y descuenta el inventario.
6. Despacho recibe el aviso de que está pagada y confirma la entrega al cliente.

Estados persistidos:

- `pending`: enviada a caja y pendiente de cobro.
- `paid`: cobrada y pendiente de entrega.
- `dispatched`: entregada al cliente.
- `cancelled`: cancelada antes del cobro.
- `expired`: no se cobró dentro del tiempo de reserva.

## Reserva de inventario

Enviar una orden a caja aparta temporalmente sus unidades. El stock físico todavía no se descuenta, pero otras ventas solo pueden utilizar la disponibilidad libre.

La reserva se convierte en salida real al cobrar. Se libera automáticamente si la orden se cancela o vence. Esto evita que dos terminales vendan simultáneamente las mismas unidades.

El Superadmin configura el tiempo entre 10 y 120 minutos en:

**Panel Dev → Módulos del sistema → Preventa y Despacho → Reserva de inventario**

## Pantalla de operación

La pantalla ofrece cuatro vistas:

- **Caja**: órdenes pendientes de cobro.
- **Entrega**: órdenes pagadas listas para entregar.
- **Todo activo**: ambas colas en una sola vista.
- **Historial**: entregadas, canceladas y vencidas, con la actividad más reciente primero.

La vista inicial es automática: una terminal con caja abierta entra en Caja; una terminal sin caja abierta entra en Entrega. El usuario puede cambiar de vista en cualquier momento.

Cada tarjeta muestra avance, tiempo esperando, cliente, RNC/cédula, vendedor, artículos, notas y total. La búsqueda admite número de orden, cliente, documento, artículo o vendedor e ignora tildes y guiones.

## Notificaciones

Una terminal de caja recibe un aviso al llegar una orden de otra terminal. Despacho recibe otro cuando caja la cobra. El sistema no reproduce el aviso en la misma terminal que originó la acción.

El sonido se puede activar o silenciar en:

**Panel Dev → Módulos del sistema → Preventa y Despacho → Avisos sonoros en tiempo real**

El indicador del menú cuenta todas las acciones pendientes: órdenes por cobrar más órdenes por entregar. Se actualiza por eventos multi-terminales y por una comprobación periódica de respaldo.

## Activación y permisos

El módulo se administra en **Panel Dev → Módulos del sistema** con las claves:

- `module_preventa`: activa o desactiva el módulo.
- `module_preventa_roles`: roles autorizados, inicialmente `admin,cajero`.
- `checkout_reservation_minutes`: duración de la reserva, inicialmente 30.
- `checkout_notifications_sound`: `1` para sonido y `0` para silencio.

Al desactivarlo desaparecen el menú y el botón Enviar a caja. El backend también rechaza las operaciones, por lo que ocultar la interfaz no es la única barrera de acceso. Superadmin conserva acceso mientras el módulo esté activo.

## Garantías de integridad

- Crear una orden no genera venta, pago ni NCF.
- Los precios y artículos quedan bloqueados al llegar a caja.
- El cobro es atómico y no puede ejecutarse dos veces.
- El inventario se descuenta exactamente una vez, al cobrar.
- No se permite entregar una orden que no esté pagada.
- Cancelación y vencimiento liberan la reserva.
- Se conservan terminal de origen, terminal de cobro, usuarios, fechas y motivo de cancelación.

## Archivos principales

- `src/main/checkout-orders-repo.js`: esquema, reservas y transiciones.
- `main.js`: autorización e IPC `checkout:*`.
- `preload.js`: API segura para el renderer.
- `src/js/preventa.js`: colas, búsqueda, avisos e historial.
- `src/js/pos.js`: envío a caja y cobro de la orden bloqueada.
- `src/js/superadmin.js`: activación, roles, reserva y sonido.
- `src/main/sync-events.js`: sincronización entre terminales.
- `scripts/test-checkout-orders.js`: invariantes de inventario y cobro.
- `scripts/test-pos-interactions.js`: interacciones y filtros de la interfaz.
