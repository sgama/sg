---
title: "Samson Gama: Homelab, Infrastructure Projects and Applied AI"
description: "Personal project evidence separated from employer production work."
draft: false
retrievalSource: "content/resume/_index.md"
retrievalSection: "🚀 Projects"
---

# What does Samson build outside employment

Samson Gama's resume lists two personal projects: a Retrieval-Augmented
Portfolio Assistant, 2025 - Present, and Self-Hosted Homelab & Cloud
Infrastructure, 2010 - Present. Together they show applied AI engineering,
multi-cloud operations and automation outside his employer production work.

The RAG assistant runs on Cloudflare Workers, Workers AI and Cloudflare AI
Search, with a single search tool the model calls to find evidence and
streaming answer generation. AI Search handles chunking, embedding, hybrid
retrieval and reranking, while the repository validates the corpus and uploads
it to a hash-named instance. Its deployments are versioned: corpus validation,
candidate indexing, deployment gates and previous-instance retention keep
retrieval data consistent with application releases. It answers from retrieved
evidence with page-level citations, and abstains when the results are
insufficient. Regression tests and labeled evaluation cases track retrieval
success, latency, token usage and estimated inference cost. This is retrieval
and application engineering, not foundation-model training.

The homelab spans multi-cloud infrastructure across GCP, DigitalOcean and
Cloudflare using Terraform, Ansible, Packer and GitOps, monitored with
Prometheus and Grafana. His self-hosted Kubernetes platform uses Proxmox,
Talos Linux, Cilium CNI, ArgoCD and Helm, alongside MikroTik VLAN and firewall
networking, custom OpenResty/Lua load balancing, authentication and hardened
Ubuntu hosts. He implemented disaster recovery and S3 backup/restore testing
and deployed honeypots to validate recovery procedures and detect malicious
activity.

These are personal projects. Their scale should not be read as employer
production scale, and the AI work is applied retrieval and application
engineering rather than foundation-model training.

Sources: [resume](/resume/) and [about](/about/), reviewed 2026-11-24.
