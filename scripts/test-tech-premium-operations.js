#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createEncryptedBackup, verifyEncryptedBackup } = require('../lib/continuity-backup');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'velo-tech-premium-'));
const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'velo-tech-external-'));
const DB = require('../database');

(async () => {
  DB.initDB(tempDir);
  const db = DB.getDB();
  require('../versioning').initVersioning(db, tempDir);
  const admin = db.prepare("SELECT id,name,role FROM users WHERE role IN ('admin','superadmin') ORDER BY id LIMIT 1").get();

  const partId = DB.productsRepo.create({ code:'BAT-TECH',name:'Batería técnica',cost:900,price:1800,stock:0,taxable:1,tax_pct:18 });
  const modelId = DB.serviceOrdersRepo.saveDeviceModel({ device_type:'celular',brand:'Marca QA',model:'Modelo Pro',model_code:'256GB' });
  DB.serviceOrdersRepo.saveCompatibility({ product_id:partId,device_model_id:modelId,compatibility_type:'original',notes:'Revisión A' });
  const catalog = DB.serviceOrdersRepo.techCatalog();
  assert.strictEqual(catalog.models.length,1);
  assert.strictEqual(catalog.compatibility[0].compatibility_type,'original');

  const technicianId = DB.serviceOrdersRepo.saveTechnician({name:'Técnico QA',commission_pct:12});
  const order = DB.serviceOrdersRepo.create({customer_id:1,device_desc:'Modelo Pro',problem:'No carga',intake_condition:'Pantalla intacta',service_technician_id:technicianId},admin);
  const appointmentId = DB.serviceOrdersRepo.saveAppointment({service_order_id:order.id,customer_id:1,customer_name:'Consumidor Final',reason:'Diagnóstico',starts_at:'2026-08-20T09:00',technician_id:technicianId},admin);
  assert.ok(appointmentId && DB.serviceOrdersRepo.listAppointments({from:'2026-08-20',to:'2026-08-21'}).length===1);
  DB.serviceOrdersRepo.saveAppointment({id:appointmentId,service_order_id:order.id,customer_id:1,customer_name:'Cliente QA',customer_phone:'8095550101',reason:'Diagnóstico',starts_at:'2099-08-20T09:00',technician_id:technicianId},admin);
  assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM service_message_queue WHERE appointment_id=? AND status='pending'").get(appointmentId).n,2);

  const evidence = DB.serviceOrdersRepo.addEvidenceMetadata(order.id,{evidence_type:'recepcion',storage_path:'service-evidence/1/test.jpg',mime_type:'image/jpeg',sha256:'a'.repeat(64),original_name:'entrada.jpg'},admin);
  assert.strictEqual(evidence.evidence_type,'recepcion');

  const timer = DB.serviceOrdersRepo.startTimer(order.id,technicianId,'Diagnóstico',admin);
  db.prepare("UPDATE service_time_entries SET started_at=datetime('now','localtime','-65 minutes') WHERE id=?").run(timer.id);
  const stopped = DB.serviceOrdersRepo.stopTimer(timer.id,admin);
  assert.ok(stopped.duration_minutes>=64 && stopped.duration_minutes<=66);

  DB.accountingRepo.saveFiscalWithholding({direction:'made',tax_kind:'isr',party_name:'Proveedor QA',party_rnc:'101000001',document_date:'2026-08-19',base_amount:10000,rate:10,amount:1000},admin.id);
  const workpaper = DB.accountingRepo.getFiscalWorkpaper({from:'2026-08-01',to:'2026-08-31'});
  assert.strictEqual(workpaper.ir17_workpaper.isr_retenido,1000);
  assert.match(workpaper.disclaimer,/DGII/);

  const encrypted = await createEncryptedBackup({db,destinationDir:externalDir,passphrase:'Prueba-segura-2026',businessId:'qa',businessName:'QA Tech'});
  assert.ok(fs.existsSync(encrypted.path));
  const verified = verifyEncryptedBackup({filePath:encrypted.path,passphrase:'Prueba-segura-2026'});
  assert.strictEqual(verified.integrity,'ok');
  let wrongKeyRejected=false;
  try { verifyEncryptedBackup({filePath:encrypted.path,passphrase:'Clave-incorrecta-2026'}); } catch { wrongKeyRejected=true; }
  assert.ok(wrongKeyRejected,'una clave incorrecta debe rechazarse');

  console.log('✓ TECH premium: catálogo, agenda, evidencia, tiempo, fiscalidad y continuidad verificados');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{
  try { DB.getDB()?.close(); } catch {}
  try { fs.rmSync(tempDir,{recursive:true,force:true}); } catch {}
  try { fs.rmSync(externalDir,{recursive:true,force:true}); } catch {}
});
