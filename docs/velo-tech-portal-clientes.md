# VELO TECH POS · Portal de clientes sin servidor en la nube

## Resultado

El cliente puede abrir desde su teléfono un enlace HTTPS para consultar una
reparación. La base de datos no se mueve: permanece en la PC servidor de la
tienda. Tailscale Funnel lleva únicamente las solicitudes del portal al puerto
local `8787`; el RPC de VELO, la administración y SQLite no se publican.

```text
Cliente (navegador)
        │ enlace HTTPS secreto
        ▼
Tailscale Funnel
        │ solo 127.0.0.1:8787
        ▼
Portal VELO ── worker del negocio ── velo.db local
```

El cliente no necesita instalar Tailscale. El portal está pensado para la PC
servidor que permanece encendida, conectada a Internet y protegida por UPS.

## Funciones entregadas por fase

### Fase 1 · Consulta de reparación

- Estado actual y cronología de recepción a entrega.
- Equipo, diagnóstico, fecha prometida, presupuesto y garantía.
- Diseño adaptable a celular y sin dependencias externas.
- Vista pública sanitizada: oculta teléfono, dirección, notas internas, costos,
  PIN y el IMEI/serial completo.

### Fase 2 · Enlace y QR

- Token aleatorio firmado; la URL no contiene el número secuencial de orden.
- QR incluido en el documento de recepción y disponible en la orden.
- Vigencia configurable, conteo de consultas, regeneración y revocación
  inmediata. Regenerar invalida el enlace anterior.

### Fase 3 · WhatsApp asistido

- Mensaje de presupuesto, aviso de equipo listo y documento de entrega.
- VELO abre WhatsApp con el teléfono y el texto preparados.
- Se registra como `prepared`: VELO no afirma que el cliente lo recibió porque
  WhatsApp no entrega esa confirmación sin su API empresarial.

### Fase 4 · Aprobación segura

- Código independiente de seis dígitos con vigencia de siete días.
- Nombre de quien responde y consentimiento explícito.
- El código se almacena como HMAC, no en texto legible.
- Cinco intentos fallidos bloquean nuevas pruebas durante quince minutos.
- Aprobación o rechazo reutiliza el flujo normal de presupuestos, reserva de
  piezas y bitácora inmutable; también conserva IP y navegador como evidencia.

### Fase 5 · Avisos y continuidad

- Cola auditable para presupuesto, equipo listo y entrega.
- `http://127.0.0.1:8787/health` comprueba el portal sin exponer datos.
- La pantalla **Servicio → Portal clientes** muestra si el portal local responde
  y permite volver a comprobarlo.
- Windows mantiene `VeloTechPOSServer` con inicio automático y reintentos. La UPS
  protege apagones breves; Windows debe configurarse sin suspensión.

### Fase 6 · Entrega y garantía

- Documento imprimible de entrega y garantía disponible tras entregar.
- Incluye trabajos, piezas, fecha, vencimiento y condiciones de garantía.
- El navegador del cliente permite imprimir o guardar el documento como PDF.
- Reingresos por garantía siguen enlazados a la reparación original dentro de
  VELO TECH POS.

## Activación en la PC servidor Windows

1. Instalar e iniciar sesión en Tailscale.
2. Instalar la edición **Velo Tech POS Server** y confirmar que
   **Velo Tech POS Server Service** está “En ejecución” en
   `services.msc`.
3. Abrir PowerShell y ejecutar el asistente incluido con la edición Servidor:

   ```powershell
   & "C:\Program Files\Velo Tech POS Server\resources\service\configure-tailscale-funnel.ps1"
   ```

   Si la ruta de instalación es distinta, localizar el archivo
   `configure-tailscale-funnel.ps1` dentro de `resources\service`.
4. Copiar la dirección `https://...ts.net` que muestra Tailscale.
5. En VELO TECH POS abrir **Servicio → Portal clientes**, pegar la dirección y
   guardar.
6. Crear una orden de prueba, pulsar **Portal / QR**, abrir el enlace usando los
   datos móviles del teléfono y comprobarlo de principio a fin.

El comando equivalente es:

```powershell
tailscale funnel --bg 8787
```

Tailscale puede pedir al administrador de la tailnet que habilite Funnel la
primera vez. Documentación oficial:
[Tailscale Funnel](https://tailscale.com/docs/features/tailscale-funnel).

## Operación diaria

1. Se recibe el equipo y VELO crea el enlace secreto automáticamente.
2. Se imprime la recepción con QR o se comparte el enlace por WhatsApp.
3. Al enviar presupuesto, VELO genera el código de seis dígitos.
4. El cliente abre el enlace, revisa las partidas y aprueba o rechaza.
5. Al quedar listo, VELO prepara el aviso con el mismo enlace.
6. Al entregar, el portal habilita el documento y la garantía.

## Lista de continuidad para la PC permanente

- UPS dimensionada para PC, router y equipo de Internet.
- Suspensión e hibernación desactivadas; apagar pantalla sí es aceptable.
- BIOS/UEFI con “encender después de volver la corriente”.
- Windows Update con horario activo fuera del horario comercial.
- Tailscale configurado para iniciar con Windows.
- `VeloTechPOSServer` en automático retrasado.
- Respaldo periódico de `C:\ProgramData\Velo Tech POS Server\data` mediante el
  sistema de backups de VELO; no copiar `velo.db` a mano mientras está abierto.
- Prueba semanal desde un teléfono usando datos móviles.

## Límites deliberados de seguridad

- Funnel escucha solamente en localhost y solo publica `/r/<negocio>/...`.
- El puerto interno `8443` conserva sus claves, terminales autorizadas y reglas
  separadas de firewall; no se comparte con el portal.
- Encabezados de caché, indexación, marcos, permisos del navegador y CSP están
  bloqueados.
- Las respuestas públicas no revelan si un número de orden existe.
- Si un enlace se comparte con la persona equivocada debe revocarse y
  regenerarse desde la orden.

Funnel evita contratar un servidor web propio, pero sigue dependiendo de que
la PC, el router, Internet y Tailscale estén disponibles. La UPS reduce cortes;
no sustituye un segundo enlace de Internet ni un respaldo restaurable.

## Verificación técnica

```bash
npm run test:service-portal
npm run test:server-service
npm run test:service-orders
npm run test:suite-upgrade
```

Estas pruebas cubren privacidad, enlace firmado, aprobación/rechazo, bloqueo,
reservas, notificaciones, entrega, garantía, revocación, separación del gateway
y actualización segura de bases existentes.
