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

El contrato se imprime en dos páginas: compraventa/equipo y
términos/declaraciones. Ambas contienen espacios para las dos firmas.

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
