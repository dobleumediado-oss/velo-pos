# Velo POS Server Service

[← Volver a CLAUDE.md](../CLAUDE.md) · [Multi-terminal](multi-terminal-sync.md) · [Release](release-process.md)

## Qué es

Es el motor permanente de Velo POS para instalaciones con varias PC. Windows lo
inicia automáticamente, lo reinicia si falla y lo mantiene activo aunque nadie
abra la interfaz visible.

No es nube y no sube datos a terceros. La base permanece en la PC Servidor:

```text
C:\ProgramData\Velo POS Server\data
```

El servicio se registra como `VeloPOSServer` y usa WinSW 2.12.0, descargado desde
su release oficial y validado durante el build con SHA-256.

## Instaladores entregables

Un release de Windows genera dos archivos:

- `Velo-POS-Server-Setup-X.Y.Z.exe`: solo para la PC que conserva los datos.
- `Velo-POS-Terminal-Setup-X.Y.Z.exe`: para caja, despacho u otras estaciones.

Los dos se publican como assets del mismo GitHub Release. Terminal usa
`latest.yml`; Servidor usa `server.yml`, por lo que cada edición recibe siempre
su instalador correcto al actualizar.

## Qué hace el instalador Servidor

1. Solicita permisos de administrador.
2. Detiene una versión anterior del servicio si existe.
3. Si todavía no hay base en ProgramData, localiza la instalación actual.
4. Crea una copia de seguridad en:
   `C:\ProgramData\Velo POS Server\backups\pre-service-AAAA...`
5. Copia los datos; nunca borra el origen.
6. Instala el servicio con inicio automático retrasado y tres reintentos.
7. Agrega reglas de firewall para Tailscale y LAN privada.
8. Inicia el servicio.
9. La consola visible se autoenlaza por `127.0.0.1`.

En actualizaciones posteriores no vuelve a migrar ni sobrescribe la base existente.
Desinstalar conserva datos, backups y configuración en ProgramData.

## Instalar una terminal

1. Instalar Tailscale si trabajará fuera de la red local e iniciar sesión en la
   misma tailnet autorizada.
2. Ejecutar el instalador Terminal.
3. En Velo POS, abrir Configuración → Modo de conexión → Cliente.
4. Escribir la IP Tailscale o LAN del servidor, puerto 8443 y clave.
5. Copiar el ID de la terminal.
6. En la consola del servidor, autorizar ese ID y asignarlo a todos los negocios
   o a uno específico.
7. Probar conexión y reiniciar la terminal.

## Operación y diagnóstico

En `services.msc` debe aparecer **Velo POS Server Service** en estado En ejecución
y con inicio Automático (inicio retrasado).

Rutas:

- Datos: `C:\ProgramData\Velo POS Server\data`
- Config del gateway: `...\data\server-service.json`
- Backups previos a migración: `...\backups`
- Logs de WinSW: `...\logs`
- Wrapper/XML: `...\service`

El endpoint `http://127.0.0.1:8443/health` devuelve el estado general sin datos
comerciales. Los demás endpoints requieren clave y terminal autorizada.

## Recuperación

Si el servicio no inicia:

1. Revisar `services.msc` y los logs.
2. Confirmar que el puerto 8443 no esté ocupado.
3. Confirmar espacio libre y permisos de ProgramData.
4. No copiar ni abrir `velo.db` manualmente mientras el servicio está activo.
5. Antes de restaurar, detener el servicio y crear otra copia completa del
   directorio `data`.

La base usa WAL y `busy_timeout`; cada negocio tiene un solo proceso escritor. El
supervisor reinicia workers caídos sin reiniciar los demás negocios.

## Compilación

```bash
npm run build:win:terminal
npm run build:win:server
```

El build Servidor ejecuta primero `prepare:server-service`, descarga WinSW oficial
y verifica el hash fijado. El workflow de tags ejecuta pruebas y publica ambos.
