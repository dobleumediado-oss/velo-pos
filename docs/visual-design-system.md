# Velo Design System 2.0

## Objetivo

Unificar la experiencia visual de Velo POS sin acoplar la presentación a las reglas de negocio. Cada ruta expone `module-page` y `module-{ruta}`; la capa visual utiliza ese contrato para aplicar identidad, jerarquía y estados coherentes.

## Componentes base

- **Armazón:** sidebar, topbar, área de trabajo y navegación activa.
- **Cabecera ejecutiva:** título, contexto y acciones principales.
- **Métricas:** indicador, valor, tendencia y nota operacional.
- **Navegación:** `tabs`, `mod-tabs`, filtros y períodos.
- **Superficies:** tarjetas, tablas, entidades, reportes y paneles financieros.
- **Interacción:** botones, formularios, alertas, estados, modales y retroalimentación.
- **Estados vacíos:** mensaje, contexto y próximo paso útil.
- **Adaptabilidad:** escritorio amplio, portátil y espacio reducido.

## Identidad por área

El sistema mantiene la misma arquitectura y asigna un acento contextual:

- Operaciones: verde y azul.
- Comercial: verde, cian y ámbar.
- Finanzas: azul, índigo, rojo y teal.
- Logística: azul y naranja.
- Administración: violeta, gris y rojo.

El color nunca sustituye el texto, el estado o el valor; solo refuerza la orientación visual.

## Cobertura

La capa común cubre Dashboard, Punto de Venta, Inventario, Compras, Clientes, Ventas, Devoluciones, Vendedores, Nómina, Caja, Gastos, Bancos, Contabilidad, Vehículos, Envíos, Conduces, Sucursales, Reportes, Etiquetas, Configuración, Auditoría y Panel de Desarrollador. El inicio de sesión conserva su experiencia oscura propia y comparte tipografía, controles y retroalimentación.

## Reglas de mantenimiento

1. Reutilizar las clases existentes antes de crear estilos inline.
2. Usar `sec-hdr` únicamente para la cabecera principal o encabezados internos simples.
3. Usar `metrics` y `metric` para indicadores comparables.
4. Encapsular tablas en `card` + `tw` o `ui-table-card`.
5. Representar listados de entidades con `ui-card-grid` y `ui-entity-card`.
6. Conservar acciones destructivas en rojo y acciones primarias en el acento del módulo.
7. Verificar cada cambio a 1280 px y en el punto responsive menor de 780 px.

## Experience 2.0

La capa `src/js/experience.js` amplía el sistema visual sin incorporar reglas de negocio:

- Centro de notificaciones conectado con inventario, créditos, caja, gastos, comisiones y nómina.
- Centro de acciones rápidas disponible con `Ctrl/Cmd + J`.
- Drawers laterales reutilizables para información contextual.
- Tema claro y oscuro por terminal.
- Densidad cómoda o compacta.
- Movimiento suave o reducido para accesibilidad.
- Tablas con ordenamiento y columnas visibles configurables.
- Skeletons de carga para módulos asíncronos.
- Pulso ejecutivo de salud operativa en el Dashboard.

Las preferencias se guardan localmente bajo `vp_ui_preferences_v2`; no modifican la configuración del negocio ni afectan otras terminales.

## Experience 3.0: espacio de trabajo inteligente

La tercera capa convierte la navegación en una herramienta operativa, no solamente estética:

- **Centro de mando:** resume salud operativa, ventas cargadas, riesgo de inventario, cuentas por cobrar y asuntos prioritarios.
- **Siguiente mejor acción:** transforma alertas reales en recomendaciones navegables hacia el módulo que puede resolverlas.
- **Espacio personal:** conserva hasta seis módulos favoritos y los últimos módulos utilizados en cada terminal.
- **Buscador como navegador:** al abrir `⌘K` muestra favoritos, recientes y módulos permitidos antes de escribir; después busca productos, clientes y facturas.
- **Navegación completa por teclado:** flechas para recorrer resultados, `Enter` para abrir, `Escape` para cerrar, `⌘J` para crear y `⌘⇧P` para el centro de mando.
- **Respeto de permisos:** favoritos, recientes y accesos solo muestran rutas que ya están disponibles en el menú del usuario autenticado.

El espacio personal se persiste bajo `vp_ui_workspace_v1`, separado por usuario y negocio activo; no modifica información contable ni reglas del negocio.

## Experience 3.1: guía animada

La guía acompaña el cambio visual con recorridos seguros y contextuales:

- Recorrido breve de las novedades visuales para todos los roles.
- Recorrido administrativo para conexiones entre inventario, ventas, vendedores, gastos, contabilidad y reportes.
- Recorrido operativo para Punto de Venta, clientes, historial y caja.
- Foco animado sobre el elemento explicado y tarjeta posicionada automáticamente sin depender del tamaño de pantalla.
- Progreso pausable y recorridos completados, separados por usuario y negocio.
- Navegación por teclado con `←`, `→`, `Enter` y `Escape`.
- Restauración de la pantalla donde estaba el usuario al terminar o pausar.
- Respeto del movimiento reducido y ausencia de acciones que creen o modifiquen movimientos del negocio.

El centro de recorridos está disponible desde el botón `?` del topbar y desde Apariencia. La invitación automática de actualización se muestra una sola vez y nunca encima de modales, formularios obligatorios o paneles abiertos.

## Experience 3.2: dirección visual del negocio

La cuarta capa lleva los componentes visuales a decisiones y flujos operativos reales:

- **Dashboard personalizable:** cada usuario puede mostrar, ocultar y ordenar pulso ejecutivo, cuentas por cobrar, indicadores, caja, gastos, fiscalidad y análisis. La preferencia queda separada por usuario y negocio.
- **Tendencias compactas:** las métricas muestran minigráficas cuando existe historial real; si no existe, se comunica el estado sin fabricar comparaciones.
- **Perfiles comerciales completos:** cada vendedor dispone de meta, avance, rentabilidad, tendencia de ventas externas, datos operativos y línea de tiempo documental.
- **Calendario empresarial:** comisiones, nóminas, viáticos y recibos ambulantes conviven en una agenda mensual navegable.
- **Flujo visual:** comisiones y nóminas se organizan en borrador, aprobado y pagado, conservando sus acciones reales.
- **Cobertura ambulante:** la vista se organiza con zona y ruta, sin pedir coordenadas técnicas al usuario.
- **Nómina independiente:** usa una identidad visual financiera propia y separa compensación, períodos y pagos de la operación cotidiana de Vendedores.

El tablero se persiste bajo `velo:dashboard-layout:v1:{negocio}:{usuario}`. Las nuevas vistas son presentaciones de datos existentes y respetan las mismas validaciones, permisos, auditoría e integración contable de los módulos de origen.

La revisión `experience-3.2` de la guía animada presenta también el botón de personalización del Dashboard y el nuevo centro visual de Vendedores. Al cambiar la revisión, cada usuario recibe una única invitación para conocer estas novedades.
