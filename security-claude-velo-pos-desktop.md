# security-claude-velo-pos-desktop.md — Seguridad, calidad, bugs y mantenibilidad para VELO POS Desktop

## 0. Propósito

Este archivo complementa el `CLAUDE.md` principal de VELO POS Desktop.

Debe usarse cuando Claude Code tenga que auditar, corregir y fortalecer el proyecto desde el punto de vista de:

- Seguridad.
- Bugs.
- Vulnerabilidades.
- Calidad de código.
- Mantenibilidad.
- Dependencias vulnerables.
- Seguridad Electron / Node.js.
- Seguridad de base de datos local.
- Seguridad de APIs locales/remotas.
- Seguridad fiscal dominicana.
- RNC / DGII.
- Comprobantes fiscales / NCF.
- e-CF mediante MCSeller.
- Caja.
- Inventario.
- Cuentas por cobrar.
- Migraciones históricas.
- Importaciones desde BAK/CSV.
- Impresoras.
- Releases.
- Auto-updates.
- Protección de datos reales de clientes.

VELO POS Desktop debe tratarse como un sistema comercial serio, no como un POS básico. Debe ser seguro, estable, auditable y listo para producción.

---

## 1. Regla principal

Claude Code NO debe empezar corrigiendo sin antes auditar.

Siempre debe trabajar así:

1. Leer este archivo completo.
2. Leer el `CLAUDE.md` principal del proyecto.
3. Analizar estructura, stack, scripts, base de datos, Electron, backend, frontend, servicios, integraciones y módulos.
4. Ejecutar solo comandos seguros de lectura y diagnóstico.
5. Entregar reporte inicial.
6. Clasificar riesgos por severidad.
7. Proponer plan de corrección por fases.
8. Pedir confirmación antes de cambios grandes.
9. Corregir por fases.
10. Probar después de cada fase.
11. Documentar archivos tocados, riesgos y pruebas.
12. Nunca romper datos importados, ventas, caja, inventario, comprobantes ni e-CF.

---

## 2. Mentalidad de auditoría

Trabaja con mentalidad parecida a:

### ZAP / OWASP ZAP

Para revisar:

- APIs locales o remotas.
- Endpoints.
- Formularios.
- Autenticación.
- Autorización.
- CORS.
- Cabeceras.
- Exposición de datos.
- OWASP Top 10.
- Broken Access Control.
- IDOR.
- Inyección.
- XSS si hay webview.
- File traversal.
- SSRF en llamadas externas.

No ejecutar active scans contra producción ni terceros sin autorización.

### Snyk

Para revisar:

- Dependencias vulnerables.
- Dependencias transitivas.
- Lockfiles.
- Electron vulnerable.
- Paquetes obsoletos.
- Paquetes abandonados.
- Scripts riesgosos.
- Secrets.
- Supply chain.
- Actualizaciones seguras.

No usar `npm audit fix --force` sin autorización.

### SonarSource / SonarQube

Para revisar:

- Bugs.
- Code smells.
- Vulnerabilidades.
- Hotspots.
- Duplicación.
- Complejidad.
- Mantenibilidad.
- Confiabilidad.
- Quality gates.

---

## 3. Fase 1 obligatoria — Reconocimiento seguro

Antes de modificar código, ejecutar comandos de solo lectura.

```bash
pwd
ls
find . -maxdepth 3 -type f | sed 's#^./##' | sort | head -400
```

Revisar si existen:

```text
package.json
package-lock.json
pnpm-lock.yaml
yarn.lock
main.js
main.ts
preload.js
preload.ts
electron-main/
src/
renderer/
public/
dist/
release/
build/
data/
database/
db/
migrations/
scripts/
server/
api/
.env
.env.example
electron-builder.yml
builder.config.*
vite.config.*
tsconfig.json
```

Si existe `package.json`:

```bash
cat package.json
npm run
```

No modificar archivos en esta fase.

Reporte inicial obligatorio:

