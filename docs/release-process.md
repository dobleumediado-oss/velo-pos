# Proceso de Release — Velo POS Desktop

[← Volver a CLAUDE.md](../CLAUDE.md) · Relacionados: [Visión general](overview.md) · [Impresión](printing-module.md)

Empujar un tag git `v*` es un **deploy a producción a negocios cliente reales**, no una corrida pasiva de CI.

## Mecanismo
1. Bump de `version` en `package.json`.
2. `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. `.github/workflows/release.yml` dispara en push de tag `v*`, corre pruebas en
   `windows-latest` y compila las cuatro ediciones.
4. Publica `Velo-POS-Terminal-Setup-X.Y.Z.exe` + `latest.yml`.
5. Publica `Velo-Tech-POS-Setup-X.Y.Z.exe` + `latest-tech.yml`.
6. Publica `Velo-POS-Server-Setup-X.Y.Z.exe` + `server.yml`.
7. Publica `Velo-Tech-POS-Server-Setup-X.Y.Z.exe` + `server-tech.yml`.
8. `electron-updater` selecciona el canal de su edición; TECH y Servidor nunca
   reciben por error el instalador Terminal.
9. WinSW se descarga desde su release oficial durante el build y se valida por SHA-256.
10. El pipeline completo compila y publica los cuatro instaladores en un único release.

## Riesgo
Es difícil de revertir: una vez que un cliente auto-actualiza, hacer rollback significa enviar una *nueva* versión mayor, no borrar la mala — algunos clientes ya la habrán jalado. No hay staging/canary; tag push = release inmediato a producción para todos.

## Qué hacer antes de taggear
Confirmar **siempre** explícitamente con el usuario antes de empujar un tag, aun si ya pidieron "commit + tag + release" de corrido — confirmar el número de versión (semver: minor para features nuevos user-facing, patch para solo fixes) y si están OK enviando sin un pase de QA en vivo/manual. Ver [Impresión](printing-module.md) para un ejemplo donde el usuario eligió explícitamente enviar sin pruebas de impresora en vivo.
