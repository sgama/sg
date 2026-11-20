---
title: "Call of Duty: Modern Warfare III"
summary: "Backend engineering, reliability, and scaling work for Demonware services supporting Call of Duty: Modern Warfare III."
showPagination: true
invertPagination: true
weight: 100
showDate: false
date: 2023-11-10
slug: "call-of-duty-mw3"
tags: ["backend", "gaming", "infrastructure", "SRE"]
---

![Key art for Call of Duty: Modern Warfare III](featured.webp)

## Scope

Supported backend services and engineering platforms behind **Call of Duty: Modern Warfare III** at **Demonware (Activision)**, as part of the team serving millions of concurrent players.

## What I Owned

- **Load and capacity validation**: Ran distributed load tests against release-candidate services, including extended runs ahead of peak traffic windows.
- **Fault injection**: Tested rate-limit behavior, HTTP error handling, and TLS failure paths by injecting failures into loaded services.
- **Backend service changes**: Developed and reviewed Python microservice changes behind online features.
- **Incident response**: Triaged production incidents under live load and converted repeat failures into runbooks and alerting changes.
- **Deployment standardization**: Standardized Kubernetes deployments with reusable Helm charts, templates, and shared configuration conventions.

## Outcomes

- Established capacity headroom and known failure modes before the launch window.
- Reduced configuration drift across services through shared deployment templates.
- Improved incident readiness by closing the gaps production incidents exposed.

*The load-testing platform, fault injection, and deployment standards described here were built and maintained across the Demonware titles I supported, not for a single release.*

**Tech Stack:**

- **Languages**: Python, C++, Go, Bash
- **Infrastructure**: Kubernetes, On-Prem
