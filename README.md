# Réseau DE · Control (v4)

Un seul dashboard pour tout le système : **SEO (Search Console + GA4)**, **Ops n8n** (exécutions, échecs, services), **alertes Telegram**, et le **pipeline** (dashboard v3 en attendant la migration).

```
GitHub Pages (index.html)
   │  login magic link (Supabase Auth, emails autorisés seulement)
   ▼
Supabase  kuhxuovjlukxdzjnsyzt (Frankfurt)
   ├─ google-auth   connecter un Gmail → liste auto de tous ses sites GSC + propriétés GA4
   ├─ seo-sync      file d'import : historique 16 mois + mise à jour quotidienne
   ├─ ops-sync      n8n API toutes les 5 min, pings santé, alertes, Telegram
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
supabase/migrations/001…005.sql  schéma, fonctions de lecture, file + cron, durcissement, pipeline
supabase/functions/_shared       helpers communs
supabase/functions/google-auth   OAuth + découverte des sites
supabase/functions/seo-sync      import GSC / GA4
supabase/functions/ops-sync      n8n, santé, alertes, Telegram
supabase/functions/pipeline      pont Apps Script (état du Sheet toutes les 15 min + actions)
```

Redéployer une fonction avec la CLI : `supabase functions deploy seo-sync --no-verify-jwt --project-ref kuhxuovjlukxdzjnsyzt`
