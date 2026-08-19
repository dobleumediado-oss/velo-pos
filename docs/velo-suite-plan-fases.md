# VELO SUITE — Plan de ejecución por fases

[← Volver a CLAUDE.md](../CLAUDE.md) · Relacionados: [Arquitectura VELO SUITE](velo-suite-architecture.md) · [Proceso de Release](release-process.md)

Plan **ejecutable** para llevar VELO POS al modelo de suite (core compartido +
vertical packs) y construir **VELO TECH POS** como primer producto hermano — **sin
afectar a los clientes que ya tienen VELO POS instalado.**

> Lee primero la [arquitectura](velo-suite-architecture.md) (el *qué*). Este doc es
> el *cómo/orden/compuertas* para hacerlo con seguridad, ahora.

---

## Invariantes (se cumplen en TODAS las fases)

Estos son los "no-negociables" que hacen la reestructuración **invisible** para
un cliente que ya tiene VELO POS. Si una fase los rompe, se detiene.

1. **`appId` de VELO POS = `do.velopos.app`** — nunca cambia (electron-updater
   empareja por él).
2. **`productName` = "Velo POS"** y **canal de update = `latest.yml`** — sin cambios.
3. **Ruta del directorio de datos** (donde vive `velo.db`) — idéntica.
4. **Migraciones aditivas e idempotentes** — nunca tocan datos existentes; con el
   vertical `auto_parts` el comportamiento es byte-idéntico.
5. **El código en la rama NO afecta a nadie** — un cliente solo cambia cuando se
   empuja un tag `v*` que su app auto-actualiza. La publicación es una **decisión
   aparte**, nunca un efecto colateral del refactor.

## Compuerta de verificación (se corre en cada fase que toque VELO POS)

- ✅ VELO POS pasa **toda su suite de tests sin cambios**.
- ✅ **Test de camino de upgrade** contra una **copia de base real**
  (`data/velo.db`): abre, migra limpio, y los agregados clave cuadran (total de
  ventas, # de facturas, cuadre contable, stock). *(Es el patrón que ya usamos
  para validar los fixes de 1.40.3.)*
- ✅ `npm run release:check` / `verify:packaging` verdes (atrapan `require()` roto
  o módulo fuera de `build.files`).
- ✅ Aserción de invariantes: un test falla si cambia appId / productName / canal /
  ruta de datos de VELO POS.

## Estrategia de ramas

- Rama de trabajo: **`feat/velo-suite`** partiendo del tag publicado **`v1.40.3`**
  (línea limpia, sin el CRM no liberado). El CRM se integra por su cuenta.
- Nada se publica a clientes hasta pasar la compuerta de upgrade y —idealmente— el
  **canal canary** (ver [BI/roadmap]; hoy no existe y es recomendable antes de la
  primera publicación del refactor).

---

## Mapa de fases

```
── PLATAFORMA (dentro de VELO POS, cero cambio para clientes) ──
F0  Preparación + red de seguridad
R0  Costura del vertical (refactor puro)
R1  Tema por configuración
R2  Terminología
R3  Modelo de producto serializado (APAGADO para auto-parts)
        ⇩ (opcional) publicable como un VELO POS idéntico
── SEGUNDO PRODUCTO (VELO TECH POS, no colisiona con VELO POS) ──
R4  Esqueleto TECH POS + (mover a monorepo packages/apps)
R5  Inventario serializado end-to-end
R6  Módulo Servicio/Reparación
R7  Trade-in + Garantía por IMEI
R8  Licencia por producto (suite)
```

### Estado de ejecución — 2026-08-18

| Fase | Estado | Compuerta principal |
|---|---|---|
| R5 · Inventario serializado | ✅ Completa | Alta/venta/búsqueda por IMEI y stock por unidad |
| R6 · Servicio / Reparación | ✅ Completa | Flujo de estados y entrega convertida en venta fiscal |
| R7 · Trade-in + Garantía | ✅ Completa | Usado como pago, garantía por IMEI y anulación consistente |
| R8 · Licencia por producto | ✅ Completa | ECDSA v3 habilita POS, TECH o ambos; vertical no autorizado bloqueado |

La regresión incluye ahora estas cuatro fases dentro de `npm test`, además de
la compuerta de upgrade sobre una copia de la base real.

---

## F0 — Preparación y red de seguridad
**Objetivo:** montar las compuertas antes de tocar código productivo.
- Crear rama `feat/velo-suite` desde `v1.40.3`.
- Escribir `scripts/test-suite-upgrade-safety.js`: copia `data/velo.db`, corre
  `initDB`+migraciones del build nuevo, verifica que abre y que agregados clave
  cuadran contra la base original.
- Escribir aserción de invariantes (appId/productName/canal/ruta de datos).
- **Impacto en clientes:** ninguno.
- **DoD:** ambos scripts existen y pasan contra la base real.

## R0 — Costura del vertical (refactor puro)
**Objetivo:** introducir el punto único donde el core lee "qué rubro soy", sin
cambiar comportamiento.
- `src/verticals/auto-parts.js` con los valores **actuales** (branding key, tema =
  paleta actual, terminología = labels actuales, módulos = set actual,
  `serialized:false`).
- Constante `VELO_VERTICAL` (default `auto_parts`); espejo en
  `settings.business_vertical` al primer arranque.
- El core lee de ahí (sin usar aún los valores para cambiar nada).
- **BD:** solo `settings.business_vertical` (aditivo).
- **Impacto en clientes:** ninguno (mismos valores).
- **DoD:** compuerta completa; VELO POS idéntico en comportamiento.

