# Mis Cartas Pokémon

Aplicación web para buscar, escanear y organizar una colección de cartas Pokémon TCG. Muestra precios orientativos de Cardmarket, separa copias por idioma y variante y ofrece un catálogo navegable por sets.

Producción: https://carlos-pokemon-tcg.surge.sh

## Stack

- HTML, CSS y JavaScript sin framework
- [TCGdex](https://tcgdex.dev/) para catálogo, metadatos, imágenes base y precios
- Supabase para autenticación, colección sincronizada y funciones Edge
- Surge.sh para el hosting estático

## Estructura

- `index.html`, `styles.css`, `app.js`: aplicación
- `aliases.js`, `sets-data.js`: datos estáticos para resolver sets e idiomas
- `icon.svg`, `manifest.webmanifest`, `sw.js`: recursos PWA
- `supabase/functions/card-image`: función Edge que sirve imágenes de productos Cardmarket con caché y fallback seguro

## Desarrollo local

```bash
python3 -m http.server 8080
```

Abre `http://localhost:8080`.

`SB_PUB` es una clave publicable de Supabase, diseñada para estar en el navegador. Las credenciales privadas de Surge, Supabase y GitHub no forman parte del repositorio.

## Despliegue estático

Antes de desplegar, cambia el parámetro de versión de `app.js?v=...` en `index.html` para invalidar la caché.

```bash
npx surge . carlos-pokemon-tcg.surge.sh
```

El despliegue requiere credenciales de Surge configuradas fuera del repositorio.

## Supabase Edge Function

```bash
supabase functions deploy card-image --project-ref mazlbhjdmrwwttinuwjk --no-verify-jwt
```

No guardes tokens, contraseñas ni claves privadas en Git.
