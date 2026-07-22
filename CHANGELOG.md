# Historial de versiones

## 1.25.0 — 2026-07-22

### Nuevo

- Módulo **Preventa y Despacho** para preparar órdenes en una terminal, cobrarlas en caja y confirmar la entrega.
- Órdenes compartidas `OC-XXXXXX` con reserva temporal de inventario y sincronización multi-terminal.
- Colas separadas de Caja, Entrega, Todo activo e Historial.
- Búsqueda por orden, cliente, RNC/cédula, artículo y vendedor.
- Avisos visuales y sonoros para nuevas órdenes y mercancía lista para entregar.
- Activación del módulo, permisos por rol, tiempo de reserva y sonido configurables por Superadmin.
- Detalle completo y trazabilidad de terminales, usuarios y estados.

### Mejorado

- Búsqueda de clientes registrados al enviar órdenes a caja.
- Regreso automático a la cola después de cobrar una orden compartida.
- Disponibilidad del POS calculada descontando reservas activas.
- Numeración de tickets reutilizable: al cerrar todos vuelve correctamente a Factura #1.
- Campos de descuento porcentual y por monto permiten escritura continua sin perder el foco.

### Corregido

- El indicador de Preventa desaparece inmediatamente al cancelar, cobrar, entregar o vencer la última orden aplicable.
- Protección contra doble cobro y contra ventas directas que consuman inventario reservado.
- Cancelar una factura vinculada retira también su orden del flujo de entrega.

### Verificación

- 254 comprobaciones automatizadas aprobadas antes de preparar la publicación.
- Validación de empaquetado confirma todos los módulos del proceso principal incluidos en el instalador.
