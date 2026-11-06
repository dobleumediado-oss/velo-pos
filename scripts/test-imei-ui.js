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
      window.closeModal=()=>{window.modalClosed=true};window.__calls=[];window.__unitCalls=[];reloadProducts=async()=>{};renderInvCurrentView=()=>{};
      window.api={productUnits:{listForProduct:async()=>({ok:true,data:[]}),create:async input=>{window.__unitCalls.push(input);return {ok:true,created:1}}},techDescriptions:{list:async()=>({ok:true,data:[{name:'Usado',description:'Descripción guardada'}]})},products:{create:async input=>{window.__calls.push(input);return window.__reject?{ok:false,error:'IMEI duplicado'}:{ok:true,id:9,product:{id:9,serialized:1,stock:1,effective_stock:1}}}}};true;
    `);
    await win.webContents.executeJavaScript(fs.readFileSync(path.join(__dirname,'../src/js/device-reference.js'),'utf8')+';true;');
    await win.webContents.executeJavaScript(fs.readFileSync(path.join(__dirname,'../src/js/inventario.js'),'utf8')+'\n;true;');
    const result=await win.webContents.executeJavaScript(`(async()=>{
      window.__patch=null;applyInventoryMutation=input=>{window.__patch=input};
      openProductoModal();
      const firstOnly=!!document.getElementById('de-brand')&&!document.getElementById('de-imei')&&!document.getElementById('pf-name');
      document.getElementById('de-brand').value='Apple';document.getElementById('de-model').value='Equipo de prueba';
      deviceEntryCapture();const catalog=!!document.querySelector('#de-models option[value="iPhone 16 Pro Max"]');
      await deviceEntryNext();const nextOnly=__calls.length===0&&!!document.getElementById('de-imei');
      document.getElementById('de-price').value='1180';document.getElementById('de-cost').value='500';deviceEntryCapture();
      const margin=document.getElementById('de-margin').textContent==='57.63%'&&document.getElementById('de-gain').textContent==='RD$680.00';
      await deviceEntryNext();const missingBlocked=__calls.length===0&&!window.modalClosed;
      document.getElementById('de-imei').value='350000000000061';
      deviceEntryBack();await deviceEntryNext();const retained=document.getElementById('de-imei').value==='350000000000061';
      window.__reject=true;await deviceEntryNext();const duplicateKept=!window.modalClosed&&window.lastNotice==='IMEI duplicado';
      window.__reject=false;await deviceEntryNext();
      const atomic=__calls[1].data.first_unit.imei==='350000000000061'&&__calls[1].data.stock===0&&__calls[1].data.name==='Apple · Equipo de prueba';
      window.modalClosed=false;DB.products=[{id:33,serialized:1,name:'Modelo existente',code:'EQ-33',price:1180,cost:500}];
      openDeviceEntry(33);const preselected=!!document.getElementById('de-imei')&&document.getElementById('de-price').readOnly;
      document.getElementById('de-imei').value='PRUEBA-EXISTENTE';await deviceEntryNext();
      const existing=__unitCalls.length===1&&__unitCalls[0].productId===33&&__calls.length===2;
      openEntradaMercanciaModal({type:'click'});const entryChoice=document.body.textContent.includes('Dispositivo con IMEI o serial')&&document.body.textContent.includes('Accesorio o insumo por cantidad');
      await abrirRegistroEquipos(DB.products[0]);const manager=[...document.querySelectorAll('button')].some(button=>button.textContent==='Agregar unidad'&&button.getAttribute('onclick')==='openDeviceEntry(33)');
      openDeviceEntry(33);return {catalog,firstOnly,nextOnly,margin,missingBlocked,retained,duplicateKept,atomic,existing,preselected,entryChoice,manager};
    })()`);
    assert(Object.values(result).every(Boolean),JSON.stringify(result));
    await win.webContents.executeJavaScript('window.scrollTo(0,0);document.activeElement?.blur();true;');
    await new Promise(resolve=>setTimeout(resolve,250));
    if(process.env.VELO_IMEI_PREVIEW_PATH) fs.writeFileSync(process.env.VELO_IMEI_PREVIEW_PATH,(await win.webContents.capturePage()).toPNG());
    console.log('✓ Ingreso TECH en dos pasos: modelo nuevo o existente, vuelta atrás sin perder datos y guardado único al terminar');
  } catch(error){console.error(error);process.exitCode=1;}finally{win.destroy();app.quit();}
});
