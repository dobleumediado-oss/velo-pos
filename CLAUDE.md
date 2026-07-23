# CLAUDE.md — Velo POS Desktop

Punto de entrada para trabajar en este proyecto. Este archivo es el **hub central**: resume lo esencial y enlaza a la documentación extendida en [`docs/`](docs/). Consulta el tema específico antes de tocar ese módulo.

## Qué es
Aplicación **Electron v29** de punto de venta (POS) **offline** para micro-negocios de República Dominicana (tiendas de auto repuestos, etc.). Versión actual: `1.26.0` (ver `package.json`).

## Stack y arquitectura
- **Electron v29** — `contextIsolation: true`, `nodeIntegration: false`.
- **better-sqlite3** — SQLite síncrono, modo WAL, foreign keys ON.
- **Patrón IPC**: el proceso main maneja toda la BD vía `ipcMain.handle()`; el renderer llama vía `contextBridge` → `window.api`. Nunca acceder a la BD desde el renderer directamente.
- **preload.js** — puente seguro; solo se exponen las llamadas IPC de la whitelist.
- **Sistema de migraciones** en `versioning.js` — array `MIGRATIONS`, registrado en la tabla `db_migrations`. Corre automáticamente al primer arranque tras actualizar.
- **Patrón repositorio** en `database.js` — objetos `xxxRepo` exportados por dominio.
- **Frontend vanilla JS** (`src/js/`) — helper `h()` para DOM, `openModal/closeModal`, `toast()`, `fmt()` para moneda. Sin frameworks.

## Convenciones clave
- **Activación de módulos** vía settings: `module_gastos='1'`, `module_contabilidad='1'`, etc., toggleados en `src/js/superadmin.js` (`modsDefs`). El sidebar y el router en `app.js` leen `CFG.module_xxx`.
- **Roles**: `admin`, `cajero`, `superadmin`.
- **Contexto RD**: ITBIS 18%, moneda DOP, NCF (comprobantes fiscales), cumplimiento DGII.
- **Normalización de nombres de campo IPC**: la BD a veces usa columnas distintas a lo que espera la UI; los handlers en `main.js` normalizan (ej. `financial_accounts.current_balance` → `balance`, `active` → `is_active`, movimientos `deposito`/`retiro` → `ingreso`/`egreso`). Mantiene el esquema estable dándole a la UI semántica limpia.
- **Impresión**: siempre a través del servicio central `src/js/print.js` (`printHTML(html, category)`), nunca `window.api.print.html` directo. Ver [Módulo de Impresión](#documentación-extendida).

## Archivos principales
- `main.js` (~165 KB) — proceso principal, todos los handlers IPC.
- `database.js` (~149 KB) — repositorios por dominio.
- `versioning.js` (~52 KB) — migraciones.
- `preload.js` — bridge `window.api.*`.
- `src/js/` — un archivo por módulo de UI (`pos.js`, `caja.js`, `contabilidad.js`, `bancos.js`, `print.js`, etc.).
- `src/js/app.js` — navegación, router, topbar.
- `src/js/data.js` — objeto `CFG` (settings del cliente).

## Documentación extendida
Cada tema tiene su archivo dedicado en [`docs/`](docs/). Todos enlazan de vuelta a este `CLAUDE.md`:

- **[Visión general](docs/overview.md)** — arquitectura, stack, patrones y convenciones (base de la sección de arriba).
- **[Módulo de Contabilidad](docs/accounting-module.md)** — módulo completo de contabilidad + bancos (migraciones v1.6.x): archivos tocados, esquema de BD, flujo de activación, repos y handlers.
- **[Módulo de Impresión](docs/printing-module.md)** — overhaul del servicio global de impresión (v1.7.0): arquitectura, categorías, bugs corregidos y trabajo diferido deliberadamente.
- **[Preventa y Despacho](docs/preventa-despacho.md)** — órdenes compartidas entre preparación, caja y entrega; reservas, estados, permisos y operación multi-terminal.
- **[Clientes empresa y representantes](docs/clientes-empresas.md)** — cuentas personales/empresariales, contactos operativos, crédito consolidado y snapshots documentales.
- **[Proceso de Release](docs/release-process.md)** — ⚠️ empujar un tag `v*` = deploy en vivo a clientes reales vía electron-updater. **Confirmar siempre con el usuario antes de tag.**

## Antes de trabajar
- La documentación son observaciones puntuales; **verifica citas file:line contra el código actual** antes de afirmarlas como hecho.
- Antes de empujar un tag de release, lee el [Proceso de Release](docs/release-process.md) y confirma con el usuario.
