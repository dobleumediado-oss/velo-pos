// ══════════════════════════════════════════════
// vehiculos.js — Vehículos y Mantenimiento
// VeloPOS v1.5.5 — Inteligencia de vehículos + combustible en tiempo real
// ══════════════════════════════════════════════

function _vUser() {
  if (window._currentUser) return window._currentUser;
  try { return JSON.parse(sessionStorage.getItem('vp_user')); } catch { return null; }
}

const _vFmt   = n => 'RD$' + (n||0).toLocaleString('es-DO', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const _vDate  = d => d ? new Date(d+'T00:00:00').toLocaleDateString('es-DO',{day:'2-digit',month:'short',year:'numeric'}) : '—';
const _vToday = () => new Date().toISOString().split('T')[0];

const TIPO_ICON  = { carro:'🚗', camioneta:'🛻', moto:'🏍️', camion:'🚛', furgoneta:'🚐', otro:'🚙' };
const TIPO_LABEL = { carro:'Carro', camioneta:'Camioneta/Pick-up', moto:'Motocicleta', camion:'Camión', furgoneta:'Furgoneta', otro:'Otro' };
const STATUS_V   = { activo:'#00c07a', inactivo:'#6b7280', taller:'#f59e0b' };

// ══════════════════════════════════════════════
// BASE DE DATOS AMPLIADA DE VEHÍCULOS
// Cubre los vehículos más comunes en RD + validación por año
// ══════════════════════════════════════════════
const _VDB = {
  carro: {
    'Toyota':      { models: ['Corolla','Camry','Yaris','Avalon','Prius','C-HR','RAV4','Venza','GR86','Crown','bZ4X'], desde: 1990 },
    'Honda':       { models: ['Civic','Accord','City','Fit','CR-V','HR-V','Pilot','Odyssey','Ridgeline','e:HEV'], desde: 1990 },
    'Hyundai':     { models: ['Tucson','Santa Fe','Elantra','Accent','Sonata','Creta','Venue','Ioniq 6','Kona','Palisade'], desde: 1995 },
    'Kia':         { models: ['Rio','Sportage','Sorento','Cerato','Picanto','Stinger','Seltos','EV6','Carnival','K5'], desde: 1995 },
    'Nissan':      { models: ['Sentra','Altima','Versa','Tiida','March','X-Trail','Juke','Kicks','Qashqai','Armada'], desde: 1990 },
    'Chevrolet':   { models: ['Aveo','Cruze','Malibu','Spark','Trax','Equinox','Captiva','Camaro','Blazer','Traverse'], desde: 1990 },
    'Volkswagen':  { models: ['Jetta','Passat','Golf','Polo','Tiguan','Vento','T-Roc','Taos','ID.4'], desde: 1990 },
    'Mazda':       { models: ['Mazda3','Mazda6','CX-3','CX-5','CX-9','CX-30','MX-5','CX-50','Mazda2'], desde: 1992 },
    'Ford':        { models: ['Fiesta','Focus','Fusion','Mustang','EcoSport','Edge','Explorer','Escape','Bronco Sport'], desde: 1990 },
    'Mercedes-Benz':{ models: ['Clase A','Clase C','Clase E','Clase S','GLA','GLC','GLE','CLA','AMG GT','EQC'], desde: 1990 },
    'BMW':         { models: ['Serie 1','Serie 3','Serie 5','Serie 7','X1','X3','X5','X6','M3','M5','i4'], desde: 1990 },
    'Audi':        { models: ['A3','A4','A6','A8','Q3','Q5','Q7','TT','RS3','e-tron','Q8'], desde: 1992 },
    'Suzuki':      { models: ['Swift','Vitara','Baleno','Ertiga','Jimny','S-Cross','Grand Vitara'], desde: 1995 },
    'Mitsubishi':  { models: ['Mirage','Lancer','Outlander','Eclipse Cross','Galant','ASX','Attrage'], desde: 1992 },
    'Subaru':      { models: ['Impreza','Outback','Forester','Legacy','XV','WRX','BRZ','Crosstrek'], desde: 1995 },
    'Lexus':       { models: ['IS','ES','RX','NX','UX','GX','LX','LC','LS'], desde: 1995 },
    'Infiniti':    { models: ['Q50','Q60','QX50','QX60','QX80','G35','G37'], desde: 2000 },
    'Acura':       { models: ['ILX','TLX','RDX','MDX','NSX','Integra'], desde: 1998 },
    'Volvo':       { models: ['S60','S90','XC40','XC60','XC90','V60','C40'], desde: 1995 },
    'Peugeot':     { models: ['208','308','508','2008','3008','5008','Rifter'], desde: 1995 },
    'Renault':     { models: ['Logan','Sandero','Duster','Kwid','Megane','Captur','Arkana'], desde: 1995 },
    'Fiat':        { models: ['500','Cronos','Argo','Pulse','Fastback','Toro'], desde: 1995 },
    'Seat':        { models: ['Ibiza','Leon','Arona','Ateca','Tarraco'], desde: 1998 },
    'Skoda':       { models: ['Fabia','Octavia','Superb','Kodiaq','Kamiq'], desde: 2000 },
    'Porsche':     { models: ['Cayenne','Macan','Panamera','911','Taycan','Boxster'], desde: 1998 },
    'Jeep':        { models: ['Compass','Renegade','Cherokee','Grand Cherokee','Wrangler','Gladiator'], desde: 1995 },
    'Dodge':       { models: ['Charger','Challenger','Durango','Journey','Dart','Hornet'], desde: 1995 },
    'Chrysler':    { models: ['300','Pacifica','Voyager'], desde: 1995 },
    'Cadillac':    { models: ['CT4','CT5','Escalade','XT4','XT5','XT6'], desde: 1998 },
    'Lincoln':     { models: ['MKZ','Nautilus','Corsair','Aviator','Navigator'], desde: 1998 },
    'Buick':       { models: ['Encore','Envision','Enclave','LaCrosse'], desde: 2000 },
    'GMC':         { models: ['Terrain','Acadia','Yukon','Canyon','Sierra'], desde: 1995 },
    'Genesis':     { models: ['G70','G80','G90','GV70','GV80'], desde: 2017 },
    'Alfa Romeo':  { models: ['Giulia','Stelvio','Tonale','Giulietta'], desde: 2000 },
    'Land Rover':  { models: ['Defender','Discovery','Range Rover','Evoque','Velar','Sport'], desde: 1995 },
    'Mini':        { models: ['Cooper','Countryman','Clubman','Paceman','Convertible'], desde: 2001 },
    'Tesla':       { models: ['Model 3','Model Y','Model S','Model X','Cybertruck'], desde: 2012 },
    'BYD':         { models: ['Seal','Atto 3','Han','Tang','Dolphin','Song Plus'], desde: 2020 },
    'Chery':       { models: ['Tiggo 4','Tiggo 7','Tiggo 8','Arrizo 5','Omoda 5'], desde: 2010 },
    'JAC':         { models: ['JS4','JS6','S3','S5','iEV7'], desde: 2015 },
    'Geely':       { models: ['Emgrand','Coolray','Tugella','Atlas','Okavango'], desde: 2018 },
    'MG':          { models: ['MG3','MG5','ZS','HS','RX5','4 EV'], desde: 2017 },
    'Haval':       { models: ['H2','H4','H6','H9','Jolion','Dargo'], desde: 2018 },
  },
  camioneta: {
    'Toyota':      { models: ['Hilux','Tacoma','Tundra','Land Cruiser 200','Land Cruiser 300','4Runner','Prado','FJ Cruiser','Sequoia'], desde: 1990 },
    'Ford':        { models: ['F-150','F-250','F-350','Ranger','Explorer','Expedition','Bronco','Maverick','F-150 Lightning'], desde: 1990 },
    'Chevrolet':   { models: ['Silverado 1500','Silverado 2500','Colorado','Tahoe','Suburban','Blazer','TrailBlazer','Traverse'], desde: 1990 },
    'Nissan':      { models: ['Frontier','Pathfinder','Armada','Navara','Titan','Xterra','Patrol','Terra'], desde: 1990 },
    'Mitsubishi':  { models: ['L200','Montero','Montero Sport','Outlander Sport','Pajero','Triton','Eclipse Cross'], desde: 1990 },
    'Jeep':        { models: ['Wrangler','Grand Cherokee','Cherokee','Compass','Renegade','Gladiator','Grand Wagoneer'], desde: 1990 },
    'Dodge':       { models: ['Ram 1500','Ram 2500','Ram 3500','Durango','Journey','Charger'], desde: 1990 },
    'Isuzu':       { models: ['D-Max','MU-X','Trooper','Rodeo'], desde: 1992 },
    'Mazda':       { models: ['BT-50','CX-50','CX-9'], desde: 1998 },
    'Honda':       { models: ['Ridgeline','Passport','Pilot'], desde: 1998 },
    'Hyundai':     { models: ['Tucson','Santa Cruz','Palisade','Creta'], desde: 2000 },
    'Kia':         { models: ['Telluride','Sorento','Mohave','Sportage'], desde: 2000 },
    'Ram':         { models: ['1500','2500','3500','1500 TRX','ProMaster'], desde: 2010 },
    'GMC':         { models: ['Sierra 1500','Sierra 2500','Canyon','Yukon','Acadia','Envoy'], desde: 1990 },
    'Volkswagen':  { models: ['Amarok','Touareg','Tiguan Allspace'], desde: 2010 },
    'Mercedes-Benz':{ models: ['Clase X','GLS','GLE','G-Klasse','AMG G63'], desde: 1998 },
    'BMW':         { models: ['X5','X6','X7','XM'], desde: 2000 },
    'Land Rover':  { models: ['Defender 110','Discovery','Range Rover','Sport'], desde: 1995 },
    'Lexus':       { models: ['GX','LX','RX'], desde: 1998 },
    'Lincoln':     { models: ['Navigator'], desde: 1998 },
    'Cadillac':    { models: ['Escalade','XT6'], desde: 2000 },
    'Haval':       { models: ['H9','Raptor'], desde: 2018 },
    'Great Wall':  { models: ['Cannon','Poer','Wingle'], desde: 2018 },
    'Mahindra':    { models: ['Scorpio','Thar','Bolero','XUV700'], desde: 2010 },
  },
  moto: {
    'Honda':       { models: ['CB300R','CBR600RR','CRF300L','Wave 110','PCX 150','XRE 300','CB500F','CB500X','Africa Twin','Gold Wing','CB1000R'], desde: 1990 },
    'Yamaha':      { models: ['YBR 125','MT-07','MT-09','FZ-25','NMAX 155','R15','R3','Fazer 250','XTZ 250','TMAX','R1'], desde: 1990 },
    'Suzuki':      { models: ['GS150','Gixxer 150','Gixxer 250','Access 125','Burgman 200','DR650','Boulevard M109R','GSX-R600'], desde: 1990 },
    'Kawasaki':    { models: ['Ninja 300','Ninja 400','Ninja 650','Z400','Z650','Versys 650','KLX 300','Z900','H2'], desde: 1990 },
    'KTM':         { models: ['Duke 200','Duke 390','Duke 790','RC 200','RC 390','Adventure 390','Adventure 790','1290 Super Duke'], desde: 2000 },
    'TVS':         { models: ['Apache RTR 160','Apache RTR 200','Ntorq 125','Raider 125','Jupiter','Star City'], desde: 2010 },
    'Bajaj':       { models: ['Pulsar 150','Pulsar 200 NS','Pulsar RS200','Dominar 400','Boxer 150','Avenger 220'], desde: 2000 },
    'Zongshen':    { models: ['ZS150','ZS200','ZS250','Cyclone 450'], desde: 2005 },
    'Hero':        { models: ['Splendor','Passion','HF Deluxe','Glamour','Xpulse 200'], desde: 2005 },
    'Royal Enfield':{ models: ['Bullet 350','Classic 350','Meteor 350','Himalayan','Thunderbird 350'], desde: 2010 },
    'Harley-Davidson':{ models: ['Sportster','Iron 883','Street 750','Fat Boy','Road King','Electra Glide','Pan America'], desde: 1990 },
    'Ducati':      { models: ['Monster','Panigale V2','Multistrada','Scrambler','Diavel'], desde: 2000 },
    'BMW Motorrad':{ models: ['R 1250 GS','F 850 GS','S 1000 RR','R nineT','C 400 X'], desde: 2000 },
    'Triumph':     { models: ['Street Twin','Bonneville','Tiger','Speed Twin','Trident 660'], desde: 2000 },
  },
  camion: {
    'Isuzu':       { models: ['NLR 55','NMR 85','NPR 75','NQR 90','FRR 90','FTR 33','FVR 34','ELF 150'], desde: 1990 },
    'Mitsubishi Fuso':{ models: ['Canter FE','Canter FG','Fighter FM','Fighter FK','Super Great FS'], desde: 1990 },
    'Hino':        { models: ['Dutro 300','Ranger 500','Profia 700','XZU300','XZU600'], desde: 1992 },
    'Mercedes-Benz':{ models: ['Sprinter 315','Actros 1845','Atego 1218','Axor 1933','Arocs'], desde: 1995 },
    'Ford':        { models: ['F-450','F-550','F-650','F-750','Cargo 1723','Transit Cargo'], desde: 1990 },
    'Chevrolet':   { models: ['NKR 55','NMR 85','NPR 65','FRR','W-Series','Kodiak'], desde: 1990 },
    'Toyota':      { models: ['Dyna 200','Dyna 300','Hiace Cargo','Land Cruiser 70 Pick-up'], desde: 1992 },
    'Kenworth':    { models: ['T270','T370','T440','T680','T800','W900','C500'], desde: 1995 },
    'Volvo':       { models: ['FH 400','FH 500','FM 330','FE 280','FL 230','FMX 460'], desde: 1995 },
    'Freightliner':{ models: ['Cascadia','M2 106','M2 112','122SD','Columbia'], desde: 1995 },
    'International':{ models: ['LT','HX','MV','MX','7600','8600'], desde: 1995 },
    'Peterbilt':   { models: ['579','589','567','520','330'], desde: 1995 },
    'Mack':        { models: ['Anthem','Pinnacle','Granite','TerraPro'], desde: 1995 },
    'Scania':      { models: ['R 450','R 500','P 280','G 410','S 500'], desde: 1998 },
    'MAN':         { models: ['TGX 18','TGS 26','TGL 8','TGM 15'], desde: 1998 },
    'DAF':         { models: ['XF 480','CF 340','LF 230'], desde: 2000 },
    'Foton':       { models: ['Aumark S','BJ1089','Auman GT','Tornado'], desde: 2010 },
    'Sinotruk':    { models: ['HOWO A7','Golden Prince','Sitrak C7H'], desde: 2012 },
    'Yutong':      { models: ['E12','T13','T7','E7'], desde: 2015 },
  },
  furgoneta: {
    'Toyota':      { models: ['HiAce Commuter','HiAce Panel Van','Proace','Alphard','Vellfire','HiAce Super Long'], desde: 1990 },
    'Ford':        { models: ['Transit 150','Transit 250','Transit 350','Transit Connect','E-150','E-250','E-350'], desde: 1990 },
    'Mercedes-Benz':{ models: ['Vito 114','Vito 119','Viano','Sprinter 310','Sprinter 314','Sprinter 516'], desde: 1995 },
    'Volkswagen':  { models: ['Transporter T6','Transporter T7','Crafter 30','Crafter 50','Caravelle','Multivan'], desde: 1995 },
    'Hyundai':     { models: ['H-1 Cargo','H-1 Wagon','Starex','County','HD35'], desde: 1998 },
    'Kia':         { models: ['Carnival','Grand Carnival','Bongo III','K2700'], desde: 1998 },
    'Nissan':      { models: ['NV200','NV300','NV400','Urvan NV350','Caravan','Primastar'], desde: 1995 },
    'Chevrolet':   { models: ['Express 1500','Express 2500','Express 3500','City Express'], desde: 1995 },
    'Renault':     { models: ['Trafic','Master','Kangoo','Express'], desde: 1998 },
    'Peugeot':     { models: ['Boxer','Expert','Partner','Traveller'], desde: 1998 },
    'Citroën':     { models: ['Jumper','Dispatch','Berlingo','SpaceTourer'], desde: 1998 },
    'Fiat':        { models: ['Ducato','Talento','Doblò','Fiorino'], desde: 1998 },
    'Opel':        { models: ['Movano','Vivaro','Combo'], desde: 2000 },
    'Maxus':       { models: ['V90','EV80','G10','T90'], desde: 2015 },
    'Iveco':       { models: ['Daily 35S','Daily 50C','Daily 70C'], desde: 2000 },
  },
  otro: {
    'Otro': { models: ['Especificar modelo'], desde: 1960 },
  }
};

// ──────────────────────────────────────────────
// PRECIO COMBUSTIBLE EN TIEMPO REAL — RD
// Fuente: micm.gob.do (scraping via IPC → main.js)
// El MICM publica los precios cada viernes como noticia HTML
// No existe API pública — se scrapea el artículo más reciente
// ──────────────────────────────────────────────
const _FUEL_FALLBACK = {
  premium:        335.10,  // RD$/galón — semana 30 mayo - 6 junio 2026
  regular:        307.50,  // Fuente: prestocombustibles.com / micm.gob.do
  diesel:         287.10,  // Gasoil Óptimo
  gasoil_regular: 259.80,
  glp:            137.20,
  gnv:             43.97,
};

let _fuelPricesCache   = null;
let _fuelPricesFetched = 0;
let _fuelPricesSource  = 'fallback';

async function _getFuelPrices() {
  // Cache de 6 horas — el MICM publica 1 vez por semana
  if (_fuelPricesCache && (Date.now() - _fuelPricesFetched) < 21600000) {
    return _fuelPricesCache;
  }

  // Intentar via IPC (main.js hace el fetch sin restricciones CORS)
  if (window.api?.fuel?.getPrices) {
    try {
      const res = await window.api.fuel.getPrices();
      if (res?.ok && res.data?.premium > 200) {
        _fuelPricesCache   = res.data;
        _fuelPricesFetched = Date.now();
        _fuelPricesSource  = res.source || 'micm';
        return _fuelPricesCache;
      }
    } catch(e) { console.warn('[Fuel] IPC error:', e.message); }
  }

  // Fallback directo desde renderer — Presto (tabla simple, menos CORS issues)
  try {
    const res = await fetch(
      'https://www.prestocombustibles.com/precios-combustibles/',
      { signal: AbortSignal.timeout(6000) }
    );
    if (res.ok) {
      const html   = await res.text();
      const get    = (label) => {
        const rx = new RegExp(label + '[^|\n]*[|:]\s*RD\$?\s*([\d,.]+)', 'i');
        const m  = html.match(rx);
        return m ? parseFloat(m[1].replace(/[^\d.]/g,'')) : null;
      };
      const premium = get('Gasolina Premium');
      if (premium && premium > 200) {
        const prices = {
          premium,
          regular:        get('Gasolina Regular') || Math.round(premium*0.917*10)/10,
          diesel:         get('Gasoil .ptimo')    || Math.round(premium*0.857*10)/10,
          gasoil_regular: get('Gasoil Regular')   || Math.round(premium*0.775*10)/10,
          glp:            get('Gas Licuado')       || _FUEL_FALLBACK.glp,
          gnv:            get('Gas Natural')       || _FUEL_FALLBACK.gnv,
        };
        _fuelPricesCache   = prices;
        _fuelPricesFetched = Date.now();
        _fuelPricesSource  = 'presto-directo';
        return prices;
      }
    }
  } catch(e) { console.warn('[Fuel] Presto directo error:', e.message); }

  // Último fallback — precios verificados más recientes
  _fuelPricesSource = 'estimado';
  return _FUEL_FALLBACK;
}

// Parsear precios del HTML del MICM
function _parseMICMPrices(html) {
  try {
    const clean  = n => parseFloat((n||'').replace(/[^\d.]/g, ''));
    // Patrones que aparecen en los artículos del MICM
    const matchP = html.match(/[Gg]asolina\s*[Pp]r[eé]mium[^<\d]*?([\d,]+\.?\d*)\s*(?:por\s*gal[oó]n)?/i);
    const matchR = html.match(/[Gg]asolina\s*[Rr]egular[^<\d]*?([\d,]+\.?\d*)\s*(?:por\s*gal[oó]n)?/i);
    const matchDO= html.match(/[Gg]asoil\s*[ÓOo]ptimo[^<\d]*?([\d,]+\.?\d*)\s*(?:por\s*gal[oó]n)?/i);
    const matchDR= html.match(/[Gg]asoil\s*[Rr]egular[^<\d]*?([\d,]+\.?\d*)\s*(?:por\s*gal[oó]n)?/i);
    const matchG = html.match(/[Gg][Ll][Pp][^<\d]*?([\d,]+\.?\d*)\s*(?:por\s*gal[oó]n)?/i);

    const p = clean(matchP?.[1]);
    const r = clean(matchR?.[1]);
    const d = clean(matchDO?.[1]);

    // Validar que los precios son coherentes (entre 100 y 800 RD$/gal)
    if (!p || p < 100 || p > 800) return null;

    return {
      premium:        p,
      regular:        r  || p * 0.917,
      diesel:         d  || p * 0.856,
      gasoil_regular: clean(matchDR?.[1]) || p * 0.774,
      glp:            clean(matchG?.[1])  || _FUEL_FALLBACK.glp,
    };
  } catch { return null; }
}

// ──────────────────────────────────────────────
// VALIDACIÓN INTELIGENTE DE MARCA/MODELO CON IA
// ──────────────────────────────────────────────
async function _validarMarcaConIA(tipo, marcaInput) {
  const todasMarcas = Object.keys(_VDB[tipo] || _VDB.carro);
  const prompt = `Eres un experto en vehículos en República Dominicana.
El usuario está registrando un vehículo de tipo "${TIPO_LABEL[tipo]}" y escribió la marca: "${marcaInput}".

Marcas conocidas en nuestro sistema: ${todasMarcas.join(', ')}

Analiza si la entrada del usuario corresponde a una marca real de vehículos. Si el usuario escribió una abreviación, error tipográfico, o nombre parcial, corrígelo.

Responde SOLO con JSON:
{
  "valido": true/false,
  "marcaCorrecta": "Nombre oficial de la marca",
  "estaEnDB": true/false,
  "sugerencias": ["Marca1", "Marca2", "Marca3"],
  "nota": "Breve explicación si es necesario"
}

Reglas:
- "TO" → Toyota (valido: true, marcaCorrecta: "Toyota")
- "TOYO" → Toyota
- "Toyotaa" → Toyota (typo)
- "Chevroelt" → Chevrolet
- "Mitsu" → Mitsubishi
- "Merced" → Mercedes-Benz
- "VW" → Volkswagen
- "BM" → BMW
- "marca inventada xyz" → valido: false
- Si la marca es real pero no está en la DB, estaEnDB: false pero valido: true`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) throw new Error('API error');
    const data  = await res.json();
    const texto = data.content?.[0]?.text || '';
    const clean = texto.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch {
    // Fallback: búsqueda local fuzzy
    const lower = marcaInput.toLowerCase();
    const marcas = Object.keys(_VDB[tipo] || _VDB.carro);
    const exacta = marcas.find(m => m.toLowerCase() === lower);
    const parcial = marcas.filter(m => m.toLowerCase().startsWith(lower.slice(0,3)));
    return {
      valido: parcial.length > 0,
      marcaCorrecta: exacta || parcial[0] || marcaInput,
      estaEnDB: !!exacta,
      sugerencias: parcial.slice(0, 5),
      nota: null,
    };
  }
}