- Stack detectado.
- Versión/uso de Electron si existe.
- Versión/uso de Node.
- Arquitectura main/preload/renderer.
- Base de datos detectada.
- Scripts disponibles.
- Módulos existentes.
- Integraciones existentes.
- Archivos sensibles.
- Riesgos críticos.
- Plan por fases.

---

## 4. Comandos de diagnóstico permitidos

Solo después de entender el proyecto:

```bash
npm audit --audit-level=moderate
npm outdated
npm ls --depth=0
npx tsc --noEmit
npm run lint
npm test
npm run test
npm run build
```

Si existen scripts propios:

```bash
npm run release:check
npm run pack
npm run dist
```

No ejecutar publicación, push, tag, release ni auto-update sin autorización.

Comando sensible de Git:

```bash
git status
git ls-files | grep -E '(^\.env$|^data/|vendor-private|\.pem$|\.key$|\.p12$|backup|dump|\.sqlite|\.db|logs?)'
```

No hacer commit, push, tag ni release sin autorización explícita.

---

## 5. Quality Gates

No considerar una fase terminada si existe alguno de estos problemas sin resolver o documentar:

- Login roto.
- Permisos rotos.
- POS roto.
- Caja rota.
- Inventario roto.
- Cuentas por cobrar rotas.
- Facturación rota.
- Comprobantes fiscales rotos.
- e-CF/MCSeller roto.
- Impresión rota.
- Migración/importación histórica rota.
- Build roto.
- Typecheck roto en zonas modificadas.
- Tests críticos rotos.
- `.env` o secretos trackeados.
- Credenciales MCSeller expuestas.
- NCF duplicable.
- e-CF duplicable.
- Caja manipulable sin auditoría.
- Inventario manipulable sin auditoría.
- IPC inseguro.
- Renderer con Node expuesto sin control.
- Auto-update inseguro.
- Release que incluya data real, backups, logs o claves.

---

## 6. Clasificación de severidad

### Crítico

- Bypass de login.
- Bypass de roles/permisos.
- Contraseñas en texto plano.
- Credenciales expuestas.
- Credenciales MCSeller expuestas.
- `.env` trackeado.
- Ejecución remota de código.
- IPC permite ejecutar comandos arbitrarios.
- Renderer expone Node sin control.
- Inyección SQL/NoSQL.
- NCF duplicable.
- e-CF duplicable.
- Venta fiscal sin trazabilidad.
- Caja manipulable sin auditoría.
- Inventario manipulable sin auditoría.
- Importación histórica corrompe datos.
- Release con datos reales del cliente.

### Alto

- Endpoint local/remoto sin auth.
- API sensible sin permisos.
- Dependencia con CVE alta.
- Falta de transacciones en ventas.
- Falta de idempotencia en e-CF.
- Falta de control de crédito en backend.
- Logs con datos sensibles.
- Backups sin protección.
- Impresión fiscal incorrecta.
- Auto-update sin validación.
- Permisos solo en frontend.
- IPC sin validar payload.

### Medio

- Duplicación alta.
- Código muerto.
- Componentes enormes.
- Servicios mezclados con UI.
- Falta de paginación.
- Falta de índices.
- Queries lentas.
- Dependencias obsoletas.
- Errores mal manejados.
- Falta de pruebas.

### Bajo

- Nombres inconsistentes.
- Imports innecesarios.
- UI desalineada.
- Mensajes mejorables.
- Comentarios faltantes.

---

## 7. Seguridad específica de Electron

Si VELO POS Desktop usa Electron, auditar obligatoriamente:

### BrowserWindow

Revisar:

- `nodeIntegration`
- `contextIsolation`
- `sandbox`
- `enableRemoteModule`
- `webSecurity`
- `allowRunningInsecureContent`
- `preload`
- `devTools`
- navegación externa
- `window.open`
- `webview`

Configuración recomendada:

