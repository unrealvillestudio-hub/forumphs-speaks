# ⛔ fphs-chat YA NO VIVE AQUÍ

**Ubicación vigente:** [`unrealvillestudio-hub/unrlvl-iid-functions` → `supabase/functions/fphs-chat/`](https://github.com/unrealvillestudio-hub/unrlvl-iid-functions/tree/main/supabase/functions/fphs-chat).
Allí están `index.ts`, la prueba `tests/fphs_chat_ley_vigente_test.mjs` y `SNAPSHOT.md`, con su
procedencia.

## Por qué se movió

- **Las Edge Functions del ecosistema se versionan y se despliegan desde `unrlvl-iid-functions`**
  (Sam, 2026-09-30).
- **Esta carpeta era la única copia de `fphs-chat` en git**, y producción se había desplegado desde
  aquí. Con dos repos posibles, las dos copias habrían acabado divergiendo.
- **La función entró allí en `unrlvl-iid-functions#275`:** primero tal como estaba desplegada
  (build `_44`) y después con sus cambios. Hoy corre el build `_64`, desplegado desde ese repo el
  2026-09-30.

## Qué hacer

- **No se despliega desde este repo.** Aquí ya no hay `index.ts` a propósito: un
  `supabase functions deploy fphs-chat` lanzado desde esta carpeta falla en vez de publicar código
  viejo.
- **Para desplegar**, desde una copia local de `unrlvl-iid-functions` al día:
  - `git checkout main && git pull origin main`
  - `supabase functions deploy fphs-chat --no-verify-jwt --project-ref amlvyycfepwhiindxgzw`
- **`--no-verify-jwt` es obligatorio.** La página pública llama al agente sin JWT de usuario; con la
  verificación activa, el chat deja de responder.
- **La historia de la copia anterior** sigue en git: `git log -- supabase/functions/fphs-chat/index.ts`.
