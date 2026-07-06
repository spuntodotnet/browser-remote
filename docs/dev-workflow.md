# dev-workflow — browser-remote

> **Lu par l'agent qui tourne sur le worker Spunto** (pipeline idée→prod, voir
> `workflows/idea-to-prod.md` du sandbox `work`). Le service `automations` ne fait
> plus que créer/arrêter le worker — c'est **toi**, l'agent, qui pilotes tout le
> reste en suivant ce fichier.
>
> ⚠️ **Stub à étoffer.** Ce repo n'a pas encore de suite de tests automatisés
> (`package.json` n'expose qu'un `start`). En attendant, la vérification est un
> sanity-check manuel (le serveur démarre / le conteneur build et répond).
> Remplacer l'étape « Tester » quand de vrais tests existent.

## Contexte de départ (déjà en place quand tu démarres)

- Tu es sur une branche dédiée déjà créée et checkout : `clickup/{taskId}-{slug}`.
- `$CLICKUP_TASK_ID` (id de ta carte) et `$CLICKUP_API_KEY` sont dans ton env.
- `gh` est authentifié.
- Le worker est jetable et dédié à cette seule tâche.

## 1. Implémenter

Réalise la demande (titre + description de la carte). Commit au fur et à mesure
sur la branche courante.

## 2. Vérifier (sanity-check, faute de suite de tests)

```bash
docker compose up -d --build   # le conteneur doit builder et démarrer
docker compose ps              # service up
docker compose logs --tail=50  # pas d'erreur au boot
# puis vérifier que l'UI/API répond (port 3001, voir README) — idéalement en
# exerçant concrètement le changement apporté.
```

_(TODO : ajouter une vraie suite de tests et l'appeler ici.)_

## 3. Livrer

Une fois le sanity-check concluant :

1. Passe la carte en `to be tested` :
   ```bash
   curl -s -X PUT -H "Authorization: $CLICKUP_API_KEY" -H "Content-Type: application/json" \
     -d '{"status": "to be tested"}' \
     "https://api.clickup.com/api/v2/task/$CLICKUP_TASK_ID"
   ```
2. Push + ouvre la PR, commente le lien sur la carte, passe-la en `in review` :
   ```bash
   GIT_TERMINAL_PROMPT=0 git push -u origin HEAD
   gh pr create --base main --fill --body "Carte ClickUp : https://app.clickup.com/t/$CLICKUP_TASK_ID"
   curl -s -X POST -H "Authorization: $CLICKUP_API_KEY" -H "Content-Type: application/json" \
     -d '{"comment_text": "PR ouverte : <URL>"}' \
     "https://api.clickup.com/api/v2/task/$CLICKUP_TASK_ID/comment"
   curl -s -X PUT -H "Authorization: $CLICKUP_API_KEY" -H "Content-Type: application/json" \
     -d '{"status": "in review"}' \
     "https://api.clickup.com/api/v2/task/$CLICKUP_TASK_ID"
   ```

Puis **arrête-toi** : le merge de la PR déclenche automatiquement le passage de la
carte en `completed` et l'arrêt du worker (webhook GitHub → automations).

## En cas d'échec du sanity-check

Ne fais pas avancer la carte. Poste un commentaire avec le souci, corrige, et
recommence à l'étape 2.