```text
nodeIntegration: false
contextIsolation: true
sandbox: true cuando sea posible
enableRemoteModule: false
webSecurity: true
allowRunningInsecureContent: false
```

### Preload

Debe:

- Usar `contextBridge`.
- Exponer solo APIs mínimas.
- No exponer `ipcRenderer` completo.
- No exponer `fs` completo.
- No exponer `require`.
- No exponer comandos del sistema.
- Validar argumentos.
- No exponer secretos.

Prohibido:

```js
window.ipcRenderer = ipcRenderer
window.fs = fs
window.require = require
```

### IPC

Cada canal IPC debe tener:

- Nombre claro.
- Validación de payload.
- Validación de sesión.
- Validación de permiso.
- Manejo de errores.
- Auditoría si es sensible.
- Restricción de rutas/archivos.
- Sin ejecución arbitraria.

Canales críticos:

- ventas
- caja
- inventario
- clientes
- crédito
- comprobantes
- e-CF
- MCSeller
- impresión
- backups
- migraciones
- importaciones
- exportaciones
- configuración
- actualizaciones
- logs

### Navegación

Bloquear:

- URLs remotas no autorizadas.
- `window.open` inseguro.
- Webviews no controlados.
- DevTools en producción salvo modo soporte.
- Carga de contenido inseguro.

### Auto-update

Auditar:

- Fuente de updates.
- Firma/integridad.
- Canal estable/beta.
- Rollback.
- Downgrade attack.
- Release notes.
- Backup antes de migrar datos.
- No actualizar durante venta, cierre de caja, importación o emisión fiscal.

---

## 8. Base de datos local

Auditar:

- Ubicación de DB.
- Permisos del archivo.
- Backups.
- Migraciones.
- Transacciones.
- Constraints.
- Índices.
- Relaciones.
- Corrupción por cierre inesperado.
- Data real en repo.
- Dumps.
- Logs.
- Copias temporales.

Reglas:

1. Ventas usan transacción.
2. Caja usa transacción.
3. Inventario usa transacción.
4. Abonos usan transacción.
5. Venta fiscal usa transacción.
6. Secuencia NCF se reserva/confirma de forma segura.
7. e-CF debe ser idempotente.
8. Migraciones deben ser idempotentes.
9. Crear backup antes de migración destructiva.
10. No borrar ventas; anular/reversar.
11. No borrar abonos; anular/reversar.
12. No borrar movimientos de inventario.
13. No alterar históricos sin auditoría.
14. No permitir duplicidad de NCF.
15. No permitir stock negativo salvo política explícita.

---

## 9. Importaciones históricas / BAK / CSV

Proteger especialmente:

- Clientes.
- Inventario.
- Ventas históricas.
- Facturas a crédito.
- Abonos.
- Cuentas por cobrar.
- Costos.
- Existencias.
- NCF históricos.
- Fechas.
- Balances.
- Relaciones factura-abono.
- IDs de origen.
- Duplicados.
- Mapeo de campos.
- Normalización.

Reglas:

1. Nunca sobrescribir datos importados sin backup.
2. Nunca borrar históricos sin confirmación.
3. Mantener `legacy_id` o referencia de origen.
4. Validar totales antes/después.
5. Validar balance de clientes.
6. Validar inventario.
7. Validar CxC.
8. Validar abonos aplicados.
9. Generar reporte de diferencias.
10. Usar staging/import preview antes de importar definitivo.
11. Si hay error, rollback.
12. No mezclar data de prueba con data real.
13. No duplicar clientes/productos/facturas silenciosamente.
14. Ventas históricas no deben alterar caja actual.
15. NCF histórico no debe reemitirse.

Pruebas obligatorias:

- Total inventario antes/después.
- Total CxC antes/después.
- Facturas crédito con balance correcto.
- Abonos aplicados correctamente.
- Clientes no duplicados.
- Productos no duplicados.
- Reporte de diferencias.
- Rollback probado.

---

## 10. Seguridad fiscal dominicana

Auditar:

