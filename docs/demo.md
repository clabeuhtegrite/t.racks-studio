# A demo instance of t.racks Studio

*[Version française](demo.fr.md)*

A demo instance lets anyone try t.racks Studio from a browser, without owning a DSP. One container
serves the interface with three devices, ready to connect on the **Connection** screen:

- **Emulated DSP 206** and **emulated DSP 408**: Thomann’s own firmware runs in the
  [emulator](../emulator/README.md) of the project. They answer like a real unit (settings, presets,
  lock, memory), but there is no audio in an emulator, so their meters stay at rest.
- **Demo DSP 408**: simulated by t.racks Studio itself, with moving meters.

A **Demo** badge in the top bar explains this to visitors. They all share these devices, and the
instance goes back to its starting state by itself: at each start, every night at 04:00 when someone
used it, and after 30 minutes without any open screen.

## Security

The demo runs the bridge in **sandbox** mode (`--sandbox`), made for an instance open to anyone:

- visitors reach only the emulated DSPs (inside the container) and demo DSPs: any other address is
  refused, so the instance gives no access to the network of the server;
- *Search the network* lists the emulated DSPs without sending anything on the network; no USB or
  serial port is listed;
- at most 8 devices in the list and 50 library entries.

There are no access codes by default: every visitor can change every setting of the demo DSPs, which
is the point of a demo. Set `DSP_STUDIO_PIN` to keep the settings for yourself (visitors can then
only look), or `DSP_STUDIO_OPERATOR_PIN` for volumes, mutes and presets only.

The container runs without privileges (user `node`, uid 1000), works with a read-only root file
system, and writes only to `/data`.

**The firmware belongs to Thomann** and is not part of the image. At the first start the container
downloads it in the background from Thomann’s website (`fast-images.static-thomann.de`, HTTPS) and
keeps it in `/data/firmware`. Without this access, only the demo DSP is offered: a failed download
is tried again 10 minutes later, then less and less often (at most every 4 hours). Do not publish
an image or a volume that contains it.

## With Docker

```sh
docker run -d --name tracks-demo --restart unless-stopped -p 8080:8080 -v tracks-demo:/data \
  -e TZ=Europe/Paris ghcr.io/clabeuhtegrite/t.racks-studio:main demo
```

or, with [the Compose file](../deploy/demo/compose.yaml) of the repository:

```sh
docker compose -f deploy/demo/compose.yaml up -d
```

Then open http://localhost:8080/ (or the address of the server). The interface answers at once. At
the first start, the emulated DSPs come in about a minute later, once the firmware is downloaded and
no screen is open (the demo starts again to add them, so nobody loses what they are doing); until
then, only the demo DSP is offered.

The image exists for amd64 and arm64 (a Raspberry Pi 4 or 5 with a 64-bit system). Its tags: `main`
follows the main branch, `x.y.z` a release, `sha-xxxxxxx` a given commit.

## On Kubernetes

[`deploy/demo/kubernetes`](../deploy/demo/kubernetes) holds a namespace, the deployment, a service
and an ingress. Set your host name (and your certificate issuer) in
[`ingress.yaml`](../deploy/demo/kubernetes/ingress.yaml), then:

```sh
kubectl apply -k deploy/demo/kubernetes
```

The state of the demo lives in the pod: keep a single replica. Traefik (the ingress controller of
k3s) carries the WebSocket of the interface without any setting; with ingress-nginx, uncomment the
two timeout annotations of the ingress.

To keep your settings out of this repository, for instance in a GitOps repository, a kustomization
of your own can take these files and change only the host name:

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

## Behind a reverse proxy

The interface keeps a WebSocket open on `/ws`. The proxy must pass it on (the `Upgrade` and
`Connection` headers) and keep the `Host` header: the bridge only accepts pages served under the
host name it is reached at. If your proxy changes it, give the public address to the bridge after
`demo`: `demo --allow-origin https://dsp.example.org`. The bridge pings every screen every
30 seconds, so a proxy that closes quiet connections after a minute or more is fine.

**Caddy**, with its automatic HTTPS certificate:

```caddyfile
dsp.example.org {
	reverse_proxy localhost:8080
}
```

**nginx**:

```nginx
server {
    listen 443 ssl;
    server_name dsp.example.org;
    # ssl_certificate and ssl_certificate_key of your certificate

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

**Traefik**, with Docker labels (in the Compose file, instead of `ports`):

```yaml
    labels:
      - traefik.enable=true
      - traefik.http.routers.tracks-demo.rule=Host(`dsp.example.org`)
      - traefik.http.routers.tracks-demo.entrypoints=websecure
      - traefik.http.routers.tracks-demo.tls.certresolver=letsencrypt
      - traefik.http.services.tracks-demo.loadbalancer.server.port=8080
```

## Settings

Environment variables of the `demo` command:

| Variable | Default | |
|---|---|---|
| `DEMO_RESET_AT` | `04:00` | daily reset, local time (`TZ`), when someone used the demo; `off`: none |
| `DEMO_IDLE_RESET` | `30` | minutes without any open screen before a reset; `0`: never |
| `DEMO_EMULATORS` | `206,408` | DSPs running the real firmware; `none`: demo DSPs only (no download) |
| `DEMO_VIRTUAL` | `408` | demo DSPs with moving meters (`206`, `408`, `206,408`…); `none`: none |
| `TZ` | UTC | time zone of `DEMO_RESET_AT`, such as `Europe/Paris` |
| `PORT` | `8080` | HTTP port inside the container |
| `DSP_STUDIO_PIN` | | administrator code (see *Security*) |
| `DSP_STUDIO_OPERATOR_PIN` | | operator code |

Arguments after `demo` go to the bridge (`demo --help` lists the variables).

## Resets and updates

A reset stops everything and starts again from the beginning: new emulated units with their
factory settings, the starting list of devices, an empty library. It takes about half a minute, the
time for the emulated DSPs to boot; open screens reconnect by themselves. Restarting the container
does the same:

```sh
docker restart tracks-demo
kubectl -n tracks-studio rollout restart deployment/tracks-studio-demo
```

On Kubernetes, the `rollout restart` also fetches the latest `main` image. With Docker:

```sh
docker compose -f deploy/demo/compose.yaml pull && docker compose -f deploy/demo/compose.yaml up -d
```

## Resources

About 150 MB of memory. An emulated DSP takes about one core while it is connected (the firmware
runs instruction by instruction). Two minutes after the last screen closes, the DSPs are
disconnected and the emulators pause: at rest, the instance uses almost no processor. The
[Kubernetes deployment](../deploy/demo/kubernetes/deployment.yaml) asks for 0.1 core and 256 MiB,
and is limited to 2 cores and 512 MiB.

## The image for real DSPs

Without the `demo` command, the same image runs t.racks Studio itself, for DSPs on Ethernet (no USB
or serial port in a container):

```sh
docker run -d --name tracks-studio --restart unless-stopped --network host -v tracks-studio:/data \
  -e DSP_STUDIO_PIN=1234 ghcr.io/clabeuhtegrite/t.racks-studio:main
```

`--network host` lets the network search find the DSPs; options go after the image name
(`--help` lists them). For a permanent setup at a venue, the [Raspberry Pi guide](raspberry-pi.md)
remains the simplest.
