# Multi-terminal y sincronización

[← Volver a CLAUDE.md](../CLAUDE.md) · [Instalación del servicio](server-service.md)

## Modelo vigente

Velo POS usa una sola fuente de verdad por negocio. Las terminales no replican
SQLite ni resuelven conflictos: llaman por RPC al servidor central.

```text
Terminal → IPC local → HTTP keep-alive/Tailscale → Server Service
         → worker exclusivo del negocio → SQLite WAL
```

El servicio y los workers se ejecutan sin ventana. Cerrar la consola Velo POS de
la PC principal no detiene las terminales.

## Procesos

- `Velo POS Server Service`: supervisor y gateway público en el puerto 8443.
- Worker `principal`: único proceso que abre la base principal.
- Un worker por cada negocio adicional: cada uno abre solamente su propia base.
- Consola del servidor: aplicación visible conectada a `127.0.0.1:8443`.
- Terminal: aplicación visible conectada por IP LAN o Tailscale.

El aislamiento por proceso es obligatorio: los repositorios actuales usan una
referencia SQLite global dentro de cada proceso. Cambiar esa referencia durante
peticiones concurrentes podría mezclar operaciones; los workers eliminan ese riesgo.

## Negocio por terminal

Cada solicitud y cada stream SSE llevan `businessId`. El gateway comprueba:

1. clave de acceso;
2. `terminalId` autorizado;
3. negocio permitido para esa terminal.

El superadmin puede asignar cada caja a todos los negocios o a uno específico.
Cambiar el negocio en una terminal reinicia únicamente esa terminal; no altera la
consola del servidor, los workers ni las demás cajas.

Si un negocio se archiva o se revoca el permiso vigente, el preflight selecciona
automáticamente el primer negocio autorizado.

## Red y rendimiento

- En el mismo local puede usarse la IP LAN.
- Para acceso remoto sin nube se recomienda Tailscale en servidor y terminales.
- Tailscale cifra el transporte; no almacena la base.
- RPC reutiliza conexiones HTTP con keep-alive.
- SSE envía avisos de cambio y la terminal vuelve a consultar solo los datos
  necesarios; no se transmite ni renderiza la base completa.

No se admite venta offline en una terminal desconectada. Es una decisión de
integridad para evitar duplicar NCF, correlativos, caja o inventario.

## Caja, fiscalidad e impresión

- Cada terminal conserva su `terminal_id` y maneja su propia sesión de caja.
- NCF, documentos e inventario se asignan en el worker del negocio.
- La impresión física sigue siendo local a la terminal, salvo la acción explícita
  de imprimir en el servidor.
- Las configuraciones de impresora son de dispositivo; los datos comerciales son
  del negocio central.

## Seguridad

- Gateway accesible mediante clave y allowlist de terminales.
- Restricción opcional de negocio por terminal.
- Administración sensible del servicio aceptada únicamente desde loopback.
- Workers enlazados a `127.0.0.1`; no quedan expuestos a la red.
- Firewall del instalador permite puerto 8443 desde Tailscale y LAN privada.
- El servicio no expone filesystem, impresión local, licencia ni updater por RPC.

## Compatibilidad

El modo Local continúa disponible para instalaciones de una sola PC. El modo
Servidor embebido anterior se mantiene por compatibilidad, pero las instalaciones
nuevas con varias terminales deben usar el instalador **Velo POS Server**.

## Verificación mínima antes de publicar

1. Migración real con copia de la base del cliente.
2. Dos terminales operando simultáneamente en negocios distintos.
3. Cerrar la consola del servidor y confirmar que ambas continúan.
4. Reiniciar Windows y confirmar inicio automático del servicio.
5. Cortar/reponer Tailscale y verificar recuperación del SSE.
6. Venta, NCF, caja, preventa, impresión y respaldo.