- RNC.
- DGII.
- NCF.
- Tipos de comprobante.
- Secuencias.
- Vencimiento.
- ITBIS.
- Facturas.
- Notas de crédito.
- Notas de débito.
- Anulaciones.
- e-CF.
- MCSeller.
- Reportes fiscales.

Reglas:

1. Nunca generar NCF solo en frontend.
2. Nunca duplicar NCF.
3. No emitir comprobante vencido sin política clara.
4. No saltar secuencias sin auditoría.
5. No anular fiscal sin permiso.
6. No emitir nota de crédito sin documento original.
7. Toda factura fiscal debe tener trazabilidad.
8. Toda e-CF debe tener estado.
9. Toda falla e-CF debe registrarse.
10. Toda configuración fiscal debe auditarse.
11. Alertar secuencias próximas a agotarse.
12. Cambios de RNC deben auditarse.
13. Reporte fiscal debe cuadrar con ventas.
14. Impresión debe mostrar datos fiscales correctos.

---

## 11. RNC / DGII

Auditar:

- Formato.
- Normalización.
- Consulta externa.
- Timeout.
- Cache.
- Fallback.
- Duplicados.
- Edición manual.
- Auditoría.
- Fuente.
- Fecha de validación.

Reglas:

1. No bloquear operación por caída externa salvo política.
2. No permitir RNC duplicado sin advertencia.
3. No editar RNC sin permiso.
4. Registrar cambio de RNC.
5. Guardar razón social anterior y nueva.
6. No exponer errores internos.
7. Proteger RNC de empresa.
8. Proteger RNC de clientes/proveedores.

---

## 12. e-CF / MCSeller

Auditar:

- Credenciales.
- Ambiente pruebas/producción.
- Token.
- Endpoint.
- Payload.
- Response.
- Logs.
- Cola.
- Reintentos.
- Idempotencia.
- Estados.
- Relación con venta.
- Relación con NCF.
- Errores.
- Reenvío.
- Cancelación.
- Notas.

Reglas:

1. Credenciales nunca en frontend.
2. Credenciales nunca en texto plano.
3. No imprimir credenciales en logs.
4. Diferenciar prueba y producción.
5. Cada envío debe tener ID único.
6. No duplicar e-CF.
7. Si MCSeller falla, marcar pendiente.
8. Reintentos controlados.
9. No reintentar indefinidamente.
10. Mostrar error claro al usuario.
11. Mostrar diagnóstico al desarrollador.
12. Guardar payload/response de forma segura.
13. No cambiar ambiente sin permiso.
14. No reenviar sin auditoría.

Estados esperados:

- No requerido.
- Pendiente.
- En cola.
- Enviado.
- Aceptado.
- Rechazado.
- Error temporal.
- Error permanente.
- Reintento pendiente.
- Anulado.
- Nota emitida.

---

## 13. POS / Ventas

Auditar:

- Carrito.
- Cliente.
- Precios.
- Costos.
- Descuentos.
- ITBIS.
- Tipo venta.
- Crédito.
- Pago mixto.
- Stock.
- Comprobante.
- Impresión.
- Anulación.
- Devolución.
- Auditoría.

Reglas:

1. Precio final se valida en servicio/backend.
2. Descuento valida permiso.
3. Crédito valida límite.
4. Cliente en mora alerta/bloquea según política.
5. Stock se valida antes de confirmar.
6. Venta es transaccional.
7. Error de impresión no duplica venta.
8. Error e-CF deja venta pendiente de e-CF.
9. Anulación requiere permiso y motivo.
10. Devolución requiere factura original.
11. No borrar venta; anular/reversar.
12. No modificar históricos sin auditoría.
13. No vender sin caja abierta si la política lo exige.
14. No manipular totales desde UI.

---

## 14. Caja

Auditar:

- Apertura.
- Fondo inicial.
- Ventas.
- Cobros.
- Egresos.
- Ingresos.
- Cierre.
- Diferencia.
- Arqueo.
- Reporte.
- Impresión.

