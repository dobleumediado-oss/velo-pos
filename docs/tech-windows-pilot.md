# Piloto real de VELO TECH POS en Windows

Esta prueba se ejecuta en una PC limpia antes de publicar. Las pruebas automáticas verifican la lógica; este piloto valida hardware, instalación y operación real.

## Preparación

- Windows 10/11 actualizado, usuario estándar y sin Node.js instalado.
- Instaladores de **Velo Tech POS** y **Velo Tech POS Server** generados por el mismo tag.
- Impresora térmica y A4, lector de código de barras, teléfono con datos móviles y unidad USB externa.
- Copia de una base de prueba; nunca usar primero la base del cliente.

## Criterios obligatorios

1. Instalar Terminal y Server; confirmar nombre, icono y accesos directos TECH.
2. Reiniciar Windows y comprobar que el servicio Server levanta sin abrir una ventana.
3. Conectar la Terminal al Server, cerrar y abrir la app y comprobar la misma sucursal/base.
4. Recibir una compra de dos equipos escaneando sus IMEI; rechazar un IMEI duplicado sin recibir parcialmente la orden.
5. Abrir caja, vender un equipo serializado, imprimir y comprobar que el IMEI vendido no reaparece disponible.
6. Recibir una reparación con fotografías y firma; crear cita, medir tiempo, aprobar presupuesto, reservar pieza, pasar control de calidad y entregar.
7. Crear una pieza agotada desde la reparación, generar la orden de compra y confirmar que la recepción libera el trabajo pendiente.
8. Probar venta a crédito con pago inicial efectivo, transferencia y mixto; registrar un abono y verificar saldos de factura, cliente y caja.
9. Enviar un aviso de prueba por WhatsApp Cloud; confirmar en el historial que “aceptado” no se muestra como “entregado” hasta tener confirmación del proveedor.
10. Crear respaldo cifrado en USB, retirar y reconectar la unidad, y ejecutar **Probar una copia** con la clave correcta y con una clave incorrecta.
11. Desde un teléfono con datos móviles, abrir el portal, aprobar/rechazar presupuesto y consultar el documento entregado.
12. Desconectar Internet: la Terminal debe informar que el Server no está disponible y no crear ventas locales divergentes. Reconectar y comprobar recuperación.
13. Comparar libros de ventas/compras, NCF, ITBIS y retenciones contra un período de control validado por el contador.
14. Instalar una versión anterior de prueba y actualizar por el canal `latest-tech`; Server debe usar exclusivamente `server-tech`.

## Evidencia de aprobación

Guardar versión, fecha, nombre del probador, PC, impresoras, lector, capturas, resultados y cualquier excepción. No publicar si falla un criterio obligatorio.
