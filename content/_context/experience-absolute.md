---
title: "Samson Gama at Absolute Software: Measured Backend Improvements"
description: "Documented throughput, resource utilization and migration outcomes."
draft: false
retrievalSource: "content/resume/_index.md"
retrievalSection: "Professional Experience"
---

# What measured improvements did Samson achieve at Absolute Software

Samson Gama was Software Developer at Absolute Software,
Jun 2017 - Sep 2018.

- Re-engineered a Python telemetry-processing microservice in Go, increasing
  throughput by roughly 10x and reducing CPU and memory utilization by 50% by
  replacing sequential message processing with goroutines and channels.
- Built a device simulation framework that emulated hundreds of thousands of
  secured devices, generating realistic and malformed telemetry events to
  load-test ingestion services and downstream behavior.
- Improved MongoDB production performance by roughly 20% through schema design,
  index optimization, data migrations and application data-access patterns.
- Automated repetitive deployment workflows through Jenkins, and worked with
  engineers on Docker, Go, Python and Kubernetes practices to keep development
  and production environments consistent.

The 20% MongoDB improvement and the roughly 10x throughput increase are
separate outcomes, not interchangeable measurements.

Source: [resume](/resume/), reviewed 2026-11-19.

<!-- FILL IN: Baseline and final measurements, workload and hardware,
measurement period, bottleneck analysis, migration risks and your individual
ownership. Explain why Go was appropriate and which alternatives you evaluated.
Keep published numbers consistent with the resume; do not extrapolate savings.
-->