Reglas:

1. Caja abierta para vender si la política lo exige.
2. Caja no se cierra dos veces.
3. Cajero no manipula caja ajena sin permiso.
4. Diferencia requiere motivo.
5. Egreso requiere permiso.
6. Anulación de pago requiere permiso.
7. Cierre guarda snapshot.
8. Cierre se imprime.
9. Cierre se audita.
10. No borrar movimientos.
11. Pago mixto cuadra.
12. Cobro crédito afecta caja y CxC.

---

## 15. Inventario

Auditar:

- Productos.
- Costos.
- Precios.
- Stock.
- Stock mínimo.
- Movimientos.
- Ajustes.
- Entradas.
- Salidas.
- Compras.
- Ventas.
- Transferencias.
- Devoluciones.
- Daños.
- Inventario valorizado.

Reglas:

1. Venta baja stock.
2. Devolución sube stock o va a devolución/daño.
3. Ajuste requiere motivo y permiso.
4. Cambio de costo requiere permiso.
5. Cambio de precio requiere permiso.
6. Stock negativo solo con política explícita.
7. Movimiento guarda usuario y referencia.
8. Inventario valorizado usa costo correcto.
9. Reporte inventario cuadra con movimientos.
10. No borrar movimientos.
11. SKU/código duplicado debe advertir.
12. Importaciones validan duplicados.

---

## 16. Cuentas por cobrar y crédito

Auditar:

- Clientes.
- Facturas crédito.
- Balance.
- Abonos.
- Estado de cuenta.
- Vencimientos.
- Mora.
- Límite.
- Días de crédito.
- Vendedor asignado.
- Reportes.

Reglas:

1. Venta crédito valida límite.
2. Cliente vencido alerta/bloquea según política.
3. Abono reduce balance.
4. Abono genera recibo.
5. Abono afecta caja si corresponde.
6. Abono se audita.
7. No borrar abonos; anular/reversar.
8. Estado de cuenta cuadra.
9. Balance cliente cuadra con facturas y abonos.
10. Vendedor solo ve clientes asignados si aplica.
11. Cambio de límite requiere permiso.
12. Facturas importadas mantienen balance correcto.

---

## 17. Proveedores y compras

Auditar:

- Proveedores.
- RNC proveedor.
- Compras.
- Órdenes.
- Recepción.
- Costos.
- CxP si existe.
- Inventario.
- NCF proveedor si aplica.

Reglas:

1. Compra sube inventario.
2. Costo se actualiza según política.
3. Cambio de costo requiere permiso.
4. Proveedor con RNC se valida si aplica.
5. Compra se audita.
6. Recepción parcial se soporta o bloquea claramente.
7. No borrar compras históricas.
8. Devolución a proveedor genera movimiento.

---

## 18. Reportes

Auditar:

- Ventas.
- Caja.
- Inventario.
- CxC.
- Clientes.
- Compras.
- Utilidad.
- Fiscal.
- Vendedores.
- Exportaciones.
- Impresión.

Reglas:

1. Cajero no ve utilidad salvo permiso.
2. Cajero no ve costos salvo permiso.
3. Reporte fiscal cuadra con facturas.
4. Reporte caja cuadra con cierre.
5. Reporte inventario cuadra con movimientos.
6. Exportación se audita.
7. PDF/Excel no expone datos indebidos.
8. Filtros se validan.
9. Reportes grandes se paginan/optimizan.
10. No datos falsos en reportes críticos.

---

## 19. Impresión

Auditar:

- Ticket.
- Factura.
- Cotización.
- Recibo.
- Conduce.
- Cierre de caja.
- Reporte.
- 80mm.
- 58mm.
- Carta.
- PDF.
- Logo.
- Márgenes.
- Copias.
- Corte.
- Plantillas.

Reglas:

