# MEXA CARTOON — Guía de despliegue (Cloudflare Pages)

Este sitio (`/mex`) usa **el mismo motor que Mundo Simz**, pero con su **propia base de
datos**: sus propios `temporadas.json`, `productos.json`, sus propias imágenes en R2 y
su propio panel. El contenido del cliente de Mexa Cartoon **no se mezcla** con el de
Mundo Simz.

La carpeta `mex/` es **autónoma**: se puede subir tal cual como su propio proyecto de
Cloudflare Pages.

---

## Qué contiene

| Archivo | Rol |
|---|---|
| `index.html` | La web pública: pantalla de título "Mexa Cartoon", mundo pixel-art (con batiseñal-halcón y Quetzalcóatl), lector de cómic, tienda 🛒 y música chiptune. |
| `admin.html` | Panel privado del cliente: sube páginas, edita niveles, personajes y tienda. |
| `functions/api/[[route]].js` | La única pieza de servidor (función edge). El token de GitHub nunca sale de aquí. |
| `assets/` | Recortes de los héroes (cutout-*). |
| `temporadas.json` / `productos.json` | Los genera el panel. Al principio no existen; el sitio funciona igual. |
| `t1-*.jpg`, `t2-*.jpg` | Cómic de ejemplo (demo). El cliente puede borrarlo desde el panel y subir el suyo. |

---

## Cómo funciona (resumen)

```
Navegador (admin.html) ──contraseña──► Cloudflare Pages Function ──► R2 (imágenes)
                                        (valida la clave)         └─► GitHub API (JSON) ──► commit
```

- Las **páginas nuevas** (`t3-0001.webp`, 4 dígitos) van a **R2**: online al instante, sin rebuild.
- Los **JSON de estado** (`temporadas.json`, `productos.json`, `personajes.json`) van a **GitHub**: historial y rollback gratis.
- El **progreso del jugador** vive en su navegador (`localStorage`). No hay cuentas.

---

## Pasos para publicarlo

### 1. Subir la carpeta a su propio repositorio de GitHub
Crea un repo nuevo (p.ej. `mexa-cartoon`) y sube **el contenido de la carpeta `mex/`** en
la raíz del repo (que `index.html`, `admin.html` y `functions/` queden en la raíz).

### 2. Crear el proyecto en Cloudflare Pages
Cloudflare → **Workers & Pages → Create → Pages → Connect to Git** → elige el repo.
- **Framework preset:** None
- **Build command:** *(vacío)*
- **Build output directory:** `/`

### 3. Crear un token fine-grained de GitHub
GitHub → Settings → Developer settings → **Fine-grained tokens** → Generate new token.
- **Repository access:** Only select repositories → **solo** el repo `mexa-cartoon`.
- **Permissions → Repository → Contents:** **Read and write**.
- Copia el token (empieza por `github_pat_…`).

### 4. Crear el bucket R2 (para las fotos que suba el cliente)
Cloudflare → **R2 → Create bucket** (p.ej. `mexa-cartoon-img`).
- En el bucket → **Settings → Public access** → habilita el dominio público (o conecta un
  subdominio, p.ej. `img.mexacartoon.com`). Copia esa URL pública.

### 5. Variables de entorno (Cloudflare → tu proyecto → Settings → Environment variables → Production)

| Variable | Tipo | Valor |
|---|---|---|
| `ADMIN_PASSWORD` | Secret | la contraseña del panel |
| `GITHUB_TOKEN` | Secret | el token del paso 3 |
| `GITHUB_REPO` | Texto | `tu-usuario/mexa-cartoon` |
| `GITHUB_BRANCH` | Texto | `main` |
| `R2_PUBLIC_URL` | Texto | la URL pública del bucket (paso 4) |

### 6. Binding de R2 (Settings → Functions → R2 bucket bindings)
- **Variable name:** `IMAGES`  →  **Bucket:** el del paso 4.

### 7. Redesplegar
Deployments → **Retry deployment** (para que tome las variables). Listo.

---

## Uso diario del cliente

1. Entra a `tudominio.com/admin.html` y escribe la contraseña.
2. **Niveles:** renombra cada nivel (barrio/temporada), bloquéalo o déjalo libre.
3. **Páginas del cómic:** elige el nivel, suelta las imágenes → se comprimen y publican solas.
4. **Tienda:** rellena los 10 productos (nombre, precio, etiqueta, foto) y publica.
5. Cada cambio queda versionado. Las páginas nuevas se ven al instante (R2); los JSON, en ~1 min.

**Modo vista previa:** si abres `admin.html` con doble clic (sin servidor), nada se
publica: puedes probarlo todo en local antes de dárselo al cliente.

---

## Coste

Igual que Mundo Simz: **0 €/mes** (Cloudflare Pages + Functions + R2 en plan gratuito,
GitHub gratis). El único gasto opcional es el dominio.

## Límites honestos (dilo antes de venderlo)

- La tienda es un **catálogo**: muestra productos, no cobra. Para cobrar de verdad hace
  falta enlazar Stripe/Shopify aparte.
- Un solo usuario admin, una sola contraseña.
- Los JSON tardan ~30-60 s en propagarse; las fotos (R2) son instantáneas.
