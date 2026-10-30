# Correcciones POS Desktop y Web — 30 de octubre de 2026

## Alcance autorizado

1. Investigar rechazo de copia final al recibir perfil de terminales; conservar validación de origen y captura posterior al bloqueo.
2. Corregir temporales de impresión que fallan con EPERM en Windows.
3. Diferenciar arqueo pendiente de efectivo contado cero; revisar discrepancia entre resumen y ventas de sesión.
4. Revisar cuadre e historial sin reescribir cierres históricos automáticamente.
5. Filtrar reportes de comprobantes por tipo, con el mismo filtro en vista, impresión y exportación.
6. Restaurar cliente completo y comprobante predeterminado en cobros; flujo confirmado: repetir venta del historial.
7. Mejorar órdenes de compra; alcance confirmado: preparar y enviar documento al proveedor; no ampliar recepción.
8. Respetar selección de impresora y compatibilidad de papel al cobrar y reimprimir.

## Evidencia inicial

- main.js usa os.tmpdir() en los temporales HTML de impresión y PDF.
- caja.js llama calcCloseTotal al abrir el arqueo con todas las cantidades en cero y permite confirmar ese cero sin declarar conteo realizado.
- La captura del arqueo muestra movimiento neto RD$46,800 mientras la vista de sesión de fondo muestra cero ventas: requiere reproducción con terminal y negocio explícitos.
- El traslado exige copia final posterior al bloqueo; no se debe suprimir esta condición para resolver el aviso.

## Ejecución por fases

Primero traslado, temporales y caja; después reportes, cobros, compras y rutas de impresión. Cada cambio requiere las pruebas del módulo y la compuerta test:tech-readiness indicada en AGENTS.md. La versión Web se revisará en su repositorio con pruebas equivalentes. Publicación pendiente de completar y verificar los cambios.

## Avance de implementación

- Desktop: temporales HTML de impresión/PDF trasladados a userData/print-temp.
- Desktop: arqueo exige confirmación del conteo y reinicia la confirmación al editar billetes; navegación a Caja invalida caché de sesión.
- Desktop: reventa recupera nombre, documento y teléfono actuales del cliente y ya no fuerza comprobante vacío.
- Desktop: selector por tipo de NCF filtra vista, impresión y Excel; cambiar filtros invalida documento anterior.
- Desktop: salida explícita vacía respeta diálogo; formato incompatible abre selección en vez de enviar silenciosamente a la impresora equivocada.
- Desktop: documento imprimible de orden de compra disponible en su detalle.
- Traslado: el dueño confirmó que la copia se creó sin haber bloqueado el Server anterior. El rechazo corresponde a la protección de copia final, no a corrupción. Se aclaró el mensaje conservando todas las validaciones de origen y fecha.
- Desktop: vista previa incluye selector de impresora puntual; también los reportes conservan esa selección. Un cambio puntual no hereda el perfil de la térmica anterior. Se agregó prueba ejecutable a test:printing.
- Desktop: se descartan respuestas antiguas de consultas de caja tras invalidar/refrescar la misma sesión. Regresión comprobada en test:cash-ui.
- Web (repositorio cloud): orden de compra con vista previa A4 y salida por el servicio compartido printHTML; incluye proveedor, cantidades, costos originales y notas. No altera existencias ni registra pagos. Dos pruebas del documento y typecheck de Web aprobados.
- Web: el arqueo ya exige declarar un importe; no reproduce el cero inicial automático del Desktop. El historial no ofrece actualmente el mismo carrito de reventa del Desktop. El reporte 607/608 de Web es una descarga fiscal TXT distinta del reporte de gestión Desktop: queda pendiente diseñar su vista filtrable sin alterar la descarga fiscal completa.
- Pendiente: prueba visual de nuevos controles, validación física de impresión Windows, completar equivalencias Web de reportes/rutas. No se afirma que todos los ocho puntos estén terminados.
- La compuerta completa pasó también después de la protección contra consultas antiguas de caja. La aclaración del mensaje de traslado se verifica con su suite. No se ha publicado.
