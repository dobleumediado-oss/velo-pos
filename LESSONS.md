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
