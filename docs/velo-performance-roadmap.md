# Roadmap de velocidad y estabilidad de Velo Suite

## Objetivo

Mantener Velo rápido sin alterar saldos, documentos históricos ni funciones que ya están correctas. Cada mejora de rendimiento debe ser medible, reversible y cubierta por pruebas.

## Reglas que no se negocian

- Ninguna optimización visual puede escribir o recalcular datos reales.
- Los saldos históricos importados conservan su saldo de origen; los abonos de Velo se aplican después y con trazabilidad.
- Un recibo de abono nunca se presenta como factura ni usa conceptos de venta, impuestos o artículos.
- Facturas e historial de abonos se muestran de antiguo a reciente, con fecha e identificador como desempate.
- No se elimina una ruta anterior hasta que la nueva pase pruebas funcionales, financieras y de documentos.
- Las pruebas automatizadas usan bases temporales; nunca la base de producción.

## Presupuesto de experiencia

| Acción | Meta local | Límite aceptable en red |
|---|---:|---:|
| Abrir buscador global | menos de 100 ms | menos de 150 ms |
| Mostrar estructura de un modal | menos de 100 ms | menos de 150 ms |
| Estado de cuenta listo | menos de 500 ms | menos de 1.5 s |
| Resultados de búsqueda | menos de 300 ms | menos de 800 ms |
| Cambio entre pestañas ya cargadas | menos de 100 ms | menos de 150 ms |

Si una operación supera el límite, se registra qué consulta o render fue lento; no se oculta el problema con animaciones largas.

## Fases

### Fase 1 — Rutas rápidas y seguras

- Mantener consultas específicas para cada pantalla; evitar cargar artículos y cálculos que la vista no usa.
- Reutilizar durante unos segundos el estado de cuenta al cambiar de pestaña.
- Abrir primero el buscador y completar accesos recientes en el siguiente cuadro visual.
- Mantener “Atrás” mediante el estado real del modal anterior, sin reconstruir formularios.

### Fase 2 — Medición por módulo

- Medir apertura, primera respuesta y render de Clientes, Ventas, Inventario, CRM, Caja y Compras.
- Marcar consultas sin límite, recorridos repetidos y tareas que bloquean la interfaz.
- Revisar índices con planes de consulta sobre una copia de datos representativa.
- Establecer paginación para historiales grandes y render progresivo para listas extensas.

### Fase 3 — Trabajo en segundo plano

- Mover reportes, preparación de PDF y cálculos extensos fuera del hilo visual cuando superen el presupuesto.
- Actualizar cachés después de confirmar una operación, sin retrasar el comprobante principal.
- Cancelar búsquedas anteriores cuando el usuario continúa escribiendo.
- Mantener reintentos explícitos ante desconexión, sin duplicar pagos ni ventas.

### Fase 4 — Prevención continua

- Ejecutar pruebas financieras, documentos, búsqueda, servidor y experiencia antes de entregar cambios.
- Añadir una prueba de regresión por cada error confirmado.
- Comparar tiempos con la línea base y rechazar cambios que degraden una acción crítica más de 20 %.
- Hacer una revisión mensual de las cinco acciones más lentas registradas.

## Protocolo para cada cambio

1. Describir el problema y su resultado esperado.
2. Medir el comportamiento actual con datos temporales o una copia autorizada.
3. Cambiar la ruta mínima necesaria, sin mezclar correcciones ajenas.
4. Probar matemáticas, documentos, orden, navegación y desconexión.
5. Verificar que no se abrió ni modificó la base real durante las pruebas.
6. Registrar el resultado y una forma clara de revertirlo.

## Criterios de aceptación de esta ronda

- El buscador aparece de inmediato y busca inventario, ventas, clientes e historial.
- El estado de cuenta no muestra el reloj de preparación ni usa la consulta pesada de Ventas.
- Los modales secundarios ofrecen “Atrás” y restauran la pantalla anterior.
- El recibo de abono dice “Monto aplicado”, “Monto del abono” y “Balance después del abono”; no “Precio venta” ni “Total con impuestos”.
- Facturas pendientes, facturas del cliente e historial de abonos aparecen de antiguo a reciente en pantalla y PDF.

## Ronda documental del POS — 26 de agosto de 2026

### Problema y resultado esperado

- “Agregar envío u otro cargo” sumaba en factura como un total separado y no estaba disponible en cotización. Debe crear un renglón de servicio visible, sumable e imprimible en ambos documentos, sin afectar inventario.
- El carrito tenía ancho fijo. Debe poder ajustarse entre un tamaño compacto y uno amplio, y recordar la preferencia al reiniciar la aplicación.
- Generar conduce estaba oculto dentro del cobro de una factura. El POS debe permitir preparar un conduce directamente como documento no fiscal, guardarlo en el módulo Conduces y no mover inventario, caja, impuestos ni contabilidad.
- La anulación existía únicamente dentro del detalle del conduce. Administrador y superadministrador deben verla también en el listado, con motivo obligatorio y auditoría.

### Ruta mínima aplicada

- El cargo nuevo se representa con una línea `service`/`non_stock` en el carrito y reutiliza la ruta transaccional existente de ventas y cotizaciones. Los cargos históricos conservan su lectura anterior.
- El ancho del panel se conserva como preferencia local de interfaz; no se escribe en SQLite ni se modifica información comercial.
- El botón Conduce reutiliza `conduce:create`, su secuencia `CON-`, sus validaciones de cliente y su tabla de artículos. No reutiliza `sales:create`.
- Anular desde el listado reutiliza `conduce:cancel`; no elimina el registro ni libera el correlativo.

### Verificación y reversión

- Verificado: interacción del POS; matemática y persistencia de artículos de servicio en factura, cotización y cola de caja; devolución de servicios sin inventario; creación/anulación de conduce; núcleo financiero; correcciones de venta; seguridad de actualización; integridad SQLite y sintaxis.
- Todas las pruebas usan una base temporal. La preferencia de ancho se prueba como almacenamiento local y nunca abre la base real.
- La prueba de actualización comparó la base real antes y después usando una copia temporal: ventas, facturación, clientes, productos, existencias y débitos/créditos permanecieron idénticos; `integrity_check` quedó en `ok` y no hubo violaciones de claves foráneas.
- Reversión: retirar el selector Conduce y el divisor visual no cambia documentos guardados; las líneas de servicio ya emitidas siguen siendo `sale_items` válidos y los conduces anulados conservan su trazabilidad.
