# Réseau DE · Control (v7)

Un seul dashboard pour tout le système : **SEO (Search Console + GA4)**, **Ops n8n** (exécutions, échecs, services), **alertes Telegram**, et le **pipeline** (dashboard v3 en attendant la migration).

```
GitHub Pages (index.html)
   │  login magic link (Supabase Auth, emails autorisés seulement)
   ▼
Supabase  kuhxuovjlukxdzjnsyzt (Frankfurt)
   ├─ google-auth   connecter un Gmail → liste auto de tous ses sites GSC + propriétés GA4
   ├─ seo-sync      file d'import : historique 16 mois + mise à jour quotidienne
   ├─ ops-sync      n8n API toutes les 5 min, pings santé, alertes, Telegram
   ├─ pipeline      pont Apps Script (Sheet toutes les 15 min + actions WF)
   ├─ index-sync    indexation Google des articles publiés (URL Inspection, toutes les 10 min)
   ├─ blotato       planning réel, publiés, échecs, stats des pins + reprogrammer / annuler (15 min)
   ├─ agent         assistant du dashboard (DeepSeek) : lit les données, propose des actions
   ├─ control-mcp   connecteur Claude (MCP, lecture seule) pour claude.ai
   └─ pg_cron       ops 5 min · worker SEO 2 min · file quotidienne 05:17 UTC
```

Déjà fait côté Supabase : projet, schéma, RLS, fonctions, cron. Il reste **6 étapes manuelles** (≈ 30 min).

---

## 1. Google Cloud (client OAuth Web)

