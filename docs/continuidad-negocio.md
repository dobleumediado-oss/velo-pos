# Continuidad y recuperación por negocio

La copia externa nueva (`.velobackup`) corresponde **al negocio seleccionado**.
Contiene una captura consistente de toda su base SQLite (historial, comprobantes,
auditoría, saldos, numeración, ajustes y datos de los módulos presentes), su
`meta.json` cuando es un negocio secundario y cada archivo de evidencia de
servicio referenciado por la base. No mezcla las bases de otros negocios. La
captura incluye transacciones confirmadas que aún estén en WAL.

El archivo se cifra con AES-256-GCM y una clave elegida por el administrador.
VELO no conserva esa clave. Al crear la copia se autentica y verifica cada
archivo y su huella. «Probar una copia» ensaya la recuperación en una carpeta
temporal, comprueba SQLite, las relaciones y los conteos, y elimina la carpeta.
Las copias anteriores `.veloenc` siguen verificándose, pero contenían solo la
base de datos.

«Recuperar copia en carpeta nueva» produce una carpeta de datos independiente,
sin sustituir la base que está operando. Si se recupera un negocio secundario,
incluye `active_business.json` para seleccionar ese negocio al arrancar una
instalación que use esa carpeta de datos. Antes de poner una recuperación en
producción hay que probar el inicio, comparar documentos, caja, CxC, inventario
y siguiente numeración, además de volver a vincular impresoras, terminales y
licencias de la máquina. No fusionar a mano dos carpetas con actividad posterior
a la fecha de la copia.

En otra instalación Desktop de la **misma edición** (POS o TECH), un superadmin
puede elegir «Incorporar copia como negocio nuevo» en Configuración → Backups.
VELO descifra y verifica el archivo `.velobackup`, crea un negocio nuevo en el
selector de inicio de sesión y pone sus evidencias en una ruta exclusiva. La
base y las evidencias de los negocios ya instalados no se reemplazan. La copia
debe proceder de una versión igual o anterior a la instalada. El acceso al
negocio incorporado usa sus usuarios y contraseñas originales; la licencia,
impresoras y conexiones de la PC nueva se configuran allí. La importación no
fusiona ventas posteriores ni sustituye un negocio existente.

Los backups automáticos y «Crear ahora» son archivos `.db`: cubren toda la
base del negocio seleccionado, pero **no** los archivos externos de evidencia.
El respaldo completo requiere usar «Crear copia externa» y guardar el archivo
fuera de la PC. Un disco externo conectado permanentemente a la misma PC no
protege contra todos los fallos físicos o robos.

«Preparar migración a Cloud» usa la misma base de captura y verificación para
producir `.velomigrate` por negocio. Ese archivo conserva datos originales para
revisión; **no** activa el negocio en Cloud. El importador Cloud sigue sin
equivalencias operativas para todos los módulos ni sincronización de cambios
posteriores a la captura. La activación debe quedar bloqueada hasta conciliar
documentos, NCF, caja, deudas, inventario y auditoría, coordinar el corte final
y comprobar que Desktop deja de emitir nuevos documentos. Ver
[`cloud/docs/velo-cloud-migracion-completa.md`](../cloud/docs/velo-cloud-migracion-completa.md).
