# Deploy on DigitalOcean

One Droplet + one Volume (`/data`) + Reserved IP, running Docker Compose with Caddy (auto HTTPS).
App Platform is not suitable: it has no persistent disk (Tephra needs SQLite + blobs on disk).

## Infra at a glance

```mermaid
flowchart LR
  U["Browser / Obsidian plugin"]
  DNS["DO DNS or any DNS<br/>A notes"]
  subgraph DO["DigitalOcean"]
    RIP["Reserved IP<br/>+ firewall 80/443"]
    subgraph DR["Droplet"]
      CADDY["Caddy<br/>auto HTTPS"]
      APP["Tephra container<br/>API + web app"]
    end
    VOL[("Volume /data<br/>SQLite + blobs")]
    ENV["env file (600)<br/>SESSION_SECRET<br/>BOOTSTRAP_TOKEN"]
  end
  DNS --> RIP --> CADDY --> APP
  APP --- VOL
  ENV -.-> APP
  U -->|HTTPS| DNS

  class U actor;
  class DNS meta;
  class RIP,CADDY edge;
  class APP run;
  class VOL data;
  class ENV secret;
  classDef actor fill:#E0F2FE,stroke:#0369A1,color:#0C4A6E;
  classDef edge fill:#FFEDD5,stroke:#EA580C,color:#7C2D12;
  classDef run fill:#DCFCE7,stroke:#16A34A,color:#14532D;
  classDef data fill:#FEE2E2,stroke:#DC2626,color:#7F1D1D;
  classDef secret fill:#F5F3FF,stroke:#7C3AED,color:#4C1D95;
  classDef meta fill:#F3F4F6,stroke:#6B7280,color:#1F2937;
```

Colors: blue = users, orange = network edge, green = compute, red = data, purple = secrets, gray = DNS/meta.

## Quick way

```bash
doctl auth init
DOMAIN=notes.example.com REGION=nyc3 ./scripts/deploy/do.sh
```

Set `DNS_ZONE=example.com` to also create the A record (domain must be in DO DNS).

## Manual steps

1. Create a 10 GiB Volume and an Ubuntu 24.04 Droplet (2 GB RAM) in the same region.
2. Attach the Volume, format it once (`mkfs.ext4`), mount at `/data`, `chown 1000:1000 /data`.
3. Install Docker, clone the repo, build: `docker build -t tephra:local -f tephra-server/deploy/docker/Dockerfile .`
4. Generate secrets into a private env file:
   ```bash
   umask 077
   printf 'TEPHRA_SESSION_SECRET=%s\nTEPHRA_BOOTSTRAP_TOKEN=%s\nTEPHRA_PUBLIC_URL=https://notes.example.com\n' \
     "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > tephra.env   # chmod 600
   ```
5. Create a Reserved IP, assign it to the Droplet.
6. DNS: `A notes.example.com -> <reserved IP>` (DO DNS or any provider).
7. Run `docker compose --env-file tephra.env up -d` (Tephra on :8080, Caddy on :80/:443 proxying to it).

## First boot

1. Open `https://notes.example.com/setup` and create the owner account with the bootstrap token.
2. Delete `TEPHRA_BOOTSTRAP_TOKEN` from `tephra.env`, then `docker compose --env-file tephra.env up -d`.
3. Back up the Volume (enable DO snapshots).