async function _validarModeloConIA(tipo, marca, modeloInput, anio) {
  const modelos = (_VDB[tipo]?.[marca]?.models) || [];
  const anioDB  = _VDB[tipo]?.[marca]?.desde || 1990;
  const anioActual = new Date().getFullYear();

  // Validación de año
  if (anio) {
    if (anio < anioDB) {
      return { valido: false, modeloCorrecto: modeloInput, nota: `${marca} comenzó a fabricarse aproximadamente en ${anioDB}. Verifica el año.` };
    }
    if (anio > anioActual + 1) {
      return { valido: false, modeloCorrecto: modeloInput, nota: `El año ${anio} es mayor al año actual. Verifica.` };
    }
  }

  // Si el modelo está en la DB local, válido inmediatamente
  const enDB = modelos.find(m => m.toLowerCase() === modeloInput.toLowerCase());
  if (enDB) return { valido: true, modeloCorrecto: enDB, estaEnDB: true, nota: null };

  // Si no está, preguntar a la IA
  const prompt = `Eres un experto en vehículos.
Marca: ${marca}
Tipo: ${TIPO_LABEL[tipo]}
Año: ${anio || 'no especificado'}
Modelo ingresado: "${modeloInput}"
Modelos conocidos en DB: ${modelos.join(', ')}

¿Es "${modeloInput}" un modelo real de ${marca}? Si hay un error tipográfico o abreviación, corrígelo.

Responde SOLO con JSON:
{
  "valido": true/false,
  "modeloCorrecto": "nombre oficial del modelo",
  "estaEnDB": true/false,
  "existeParaElAnio": true/false,
  "nota": "explicación si es necesario"
}`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) throw new Error('API');
    const data  = await res.json();
    const clean = (data.content?.[0]?.text || '').replace(/```json|```/g,'').trim();
    return JSON.parse(clean);
  } catch {
    const parcial = modelos.filter(m =>
      m.toLowerCase().includes(modeloInput.toLowerCase().slice(0,4)));
    return {
      valido: parcial.length > 0 || modeloInput.length > 2,
      modeloCorrecto: parcial[0] || modeloInput,
      estaEnDB: false,
      existeParaElAnio: true,
      nota: parcial.length ? `¿Quisiste decir ${parcial[0]}?` : null,
    };
  }
}

