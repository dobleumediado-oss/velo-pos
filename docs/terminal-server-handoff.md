# Traslado de terminales a otro Server

## Alcance

El respaldo `.velobackup` es por negocio. No incluye la identidad de red, la
clave ni las autorizaciones del servicio Windows. Una terminal guarda su ID,
servidor, puerto, clave y negocio seleccionado en esta PC. Una migración de
Server debe trasladar esas autorizaciones y traducir los IDs de negocio antes
de cambiar la conexión de las cajas.

El servidor anterior puede avisar a terminales que ya se conectan a él. No puede
contactar una terminal apagada ni hacer que una versión antigua entienda un
aviso nuevo. Por eso ambos Servers y las terminales deben tener la versión que
incluya esta función antes de preparar el traslado. El servidor anterior queda
encendido hasta comprobar que todas recibieron el destino nuevo.

## Secuencia de corte

En **Configuración → Modo de Conexión → Trasladar terminales a otro Server**,
elige si la PC es el Server anterior o el nuevo. La pantalla muestra solo las
acciones de ese equipo y organiza el trabajo en **Preparar → Copiar → Vincular →
Trasladar**. El Server anterior resume los negocios y terminales; la validación
del destino comprueba identidad, autorización, negocios y versión después de
recibir las copias y el perfil. Cada terminal prueba las direcciones LAN o
Tailscale disponibles antes de cambiar su conexión.

1. Instalar y probar el Server nuevo en LAN y Tailscale, sin llevar terminales.
2. Mostrar los negocios y terminales del Server anterior, incluyendo qué negocio
   usa cada terminal. El operador comprueba que todos los negocios a migrar
   están incluidos.
3. Poner el Server anterior en mantenimiento para bloquear nuevas operaciones.
   Desde ese momento no puede emitirse una factura ni modificar caja o inventario.
4. Crear una copia externa final de **cada** negocio, incorporarla en el Server
   nuevo y verificar documentos, NCF, caja, inventario y auditoría. Cada negocio
   recuperado debe mostrar la fecha de captura posterior al inicio del bloqueo.
   Si ya se incorporó una copia para revisión, permanece separada: al recibir
   el perfil, VELO la señala como preliminar y señala cuál es la copia final.
   No operar ventas sobre la preliminar.
5. Exportar desde el Server anterior el perfil cifrado de terminales y recibirlo
   en el nuevo con la clave de traslado. En el destino se relaciona cada ID de
   negocio anterior con exactamente uno recuperado; no se conceden permisos a
   negocios ajenos.
6. En el Server anterior, introducir las direcciones LAN y Tailscale del nuevo.
   Se comprueban identidad, autorización, negocios y versión antes de guardar
   el plan. Seleccionar una terminal piloto: el Server anterior le anuncia el
   destino por la conexión existente. La terminal prueba el nuevo Server antes
   de guardar IP, puerto y negocio en una transacción.
7. Confirmar que la terminal piloto figura como conectada en el nuevo Server.
   Después activar el cambio para las demás y observar cuáles respondieron.
   El Server anterior permanece bloqueado para evitar dos fuentes de verdad.

El flujo debe poder cancelarse antes de activar el destino. Después de que una
terminal haya emitido documentos en el Server nuevo, volver al antiguo exige una
conciliación; no se ofrece un botón de reversión automática.

## Límites de seguridad

- Nunca aceptar una dirección pública arbitraria. Solo LAN privada o Tailscale.
- La solicitud de traslado requiere superadmin en ambos Servers y un perfil
  cifrado con clave de al menos 12 caracteres. El perfil se abre en el nuevo
  Server y no se conserva descifrado en un archivo temporal.
- La clave de acceso no aparece en un aviso ni en los logs. Los IDs y permisos
  se copian solo al Server validado; la consola nueva conserva su propio acceso.
- El Server anterior no anuncia el cambio hasta que todos los negocios estén
  recuperados, la fuente esté bloqueada y el destino responda con los negocios
  y terminales esperados.
- Cada terminal conserva su ID y configuración de impresión. El negocio elegido
  se traduce al nuevo ID; nunca se usa el negocio principal vacío por defecto.

## Pruebas necesarias

- Negocios principal y secundarios, con IDs distintos tras incorporar copias.
- Terminal autorizada a un negocio y terminal autorizada a varios.
- Una terminal por LAN y otra por Tailscale; una apagada durante el corte.
- Destino inaccesible, identidad incorrecta, clave inválida y copia antigua.
- Caja abierta, NCF siguiente y ventas bloqueadas durante el corte.
- Reinicio de ambos Servers y de una terminal en cada fase.
