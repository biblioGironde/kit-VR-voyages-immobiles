# Voyages immobiles · Chargeur 360

Outil de **biblio.gironde** pour charger des vidéos 360° sur des casques **Meta Quest**, par câble USB, sans internet ni logiciel tiers. Pensé pour préparer un parc de casques prêtés en bibliothèque : on constitue une sélection, on branche les casques l'un après l'autre, et seules les vidéos manquantes sont envoyées.

Deux façons de l'utiliser :

| | Application de bureau (Electron) | Version web |
|---|---|---|
| Installation | Installeur Windows, `.dmg` macOS, AppImage Linux | Aucune : ouvrir `docs/index.html` dans Chrome ou Edge |
| Navigateur requis | Non | Chrome ou Edge (WebUSB) |
| Hors ligne | Oui | Oui (fichier unique, aucune ressource externe) |

## Fonctionnalités

- Glisser-déposer de vidéos ou de dossiers entiers (MP4, MKV, MOV, WebM…).
- Rangement par **collections** (par défaut « Voyage express » et « Évasion »), qui deviennent des sous-dossiers sur le casque. Un sous-dossier local qui porte le nom d'une collection y est rangé automatiquement.
- Comparaison avec le contenu du casque : *À envoyer*, *Déjà sur le casque*, *Différente*. Les doublons (même nom, même taille) ne sont pas renvoyés.
- Progression globale, vitesse, temps restant, annulation.
- **Mode série** : la sélection est conservée d'un casque à l'autre ; récapitulatif des casques préparés.
- Informations du casque : modèle, numéro de série, batterie, espace libre (vérifié avant l'envoi).
- Navigation et suppression des vidéos présentes sur le casque ; **mode miroir** optionnel qui aligne exactement le casque sur la sélection.
- Suffixe de projection optionnel (`_360`, `_360_TB`, `_360_LR`, `_180_LR`) pour les lecteurs qui l'exploitent (Skybox, DeoVR…).

Les vidéos sont déposées par défaut dans `/sdcard/Movies/360/<collection>/`, visibles dans l'application **Fichiers** du casque.

## Préparer un casque (une seule fois)

1. Activer le **mode développeur** dans l'application mobile Meta Horizon (*Appareils › Paramètres du casque › Mode développeur*). Le compte doit être rattaché à une organisation développeur Meta.
2. Brancher le casque à l'ordinateur avec un câble USB-C **de données**.
3. Cliquer sur **Connecter un casque**, puis, dans le casque, accepter « Autoriser le débogage USB » en cochant « Toujours autoriser depuis cet ordinateur ».
4. Fermer SideQuest, Meta Quest Developer Hub ou tout autre outil `adb` : ils bloquent l'accès USB.

## Développement

Prérequis : Node.js 22.

```bash
npm install
npm start            # construit la page puis lance l'application
npm run build:web    # construit seulement app/index.html et docs/index.html
npm run dist         # installeurs pour le système courant (dossier dist/)
```

Structure :

```
web/index.html        gabarit de la page (HTML + CSS)
web/app.js            logique : connexion ADB via WebUSB (Tango), transferts
scripts/build-web.mjs assemble la page autonome (esbuild, tout en un fichier)
electron/main.js      fenêtre Electron, autorisations USB, choix du casque
docs/index.html       version web construite (publiable sur GitHub Pages)
build/icon.png        icône de l'application
```

Après une modification de `web/`, lancer `npm run build:web` et committer `docs/index.html` pour mettre à jour la version web.

## Publier une version

Pousser une étiquette `vX.Y.Z` : l'action GitHub *Construire l'application* fabrique les installeurs Windows, macOS et Linux et les joint à une *Release*.

```bash
npm version patch   # met à jour package.json et crée l'étiquette
git push --follow-tags
```

Les applications ne sont pas signées : Windows SmartScreen demandera « Informations complémentaires › Exécuter quand même », et macOS demandera un clic droit › Ouvrir au premier lancement.

## Version web sur GitHub Pages

*Settings › Pages › Deploy from a branch*, branche `main`, dossier `/docs`. La page fonctionne alors depuis Chrome ou Edge à l'adresse du dépôt, en HTTPS.

## Technique

La communication avec le casque utilise le protocole ADB réimplémenté en JavaScript par [Tango](https://github.com/yume-chan/ya-webadb) (licence MIT), au-dessus de WebUSB. La clé d'authentification ADB est générée localement et conservée par l'application ; aucune donnée ne quitte l'ordinateur autrement que par le câble.

## Licence

MIT