// Rendimiento estimado por tipo y combustible (km/galón)
function _estimarRendimiento(tipo, fuelGrade) {
  const base = {
    carro:     { premium: 38, regular: 35, diesel: 45 },
    camioneta: { premium: 28, regular: 26, diesel: 32 },
    moto:      { premium: 65, regular: 60, diesel: 0  },
    camion:    { premium: 0,  regular: 0,  diesel: 14 },
    furgoneta: { premium: 22, regular: 20, diesel: 28 },
    otro:      { premium: 30, regular: 28, diesel: 35 },
  };
  return base[tipo]?.[fuelGrade] || 30;
}

// ── Render principal ──────────────────────────
async function renderVehiculos(el) {
  el.innerHTML = '<div style="padding:32px;text-align:center;color:var(--muted2)">Cargando vehículos...</div>';
  const user = _vUser();
  if (!user) return;

  if (!window.api?.vehicles) {
    el.innerHTML = '<div style="padding:32px;text-align:center;color:var(--red,#ef4444)">Módulo de vehículos no disponible. Reinicia la aplicación.</div>';
    return;
  }

  // Cargar vehículos + precio combustible en paralelo
  const [vehRes, pendRes, fuelPrices] = await Promise.all([
    window.api.vehicles.getAll(),
    window.api.maintenance.getPending(),
    _getFuelPrices(),
  ]);
  const vehiculos  = vehRes?.data  || [];
  const pendientes = pendRes?.data || [];

  // Guardar precios globalmente para el cálculo de envíos
  window._fuelPrices = fuelPrices;

  el.innerHTML = '';

  // Banner de precio de combustible actual
  const fuelBanner = document.createElement('div');
  fuelBanner.style.cssText = 'display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px;background:var(--bg2);border-radius:10px;border:0.5px solid var(--line2);padding:10px 14px;align-items:center';
  fuelBanner.innerHTML = `
    <span style="font-size:11px;color:var(--muted2);font-weight:600">⛽ PRECIO COMBUSTIBLE HOY (RD$/galón):</span>
    <span style="font-size:12px;font-weight:700;color:var(--green,#00c07a)">Premium: ${_vFmt(fuelPrices.premium)}</span>
    <span style="font-size:12px;font-weight:700;color:var(--blue,#3b82f6)">Regular: ${_vFmt(fuelPrices.regular)}</span>
    <span style="font-size:12px;font-weight:700;color:var(--amber,#f59e0b)">Gasoil: ${_vFmt(fuelPrices.diesel)}</span>
    <span style="font-size:10px;color:var(--muted2);margin-left:auto">
      Fuente: MIC RD · ${_fuelPricesSource === 'micm' || _fuelPricesSource === 'micm-directo' ? 
        '<span style=\'color:var(--green,#00c07a)\'>✓ tiempo real</span>' : 
        '<span style=\'color:var(--amber,#f59e0b)\">estimado — sin internet</span>'}
    </span>\``;
  el.appendChild(fuelBanner);

  // Header
  const hdr = document.createElement('div');
  hdr.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:8px';
  hdr.innerHTML = `
    <div>
      <h2 style="font-size:18px;font-weight:600;margin:0;color:var(--ink)">Vehículos y Mantenimiento</h2>
      <p style="font-size:12px;color:var(--muted2);margin:2px 0 0">${vehiculos.length} vehículo${vehiculos.length!==1?'s':''} registrado${vehiculos.length!==1?'s':''}</p>
    </div>
    <button class="btn btn-dark btn-sm" id="btn-nuevo-vehiculo">+ Nuevo vehículo</button>`;
  el.appendChild(hdr);

  // Alertas de mantenimiento
  if (pendientes.length) {
    const alert = document.createElement('div');
    alert.style.cssText = 'background:#fffbeb;border:1px solid #f59e0b;border-radius:8px;padding:10px 14px;margin-bottom:14px;font-size:12px;color:#92400e';
    alert.innerHTML = `⚠ <strong>${pendientes.length} mantenimiento${pendientes.length>1?'s':''} próximo${pendientes.length>1?'s':''}</strong>: 
      ${pendientes.slice(0,3).map(p=>`${p.brand} ${p.model} — ${p.type} (${_vDate(p.next_date)})`).join(' · ')}`;
    el.appendChild(alert);
  }

  if (!vehiculos.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'text-align:center;padding:48px;color:var(--muted2)';
    empty.innerHTML = '<div style="font-size:40px">🚗</div><div style="margin-top:8px;font-size:13px">Sin vehículos registrados</div><div style="font-size:11px;margin-top:4px">Agrega el primer vehículo de la empresa</div>';
    el.appendChild(empty);
  } else {
    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px';
    vehiculos.forEach(v => {
      // Costo por km con precio real de combustible
      const grade     = v.fuel_grade || 'premium';
      const precioGal = fuelPrices[grade] || fuelPrices.premium;
      const kmg       = v.km_per_gallon || 30;
      const costKm    = (precioGal / kmg).toFixed(2);

      const card = document.createElement('div');
      card.style.cssText = 'background:var(--bg2);border-radius:12px;border:0.5px solid var(--line2);overflow:hidden';
      card.innerHTML = `
        <div style="padding:14px 16px;border-bottom:1px solid var(--line2)">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
            <div style="font-size:20px">${TIPO_ICON[v.type]||'🚗'}</div>
            <span style="font-size:10px;padding:2px 8px;border-radius:100px;background:${STATUS_V[v.status]||'#6b7280'}22;color:${STATUS_V[v.status]||'#6b7280'};font-weight:600">${v.status}</span>
          </div>
          <div style="font-size:15px;font-weight:600;color:var(--ink)">${v.brand} ${v.model}</div>
          <div style="font-size:11px;color:var(--muted2)">${v.year||''} ${v.plate?'· '+v.plate:''} ${v.color?'· '+v.color:''}</div>
        </div>
        <div style="padding:10px 16px;font-size:12px;color:var(--muted2)">
          <div>⛽ ${v.fuel_grade} · ${kmg} km/gal · <strong style="color:var(--ink)">RD$${costKm}/km</strong></div>
          <div>📍 Odómetro: ${(v.odometer||0).toLocaleString()} km</div>
        </div>
        <div style="padding:8px 12px;display:flex;gap:6px;border-top:0.5px solid var(--line2)">
          <button class="btn btn-ghost btn-sm" style="flex:1" onclick="verMantenimiento(${v.id},'${v.brand} ${v.model}')">🔧 Mantenimiento</button>
          <button class="btn btn-ghost btn-sm" onclick="editarVehiculo(${v.id})">✏️</button>
          <button class="btn btn-ghost btn-sm" style="color:var(--red,#ef4444)" onclick="eliminarVehiculo(${v.id})">🗑</button>
        </div>`;
      grid.appendChild(card);
    });
    el.appendChild(grid);
  }

  document.getElementById('btn-nuevo-vehiculo')?.addEventListener('click', () => modalNuevoVehiculo(el));
}