1. Impresión no duplica venta.
2. Reimpresión fiscal se audita.
3. Factura fiscal muestra NCF/e-CF correcto.
4. Recibo muestra abono correcto.
5. Cierre muestra totales correctos.
6. Plantillas configurables.
7. Prueba de impresora no afecta datos.
8. Error de impresión permite reintento.
9. Impresora caída no congela sistema.
10. No imprimir comprobante fiscal incorrecto.

---

## 20. Releases, updates y distribución

Auditar:

- Versionado.
- Build.
- Instalador.
- Auto-update.
- Firma.
- Release notes.
- Migraciones post-update.
- Backup antes de update.
- Rollback.
- Archivos incluidos.
- Datos reales.
- Logs.
- DB local.
- `.env`.

Reglas:

1. No incluir DB real en release.
2. No incluir `.env`.
3. No incluir backups.
4. No incluir logs.
5. No incluir claves.
6. No publicar sin `release:check`.
7. No tag/push sin autorización.
8. Update no borra datos del cliente.
9. Migración de update requiere backup.
10. Rollback documentado.
11. No actualizar durante venta/caja/e-CF/importación.

Checklist:

```bash
npm run release:check
git status
git ls-files | grep -E '(^\.env$|^data/|vendor-private|\.pem$|\.key$|\.p12$|backup|dump|\.sqlite|\.db|logs?)'
```

---

## 21. Archivos sensibles

Proteger:

- `.env`
- `.env.local`
- `.env.production`
- `.npmrc`
- certificados
- `.pem`
- `.key`
- `.p12`
- credenciales MCSeller
- tokens API
- claves JWT
- claves DB
- backups
- dumps
- archivos fiscales
- exportaciones
- logs
- DB local
- datos de clientes

Si encuentra secretos:

1. No imprimirlos.
2. Informar que existen.
3. Recomendar rotación.
4. Mover fuera del repo.
5. Actualizar `.gitignore`.
6. Limpiar historial si fueron commiteados.
7. No hacer push.

---

## 22. Logs y auditoría

Logs permitidos:

- ID evento.
- Usuario ID.
- Rol.
- Sucursal.
- Módulo.
- Acción.
- Resultado.
- Código error.
- Timestamp.
- Referencia documento.
- Estado e-CF.
- Estado impresión.
- Estado caja.
- Estado migración.

No loguear:

- Contraseñas.
- Tokens.
- Credenciales MCSeller.
- Claves privadas.
- Datos completos de tarjeta.
- `.env`.
- Stack traces visibles al usuario.
- Payload fiscal completo sin protección.

Auditar:

- Login/logout.
- Intentos fallidos.
- Cambio contraseña.
- Cambio rol/permiso.
- Venta.
- Anulación.
- Devolución.
- Descuento.
- Cambio precio/costo.
- Ajuste inventario.
- Compra.
- Transferencia.
- Abono.
- Apertura/cierre caja.
- Diferencia caja.
- Reimpresión fiscal.
- Emisión/anulación NCF.
- Envío/error e-CF.
- Configuración fiscal.
- Configuración MCSeller.
- Configuración impresora.
- Importación.
- Migración.
- Exportación.
- Backup/restauración.
- Release/update.

---

## 23. Calidad y mantenibilidad

Detectar y corregir gradualmente:

- Código duplicado.
- Código muerto.
- Funciones largas.
- Componentes gigantes.
- Lógica de negocio en UI.
- Servicios mezclados.
- Imports rotos.
- Variables sin uso.
- Tipos débiles.
- Promesas sin manejo.
- Queries repetidas.
- SQL concatenado.
- Falta de transacciones.
- Falta de validaciones.
- Falta de helpers fiscales.
- Falta de helpers monetarios.
- Falta de helpers de fecha.
- Falta de pruebas.
- Estilos duplicados.
- Pantallas lentas.

Reglas:

1. Refactor por módulo.
2. No refactor global a ciegas.
3. Proteger comportamiento existente.
4. No romper importación histórica.
5. No mezclar rediseño visual con seguridad crítica.
6. Separar UI, servicios, repositorios y validaciones.
7. Documentar cambios.