1. **APIs & Services → Credentials → ton client OAuth Web**
   - **Reset secret** (l'ancien a été collé dans le chat).
   - **Authorized redirect URIs** → ajouter exactement :
     `https://kuhxuovjlukxdzjnsyzt.supabase.co/functions/v1/google-auth`
2. Un seul client OAuth suffit pour GSC + GA4 ; l'ID et le secret doivent venir du **même** client.
3. **APIs & Services → Library** : activer **Google Search Console API**, **Google Analytics Admin API**, **Google Analytics Data API**.
4. **OAuth consent screen**
   - Scopes : `openid`, `email`, `.../auth/webmasters.readonly`, `.../auth/analytics.readonly`
   - **Publishing status → Production** (en *Testing*, les tokens expirent après 7 jours).
   - Tu verras « Google n'a pas validé cette app » → *Paramètres avancés → Continuer*. Normal : c'est ta propre app.

## 2. Secrets Supabase

Dashboard → **Edge Functions → Secrets** :
<https://supabase.com/dashboard/project/kuhxuovjlukxdzjnsyzt/functions/secrets>

| Nom | Valeur |
|---|---|
| `GOOGLE_CLIENT_ID` | ID du client OAuth Web actif (`918038722999-uthn16e1…apps.googleusercontent.com`) |
| `GOOGLE_CLIENT_SECRET` | le **nouveau** secret après reset |
| `N8N_BASE_URL` | URL de ton n8n, ex. `https://n8n.tondomaine.com` (sans `/api`) |
| `N8N_API_KEY` | n8n → Settings → **n8n API** → *Create an API key* |
| `TELEGRAM_BOT_TOKEN` | @BotFather → `/newbot` |
| `TELEGRAM_CHAT_ID` | envoie un message à ton bot, puis ouvre `https://api.telegram.org/bot<TOKEN>/getUpdates` → `chat.id` |
| `BLOTATO_API_KEY` | Blotato → Settings → API (clé **régénérée**, l'ancienne a circulé) |
| `DEEPSEEK_API_KEY` | platform.deepseek.com → API keys (clé **régénérée**) |

Les fonctions lisent les secrets au démarrage : rien à redéployer.

## 3. GitHub Pages

1. Crée le repo (ex. `reseau-de-control`) et pousse ce dossier tel quel.
2. **Settings → Pages → Deploy from a branch → `main` / root**.
3. L'URL sera `https://<ton-user>.github.io/reseau-de-control/`.

> `index.html` contient seulement la clé **publishable** Supabase (faite pour le navigateur). Aucune clé secrète dans le repo.

## 4. Auth Supabase (lien magique)

Dashboard → **Authentication → URL Configuration** :
<https://supabase.com/dashboard/project/kuhxuovjlukxdzjnsyzt/auth/url-configuration>

- **Site URL** = l'URL GitHub Pages ci-dessus
- **Redirect URLs** → ajouter la même URL (et `http://localhost:*` si tu testes en local)

Email autorisé : `abdelilah199818@gmail.com`. Pour en ajouter un :
```sql
insert into allowed_users(email) values ('autre@email.com');
```

## 5. Premier lancement

1. Ouvre le dashboard → connexion par email.
2. **Connexions → + Connecter un compte Google** → choisis le Gmail qui a GSC/GA4.
   Tous les sites Search Console et propriétés GA4 sont détectés et regroupés par domaine.
3. Vérifie les liaisons domaine ↔ GSC ↔ GA4 (menus déroulants), puis **Tout suivre**.
4. **Importer l'historique (16 mois)** → le worker traite la file toutes les 2 min
   (≈ 1–3 h pour 13 sites). Tu peux forcer avec « Traiter la file maintenant ».
5. Plusieurs Gmail ? Reclique « Connecter » : tout s'ajoute au même dashboard.

## 6. Ops n8n

- Après les secrets n8n : **Ops n8n → Synchroniser maintenant**.
- Coupe « Surveiller » sur les workflows JETABLE / tests.
- Mets un **Attendu (min)** sur les workflows planifiés (ex. WF3b = 120) → alerte si aucun succès depuis 2× ce délai.
- **Santé des services** : ajoute le `/health` du pod RunPod, le renderer VDS (`:8110`), ton n8n, tes blogs.

## 7. Pipeline (Google Sheet via Apps Script)

L'onglet **Pipeline** remplace le dashboard v3 : synthèse, articles (WF1), images (WF2a/2b + pod), Pinterest (WF3a + calendrier), planificateur Blotato, coûts, échecs. Rien ne change dans Apps Script ni dans n8n.

1. **Connexions → Réglages → URL web app Apps Script** : l'URL de déploiement qui finit par `/exec`.
2. Secrets Supabase : `APPS_SCRIPT_USER` et `APPS_SCRIPT_PASS` = un couple de `API_USERS` dans `API.gs`.
3. **Pipeline → Actualiser depuis le Sheet**. Ensuite, Supabase relit le Sheet toutes les 15 min.

Alertes ajoutées : Apps Script injoignable · échecs articles + images ≥ seuil · site avec des pins prêts mais rien de planifié sous 48 h.

---

## 8. Indexation Google (v6)

- Les articles `published` du Sheet sont ajoutés tout seuls à `url_index`. Ceux qui ont déjà des impressions GSC sont marqués indexés **sans** consommer de quota.
- Le worker inspecte toutes les 10 min, au plus `index_daily_per_site` par site et par jour (défaut 300 ; la limite Google est 2 000). Un article indexé est revérifié tous les 30 jours, un non indexé tous les 2 jours (7 jours s'il a plus de 30 jours).
- L'API ne permet pas de « Demander l'indexation » : le bouton **GSC** de chaque URL ouvre l'inspection dans Search Console.
- « Suivi depuis » = date où le dashboard a vu l'URL pour la première fois (le 26/10 pour l'existant), pas la date de publication.

## 9. Pinterest via Blotato (v6)

- La synchro (15 min) lit les comptes, **tous** les posts programmés, les échecs (14 j), les pins publiés et leurs stats (4 comptes par passage, en rotation), puis le lien de 40 pins par passage pour les relier aux articles.
- **Reprogrammer / Annuler** agissent directement chez Blotato (journal dans `blotato_actions`). Le Sheet n'est **pas** modifié.
- « Sheet vs Blotato » compare `Planifié pour` (Sheet) et ce qui est réellement programmé chez Blotato, sur 14 jours.

## 10. Assistant (DeepSeek) et connecteur Claude

- **Assistant** : bouton en bas à droite. Il lit les données via 17 outils en lecture seule et **propose** des actions (WF1/2/3, relances, envoi des pins, Blotato, alertes, inspection). Rien ne part sans ton clic « Exécuter » + confirmation. Plafond `agent_daily_tokens` (défaut 400 000 / jour, ≈ quelques centimes).
- **Connecteur Claude** : Connexions → « Connecteur Claude (MCP) » → copie l'URL → claude.ai **Settings → Connectors → Add custom connector**. Lecture seule. L'URL contient un jeton secret ; « Régénérer » invalide l'ancienne.

## 13. v7 (05/11)

- **Vue d'ensemble → « À faire aujourd'hui »** : 3 à 7 actions calculées sur tes données, chacune avec son bouton :
  - Blotato expiré, n8n ou site en panne, workflow en échec récent ;
  - échecs d'articles par cause, portée Pinterest écrasée, comptes sans pin programmé ;
  - site à 0 indexé, URLs du Sheet en 404 ou `?p=`, chute SEO, sitemap illisible.
- **Workflows morts** : un échec de plus de 7 jours (workflow qui ne tourne plus) n'est plus « en panne ». Il ne déclenche plus d'alerte critique (ops-sync) et apparaît comme « Ancien échec » dans le dashboard.
- **Pinterest → « Volume vs portée »** :
  - pins par semaine, et impressions et clics par pin (pins de plus de 7 jours) ;
  - tableau par compte (rythme sur 7 jours, impressions par pin récentes vs avant, diagnostic « trop de pins, portée écrasée » / « portée en chute ») ;
  - RPC `blotato_volume_reach`, `blotato_account_reach`.
- **Pipeline → Échecs → « Pourquoi ça échoue »** : regroupement par cause (crédit ou clé DeepSeek, WordPress / Wordfence, WF1 en double, mauvais site, doublon d'intention, contrôle qualité, carte recette, réponse coupée, délai), avec la correction à faire.
- **Badges « page 404 / lien ?p= / redirige »** sur les articles (Pipeline → Articles) et les posts programmés (Pinterest). RPC `article_link_health`.
- **Indexation → courbe « % indexé »** (relevé horaire `index_daily`, cron `index-snapshot-hourly`) et badge « bloqué » sur un site à 0 article indexé.
- **Sitemaps** : prise en charge de Yoast, `wp-sitemap.xml` et `sitemap.xml` (Shopify, etc.) avec les index imbriqués. Alerte dédiée `sitemap_error` ; message « site injoignable » quand le domaine ne répond plus en DNS.
- **Mobile** : la barre du bas défile (7 onglets lisibles).
- Migration `012_v7_insights.sql`.

## 12. Indexation v2 : la vérité = les sitemaps (30/10)

- Constat : sur 1 371 URLs « publiées » du Sheet, seules 478 étaient les vraies URLs. Les autres :
  - 383 liens courts `?p=123` ;
  - d'anciens slugs qui redirigent (slug changé, articles fusionnés en une seule page) ;
  - des pages en 404.
  
  Google ne connaît que l'URL finale : le « 77 % inconnus de Google » venait en grande partie de là.
- Désormais `url_index` = les URLs des sitemaps d'articles WordPress (995 articles en ligne le 30/10). Les sitemaps sont relus toutes les 6 h, ou via le bouton « Relire les sitemaps ».
- Les URLs du Sheet vont dans `url_alias` : elles sont vérifiées (redirection + canonique) puis reliées à leur vraie URL, ce qui garde l'article et le mot-clé.
  - Cron `index-aliases-2min` : 4 requêtes à la fois. Le serveur WordPress sature au-delà : 326 timeouts sur 350 requêtes parallèles.
- Panneau « URLs du Sheet à corriger » (Indexation) : export CSV, avec la vraie URL à coller dans la colonne URL du Master.
- Migrations `010_index_truth.sql` et `011_alias_claim_lock.sql`.

## 11. Calendrier (jour ou période)

- Bouton **Calendrier** dans toutes les vues de données : un jour précis ou une période du … au …, avec raccourcis (hier, J-3, ce mois-ci, mois dernier). Le choix suit d'un onglet à l'autre ; la croix ou un bouton « 7 j / 28 j » revient aux jours glissants.
- Un seul jour : chiffres de ce jour comparés à la veille ; courbes sur les 28 jours précédents avec le jour surligné en jaune.
- SEO (détail des requêtes : 90 derniers jours ; au-delà, agrégé par mois), Vue d'ensemble, Ops n8n (exécutions par workflow, 60 jours gardés), Indexation (nouveaux, indexés, inspectés + onglet « Activité de la période »), Pinterest (publiés, échecs, stats, meilleurs pins), Pipeline (séries du Sheet sur 30 jours + écarts des relevés horaires depuis le 25/10).
- Migration `009_date_range.sql` : fonctions « _range » ; les anciennes restent.

## Données & limites (free plan Supabase, 500 Mo)

| Donnée | Granularité | Durée |
|---|---|---|
| Clics/impressions/position par site | jour | 16 mois + illimité ensuite |
| Pays, appareils | jour (top 20) | idem |
| Requêtes, pages | jour (top 250) | 90 jours glissants |
| Requêtes, pages | mois (top 1000) | illimité |
| Sessions GA4, sources/supports | jour (top 50 sources) | illimité |
| Pages GA4 | mois (top 1000) | illimité |
| Exécutions n8n | 1 ligne / exécution | 60 jours |

Réglables dans **Connexions → Réglages**. En Supabase Pro (8 Go), on peut monter le détail quotidien à 1000+ requêtes/jour.

Données GSC : décalage normal de 1 à 3 jours ; les 5 derniers jours sont ré-importés chaque nuit.

## Alertes

| Alerte | Déclencheur |
|---|---|
| Workflow en échec | dernière exécution `error`/`crashed` (résolue au prochain succès) |
| Exécution bloquée | `running` depuis plus de 90 min (réglable) |
| Workflow silencieux | aucun succès depuis 2 × « Attendu » |
| Service down | health check ≠ code attendu ou timeout 12 s |
| API n8n injoignable | erreur sur l'API n8n |
| Compte Google déconnecté | refresh token révoqué → reconnecter |
| Chute SEO | clics GSC −40 % semaine/semaine (≥ 50 clics avant) |

Chaque nouvelle alerte part sur Telegram une seule fois, plus un message ✅ à la résolution.

## Fichiers

```
MASTER_PROMPT.md                 brief complet pour redessiner le front (contrat de données inclus)
index.html                       front (GitHub Pages)
supabase/migrations/001…012.sql  schéma, lecture, file + cron, durcissement, pipeline, indexation, Blotato, agent, calendrier
supabase/functions/_shared       helpers communs
supabase/functions/google-auth   OAuth + découverte des sites
supabase/functions/seo-sync      import GSC / GA4
supabase/functions/ops-sync      n8n, santé, alertes, Telegram
supabase/functions/pipeline      pont Apps Script (état du Sheet toutes les 15 min + actions)
supabase/functions/index-sync    inspection d'URL Search Console
supabase/functions/blotato       synchro Blotato + reprogrammer / annuler
supabase/functions/agent         assistant DeepSeek (propose, ne fait rien seul)
supabase/functions/control-mcp   serveur MCP pour claude.ai (lecture seule)
supabase/functions/_shared/tools.ts  outils lecture seule communs à l'agent et au MCP
_test/                           mock Supabase (mock-supabase.js + mock-v6.js) et index-test.html
```

Redéployer une fonction avec la CLI : `supabase functions deploy seo-sync --no-verify-jwt --project-ref kuhxuovjlukxdzjnsyzt`
