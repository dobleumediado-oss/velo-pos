# Visión general — Velo POS Desktop

[← Volver a CLAUDE.md](../CLAUDE.md) · Relacionados: [Clientes empresa](clientes-empresas.md) · [Contabilidad](accounting-module.md) · [Impresión](printing-module.md) · [Release](release-process.md)

Aplicación **Electron v29** de punto de venta (POS) **offline** para micro-negocios de República Dominicana (tiendas de auto repuestos, etc.).

## Stack
- **Electron v29** — `contextIsolation: true`, `nodeIntegration: false`.
- **better-sqlite3** — SQLite síncrono, modo WAL, foreign keys ON.
- **Patrón IPC**: el proceso main maneja toda la BD vía `ipcMain.handle()`; el renderer llama vía `contextBridge` → `window.api`.
- **preload.js** — puente seguro; solo se exponen las llamadas IPC de la whitelist.
- **Sistema de migraciones** en `versioning.js` — array `MIGRATIONS`, registrado en la tabla `db_migrations`.
- **Patrón repositorio** en `database.js` — objetos `xxxRepo` exportados por dominio.
- **Frontend vanilla JS** — helper `h()` para DOM, `openModal/closeModal`, `toast()`, `fmt()` para moneda. Sin frameworks.

## Convenciones clave
- **Activación de módulos** vía settings: `module_gastos='1'`, `module_contabilidad='1'`, etc., toggleados en `src/js/superadmin.js` (`modsDefs`).
- **Roles**: `admin`, `cajero`, `superadmin`.
- **Contexto RD**: ITBIS 18%, moneda DOP, NCF (comprobantes fiscales), cumplimiento DGII.
- **Preventa multi-terminal**: despacho prepara y reserva; caja cobra y genera la factura; despacho confirma la entrega. Ver [Preventa y Despacho](preventa-despacho.md).
- **Clientes empresariales**: una empresa concentra datos fiscales, crédito e historial; sus representantes identifican quién solicita o recibe sin crear cuentas separadas. Ver [Clientes empresa y representantes](clientes-empresas.md).
- **Alcance operativo**: una sola empresa usuaria, inventario global y varias terminales; no se modelan sucursales en el flujo empresarial actual.

## Normalización de nombres de campo IPC (importante)
La BD a veces usa columnas distintas a lo que espera la UI. Los handlers en `main.js` normalizan:
- `financial_accounts.current_balance` → expuesto como `balance`
- `financial_accounts.active` → expuesto como `is_active` (boolean)
- Tipos de movimiento `deposito`/`retiro` → mostrados como `ingreso`/`egreso`

**Por qué:** mantiene el esquema de BD estable dándole a la UI semántica limpia.
