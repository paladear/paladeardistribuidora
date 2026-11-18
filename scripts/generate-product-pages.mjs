// Genera una página real por producto y por rubro de la DISTRIBUIDORA, para que
// Google (y WhatsApp) vean el contenido en el HTML y no sólo después de correr JS.
// NO toca precios-may.csv ni catalogo-panel.json: sólo los lee.
//
// Diferencias con la tienda minorista, que es de donde sale este script:
//   · una sola lista de precios y SIN IVA
//   · la venta es por bulto cerrado: el precio que se publica es el del bulto
//     entero (precio unitario x bulto), no el de la unidad suelta
//   · no hay granel ni ofertas del mes
//   · precio 0 significa sin stock: se publica el producto sin precio
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE_URL || 'https://mayorista.paladear.com.ar/';
const TIENDA = 'Paladear Distribuidora';
const SALIDA = process.env.SALIDA || '.';
const DIRECCION = 'Ruta Provincial 50 Nº 13080, KM 8 — Guaymallén';

const VALID_RUBROS = new Map([
  ['FRUTOS SECOS','Frutos Secos'],['DESHIDRATADOS','Deshidratados'],['SEMILLAS','Semillas'],
  ['ESPECIAS','Especias'],['INFUSIONES Y HIERBAS','Infusiones y Hierbas'],['CEREALES','Cereales'],
  ['GRANOS Y LEGUMBRES','Granos y Legumbres'],['HARINAS','Harinas'],['PRODUCTOS SIN TACC','Sin TACC'],
  ['DULCES, MIEL Y CHOCOLATES','Dulces, Miel y Chocolates'],['AZUCAR, CACAO Y REPOSTERIA','Azúcar, Cacao y Repostería'],
  ['MANTECAS Y PASTAS','Mantecas y Pastas'],['ACEITES Y VINAGRES','Aceites y Vinagres'],['ACEITUNAS','Aceitunas'],
  ['ENCURTIDOS','Encurtidos'],['TOMATE TRITURADO','Tomate'],['SNACK','Snacks'],['SUPLEMENTOS','Suplementos'],
  ['LINEA GOURMET','Línea Gourmet'],['BEBIDAS','Bebidas'],['VINOS','Vinos y Licores'],
  ['PRODUCTOS DE FRIO','Productos de Frío'],['PRODUCTOS CONGELADOS','Congelados'],['PALADEAR HOME','Paladear Home']
]);

