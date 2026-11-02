# Une instance de démo de t.racks Studio

*[English version](demo.md)*

Une instance de démo permet à n’importe qui d’essayer t.racks Studio dans un navigateur, sans avoir
de DSP. Un seul conteneur sert l’interface avec trois appareils, prêts à être connectés depuis
l’écran **Connexion** :

- **DSP 206 émulé** et **DSP 408 émulé** : le firmware de Thomann lui-même tourne dans
  l’[émulateur](../emulator/README.md) du projet. Ils répondent comme un vrai boîtier (réglages,
  presets, verrouillage, mémoire), mais un émulateur n’a pas de son : leurs vumètres restent au repos.
- **DSP 408 de démo** : simulé par t.racks Studio, avec des vumètres qui bougent.

Un badge **Démo** dans la barre du haut l’explique aux visiteurs. Ils partagent tous ces appareils,
et l’instance revient d’elle-même à son état de départ : à chaque démarrage, chaque nuit à 4 h si
quelqu’un s’en est servi, et après 30 minutes sans aucun écran ouvert.

## Sécurité

La démo fait tourner le pont en mode **bac à sable** (`--sandbox`), prévu pour une instance ouverte
à tous :

- les visiteurs n’atteignent que les DSP émulés (dans le conteneur) et les DSP de démo : toute autre
  adresse est refusée, l’instance ne donne donc aucun accès au réseau du serveur ;
- *Rechercher sur le réseau* liste les DSP émulés sans rien envoyer sur le réseau ; aucun port USB
  ou série n’est proposé ;
- 8 appareils au plus dans la liste et 50 entrées dans la bibliothèque.

Il n’y a pas de code d’accès par défaut : chaque visiteur peut changer tous les réglages des DSP de
la démo, c’est le principe. `DSP_STUDIO_PIN` réserve les réglages à vous seul (les visiteurs ne
peuvent alors que regarder), `DSP_STUDIO_OPERATOR_PIN` leur laisse les volumes, les mutes et les
presets.

Le conteneur tourne sans privilège (utilisateur `node`, uid 1000), fonctionne avec un système de
fichiers en lecture seule et n’écrit que dans `/data`.

**Le firmware appartient à Thomann** et ne fait pas partie de l’image. Au premier démarrage, le
conteneur le télécharge depuis le site de Thomann (`fast-images.static-thomann.de`, en HTTPS) et le
garde dans `/data/firmware`. Sans cet accès, seul le DSP de démo est proposé. Ne publiez pas d’image
ni de volume qui le contient.

## Avec Docker

```sh
docker run -d --name tracks-demo --restart unless-stopped -p 8080:8080 -v tracks-demo:/data \
  -e TZ=Europe/Paris ghcr.io/clabeuhtegrite/t.racks-studio:main demo
```

ou, avec [le fichier Compose](../deploy/demo/compose.yaml) du dépôt :

```sh
docker compose -f deploy/demo/compose.yaml up -d
```

Ouvrez ensuite http://localhost:8080/ (ou l’adresse du serveur). Le premier démarrage prend environ
une minute : le firmware est téléchargé, puis chaque DSP émulé s’initialise comme un boîtier neuf.

L’image existe pour amd64 et arm64 (un Raspberry Pi 4 ou 5 avec un système 64 bits). Ses tags :
`main` suit la branche principale, `x.y.z` une version publiée, `sha-xxxxxxx` un commit précis.

## Sur Kubernetes

[`deploy/demo/kubernetes`](../deploy/demo/kubernetes) contient un namespace, le déploiement, un
service et un ingress. Indiquez votre nom d’hôte (et votre émetteur de certificats) dans
[`ingress.yaml`](../deploy/demo/kubernetes/ingress.yaml), puis :

```sh
kubectl apply -k deploy/demo/kubernetes
```

L’état de la démo vit dans le pod : gardez un seul réplica. Traefik (le contrôleur d’ingress de k3s)
transporte la WebSocket de l’interface sans réglage ; avec ingress-nginx, décommentez les deux
annotations de délai de l’ingress.

Pour garder vos réglages hors de ce dépôt, par exemple dans un dépôt GitOps, une kustomization à vous
peut reprendre ces fichiers et ne changer que le nom d’hôte :

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - https://github.com/clabeuhtegrite/t.racks-studio//deploy/demo/kubernetes?ref=main
patches:
  - target: { kind: Ingress, name: tracks-studio-demo }
    patch: |-
      - { op: replace, path: /spec/rules/0/host, value: dsp.example.org }
      - { op: replace, path: /spec/tls/0/hosts/0, value: dsp.example.org }
