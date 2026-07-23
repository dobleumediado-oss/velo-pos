# Historial de versiones

## 1.27.0 — 2026-07-23

### Corregido

- Las cantidades del POS aceptan varios dígitos sin perder el foco.
- Las cotizaciones se eliminan realmente y ya no pasan por la anulación de facturas.
- Crear una cotización no mueve inventario, caja, crédito, cuentas financieras ni contabilidad.
- Los reportes financieros excluyen cotizaciones.
- Convertir una cotización genera la factura y elimina correctamente el documento de origen.
- Facturar un conduce genera también el asiento contable de la factura.
- Los reportes de abonos muestran el correlativo documental y no el ID técnico.
- El reinicio total y la migración integral reinician correctamente los correlativos
  internos sin mezclar documentos de dos negocios.
- La interfaz usa “Cotizar/Crear cotización” en vez de “Cobrar” cuando corresponde.

### Nuevo

- **Velo POS Server Service** para Windows: mantiene datos y terminales disponibles
  aunque la interfaz de la PC servidor esté cerrada.
- Supervisor con un worker SQLite aislado por negocio, gateway único en el puerto
  8443 y recuperación automática ante fallos.
- Dos instaladores independientes: Servidor y Terminal, con canales de actualización
  separados para impedir que una edición reemplace accidentalmente a la otra.
- Migración segura al instalar Servidor: respaldo previo, copia sin borrar el origen
  y conservación de datos/backups al desinstalar.
- Negocio seleccionado por terminal; cambiarlo ya no reinicia ni modifica el servidor
  o las demás cajas.
- Asignación de cada terminal a todos los negocios o a un negocio específico.
- Prueba automatizada del gateway, autenticación, aislamiento y routing multi-negocio.
- Secuencias independientes para facturas al contado, facturas a crédito, cotizaciones,
  notas de crédito, abonos, recibos, pagos a proveedores, conduces y reportes.
- Números documentales anulados o eliminados no se reutilizan.
- PDF por WhatsApp desde facturas, cotizaciones y conduces, reutilizando la plantilla de impresión.
- Pruebas de regresión específicas para numeración, cotizaciones no financieras,
  eliminación, cantidades y exclusión de reportes.

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
