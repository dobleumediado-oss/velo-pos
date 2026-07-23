# Clientes persona, empresas y representantes

[← Volver a CLAUDE.md](../CLAUDE.md) · Relacionados: [Visión general](overview.md) · [Preventa y Despacho](preventa-despacho.md) · [Impresión](printing-module.md)

Desde la versión 1.26.1, una cuenta de cliente puede ser una **persona** o una **empresa**. El diseño está optimizado para una sola empresa usuaria de Velo POS, uno o dos usuarios y varias terminales conectadas al mismo negocio; no introduce sucursales ni cuentas independientes por representante.

## Modelo operativo

```text
Cliente empresa (cuenta comercial y fiscal)
├── Representante principal
├── Representante de compras
└── Representante de recepción
        │
        ├── Cotización / POS
        ├── Orden de preventa y caja
        ├── Factura y cuenta por cobrar
        └── Conduce / envío / entrega
```

La empresa es siempre la propietaria de:

- RNC, razón social, nombre comercial y dirección fiscal.
- Límite, plazo y balance de crédito.
- Facturas, abonos, historial de compras y NCF.
- Precio preferido de detalle o mayorista.

El representante identifica a la persona que solicita, recibe o gestiona la operación. Nunca tiene balance ni cuenta por cobrar separada.

## Datos

### Cuenta de cliente

La tabla `customers` conserva los clientes anteriores y agrega:

- `customer_type`: `person` o `company`.
- `trade_name`: nombre comercial opcional.
- `billing_email`: correo de facturación.
- `preferred_price_mode`: detalle o mayorista.
- `notes`: observaciones internas.

Todos los clientes existentes se mantienen como personas. La migración no intenta deducir el tipo por la longitud del documento.

### Representantes

La tabla `customer_contacts` pertenece a `customers` y guarda nombre, documento, cargo, teléfono, correo, representante principal y permisos operativos para solicitar, recibir mercancía o recibir facturas. Solo una empresa puede tener representantes.

Eliminar un representante lo desactiva para operaciones nuevas; no borra su aparición en documentos históricos.

## Flujo en el sistema

1. Un administrador crea o edita el cliente como **Empresa**.
2. Desde la lista de Clientes abre **Representantes** y registra uno o varios contactos.
3. En el selector permanente del POS, Preventa, Conduce o Envíos se puede buscar por razón social, nombre comercial, RNC, teléfono o datos del representante.
4. Al elegir un representante, el sistema vincula automáticamente la cuenta empresarial y aplica su precio preferido antes de elegir productos.
5. Si el cliente es de detalle o mayorista, el catálogo y las líneas no modificadas del carrito cambian al precio correspondiente. Un precio autorizado manualmente no se sobrescribe.
6. La factura y el crédito quedan a nombre de la empresa; el documento muestra `Solicitado por` con el representante.
7. Al registrar un abono se puede indicar qué representante pagó; el recibo y el estado de cuenta muestran `Pagado por`.

El representante también acompaña una orden compartida desde preparación hasta caja y entrega. La reserva de inventario y el cobro siguen funcionando sobre la orden, no sobre el contacto.

## Snapshots documentales

Ventas, órdenes de caja, pagos, conduces y envíos guardan una copia de los datos relevantes al momento de la operación. Si luego cambia la razón social, dirección, correo, cargo o nombre del representante, una factura o recibo anterior conserva el contenido original.

Los snapshots recibidos desde formularios normales no son confiables: el proceso principal vuelve a leer la empresa y el representante desde SQLite. Solo los flujos internos verificados —por ejemplo, cobrar una orden ya preparada o facturar un conduce— pueden trasladar su snapshot histórico.

## Impresión y búsqueda

- Los perfiles térmicos, carta, media carta, NCF y conduce muestran el representante cuando existe.
- Reimpresiones y PDF usan el snapshot de la venta, no los datos actuales del cliente.
- Estados de cuenta, facturas pendientes y recibos de abono muestran qué representante solicitó o pagó cada operación.
- Ventas y búsqueda global encuentran documentos por nombre, cargo o teléfono del representante.
- Conduces y envíos muestran el contacto responsable en lista y detalle.

## Organización del módulo Clientes

Las pestañas **Personas** y **Empresas** permiten trabajar ambos grupos por separado sin duplicar cuentas ni romper los filtros de crédito. En una fila empresarial, **Representantes** abre un panel con sus permisos y su actividad atribuida: facturas, cotizaciones, compras a crédito, saldo pendiente, abonos y operaciones recientes. La deuda continúa perteneciendo a la empresa.

## Archivos principales

- `database.js`: migración idempotente, repositorios, validaciones y snapshots.
- `versioning.js`: migración `1.26.1` para instalaciones existentes.
- `main.js` y `preload.js`: API IPC y permisos administrativos.
- `src/js/clientes.js`: alta de persona/empresa y gestión de representantes.
- `src/js/pos.js`, `preventa.js`, `conduce.js`, `envios.js`: selección y trazabilidad operativa.
- `src/js/print.js`, `plantillas.js`, `ventas.js`: impresión y reimpresión histórica.
- `scripts/test-customer-companies.js`: regresión del modelo empresarial completo.

## Alcance deliberado

No se crean sucursales de clientes, departamentos con balances propios ni jerarquías multinivel. Si una empresa tiene varios puntos de contacto, se representan como contactos de la misma cuenta. Esto mantiene simple el uso para negocios pequeños y evita fragmentar el crédito o el historial.
