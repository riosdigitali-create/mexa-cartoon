/**
 * MUNDO SIMZ — API serverless (Cloudflare Pages Functions, edge)
 * ---------------------------------------------------------------
 * El token de GitHub NUNCA sale del servidor: vive como variable de
 * entorno cifrada en Cloudflare. El navegador solo envía la contraseña
 * del panel; esta función valida y escribe en R2 o en el repositorio.
 *
 * ARQUITECTURA DE ALMACENAMIENTO — POR QUÉ HAY DOS SITIOS
 * -------------------------------------------------------
 * Las imágenes NUEVAS van a R2, no a Git. Motivo: Git guarda todas las
 * versiones para siempre (borrar una foto no libera nada), Cloudflare Pages
 * solo admite 20.000 archivos por despliegue en el plan gratuito, y cada
 * subida disparaba un commit + un rebuild de 30-60 s. Con miles de páginas
 * por nivel eso no se sostiene. R2 no tiene límite de objetos, borrar libera
 * de verdad, y subir NO dispara rebuild: la foto está online al instante.
 *
 * Las imágenes VIEJAS (esquema t{n}-{nn}, 2 dígitos) siguen en el repo y se
 * sirven desde el propio sitio. No se migran ni se tocan. El front resuelve
 * la URL según el nombre, así que ambas conviven sin conflicto:
 *
 *   t1-07.jpg          → 2 dígitos → mismo origen (repo, como siempre)
 *   t1-0007.webp       → 4 dígitos → R2 (R2_PUBLIC_URL)
 *   personaje-0007.webp → 4 dígitos → R2 (postales de la galería)
 *
 * Los JSON de estado (temporadas.json, productos.json, personajes.json) SIGUEN
 * en Git: son pequeños, cambian poco y ahí ganamos historial y rollback gratis.
 *
 * Variables de entorno (Cloudflare → Settings → Environment variables):
 *   ADMIN_PASSWORD   contraseña del panel            (secreta)
 *   GITHUB_TOKEN     token fine-grained, Contents:RW (secreta)
 *   GITHUB_REPO      usuario/repositorio
 *   GITHUB_BRANCH    main            (opcional)
 *   R2_PUBLIC_URL    https://img.tu-dominio.com  (dominio público del bucket)
 *
 * Bindings (Cloudflare → Settings → Functions → R2 bucket bindings):
 *   IMAGES           → bucket R2 donde viven las páginas
 *
 * Rutas:  POST /api/login · /api/list · /api/upload · /api/delete · /api/save
 */

const GH = 'https://api.github.com';

/** Nombre nuevo (vive en R2): 4 dígitos.  t1-0007.webp */
const NUEVO = /^t\d{1,2}-\d{4}\.(jpe?g|png|webp|gif)$/i;
/** Nombre antiguo (vive en el repo): 2-3 dígitos. t1-07.jpg */
const LEGADO = /^t\d{1,2}-\d{2,3}\.(jpe?g|png|webp|gif)$/i;
/** Foto de producto */
const PRODUCTO = /^producto-\d+\.(jpe?g|png|webp|gif)$/i;
/** Postal de personaje (vive en R2): personaje-0007.webp
    Son pocas, pero van a R2 por lo mismo que las páginas: subir no dispara
    rebuild y borrar libera de verdad. Sigue la misma regla de 4 dígitos. */
const PERSONAJE = /^personaje-\d{4}\.(jpe?g|png|webp|gif)$/i;

/** ¿Este archivo vive en R2? El nombre es lo único que lo decide, y esta
    función es la ÚNICA fuente de esa verdad: subir, borrar y listar la usan
    todos, así que nunca pueden acabar mirando a almacenes distintos. */
const enR2 = p => NUEVO.test(p) || PERSONAJE.test(p);

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });

/** comparación en tiempo constante (evita filtrar la clave por tiempos de respuesta) */
function safeEqual(a = '', b = '') {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function ghHeaders(env) {
  return {
    Authorization: 'Bearer ' + env.GITHUB_TOKEN,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'mundo-simz-cms',
    'content-type': 'application/json'
  };
}

async function gh(env, path, init = {}) {
  const r = await fetch(GH + path, { ...init, headers: ghHeaders(env) });
  const txt = await r.text();
  let body = {};
  try { body = txt ? JSON.parse(txt) : {}; } catch (e) { body = { message: txt }; }
  if (!r.ok) throw new Error(body.message || 'GitHub HTTP ' + r.status);
  return body;
}

const repo = env => env.GITHUB_REPO;
const branch = env => env.GITHUB_BRANCH || 'main';

/** sha actual de un archivo del repo (null si no existe) */
async function shaOf(env, path) {
  try {
    const r = await gh(env, `/repos/${repo(env)}/contents/${encodeURIComponent(path)}?ref=${branch(env)}`);
    return r.sha || null;
  } catch (e) { return null; }
}

/** base64 → Uint8Array */
function b64ToBytes(b64) {
  const limpio = String(b64).replace(/^data:[^,]+,/, '').replace(/\s/g, '');
  const bin = atob(limpio);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const mimeDe = path => ({
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  webp: 'image/webp', gif: 'image/gif', mp3: 'audio/mpeg', ogg: 'audio/ogg'
}[(path.split('.').pop() || '').toLowerCase()] || 'application/octet-stream');

export async function onRequest(context) {
  const { request, env, params } = context;
  const route = (Array.isArray(params.route) ? params.route.join('/') : params.route || '').toLowerCase();

  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (request.method !== 'POST') return json({ ok: false, error: 'Método no permitido' }, 405);

  if (!env.ADMIN_PASSWORD || !env.GITHUB_TOKEN || !env.GITHUB_REPO) {
    return json({ ok: false, error: 'Faltan variables de entorno en Cloudflare (ADMIN_PASSWORD, GITHUB_TOKEN, GITHUB_REPO)' }, 500);
  }

  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: 'JSON inválido' }, 400); }

  // ---- autenticación: la contraseña se valida SIEMPRE en el servidor ----
  if (!safeEqual(body.password || '', env.ADMIN_PASSWORD)) {
    return json({ ok: false, error: 'Contraseña incorrecta' }, 401);
  }

  const r2 = env.IMAGES || null;                 // puede no estar configurado todavía
  const publico = (env.R2_PUBLIC_URL || '').replace(/\/+$/, '');

  try {
    switch (route) {

      /* --- comprobar acceso --- */
      case 'login':
        return json({
          ok: true,
          repo: repo(env),
          branch: branch(env),
          // el panel necesita saber si puede usar R2 y desde qué dominio se lee
          r2: !!r2 && !!publico,
          r2Base: publico
        });

      /* --- listar archivos de UN prefijo, paginado ---
         Antes se listaba el repo entero en cada refresh. Con miles de páginas
         eso devuelve megas de JSON y la Trees API acaba marcando `truncated`,
         que aquí era un error fatal. Ahora el panel pide solo el nivel que está
         viendo (prefix: "t3-") y pagina con cursor.

         Dos fuentes, porque hay dos almacenes:
           · R2   → páginas nuevas. Paginado nativo con cursor, 1000 por vuelta.
           · Repo → páginas antiguas. Una llamada a Trees, filtrada por prefijo.
         El repo solo se consulta en la primera vuelta (sin cursor): no pagina y
         volver a pedirlo en cada página duplicaría resultados. */
      case 'list': {
        const prefix = String(body.prefix || '').replace(/[^\w.\-]/g, '');
        const cursor = body.cursor || undefined;
        let files = [];
        let siguiente = null;

        if (r2) {
          const l = await r2.list({ prefix, limit: 1000, cursor });
          files = l.objects.map(o => ({
            name: o.key,
            path: o.key,
            size: o.size,
            store: 'r2',
            sha: '',
            url: publico ? `${publico}/${encodeURIComponent(o.key)}` : o.key
          }));
          siguiente = l.truncated ? l.cursor : null;
        }

        // páginas antiguas del repo: solo en la primera vuelta
        if (!cursor) {
          const raw = `https://raw.githubusercontent.com/${repo(env)}/${branch(env)}/`;
          try {
            const t = await gh(env, `/repos/${repo(env)}/git/trees/${branch(env)}?recursive=1`);
            const legado = (Array.isArray(t.tree) ? t.tree : [])
              .filter(f => f.type === 'blob' && !f.path.includes('/') && f.path.startsWith(prefix))
              .filter(f => LEGADO.test(f.path) || PRODUCTO.test(f.path))
              .map(f => ({
                name: f.path, path: f.path, size: f.size || 0,
                store: 'git', sha: f.sha, url: raw + encodeURIComponent(f.path)
              }));
            files = legado.concat(files);
          } catch (e) {
            // el repo no responde: seguimos con lo de R2 en vez de tumbar el panel
          }
        }

        return json({ ok: true, files, cursor: siguiente, truncated: !!siguiente });
      }

      /* --- subir imagen (base64) ---
         Las páginas del cómic (esquema nuevo de 4 dígitos) van a R2: sin commit
         y sin rebuild, están online al instante. Todo lo demás —fotos de
         producto, audio— sigue en el repo: son pocas, cambian poco, y el front
         las lee como ruta relativa del propio sitio. Es la MISMA regla que usa
         `delete`, para que subir y borrar nunca miren a sitios distintos.

         Si el bucket aún no está configurado, las páginas caen al repo para no
         dejar el panel inservible durante la transición. */
      case 'upload': {
        const path = String(body.path || '').replace(/[^\w.\-]/g, '_');
        if (!path || !body.content) return json({ ok: false, error: 'Faltan datos' }, 400);

        /* Allowlist estricta, igual que en `delete`. Antes aquí solo se miraba
           la extensión, y el saneado conservaba `.` y `/`: con la contraseña
           correcta se podía sobrescribir CUALQUIER archivo del repo que
           terminara en .jpg/.png/... en cualquier ruta. Ahora solo se admiten
           los tres nombres que el proyecto usa de verdad, sin subcarpetas. */
        if (!(NUEVO.test(path) || LEGADO.test(path) || PRODUCTO.test(path) || PERSONAJE.test(path) || /^musica\.(mp3|ogg)$/i.test(path))) {
          return json({ ok: false, error: 'Nombre no permitido: ' + path }, 400);
        }

        /* Una página de 4 dígitos SOLO puede vivir en R2. Si no hay bucket, se
           rechaza en vez de commitearla al repo: el nombre es lo único que dice
           dónde vive un archivo, así que una página de 4 dígitos en Git queda
           envenenada —invisible para la web (que la busca en R2) e imposible de
           borrar (delete la manda a R2, donde no está)—. Mejor un error claro
           ahora que un archivo fantasma para siempre. */
        if (enR2(path) && !r2) {
          return json({ ok: false, error: 'Falta configurar R2 (binding IMAGES y variable R2_PUBLIC_URL). Ver GUIA-DESPLIEGUE.md, paso 4.' }, 500);
        }

        if (r2 && enR2(path)) {
          const bytes = b64ToBytes(body.content);
          await r2.put(path, bytes, {
            httpMetadata: {
              contentType: mimeDe(path),
              // inmutable: el nombre nunca se reutiliza, así que el navegador y
              // el CDN pueden cachearla para siempre sin revalidar.
              cacheControl: 'public, max-age=31536000, immutable'
            }
          });
          return json({ ok: true, path, store: 'r2', url: publico ? `${publico}/${encodeURIComponent(path)}` : path });
        }

        // repo: fotos de producto, audio, o páginas si aún no hay bucket
        const sha = await shaOf(env, path);
        const r = await gh(env, `/repos/${repo(env)}/contents/${encodeURIComponent(path)}`, {
          method: 'PUT',
          body: JSON.stringify({
            message: body.message || 'Subir ' + path,
            content: String(body.content).replace(/^data:[^,]+,/, ''),
            branch: branch(env),
            ...(sha ? { sha } : {})
          })
        });
        return json({ ok: true, path, store: 'git', commit: r.commit && r.commit.sha });
      }

      /* --- guardar JSON (tienda / niveles) --- */
      case 'save': {
        const path = String(body.path || '');
        if (!/^(productos|temporadas|personajes)\.json$/.test(path)) return json({ ok: false, error: 'Archivo no permitido' }, 400);
        const text = JSON.stringify(body.data);
        // TextEncoder + trozos: String.fromCharCode(...bytes) revienta la pila
        // con arrays grandes, y temporadas.json crece con miles de páginas.
        const bytes = new TextEncoder().encode(text);
        let bin = '';
        for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
        const content = btoa(bin);
        const sha = await shaOf(env, path);
        await gh(env, `/repos/${repo(env)}/contents/${encodeURIComponent(path)}`, {
          method: 'PUT',
          body: JSON.stringify({
            message: 'Actualizar ' + path,
            content, branch: branch(env), ...(sha ? { sha } : {})
          })
        });
        return json({ ok: true, path });
      }

      /* --- borrar archivo(s) ---
         Acepta `path` (uno) o `paths` (lote). Borrar 500 páginas de una en una
         eran 500 commits; en R2 el borrado en lote es una sola operación. */
      case 'delete': {
        const lista = Array.isArray(body.paths) ? body.paths : [body.path];
        const paths = lista.map(p => String(p || '')).filter(Boolean);
        if (!paths.length) return json({ ok: false, error: 'Faltan datos' }, 400);

        // allowlist: solo páginas o fotos de producto. Ni con la contraseña
        // correcta se puede borrar index.html, el panel ni esta función.
        const malo = paths.find(p => !(NUEVO.test(p) || LEGADO.test(p) || PRODUCTO.test(p) || PERSONAJE.test(p)));
        if (malo) return json({ ok: false, error: 'Solo se pueden borrar páginas, personajes o fotos de producto: ' + malo }, 400);

        const deR2 = paths.filter(enR2);
        const enGit = paths.filter(p => !enR2(p));

        if (deR2.length) {
          if (!r2) return json({ ok: false, error: 'El bucket R2 no está configurado' }, 500);
          await r2.delete(deR2);                  // borrado en lote, una operación
        }
        for (const p of enGit) {
          const sha = (paths.length === 1 && body.sha) ? body.sha : await shaOf(env, p);
          if (!sha) continue;                     // ya no existe: no es un error
          await gh(env, `/repos/${repo(env)}/contents/${encodeURIComponent(p)}`, {
            method: 'DELETE',
            body: JSON.stringify({ message: 'Borrar ' + p, sha, branch: branch(env) })
          });
        }
        return json({ ok: true, paths });
      }

      default:
        return json({ ok: false, error: 'Ruta desconocida' }, 404);
    }
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}
