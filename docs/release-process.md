# Proceso de Release — Velo POS Desktop

[← Volver a CLAUDE.md](../CLAUDE.md) · Relacionados: [Visión general](overview.md) · [Impresión](printing-module.md)

Empujar un tag git `v*` es un **deploy a producción a negocios cliente reales**, no una corrida pasiva de CI.

## Mecanismo
1. Bump de `version` en `package.json`.
2. `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. `.github/workflows/release.yml` dispara en push de tag `v*`, corre en `windows-latest`, ejecuta `npm run release:win` (`electron-builder --win --publish always`).
4. Publica a GitHub Releases (`owner: dobleumediado-oss`, `repo: velo-pos`) — sube `Velo-POS-Setup-X.Y.Z.exe` + `latest.yml`.
5. Las instalaciones cliente corren `electron-updater` apuntado a los releases de este repo — auto-detectan e instalan la nueva versión, sin descarga manual del dueño del negocio.
6. El pipeline completo (build + publish) toma ~1.5 min — rápido, no un gate largo de CI.

## Riesgo
Es difícil de revertir: una vez que un cliente auto-actualiza, hacer rollback significa enviar una *nueva* versión mayor, no borrar la mala — algunos clientes ya la habrán jalado. No hay staging/canary; tag push = release inmediato a producción para todos.

## Qué hacer antes de taggear
Confirmar **siempre** explícitamente con el usuario antes de empujar un tag, aun si ya pidieron "commit + tag + release" de corrido — confirmar el número de versión (semver: minor para features nuevos user-facing, patch para solo fixes) y si están OK enviando sin un pase de QA en vivo/manual. Ver [Impresión](printing-module.md) para un ejemplo donde el usuario eligió explícitamente enviar sin pruebas de impresora en vivo.
