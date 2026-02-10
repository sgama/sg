---
title: "Building a Reproducible Infra Lab with Packer, Terraform, Ansible, and Docker Compose"
date: 2021-06-06
slug: "homelab"
summary: "A deep-dive on structuring a reproducible infrastructure lab using image baking, provisioning, configuration management, and service orchestration."
tags: ["packer", "terraform", "ansible", "docker", "devops", "infra"]
categories: ["Infrastructure", "Automation"]
---

> This post is intentionally generic and redacts all environment-specific details. Replace placeholders (like `<region>`, `<domain>`, and `<registry>`) with your own values.

## Overview

A reliable infrastructure lab is built on **repeatable, auditable, and layered automation**. The most effective way to achieve this is to separate concerns into four distinct layers:

1. **Image Baking** (Packer) — produce a minimal, consistent base image.
2. **Infrastructure Provisioning** (Terraform) — create compute, storage, and network resources.
3. **Configuration Management** (Ansible) — apply OS hardening and tool installation.
4. **Service Orchestration** (Docker Compose) — run application stacks with minimal drift.

This guide walks through an end-to-end architecture you can build and expand over time. The flow is straightforward and safe to extend.

---

## High-Level Architecture

{{< mermaid >}}
flowchart TD
A[Source Control] --> B[Packer Build]
B --> C[Golden Image Artifact]
C --> D[Terraform Plan]
D --> H1[Proxmox Hypervisor]
D --> E[Provisioned Hosts]
E --> F[Ansible Playbooks]
F --> G[Hardened Hosts]
G --> H[Docker Compose Stacks]
H --> I[Services Online]
{{< /mermaid >}}

**Key properties of this layout:**

- Every stage has a clean input/output boundary.
- Any stage can be re-run without re-implementing the others.
- The system is resilient to partial rebuilds (e.g., re-provision only, or re-harden only).

---

## Repository Structure (Conceptual)

A clear folder structure makes the pipeline maintainable. The following is a logical layout that you can implement in your own repository:

```text
/packer/
  templates/
  scripts/
/terraform/
  modules/
  envs/
/ansible/
  playbooks/
  roles/
/assets/
  containers/
  configs/
```

This structure lets each layer evolve without pulling in unrelated changes.

---

## Hypervisor Layer: Proxmox (VMs and LXC)

While Packer, Terraform, Ansible, and Docker Compose are the visible layers, they usually sit **on top of a hypervisor**. In this architecture, **Proxmox** is the virtualization substrate. It sets your execution primitives, scaling model, and upgrade path.

### Why Proxmox fits this model

Proxmox provides:

- **VMs** for strong isolation, kernel independence, and OS customization.
- **LXC containers** for lightweight system services and fast boot times.
- **Snapshots and backups** that fit well with immutable image workflows.
- **A stable API surface** for automation and integration with Terraform.

### VM vs LXC decision points

- **Use VMs** when you need kernel-level isolation, custom kernels, or full OS control.
- **Use LXC** for lightweight, single-purpose services or build agents.

In practice, a common pattern is:

- **Core services in VMs** (e.g., edge, monitoring, data stores).
- **Utility services in LXC** (e.g., DNS, internal tools, CI runners).

### Where Docker Compose fits

Docker Compose runs **inside VMs**, not on the hypervisor directly. That keeps the separation of concerns clear:

- Proxmox manages compute and isolation.
- VMs provide a stable OS boundary.
- Docker Compose orchestrates app-level services within those VM boundaries.

{{< mermaid >}}
flowchart LR
P[Proxmox] --> V[VMs]
P --> L[LXC]
V --> D[Docker Compose]
{{< /mermaid >}}

---

## Layer 1: Image Baking with Packer

### Why bake images

Baked images give you predictable system bootstrapping. A base image means:

- All instances start from the same OS snapshot.
- Core system packages and agents are already installed.
- Initial boot time is faster (fewer first-boot tasks).

### Recommended Packer Responsibilities

Keep your Packer responsibilities narrow and predictable:

- Base OS updates
- Security patches
- Essential system packages (e.g., `sudo`, SSH server)
- Optional: VM guest agents, disk utilities, cloud-init tools

Anything beyond that is better handled by Ansible to avoid rebuilding images unnecessarily.

### Example: Packer Workflow

{{< mermaid >}}
sequenceDiagram
participant Git as Git Repo
participant Packer as Packer
participant Image as Image Registry

Git->>Packer: Build request (template + vars)
Packer->>Packer: Provision base OS
Packer->>Packer: Install core utilities
Packer->>Image: Publish golden image
{{< /mermaid >}}

### Common Pitfalls

- **Image bloat:** Avoid installing application stacks in Packer. It slows rebuilds.
- **Drift:** If you mutate images after provisioning, you lose reproducibility.
- **Version creep:** Always tag image outputs with explicit versions.

