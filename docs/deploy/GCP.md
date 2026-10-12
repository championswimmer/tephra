# Deploy Tephra on GCP

One Compute Engine VM + Persistent Disk running the Docker image, Caddy for HTTPS, secrets in Secret Manager. (Cloud Run needs Filestore; see `tephra-server/deploy/gcp/README.md`.)

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
