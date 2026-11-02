# syntax=docker/dockerfile:1
# t.racks Studio in a container: the web interface and the bridge, plus the firmware emulator for a
# demo instance. Published as ghcr.io/clabeuhtegrite/t.racks-studio (amd64 and arm64).
#
#   docker run -p 8080:8080 ghcr.io/clabeuhtegrite/t.racks-studio demo     public demo (docs/demo.md)
#   docker run -p 8080:8080 -v tracks:/data ghcr.io/clabeuhtegrite/t.racks-studio
#                                                                         the app itself, DSPs on Ethernet
#
# The DSP firmware is never part of the image: the demo downloads it from Thomann's site at its
# first start, into /data. A Raspberry Pi at a venue uses deploy/raspberry-pi/install.sh instead.

ARG NODE_IMAGE=node:22-bookworm-slim

# ---------------------------------------------------------------- web interface (any platform)
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS web
WORKDIR /src
COPY package.json package-lock.json ./
COPY apps/bridge/package.json apps/bridge/
COPY apps/web/package.json apps/web/
COPY packages/i18n/package.json packages/i18n/
COPY packages/protocol/package.json packages/protocol/
RUN npm ci --no-audit --no-fund --loglevel=error
COPY packages packages
COPY apps/web apps/web
RUN npm run build

# ---------------------------------------------------------------- runtime modules (plain JavaScript)
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS modules
WORKDIR /src
COPY package.json package-lock.json ./
COPY apps/bridge/package.json apps/bridge/
COPY apps/web/package.json apps/web/
COPY packages/i18n/package.json packages/i18n/
COPY packages/protocol/package.json packages/protocol/
# no USB / serial modules in a container: DSPs are reached over Ethernet (or emulated)
RUN npm ci --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund --loglevel=error

# ---------------------------------------------------------------- the image
FROM ${NODE_IMAGE}
# Python and Unicorn run the DSP firmware in the emulator; tini forwards signals and reaps processes
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY emulator/requirements.txt /tmp/emulator-requirements.txt
RUN python3 -m venv /opt/emulator \
 && /opt/emulator/bin/pip install --no-cache-dir --disable-pip-version-check -r /tmp/emulator-requirements.txt \
 && rm /tmp/emulator-requirements.txt

WORKDIR /app
COPY --from=modules /src/node_modules node_modules
COPY package.json package-lock.json LICENSE ./
COPY packages/i18n/package.json packages/i18n/
COPY packages/i18n/src packages/i18n/src
COPY packages/protocol/package.json packages/protocol/
COPY packages/protocol/src packages/protocol/src
COPY apps/bridge/package.json apps/bridge/
COPY apps/bridge/src apps/bridge/src
COPY apps/web/package.json apps/web/
COPY --from=web /src/apps/web/dist apps/web/dist
COPY emulator/*.py emulator/
COPY deploy/demo/demo.ts deploy/demo/
COPY deploy/docker/entrypoint.sh /usr/local/bin/t.racks-studio
RUN python3 -m compileall -q emulator \
 && chmod 0755 /usr/local/bin/t.racks-studio \
 && mkdir -p /data && chown node:node /data

ENV NODE_ENV=production \
    PATH=/opt/emulator/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8080 \
    DSP_STUDIO_DATA=/data \
    DEMO_DIR=/data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
ENTRYPOINT ["tini", "--", "t.racks-studio"]
CMD ["bridge"]

LABEL org.opencontainers.image.title="t.racks Studio" \
      org.opencontainers.image.description="Web editor for the t.racks DSP 206 and DSP 408, with a demo mode on the emulated firmware" \
      org.opencontainers.image.source="https://github.com/clabeuhtegrite/t.racks-studio" \
      org.opencontainers.image.licenses="MIT"