---

## Layer 2: Infrastructure Provisioning with Terraform

### Why Terraform

Terraform gives you:

- Declarative infrastructure
- Transparent plans and diffs
- Dependency tracking
- State management

That makes it a good foundation for a lab that should be reproducible and shareable.

### Recommended Terraform Responsibilities

Terraform should focus on _infra ownership_:

- VMs / instances
- Networks
- Firewalls
- Storage and volumes
- DNS records (if required)

Everything else (packages, services, app configs) should be deferred to Ansible or Docker Compose.

### Terraform Module Strategy

A disciplined module structure helps keep your infrastructure understandable:

{{< mermaid >}}
graph LR
A[Root Module] --> B[Compute Module]
A --> C[Network Module]
A --> D[DNS Module]
A --> E[Inventory Module]
{{< /mermaid >}}

### Declarative Outputs and Inventory

Terraform can generate:

- Dynamic inventory files for Ansible
- Local artifacts for tools (like SSH or editor configs)
- Outputs that power downstream provisioning steps

This cuts down on manual coordination across layers.

> **Hypervisor note:** Terraform can target Proxmox APIs to create both **VMs** and **LXC containers**, allowing you to treat the hypervisor as a first-class infrastructure provider.

---

## Layer 3: Configuration Management with Ansible

### Why Ansible after Terraform

Terraform provisions hosts, but it does **not** manage the OS lifecycle well. Ansible excels at:

- Enforcing configuration state
- Running idempotent provisioning
- Applying role-driven logic
- Simplifying system updates

### Recommended Playbook Structure

Split playbooks by concern, not by host:

- **Bootstrap:** OS updates, base tools, SSH hardening
- **Harden:** firewall, kernel tuning, security baselines
- **Deploy:** service dependencies, config files, user provisioning

{{< mermaid >}}
flowchart LR
A[Provisioned Host] --> B[Bootstrap Playbook]
B --> C[Harden Playbook]
C --> D[Deploy Playbook]
{{< /mermaid >}}

### Idempotency Patterns

Use these patterns to keep Ansible safe to re-run:

- `changed_when` for commands that are safe but not idempotent
- `creates:` in `command` and `shell` tasks to avoid rework
- Explicit `state: present` / `state: absent` definitions

### Security Model

Always separate variables and secrets:

- Store secrets in encrypted files or vault systems
- Use environment variables or CI-injected values
- Never commit plaintext credentials

#### Encrypted secrets with age + sops (CI-friendly)

For full automation, keep **encrypted** secrets in version control and decrypt them only in CI. A common approach is:

1. Generate an age keypair with `age-keygen` on a trusted machine.
2. Configure sops to use the age public key.
3. Encrypt secret files (including terraform variables) before committing.
4. In CI, load the age private key from GitHub Actions secrets and decrypt at runtime.

{{< mermaid >}}
flowchart TD
Dev[Developer workstation] -->|age-keygen| AgeKeys[Age keypair]
AgeKeys -->|public key| SopsConfig[sops.yaml config]
SecretsPlain[Plaintext secrets] -->|sops encrypt| SecretsEnc[Encrypted secrets]
SopsConfig -->|rules| SecretsEnc
SecretsEnc -->|git commit| Repo[Git repository]
Repo -->|checkout| CI[CI runner]
CI -->|age private key from secrets| Decrypt[sops decrypt]
Decrypt --> Ephemeral[Ephemeral files for jobs]
Ephemeral -->|apply| Terraform[Terraform/Ansible]
{{< /mermaid >}}

This lets you safely commit encrypted files such as [terraform.tfvars.json](terraform.tfvars.json) while keeping plaintext out of the repo.

{{< mermaid >}}
sequenceDiagram
participant Dev as Developer
participant Repo as Git Repo
participant CI as CI Runner
participant Vault as CI Secrets Store
participant Sops as SOPS
participant Age as age

Dev->>Age: Generate keypair
Dev->>Sops: Configure age public key
Dev->>Sops: Encrypt secrets
Dev->>Repo: Commit encrypted files
Repo->>CI: Pipeline starts
CI->>Vault: Fetch age private key
CI->>Sops: Decrypt secrets
Sops->>CI: Plaintext in temp workspace
CI->>CI: Use secrets, then delete
{{< /mermaid >}}

**Why this works:**

- Encrypted files remain auditable and versioned.
- CI pipelines are fully automated without manual secret handling.
- Rotating keys is straightforward (re-encrypt with a new age key).

**Good practice:**

- Treat encrypted files as the source of truth.
- Decrypt into ephemeral paths in CI.
- Never persist decrypted files as build artifacts.

---

## Layer 4: Service Orchestration with Docker Compose