---

## 24. Rendimiento y estabilidad

Auditar:

- Tiempo de arranque.
- Dashboard.
- POS.
- Búsqueda productos.
- Búsqueda clientes.
- Ventas con muchos productos.
- Reportes grandes.
- Impresión.
- Migraciones.
- Backups.
- Memoria.
- Main process bloqueado.
- Queries lentas.
- Índices.

Reglas:

1. No bloquear main process.
2. Usar workers/procesos cuando aplique.
3. Paginar tablas grandes.
4. Indexar búsquedas críticas.
5. No cargar inventario completo si no hace falta.
6. Loading por sección.
7. Error por widget.
8. No congelar POS durante impresión.
9. No congelar POS durante reportes.
10. No congelar POS durante backup.

---

## 25. Fases obligatorias

### Fase 1 — Reconocimiento seguro

- Stack.
- Electron.
- DB.
- Scripts.
- Integraciones.
- Archivos sensibles.
- Riesgos.
- Sin cambios.

### Fase 2 — Seguridad Electron/Node

- Main.
- Renderer.
- Preload.
- IPC.
- FS.
- DevTools.
- Navegación.
- Auto-update.

### Fase 3 — Dependencias

- Audit.
- Outdated.
- Vulnerabilidades.
- Actualizaciones seguras.
- Build/test.

### Fase 4 — Seguridad fiscal

- RNC.
- DGII.
- NCF.
- e-CF.
- MCSeller.
- ITBIS.
- Reportes fiscales.

### Fase 5 — POS, caja e inventario

- Ventas.
- Caja.
- Inventario.
- Descuentos.
- Crédito.
- Anulaciones.
- Devoluciones.

### Fase 6 — Importaciones y migraciones

- BAK/CSV.
- Clientes.
- Inventario.
- Facturas.
- Abonos.
- Balances.
- Rollback.

### Fase 7 — Reportes e impresión

- Reportes.
- Exportaciones.
- Plantillas.
- Impresoras.
- Cierres.
- Reimpresión.

### Fase 8 — Calidad y mantenibilidad

- Refactor seguro.
- Validaciones.
- Servicios.
- Repositorios.
- Tests.
- Errores.

### Fase 9 — Release seguro

- release:check.
- Git.
- Archivos sensibles.
- Build.
- Instalador.
- Auto-update.
- Versionado.

---

## 26. Pruebas manuales mínimas

### Login y roles

- Admin.
- Gerente.
- Cajero.
- Vendedor.
- Contabilidad.
- Almacén.
- Soporte/desarrollador.

### POS

- Venta contado.
- Venta crédito.
- Pago mixto.
- Descuento permitido.
- Descuento sin permiso.
- Producto sin stock.
- Cliente con mora.
- Cliente con RNC.
- Factura con NCF.
- Factura e-CF.
- Impresión.
- Reimpresión.

### Caja

- Apertura.
- Venta.
- Cobro.
- Egreso.
- Ingreso.
- Cierre.
- Diferencia.
- Reporte.
- Reapertura no permitida.

### Inventario

- Venta baja stock.
- Compra sube stock.
- Ajuste con motivo.
- Devolución.
- Producto duplicado.
- Stock negativo bloqueado.
- Inventario valorizado.

### Fiscal/e-CF

- NCF único.
- Secuencia agotada.
- Secuencia vencida.
- e-CF pendiente.
- e-CF aceptado.
- e-CF rechazado.
- Reintento.
- Error MCSeller.
- Nota de crédito.

### Importación

- Clientes.
- Inventario.
- Facturas crédito.
- Abonos.
- Balance.
- Duplicados.
- Rollback.
- Reporte diferencias.

### Release

- No `.env`.
- No DB real.
- No backups.
- No logs.
- Build correcto.
- Versionado correcto.
- Update no borra data.

---

## 27. Formato de reporte obligatorio

