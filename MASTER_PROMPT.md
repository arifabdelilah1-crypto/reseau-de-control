# MASTER PROMPT — Redesign du dashboard « Réseau DE · Control »

> Colle ce fichier en entier au début de la conversation, puis joins le zip du projet (ou au minimum `index.html`).
> Tout ce qu'il faut pour redessiner sans rien casser est ici : le contexte, ce qui existe, le contrat de données et les règles.

---

## 0. Ta mission

Tu es un designer produit senior doublé d'un développeur front-end. Tu **redessines entièrement l'interface** de `index.html`, un dashboard de monitoring déjà **fonctionnel et en production**.

- **Objectif :** une interface plus belle, plus claire, plus rapide à lire, avec une identité visuelle propre et qui ne ressemble pas à un template SaaS ou « IA » générique. Elle doit rester utilisable sur téléphone.
- **Tu ne touches pas au backend.** Supabase (tables, fonctions SQL, edge functions, cron) est déjà déployé et marche. Le nouveau front doit consommer **exactement** le même contrat de données (section 4).
- **Livrable :** un seul fichier `index.html` autonome (HTML + CSS + JS inline), déployé tel quel sur GitHub Pages, sans étape de build. Bibliothèques autorisées uniquement via CDN avec une version figée (déjà utilisées : `@supabase/supabase-js@2`, `Chart.js 4.4.1`). Tu peux en remplacer ou en ajouter si ça apporte vraiment quelque chose, sans casser le chargement statique.
- Livre le fichier **complet**, pas des morceaux. Si c'est trop long, livre-le en parties numérotées, à concaténer dans l'ordre.

---

## 1. Contexte métier

Le propriétaire, Arif, gère un réseau de **13 blogs de recettes en allemand** (WordPress) entièrement automatisé :

```
Google Sheet (Master = 1 ligne par article, Pins = 1 ligne par pin, Sites)
   → n8n self-hosted : WF1 articles (DeepSeek) → WF2a images (GPU RunPod) → WF2b upload WordPress
                       → WF3a pins Pinterest (DeepSeek + renderer) → WF3b publication via Blotato
   → Apps Script (API.gs + Dashboard.gs) : API web au-dessus du Sheet
```

Le dashboard sert à **surveiller et piloter** tout le système depuis un seul endroit :
1. **Le trafic** : Google Search Console + Google Analytics 4 de tous les sites (comme gscdump.com), avec l'historique stocké dans Supabase.
2. **L'automatisation** : santé des workflows n8n, exécutions, échecs, services (pod GPU, renderer…), alertes Telegram.
3. **Le pipeline de contenu** : articles → images → pins, coûts, planificateur de pins Pinterest.

Langue de l'interface : **français**. Fuseau d'affichage : Africa/Casablanca. Monnaie : MAD. Les sites, mots-clés et pages sont en allemand.

Le dashboard servira aussi de **vitrine / case study** pour un futur SaaS (Pinlift). Il doit donc être assez soigné pour être montré en capture d'écran.

---

## 2. Architecture (ne pas modifier)

```
GitHub Pages ─ index.html (ce que tu redessines)
   │  supabase-js (clé publishable, faite pour le navigateur)
   ▼
Supabase  https://kuhxuovjlukxdzjnsyzt.supabase.co   (Frankfurt, free plan)
   ├─ Auth : email + mot de passe, ou lien magique ; seuls les emails de allowed_users voient les données (RLS)
   ├─ Tables + fonctions SQL (RPC) en lecture seule pour le front
   ├─ Edge functions :
   │    google-auth  OAuth Google → découverte auto des sites GSC + propriétés GA4
   │    seo-sync     file d'import GSC/GA4 (historique 16 mois + quotidien)
   │    ops-sync     API n8n toutes les 5 min, health checks, alertes, Telegram
   │    pipeline     pont vers Apps Script (état du Sheet toutes les 15 min + actions)
   └─ pg_cron : ops 5 min · worker SEO 2 min · SEO quotidien 05:17 UTC · pipeline 15 min
```

Constantes du front (à garder telles quelles) :
```js
const SUPABASE_URL = "https://kuhxuovjlukxdzjnsyzt.supabase.co";
const SUPABASE_KEY = "sb_publishable_ONExiZZVqMmaEPkJfXGEPw_J1ohmmpV";
```

---

