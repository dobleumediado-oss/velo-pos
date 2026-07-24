/* ═══════════════════════════════════════════════════════════════════════════
   EXPORT EQUIPARTS v2 — desde faprodb_bak2 (BAK faprodb2026-07-21-12-50.bak)
   Generado: 21-jul-2026

   Correr UNA query a la vez y guardar con el nombre indicado.
   Los 4 CSV van en la MISMA carpeta. NO abrirlos en Excel (corrompe encoding).

   CHECKPOINT DEL BAK 21-jul (validado):
     CxC pendientes .......... RD$12,420,461.00 · 176 facturas · 56 clientes
     Anuladas / Pagadas ...... 142 / 2318
     Articulos activos ....... 1245  (1213 gravados / 32 exentos)
     Clientes ................ 313
     Facturas no anuladas .... 2494  ·  items detalle 9081
     Recibos (pago_detalle) .. 4268  ·  2655 con monto > 0

   HALLAZGOS QUE CAMBIARON LAS QUERIES RESPECTO A LA VERSION ANTERIOR:
     1. payment_method NO se deriva de condicion_pago. 168 de 176 facturas
        pendientes estan marcadas condicion_pago=0 ('contado') con forma_pago
        'Efectivo' y aun asi tienen balance. Esos campos son defaults que nadie
        actualizo. El unico dato confiable es balance_factura.
     2. ITBIS por articulo vive en articulo.itbis (18 / 15 / 0). Se mapea a
        products.taxable. El precio YA incluye el ITBIS (monto_factura =
        suma del detalle), asi que los precios se migran tal cual.
     3. Los descuentos (pago_detalle.descuento, RD$179,744.58) cierran factura
        sin que entre efectivo. Entran como fila aparte con method='descuento'
        y old_id_pago_detalle NEGATIVO para no chocar con el dedup.
   ═══════════════════════════════════════════════════════════════════════════ */

USE faprodb_bak2;
GO

/* ───────────────────────────────────────────────────────────────────────────
   1) 1_inventario_v2.csv          esperado: 1245 filas
   header: code,barcode,name,cost,price,wholesale,taxable,tax_pct,stock,
           stock_min,category,brand,unit
   ─────────────────────────────────────────────────────────────────────────── */
   OJO — CODIGOS DUPLICADOS: 14 codigos estan compartidos por 25 articulos
   DISTINTOS (ej. 'GB/T 297-1994' lo usan 5 rodamientos diferentes). La identidad
   real en faprodb es id_articulo, no codigo. Si se exporta el codigo crudo, el
   importador deduplica y se pierden 25 productos, ademas de enlazar mal los
   sale_items. Por eso al codigo repetido se le agrega '-<id_articulo>'.
   La MISMA expresion se usa en la query de ventas, asi el enlace queda intacto. */
