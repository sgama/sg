---
title: "Samson Gama: Homelab, Infrastructure Projects and Applied AI"
description: "Personal project evidence separated from employer production work."
draft: false
retrievalSource: "content/resume/_index.md"
retrievalSection: "Projects"
---

# What does Samson build outside employment

Samson Gama's resume lists two projects: a Retrieval-Augmented Portfolio
Assistant, 2025 - Present, and Self-Hosted Homelab & Cloud Infrastructure,
2010 - Present.

The RAG assistant runs on Cloudflare Workers, Workers AI and Vectorize, with
custom content ingestion, embedding generation, semantic retrieval and
streaming answer generation. Its deployments are versioned: corpus validation,
candidate indexing, deployment gates and rollback support keep retrieval data
consistent with application releases. It implements contextual query rewriting,
semantic retrieval and parent-section expansion, answers from retrieved
evidence, and abstains when retrieved context is insufficient. Regression tests
and labeled evaluation cases track retrieval success, latency, token usage and
estimated inference cost.

The homelab spans multi-cloud infrastructure across GCP, DigitalOcean and
Cloudflare using Terraform, Ansible, Packer and GitOps, monitored with
Prometheus and Grafana. His self-hosted Kubernetes platform uses Proxmox,
Talos Linux, Cilium CNI, ArgoCD and Helm, alongside MikroTik VLAN and firewall
networking and OpenResty/Lua load balancing.

These are personal projects. Their scale should not be read as employer
production scale, and the AI work is applied retrieval and application
engineering rather than foundation-model training.

Sources: [resume](/resume/) and [about](/about/), reviewed 2026-11-19.

<!-- FILL IN: Two projects with public URLs, purpose, architecture, your
ownership, current status, tests and measured results. For the AI chat, explain
retrieval, evaluation, failure handling and known limitations; date
architecture claims after changes. Do not publish home network addresses,
credentials or exploitable details. -->