### Why Docker Compose

Docker Compose is lightweight and ideal for lab stacks. It provides:

- Multi-service wiring
- Dependency ordering
- Simple replication
- Portable definitions

It fits well in a lab where you want fast iteration without standing up a full Kubernetes cluster.

### Compose Pattern: Split by Domain

Rather than one monolithic file, split stacks by concerns:

- `docker-compose.core.yml`
- `docker-compose.monitoring.yml`
- `docker-compose.services.yml`

Then aggregate them with a top-level include file or manual composition scripts.

{{< mermaid >}}
graph TD
A[Base Compose] --> B[Monitoring Stack]
A --> C[Services Stack]
A --> D[Edge/Proxy Stack]
{{< /mermaid >}}

### Configuration Hygiene

- Use `.env` for non-sensitive parameters
- Use `.env.local` for local-only overrides
- For secrets: mount them from a secure vault or encrypted store

> **VM boundary reminder:** Docker Compose is intentionally scoped to **within a VM**, so that service-level failures or upgrades do not impact the hypervisor or other workloads.

---

## Development Environment Strategy

A solid dev environment keeps this workflow sustainable.

### Recommended Tooling

- **Formatter and lint hooks** for YAML, HCL, and shell scripts
- **Task runners** to standardize common commands
- **CI checks** that validate syntax and schema

### Local Iteration Loop

{{< mermaid >}}
sequenceDiagram
participant Dev as Developer
participant Repo as Repository
participant CI as CI/Lint
participant Lab as Lab Host

Dev->>Repo: Commit change
Repo->>CI: Run format + lint
CI->>Repo: Report status
Dev->>Lab: Apply Terraform + Ansible
Lab->>Dev: Validation feedback
{{< /mermaid >}}

### Tips for Fast Feedback

- Keep a small "canary" host for rapid testing
- Use targeted Ansible tags
- Isolate Compose stacks to avoid restarting everything

---

## End-to-End Flow (Detailed)

Putting it all together:

1. **Bake** a minimal OS image with Packer.
2. **Provision** infrastructure from that image using Terraform.
3. **Bootstrap** and **harden** systems with Ansible.
4. **Deploy** services using Docker Compose.

{{< mermaid >}}
flowchart LR
A[Packer] --> B[Terraform]
B --> C[Ansible]
C --> D[Docker Compose]
{{< /mermaid >}}

Each layer stays focused and can be improved independently.

---

## Operational Best Practices

### Versioning and Release Strategy

- Tag Packer images with `vYYYYMMDD` or `vX.Y.Z`
- Store Terraform state in a remote backend for multi-user workflows
- Pin Ansible role versions for stable results
- Version Compose files and avoid floating tags for critical services

### Observability

Even in a lab, observability prevents unknown drift:

- Centralized logs
- Metrics collection
- Optional alerting routes

### Documentation

Treat docs as part of the infrastructure:

- Document service ports and security policies
- Keep a dependency map in the repo
- Explain build and provisioning workflows

---

## Example: Skeleton Automation Map

{{< mermaid >}}
mindmap
root((Infra Lab))
  Packer
    Base OS
    Guest Agent
    Security Updates
  Terraform
    Compute
    Network
    DNS
    Inventory
  Ansible
    Bootstrap
    Harden
    Users
    Tooling
  Docker Compose
    Proxy
    Monitoring
    Services
{{< /mermaid >}}

---

## Final Thoughts

This approach is modular and practical. It lets you:

- swap Packer builders (VMs, cloud images, containers)
- evolve Terraform modules safely
- re-run Ansible for drift correction
- redeploy services with minimal disruption

Keep each layer clear and minimal, and the lab stays stable as it grows.

---

## Next Steps

If you want to extend this pattern:

- Add a CI pipeline that validates every layer.
- Introduce an inventory generator from Terraform outputs.
- Add automated compliance checks in Ansible.
- Add a service catalog for Docker Compose stacks.

### Future path: Kubernetes with TalosOS

If the lab outgrows Compose, a **TalosOS-based Kubernetes cluster** on Proxmox VMs is a solid next step. TalosOS offers:

- Immutable, minimal OS for Kubernetes nodes
- API-driven operations (no SSH required)
- Predictable upgrades and rollbacks

It still fits the same layered model:

{{< mermaid >}}
flowchart LR
A[Packer] --> B[Proxmox VMs]
B --> C[TalosOS Nodes]
C --> D[Kubernetes]
D --> E[Platform Services]
{{< /mermaid >}}

You can stage this transition by:

- Keeping Compose for legacy or low-complexity stacks
- Introducing a small TalosOS cluster for new workloads
- Migrating services gradually using GitOps tooling

This setup scales from a single test host to a serious homelab or small production setup without losing the simplicity that keeps it manageable.
