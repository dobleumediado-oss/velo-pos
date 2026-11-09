# Preparación de la migración a Cloud

En Configuración → Backups, **Preparar migración a Cloud** crea un archivo
`.velomigrate` del negocio seleccionado. Solo administración puede crearlo.
En instalaciones con servidor se selecciona la carpeta desde la PC Servidor.
Cada negocio se prepara por separado.

El archivo contiene una copia consistente de SQLite (todas las tablas, también
las de módulos que Cloud todavía no soporta) y los archivos referenciados en
`service_order_evidence`. Se verifican integridad de SQLite, relaciones y
huellas de las evidencias. Si falta una evidencia o fue alterada, la preparación
falla y elimina el archivo incompleto. Los archivos externos no referenciados
en esa tabla no se incluyen; esto no sustituye el respaldo del equipo.

La clave de al menos 12 caracteres no se guarda. El contenido se comprime y
cifra con AES-256-GCM y una clave derivada con scrypt y sal aleatoria. Se verifica
el archivo antes de confirmarlo. Las copias temporales se eliminan al terminar.
La base activa no se reemplaza ni se marca como migrada.

## Corte final a Cloud (modo consulta)

Decisiones del dueño (7 de noviembre de 2026): pausa corta sin captura de
cambios; Desktop queda en modo consulta; Cloud solo activa una copia final en
una empresa vacía y puede deshacerlo antes de su primer movimiento.

En Configuración → Backups, **Corte final a Cloud** (administración):
1. Exige escribir `CONGELAR`, que no haya ninguna caja abierta y que la base
   pase `quick_check`.
2. Registra en la auditoría `corte_cloud_congelado` (la última escritura) y deja
   la marca `cloud-cutover.json` en la carpeta del negocio, con hora y usuario.
3. Congela la conexión: `PRAGMA query_only = ON` (SQLite rechaza toda escritura,
   también la de las terminales que pasan por el Servidor) y `db.prepare`
   rechaza antes de ejecutar cualquier sentencia que escribe.
4. Saca la copia final `.velomigrate` con `purpose: desktop-cutover-final` y
   `frozenAt`. Es la única que VELO Cloud acepta para activar.

Mientras está congelado:
- Arriba de cada pantalla se ve el aviso «Modo consulta…» con la fecha.
- Toda escritura responde «Este negocio ya opera en VELO Cloud: Desktop está en
  modo consulta y no guarda cambios», en esta PC y en las terminales (el puente
  IPC traduce el error, `src/main/ipc-bridge.js`).
- Entrar, salir, consultar, reimprimir y los respaldos (manual y externo
  cifrado) siguen funcionando; la auditoría, el registro de impresiones y el de
  respaldos no escriben. La cola automática de WhatsApp se detiene (los mensajes
  los envía Cloud). Cambiar a un negocio congelado no le escribe nada.
- Reiniciar o actualizar no descongela: la marca se aplica al terminar el
  arranque. Una marca dañada se trata como congelado.
- **Sacar otra vez la copia final** repite la copia con la misma hora.

**Descongelar negocio** (solo superadmin) exige escribir `DESCONGELAR` y un
motivo. Se hace solo si Cloud no llegó a activarse o se deshizo el corte. La
marca queda archivada como `cloud-cutover.descongelado-<fecha>.json` y la
auditoría registra `corte_cloud_descongelado`.

Código: `lib/cloud-cutover-freeze.js`, canales `cloudCutover:*` en `main.js`,
`abrirCorteCloud` / `abrirDescongelarCorte` en `src/js/config.js`, aviso en
`src/js/app.js`. Prueba: `npm run test:cloud-cutover`.

## Datos de prueba de VELO TECH en un negocio VELO POS

VELO POS no maneja equipos con IMEI. Si una base de VELO POS trae un artículo de
prueba con IMEI, sus equipos y ventas con equipo, VELO Cloud no la convierte (datos
de la otra edición). Anular esas ventas no basta: sus líneas siguen apuntando a los
equipos. Decisión del dueño (7 de noviembre de 2026): herramienta en Desktop.

En Configuración → Backups aparece el aviso **Datos de prueba de VELO TECH** con lo
que hay y lo que falta. **Retirar datos de prueba** (solo superadmin, solo VELO POS):
1. Exige que toda venta con equipo ya esté **anulada por el flujo normal** (caja,
   existencia y comprobantes se revierten como siempre; el equipo vuelve a existencia).
2. Se niega si hay taller, recepciones de usados, compras de equipos, técnicos o
   modelos: esos datos de TECH se resuelven aparte.
3. Pide escribir `RETIRAR` y guarda antes un respaldo verificado
   (`backups/velo_pre_retiro_datos_tech_<fecha>.db`).
4. En una transacción: desengancha los equipos de las líneas anuladas, retira los
   equipos y deja el artículo sin IMEI e inactivo. Ventas anuladas, caja e
   historial se conservan. Queda en la auditoría (`retiro_datos_prueba_tech`).

Verificado con una copia de la base real: tras anular las 2 ventas y retirar, VELO
Cloud no detecta datos de la otra edición y los 20 pasos y el ensayo final pasan
(25.175 registros). Código: `lib/tech-test-data.js`, canales
`cloudCutover:techTestDataStatus` / `cloudCutover:retireTechTestData`. Prueba:
`npm run test:tech-test-data`.

## Alcance pendiente

**Preparar migración a Cloud** saca una copia inicial para ensayar; el corte
usa la copia final de arriba. La activación en Cloud sigue en pruebas (bloqueada
en producción) y falta el ensayo final con la base real. No se debe pedir a
un cliente que abandone Desktop con este archivo. La continuidad sin pérdida
de ventas requiere completar y probar esas partes y la equivalencia de módulos.

## Verificación

`npm run test:cloud-migration-package` usa exclusivamente datos ficticios en
carpetas temporales. Comprueba descifrado independiente, conservación de tablas
desconocidas, valores binarios, saldos y numeración, evidencias, contraseña
incorrecta, alteración, truncamiento, rutas inválidas y limpieza ante errores.
