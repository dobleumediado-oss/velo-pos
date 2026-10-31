# Matriz VELO POS / VELO TECH POS

> Hub: [`CLAUDE.md`](../CLAUDE.md). Antes de tocar una pantalla, mira aquí a qué producto pertenece.

## Quién decide el producto

- **Desktop:** cada instalador lleva su rubro compilado (`package.json.veloVertical`). El único punto que lo resuelve es `src/verticals/index.js` (`activeVerticalId()`); en pantalla se lee `window._vertical`.
  - `auto_parts` = **VELO POS** (`serialized: false`, sin módulos de TECH).
  - `tech` = **VELO TECH POS** (`serialized: true`; módulos `service_orders`, `trade_in`; `vehicles: false`).
- **Web (VELO Cloud):** el subdominio (`pos.` / `tech.`) y la vertical del negocio (`tenant.vertical`). En pantalla: `currentVertical()` y el hook `useSerializedVertical()` (`apps/web/src/lib/use-vertical.ts`).

## Regla

Una función de TECH se enciende por **la capacidad**, nunca por el nombre de la pantalla:

| Capacidad | Desktop | Web |
|---|---|---|
| Inventario por IMEI | `window._vertical?.serialized` | `useSerializedVertical()` / `vertical === 'TECH'` |
| Servicio técnico | `window._vertical?.modules?.service_orders` | vertical `TECH` |
| Parte de pago (usados) | `window._vertical?.modules?.trade_in` | vertical `TECH` |
| Vehículos | `window._vertical?.modules?.vehicles !== false` | — |

Un dato que solo existe en TECH (IMEI, capacidad, batería, equipo usado) **no se muestra ni se imprime** en VELO POS, aunque un ajuste guardado lo traiga.

## Matriz por módulo

| Módulo / función | VELO POS | VELO TECH POS | Dónde se decide |
|---|---|---|---|
| Etiquetas Interno / Proveedor / Personalizado | ✅ | ✅ | — |
| Etiqueta **Exhibir**: nombre, marca, modelo, precio, códigos, logo | ✅ | ✅ | `labelFieldsFor(kind, chosen, serialized)` |
| Exhibir con **capacidad, batería e IMEI** (una por equipo) | ❌ | ✅ | `SERIALIZED_LABEL_FIELDS` en `zpl-labels` |
| Inventario por IMEI, «Buscar IMEI», «Registrar equipos» | ❌ | ✅ | `inventario.js` (`serialized`) |
| Conteo físico por IMEI | ❌ (solo productos) | ✅ | `inventario.js` (`countHasImei`) |
| Venta eligiendo el equipo (IMEI) | ❌ | ✅ | `pos.js` (producto serializado) |
| Equipo usado como parte de pago | ❌ | ✅ | `pos.js` (`modules.trade_in`) |
| Compras de equipos a personas | ❌ | ✅ | `compras.js` (`id === 'tech'`) |
| Servicio técnico (órdenes, recibo, etiqueta del equipo) | ❌ | ✅ | `app.js` (`modules.service_orders`), `main.js` |
| Conduces | ✅ | ❌ | `app.js` (`id !== 'tech'`) |
| Vehículos y mantenimiento | ✅ | ❌ | `app.js` (`modules.vehicles`) |
| Servicios sin existencia (Web: pestaña Servicios) | ✅ (sin mencionar IMEI) | ✅ | `services-panel.tsx` |

## Cómo se protege

- Desktop: `scripts/test-zebra-thermal-quality.js` comprueba que en VELO POS Exhibir no ofrece capacidad, batería ni IMEI.
- Web: `tests/label-fields-vertical.test.ts`.
- Al reportar un cambio se marca **[POS]**, **[TECH]** o **[Ambos]**.
