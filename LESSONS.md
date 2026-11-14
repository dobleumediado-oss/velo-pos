# Lecciones de Velo POS Desktop

- Al agregar una reserva fiscal, prueba por separado la reserva, el envío y la
  aceptación con el esquema completo de Desktop. El disparador histórico de NCF
  llenaba la fecha fiscal al guardar cualquier número. La prueba debe verificar
  que un e-NCF reservado o de prueba conserve la fecha fiscal vacía.

- Confirma la base de la rama antes de escribir código. El 13 nov 2026 el
  recibo de egreso se empezó en la carpeta principal, que estaba en 1.54.2
  (63 commits detrás de `v1.65.3`) y con cambios ajenos sin commitear; se
  descubrió al preparar el commit y hubo que portarlo. Al iniciar, compara
  `HEAD` con la última etiqueta `v*` (`git rev-list --count HEAD..<tag>`) y
  revisa `git worktree list`. Si la rama está atrás, avisa y trabaja en un
  worktree nuevo desde la base correcta.
- Antes de afirmar quién puede mover dinero, lee todos los caminos. Se dijo
  que «el cajero no puede pagar gastos» leyendo solo `expenses:pay`, pero
  `expenses:create` le permite registrar y pagar desde caja hasta
  `cajero_limit` (1500 por defecto). Revisa `create`, `pay` y los flujos
  automáticos, y cita el `archivo:línea` de cada uno.
- Un archivo de la raíz puede existir en la base aunque no esté en tu carpeta:
  agrega a `LESSONS.md`, nunca lo reemplaces.
- Lee `LESSONS.md` desde la última etiqueta (`git show <tag>:LESSONS.md`), no
  desde tu carpeta. El 13-14 nov 2026 la cadena de diseño móvil
  (`feature/mobile-design-v1` a `v8`) se armó sobre 1.54.2, 69 commits detrás
  de `v1.65.4`, repitiendo la lección de arriba: la carpeta principal estaba
  en una rama vieja que no tenía este archivo.
- Un atributo «inofensivo» puede cambiar escritorio. En Servicio técnico,
  cambiar una celda vacía a `<td hidden>` acortaba la fila en escritorio. Para
  cambios móviles, compara capturas de 1280 px antes y después, píxel a píxel,
  ignorando solo zonas que dependen de la hora (reloj, hora de muestra).
- Si editas plantillas `` `...` `` con un script, valida la sintaxis después
  (`node -e "new Function(src)"`). Un rotulador de `<td>` cortó la etiqueta en
  un `>` que estaba dentro de una expresión `${...}`.
- Las rejillas en línea con columnas fijas (`grid-template-columns: 1fr 400px`,
  `minmax(320px, …)`) aplastan la otra columna en pantallas estrechas. En
  Apariencia el texto quedó de un carácter de ancho. Busca `px` en
  `grid-template-columns` antes de dar por adaptado un módulo.
- Un SVG sin tamaño ocupa todo el ancho de su contenedor. El ícono del título
  de Reportes de Conduce medía 625×625 px en escritorio. Dale tamaño en CSS a
  cualquier ícono nuevo fuera de los contenedores que ya lo dimensionan.
- El menú y `routeTo` deciden el acceso por separado y pueden desincronizarse:
  el menú del admin de VELO TECH mostraba Servicio técnico, pero `routeTo` lo
  devolvía al Dashboard. Al agregar un módulo, revisa las dos listas.
- En un banco de pruebas con API falsa, un fallo puede venir de los datos
  falsos. Antes de llamarlo bug, repite la misma prueba sobre la versión base;
  si falla igual, es del banco o es previo, no de tu cambio.
