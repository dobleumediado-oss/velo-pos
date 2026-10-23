# Preparación de la migración a Cloud

En Configuración → Backups, **Preparar migración a Cloud** crea un archivo
`.velomigrate` del negocio seleccionado. Solo administración puede crearlo.
En instalaciones con servidor se selecciona la carpeta desde la PC Servidor.
Cada negocio se prepara por separado.

El archivo contiene una copia consistente de SQLite (todas las tablas, también
las de módulos que Cloud todavía no soporta) y los archivos referenciados en
`service_order_evidence`. Se verifican integridad de SQLite, relaciones y
huellas de las evidencias. Si falta una evidencia o fue alterada, la preparación
falla y elimina el archivo incompleto. Los archivos externos no referenciados
en esa tabla no se incluyen; esto no sustituye el respaldo del equipo.

La clave de al menos 12 caracteres no se guarda. El contenido se comprime y
cifra con AES-256-GCM y una clave derivada con scrypt y sal aleatoria. Se verifica
el archivo antes de confirmarlo. Las copias temporales se eliminan al terminar.
La base activa no se reemplaza ni se marca como migrada.

## Alcance pendiente

Esto **prepara una copia inicial**, no es todavía una migración operativa.
No existe aún importación completa en Cloud, captura de operaciones posteriores,
conciliación final ni activación coordinada de terminales. No se debe pedir a
un cliente que abandone Desktop con este archivo. La continuidad sin pérdida
de ventas requiere completar y probar esas partes y la equivalencia de módulos.

## Verificación

`npm run test:cloud-migration-package` usa exclusivamente datos ficticios en
carpetas temporales. Comprueba descifrado independiente, conservación de tablas
desconocidas, valores binarios, saldos y numeración, evidencias, contraseña
incorrecta, alteración, truncamiento, rutas inválidas y limpieza ante errores.
