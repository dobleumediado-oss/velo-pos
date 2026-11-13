# Sandbox: probar antes de publicar

[← Volver a CLAUDE.md](../CLAUDE.md) · Relacionados: [Proceso de Release](release-process.md) · [Pasar a VELO Cloud](pasar-a-cloud.md)

Antes de que un cambio llegue a los clientes, pasa por dos pruebas automáticas que
corren en GitHub, sin necesitar ninguna computadora encendida:

| Dónde | Qué prueba | Cuándo |
|---|---|---|
| `velo-pos` → **Actions → Validación Windows de VELO Desktop** | `test:tech-readiness` y la batería completa en Windows | Cada push a `codex/**`, `claude/**`, `fix/**`, `feat/**` o `release/**`, cada PR y a mano |
| `velo-cloud` → **Actions → Sandbox VELO** | Negocios inventados sobre Cloud en modo producción y el cliente real de esta versión de Desktop («Pasar a VELO Cloud») contra esa API | Cada push a Cloud y a mano, eligiendo la versión o rama de Desktop |

**Regla:** no se empuja un tag `v*` sin las dos en verde para el commit que se va a
publicar. Si el cambio toca el diálogo con Cloud (`lib/cloud-direct*.js`), corre el
sandbox de Cloud a mano con `desktop_ref` = tu rama antes de publicar.

## Cómo funciona por dentro

La guía completa del sandbox vive en el repo de Cloud (`cloud/docs/sandbox.md`):

- qué negocios inventados crea;
- qué recorridos prueba;
- cómo levantarlo en la Mac con `scripts/sandbox/up.sh`;
- sus guardas de seguridad: solo bases cuyo nombre dice «sandbox», nunca el `.env` real.

Para usar este Desktop contra el sandbox local de Cloud:

```bash
VELO_CLOUD_API_URL=http://localhost:4100 npm run dev
```

El asistente «Pasar a VELO Cloud» avisa que es un VELO Cloud de prueba. Sin la
variable, Desktop apunta a **producción**.

## Instaladores de prueba

**Actions → Validación Windows de VELO Desktop → Run workflow**, con `buildPilot`
marcado, construye los cuatro instaladores **sin publicarlos** (artefacto de 7 días,
con sus sumas SHA-256). Sirven para revisar en una PC con Windows antes del tag.
