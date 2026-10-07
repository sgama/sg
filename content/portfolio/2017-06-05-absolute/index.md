---
title: "High-Scale Backend: Absolute Data Pipeline"
summary: "Re-engineered a microservice from Python to Go, achieving 20x throughput and reducing CPU and memory utilization by 90%."
showPagination: true
invertPagination: true
weight: 100
showDate: false
date: 2017-06-05
slug: "absolute"
tags: ["backend", "kubernetes", "cybersecurity","biometrics"]
---

![Featured image](featured.webp)

At **Absolute Software**, I served as a Backend Developer focused on modernizing the company's core data ingestion infrastructure.

## The Problem

The legacy pipeline struggled to process the massive volume of security telemetry data coming from millions of endpoint devices. It was resource-heavy, slow to scale, and difficult to maintain.

## The Solution

I led the redesign of critical components of the pipeline, shifting from a monolithic approach to a microservices architecture.

### 1. Golang & Concurrency

- **Language Switch**: We rebuilt the ingestion workers in **Go (Golang)** to take advantage of its lightweight goroutines and superior handling of concurrent network I/O.
- **Async Processing**: Implemented a non-blocking, asynchronous processing model that could handle thousands of concurrent connections effortlessly.

### 2. Kubernetes Autoscaling

- **Orchestration**: Deployed the new services on **Kubernetes**.
- **Elasticity**: Configured Horizontal Pod Autoscalers (HPA) to automatically spin up new worker pods during traffic spikes and scale down during lulls.

## Results

- **Performance**: Achieved **20x throughput** after re-engineering a microservice from Python to Go.
- **Efficiency**: CPU and memory utilization were reduced by **90%**, while maintaining integration test coverage.
- **Reliability**: The system became resilient to bursts of data that previously caused outages.

## DevOps Contributions

Beyond the code, I improved the developer experience:

- **Internal Tools**: Built CLI tools for load testing and generating mock telemetry data.
- **Automation**: Optimized Jenkins pipelines to remove manual deployment steps.

**Tech Stack:**

- **Core**: Golang
- **Infrastructure**: Kubernetes, Docker
- **CI/CD**: Jenkins
- **Domain**: High-Volume Data Processing
