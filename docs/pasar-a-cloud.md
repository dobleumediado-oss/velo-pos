# Pasar a VELO Cloud (sin archivos)

[← Volver a CLAUDE.md](../CLAUDE.md) · Relacionados: [Preparación de migración a Cloud](cloud-migration-preparation.md) · [Continuidad](continuidad-negocio.md)

Decisión del dueño (10 nov 2026): migrar un negocio de Desktop a VELO Cloud sin
llevar archivos ni claves a mano, con un ensayo previo y **sin dejar Desktop
congelado si Cloud no activa el negocio**. Desde Desktop 1.64.0.

## Dónde

Configuración → Backups → **Pasar a VELO Cloud** (administrador o superadmin, en la
PC Servidor o en una PC sola; una terminal se rechaza porque trabaja contra la base
del Servidor). Los botones anteriores siguen como respaldo: «Preparar migración a
Cloud» y «Corte final a Cloud (con archivo)».

## Flujo

1. **Entrar a VELO Cloud** con la cuenta de administración de la empresa (correo y
   contraseña; si la cuenta tiene varias empresas, se elige). Desktop no guarda la
   contraseña y mantiene la sesión en memoria. Si el acceso está cerrado, pulsa
   **Solicitar habilitación**. VELO lo aprueba en **Control Center → Empresas**.
   Pulsa **Consultar estado** para continuar cuando habiliten el ensayo.
2. **Revisión**: ventas de prueba con equipo sin anular, datos de prueba de VELO TECH
   (lo retira el superadmin), conteo en borrador y cajas abiertas. Cada cosa tiene su
   botón para resolverla ahí mismo. La caja abierta solo impide el corte.
3. **Ensayo** (el negocio sigue trabajando): copia de preparación, Cloud la lee, se
   eligen sucursal, almacén, un usuario de Cloud por cada usuario de Desktop y la caja
   de cada terminal (una sola opción se elige sola; las unidades toman los decimales
   mínimos). Se ensayan los 20 pasos y se revierten. Lo elegido se guarda en
   `cloud-direct.json` (carpeta del negocio) para el corte.
4. **Corte** (escribir CORTE; exige ensayo superado con esa empresa, caja cerrada e
   integridad): congela Desktop, saca la copia final, la envía, convierte los 20 pasos,
   guarda el historial y activa. Unos 10 minutos en producción.

La clave de cada copia la genera Desktop (aleatoria) y nunca se escribe a mano. La del
corte queda en la marca del corte (`cloud-cutover.json`) y se muestra al terminar: sirve
para deshacer el corte en Cloud mientras Cloud no tenga movimientos propios.

## Si algo falla (la regla del dueño)

| Qué pasó | Qué hace Desktop |
|---|---|
| Falla antes de congelar | Nada cambia |
| Falla después de congelar y Cloud responde que la copia **no** está activa | Se **descongela solo** (auditoría `corte_cloud_descongelado_auto`) |
| Cloud confirma la activación (aunque la respuesta se haya perdido) | Queda en consulta para siempre |
| Sin respuesta al **activar**, o Cloud no responde con el estado | Queda en consulta, estado «por comprobar»; botón **Volver a comprobar** |
| «Volver a comprobar» antes de 5 minutos de pedir la activación y Cloud aún no la ve | Espera: una activación puede seguir terminando en Cloud |

Así nunca hay dos sistemas emitiendo NCF a la vez. La marca del corte guarda el estado
(`sending`, `converting`, `activating`, `verify`, `activated`) y sobrevive reinicios; el
aviso superior de Desktop lo refleja.

## Código

- `lib/cloud-direct.js`: cliente de la API de Cloud (sesión como `Bearer`, sin tocar
  Cloud), correspondencias y los 20 pasos en el mismo orden y con los mismos datos que la
  pantalla web «Convertir pasos».
- `lib/cloud-direct-flow.js`: ensayo, corte, comprobar y descongelar automático, sin
  Electron (recibe la base, la carpeta y cómo sacar la copia).
- `lib/cloud-cutover-freeze.js`: `updateCloud` anota el estado del corte en la marca; el
  estado público nunca incluye la clave.
- `main.js`: canales `cloudDirect:*` (solo en esta PC, en `localOnly`); `src/js/config.js`:
  asistente `abrirPasarACloud`; `src/js/app.js`: aviso según el estado del corte.

## Pruebas

- `npm run test:cloud-direct`: correspondencias, sesión y pasos sin red.
- `npm run test:cloud-cutover`: modo consulta, incluida la marca con el estado de Cloud.
- Punta a punta (10 nov 2026) con el código real sobre una copia de la base del negocio y
  Cloud local: entrar (y contraseña equivocada), revisión, ensayo con caja abierta, corte
  negado con caja abierta, **Cloud rechaza activar → se descongela solo y vuelve a
  escribir**, **sin conexión al activar → por comprobar → espera → se descongela**,
  **respuesta perdida tras activar → al comprobar confirma la activación**, y corte normal.
- En la app real (10 nov 2026, Desktop 1.64.0 en desarrollo contra Cloud local, aviso
  «VELO Cloud de prueba»): entrar, revisión «Todo listo», ensayo de los 20 pasos (14 s) con
  avance en vivo, correspondencias de usuarios, corte con CORTE (79 registros), pantalla
  «Listo» con la clave, aviso de modo consulta y, al reabrir, «Este negocio ya opera en VELO
  Cloud». Con `VELO_CLOUD_API_URL` el asistente avisa que no es el Cloud real.
