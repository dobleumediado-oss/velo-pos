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
