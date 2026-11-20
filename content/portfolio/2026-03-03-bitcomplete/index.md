---
title: "Bitcomplete"
summary: "Centralized GitOps across 20 bare-metal Kubernetes clusters, customer onboarding, and NVIDIA GPU troubleshooting for AI/HPC workloads."
showPagination: true
invertPagination: true
weight: 100
showDate: false
date: 2026-03-03
slug: "bitcomplete"
tags: ["backend", "AI", "infrastructure", "reliability"]
---

![Bitcomplete cloud AI infrastructure platform operations board](featured.png)

## 🎯 Scope

Supported GPU infrastructure for AI/HPC workloads, including Kubernetes GitOps across 20 bare-metal clusters, NVIDIA GPU troubleshooting, customer onboarding, and incident-response workflows.

## 🛠️ What I Owned

- **Centralized GitOps across clusters**: Architected management of 20 bare-metal Kubernetes clusters through a single management cluster, replacing independent ArgoCD deployments and eliminating nearly 20 redundant controllers.
- **Automated customer onboarding**: Designed a workflow using isolated customer repositories against a shared platform monorepo, cutting new customer onboarding from roughly one day to 15 minutes and a small number of pull requests.
- **Troubleshot GPU workloads**: Diagnosed NVIDIA Hopper and Blackwell issues across NVLink, InfiniBand, NVIDIA drivers, and Slurm.
- **Raised operational readiness**: Standardized runbooks, alerting, and incident-response workflows for training and inference workloads to shorten diagnosis and handoff.
- **Closed the loop on incidents**: Investigated customer-facing incidents across networking, storage, scheduling, and system layers, then fed findings into postmortems, runbooks, and prevention work.

## 📈 Outcomes

- Removed deployment drift and redundant control-plane work across the GPU fleet.
- Cut customer onboarding from about a day to 15 minutes.
- Reduced customer workload downtime by standardizing NVIDIA tooling and incident workflows.
- Shortened diagnosis and handoff during incidents through clearer alerting and runbooks whose gaps had shown up in real incidents.

**Tech Stack:**

- **Platform**: Kubernetes (bare metal), ArgoCD, GitOps
- **Domain**: AI/HPC training and inference infrastructure
