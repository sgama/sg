---
title: "Resume"
description: "Samson Gama's resume: senior software engineer building backend services, distributed systems, and Kubernetes platforms in Go and Python."
summary: "Senior software engineer with 8+ years building backend services, distributed systems, and production platforms in Go, Python, and Kubernetes."
showDate: false
---

# Samson Gama

Senior Software Engineer | Backend Systems | Go, Python, Kubernetes, AI

Vancouver, BC | [samsongama.com](https://samsongama.com) | [linkedin.com/in/samsongama](https://linkedin.com/in/samsongama/)

## Summary

Senior software engineer with 8+ years building backend services and the platforms they run on. Works in Go and Python, runs Kubernetes in production, and owns systems from design through incident response. Architected centralized GitOps across 20 bare-metal clusters, built a distributed load-testing platform that generated up to 10 million requests per minute for 10+ teams, and wrote the RFCs and migration plans for moving MySQL databases above 1 TB onto Vitess. Recent work spans NVIDIA GPU infrastructure for AI/HPC workloads and a serverless retrieval-augmented assistant on Cloudflare Workers, Workers AI, and Vectorize.

## Professional Experience

### Bitcomplete

Senior Software Developer | Mar 2026 - Jun 2026

- Architected centralized GitOps management across 20 bare-metal Kubernetes clusters, replacing independent ArgoCD deployments with a dedicated management cluster and eliminating nearly 20 redundant controllers
- Designed a customer onboarding workflow using isolated customer repositories and a shared platform monorepo, cutting new customer onboarding from roughly one day to 15 minutes and a small number of pull requests
- Supported GPU infrastructure across NVIDIA Hopper and Blackwell platforms, troubleshooting workloads involving NVLink, InfiniBand, NVIDIA drivers, and Slurm
- Raised operational readiness for GPU infrastructure serving AI/HPC workloads, standardizing runbooks, alerting, and incident-response workflows to shorten diagnosis and handoff

### Demonware (Activision)

Senior Software Engineer | Aug 2020 - Jan 2026

- Architected and built a distributed load-testing platform from scratch in Go, Kubernetes, and Redis, with horizontally scalable traffic generation and Redis-backed distributed token-bucket rate limiting
- Enabled 10+ engineering teams company-wide to generate up to 10 million requests per minute across multiple services, sustaining load tests of up to 72 hours
- Supported backend services and engineering platforms powering Call of Duty titles with millions of concurrent players, diagnosing production incidents under peak live traffic and turning repeat failures into runbooks and alerting changes that reduced repeat incidents and alert fatigue
- Implemented configurable fault injection for latency, traffic spikes, HTTP errors, and TLS failures, letting teams evaluate rate-limit behavior, find cascading service failures, and validate resilience under load
- Developed features in Python backend microservices integrating Apple, Google, Xbox, and PlayStation Network commerce platforms with internal entitlement services, supporting event-driven reconciliation across purchases, logins, and asynchronous fulfillment
- Authored and contributed to RFCs and technical proposals for migrating MySQL databases exceeding 1 TB to Vitess, covering schema and query compatibility, required schema changes, and ORM-managed migration plans with rollback procedures
- Standardized Kubernetes deployments with reusable Helm charts, templates, and internal tooling, and automated environment provisioning, supporting seven game launches and reducing configuration drift
- Established company-wide conf.d configuration standards and resource-utilization practices across backend services, driving adoption of standardized configuration structures and automation
- Contributed to cross-team architecture reviews, reviewed Python service changes, and mentored junior engineers on implementation and engineering practices

### Mastercard (Nudata Security)

Senior Software Engineer | Oct 2018 - Jul 2020

- Developed PHP backend services for behavioral biometric data collection and fraud detection, alongside the AWS infrastructure they ran on
- Designed and built highly available microservice infrastructure across AWS regions with CloudFormation and SaltStack, including backup strategies, disaster recovery procedures, and operational runbooks
- Architected and deployed an AWS VPC Traffic Mirroring environment with CloudFormation, replicating production load-balancer traffic into isolated environments while discarding mirrored responses, which enabled realistic testing, production bug reproduction, and safer deployments
- Automated infrastructure provisioning and deployment pipelines with CloudFormation and SaltStack across roughly 20 backend services in 8 AWS regions, and drove adoption of the resulting deployment tooling
- Improved background-job processing through better logging, error handling, and notification workflows, increasing failure visibility and reducing manual intervention
- Led bi-weekly technical sessions on offensive security, covering practical attack techniques and defensive engineering practices

### Absolute Software

Software Developer | Jun 2017 - Sep 2018

- Re-engineered a Python telemetry-processing microservice in Go, increasing throughput by roughly 10x and reducing CPU and memory utilization by 50% by replacing sequential message processing with goroutines and channels
- Built a device simulation framework that emulated hundreds of thousands of secured devices, generating realistic and malformed telemetry events to load-test ingestion services and downstream behavior
- Improved MongoDB production performance by roughly 20% through schema design, index optimization, data migrations, and application data-access patterns
- Automated repetitive deployment workflows through Jenkins, and worked with engineers on Docker, Go, Python, and Kubernetes practices to keep development and production environments consistent

### Prizm Media Inc

Software Developer Intern | Dec 2015 - Aug 2016

- Reduced response times for frequently used APIs by up to 70% through query optimization and application-level caching
- Developed backend and mobile features for an AWS-hosted social fitness platform, and prototyped machine-learning models using support vector machines and neural networks, including model development and performance evaluation

### Ericsson

Software Developer Intern | Sep 2015 - Dec 2015

- Developed a Python plugin for OpenStack Neutron that automated provisioning and lifecycle management of virtual Ericsson routers
- Diagnosed infrastructure, networking, and deployment issues in containerized virtual-router environments and Mirantis OpenStack test pipelines

### Grin Technologies

Software Developer Intern | May 2014 - Aug 2014

- Developed web applications for processing and visualizing electric-vehicle telemetry, and administered an AWS-hosted community forum serving 5,000+ daily users through 2020 - [endless-sphere.com](https://endless-sphere.com)

## Technical Skills

| Category | Skills |
| --- | --- |
| Languages | Go, Python, Bash, C/C++, Rust, Java, JavaScript, PHP |
| Backend & Distributed Systems | Microservices, Concurrency, Distributed Rate Limiting, Load Testing, Fault Injection, Performance Engineering |
| Databases & Data Processing | MySQL, PostgreSQL, MongoDB, Redis, Cassandra, Kafka, Vitess |
| Cloud & Infrastructure | AWS, GCP, Azure, Linux, Docker, Kubernetes, Terraform, Ansible, Packer, Helm |
| Software Delivery | CI/CD, Automated Testing, Git, Jenkins, ArgoCD, GitOps, CloudFormation, SaltStack |
| Observability | Prometheus, Grafana, OpenTelemetry, Distributed Tracing, Metrics, Logging |
| AI Engineering | Retrieval-Augmented Generation, Embeddings, Vector Search, Prompt Design, Evaluation |
| Networking | Cilium, Nginx, HAProxy, OpenResty/Lua, MikroTik, InfiniBand |
| Security | OSCP, CEH, Linux Hardening, Offensive Security |

## Projects

### Personal Website RAG Assistant | 2025 - Present

- Architected and built a serverless RAG application on Cloudflare Workers, Workers AI, and Vectorize, with custom content ingestion, embedding generation, semantic retrieval, and streaming answer generation
- Engineered versioned knowledge-base deployments with corpus validation, candidate indexing, deployment gates, and rollback support so retrieval data stays consistent with application releases
- Implemented contextual query rewriting, semantic retrieval, and parent-section expansion, producing evidence-grounded answers with explicit abstention when retrieved context is insufficient
- Developed regression tests and labeled evaluation cases for retrieval and answer quality, tracking retrieval success, latency, token usage, and estimated inference cost to catch quality regressions

### Self-Hosted Homelab & Cloud Infrastructure | 2010 - Present

- Built and managed multi-cloud infrastructure across GCP, DigitalOcean, and Cloudflare with Terraform, Ansible, Packer, and GitOps, monitored with Prometheus and Grafana
- Designed and operated a self-hosted Kubernetes platform on Proxmox with Talos Linux, Cilium CNI, ArgoCD, and Helm for reproducible clusters and automated application deployments
- Engineered MikroTik VLAN and firewall networking, custom OpenResty/Lua load balancing, authentication, and hardened Ubuntu hosts across the environment
- Implemented disaster recovery and S3 backup/restore testing, and deployed honeypots to validate recovery procedures and detect malicious activity

## Leadership and Community

### Strata Council President

- Lead a council representing a community of ~1,200 residents, coordinating stakeholders, facilitating meetings and decision-making, and communicating operational priorities

### Veazey Foundation Trustee

- Serve on the board of a charitable foundation providing full scholarships to incoming UBC students, contributing to governance, financial decisions, and long-term planning

## Certifications and Achievements

- Offensive Security Certified Professional (OSCP) | Offensive Security | 2020
- Trend Micro Capture the Flag | Global Finalist | Maple Bacon, UBC CTF | 12th of 1,000 teams | 2019

## Education

- University of British Columbia, B.A.Sc., Computer Engineering | 2017
