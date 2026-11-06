#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { app, BrowserWindow } = require('electron');
app.whenReady().then(async()=>{
  const win = new BrowserWindow({show:Boolean(process.env.VELO_IMEI_PREVIEW_PATH),width:1100,height:1100,webPreferences:{contextIsolation:false,nodeIntegration:false}});
  try {
    await win.loadURL('data:text/html;charset=utf-8,<html><body><div id="modal" style="padding:25px;max-width:850px;margin:auto;background:white"></div></body></html>');
    await win.webContents.insertCSS(fs.readFileSync(path.join(__dirname,'../src/css/styles.css'),'utf8'));
    await win.webContents.executeJavaScript(`
      window._vertical={id:'tech',serialized:true}; window.user={id:1};
      window.DB={products:[]};window.CATS=['Celulares'];window.CFG={itbis:18};
      window.vterm=(key,fallback)=>fallback;window.svg=()=>'';window.fmt=n=>'RD$'+Number(n).toFixed(2);
      window.toast=message=>{window.lastNotice=message};window.openModal=html=>document.getElementById('modal').innerHTML=html;
      window.closeModal=()=>{window.modalClosed=true};window.__calls=[];
      window.api={products:{create:async input=>{window.__calls.push(input);return window.__reject?{ok:false,error:'IMEI duplicado'}:{ok:true,id:9,product:{id:9,serialized:1,stock:1,effective_stock:1}}}}};true;
    `);
    await win.webContents.executeJavaScript(fs.readFileSync(path.join(__dirname,'../src/js/inventario.js'),'utf8')+'\n;true;');
    const result=await win.webContents.executeJavaScript(`(async()=>{
      window.__patch=null;applyInventoryMutation=input=>{window.__patch=input};
      openProductoModal();
      const firstOnly=document.getElementById('pf-equipment-step-2').style.display==='none'&&!document.getElementById('pf-model-only');
      document.getElementById('pf-name').value='Equipo de prueba';document.getElementById('pf-code').value='TECH-QA';
      document.getElementById('pf-price').value='1180';document.getElementById('pf-cost').value='500';
      await guardarProducto(null);const nextOnly=__calls.length===0&&document.getElementById('pf-equipment-step-1').style.display==='none';
      await guardarProducto(null);const missingBlocked=__calls.length===0&&!window.modalClosed;
      document.getElementById('pf-imei').value='350000000000061';
      pfEquipmentStep(1);pfNextEquipmentStep();const retained=document.getElementById('pf-imei').value==='350000000000061';
      window.__reject=true;await guardarProducto(null);const duplicateKept=!window.modalClosed&&window.lastNotice==='IMEI duplicado';
      window.__reject=false;await guardarProducto(null);
      const atomic=__calls[1].data.first_unit.imei==='350000000000061'&&__calls[1].data.stock===0&&__patch.patch.effective_stock===1;
      window.modalClosed=false;DB.products=[{id:33,serialized:1,name:'Modelo existente',code:'EQ-33'}];
      window.abrirRegistroEquipos=product=>{window.__selectedProduct=product.id};
      openProductoModal();document.getElementById('pf-existing-model').value='33';pfChooseExistingEquipment();pfNextEquipmentStep();
      const existing=window.__selectedProduct===33&&__calls.length===2;
      openProductoModal();return {firstOnly,nextOnly,missingBlocked,retained,duplicateKept,atomic,existing};
    })()`);
    assert.deepEqual(result,{firstOnly:true,nextOnly:true,missingBlocked:true,retained:true,duplicateKept:true,atomic:true,existing:true});
    await win.webContents.executeJavaScript('window.scrollTo(0,0);document.activeElement?.blur();true;');
    await new Promise(resolve=>setTimeout(resolve,250));
    if(process.env.VELO_IMEI_PREVIEW_PATH) fs.writeFileSync(process.env.VELO_IMEI_PREVIEW_PATH,(await win.webContents.capturePage()).toPNG());
    console.log('✓ Ingreso TECH en dos pasos: modelo nuevo o existente, vuelta atrás sin perder datos y guardado único al terminar');
  } catch(error){console.error(error);process.exitCode=1;}finally{win.destroy();app.quit();}
});
