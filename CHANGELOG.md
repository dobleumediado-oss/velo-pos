# Historial de versiones

## 1.26.1 — 2026-07-22

### Nuevo

- Clientes de tipo **Persona** o **Empresa**, conservando como personas todos los registros existentes.
- Representantes empresariales con cargo, documento, teléfono, correo, contacto principal y permisos operativos.
- Búsqueda de empresas por razón social, nombre comercial, RNC o representante.
- Precio preferido de detalle/mayorista y correo de facturación por empresa.
- Importación opcional de empresas con representante principal.
- Selector permanente de cliente en el POS antes de agregar artículos, con búsqueda por empresa, persona o representante.

### Integrado

- POS, cotizaciones, Preventa y Despacho, facturas, crédito, conduces y envíos mantienen la empresa y su representante.
- Las cuentas por cobrar y los abonos permanecen consolidados en la empresa.
- El precio preferido cambia automáticamente el catálogo y recalcula las líneas no modificadas del carrito; los precios autorizados manualmente se respetan.
- Plantillas térmicas, carta, media carta, NCF, conduce, reimpresión y PDF muestran `Solicitado por` cuando corresponde.
- Abonos y recibos guardan y muestran `Pagado por`; estados de cuenta y facturas pendientes identifican al representante de cada operación.
- Ventas, conduces, envíos y búsqueda global encuentran operaciones por representante.
- Clientes separa Personas y Empresas; cada empresa ofrece un panel de representantes con facturas, cotizaciones, crédito pendiente y abonos atribuidos.

### Seguridad e historial

- Empresa y representante se validan nuevamente en el proceso principal; no se confía en texto enviado por la interfaz.
- Snapshots documentales conservan razón social, dirección, contacto y representante aunque se editen o desactiven después.
- Los abonos conservan su propio snapshot del representante, independiente de cambios posteriores en el contacto.
- Solo flujos internos verificados pueden reutilizar snapshots históricos.
- Reinicio total, importación y rollback incluyen correctamente la nueva tabla de representantes y los conduces relacionados.

### Verificación

- Pruebas específicas cubren empresa, representante, documento único, selector y precios del POS, preventa, crédito, abonos, conduce, envío y persistencia histórica.
- 284 comprobaciones automatizadas aprobadas; migraciones y estructura del instalador verificadas para Velo POS 1.26.1.

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