SELECT CASE WHEN d.n > 1 THEN a.codigo + '-' + CAST(a.id_articulo AS VARCHAR)
            ELSE a.codigo END AS code,
  ISNULL(a.codigo_barra,a.codigo) AS barcode,
  -- Quitar comillas dobles del nombre (marcas de pulgadas del sistema viejo,
  -- ej. TORNILLO 1/2") — ensucian la ficha y no aportan.
  REPLACE(a.Articulo,'"','') AS name,
  a.costo_compra AS cost, ISNULL(pv.precio,a.precio_venta) AS price,
  ISNULL(pm.precio,a.precio_por_mayor) AS wholesale,
  CASE WHEN ISNULL(a.itbis,0) > 0 THEN 1 ELSE 0 END AS taxable,
  18 AS tax_pct,
  CASE WHEN ISNULL(inv.stock,0)<0 THEN 0 ELSE ISNULL(inv.stock,0) END AS stock,
  5 AS stock_min,'GENERICO' AS category,'GENERICA' AS brand,ISNULL(a.unidad,'1') AS unit
FROM dbo.articulo a
INNER JOIN (SELECT codigo, COUNT(*) AS n FROM dbo.articulo WHERE estado='A'
            GROUP BY codigo) d ON d.codigo = a.codigo
LEFT JOIN (SELECT id_articulo,
             SUM(CASE WHEN Operador='suma'  THEN cantidad
                      WHEN Operador='resta' THEN -cantidad
                      ELSE cantidad END) AS stock
           FROM dbo.V_INVENTARIO GROUP BY id_articulo) inv ON inv.id_articulo=a.id_articulo
LEFT JOIN dbo.articulo_precio pv ON pv.id_articulo=a.id_articulo AND pv.id_precio=2 AND pv.estado='A'
LEFT JOIN dbo.articulo_precio pm ON pm.id_articulo=a.id_articulo AND pm.id_precio=1 AND pm.estado='A'
WHERE a.estado='A'
ORDER BY a.codigo;


/* ───────────────────────────────────────────────────────────────────────────
   2) 2_clientes_v2.csv            esperado: 313 filas
   header: old_id_cliente,name,rnc,phone,address,email,credit_days
   Nota: faprodb no tiene tabla de credito -> credit_days = 30 por defecto.
   ─────────────────────────────────────────────────────────────────────────── */
SELECT c.id_cliente AS old_id_cliente,
  REPLACE(LTRIM(RTRIM(ISNULL(c.nombre,'') +
    CASE WHEN ISNULL(c.apellido,'')<>'' THEN ' '+c.apellido ELSE '' END)),',',' ') AS name,
  CASE WHEN LTRIM(RTRIM(ISNULL(c.cedula,''))) IN ('','-','--','---')
       THEN '' ELSE LTRIM(RTRIM(c.cedula)) END AS rnc,
  -- La tabla destino tiene UNA columna phone. faprodb guarda numeros en
  -- telefono y/o celular. Se combinan: si ambos existen y son distintos ->
  -- "telefono / celular"; si solo uno -> ese; si ninguno -> ''.
  CASE
    WHEN LTRIM(RTRIM(ISNULL(c.telefono,''))) NOT IN ('','-','--','---')
     AND LTRIM(RTRIM(ISNULL(c.celular,'')))  NOT IN ('','-','--','---')
     AND LTRIM(RTRIM(c.telefono)) <> LTRIM(RTRIM(c.celular))
      THEN LTRIM(RTRIM(c.telefono)) + ' / ' + LTRIM(RTRIM(c.celular))
    WHEN LTRIM(RTRIM(ISNULL(c.telefono,''))) NOT IN ('','-','--','---')
      THEN LTRIM(RTRIM(c.telefono))
    WHEN LTRIM(RTRIM(ISNULL(c.celular,'')))  NOT IN ('','-','--','---')
      THEN LTRIM(RTRIM(c.celular))
    ELSE ''
  END AS phone,
  REPLACE(ISNULL(c.direccion,''),',',' ') AS address,
  ISNULL(c.email,'') AS email,
  30 AS credit_days
FROM dbo.cliente c
ORDER BY c.id_cliente;


/* ───────────────────────────────────────────────────────────────────────────
   3) 3_ventas_v2.csv              esperado: 9081 filas (una por item)
   header: old_id_factura,numero_factura,numero_factura_fmt,ncf,customer_name,
           old_id_cliente,date,total,balance,payment_method,status,
           estado_origen,product_code,product_name,qty,unit_price,line_total,
           factura_nota
   payment_method sale del BALANCE, no de condicion_pago. Ver hallazgo 1.
   ─────────────────────────────────────────────────────────────────────────── */
SELECT f.id_factura AS old_id_factura, f.codigo_factura AS numero_factura,
  RIGHT('00000000'+CAST(f.codigo_factura AS VARCHAR),8) AS numero_factura_fmt,
  CASE WHEN f.ncf LIKE 'B%' THEN f.ncf ELSE '' END AS ncf,
  REPLACE(LTRIM(RTRIM(ISNULL(c.nombre,'') +
    CASE WHEN ISNULL(c.apellido,'')<>'' THEN ' '+c.apellido ELSE '' END)),',',' ') AS customer_name,
  f.id_cliente AS old_id_cliente,
  CONVERT(VARCHAR(10),f.fecha_insercion,120) AS date,
  f.monto_factura AS total, f.balance_factura AS balance,
  CASE WHEN f.balance_factura > 0 THEN 'credito' ELSE 'efectivo' END AS payment_method,
  'completed' AS status, f.estado_factura AS estado_origen,
  ISNULL(CASE WHEN d.n > 1 THEN a.codigo + '-' + CAST(a.id_articulo AS VARCHAR)
              ELSE a.codigo END, 'IMP') AS product_code,
  REPLACE(REPLACE(ISNULL(a.Articulo,'Producto'),'"',''),',',' ') AS product_name,
  fd.cantidad AS qty, fd.precio AS unit_price, fd.importe AS line_total,
  -- Nota real de la factura (el importador la anexa a sales.notes).
  REPLACE(REPLACE(ISNULL(f.nota,''),'"',''),',',' ') AS factura_nota
FROM dbo.factura f
-- LEFT (no INNER): la factura 204628 no tiene lineas en factura_detalle y con
-- INNER se perdia, dejando huerfano su recibo de RD$630. El importador le crea
-- una linea generica cuando llega sin items.
LEFT  JOIN dbo.factura_detalle fd ON fd.id_factura=f.id_factura
LEFT  JOIN dbo.articulo a ON a.id_articulo=fd.id_articulo
LEFT  JOIN (SELECT codigo, COUNT(*) AS n FROM dbo.articulo WHERE estado='A'
            GROUP BY codigo) d ON d.codigo = a.codigo
LEFT  JOIN dbo.cliente  c ON c.id_cliente=f.id_cliente
WHERE f.estado_factura <> 'Anulada'
ORDER BY f.id_factura, fd.id_factura_detalle;


/* ───────────────────────────────────────────────────────────────────────────
   4) 4_recibos_v2.csv             esperado: 2699 filas (2655 efectivo + 44 desc)
   header: old_id_pago_detalle,old_id_factura,old_id_cliente,customer_name,
           date,amount,method,numero_recibo,notes
   BORRAR las columnas _ord y _tipo del CSV antes de guardarlo.
   Se excluyen 157 detalles que apuntan a facturas anuladas y 1456 con monto 0.
   ─────────────────────────────────────────────────────────────────────────── */
SELECT old_id_pago_detalle, old_id_factura, old_id_cliente, customer_name,
       date, amount, method, numero_recibo, notes
FROM (
  -- Fila de EFECTIVO: el dinero que realmente entro
  SELECT pd.id_pago_detalle AS old_id_pago_detalle,
         pd.id_factura      AS old_id_factura,
         f.id_cliente       AS old_id_cliente,
         REPLACE(LTRIM(RTRIM(ISNULL(c.nombre,'') +
           CASE WHEN ISNULL(c.apellido,'')<>'' THEN ' '+c.apellido ELSE '' END)),',',' ') AS customer_name,
         CONVERT(VARCHAR(10), p.fecha, 120) AS date,
         pd.monto AS amount,
         LOWER(LTRIM(RTRIM(ISNULL(p.forma_pago,'efectivo')))) AS method,
         p.id_pago AS numero_recibo,
         -- Nota real del abono: pago_detalle.nota; si viene vacia, el concepto
         -- del pago. El importador la anexa a payments.note.
         REPLACE(REPLACE(
           CASE WHEN LTRIM(RTRIM(ISNULL(pd.nota,''))) <> ''
                THEN pd.nota ELSE ISNULL(p.concepto,'Pago de factura') END,
           '"',''),',',' ') AS notes,
         pd.id_pago_detalle AS _ord, 0 AS _tipo
  FROM dbo.pago_detalle pd
  INNER JOIN dbo.pago    p ON p.id_pago    = pd.id_pago
  INNER JOIN dbo.factura f ON f.id_factura = pd.id_factura
  LEFT  JOIN dbo.cliente c ON c.id_cliente = f.id_cliente
  WHERE f.estado_factura <> 'Anulada' AND pd.monto > 0

  UNION ALL

  -- Fila de DESCUENTO: rebaja que cerro factura sin que entrara dinero.
  -- id NEGATIVO -> nunca choca con el dedup por old_id_pago_detalle.
  SELECT -pd.id_pago_detalle, pd.id_factura, f.id_cliente,
         REPLACE(LTRIM(RTRIM(ISNULL(c.nombre,'') +
           CASE WHEN ISNULL(c.apellido,'')<>'' THEN ' '+c.apellido ELSE '' END)),',',' '),
         CONVERT(VARCHAR(10), p.fecha, 120),
         pd.descuento, 'descuento', p.id_pago,
         REPLACE(REPLACE(
           CASE WHEN LTRIM(RTRIM(ISNULL(pd.nota,''))) <> ''
                THEN 'Descuento aplicado | ' + pd.nota ELSE 'Descuento aplicado' END,
           '"',''),',',' '),
         pd.id_pago_detalle, 1
  FROM dbo.pago_detalle pd
  INNER JOIN dbo.pago    p ON p.id_pago    = pd.id_pago
  INNER JOIN dbo.factura f ON f.id_factura = pd.id_factura
  LEFT  JOIN dbo.cliente c ON c.id_cliente = f.id_cliente
  WHERE f.estado_factura <> 'Anulada' AND ISNULL(pd.descuento,0) > 0
) x
ORDER BY _ord, _tipo;


/* ───────────────────────────────────────────────────────────────────────────
   VALIDACION FINAL — correr despues de generar los 4 CSV
   ─────────────────────────────────────────────────────────────────────────── */
SELECT 'inventario' AS csv, COUNT(*) AS filas_esperadas FROM dbo.articulo WHERE estado='A'
UNION ALL SELECT 'clientes', COUNT(*) FROM dbo.cliente
UNION ALL SELECT 'ventas', COUNT(*) FROM dbo.factura_detalle fd
          INNER JOIN dbo.factura f ON f.id_factura=fd.id_factura
          WHERE f.estado_factura<>'Anulada'
UNION ALL SELECT 'recibos_efectivo', COUNT(*) FROM dbo.pago_detalle pd
          INNER JOIN dbo.factura f ON f.id_factura=pd.id_factura
          WHERE f.estado_factura<>'Anulada' AND pd.monto>0
UNION ALL SELECT 'recibos_descuento', COUNT(*) FROM dbo.pago_detalle pd
          INNER JOIN dbo.factura f ON f.id_factura=pd.id_factura
          WHERE f.estado_factura<>'Anulada' AND ISNULL(pd.descuento,0)>0;

-- CxC que debe dar el import: 12,420,461.00 en 176 facturas / 56 clientes
SELECT CAST(SUM(balance_factura) AS DECIMAL(18,2)) AS cxc_target,
       COUNT(*) AS facturas_pendientes,
       COUNT(DISTINCT id_cliente) AS clientes_con_saldo
FROM dbo.factura WHERE estado_factura='Pendiente' AND balance_factura>0;
