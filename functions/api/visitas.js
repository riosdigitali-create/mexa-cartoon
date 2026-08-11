/**
 * MEXA CARTOON — contador de público (Cloudflare Pages Function, edge)
 * ------------------------------------------------------------------
 * Devuelve el TOTAL ACUMULADO de gente que ha entrado al sitio, y lo sube
 * cuando el visitante es nuevo del día. El número solo crece: no se reinicia
 * ni depende de ningún servicio de terceros.
 *
 * Por qué vive aquí y no en el navegador: un contador que el cliente puede
 * tocar no vale nada — recargas, pestañas y F5 lo inflan, y cualquiera puede
 * falsearlo desde la consola. Aquí el conteo lo decide el servidor.
 *
 * Ruta:  GET /api/visitas   →  { ok:true, value:<total> }
 *
 * Este archivo gana sobre [[route]].js porque Pages resuelve primero las rutas
 * exactas; por eso /api/visitas es pública y no pasa por la contraseña del panel.
 *
 * Binding (Cloudflare → tu proyecto de Pages → Settings → Bindings → Add → D1):
 *   STATS          → base D1 (por ejemplo `mexa-cartoon-stats`)
 *
 * Variable opcional (Settings → Variables and Secrets):
 *   VISITAS_BASE   arranque del contador. Sirve para no empezar de cero y
 *                  respetar el público que la página ya traía. Por defecto 349.
 *                  Solo se usa la PRIMERA vez: después el total manda.
 *
 * Qué cuenta como una visita: un visitante por día. Dos personas distintas
 * cuentan dos; la misma persona recargando veinte veces cuenta una. Los bots
 * declarados no cuentan. La huella es un hash de IP + navegador + día: no se
 * guarda la IP en claro y al día siguiente ya no sirve para identificar a nadie.
 */

const BASE_POR_DEFECTO = 349;

/* Sal fija: evita que la huella sea un hash "pelado" de la IP, que cualquiera
   con la lista de IPs podría recalcular. No es un secreto crítico. */
const SAL = 'mexa-cartoon-visitas-v1';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',      // el contador nunca se sirve de caché
      'access-control-allow-origin': '*'
    }
  });

/** Bots declarados: rastreadores, previsualizadores de enlaces y monitores.
    No se les cuenta, pero SÍ se les responde el total: así una vista previa de
    WhatsApp o Facebook no infla el número ni se rompe. */
const ES_BOT = /bot|crawl|spider|slurp|facebookexternalhit|whatsapp|telegram|discord|preview|monitor|pingdom|lighthouse|headless|curl|wget|python-requests|axios|postman/i;

const hoyUTC = () => new Date().toISOString().slice(0, 10);   // 2026-08-11

/** Huella corta y estable del visitante para el día en curso. */
async function huella(request) {
  const ip = request.headers.get('cf-connecting-ip') || '0.0.0.0';
  const ua = request.headers.get('user-agent') || '';
  const datos = new TextEncoder().encode(SAL + '|' + ip + '|' + ua + '|' + hoyUTC());
  const hash = await crypto.subtle.digest('SHA-256', datos);
  return [...new Uint8Array(hash)].slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function crearTablas(db) {
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS visitas (clave TEXT PRIMARY KEY, total INTEGER NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS visitantes (huella TEXT PRIMARY KEY, dia TEXT NOT NULL)'),
    db.prepare('CREATE INDEX IF NOT EXISTS visitantes_dia ON visitantes (dia)')
  ]);
}

async function totalActual(db) {
  const fila = await db.prepare('SELECT total FROM visitas WHERE clave = ?').bind('total').first();
  return fila ? Number(fila.total) : null;
}

/** Suma 1 si el visitante es nuevo hoy y devuelve el total resultante. */
async function contar(db, base, request, contable) {
  // arranque: solo entra si la fila no existe todavía
  await db.prepare('INSERT OR IGNORE INTO visitas (clave, total) VALUES (?, ?)').bind('total', base).run();

  if (!contable) return { total: await totalActual(db), nuevo: false };

  const h = await huella(request);
  const dia = hoyUTC();

  /* INSERT OR IGNORE sobre la clave primaria: si la huella ya estaba, changes
     es 0 y no se suma nada. Así la recarga no cuenta, y sin necesidad de leer
     antes y escribir después (que con dos visitas a la vez perdería una). */
  const ins = await db.prepare('INSERT OR IGNORE INTO visitantes (huella, dia) VALUES (?, ?)').bind(h, dia).run();
  const nuevo = !!(ins.meta && ins.meta.changes);

  if (nuevo) {
    await db.prepare('UPDATE visitas SET total = total + 1 WHERE clave = ?').bind('total').run();
  }
  return { total: await totalActual(db), nuevo };
}

export async function onRequestGet(context) {
  const { request, env, waitUntil } = context;
  const db = env.STATS || null;
  const base = Number(env.VISITAS_BASE) > 0 ? Math.floor(Number(env.VISITAS_BASE)) : BASE_POR_DEFECTO;

  // Sin binding no se inventa nada: el front tiene su propio respaldo y sigue.
  if (!db) return json({ ok: false, error: 'Falta el binding D1 STATS en Cloudflare' }, 503);

  const ua = request.headers.get('user-agent') || '';
  const contable = !ES_BOT.test(ua) && ua.length > 0;

  try {
    let r;
    try {
      r = await contar(db, base, request, contable);
    } catch (e) {
      // primera vez: la base está vacía y aún no hay tablas
      if (!/no such table|no such column/i.test(e.message || '')) throw e;
      await crearTablas(db);
      r = await contar(db, base, request, contable);
    }

    /* Limpieza perezosa: las huellas de días pasados ya no sirven para nada.
       Se hace de vez en cuando y sin bloquear la respuesta. */
    if (Math.random() < 0.02) {
      const tarea = db.prepare('DELETE FROM visitantes WHERE dia < ?').bind(hoyUTC()).run();
      if (waitUntil) waitUntil(tarea); else await tarea;
    }

    return json({ ok: true, value: r.total, nuevo: r.nuevo });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

/* Solo GET (y el OPTIONS de cortesía). Cualquier otro método lo rechaza Pages
   solo, al no encontrar handler: no se exporta `onRequest` a propósito, para
   que no compita con `onRequestGet`. */
export const onRequestOptions = () => new Response(null, { status: 204 });
