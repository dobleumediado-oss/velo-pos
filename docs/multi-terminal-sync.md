# Multi-terminal / Sincronización — Esquema completo

[← Volver a CLAUDE.md](../CLAUDE.md)

> Estado: **fases funcionales completas y validadas** (rama `feat/multi-terminal`,
> 15 commits). Falta **QA visual en GUI** (impresión real, modal de destino, aspecto
> de la UI) y la decisión de merge/release. NO liberar a clientes hasta ese QA.
> El modo por defecto es **Local** — el comportamiento actual queda intacto. Todo lo
> nuevo es **aditivo y opt-in**. Validado en Electron real: arranque local sin cambios,
> modo servidor sirviendo RPC, y E2E cliente→servidor 7/7 (login, sesión única, datos,
> settings, seguridad).

## 1. Objetivo
Permitir que varias PC (mostrador + laptops/desktops) de un mismo negocio compartan
**los mismos datos en tiempo real**: inventario, ventas, clientes, caja, cuentas.
Con opción de conectarse **desde la misma red local** o **de forma remota** (otra
WiFi) de manera segura.

## 2. Modelo elegido: servidor central (una sola base viva)
Una PC es el **servidor** (la principal, la que tiene la base de datos). Las demás
son **clientes**: no guardan copia, **consultan y escriben en la base del servidor**.
No hay "sincronización de copias" ni conflictos — hay una sola fuente de verdad.

```
Cliente (renderer) → window.api.* → main (cliente) → red → main (servidor) → SQLite
```

El sistema ya centraliza TODO el acceso a datos en el proceso main vía IPC
(`window.api`). Ese es el único punto que cambia: en modo **cliente**, en vez de
pegarle a la BD local, reenvía la operación al servidor. La UI (los ~28 módulos)
no cambia.

### Por qué NO offline-first (todavía)
El offline-first (cada PC con copia que se replica/mergea) permite vender sin
conexión, pero agrega conflictos y complica NCF/correlativo. Se documenta como
**Fase futura** opcional; el modelo central resuelve el 90% con mucho menos riesgo.

## 3. Los tres modos de conexión
| Modo | Qué hace | Base de datos |
|------|----------|---------------|
| **Local** (default) | Como hoy, máquina sola | SQLite local |
| **Servidor** | Esta PC atiende a las demás | SQLite local (fuente de verdad) |
| **Cliente** | Reenvía todo al servidor | Ninguna local — usa la del servidor |

Regla: **un solo Servidor por negocio.** Puede haber muchos Clientes.

## 4. Escenarios de red
| Dónde está la máquina | ¿Tailscale? | IP que usa |
|---|---|---|
| En la tienda, misma red WiFi/cable | No | IP local (`192.168.x.x`) |
| Remota / otra WiFi / otra sucursal | Sí (en servidor **y** cliente) | IP de Tailscale (`100.x.x.x`) |

- **Tailscale/WireGuard** es solo la "carretera" (VPN): conecta las máquinas de
  forma cifrada. **No guarda datos** ni es el servidor. Solo hace falta para cruzar
  de una red a otra.
- Recomendación operativa: si alguna máquina se conectará desde afuera, instalar
  Tailscale en **todas** y usar siempre la IP de Tailscale (config idéntica dentro
  y fuera de la tienda).

## 5. Identidad de terminal
Cada PC se identifica con:
- `machineId` — ya existe ([license.js](../license.js)); hash de hardware+hostname.
  Cambia si se renombra la PC o cambia el CPU.
- `terminal_id` — **nuevo**: UUID persistente generado la 1ª vez y guardado en
  `settings`. NO cambia aunque se renombre la PC. Es el identificador estable.

Usos: cajas por terminal, allowlist de máquinas autorizadas en el servidor,
auditoría ("qué terminal hizo esta venta"), nombre amigable ("Mostrador").

## 6. Cajas por terminal (cambio de diseño clave)
Hoy el sistema maneja **una sola caja global** (`cashRepo.getOpen()` → LIMIT 1).
Multi-terminal exige que **cada terminal abra/cierre y cuadre su propia caja**:
- Agregar `terminal_id` a `cash_sessions`.
- `getOpen()` pasa a ser `getOpen(terminalId)`.
- Reportes de caja: por terminal y consolidado.
- **DECIDIDO:** cada terminal maneja **su propia caja** (abre, cierra y cuadra la suya).

## 7. Usuarios y permisos
- Los usuarios y roles son **centrales** (viven en el servidor).
- Cada máquina tiene su **propia sesión/login** independiente. La laptop entra con
  OTRO usuario, no hereda el del mostrador.
- Cualquier admin/cajero (según permiso) entra en cualquier terminal y vende.
- **DECIDIDO:** un mismo usuario **NO** puede estar logueado en 2 máquinas a la vez.
  El servidor lleva el registro de sesiones activas por usuario; el 2º login se
  **rechaza con una alerta** ("Este usuario ya tiene una sesión activa en otra terminal").