## 3. Écrans actuels (tout doit rester disponible)

Les noms d'onglets sont modifiables, la navigation peut être repensée (sidebar, command palette…), mais **aucune fonction ne doit disparaître**.

### 3.1 Login
- Email + mot de passe (`signInWithPassword`). Si le mot de passe est vide → lien magique (`signInWithOtp`, limité à environ 2 emails/heure par Supabase ; afficher un message clair en cas de rate limit).
- Après connexion, appeler `rpc("is_allowed")`. Si `false`, afficher « email non autorisé ».
- Retour d'OAuth Google : le hash d'URL contient `#google=connected&email=…&gsc=N&ga4=N`, ou `google=error|partial&reason=…`. Afficher un toast, puis nettoyer le hash.

### 3.2 Vue d'ensemble
- Période : 7 j / 28 j / 3 mois.
- Alertes ouvertes (3 max, lien « tout voir »).
- KPI avec delta vs la période précédente : clics Google, impressions, position moyenne (plus bas = mieux, delta inversé), sessions GA4, sessions Pinterest, workflows en échec / surveillés.
- Graphiques : clics Google par jour ; sessions GA4 (toutes sources + Pinterest) ; exécutions n8n succès/échecs sur 14 jours.
- Tableau des sites suivis : clics + delta, impressions, position, sessions + delta, sessions Pinterest, sparkline des clics, état de la synchro. Un clic sur une ligne ouvre le SEO de ce site.

### 3.3 SEO (façon gscdump)
- Sélecteur de site (ou « tous les sites suivis ») et périodes : 7 j / 28 j / 3 m / 6 m / 12 m / 16 m.
- KPI : clics, impressions, CTR, position, sessions GA4, sessions Pinterest (avec deltas).
- Graphiques : clics, impressions, position (axe inversé), sessions GA4 vs Pinterest.
- Tables : top requêtes et top pages (filtrables, barre de proportion sur les clics) ; gagnants/perdants (seulement si la période ≤ 45 j) ; pays ; appareils ; sources GA4 (Pinterest mis en évidence) ; pages GA4 les plus vues.
- Afficher si les données sont « jour par jour » ou « agrégées par mois » (champ `granularity`).

### 3.4 Ops n8n
- Bouton « Synchroniser maintenant ».
- Bandeau si n8n n'est pas configuré.
- KPI : workflows surveillés, en échec (avec noms), exécutions 24 h et taux de réussite, en cours, services OK / total.
- Alertes ouvertes et récemment résolues, avec un bouton « Résoudre ».
- Tableau des workflows : état (OK / échec / en cours / inactif), nom + tags, dernière exécution, dernier succès, échecs 24 h et 7 j, durée moyenne, interrupteur **Surveiller**, champ **Attendu (min)**.
- Santé des services : liste + formulaire d'ajout (nom, URL, code HTTP attendu) + suppression.
- 25 dernières exécutions.

