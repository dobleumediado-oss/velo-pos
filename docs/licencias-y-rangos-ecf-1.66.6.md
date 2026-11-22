# Licencias con llave nueva y rangos e-CF por ambiente (Desktop 1.66.6)

Fase A de las mejoras de VELO Control, aprobada por Wilfer el 20 nov 2026. Volver al
hub: [CLAUDE.md](../CLAUDE.md).

## Licencias: llave nueva

La llave privada que firmaba las licencias (`tools/vendor-private.pem`) se borró del
repositorio en julio de 2026 (commit `850cf3f`), pero sigue en el historial del repo
**público**. Era la misma que firmaba todas las licencias v2 y v3: cualquiera podía firmarse
una licencia perpetua o «UNIVERSAL».

Desde 1.66.6:

- `license.js` verifica con una **llave nueva** (huella `C36F040E7086C529`). Su privada vive
  en `~/.velo-licencias/vendor-private.pem` (permisos 600), fuera de todo repositorio. Hay
  que guardar una copia en el gestor de contraseñas: sin ella no se pueden emitir licencias.
- La llave anterior queda como `LEGACY_PUBLIC_KEY_PEM` y solo valida las licencias de la
  **lista blanca** (`LEGACY_ALLOWED_SHA256`): el SHA-256 de cada una de las 15 licencias que
  el proveedor emitió (historial del 21 ago al 16 nov 2026). Las huellas no revelan nada.
- Una licencia instalada, firmada con la llave anterior y **fuera** de la lista (falsificada
  o anterior al historial) recibe **30 días de aviso** desde que 1.66.6 la detecta
  (`.legacy-license-notice` en la carpeta de datos): sigue operando y avisa «Licencia por
  renovar». Al día 30 se bloquea con el motivo. Una licencia así nunca se puede activar.
- `tools/license-provider.js` y `tools/generate-license.js` buscan la llave y el historial en
  `~/.velo-licencias/` (o `VELO_PRIVATE_KEY_PATH` y `VELO_LICENSE_HISTORY_PATH`). El
  administrador de licencias se niega a firmar con una llave que no coincida con `license.js`.
- El historial anterior se copió (no se movió) a `~/.velo-licencias/license-history.json`.

Comprobado sobre los datos reales sin guardar nada: las 15 licencias siguen valiendo; una
licencia «UNIVERSAL» firmada con la llave filtrada se rechaza (`LEGACY_KEY_RETIRED`); una
licencia firmada con la llave nueva vale.

Pendiente fuera de esta versión: la fecha de vencimiento depende del reloj del equipo
(se resuelve cuando Desktop reporte a Control, Fase D).

## Rangos e-CF por ambiente

- Un rango solo choca con otro **activo** del mismo ambiente y RNC: el rango real de la DGII
  ya se puede registrar aunque cruce el que se usó en TesteCF.
- Los números ya usados (por ejemplo en pruebas) no se repiten: la reserva los salta, y al
  registrar el rango la pantalla dice cuántos se saltarán.
- **Desactivar rango**: deja de emitir y queda en el historial (migración aditiva
  `1.66.6-ecf-range-active`, columna `active`). No se puede volver a activar.
- `ecf_documents.encf` sigue siendo único en toda la tabla (cambiarlo exigiría reescribir la
  tabla). Recomendación: probar en TesteCF con números altos (por ejemplo `E310000019901`).
  Pendiente confirmar con MSeller si los números autorizados que quedan sin usar deben
  anularse ante la DGII.

**Orden de publicación:** la columna nueva cambia la huella de `ecf_sequences` que revisa
«Pasar a VELO Cloud». Cloud aprueba la huella nueva en `73ad563`; **Cloud debe estar
desplegado antes de publicar Desktop 1.66.6**, o los clientes con rangos e-CF no podrían
pasar a Cloud.

## Reporte diario a VELO Control y licencias renovables (Fase D)

- `lib/control-report.js`: dos minutos después de abrir y luego cada 24 horas, el equipo
  envía a `https://api.velosuite.cloud/v1/desktop/heartbeat` su licencia (como identidad),
  la versión, el modo (equipo único, Servidor o Terminal), los e-CF aceptados del mes y sus
  rangos activos. **Nunca clientes, montos ni facturas.** Una Terminal no envía uso de e-CF.
  Solo en la app instalada (o con `VELO_CONTROL_REPORT=1`); se apaga con el ajuste
  `control_report_enabled='0'`. Sin internet no pasa nada.
- Si en VELO Control la instalación está unida a una cuenta de Cobros de Desktop, activa y
  sin atraso, y la licencia vence en menos de 30 días, Cloud responde con una licencia de
  35 días firmada con la **llave del servidor** (huella `BEB8F4186D827EE0`). Desktop la
  verifica con `activateLicense` y solo la instala si vence después de la actual; nunca
  reemplaza una perpetua. Queda en la auditoría (`licencia_renovada`).
- `license.js` acepta de la llave del servidor solo licencias v3 que venzan a 45 días o
  menos (`SERVER_LICENSE_TOO_LONG` si no). Si alguien comprometiera el servidor, no podría
  sacar licencias largas ni perpetuas.
- Probado de punta a punta con las llaves reales contra la API de Cloud en local.
- Pendiente: el «Servidor» instalado como servicio sin ventana todavía no reporta (solo la
  app con ventana).

### Conectividad con VELO Control (F3, 22 nov 2026)

- Desde la Fase F1 de Cobros, la licencia renovada dura **lo pagado más 3 días** (tope 35):
  un equipo que no se conecta se queda sin renovar aunque el cliente esté al día.
- Por eso el reporte ahora sale **al abrir** (a los 2 minutos), **una vez al día**, **al
  despertar la PC** (si no hubo un reporte bueno en 20 horas) y, si falla, **se reintenta en
  una hora** en vez de esperar al día siguiente (`nextDelayMs`, `shouldReportOnResume` en
  `lib/control-report.js`).
- **Configuración → «Licencia en línea»** (Administrador y Dev): última conexión de este
  equipo, el motivo si falló (sin jerga) y el botón **«Conectar ahora»**, que reporta en el
  momento e instala la renovada si llega. IPC `license:controlStatus` y
  `license:controlConnect`.
- La última conexión buena se guarda por equipo en `control-report.json`, junto a la
  licencia (no en la base que las Terminales comparten con el Servidor).
- En VELO Control, la pantalla «Desktop» marca «Sin reportar» (3 días o más) y «Vence
  pronto» (menos de 7 días).