## 8. Impresión (DECIDIDO — modelo flexible por terminal)
Servicio ya centralizado en [print.js](../src/js/print.js). Comportamiento por terminal:
- **Si la terminal tiene impresora física** → imprime en **su propia** impresora, en el sitio.
- **Si NO tiene impresora física** → el documento **se guarda en el servidor (local)** y
  se le ofrece al usuario, **en el momento**, la opción de:
  - imprimirlo **en la impresora del servidor (mostrador)**, o
  - imprimirlo **desde la misma terminal** (si conecta una impresora ahí).
- Todo documento generado queda registrado en el servidor aunque no se imprima.
- **Aplica a TODOS los módulos que imprimen o generan reportes** (factura, ticket,
  cotización, conduce, abono, cierre de caja, reportes contables, 607/608, etc.),
  no solo a la venta. El ruteo pasa por el único servicio de impresión.

## 9. Fiscal — lo más crítico (NCF / correlativo / inventario)
El **servidor** es el único que asigna, en orden y de forma serializada:
- **NCF** (desde `ncf_sequences`) — nunca duplicado entre terminales.
- **numero_factura / correlativo**.
- **Descuento de inventario** — atómico, sin sobreventa.

> ⚠️ El commit `b32dba1` (v1.14.0) reescribió plantillas y "NCF por secuencias".
> Re-leer ese código antes de tocar la asignación de NCF en la fase de servidor.

## 10. Disponibilidad y respaldo (no negociable)
Todo el negocio depende del servidor:
- **Respaldo automático fuera de la máquina** (disco externo / nube). Si el disco
  del servidor muere o lo roban, sin respaldo se pierde TODO.
- **UPS** (batería) y buen internet en el servidor.
- Idealmente una **máquina dedicada** (mini-PC always-on), no la laptop de trabajo.
- Cliente sin conexión al servidor → aviso claro y **bloqueo de venta** (para no
  descuadrar caja/NCF). El offline-first (vender sin servidor) es fase futura.

## 11. Seguridad
- Transporte **cifrado (TLS)** entre cliente y servidor.
- **Clave de acceso** (token) + **allowlist de `terminal_id`/`machineId`** en el
  servidor: solo terminales registradas entran.
- Tailscale limita quién puede siquiera alcanzar la IP.
- Login de usuario (rol) por encima de todo.
- No exponer el filesystem ni Node al cliente remoto; solo las operaciones IPC
  whitelisted, ahora sobre la red.

## 12. Fases de implementación
- **Fase 1 — Fundación:** identidad de terminal (`terminal_id` + `machineId`), bandera
  `connection_mode` (default `local`). ✅
- **Fase 2 — Capa de red:** `src/main/connection.js` (clave/allowlist/autorización),
  `net-server.js` (RPC HTTP), `net-client.js` (transporte + offline), `ipc-bridge.js`
  (interceptor mode-aware que migra los 197 handlers en un punto; AsyncLocalStorage
  para el terminalId por petición). Cableado en `main.js` (solo arranca en modo servidor). ✅
- **Fase 3 — UI de conexión:** card "Modo de Conexión" (config.js) + handlers
  `connection:*`. Split de settings (negocio→servidor / dispositivo→local). ✅
- **Fase 4 — Cajas por terminal:** migración `1.14.1` (`terminal_id` en cash_sessions),
  `getOpen(terminalId)` con fallback legacy, venta→caja en todos los flujos de dinero. ✅
- **Fase 5 — Ruteo de impresión:** `print:*` local por terminal, `print:onServer` para
  imprimir en el mostrador, modal de destino (cliente sin impresora). ✅
- **Sesión única por usuario:** registro en memoria + heartbeat + alerta. ✅
- **Hardening:** el servidor no sirve canales de dispositivo a clientes (deny list). ✅
- **Pendiente:** QA visual GUI (impresión real, modal, aspecto UI); Tailscale (manual o
  empaquetado); respaldo automático fuera de la máquina + UPS (operativo).
- **Fase futura (opcional) — Offline-first:** copia local + replicación para vender sin servidor.

## 13. Decisiones (RESUELTAS)
1. **Cajas:** cada terminal maneja su propia caja. (§6)
2. **Impresión:** flexible por terminal — impresora física local si la hay; si no,
   se guarda en el servidor y se ofrece imprimir por el servidor o desde la terminal
   en el momento. Aplica a todos los módulos de impresión/reportes. (§8)
3. **Sesión de usuario:** un usuario no puede estar en 2 máquinas a la vez → alerta
   y rechazo del 2º login. (§7)

## 14. Regla de release
Nada de esto se hace tag/release a clientes hasta estar **completo y probado en QA**.
El modo por defecto (`local`) garantiza que las versiones intermedias no cambian el
comportamiento actual de nadie.
