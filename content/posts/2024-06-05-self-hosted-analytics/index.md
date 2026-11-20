---
title: "Privacy-First Analytics: Self-Hosting Umami with Cloudflare Tunnels"
date: 2024-06-05
slug: "self-hosted-analytics"
description: "Self-hosting Umami analytics on Docker, exposed through Cloudflare Tunnels, with Nginx gating the admin surface."
summary: "Self-hosted Umami on Docker and Cloudflare Tunnels: no inbound ports, admin surface gated by Nginx."
tags: ["analytics", "self-hosted", "docker", "cloudflare", "privacy"]
showDate: true
series: ["Homelab"]
---

![Featured image](featured.png)

I wanted basic usage analytics without sending visitor data to a third-party ad network or adding a heavy client-side script. I chose [Umami](https://umami.is/) and run it with Docker Compose on my home server, route public tracking requests through a Cloudflare Tunnel, and use Nginx to block the public admin surface.

That keeps inbound router ports closed and my home IP out of public DNS. I still own the database, backups, and tunnel uptime; this setup does not remove those operational responsibilities.

## 🏗️ The Architecture

The setup is surprisingly simple but robust. Instead of opening ports on my router (port forwarding 80/443), which exposes my home IP to the world, I use **Cloudflare Tunnels**. A lightweight daemon (`cloudflared`) creates an outbound connection to Cloudflare's edge, creating a secure tunnel for traffic to flow in.

{{< mermaid >}}
flowchart TD
subgraph Client
    Browser[User Browser]
end

subgraph "Cloudflare Edge Network"
    CDN[CDN / Cache]
    TunnelEntry[Tunnel End Point]
end

subgraph "Cloudflare Worker (static assets)"
    Static[Static Assets]
    HTML[index.html]
end

subgraph "Home Lab (Private Network)"
    Cloudflared[cloudflared]
    Umami[Umami App]
    DB[(PostgreSQL)]
end

%% Flow 1: Static Content
Browser -- "GET /" --> CDN
CDN -- "Fetch" --> Static
Static --> Browser

%% Flow 2: Analytics Data
Browser -- "POST /api/send" --> TunnelEntry
TunnelEntry -. "Encrypted Tunnel" .-> Cloudflared
Cloudflared -- "Internal Docker Network" --> Umami
Umami --> DB

linkStyle 0,1,2 stroke:blue,stroke-width:2px;
linkStyle 3,4,5,6 stroke:orange,stroke-width:2px;
{{< /mermaid >}}

This dual-path architecture enables the best of both worlds:

1. **Blue Path:** Static content is served instantly from Cloudflare's global cache (Workers static assets).
2. **Orange Path:** Analytics data travels securely through the tunnel to my home server without ever exposing my IP.

## 🐳 1. The Infrastructure: Docker Compose

I orchestrate everything in a single `docker-compose.yml` file. This ensures reproducibility and ease of updates.

### Logging Strategy

First, I set up a robust logging configuration. I pipe logs to Loki for analysis, but limit buffer sizes to prevent memory leaks on my server.

```yaml
x-logging: &default-logging
  driver: loki
  options:
    loki-url: "http://127.0.0.1:3100/loki/api/v1/push"
    mode: non-blocking
    max-buffer-size: 4m
    max-size: 20m
```

### The Services

There are two main stars of the show here:

1. **cloudflared**: This container authenticates with Cloudflare using a token and establishes the tunnel. It's the gatekeeper.
2. **umami**: The analytics engine itself.

```yaml
services:
  # 1. Cloudflare Tunnel
  # Securely exposes the internal Umami service to ping.samsongama.com
  cloudflared-sg:
    image: cloudflare/cloudflared:latest
    container_name: cloudflared-sg
    logging: *default-logging
    networks: [dev-tier]
    restart: always
    command: tunnel --no-autoupdate run
    environment:
      - TUNNEL_TOKEN=${CLOUDFLARED_SG_TUNNEL_TOKEN}

  # 2. Umami Analytics
  umami:
    image: ghcr.io/umami-software/umami:latest
    container_name: umami
    restart: unless-stopped
    depends_on:
      - postgres
    environment:
      DATABASE_URL: postgresql://umami:${UMAMI_PASSWORD}@postgres:5432/umami_data
      # Add IP Geolocation support
      GEO_DATABASE_URL: "https://github.com/P3TERX/GeoLite.mmdb/raw/download/GeoLite2-City.mmdb"
    logging: *default-logging
    networks: [dev-tier]
    volumes:
      - umami_data:/app/data
```

*Note: I also use a `postgres` service (not shown above for brevity) which Umami depends on.*

## 🔒 2. Secure Networking

Notice that the `umami` service **does not map any ports** (e.g., `ports: - 3000:3000`). This is intentional.

The container lives entirely inside the `dev-tier` Docker network. The `cloudflared` container is also on this network. It proxies traffic directly to `http://umami:3000` internally. The outside world literally cannot touch the Umami instance except through the verified Cloudflare Tunnel.

## 🛡️ 3. Hardening with Nginx

To take security a step further, I don't expose the Umami container directly to the tunnel. Instead, I place an **Nginx** reverse proxy in between. This allows me to selectively expose endpoints.

My public domain (`ping.samsongama.com`) allows legitimate visitors to download the tracking script and send data, but strictly blocks the admin dashboard.

```nginx
# Public Facing Block (ping.samsongama.com)
server {
    server_name ping.samsongama.com;

    # 1. Allow public access to tracking scripts
    location ~ ^/(script\.js|umami\.js)$ {
        proxy_pass http://umami:3000;
        # ... proxy headers ...
    }

    # 2. Allow public access to tracking API (metrics collection)
    location /api/send {
        proxy_pass http://umami:3000;
        # ... proxy headers ...
    }

    # 3. Block everything else (Login Page, Admin Panel)
    location / {
        return 403;
    }
}
```

If I need to check my stats, I access the dashboard via a separate, private domain (`https://analytics.local`) that is only available on my home LAN.

```nginx
# Internal Admin Block (analytics.local)
server {
    listen 443 ssl;
    server_name analytics.local;

    # Full access to the entire application
    location / {
        proxy_pass http://umami:3000;
        proxy_set_header Host $host;
        # ...
    }
}
```

## 🔗 4. Integration with Hugo

Once the backend is running at `https://ping.samsongama.com`, integrating it into Hugo is trivial.

I keep the script external so I can update the backend without touching the site code. In the Blowfish theme, we can inject this into the `<head>` using `layouts/partials/extend-head.html`.

```html
<!-- layouts/partials/extend-head.html -->
{{/* Umami Analytics */}}
<script defer src="https://ping.samsongama.com/script.js"
    data-website-id="random-id"></script>
```

Using `defer` keeps the script from blocking initial page render. Lighthouse scores are checked per release; the tracking script is small, but no specific score is claimed here.

## 🚀 Future Improvements

While this setup is robust, there are a few enhancements on my roadmap:

1. **Database Backups to R2**: Automating PostgreSQL dumps and shipping them to Cloudflare R2 for off-site disaster recovery.
2. **High Availability**: Adding a second `cloudflared` replica on a Raspberry Pi to ensure the tunnel stays up even if the main server takes a brief nap.

## ⚖️ Trade-offs and rationale

- **Self-host vs SaaS:** self-hosting keeps analytics data under my control and avoids a third-party tracker; the cost is owning uptime, backups and hardware.
- **Tunnel vs port forwarding:** no inbound ports and no home IP exposure; the cost is a dependency on Cloudflare's edge and a running daemon.
- **Nginx gating:** public endpoints serve only the script and `/api/send`; admin is LAN-only. This limits attack surface but adds a config layer to maintain.

## 📈 Performance and accessibility

- The tracking script is deferred and small; it does not block first paint. Analytics are aggregate and cookieless, which keeps the consent surface minimal.
- No accessibility regression is introduced: the script adds no UI.

## ✅ Conclusion

Self-hosting Umami via a Cloudflare Tunnel gives me aggregate, cookieless analytics without exposing my home IP or forwarding ports. The trade-off is operational ownership of the database, backups and tunnel uptime.
