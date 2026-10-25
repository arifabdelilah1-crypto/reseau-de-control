# 14_control — Réseau DE · Control, front « Synoptique » (v5)

Refonte complète de `index.html` du dashboard Control, faite à partir de `MASTER_PROMPT.md`.
Le backend (Supabase, edge functions, cron, Apps Script) n'a pas été touché.

## Ce qu'il faut faire

1. Remplacer `index.html` dans le repo GitHub Pages par `reseau-de-control/index.html`, puis pousser.
   Le dossier `reseau-de-control/` est le zip d'origine avec le nouveau `index.html` : on peut le pousser tel quel.
2. Ouvrir le dashboard, se connecter et faire le tour des onglets.
3. Contrôler l'onglet Pipeline sur les vraies données (voir « À vérifier en vrai »).

## Contenu

| Chemin | Rôle |
|---|---|
| `reseau-de-control/index.html` | le livrable : un seul fichier (HTML + CSS + JS), sans build |
| `_test/index-test.html` + `_test/mock-supabase.js` | la même page branchée sur une fausse base en mémoire, sans réseau ni écriture réelle |

Pour lancer le test : `cd 14_control/_test && python3 -m http.server 8765`, puis ouvrir
`http://127.0.0.1:8765/index-test.html?mock=full`. Scénarios disponibles : `full`, `empty`, `error`,
`slow`, `login`, `denied`.

## Direction visuelle

Un tableau de contrôle optique de poste d'aiguillage.
- **Signature** : la *ligne de production*, Sheet → WF1 → WF2a → WF2b → WF3a → WF3b → Trafic, dessinée comme une voie ferrée.
  - Chaque station a un feu (vert, ambre, rouge, bleu = en cours, gris = sans donnée) et ses compteurs.
  - Entre deux stations, une plaque indique ce qui attend l'étape suivante.
  - Sur mobile, la ligne passe en vertical.
- **Typographies** :
  - Big Shoulders pour les titres (style signalétique) ;
  - Atkinson Hyperlegible Next pour le texte ;
  - Atkinson Hyperlegible Mono pour les chiffres et les étiquettes.
- **Couleurs** :
  - fond porcelaine froid (`#e8ebe7`) le jour, vert-noir (`#0b0f0d`) la nuit ;
  - le jaune signal ne sert qu'à la sélection et au bouton principal. Il n'est jamais rond : les ronds sont réservés aux feux d'état.
- **Navigation** :
  - sur ordinateur, une barre latérale avec les 4 feux de santé (SEO, n8n, Pipeline, Services) ;
  - sur mobile, une barre en bas pour le pouce ;
  - **Ctrl/⌘ K** pour aller à une vue, un site ou une action.

## Ce qui a changé

**Ajouts**
- La ligne de production en tête de la Vue d'ensemble.
- Feux de santé et badge d'alertes visibles sur toutes les vues.
- La palette Ctrl/⌘ K.
- Tables triables par colonne et export CSV (séparateur `;` pour Excel en français).
- SEO : comparaison de deux sites côte à côte (« Comparer avec… »).
- Vue d'ensemble : petits triangles sur la courbe des clics les jours de pic de publication.
- Pipeline :
  - liste des articles (`articleList`) avec recherche ;
  - avertissement « sites sans pin sous 48 h » au-dessus du calendrier.
