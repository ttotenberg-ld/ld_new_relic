# Running the demo on EC2 (amd64)

The PCG container image is AMD64-only (see [`../PCG_FINDINGS.md`](../PCG_FINDINGS.md) #7). On Apple Silicon dev machines it runs under QEMU emulation, and the emulated crypto layer corrupts PCG's outbound TLS handshake to NR cloud — blocking the NR-agent → PCG leg end-to-end.

Running the same demo on a native x86_64 Linux host (e.g. an EC2 instance) sidesteps the emulation entirely and lets us validate:

- `nr-agent-service` → TLS terminator → PCG's `nrproprietaryreceiver` → NR cloud (for APM data)
- `nr-agent-service` → PCG → LaunchDarkly OTLP (for Goal 2 forking, subject to the data-shape caveat in #6)

This is a throwaway demo box. Terminate it when you're done.

---

## 1. Launch an EC2 instance

### Recommended specs

| Setting | Value |
|---|---|
| **AMI** | Ubuntu Server 24.04 LTS (amd64) |
| **Instance type** | `t3.large` (2 vCPU, 8 GiB) — enough headroom for kind + PCG + 3 demo services. Bump to `t3.xlarge` if you see OOM kills. |
| **Architecture** | x86_64 (**not** arm64 / Graviton — that's what we're trying to avoid) |
| **Storage** | 40 GiB gp3 (20 GiB fills up once kind + PCG + three Node images are all on disk) |
| **Key pair** | Bring your own SSH key |
| **Security group** | Inbound: SSH (22) from your IP only. Outbound: all (needed for NR + LD + apt + Docker Hub). |

### CLI shortcut

Launch in two steps — security group first, then the instance. (Just passing `--key-name` without a security group lands you on the VPC's default SG, which typically has no inbound rules, so SSH fails.)

```bash
# 1. Security group with SSH from your IP only
MY_IP=$(curl -s https://checkip.amazonaws.com)
SG_ID=$(aws ec2 create-security-group \
  --group-name ld-nr-demo-sg \
  --description 'LD+NR demo box' \
  --query 'GroupId' --output text)
aws ec2 authorize-security-group-ingress \
  --group-id $SG_ID --protocol tcp --port 22 --cidr ${MY_IP}/32

# 2. Launch the instance with a public IP and that SG
aws ec2 run-instances \
  --image-id resolve:ssm:/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id \
  --instance-type t3.large \
  --key-name YOUR_KEY_NAME \
  --security-group-ids $SG_ID \
  --associate-public-ip-address \
  --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=40,VolumeType=gp3}' \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=ld-nr-demo}]'
```

If you'd rather use AWS's browser-based EC2 Instance Connect (which connects from AWS edge IPs, not yours), swap the CIDR in step 1 to `0.0.0.0/0`. That's fine for a short-lived throwaway demo — terminate the instance when done.

## 2. SSH in and install tooling

```bash
ssh -i ~/.ssh/YOUR_KEY.pem ubuntu@<public-ip>
```

Install everything in one shot:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg git openssl make

# Docker (from Docker's apt repo, not distro's)
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker $USER

# kind
curl -fsSL -o /tmp/kind https://kind.sigs.k8s.io/dl/v0.24.0/kind-linux-amd64
sudo install /tmp/kind /usr/local/bin/kind

# kubectl
curl -fsSL -o /tmp/kubectl "https://dl.k8s.io/release/$(curl -fsSL https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
sudo install /tmp/kubectl /usr/local/bin/kubectl

# helm (binary tarball — avoids apt repo DNS flakiness on some EC2 regions)
curl -fsSL https://get.helm.sh/helm-v3.16.1-linux-amd64.tar.gz \
  | sudo tar -xz -C /usr/local/bin --strip-components=1 linux-amd64/helm
```

Activate the `docker` group so non-root `docker` commands work in the current shell (otherwise you get `permission denied while trying to connect to the docker API`):

```bash
newgrp docker
```

Or log out and back in. Verify all four tools:

```bash
docker version
kind version
kubectl version --client
helm version
```

## 3. Clone the repo and configure credentials

```bash
git clone <this-repo> ld_new_relic
cd ld_new_relic/demo
cp .env.example .env
nano .env   # fill in LD_SDK_KEY, NEW_RELIC_LICENSE_KEY
```

Leave `NEW_RELIC_HOST=pcg-tls` in `.env` (that's the in-compose TLS terminator — not `collector.newrelic.com` and not `host.docker.internal`).

## 4. Stand up the kind cluster + PCG

```bash
# Create cluster
kind create cluster --name ld-nr-demo

# Install PCG
export NEW_RELIC_LICENSE_KEY=$(grep NEW_RELIC_LICENSE_KEY .env | cut -d= -f2)
helm repo add newrelic https://helm-charts.newrelic.com
helm repo update
cd pcg
helm upgrade --install pipeline-control-gateway \
  newrelic/pipeline-control-gateway \
  --namespace newrelic --create-namespace \
  --values values-newrelic-gateway.yaml \
  --set licenseKey=$NEW_RELIC_LICENSE_KEY \
  --set cluster=ld-nr-demo
cd ..

# Wait for PCG to be ready
kubectl -n newrelic rollout status deploy/pipeline-control-gateway --timeout=120s
```

## 5. Generate the self-signed TLS cert

```bash
bash pcg/tls/gen.sh
```

## 6. Start the port-forward as a background service

On EC2 we want port-forward to survive SSH disconnects. Use `nohup`, and bind PCG's NR-agent receiver to a non-privileged host port (8080) so we don't need `sudo` (which would run `kubectl` as root and miss your kubeconfig):

```bash
nohup kubectl -n newrelic port-forward svc/pipeline-control-gateway \
  4317:4317 4318:4318 8080:80 \
  > /tmp/pcg-portforward.log 2>&1 &

sleep 2
ss -tlnp | grep -E ':(8080|4318)\b'
```

Then tell the NR agent to hit port 8080 instead of the default 443. Edit `demo/.env` and add:

```
NEW_RELIC_PORT=8080
```

And update the Caddyfile to forward to 8080 instead of 80. Edit `demo/pcg/tls/Caddyfile`, change the `reverse_proxy` line to:

```
reverse_proxy http://host.docker.internal:8080
```

(If you do want the agent and Caddy talking on the standard :80 host port, you'd need `sudo kubectl --kubeconfig=$HOME/.kube/config ...` to preserve the user's cluster config. The 8080 path sidesteps that entirely.)

## 7. Launch the demo stack

```bash
cd ~/ld_new_relic/demo
docker compose up --build -d
```

All four services should come up:

```bash
docker compose ps
# nr-agent-service, otel-service, simulator, pcg-tls
```

## 8. Verify end-to-end

```bash
# NR agent should be connecting cleanly now (no more TLS errors from emulation)
docker exec nr-agent-service tail -30 /app/newrelic_agent.log

# PCG should be receiving NR agent traffic
kubectl -n newrelic logs -l app.kubernetes.io/name=pipeline-control-gateway --tail=50

# Internal PCG metrics for pipeline throughput (see demo README.md for query examples)
POD=$(kubectl -n newrelic get pods -l app.kubernetes.io/name=pipeline-control-gateway -o jsonpath='{.items[0].metadata.name}')
kubectl -n newrelic port-forward pod/$POD 8888:8888 &
curl -s http://localhost:8888/metrics | grep -E 'otelcol_(receiver|exporter)_.*spans'
```

In New Relic:

```sql
FROM Span SELECT *
  WHERE service.name = 'ld-nr-demo-agent-service'
    AND feature_flag.key IS NOT NULL
  SINCE 10 minutes ago LIMIT 20
```

In LaunchDarkly: open the `demo-flag` guarded rollout dashboard. Traces should show up within 1–2 minutes of traffic starting.

## 9. Clean up

```bash
# Demo stack
cd ~/ld_new_relic/demo
docker compose down

# PCG + kind
helm -n newrelic uninstall pipeline-control-gateway
kind delete cluster --name ld-nr-demo

# Terminate the EC2 instance
aws ec2 terminate-instances --instance-ids i-xxxxxxxxxxxx
```

## Notes

- The TLS terminator (Caddy sidecar in docker-compose) is still needed on EC2. PCG's `nrproprietaryreceiver` is plain HTTP only regardless of host architecture — that's a chart-shipping gap, not an emulation issue. See `PCG_FINDINGS.md` #4.
- Everything else in `PCG_FINDINGS.md` — the OTLP receiver binding (#1), the processor allowlist (#2), the Node.js OTel bridge stub (#6) — still applies on EC2. This guide gets you past the arm64-specific blocker (#7) only.
