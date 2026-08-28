# VELO TECH POS · Ciclo de equipos usados y recepción técnica

## Alcance implementado

Esta función pertenece exclusivamente al vertical **VELO TECH POS**. Las tablas
y columnas nuevas son aditivas; los productos no serializados de VELO POS
continúan usando el stock numérico tradicional.

### Recepción de servicio técnico

- La recepción registra salud de batería en porcentaje, capacidad en mAh y los
  datos físicos ya existentes.
- La garantía del trabajo se propone desde una configuración administrativa y
  queda guardada en cada orden.
- El recibo de recepción y la etiqueta del equipo son trabajos separados. La
  etiqueta usa el canal de impresoras de etiquetas y formato de 62 × 40 mm.
- El recibo documenta cliente, equipo, identificador, batería, problema,
  condición, accesorios, alcance de garantía, firmas y QR privado.

### Compra de un equipo a una persona

La pestaña **Compras → Equipos comprados a personas** registra en una sola
operación:

- identidad, documento, teléfono, dirección y correo del vendedor;
- modelo, IMEI/serial, color, almacenamiento, batería, condición y pruebas;
- precio y pago por efectivo, transferencia o cheque;
- declaraciones de propiedad y procedencia lícita;
- nombres de quien vende y quien representa al negocio;
- una copia inmutable de los términos vigentes al firmar.

Al confirmar, VELO crea una unidad usada en inventario. El efectivo exige caja
abierta y forma parte del cuadre; transferencia y cheque quedan ligados a la
cuenta bancaria elegida. Si Contabilidad está activa, se registra débito a
Inventario y crédito a Caja o Banco.

El contrato se imprime como una hoja A4 completa: reúne datos del vendedor,
identificación y evaluación del equipo, pago, términos y declaraciones, y deja
espacios amplios al pie para las firmas de ambas partes.

### Inventario y factura posterior

- Cada equipo serializado puede conservar salud y capacidad de batería.
- Las descripciones comerciales reutilizables se administran desde Inventario.
- La descripción elegida pertenece a la unidad por IMEI/serial y se incorpora a
  la línea congelada de la factura cuando esa unidad se vende.

## Controles de integridad

- Un IMEI/serial duplicado cancela toda la operación.
- Una compra en efectivo sin caja abierta no crea contrato, salida ni unidad.
- Los términos de un contrato existente no cambian al editar la plantilla.
- La ruta está bloqueada fuera de VELO TECH POS y respeta permisos de Compras e
  Inventario.
- Las pruebas se ejecutan sobre bases temporales con `npm run
  test:tech-lifecycle`.

## Operación profesional del taller

El módulo **Servicio técnico** incorpora además estas diez capacidades:

1. Recepción de una persona ocasional sin crearla en el directorio de clientes,
   conservando nombre, documento, teléfono, dirección y correo en la orden.
2. Documento de recepción A4 con estado físico, accesorios, pruebas,
   autorizaciones, firma manuscrita, evidencias y QR privado.
3. Plantillas de pruebas según la falla: señal, carga, pantalla, batería, audio,
   cámaras, conectividad, líquido o equipo que no enciende.
4. Anticipos trazables, recibo independiente, devolución controlada y aplicación
   automática al restante de la factura final.
5. Consentimientos obligatorios para diagnóstico, manejo de datos y condición
   de entrada, congelados en el documento con sus casillas marcadas.
6. Garantía individual por pieza o mano de obra y reingreso enlazado a la línea
   cubierta.
7. Seguimiento de equipos listos no retirados: fecha límite, días de gracia,
   cargo diario configurable, avisos y marca de no reclamado sujeta a revisión
   legal.
8. Identificación de la persona que retira, relación con el titular,
   autorización, notas y firma de entrega.
9. Historial unificado por IMEI o serial con compras, inventario, ventas,
   trade-ins y reparaciones.
10. Indicadores de ingresos, piezas, mano de obra, beneficio bruto, margen,
    anticipos, tiempos de ciclo y equipos pendientes de retiro.

La entrega conserva el total fiscal de la reparación, separa el anticipo ya
pagado del monto cobrado al final y cancela la cuenta contable de anticipos. El
portal del cliente refleja presupuesto, avances, garantía por partida y estado
de retiro sin exponer IMEI o serial completos.

## Siguientes mejoras recomendadas

1. Adjuntar fotografías de cédula, equipo encendido, IMEI visible y condición
   física con sello de fecha y huella del archivo.
2. Añadir una lista de cuarentena configurable antes de habilitar la reventa de
   un usado adquirido a un particular.
3. Integrar una consulta externa de bloqueo/denuncia de IMEI cuando exista un
   proveedor autorizado; nunca afirmar que está limpio sin una fuente real.
4. Incorporar firma manuscrita en pantalla como evidencia adicional, manteniendo
   la versión imprimible.
5. Registrar quién realizó cada prueba de batería, cámaras, biometría, carga,
   red y bloqueo de cuenta.
6. Someter los términos predeterminados a revisión legal local antes de usarlos
   como contrato definitivo.
