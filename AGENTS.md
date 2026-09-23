# AGENTS.md — Velo POS Desktop

Reglas para cualquier agente que trabaje en este repositorio (Codex, Claude Code
u otro). Son cortas a propósito: léelas completas antes de tocar nada.

La documentación del proyecto vive en **[`CLAUDE.md`](CLAUDE.md)**, que es el hub
y enlaza cada módulo en [`docs/`](docs/). Léelo después de esto.

## Qué es
POS **offline** en **Electron v29** para micro-negocios de República Dominicana:
facturación con NCF, ITBIS 18%, caja, inventario, contabilidad. Lo usan negocios
reales todos los días. Un error aquí no es un test rojo: es una factura mal
emitida o una caja descuadrada.

## Cuatro reglas que no se rompen

1. **Nunca empujes un tag `v*`.** `git push origin vX.Y.Z` dispara el workflow
   que publica los cuatro instaladores y `electron-updater` los baja solo a las
   máquinas de los clientes. Es un deploy en vivo, no una corrida de CI. Solo el
   dueño decide cuándo y con qué número. Ver
   [Proceso de Release](docs/release-process.md).
2. **Nunca `git add -A`, `git add .` ni `git commit -a`.** El árbol de trabajo
   suele tener cambios ajenos sin commitear (por ejemplo `velo-suite-web/`,
   `outputs/`, `.claude/`, los íconos de VELO TECH en `src/assets/`, la línea
   `packageManager` de `package.json`). Nombra archivo por archivo lo que
   commiteas y revisa `git diff --cached` antes de confirmar. Si necesitas
   commitear solo una parte de un archivo con cambios ajenos, construye el índice
   a mano (`git show HEAD:archivo` + tu cambio + `git hash-object -w` +
   `git update-index --cacheinfo`).
3. **Nunca escribas en `data/velo.db`.** Contiene nombres, teléfonos y deudas de
   clientes reales. Para probar contra datos de verdad, trabaja sobre una
   **copia** y bórrala al terminar. Tampoco pegues esos datos en un chat ni los
   subas a ningún servicio.
4. **Verifica antes de afirmar.** Las citas `archivo:línea` de la documentación
   son observaciones de un momento dado; compruébalas contra el código actual
   antes de darlas por hechas. Si algo no lo probaste, dilo.

## Arquitectura mínima
- **IPC obligatorio**: la base de datos se toca solo en el proceso main
  (`ipcMain.handle()` en `main.js`); el renderer llama por `window.api`, expuesto
  en la whitelist de `preload.js`. Nunca acceder a SQLite desde `src/js/`.
- **Repositorios** por dominio en `database.js` (`salesRepo`, `cashRepo`, …).
- **Migraciones aditivas** en `versioning.js` (array `MIGRATIONS`, tabla
  `db_migrations`). Corren solas al primer arranque tras actualizar, en bases con
  años de datos: agregar columnas, no reescribir tablas.
- **Frontend vanilla JS** en `src/js/`, un archivo por módulo. Sin frameworks ni
  build step: helpers `h()`, `openModal/closeModal`, `toast()`, `fmt()`.
- **Impresión** siempre por `src/js/print.js` (`printHTML(html, category)`),
  nunca `window.api.print.html` directo.
- **Idioma**: todo lo que ve el usuario, en español dominicano y sin jerga
  técnica. Los mensajes de commit y los comentarios, igual.

## Cómo correr y probar
```bash
npm run dev                    # la app con devtools
npm run test:tech-readiness    # la compuerta que corre el CI del release
npm test                       # la batería completa (larga)
npm run test:pos               # una suite suelta; ver "scripts" en package.json
```
Si tocas un módulo, corre su suite **y** `test:tech-readiness`. Las pruebas usan
el ABI de Electron: si `better-sqlite3` se queja al abrir la base, corre
`npm run rebuild`.

Excepción conocida: `npm run verify:marker` reporta drift en
`src/js/clientes.js` por una frase en prosa que se parece al marcador histórico.
Es un falso positivo que viene de antes; **no** reescribas ese texto para
callarlo.

## Trabajo pendiente
Las mejoras acordadas y todavía no hechas están en
[Mejoras pendientes](docs/mejoras-pendientes.md), con el código a tocar y las
preguntas abiertas. Si una tarea depende de una decisión del dueño, pregúntala
antes de escribir código: aquí "asumir" mueve dinero.