### 3.5 Pipeline (Google Sheet)
Sous-onglets :
- **Synthèse** : KPI (publiés, échecs, images, pins en ligne, couverture Pinterest, coût total / par article / du mois), 3 courbes sur 30 j, tableau par site.
- **Articles** : sélecteur de sites (chips) + semaines ; actions WF1 / relancer les échecs / diagnostic ; statuts ; par semaine ; par site.
- **Images** : URL du pod GPU (enregistrer, tester, avec résultats) ; WF2a / WF2b / relancer les échecs ; statuts ; par site.
- **Pinterest** : KPI (en ligne, programmés, planifiés, en attente, erreurs, doublons) ; WF3a ; **calendrier heatmap des 14 prochains jours par site** (un jour vide est un signal d'alerte) ; tableau par compte.
- **Planificateur** : formulaire (sites, premier jour, nb de jours, pins/jour/compte, plage horaire, écart min, éviter le même article N jours, fuseau) → **Aperçu** → **Appliquer cet aperçu** (même seed) ; déplanifier ; envoi automatique (statut / activer / couper) ; envoyer les pins dus maintenant ; tableau du plan par site et par jour.
- **Coûts** : KPI, barres empilées par jour (articles / images / pins), tableau par site, formulaire des coûts unitaires.
- **Échecs** : listes articles / images / pins / doublons + « Tout remettre en pending ».

Toute action qui écrit ou lance un workflow passe par une **confirmation**.

### 3.6 Connexions
- Bouton « Connecter un compte Google ».
- Comptes Google : état, nombre de sites GSC et de propriétés GA4, re-scanner, déconnecter.
- Sites détectés : interrupteur **Suivre**, menus de liaison GSC / GA4, progression de l'import, dernière synchro ; boutons « Tout suivre », « Importer l'historique (16 mois) », « Traiter la file maintenant ».
- Intégrations : Google, URI de redirection (copiable), n8n, Telegram (+ bouton Tester).
- Réglages (table `settings`) : URL dashboard v3, URL web app Apps Script, rétention, top N, mois d'historique, seuils d'alertes.
- Mon mot de passe (`auth.updateUser({ password })`).

---

## 4. CONTRAT DE DONNÉES (à respecter à la lettre)

Client : `const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: true, detectSessionInUrl: true } })`.
Dates au format `YYYY-MM-DD`. « J-1 » = hier (les données GSC ont 2-3 jours de retard).

### 4.1 Fonctions SQL — `sb.rpc(nom, args)`
`p_site = null` → agrégat de tous les sites suivis (`tracked = true`).

| RPC | Arguments | Retourne (une ligne par…) |
|---|---|---|
| `is_allowed` | — | `boolean` |
| `site_overview` | `p_days` | site : `site_id, domain, label, tracked, has_gsc, has_ga4, clicks, clicks_prev, impressions, impressions_prev, avg_position, sessions, sessions_prev, pinterest_sessions, pinterest_sessions_prev, spark (jsonb [clics/jour]), last_sync_at, last_sync_error` |
| `site_series` | `p_site, p_from, p_to` | jour : `date, clicks, impressions, avg_position, sessions, users, pinterest_sessions` |
| `top_queries` | `p_site, p_from, p_to, p_limit` | `query, clicks, impressions, ctr (0-1), avg_position, granularity ('daily'|'monthly')` |
| `top_pages` | idem | `page (URL complète), clicks, impressions, ctr, avg_position, granularity` |
| `query_movers` | `p_site, p_days, p_limit` | `query, clicks_now, clicks_prev, delta` (gagnants puis perdants) |
| `gsc_dims` | `p_site, p_from, p_to, p_dim ('country'|'device'), p_limit` | `value (code pays ISO-3 minuscule ou MOBILE/DESKTOP/TABLET), clicks, impressions, avg_position` |
| `ga4_sources` | `p_site, p_from, p_to, p_limit` | `source, medium, sessions, users` |
| `ga4_pages` | `p_site, p_from, p_to, p_limit` | `page (chemin), views, sessions` |
| `workflow_health` | — | workflow : `id, name, active, watch, expected_every_min, tags (jsonb []), last_started, last_status, last_success, runs_24h, errors_24h, runs_7d, errors_7d, avg_duration_s, running_now, running_since` |
| `n8n_daily` | `p_days` | jour : `date, success, failed` |
| `sync_progress` | — | site : `site_id, queued, running, done, failed, last_error` |

### 4.2 Tables lues ou écrites directement — `sb.from(...)`
| Table | Lecture | Écriture autorisée |
|---|---|---|
| `alerts` | `id, kind, severity ('crit'|'warn'|'info'), title, created_at, last_seen_at, resolved_at` (ouvertes = `resolved_at is null`) | `update {resolved_at}` |
| `google_accounts` | `id, email, status ('active'|'error'), last_error, connected_at, last_discovery_at` | — |
| `gsc_sites` | `id, account_id, site_url, permission_level, domain` | — |
| `ga4_properties` | `id, account_id, property_id, display_name, account_name, default_uri, domain` | — |
| `sites` | `id, domain, label, gsc_site_id, ga4_property_id, tracked, last_sync_at, last_sync_error` | `update {tracked}`, `{gsc_site_id}`, `{ga4_property_id}` |
| `n8n_workflows` | (via `workflow_health`) | `update {watch}`, `{expected_every_min}` |
| `n8n_executions` | `id, workflow_id, status, mode, started_at, stopped_at, synced_at` | — |
| `health_checks` | `id, name, url, expect_status, enabled, last_status, last_ok, last_ms, last_checked_at, last_error` | insert / delete |
| `settings` | `key, value (jsonb)` | upsert |
| `pipeline_state` | ligne `id = 1` : `data (jsonb, voir 4.4), ok, error, ms, taken_at` | — |

### 4.3 Edge functions — `sb.functions.invoke(nom, { body })`
En cas d'erreur, le message est dans `await error.context.json()` → `.error`.

| Fonction | `body` | Réponse |
|---|---|---|
| `google-auth` | `{action:"start", return_to: location.origin + location.pathname}` | `{url}` → `location.href = url` |
| `google-auth` | `{action:"discover", account_id}` | `{results:{[id]:{gsc, ga4, sites} | {error}}}` |
| `google-auth` | `{action:"disconnect", account_id}` | `{ok}` |
| `seo-sync` | `{action:"backfill"}` | `{sites, queued}` |
| `seo-sync` | `{action:"work"}` (jusqu'à environ 2 min) | `{done, failed, errors[]}` |
| `ops-sync` | `{action:"status"}` | `{google, google_redirect_uri, n8n, n8n_url, telegram}` |
| `ops-sync` | `{action:"run"}` | `{n8n:{workflows, executions} | n8n_error, health:{checked, down}, alerts:{open}}` |
| `ops-sync` | `{action:"test_alert"}` | `{ok}` |
| `pipeline` | `{action:"refresh"}` (10-60 s) | `{ok, ms}` ou `{ok:false, error}` |
| `pipeline` | `{action:"call", gas:"<action>", params:{…}}` | réponse brute d'Apps Script (voir 4.5) |

### 4.4 Forme de `pipeline_state.data` (sortie de `dbAggregate_` dans Dashboard.gs)
```js
{ today, tz, costs:{article, image, pin},
  days:[30 × 'YYYY-MM-DD'], nextDays:[14 × 'YYYY-MM-DD'],
  articles:{ total, byStatus:{status:n}, generated, published, failed,
    bySite:[{site, total, pending, published, scheduled, drafted, failed, generated, cost}],
    byWeek:[{week, total, published, generated, failed}], daily:[30 nombres],
    failedList:[{id, site, kw, status, error}] },
  images:{ byStatus, articlesDone, images, withImages, avg,
    bySite:[{site, textDone, pending, generating, generated, uploading, done, failed, images, cost}],
    daily:[30], dailyImgs:[30], failedList:[{id, site, kw, status, error}] },
  pins:{ total, byStatus:{done, planned, scheduled, posted, skip, error},
    bySite:[{site, account, done, planned, scheduled, posted, skip, error, total, cost, next7, nArticles, pubArticles, noPins, covered}],
    daily:[30], cal:{[site]:{[day]:n}}, dupes:[{site, account, day, article}], dupCount,
    errors:[{pin, id, site, status, error}], covered, noPins, published, hasPlanCol },
  articleList:[{id, site, kw, url, st, im, imgs, d, pl, sc, po, sk, er, next}],
  cost:{ articles, images, pins, total, month, perPublished,
    daily:[{d, a, i, p}], bySite:[{site, a, i, p, t, published}] },
  accounts:{[site]:accountId}, pod:{url, updated_at} }
```
Le site `"—"` correspond aux lignes sans site : il faut le masquer.

### 4.5 Actions Apps Script autorisées (`pipeline` → `call`)
Les tableaux (`sites`, `weeks`) peuvent être envoyés comme tableaux JS : la fonction les sérialise.

| `gas` | `params` | Réponse utile |
|---|---|---|
| `wf1_run` / `wf1_retry_failed` | `{sites:[], weeks:[]}` | `{ok, code, body}` ou `{ok, message}` |
| `wf1_diagnostic` | — | `{failed, processing, error_groups:[{error, count, examples}], recommendation}` |
| `wf2_run` / `wf2b_run` / `wf2_retry_failed` / `wf3_run` | `{sites:[]}` | `{ok, code}` |
| `reset_failed` | — | `{ok, reset:{text, img}}` |
| `save_pod` | `{pod_url}` | `{ok, pod_url}` |
| `test_pod` | — | `{ok, pod_url, tests:[{path, code, ms, body}]}` |
| `set_costs` | `{article, image, pin}` | `{ok, costs}` |
| `plan_pins` | `{sites, start, days, per_day, h_start, h_end, min_gap, avoid_days, tz, dry:"1"|"0", seed?}` | `{ok, total, written?, days, plan:[…], perSite:[{site, account, planned, waiting, days:{}, exist:{}}], shortage:[{site, day, missing}], skipped:{noAccount, noBoard, noImage}, options:{seed}}` |
| `unplan_pins` | `{sites}` | `{ok, cleared}` |
| `send_planned` | — | `{ok, sent, expired, message}` |
| `auto_on` / `auto_off` / `auto_status` | — | `{ok, on, last:{at, sent, expired, ok}}` |

Pour **Appliquer** un aperçu, renvoyer exactement les mêmes options avec `seed = options.seed` de l'aperçu et `dry:"0"`.

---

## 5. Règles de design et de qualité

**Identité**
- Interface d'un **outil d'opérateur** : dense, nette, rassurante. Pense salle de contrôle ou terminal d'éditeur, pas landing page.
- Évite le look « IA générique » : pas de dégradés violets, pas de glassmorphism, pas de grosses cartes arrondies vides, pas d'emojis décoratifs. Arif a déjà refusé ce style pour Pinlift.
- La v4 actuelle utilise Archivo (titres, largeur variable) + IBM Plex Mono (chiffres), un fond papier chaud et un accent jaune signal. Tu peux la garder, l'affiner ou proposer mieux, mais choisis une direction et tiens-la partout.
- **Clair et sombre obligatoires.** Tokens sur `:root`, sombre via `@media (prefers-color-scheme: dark)` avec la garde `:root:not([data-theme="light"])` + `:root[data-theme="dark"]`, et un bouton de bascule (choix gardé dans localStorage, avec try/catch).

**Données**
- Chiffres en police tabulaire. Formats : `fr-FR`, compacts au-delà de 10 000 (1,2 k), position avec 1 décimale, CTR en %, MAD sans décimale (sauf coûts unitaires).
- Deltas : ▲ vert si c'est mieux, ▼ rouge si c'est pire. **La position est inversée** : une baisse est une amélioration.
- Couleurs de séries dans un ordre fixe (1 = bleu toutes sources, 2 = orange Pinterest, 3 = aqua). Jamais la couleur seule : légende ou libellé direct.
- Couleurs d'état réservées (vert ok, ambre warn, rouge crit) et toujours accompagnées d'un texte ou d'une icône.
- **Un seul axe Y par graphique** (jamais de double axe). Survol : crosshair + tooltip sur les courbes.
- Chaque bloc a un **état vide utile** (ce qu'il faut faire pour le remplir), un **état de chargement** (skeleton) et un **état d'erreur**.

**Comportement**
- Navigation par hash (`#view=seo`), qui survit au rechargement.
- Rafraîchissement auto de l'onglet visible toutes les 5 min (pas quand l'onglet du navigateur est caché).
- Toasts pour les retours d'action ; confirmation pour toute action qui écrit ou lance un workflow ; bouton désactivé avec « … » pendant l'appel.
- Mobile : marges de 16 px, aucun scroll horizontal de page (les tableaux scrollent dans leur conteneur), navigation utilisable au pouce.
- Accessibilité : contraste AA sur le texte, focus visible, boutons de vraie taille, `aria-selected` / `aria-pressed` sur les onglets et segments.
- Échapper tout texte venant des données (`esc()`) avant de l'injecter en HTML.

**Interdits**
- Mettre des clés secrètes dans le front. Seule la clé `sb_publishable_…` y va.
- Appeler Apps Script, n8n, Google ou Telegram directement depuis le navigateur. Tout passe par les edge functions.
- Changer les noms des RPC, tables, colonnes ou actions.

---

## 6. Idées d'amélioration bienvenues (optionnel, si le contrat reste intact)
- Command palette (Ctrl+K) pour sauter à un site, un onglet ou une action.
- Page « santé globale » en un coup d'œil : feux tricolores SEO / n8n / pipeline / services.
- Tables triables par colonne et export CSV des tables SEO.
- Comparaison de deux sites côte à côte.
- Marqueurs sur les courbes SEO quand un workflow a publié beaucoup d'articles (données `articles.daily`).

---

## 7. Déroulé attendu
1. Lis tout le `index.html` actuel pour comprendre chaque appel et chaque état.
2. Propose en quelques lignes ta direction visuelle (typo, couleurs, structure de navigation), puis attends la validation.
3. Livre le nouveau `index.html` complet.
4. Liste ce qui a changé et confirme, appel par appel, que le contrat de la section 4 est respecté.