- Chaque graphique peut s'afficher en tableau (bouton à droite du titre).
- Chaque bloc a trois états : chargement (squelette), vide (avec ce qu'il faut faire) et erreur (avec un bouton « Réessayer »).
- Un écran de démarrage remplace la page blanche pendant la vérification de session.

**Corrections de bugs de la v4**
- **Critique** : enregistrer les Réglages écrivait 0 dans chaque champ vide. Une rétention à 0 aurait fait purger tout le détail requêtes/pages. Désormais :
  - seuls les champs modifiés sont écrits, en entiers ;
  - un champ vidé supprime la ligne, ce qui remet la valeur par défaut du backend ;
  - les valeurs par défaut sont affichées en gris.
- Toute écriture et tout lancement passe par une confirmation. Avant, il en manquait sur WF2b, l'envoi auto, l'envoi des pins, le pod, les coûts, l'import, « Tout suivre », Résoudre et Retirer.
- Les interrupteurs et menus reviennent à leur état si on annule ou si l'écriture échoue. Les erreurs d'écriture sont affichées.
- Planificateur :
  - un aperçu devient périmé dès qu'une option ou un site change, et « Appliquer » se désactive ;
  - « Appliquer » renvoie exactement les options de l'aperçu, avec son seed et `dry:"0"`.
- Après une action qui écrit dans le Sheet, la page surveille la relecture faite en arrière-plan puis se met à jour toute seule.
- Le rafraîchissement automatique (5 min) n'efface plus une saisie en cours.
- Un ancien chargement qui revient en retard ne remplace plus l'affichage. Le démarrage ne peut plus se lancer deux fois.
- Quand la position est vide sur une période, elle affiche « — ». Avant, elle affichait un faux « ▼ 100 % » en vert.
- Gagnants/perdants sont disponibles jusqu'à 45 j, la vraie limite. Avant, le texte annonçait 28 j.
- Les pages GA4 sont libellées « mois complets », ce que la base renvoie réellement.
- Supprimer un service résout aussi son alerte, qui restait ouverte pour toujours.
- Les 2 ou 3 derniers jours sans données Google (délai normal) laissent un trou sur les courbes, au lieu d'une fausse chute à zéro.
- supabase-js est figé en `2.117.3` (fichier statique, avec empreinte SRI) et Chart.js en `4.4.1`. Avant, `@2` suivait la dernière version.

## Contrat de données (§4), appel par appel

Tous les noms (RPC, tables, colonnes, actions) sont repris à l'identique. Vérification faite dans le code des
migrations et des edge functions, puis par une revue adversariale du fichier final.

- **RPC (12/12)** : `is_allowed`, `site_overview`, `site_series`, `top_queries`, `top_pages`, `query_movers`,
  `gsc_dims`, `ga4_sources`, `ga4_pages`, `workflow_health`, `n8n_daily`, `sync_progress`.
  - `p_site: null` est envoyé explicitement pour « tous les sites ».
  - Les dates sont calculées en UTC, comme `current_date` côté SQL.
- **Tables** :
  - en lecture : `alerts`, `google_accounts`, `gsc_sites`, `ga4_properties`, `sites`, `n8n_executions`, `health_checks`, `settings`, `pipeline_state` ;
  - en écriture : `alerts {resolved_at}`, `sites {tracked | gsc_site_id | ga4_property_id}` (`null` pour délier), `n8n_workflows {watch | expected_every_min}` (entier > 0 ou `null`), `health_checks` insert/delete, `settings` upsert.
- **Edge functions (10/10)** :
  - `google-auth` start / discover / disconnect ;
  - `seo-sync` backfill / work ;
  - `ops-sync` status / run / test_alert ;
  - `pipeline` refresh / call.
  - Les échecs renvoyés en HTTP 200 sont traités comme des échecs : `ok:false`, `n8n_error`, `results[id].error`, `failed > 0`.
  - Un 401 renvoie à la connexion.
- **Apps Script (17/17)** : wf1_run, wf1_retry_failed, wf1_diagnostic, wf2_run, wf2b_run, wf2_retry_failed, wf3_run,
  reset_failed, save_pod, test_pod, set_costs, plan_pins, unplan_pins, send_planned, auto_on, auto_off, auto_status.
  - `sites` et `weeks` partent toujours en tableaux (`[]` = tous) ; `dry` et `seed` en chaînes.
- **Deux écritures en plus**, autorisées par les policies RLS existantes mais absentes du tableau §4 :
  - `settings` delete : un champ vidé revient au défaut, au lieu d'écrire 0 ;
  - `alerts` update filtré sur `fingerprint = health:<id>` : à la suppression d'un service, son alerte se résout.
- **Sécurité** :
  - seule la clé `sb_publishable_…` est dans la page, et aucun appel direct à Apps Script, n8n, Google ou Telegram ;
  - tout texte venant des données est échappé.

## À vérifier en vrai (non vérifiable d'ici)

- **Forme de `pipeline_state.data`** :
  - `Dashboard.gs` n'est ni dans le zip ni sur ce Mac, et le projet Supabase n'est pas accessible depuis mon compte. La forme suit donc le §4.4 sans contrôle en direct.
  - Le code est défensif : un champ absent affiche « — », il ne casse rien. Points à regarder une fois : la liste des articles (champs `st`, `im`, `d`, `pl`, …) et les exemples du Diagnostic WF1.
- **Rapprochement des workflows sur la ligne** : il se fait par le nom (`WF1`, `WF2a`, `WF2b`, `WF3a`, `WF3b`), copies TENDANCE / JETABLE / test exclues. Si un feu de station reste gris, son infobulle donne la raison.
- **Tests** : tout a tourné sur la fausse base (toutes les vues, clair/sombre, 375 px et bureau, scénarios vide/erreur/lent/refusé, aucune erreur JavaScript). Rien n'a été exécuté contre la vraie base.
