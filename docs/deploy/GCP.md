# Deploy Tephra on GCP

One Compute Engine VM + Persistent Disk running the Docker image, Caddy for HTTPS, secrets in Secret Manager. (Cloud Run needs Filestore; see `tephra-server/deploy/gcp/README.md`.)

## Infra at a glance

```mermaid
flowchart LR
  U["Browser / Obsidian plugin"]
  DNS["Your DNS<br/>A notes"]
  subgraph GCP["GCP project"]
    IP["Static external IP<br/>+ firewall 80/443"]
    subgraph VM["Compute Engine VM"]
      CADDY["Caddy<br/>auto HTTPS"]
      APP["Tephra container<br/>API + web app"]
    end
    PD[("Persistent Disk /data<br/>SQLite + blobs")]
    SM["Secret Manager<br/>SESSION_SECRET<br/>BOOTSTRAP_TOKEN"]
    AR["Artifact Registry<br/>Tephra image"]
  end
  DNS --> IP --> CADDY --> APP
  APP --- PD
  SM -.-> APP
  AR -.->|pull| VM
  U -->|HTTPS| DNS

  class U actor;
  class DNS meta;
  class IP,CADDY edge;
  class APP run;
  class PD data;
  class SM secret;
  class AR meta;
  classDef actor fill:#E0F2FE,stroke:#0369A1,color:#0C4A6E;
  classDef edge fill:#FFEDD5,stroke:#EA580C,color:#7C2D12;
  classDef run fill:#DCFCE7,stroke:#16A34A,color:#14532D;
  classDef data fill:#FEE2E2,stroke:#DC2626,color:#7F1D1D;
  classDef secret fill:#F5F3FF,stroke:#7C3AED,color:#4C1D95;
  classDef meta fill:#F3F4F6,stroke:#6B7280,color:#1F2937;
```

Colors: blue = users, orange = network edge, green = compute, red = data, purple = secrets, gray = DNS/meta.

1. Push the image to Artifact Registry (or any registry the VM can pull).
2. Log in and run the script:
   ```sh
   gcloud auth login
   PROJECT=my-proj ZONE=us-central1-a DOMAIN=notes.example.com \
   IMAGE=us-docker.pkg.dev/my-proj/tephra/tephra:latest \
   scripts/deploy/gcp.sh
   ```
   It creates: static IP, firewall (80/443), 10 GB disk, 2 secrets (`TEPHRA_SESSION_SECRET`, `TEPHRA_BOOTSTRAP_TOKEN`, random via `openssl rand -hex 32`), and the VM.
3. Add a DNS record at your registrar: `A notes.example.com -> <IP printed by script>`.
4. Wait ~2 min. Caddy gets the TLS cert; `TEPHRA_PUBLIC_URL=https://notes.example.com` is set for you.
5. Get the bootstrap token and open `https://notes.example.com/setup`:
   ```sh
   gcloud secrets versions access latest --secret=tephra-bootstrap-token
   ```
6. After setup, remove the token:
   ```sh
   gcloud compute ssh tephra --zone us-central1-a --command \
     "cd /opt/tephra && sudo sed -i '/BOOTSTRAP_TOKEN/d' tephra.env && sudo docker-compose up -d --force-recreate tephra"
   ```
7. Backup: `gcloud compute disks snapshot tephra-data --zone us-central1-a`.

Never attach one disk to two VMs.
