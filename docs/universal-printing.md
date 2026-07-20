# Impresión universal y 2Connect 2C-LP427B

Velo POS separa la impresora física del formato del documento. El sistema genera
HTML imprimible con el tamaño real del medio y lo entrega al controlador instalado
en Windows, macOS o Linux. Así no depende de una marca ni intenta comunicarse
directamente con un puerto USB específico.

## Perfiles disponibles

- Ticket térmico continuo: 58, 72 y 80 mm.
- 2Connect 2C-LP427B: ancho de impresión de 108 mm y resolución de 203 DPI.
- Rollo continuo con ancho y DPI configurables.
- Etiquetadora universal con ancho y DPI configurables.
- Carta/A4 para impresoras láser o de tinta.

La 2C-LP427B anuncia emulación ZPL, TSPL, EPS/EPL, DPL y sensores de espacio o marca
negra. Velo POS usa por defecto el **controlador del sistema**, que es la ruta más
universal: el controlador traduce el trabajo al lenguaje configurado en la
impresora. No se envían comandos ZPL/TSPL crudos desde la aplicación.

## Configurar tickets

1. Instalar el driver USB de la impresora en el sistema operativo.
2. Abrir Configuración → Impresora.
3. Seleccionar la impresora instalada.
4. Elegir el perfil del papel. Para la 2Connect, usar el preset
   `2Connect 2C-LP427B · etiquetas/rollo 108 mm · 203 dpi`.
5. Para imprimir tickets en esta etiquetadora, configurar rollo continuo tanto en
   Velo POS como en las preferencias del driver.

Una etiquetadora no reemplaza automáticamente una ticketera ESC/POS con cortador.
Puede imprimir tickets si admite material continuo, pero el corte dependerá del
hardware y del driver.

## Configurar etiquetas

En Etiquetas de código de barras se eligen por separado:

- impresora;
- perfil 2Connect o universal;
- ancho real del rollo;
- resolución;
- avance por espacio/sensor, marca negra o rollo continuo.

El motor calcula las columnas que caben en el rollo. Si el diseño solicita más,
las reduce automáticamente para evitar etiquetas cortadas. En modo sensor cada
fila se imprime como una página física con altura de etiqueta más separación; en
modo continuo el trabajo conserva una altura dinámica.

## Preparación del driver

El ancho, alto, orientación y tipo de sensor configurados en el driver deben
coincidir con Velo POS. Si el equipo avanza una etiqueta en blanco o se desfasa,
calibrar el sensor desde el driver o el procedimiento del fabricante antes de
volver a imprimir.
