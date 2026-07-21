# Módulos conectados de Vendedores, Comisiones y Nómina

## Objetivo

Administrar vendedores fijos y ambulantes sin obligar a que todos tengan acceso
al POS. Un vendedor fijo puede vincularse a un usuario; un ambulante trabaja con
documentos físicos externos y el dueño transcribe sus ventas en el sistema.

## Flujo integrado

1. En **Vendedores** se registra el perfil y la operación comercial: tipo, contacto, zona, ruta y meta.
2. Las ventas del POS se asignan manualmente o automáticamente por el usuario vinculado.
3. Las ventas ambulantes se registran con el número opcional del recibo externo y detalle de productos, cantidades, precios y costos. Si el papel no tiene número, el sistema genera una referencia `EXT-000000`.
4. En **Comisiones** se configura la regla de incentivo y se propone el período semanal, quincenal o mensual.
5. El cálculo descuenta devoluciones y puede usar venta neta, margen bruto o monto por venta.
6. La liquidación queda en borrador para revisión; solo al aprobarse queda disponible para Nómina.
7. En **Nómina** se configura el salario y la frecuencia de pago; cada período combina salario, comisiones aprobadas, bonos y deducciones.
8. Al pagar la nómina, se crea un gasto real por persona y se generan los asientos contables.
9. Las nóminas semanales, quincenales y mensuales se procesan por separado para
   respetar la frecuencia configurada de cada vendedor.

## Viáticos

Combustible, alimentación, alojamiento, peajes y otros viáticos se registran en
el módulo Vendedores, pero su fuente financiera es el módulo Gastos. Por eso
aparecen en resultados, flujo de efectivo, cuentas por pagar y auditoría sin
duplicarse.

## Controles

- Número de recibo externo único por vendedor cuando se suministra; referencia interna automática en caso contrario.
- La venta externa es administrativa: no crea factura fiscal ni mueve inventario.
- Los productos transcritos calculan automáticamente venta bruta, costo, margen y base de comisión.
- Una venta externa incluida en una comisión aprobada no puede anularse.
- Las reglas y ventas utilizadas se congelan como líneas del corte.
- No se permiten cortes de comisión solapados ni nóminas duplicadas del mismo período.
- Solo administradores gestionan reglas, liquidaciones de comisión, salarios y pagos.
- El ambulante no necesita usuario ni contraseña del sistema.
- Una comisión pagada queda enlazada a la nómina que la liquidó.

## Separación de responsabilidades

- **Vendedores:** perfiles fijos y ambulantes, ventas externas, metas, viáticos, agenda, rutas y cobertura.
- **Comisiones:** reglas de incentivo, simulación, cálculo, liquidaciones, aprobación e historial.
- **Nómina:** salarios base, bonos, deducciones, períodos, aprobación, pago y trazabilidad financiera.
- Los tres módulos comparten la identidad del vendedor, pero conservan ciclos y estados independientes.
- La única transferencia entre Comisiones y Nómina es una liquidación aprobada; nunca se recalcula ni se vuelve a digitar dentro de la nómina.
- Los cajeros pueden operar Vendedores cuando su permiso está habilitado. Comisiones y Nómina quedan reservadas a administradores por contener incentivos y salarios.

## Experiencia visual

El módulo incorpora vistas complementarias sin duplicar movimientos:

- Perfil individual con meta del período, avance, ventas, margen, gastos y rentabilidad.
- Línea de tiempo operativa que enlaza ventas externas y viáticos del vendedor.
- Agenda mensual de ventas externas y viáticos.
- Cobertura exclusiva para ambulantes sobre OpenStreetMap, con punto base real, fecha de actualización y acceso a navegación.
- Centro de Comisiones con proyección, reglas, liquidaciones y flujo borrador → aprobado → enviado a Nómina.
- Centro de Nómina con indicadores, períodos, salarios y flujo borrador → aprobado → pagado.

La meta se utiliza para comparación visual y no altera el cálculo de comisión. El usuario nunca introduce latitud ni longitud: busca una dirección, sector o zona y el sistema resuelve y guarda las coordenadas. La actualización del tablero es inmediata, pero el punto es administrativo; para seguimiento GPS continuo sería necesario que el teléfono del ambulante compartiera su ubicación.