## R1 — Tema por configuración
**Objetivo:** que los colores salgan del vertical, con auto-parts = hoy.
- Cargar `vertical.theme` como variables CSS en `:root` (`app.js`/`data.js`).
- **Impacto en clientes:** ninguno (misma paleta).
- **DoD:** sin diferencia visual; compuerta completa.

## R2 — Terminología
**Objetivo:** labels por rubro sin migración forzada.
- Helper `t(key)` con **fallback a los labels actuales**. Adopción gradual.
- **Impacto en clientes:** ninguno hasta migrar cada label.
- **DoD:** compuerta completa.

## R3 — Modelo de producto serializado (apagado para auto-parts)
**Objetivo:** la única adición estructural, gated OFF para el rubro actual.
- Migración (idempotente, aditiva): `products.serialized` DEFAULT 0 + tabla
  `product_units` + índices (ver [arquitectura §5](velo-suite-architecture.md)).
- `productUnitsRepo` + **helper central de stock** (serializado ⇒ stock = COUNT de
  unidades `en_stock`).
- Con `serialized=0`: `product_units` vacía, flujo de venta idéntico.
- **Impacto en clientes:** la migración corre solo si se publica; es aditiva y no
  toca datos → auto-parts idéntico. **Test de upgrade obligatorio.**
- **DoD:** upgrade-safety verde (tabla vacía, columna 0, ventas/stock idénticos);
  tests de ventas verdes.

> **Punto de decisión:** R0–R3 dejan a VELO POS **funcionalmente idéntico**. Se
> pueden publicar como un VELO POS normal (p. ej. 1.41.0) o quedar sin publicar.
> Recomendación: **no acoplar a release** hasta tener el canary.

---

## R4 — Esqueleto VELO TECH POS (segundo producto)
**Objetivo:** el primer producto hermano, aislado de VELO POS.
- `build/electron-builder-tech.js`: `appId='do.velotechpos.app'`,
  `productName='Velo Tech POS'`, ícono propio, canal `latest-tech.yml`,
  `VELO_VERTICAL=tech`.
- `src/verticals/tech.js` (branding, tema, terminología, módulos: `serialized:true`,
  `service_orders:true`, `vehicles:false`).
- Scripts `build:win:tech`, `release:win:tech`.
- **(Aquí encaja el movimiento a monorepo** `packages/core` + `apps/velo-pos` +
  `apps/velo-tech-pos`, con `verify:packaging` + `verify:marker` como red por las
  rutas `require()` y el marcador histórico frágil.)
- **Impacto en clientes VELO POS:** ninguno — producto separado, appId y canal
  distintos; jamás se cruzan los auto-updates (igual que Terminal vs Server hoy).
- **DoD:** instalador Velo Tech POS arranca con su identidad/tema/base propia;
  VELO POS sigue pasando su suite + upgrade-safety.

## R5 — Inventario serializado end-to-end (TECH)
**Objetivo:** operar equipos por IMEI.
- UI de alta por IMEI, venta eligiendo unidad, stock por unidades, búsqueda por IMEI.
- **DoD:** vender un equipo descuenta su unidad; asiento/COGS y factura correctos; test.

## R6 — Módulo Servicio / Reparación (TECH)
**Objetivo:** órdenes de reparación (recepción→…→entrega).
- `service_orders` + `service_order_items` (patrón `maintenanceRepo`/preventa).
- Entrega → genera venta normal (repuestos + mano de obra) reusando fiscal/contable.
- **DoD:** la orden recorre estados y desemboca en venta fiscalmente correcta; test.

## R7 — Trade-in + Garantía por IMEI (TECH)
- Compra de usados → `product_unit` `condition='usado'`, valor como pago.
- `warranty_until` por unidad + consulta "buscar por IMEI" (venta, cliente, garantía).
- **DoD:** comprar usado y consultar garantía por IMEI funcionan; test.

## R8 — Licencia por producto (suite)
**Objetivo:** que la licencia sepa qué producto(s) habilita el cliente.
- Extender el token para declarar `velo_pos` / `velo_tech_pos` y gatear el vertical.
- **Prerrequisito:** arreglar la vulnerabilidad de licencia ya identificada en la
  auditoría (una vez arreglada, protege a toda la suite).
- **DoD:** el token habilita/gatea el vertical; un cliente puede tener uno o ambos.

---

## Qué es publicable y cuándo

| Bloque | ¿Afecta a clientes VELO POS? | Cuándo publicar |
|---|---|---|
| F0–R3 (plataforma) | No, si pasa la compuerta | Opcional, como VELO POS idéntico; mejor tras tener canary |
| R4–R8 (TECH POS) | No (producto separado) | Como producto nuevo, canal propio |

## Anti-patrones (recordatorio)
- ❌ Cambiar appId / ruta de datos de VELO POS.
- ❌ Publicar el refactor sin el test de upgrade contra base real.
- ❌ Migraciones que toquen datos existentes.
- ❌ Mover a monorepo sin `verify:packaging` / `verify:marker`.
- ❌ Acoplar el refactor a un release "de paso".

## Orden recomendado para empezar hoy
**F0 → R0** es el arranque seguro: monta las compuertas y hace la costura sin
cambiar comportamiento. Todo en `feat/velo-suite`, sin publicar. A partir de ahí,
cada fase entra con su compuerta verde.
