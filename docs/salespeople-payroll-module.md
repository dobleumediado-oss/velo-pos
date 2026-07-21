# Módulo de vendedores, comisiones, viáticos y nómina

## Objetivo

Administrar vendedores fijos y ambulantes sin obligar a que todos tengan acceso
al POS. Un vendedor fijo puede vincularse a un usuario; un ambulante puede operar
con su talonario y ser controlado por el dueño desde el sistema.

## Flujo integrado

1. Se registra el vendedor, su tipo, zona, ruta, talonario, salario y regla de comisión.
2. Las ventas del POS se asignan manualmente o automáticamente por el usuario vinculado.
3. Las ventas ambulantes se registran por número único de talonario/recibo.
4. El sistema propone el período semanal, quincenal o mensual.
5. La comisión descuenta devoluciones y usa venta neta, margen bruto o monto por venta.
6. El corte queda en borrador; al aprobarlo puede incorporarse a una nómina.
7. La nómina combina salario, comisión, bonos y deducciones.
8. Al pagar, se crea un gasto real por vendedor y se generan los asientos contables.
9. Las nóminas semanales, quincenales y mensuales se procesan por separado para
   respetar la frecuencia configurada de cada vendedor.

## Viáticos

Combustible, alimentación, alojamiento, peajes y otros viáticos se registran en
el módulo Vendedores, pero su fuente financiera es el módulo Gastos. Por eso
aparecen en resultados, flujo de efectivo, cuentas por pagar y auditoría sin
duplicarse.

## Controles

- Recibo único por vendedor, talonario y número.
- Una venta externa incluida en una comisión aprobada no puede anularse.
- Las reglas y ventas utilizadas se congelan como líneas del corte.
- No se permiten cortes de comisión solapados ni nóminas duplicadas del mismo período.
- Solo administradores gestionan salarios, comisiones y pagos.
- El ambulante no necesita usuario ni contraseña del sistema.
- Una comisión pagada queda enlazada a la nómina que la liquidó.

## Centro visual de operaciones

El módulo incorpora vistas complementarias sin duplicar movimientos:

- Perfil individual con meta del período, avance, ventas, margen, comisión, gastos y rentabilidad.
- Línea de tiempo que enlaza talonarios, viáticos y cortes de comisión del vendedor.
- Calendario mensual de documentos comerciales y de compensación.
- Flujo por estados para aprobar y pagar comisiones y nóminas desde el mismo tablero.
- Mapa de cobertura exclusivo para ambulantes, basado en zona/ruta y coordenadas opcionales.

La meta se utiliza para comparación visual y no altera el cálculo de comisión. Las coordenadas son opcionales: si faltan, el sistema muestra una posición operativa aproximada y la identifica explícitamente como tal.