```md
# Reporte de Seguridad y Calidad — VELO POS Desktop

## Resumen ejecutivo

## Stack detectado

## Arquitectura Electron/Node detectada

## Base de datos detectada

## Scripts disponibles

## Comandos ejecutados

## Hallazgos críticos

## Hallazgos altos

## Hallazgos medios

## Hallazgos bajos

## Riesgos Electron

## Riesgos IPC

## Riesgos de base de datos local

## Riesgos de dependencias

## Riesgos POS/Caja

## Riesgos Inventario

## Riesgos Cuentas por Cobrar

## Riesgos Fiscal/RNC/NCF

## Riesgos e-CF/MCSeller

## Riesgos de impresión

## Riesgos de importación/migración

## Riesgos de release/update

## Archivos sensibles detectados

## Plan de corrección por fases

## Cambios recomendados

## Cambios que NO deben hacerse todavía

## Pruebas necesarias

## Próximo paso recomendado
```

---

## 28. Formato de corrección obligatorio

```md
# Corrección aplicada — VELO POS Desktop

## Fase

## Problema corregido

## Severidad

## Archivos modificados

## Qué se cambió

## Por qué se cambió

## Riesgos

## Cómo probar

## Resultado de pruebas

## Pendientes
```

---

## 29. Prompt operativo recomendado

Usa este prompt con Claude Code:

```text
Lee completamente security-claude-velo-pos-desktop.md y CLAUDE.md.

Actúa como auditor senior de seguridad, calidad, bugs, dependencias vulnerables, Electron, Node.js, APIs, POS, facturación dominicana, RNC/DGII, NCF, e-CF/MCSeller, caja, inventario, migraciones y releases.

Inspírate en la metodología de ZAP, Snyk y SonarSource, pero no asumas que esas herramientas están instaladas. Primero detecta stack, scripts, arquitectura, herramientas disponibles y riesgos.

Comienza con la Fase 1: Reconocimiento seguro. No modifiques código todavía. Ejecuta solo comandos seguros de lectura y diagnóstico. Luego entrégame un reporte completo con hallazgos críticos, altos, medios y bajos, riesgos Electron/IPC, dependencias vulnerables, calidad del código, seguridad fiscal, seguridad e-CF/MCSeller, RNC/DGII, POS, caja, inventario, importaciones históricas, impresión, releases y plan de corrección por fases.
```

---

## 30. Reglas de no negociación

Claude Code no debe:

- Modificar código antes de auditar.
- Ejecutar active scan contra producción.
- Actualizar dependencias con `--force`.
- Borrar archivos sin explicar.
- Borrar datos históricos.
- Romper importaciones.
- Romper login.
- Romper permisos.
- Romper ventas.
- Romper caja.
- Romper inventario.
- Romper CxC.
- Romper comprobantes.
- Romper e-CF.
- Romper impresión.
- Romper release/update.
- Exponer secretos.
- Imprimir credenciales.
- Permitir NCF duplicados.
- Permitir e-CF duplicados.
- Dejar IPC inseguro.
- Dejar Node expuesto en renderer sin control.
- Incluir DB real en release.
- Incluir `.env` en release.
- Hacer commit/push/tag sin autorización.
- Dar por segura una protección que solo existe en frontend.
- Dar por terminada una fase sin pruebas.

---

## 31. Resultado esperado

VELO POS Desktop debe quedar:

- Más seguro.
- Más estable.
- Más mantenible.
- Con menos bugs.
- Con dependencias controladas.
- Con Electron seguro.
- Con IPC controlado.
- Con base de datos local protegida.
- Con ventas transaccionales.
- Con caja auditable.
- Con inventario consistente.
- Con CxC cuadrada.
- Con RNC/DGII controlado.
- Con NCF seguro.
- Con e-CF/MCSeller trazable.
- Con impresión confiable.
- Con importaciones protegidas.
- Con reportes seguros.
- Con releases limpios.
- Con actualizaciones seguras.
- Listo para producción comercial.