```

## Derrière un proxy inverse

L’interface garde une WebSocket ouverte sur `/ws`. Le proxy doit la transmettre (en-têtes `Upgrade`
et `Connection`) et garder l’en-tête `Host` : le pont n’accepte que les pages servies sous le nom
d’hôte par lequel on l’atteint. Le pont envoie un ping à chaque écran toutes les 30 secondes : un
proxy qui ferme les connexions silencieuses au bout d’une minute ou plus ne gêne pas.

**Caddy**, avec son certificat HTTPS automatique :

```caddyfile
dsp.example.org {
	reverse_proxy localhost:8080
}
```

**nginx** :

```nginx
server {
    listen 443 ssl;
    server_name dsp.example.org;
    # ssl_certificate et ssl_certificate_key de votre certificat

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 1h;
    }
}
```

**Traefik**, avec des labels Docker (dans le fichier Compose, à la place de `ports`) :

```yaml
    labels:
      - traefik.enable=true
      - traefik.http.routers.tracks-demo.rule=Host(`dsp.example.org`)
      - traefik.http.routers.tracks-demo.entrypoints=websecure
      - traefik.http.routers.tracks-demo.tls.certresolver=letsencrypt
      - traefik.http.services.tracks-demo.loadbalancer.server.port=8080
```

## Réglages

Variables d’environnement de la commande `demo` :

| Variable | Par défaut | |
|---|---|---|
| `DEMO_RESET_AT` | `04:00` | remise à zéro quotidienne, heure locale (`TZ`), si quelqu’un s’est servi de la démo ; `off` : aucune |
| `DEMO_IDLE_RESET` | `30` | minutes sans aucun écran ouvert avant une remise à zéro ; `0` : jamais |
| `DEMO_EMULATORS` | `206,408` | DSP qui font tourner le vrai firmware ; `none` : DSP de démo seulement (aucun téléchargement) |
| `DEMO_VIRTUAL` | `408` | DSP de démo aux vumètres animés (`206`, `408`, `206,408`…) ; `none` : aucun |
| `TZ` | UTC | fuseau horaire de `DEMO_RESET_AT`, par exemple `Europe/Paris` |
| `PORT` | `8080` | port HTTP dans le conteneur |
| `DSP_STUDIO_PIN` | | code administrateur (voir *Sécurité*) |
| `DSP_STUDIO_OPERATOR_PIN` | | code opérateur |

## Remises à zéro et mises à jour

Une remise à zéro arrête tout et recommence depuis le début : des boîtiers émulés neufs avec leurs
réglages d’usine, la liste d’appareils de départ, une bibliothèque vide. Elle dure environ une
demi-minute, le temps que les DSP émulés s’initialisent ; les écrans ouverts se reconnectent tout
seuls. Redémarrer le conteneur fait la même chose :

```sh
docker restart tracks-demo
kubectl -n tracks-studio rollout restart deployment/tracks-studio-demo
```

Sur Kubernetes, le `rollout restart` récupère aussi la dernière image `main`. Avec Docker :

```sh
docker compose -f deploy/demo/compose.yaml pull && docker compose -f deploy/demo/compose.yaml up -d
```

## Ressources

Environ 150 Mo de mémoire. Un DSP émulé occupe environ un cœur tant qu’il est connecté (le firmware
tourne instruction par instruction). Deux minutes après la fermeture du dernier écran, les DSP sont
déconnectés et les émulateurs se mettent en pause : au repos, l’instance n’utilise presque pas de
processeur. Le [déploiement Kubernetes](../deploy/demo/kubernetes/deployment.yaml) demande 0,1 cœur
et 256 Mio, et se limite à 2 cœurs et 512 Mio.

## L’image pour de vrais DSP

Sans la commande `demo`, la même image fait tourner t.racks Studio lui-même, pour des DSP en Ethernet
(pas de port USB ni série dans un conteneur) :

```sh
docker run -d --name tracks-studio --restart unless-stopped --network host -v tracks-studio:/data \
  -e DSP_STUDIO_PIN=1234 ghcr.io/clabeuhtegrite/t.racks-studio:main
```

`--network host` permet à la recherche réseau de trouver les DSP ; les options se placent après le
nom de l’image (`--help` les liste). Pour une installation fixe dans une salle, le
[guide Raspberry Pi](raspberry-pi.fr.md) reste le plus simple.
