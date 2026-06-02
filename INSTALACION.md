# Velo POS — Guía de Instalación

## Requisitos

- Windows 10/11 de 64 bits (recomendado) o macOS 11+
- 4GB RAM mínimo
- 500MB espacio libre
- Impresora térmica AOKIA AK-3380 80mm (opcional)

---

## Instalación en Windows

1. Copia el USB al escritorio o descarga el instalador
2. Ejecuta `Velo POS Setup.exe`
3. Sigue el asistente de instalación
4. El sistema se instala en `C:\Program Files\Velo POS\`
5. Los datos se guardan en `C:\Users\TU_USUARIO\AppData\Roaming\Velo POS\data\`

---

## Primer uso

**Credenciales predeterminadas:**
- Admin:  `admin@microparts.do` / `admin123`
- Cajero: `caja@microparts.do`  / `caja123`

⚠️ **Cambia las contraseñas inmediatamente** desde Configuración → Usuarios.

**Pasos iniciales:**
1. Inicia sesión como Admin
2. Ve a Configuración y llena los datos del negocio
3. Configura la impresora térmica
4. Crea los cajeros con sus propias credenciales
5. Agrega los productos al inventario
6. ¡Listo para vender!

---

## Configurar impresora AOKIA 80mm

1. Instala el driver USB de la impresora (incluido en el USB o en el CD del fabricante)
2. Conecta la impresora por USB y enciéndela
3. En Windows, verifica que aparece en Panel de Control → Dispositivos e Impresoras
4. Abre Velo POS → Configuración → Impresora Térmica
5. Haz clic en "Configurar impresora" y selecciona la AOKIA de la lista
6. Haz clic en "Prueba de impresión" para verificar

---

## Backups

- El sistema hace un **backup automático diario** al iniciar
- Los backups se guardan en: `AppData\Roaming\Velo POS\data\backups\`
- Para backup manual: Configuración → Backups → Guardar backup ahora
- Se conservan los últimos 30 días de backups automáticamente
- **Recomendación:** Copia la carpeta `backups` a un USB externo semanalmente

---

## Licencia

El sistema incluye 30 días de período de gracia sin licencia.
Para activar, contacta al proveedor con el **ID de máquina** que aparece en Configuración → Licencia.

---

## Soporte

Para soporte técnico, proporciona:
- Versión del sistema (visible en Configuración)
- ID de máquina
- Descripción del problema

---

## Actualización

Para actualizar el sistema:
1. Haz un backup manual primero
2. Cierra el sistema
3. Ejecuta el nuevo instalador
4. Los datos se conservan automáticamente