// ── Modal nuevo/editar vehículo con validación inteligente ────────────────────
function modalNuevoVehiculo(parentEl, vehiculo = null) {
  const user  = _vUser();
  const title = vehiculo ? 'Editar vehículo' : 'Nuevo vehículo';
  const v     = vehiculo || {};
  const tipos = ['carro','camioneta','moto','camion','furgoneta','otro'];

  const html = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <div class="fg"><label class="lbl">Tipo *</label>
        <select class="inp" id="v-type">
          ${tipos.map(t=>`<option value="${t}" ${(v.type||'carro')===t?'selected':''}>${TIPO_ICON[t]} ${TIPO_LABEL[t]}</option>`).join('')}
        </select></div>
      <div class="fg"><label class="lbl">Estado</label>
        <select class="inp" id="v-status">
          <option value="activo"   ${(v.status||'activo')==='activo'?'selected':''}>✅ Activo</option>
          <option value="inactivo" ${v.status==='inactivo'?'selected':''}>⏸ Inactivo</option>
          <option value="taller"   ${v.status==='taller'?'selected':''}>🔧 En taller</option>
        </select></div>
    </div>

    <!-- MARCA con validación IA -->
    <div class="fg" style="position:relative">
      <label class="lbl">Marca *</label>
      <div style="display:flex;gap:6px">
        <input class="inp" id="v-brand" placeholder="Ej: Toyota, Honda, Hyundai..." value="${v.brand||''}" autocomplete="off" style="flex:1">
        <button class="btn btn-ghost btn-sm" id="btn-validar-marca" type="button" title="Validar marca con IA" style="white-space:nowrap">
          ✨ Validar
        </button>
      </div>
      <div id="v-brand-list" style="display:none;position:absolute;z-index:999;background:var(--bg);border:1px solid var(--line2);border-radius:8px;max-height:220px;overflow-y:auto;box-shadow:0 4px 20px #0003;width:100%;left:0;top:100%"></div>
      <div id="v-brand-feedback" style="font-size:11px;margin-top:4px;min-height:16px"></div>
    </div>

    <!-- MODELO con validación IA -->
    <div class="fg" style="position:relative">
      <label class="lbl">Modelo *</label>
      <div style="display:flex;gap:6px">
        <input class="inp" id="v-model" placeholder="Ej: Corolla, Civic, Tucson..." value="${v.model||''}" autocomplete="off" style="flex:1">
        <button class="btn btn-ghost btn-sm" id="btn-validar-modelo" type="button" title="Validar modelo con IA" style="white-space:nowrap">
          ✨ Validar
        </button>
      </div>
      <div id="v-model-list" style="display:none;position:absolute;z-index:999;background:var(--bg);border:1px solid var(--line2);border-radius:8px;max-height:220px;overflow-y:auto;box-shadow:0 4px 20px #0003;width:100%;left:0;top:100%"></div>
      <div id="v-model-feedback" style="font-size:11px;margin-top:4px;min-height:16px"></div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">
      <div class="fg"><label class="lbl">Año</label>
        <input class="inp" id="v-year" type="number" min="1960" max="${new Date().getFullYear()+1}"
               placeholder="${new Date().getFullYear()}" value="${v.year||''}">
        <div id="v-year-feedback" style="font-size:10px;margin-top:2px;color:var(--muted2)"></div>
      </div>
      <div class="fg"><label class="lbl">Placa</label>
        <input class="inp" id="v-plate" placeholder="A123456" value="${v.plate||''}"></div>
      <div class="fg"><label class="lbl">Color</label>
        <input class="inp" id="v-color" placeholder="Blanco" value="${v.color||''}"></div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <div class="fg"><label class="lbl">Tipo de combustible</label>
        <select class="inp" id="v-fuel-type">
          <option value="gasolina" ${(v.fuel_type||'gasolina')==='gasolina'?'selected':''}>Gasolina</option>
          <option value="diesel"   ${v.fuel_type==='diesel'?'selected':''}>Gasoil / Diesel</option>
          <option value="electrico"${v.fuel_type==='electrico'?'selected':''}>Eléctrico</option>
          <option value="hibrido"  ${v.fuel_type==='hibrido'?'selected':''}>Híbrido</option>
        </select></div>
      <div class="fg"><label class="lbl">Grado de gasolina</label>
        <select class="inp" id="v-fuel-grade">
          <option value="premium" ${(v.fuel_grade||'premium')==='premium'?'selected':''}>Premium</option>
          <option value="regular" ${v.fuel_grade==='regular'?'selected':''}>Regular</option>
          <option value="diesel"  ${v.fuel_grade==='diesel'?'selected':''}>Gasoil</option>
        </select></div>
    </div>

    <!-- Precio combustible en tiempo real -->
    <div id="v-fuel-price-info" style="background:var(--bg2);border-radius:8px;padding:10px 12px;font-size:12px;border:0.5px solid var(--line2);margin-bottom:4px">
      <div style="color:var(--muted2);font-size:10px;margin-bottom:4px">⛽ Precio actual del combustible seleccionado</div>
      <div id="v-fuel-price-val" style="font-weight:700;color:var(--ink);font-size:15px">Cargando...</div>
      <div id="v-fuel-cost-km"  style="color:var(--muted2);font-size:11px;margin-top:2px"></div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <div class="fg"><label class="lbl">Rendimiento (km/galón)</label>
        <input class="inp" id="v-kmg" type="number" step="0.1" min="1" placeholder="35" value="${v.km_per_gallon||''}">
        <div id="v-kmg-hint" style="font-size:10px;color:var(--muted2);margin-top:2px">Se calcula automáticamente según el tipo y combustible</div>
      </div>
      <div class="fg">
        <label class="lbl" style="display:flex;align-items:center;gap:6px">
          Odómetro actual (km)
          <span style="cursor:help;color:var(--muted2);font-size:11px;border:1px solid var(--line2);border-radius:50%;width:16px;height:16px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0"
                title="Kilómetros que muestra el tablero. Úsalo para programar mantenimientos.">?</span>
        </label>
        <input class="inp" id="v-odo" type="number" min="0" placeholder="0" value="${v.odometer||0}">
        <div style="font-size:10px;color:var(--muted2);margin-top:2px">Km del tablero del vehículo</div>
      </div>
    </div>
    <div class="fg"><label class="lbl">Notas</label>
      <textarea class="inp" id="v-notes" rows="2">${v.notes||''}</textarea></div>
    <input type="hidden" id="v-brand-valid" value="${vehiculo?'1':'0'}">
    <input type="hidden" id="v-model-valid" value="${vehiculo?'1':'0'}">`;

  // Capturar mainContent ANTES de abrir el modal
  // para no depender del DOM del overlay (que se remueve antes del callback)
  const _mainContent = document.getElementById('main-content') || parentEl;

  _vModal(title, html, async (overlay) => {
    const brand = overlay.querySelector('#v-brand')?.value.trim();
    const model = overlay.querySelector('#v-model')?.value.trim();
    const tipo  = overlay.querySelector('#v-type')?.value || 'carro';
    const grade = overlay.querySelector('#v-fuel-grade')?.value || 'premium';
    const kmgVal = overlay.querySelector('#v-kmg')?.value;
    const kmg   = kmgVal ? parseFloat(kmgVal) : _estimarRendimiento(tipo, grade);

    if (!brand || !model) throw new Error('Marca y modelo son obligatorios');
    if (kmg <= 0) throw new Error('El rendimiento debe ser mayor a 0');

    const anio = parseInt(overlay.querySelector('#v-year')?.value) || null;
    if (anio && (anio < 1960 || anio > new Date().getFullYear() + 1)) {
      throw new Error(`Año inválido: ${anio}`);
    }

    const data = {
      type:          tipo,
      brand, model,
      year:          anio,
      plate:         overlay.querySelector('#v-plate')?.value.trim(),
      color:         overlay.querySelector('#v-color')?.value.trim(),
      fuel_type:     overlay.querySelector('#v-fuel-type')?.value,
      fuel_grade:    grade,
      km_per_gallon: kmg,
      odometer:      parseFloat(overlay.querySelector('#v-odo')?.value) || 0,
      status:        overlay.querySelector('#v-status')?.value,
      notes:         overlay.querySelector('#v-notes')?.value,
    };

    let res;
    if (vehiculo) {
      res = await window.api.vehicles.update({ id: vehiculo.id, data, requestUserId: user.id });
    } else {
      res = await window.api.vehicles.create({ data, requestUserId: user.id });
    }
    if (!res.ok) throw new Error(res.error);
    _vToast(`✓ Vehículo ${vehiculo ? 'actualizado' : 'registrado'}`);
    // Usar _mainContent capturado antes — el overlay ya no existe en el DOM
    renderVehiculos(_mainContent);
  }, vehiculo ? 'Guardar cambios' : 'Registrar vehículo');

  // ── Lógica inteligente del modal ─────────────────────────────────────────
  setTimeout(async () => {
    const typeEl      = document.getElementById('v-type');
    const brandEl     = document.getElementById('v-brand');
    const modelEl     = document.getElementById('v-model');
    const yearEl      = document.getElementById('v-year');
    const kmgEl       = document.getElementById('v-kmg');
    const kmgHint     = document.getElementById('v-kmg-hint');
    const fuelTypeEl  = document.getElementById('v-fuel-type');
    const fuelGradeEl = document.getElementById('v-fuel-grade');
    const brandList   = document.getElementById('v-brand-list');
    const modelList   = document.getElementById('v-model-list');
    const brandFb     = document.getElementById('v-brand-feedback');
    const modelFb     = document.getElementById('v-model-feedback');
    const yearFb      = document.getElementById('v-year-feedback');
    const fuelPriceVal= document.getElementById('v-fuel-price-val');
    const fuelCostKm  = document.getElementById('v-fuel-cost-km');

    const fuelPrices  = window._fuelPrices || _FUEL_FALLBACK;

    // Actualizar precio de combustible mostrado
    function updateFuelPrice() {
      const grade = fuelGradeEl?.value || 'premium';
      const tipo  = typeEl?.value || 'carro';
      const kmg   = parseFloat(kmgEl?.value) || _estimarRendimiento(tipo, grade);
      const precio = fuelPrices[grade] || fuelPrices.premium;
      const costKm = precio / kmg;
      if (fuelPriceVal) fuelPriceVal.textContent = `${_vFmt(precio)} / galón`;
      if (fuelCostKm)   fuelCostKm.textContent   = `Costo estimado: RD$${costKm.toFixed(2)} por km`;
    }

    // Autocomplete local rápido
    function showDropdown(listEl, items, onSelect) {
      if (!items.length) { listEl.style.display = 'none'; return; }
      listEl.innerHTML = items.slice(0, 8).map(item => `
        <div style="padding:9px 14px;cursor:pointer;font-size:13px;border-bottom:0.5px solid var(--line2);
                    display:flex;align-items:center;gap:8px"
             onmouseenter="this.style.background='var(--bg2)'"
             onmouseleave="this.style.background=''"
             data-val="${item}">${item}</div>`).join('');
      listEl.style.display = 'block';
      listEl.querySelectorAll('div').forEach(div => {
        div.addEventListener('mousedown', (e) => {
          e.preventDefault();
          onSelect(div.dataset.val);
          listEl.style.display = 'none';
        });
      });
    }

    function getBrands(tipo, filter = '') {
      const db = _VDB[tipo] || _VDB.carro;
      return Object.keys(db).filter(m => !filter || m.toLowerCase().includes(filter.toLowerCase()));
    }

    function getModels(tipo, marca, filter = '') {
      const db = _VDB[tipo] || _VDB.carro;
      return (db[marca]?.models || []).filter(m => !filter || m.toLowerCase().includes(filter.toLowerCase()));
    }

    // Calcular rendimiento automático
    function autoRendimiento() {
      if (kmgEl?.dataset.manual === '1') return;
      const tipo  = typeEl?.value || 'carro';
      const ftype = fuelTypeEl?.value || 'gasolina';
      const grade = fuelGradeEl?.value || 'premium';
      if (ftype === 'electrico') {
        if (kmgEl) kmgEl.value = '';
        if (kmgHint) kmgHint.textContent = 'Eléctrico — sin consumo de combustible';
        return;
      }
      const est = _estimarRendimiento(tipo, ftype === 'diesel' ? 'diesel' : grade);
      if (kmgEl) kmgEl.value = est;
      if (kmgHint) kmgHint.textContent = `Estimado para ${TIPO_LABEL[tipo]||tipo} · puedes ajustarlo`;
    }

    // Validar marca con IA al hacer clic en botón
    document.getElementById('btn-validar-marca')?.addEventListener('click', async () => {
      const input = brandEl?.value.trim();
      if (!input) { brandFb.innerHTML = '<span style="color:var(--amber,#f59e0b)">Escribe una marca primero</span>'; return; }
      const btn = document.getElementById('btn-validar-marca');
      btn.disabled = true; btn.textContent = '⏳';
      brandFb.innerHTML = '<span style="color:var(--muted2)">Validando con IA...</span>';
      const resultado = await _validarMarcaConIA(typeEl?.value || 'carro', input);
      btn.disabled = false; btn.textContent = '✨ Validar';
      if (resultado.valido) {
        if (brandEl) brandEl.value = resultado.marcaCorrecta;
        document.getElementById('v-brand-valid').value = '1';
        brandFb.innerHTML = `<span style="color:var(--green,#00c07a)">✓ ${resultado.marcaCorrecta}${resultado.nota ? ' · ' + resultado.nota : ''}</span>`;
        // Cargar modelos de la marca confirmada
        showDropdown(modelList, getModels(typeEl?.value||'carro', resultado.marcaCorrecta), val => {
          if (modelEl) modelEl.value = val;
          modelFb.innerHTML = `<span style="color:var(--green,#00c07a)">✓ ${val}</span>`;
          document.getElementById('v-model-valid').value = '1';
        });
      } else {
        document.getElementById('v-brand-valid').value = '0';
        brandFb.innerHTML = `<span style="color:var(--red,#ef4444)">⚠ ${resultado.nota || 'Marca no reconocida'}</span>`;
        if (resultado.sugerencias?.length) {
          showDropdown(brandList, resultado.sugerencias, val => {
            if (brandEl) brandEl.value = val;
            document.getElementById('v-brand-valid').value = '1';
            brandFb.innerHTML = `<span style="color:var(--green,#00c07a)">✓ ${val}</span>`;
          });
        }
      }
    });

    // Validar modelo con IA
    document.getElementById('btn-validar-modelo')?.addEventListener('click', async () => {
      const marca = brandEl?.value.trim();
      const input = modelEl?.value.trim();
      const anio  = parseInt(yearEl?.value) || null;
      if (!input) { modelFb.innerHTML = '<span style="color:var(--amber,#f59e0b)">Escribe un modelo primero</span>'; return; }
      const btn = document.getElementById('btn-validar-modelo');
      btn.disabled = true; btn.textContent = '⏳';
      modelFb.innerHTML = '<span style="color:var(--muted2)">Validando con IA...</span>';
      const resultado = await _validarModeloConIA(typeEl?.value||'carro', marca, input, anio);
      btn.disabled = false; btn.textContent = '✨ Validar';
      if (resultado.valido) {
        if (modelEl) modelEl.value = resultado.modeloCorrecto;
        document.getElementById('v-model-valid').value = '1';
        modelFb.innerHTML = `<span style="color:var(--green,#00c07a)">✓ ${resultado.modeloCorrecto}${resultado.nota ? ' — ' + resultado.nota : ''}${resultado.existeParaElAnio === false ? ' ⚠ Verifica el año para este modelo' : ''}</span>`;
      } else {
        document.getElementById('v-model-valid').value = '0';
        modelFb.innerHTML = `<span style="color:var(--red,#ef4444)">⚠ ${resultado.nota || 'Modelo no reconocido para esta marca'}</span>`;
      }
    });

    // Autocomplete local en tiempo real (sin IA — rápido)
    brandEl?.addEventListener('input', () => {
      showDropdown(brandList, getBrands(typeEl?.value||'carro', brandEl.value), val => {
        brandEl.value = val;
        document.getElementById('v-brand-valid').value = '1';
        brandFb.innerHTML = `<span style="color:var(--green,#00c07a)">✓ ${val}</span>`;
        showDropdown(modelList, getModels(typeEl?.value||'carro', val), mv => {
          modelEl.value = mv;
          document.getElementById('v-model-valid').value = '1';
          modelFb.innerHTML = `<span style="color:var(--green,#00c07a)">✓ ${mv}</span>`;
        });
      });
    });

    brandEl?.addEventListener('focus', () =>
      showDropdown(brandList, getBrands(typeEl?.value||'carro', brandEl.value), val => {
        brandEl.value = val;
        brandFb.innerHTML = `<span style="color:var(--green,#00c07a)">✓ ${val}</span>`;
        showDropdown(modelList, getModels(typeEl?.value||'carro', val), mv => {
          modelEl.value = mv;
          modelFb.innerHTML = `<span style="color:var(--green,#00c07a)">✓ ${mv}</span>`;
        });
      })
    );

    modelEl?.addEventListener('input', () => {
      const marca = brandEl?.value.trim();
      showDropdown(modelList, getModels(typeEl?.value||'carro', marca, modelEl.value), val => {
        modelEl.value = val;
        document.getElementById('v-model-valid').value = '1';
        modelFb.innerHTML = `<span style="color:var(--green,#00c07a)">✓ ${val}</span>`;
      });
    });

    modelEl?.addEventListener('focus', () => {
      const marca = brandEl?.value.trim();
      showDropdown(modelList, getModels(typeEl?.value||'carro', marca, modelEl.value), val => {
        modelEl.value = val;
        modelFb.innerHTML = `<span style="color:var(--green,#00c07a)">✓ ${val}</span>`;
      });
    });

    // Validación de año en tiempo real
    yearEl?.addEventListener('input', () => {
      const anio = parseInt(yearEl.value);
      const actual = new Date().getFullYear();
      if (!anio) { yearFb.textContent = ''; return; }
      if (anio < 1960) { yearFb.style.color='var(--red,#ef4444)'; yearFb.textContent = 'Año muy antiguo'; }
      else if (anio > actual + 1) { yearFb.style.color='var(--red,#ef4444)'; yearFb.textContent = `Año mayor al actual (${actual})`; }
      else { yearFb.style.color='var(--green,#00c07a)'; yearFb.textContent = `✓ ${anio}`; }
    });

    // Combustible
    fuelTypeEl?.addEventListener('change', () => {
      if (fuelTypeEl.value === 'diesel' && fuelGradeEl) fuelGradeEl.value = 'diesel';
      else if (fuelTypeEl.value === 'electrico' && fuelGradeEl) fuelGradeEl.value = 'premium';
      autoRendimiento(); updateFuelPrice();
    });
    fuelGradeEl?.addEventListener('change', () => { autoRendimiento(); updateFuelPrice(); });
    kmgEl?.addEventListener('input', () => { kmgEl.dataset.manual = '1'; updateFuelPrice(); });
    typeEl?.addEventListener('change', () => {
      brandEl.value = ''; modelEl.value = '';
      brandFb.innerHTML = ''; modelFb.innerHTML = '';
      document.getElementById('v-brand-valid').value = '0';
      document.getElementById('v-model-valid').value = '0';
      autoRendimiento(); updateFuelPrice();
      showDropdown(brandList, getBrands(typeEl.value), val => { brandEl.value = val; });
    });

    // Cerrar dropdowns al click fuera
    document.addEventListener('mousedown', (e) => {
      if (!brandEl?.contains(e.target) && !brandList?.contains(e.target)) brandList.style.display = 'none';
      if (!modelEl?.contains(e.target) && !modelList?.contains(e.target)) modelList.style.display = 'none';
    });

    // Inicializar
    autoRendimiento();
    updateFuelPrice();
  }, 150);
}

// ── Mantenimiento de un vehículo ──────────────
window.verMantenimiento = async (vehicleId, vehicleName) => {
  const user = _vUser();
  const [histRes, typesRes] = await Promise.all([
    window.api.maintenance.getByVehicle({ vehicleId }),
    window.api.maintenance.getTypes(),
  ]);
  const historial = histRes?.data || [];
  const tipos     = typesRes?.data || [];

  const histHtml = historial.length ? `
    <table style="width:100%;border-collapse:collapse;font-size:12px">
      <thead><tr style="border-bottom:1px solid var(--line2);color:var(--muted2)">
        <th style="padding:6px;text-align:left">Fecha</th>
        <th style="padding:6px;text-align:left">Tipo</th>
        <th style="padding:6px;text-align:left">Taller</th>
        <th style="padding:6px;text-align:right">Costo</th>
        <th style="padding:6px;text-align:left">Próximo</th>
      </tr></thead>
      <tbody>${historial.map((m,i) => `
        <tr style="border-bottom:0.5px solid var(--line2);background:${i%2?'var(--bg2)':''}">
          <td style="padding:6px;color:var(--muted2)">${_vDate(m.date_done)}</td>
          <td style="padding:6px;font-weight:500">${m.type}</td>
          <td style="padding:6px;color:var(--muted2)">${m.workshop||'—'}</td>
          <td style="padding:6px;text-align:right">${_vFmt(m.cost)}</td>
          <td style="padding:6px">${m.next_date?`<span style="color:var(--amber,#f59e0b)">${_vDate(m.next_date)}</span>`:'—'}</td>
        </tr>`).join('')}</tbody>
    </table>` : '<div style="text-align:center;padding:24px;color:var(--muted2);font-size:13px">Sin registros de mantenimiento</div>';

  _vModal(`🔧 Mantenimiento — ${vehicleName}`, `
    <div style="display:flex;justify-content:flex-end;margin-bottom:12px">
      <button class="btn btn-dark btn-sm" id="btn-nuevo-mant">+ Registrar mantenimiento</button>
    </div>
    ${histHtml}`,
    async () => {}, 'Cerrar');

  setTimeout(() => {
    document.getElementById('btn-nuevo-mant')?.addEventListener('click', () =>
      modalNuevoMantenimiento(vehicleId, vehicleName, tipos, user));
  }, 100);
};

function modalNuevoMantenimiento(vehicleId, vehicleName, tipos, user) {
  const html = `
    <div style="font-size:12px;color:var(--muted2);margin-bottom:12px">Vehículo: <strong>${vehicleName}</strong></div>
    <div class="fg"><label class="lbl">Tipo de mantenimiento *</label>
      <select class="inp" id="m-type">
        <option value="">Selecciona...</option>
        ${tipos.map(t=>`<option value="${t.name}">${t.name}</option>`).join('')}
        <option value="__otro">Otro (especificar)</option>
      </select></div>
    <div class="fg" id="m-otro-wrap" style="display:none"><label class="lbl">Especificar</label>
      <input class="inp" id="m-otro" placeholder="Tipo de mantenimiento"></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <div class="fg"><label class="lbl">Fecha *</label>
        <input class="inp" id="m-date" type="date" value="${_vToday()}"></div>
      <div class="fg"><label class="lbl">Costo (RD$)</label>
        <input class="inp" id="m-cost" type="number" min="0" placeholder="0"></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <div class="fg"><label class="lbl">Odómetro actual (km)</label>
        <input class="inp" id="m-odo" type="number" placeholder="Km al hacer el servicio"></div>
      <div class="fg"><label class="lbl">Próxima fecha</label>
        <input class="inp" id="m-next" type="date"></div>
    </div>
    <div class="fg"><label class="lbl">Taller / Mecánico</label>
      <input class="inp" id="m-workshop" placeholder="Nombre del taller"></div>
    <div class="fg"><label class="lbl">Notas</label>
      <textarea class="inp" id="m-notes" rows="2"></textarea></div>`;

  _vModal('Registrar mantenimiento', html, async (overlay) => {
    let type = overlay.querySelector('#m-type')?.value;
    if (type === '__otro') type = overlay.querySelector('#m-otro')?.value.trim();
    if (!type) throw new Error('Selecciona el tipo de mantenimiento');
    const res = await window.api.maintenance.create({
      data: {
        vehicle_id:  vehicleId, type,
        date_done:   overlay.querySelector('#m-date')?.value,
        cost:        parseFloat(overlay.querySelector('#m-cost')?.value) || 0,
        odometer_at: parseFloat(overlay.querySelector('#m-odo')?.value) || null,
        next_date:   overlay.querySelector('#m-next')?.value || null,
        workshop:    overlay.querySelector('#m-workshop')?.value.trim(),
        notes:       overlay.querySelector('#m-notes')?.value,
      },
      requestUserId: user.id,
    });
    if (!res.ok) throw new Error(res.error);
    _vToast('✓ Mantenimiento registrado');
    const el = document.getElementById('main-content');
    if (el) renderVehiculos(el);
  }, 'Registrar');

  setTimeout(() => {
    document.getElementById('m-type')?.addEventListener('change', (e) => {
      document.getElementById('m-otro-wrap').style.display = e.target.value === '__otro' ? 'block' : 'none';
    });
  }, 100);
}

window.editarVehiculo = async (id) => {
  const res = await window.api.vehicles.getAll();
  const v = (res?.data||[]).find(x => x.id === id);
  if (!v) return;
  const el = document.getElementById('main-content');
  modalNuevoVehiculo(el, v);
};

window.eliminarVehiculo = async (id) => {
  if (!confirm('¿Eliminar este vehículo? También se eliminará su historial de mantenimiento.')) return;
  const user = _vUser();
  const res  = await window.api.vehicles.delete({ id, requestUserId: user.id });
  if (!res.ok) return alert(res.error);
  _vToast('✓ Vehículo eliminado');
  const el = document.getElementById('main-content');
  if (el) renderVehiculos(el);
};

// ── Utilidades ────────────────────────────────
function _vModal(titulo, html, onConfirm, confirmLabel='Guardar') {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:#0008;z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px';
  overlay.innerHTML = `
    <div style="background:var(--bg);border-radius:14px;width:100%;max-width:560px;max-height:90vh;overflow-y:auto;box-shadow:0 8px 40px #0004">
      <div style="display:flex;justify-content:space-between;align-items:center;padding:16px 20px;border-bottom:1px solid var(--line2)">
        <div style="font-size:15px;font-weight:600">${titulo}</div>
        <button id="vm-close" style="background:none;border:none;cursor:pointer;color:var(--muted2);font-size:18px">✕</button>
      </div>
      <div style="padding:20px" id="vm-body">${html}</div>
      <div style="padding:16px 20px;border-top:1px solid var(--line2);display:flex;gap:8px;justify-content:flex-end">
        <button class="btn btn-ghost" id="vm-cancel">Cancelar</button>
        <button class="btn btn-dark" id="vm-confirm">${confirmLabel}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#vm-close')?.addEventListener('click',   () => overlay.remove());
  overlay.querySelector('#vm-cancel')?.addEventListener('click',  () => overlay.remove());
  overlay.querySelector('#vm-confirm')?.addEventListener('click', async () => {
    const btn = overlay.querySelector('#vm-confirm');
    btn.disabled = true; btn.textContent = 'Guardando...';
    try { await onConfirm(overlay); overlay.remove(); }
    catch(e) { btn.disabled = false; btn.textContent = confirmLabel; alert(e.message); }
  });
  return overlay;
}

function _vToast(msg) {
  if (typeof toast === 'function') { toast(msg); return; }
  const t = document.createElement('div');
  t.style.cssText = 'position:fixed;bottom:24px;right:24px;background:var(--ink);color:var(--bg);padding:10px 18px;border-radius:8px;font-size:13px;z-index:99999;animation:fadeIn .2s';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}
