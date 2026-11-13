# Lecciones de Velo POS Desktop

- Al agregar una reserva fiscal, prueba por separado la reserva, el envío y la
  aceptación con el esquema completo de Desktop. El disparador histórico de NCF
  llenaba la fecha fiscal al guardar cualquier número. La prueba debe verificar
  que un e-NCF reservado o de prueba conserve la fecha fiscal vacía.
- Antes de preparar una publicación de VELO Cloud, toma como base la rama que dice
  `.do/app.yaml` (`branch:`), no `main` ni la rama que esté en el checkout.
  Compruébalo con `git merge-base --is-ancestor origin/<rama> HEAD`. El 12 nov 2026
  un cambio se preparó sobre una rama local con 27 commits menos y se dio por
  probado con 7 pruebas; la batería completa encontró una prueba vieja que fallaba.
- No digas «probado» sin la batería completa. En Cloud: `RUN_DB_TESTS=1 npm test`
  con PostgreSQL desechable y un rol sin superusuario, como el CI. En Desktop:
  `npm run test:tech-readiness`. Si en una base recién creada fallan dos archivos
  con `Unique constraint failed (key)` al sembrar permisos, repítelos solos antes
  de culpar al cambio.
- Antes de crear o reemplazar un archivo, búscalo en la versión publicada
  (`git show <tag>:archivo`), no solo en el checkout: el checkout principal suele
  estar atrasado.