function parseCsv(csv){
  const rows=[]; const lines=csv.trim().split(/\r?\n/); let i=0;
  while(i<lines.length){
    let raw=lines[i++]; let q=(raw.match(/"/g)||[]).length;
    while(q%2!==0 && i<lines.length){ raw+='\n'+lines[i++]; q=(raw.match(/"/g)||[]).length; }
    const cols=[]; let cur=''; let quoted=false;
    for(let j=0;j<raw.length;j++){
      const ch=raw[j];
      if(ch==='"'){ if(quoted&&raw[j+1]==='"'){cur+='"';j++;} else quoted=!quoted; }
      else if(ch===','&&!quoted){ cols.push(cur.trim()); cur=''; }
      else cur+=ch;
    }
    cols.push(cur.trim()); rows.push(cols);
  }
  return rows;
}
const norm = v => String(v||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toUpperCase().trim();
const slug = v => String(v||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase()
  .replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').replace(/-{2,}/g,'-');
const cleanId = v => String(v||'').trim().replace(/\./g,'').replace(/,.*$/,'');
function price(v){
  const c=String(v||'').replace(/[^0-9,.]/g,'').replace(/\./g,'').replace(',','.');
  const n=Number.parseFloat(c); return Number.isFinite(n)?Math.round(n):0;
}
const esc = v => String(v==null?'':v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
const fmt = n => new Intl.NumberFormat('es-AR').format(Math.round(n||0));
function recorte(t,max){
  t=String(t||'').replace(/\s+/g,' ').trim();
  if(t.length<=max) return t;
  const corte=t.slice(0,max-1);
  return corte.slice(0,corte.lastIndexOf(' ')).replace(/[,;:.\s]+$/,'')+'…';
}
/* Bulto: se lee EXACTAMENTE como lo hace el sitio (_cargarInfoMay), porque el
   precio publicado es precio_unitario x bulto y cualquier diferencia publica un
   precio equivocado. Dos trampas reales:
     · "11.34" es ONCE COMA TREINTA Y CUATRO kilos, no once mil trescientos
       treinta y cuatro: hay que leerlo con parseFloat, no con el formato de
       miles argentino.
     · si el producto no tiene ficha en el panel, el bulto es 1. NO se usa la
       columna "Patente" del CSV, que a veces dice otra cosa. */
function bultoDe(fi){
  const crudo = String((fi && fi.bulto!=null) ? fi.bulto : '').trim();
  const n = Number.parseFloat(crudo.replace(',', '.')) || 1;
  const unidad = (fi && fi.bultoUnidad)
    ? String(fi.bultoUnidad).trim()
    : ((/kg|kgr|kilo/i.test(crudo) || (n % 1 !== 0)) ? 'kg' : 'unidad');
  return { n, unidad };
}
// Mismo texto que muestra la tienda: "12 Unidades", "11,34 Kg", "1 Unidad".
function bultoLabel(n, unidad){
  const s = String(n).replace('.', ',');
  if(unidad === 'kg') return s + ' Kg';
  return n === 1 ? '1 Unidad' : s + ' Unidades';
}

function buildProducts(pricesCsv, fichas, rubrosOcultos, descsPorId){
  const rows=parseCsv(pricesCsv);
  const ocultos=new Set((rubrosOcultos||[]).map(norm));
  const porId=new Map();
  for(const cols of rows.slice(1)){
    if(cols.length<6) continue;
    const rubroKey=norm(cols[2]);
    const id=cleanId(cols[3]);
    const nombreCsv=String(cols[4]||'').replace(/^"|"$/g,'').trim();
    const unitario=price(cols[5]);

    if(!nombreCsv||!id||!VALID_RUBROS.has(rubroKey)||ocultos.has(rubroKey)) continue;
    const fi=fichas[id]||{};
    if(fi.oculto===true) continue;
    const nombre=String(fi.nombre||nombreCsv).trim();
    const sl=slug(nombre)+'-'+slug(id);
    if(!slug(nombre)||!slug(id)) continue;
    const b=bultoDe(fi);
    // Precio 0 en la planilla = sin stock. El producto se publica igual, sin
    // precio: asi el cliente sabe que existe y pregunta, en vez de no verlo.
    const precioBulto = unitario>0 ? unitario*b.n : 0;
    porId.set(id,{
      id, nombre, slug:sl, rubroKey,
      rubro: VALID_RUBROS.get(rubroKey), rubroSlug: slug(VALID_RUBROS.get(rubroKey)),
      desc: String(fi.desc||descsPorId[id]||'').trim(),
      marca: String(fi.marca||'').trim(),
      envase: String(fi.envase||'').trim(),
      bulto: b.n, bultoUnidad: b.unidad,
      bultoLabel: bultoLabel(b.n, b.unidad),
      unitario, precio: precioBulto, sinStock: !precioBulto,
      url: BASE+'p/'+sl+'/'
    });
  }
  return [...porId.values()].sort((a,b)=>a.nombre.localeCompare(b.nombre,'es',{sensitivity:'base'}));
}

/* El estilo NO se escribe aca: se saca del propio index.html, de las mismas
   reglas que pinta la ficha abierta del catalogo mayorista. */
const PREFIJOS = ['.product-detail','.pdrel-','.opt-btn','.prices','.price-min','.price-may',
  '.price-label','.price-unit','.add-btn','.add-cart-icon','.nom-p','.nom-c','.nom-m','.nom-meta',
  '.precio-oferta','.precio-tachado','.product-image-placeholder','.opt-btns','.sello-d'];
function cssDeLaTienda(html){
  const bloques=[...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m=>m[1]).join('\n');
  const raiz=(bloques.match(/:root\{[^}]*\}/)||[''])[0];
  const reglas=[];
  const re=/@media[^{]*\{(?:[^{}]|\{[^{}]*\})*\}|[^{}]+\{[^{}]*\}/g;
  let m;
  while((m=re.exec(bloques))){
    const t=m[0];
    const sel=t.trimStart().startsWith('@media') ? t : t.split('{')[0];
    if(PREFIJOS.some(p=>sel.includes(p))) reglas.push(t);
  }
  if(reglas.length<40) throw new Error('Solo se extrajeron '+reglas.length+' reglas de index.html; se cancela para no publicar paginas sin estilo');
  return raiz + '\n' + reglas.join('\n') + `
*{margin:0;padding:0;box-sizing:border-box;font-family:'Montserrat',sans-serif}
button{cursor:pointer;border:none;font-family:inherit}
img{max-width:100%}
html,body{margin:0;background:#f8f5ef}
body{font-family:'Montserrat',system-ui,-apple-system,'Segoe UI',sans-serif;color:var(--fg);line-height:1.5}
.product-detail{position:static!important;inset:auto!important;z-index:auto!important;min-height:100vh;animation:none}
.product-detail-bar{position:sticky;top:0}
.product-detail-bar a{text-decoration:none}
.product-detail-title{margin-top:0}
.product-detail-buy .add-btn{text-decoration:none;margin-top:4px}
.pdrel-card{text-decoration:none}
.pdrel-img img{max-width:100%;max-height:100%;object-fit:contain}
.pd-pie{margin:34px 0 0;padding:18px 0 40px;text-align:center;font-size:12.5px;color:#6b8aa1}
.pd-rubro-intro{margin:0 0 18px;color:#496579;font-size:14.5px}
/* Propias de la distribuidora: el bulto y la aclaracion de IVA. */
.pd-bulto{display:inline-block;margin:0 0 10px;padding:5px 11px;border-radius:999px;background:rgba(79,140,174,.13);color:#2c5f80;font-size:12.5px;font-weight:700}
.pd-iva{margin-top:7px;font-size:12px;color:#6b8aa1}
.pd-sinstock{margin-top:4px;font-size:13.5px;font-weight:700;color:#9a5b3d}
`;
}

const ICONO_CARRITO = '<span class="add-cart-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3h2l2.4 10.3a2 2 0 0 0 2 1.6h7.8a2 2 0 0 0 2-1.6L21 7H6"/><circle cx="9" cy="20" r="1.4" fill="currentColor" stroke="none"/><circle cx="18" cy="20" r="1.4" fill="currentColor" stroke="none"/></svg></span>';
const FLECHA = '<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>';

function pagina({title, desc, canonical, image, body, schema}){
  return `<!DOCTYPE html>
<html lang="es-AR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Paladear Distribuidora">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(canonical)}">
${image?`<meta property="og:image" content="${esc(image)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${esc(image)}">`:'<meta name="twitter:card" content="summary">'}
<meta property="og:locale" content="es_AR">
<link rel="icon" href="${BASE}favicon-may-p-32.png" sizes="32x32">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="${BASE}ficha-producto.css">
<script type="application/ld+json">${JSON.stringify(schema)}</script>
</head>
<body class="min-redesign">
${body}
</body>
</html>
`;
}

function barra(volverA){
  return `<div class="product-detail-bar">
    <a class="product-detail-back" href="${esc(volverA)}" aria-label="Volver">${FLECHA}</a>
    <strong>Detalle del producto</strong>
    <a class="product-detail-close" href="${BASE}" aria-label="Ir al catálogo">×</a>
  </div>`;
}

function miniCard(q){
  const img = q.tieneFoto ? BASE+'fotos/'+q.id+'.webp' : '';
  return `<a class="pdrel-card" href="${BASE}p/${esc(q.slug)}/">`
    + `<span class="pdrel-img">${img?`<img src="${esc(img)}" alt="${esc(q.nombre)}" loading="lazy" decoding="async" width="200" height="200">`:'<span class="product-image-placeholder" aria-hidden="true"></span>'}</span>`
    + `<span class="pdrel-nom"><b class="nom-p">${esc(q.nombre)}</b>${q.marca?`<span class="nom-meta"><em class="nom-m">${esc(q.marca)}</em></span>`:''}</span>`
    + `<span class="pdrel-precio">${q.sinStock?'Consultar':'$'+fmt(q.precio)}</span>`
    + `</a>`;
}

function paginaProducto(p, hermanos, hayFoto){
  const img = hayFoto ? BASE+'fotos/'+p.id+'.webp' : '';
  const titulo = p.nombre + (p.marca?' '+p.marca:'') + ' por mayor | Paladear Distribuidora';
  const descMeta = recorte(
    p.desc || (p.nombre+(p.marca?' de '+p.marca:'')+'. Venta mayorista por bulto cerrado de '+p.bultoLabel+'. Precios sin IVA. Paladear Distribuidora, Mendoza.'),
    158);

  const metaFila = (p.marca || p.envase)
    ? `<div class="product-detail-meta">${p.envase?`<span class="nom-c">${esc(p.envase)}</span>`:''}${p.marca?`<em class="nom-m">${esc(p.marca)}</em>`:''}</div>` : '';

  const offers = p.sinStock
    ? {"@type":"Offer","priceCurrency":"ARS","availability":"https://schema.org/OutOfStock","url":p.url}
    : {"@type":"Offer","priceCurrency":"ARS","price":p.precio,
       "availability":"https://schema.org/InStock","url":p.url,
       "eligibleQuantity":{"@type":"QuantitativeValue","value":p.bulto,"unitText":p.bultoUnidad},
       "valueAddedTaxIncluded":false};
  const schema = {"@context":"https://schema.org","@graph":[
    {"@type":"Product","name":p.nombre,
     ...(p.desc?{"description":p.desc}:{}),
     ...(img?{"image":[img]}:{}),
     ...(p.marca?{"brand":{"@type":"Brand","name":p.marca}}:{}),
     "sku":p.id,"category":p.rubro,"offers":offers,
     "seller":{"@type":"Organization","name":TIENDA}},
    {"@type":"BreadcrumbList","itemListElement":[
      {"@type":"ListItem","position":1,"name":"Inicio","item":BASE},
      {"@type":"ListItem","position":2,"name":p.rubro,"item":BASE+'c/'+p.rubroSlug+'/'},
      {"@type":"ListItem","position":3,"name":p.nombre,"item":p.url}]}]};

  const bloquePrecio = p.sinStock
    ? `<div class="prices"><div><span class="price-label">Precio</span><div class="price-min">Consultar</div></div></div>
       <div class="pd-sinstock">Sin stock por el momento. Consultanos por WhatsApp.</div>`
    : `<div class="prices"><div><span class="price-label">Precio por bulto</span><div class="price-min">$${fmt(p.precio)}</div></div>
         <div><span class="price-label">Por ${esc(p.bultoUnidad)}</span><div class="price-may">$${fmt(p.unitario)}</div></div></div>
       <div class="pd-iva">Los precios no incluyen IVA. La venta es por bulto cerrado.</div>`;

  const body = `<section class="product-detail">
${barra(BASE+'c/'+p.rubroSlug+'/')}
<div class="product-detail-shell"><div class="product-detail-main">
  <div class="product-detail-image">${img?`<img src="${esc(img)}" alt="${esc(p.nombre)}${p.marca?' '+esc(p.marca):''}" width="900" height="900" decoding="async">`:'<span class="product-image-placeholder" aria-hidden="true"></span>'}</div>
  <div class="product-detail-copy">
    <div class="product-detail-category">${esc(p.rubro)}</div>
    <h1 class="product-detail-title">${esc(p.nombre)}</h1>
    ${metaFila}
    <div class="pd-bulto">Bulto cerrado: ${esc(p.bultoLabel)}</div>
    ${p.desc?`<div class="product-detail-info">${esc(p.desc)}</div>`:''}
    <div class="product-detail-buy">
      ${bloquePrecio}
      <a class="add-btn" href="${BASE}?producto=${esc(p.slug)}">${ICONO_CARRITO} Ver en el catálogo</a>
    </div>
  </div>
  ${hermanos.length?`<div class="product-detail-rel"><h3 class="pdrel-tit">Relacionados</h3><div class="pdrel-fila">${hermanos.map(miniCard).join('')}</div></div>`:''}
</div></div>
<p class="pd-pie">${TIENDA} · ${esc(DIRECCION)} · <a href="${BASE}">Ver todo el catálogo mayorista</a></p>
</section>`;
  return pagina({title:titulo, desc:descMeta, canonical:p.url, image:img, body, schema});
}

function paginaRubro(rubro, rubroSlug, prods){
  const url = BASE+'c/'+rubroSlug+'/';
  const titulo = rubro + ' por mayor en Mendoza | Paladear Distribuidora';
  const descMeta = recorte(`${rubro} por mayor: ${prods.slice(0,6).map(p=>p.nombre).join(', ')} y más. Venta mayorista por bulto cerrado, precios sin IVA. Paladear Distribuidora, Mendoza.`, 158);
  const schema = {"@context":"https://schema.org","@graph":[
    {"@type":"CollectionPage","name":rubro,"url":url,
     "mainEntity":{"@type":"ItemList","numberOfItems":prods.length,
       "itemListElement":prods.slice(0,60).map((p,i)=>({"@type":"ListItem","position":i+1,"name":p.nombre,"url":p.url}))}},
    {"@type":"BreadcrumbList","itemListElement":[
      {"@type":"ListItem","position":1,"name":"Inicio","item":BASE},
      {"@type":"ListItem","position":2,"name":rubro,"item":url}]}]};
  const body = `<section class="product-detail">
${barra(BASE)}
<div class="product-detail-shell">
  <div class="product-detail-category">Categoría</div>
  <h1 class="product-detail-title">${esc(rubro)}</h1>
  <p class="pd-rubro-intro">${prods.length} productos de ${esc(rubro.toLowerCase())} para comprar por mayor en Paladear Distribuidora, Mendoza. La venta es por bulto cerrado y los precios no incluyen IVA.</p>
  <div class="product-detail-rel"><h3 class="pdrel-tit">Todos los productos</h3><div class="pdrel-fila">${prods.map(miniCard).join('')}</div></div>
</div>
<p class="pd-pie">${TIENDA} · ${esc(DIRECCION)} · <a href="${BASE}">Ver todo el catálogo mayorista</a></p>
</section>`;
  return pagina({title:titulo, desc:descMeta, canonical:url, image:BASE+'og-image-may-blue.jpg', body, schema});
}

// Descripciones: el panel mayorista ya trae "desc" en la mayoria. Para los que
// no, se usa la columna "info" de info-min.csv, cruzada por numero de articulo,
// que es lo mismo que hace el sitio en vivo.
function descsDeInfoMin(csv){
  const rows=parseCsv(csv); const out={};
  if(!rows.length) return out;
  const cab=rows[0].map(c=>norm(c));
  const iInfo=cab.indexOf('INFO'), iArt=cab.findIndex(c=>c.startsWith('ARTICULO'));
  if(iInfo<0||iArt<0) return out;
  for(const c of rows.slice(1)){
    const id=cleanId(c[iArt]||''); const t=String(c[iInfo]||'').trim();
    if(id&&t) out[id]=t;
  }
  return out;
}

// ───────────────────────────────────────────────────────────────
const [pricesRaw, panelRaw, indexRaw] = await Promise.all([
  readFile('precios-may.csv','utf8'), readFile('catalogo-panel.json','utf8'), readFile('index.html','utf8')
]);
let infoMinRaw=''; try{ infoMinRaw = await readFile('info-min.csv','utf8'); }catch(e){}
let fotosPropias={}; try{ fotosPropias = JSON.parse(await readFile('fotos-propias.json','utf8'))||{}; }catch(e){}

const CSS = cssDeLaTienda(indexRaw);
const panel = JSON.parse(panelRaw)||{};
const fichas = panel.fichas||{};
if(!Object.keys(fichas).length) throw new Error('catalogo-panel.json no trae fichas');
const descs = descsDeInfoMin(infoMinRaw.replace(/\r\n?/g,'\n'));
const productos = buildProducts(pricesRaw.replace(/\r\n?/g,'\n'), fichas, panel.rubrosOcultos||[], descs);
if(productos.length<150) throw new Error('Solo '+productos.length+' productos; se cancela para no romper lo publicado');

for(const p of productos){
  p.tieneFoto = !!fotosPropias[p.id] || existsSync(path.join(SALIDA,'fotos',p.id+'.webp'));
}

const porRubro=new Map();
for(const p of productos){ if(!porRubro.has(p.rubro)) porRubro.set(p.rubro,[]); porRubro.get(p.rubro).push(p); }

await rm(path.join(SALIDA,'p'),{recursive:true,force:true});
await rm(path.join(SALIDA,'c'),{recursive:true,force:true});

let nFotos=0, nSinStock=0;
for(const p of productos){
  if(p.tieneFoto) nFotos++;
  if(p.sinStock) nSinStock++;
  const hermanos=(porRubro.get(p.rubro)||[]).filter(h=>h.id!==p.id).slice(0,8);
  const dir=path.join(SALIDA,'p',p.slug);
  await mkdir(dir,{recursive:true});
  await writeFile(path.join(dir,'index.html'), paginaProducto(p,hermanos,p.tieneFoto));
}
for(const [rubro,prods] of porRubro){
  const dir=path.join(SALIDA,'c',prods[0].rubroSlug);
  await mkdir(dir,{recursive:true});
  await writeFile(path.join(dir,'index.html'), paginaRubro(rubro,prods[0].rubroSlug,prods));
}

const urls = [
  BASE,
  BASE + 'catalogo.html',
  ...[...porRubro.values()].map(ps => BASE + 'c/' + ps[0].rubroSlug + '/'),
  ...productos.map(p => p.url)
];
const sitemap = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ...urls.map(u => '  <url><loc>' + esc(u) + '</loc></url>'),
  '</urlset>',
  ''
].join('\n');
await writeFile(path.join(SALIDA,'ficha-producto.css'), CSS);
await writeFile(path.join(SALIDA,'sitemap.xml'), sitemap);
await writeFile(path.join(SALIDA,'sitemap.txt'), urls.join('\n') + '\n');

console.log('Paginas generadas: '+productos.length+' productos ('+nFotos+' con foto, '+nSinStock+' sin stock) y '+porRubro.size+' rubros.');
console.log('Sitemap: '+urls.length+' direcciones.');
