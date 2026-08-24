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
