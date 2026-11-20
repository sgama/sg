---
title: "Capstone: Contextual Ad Targeting Engine"
summary: "Built a contextual ad-targeting engine that inferred time, location, and sentiment from text and image content."
showPagination: true
invertPagination: true
weight: 100
showDate: false
date: 2017-01-01
slug: "ubc-capstone"
tags: ["machine-learning", "nlp", "tensorflow", "backend"]
---

![Interface of the contextual ad targeting machine-learning platform](featured.webp)

For my UBC Engineering final year project, my team built a **Contextual Inference Engine**. This SaaS platform analyzed unstructured user content to extract metadata—time, location, and sentiment—and turned it into actionable ad-targeting signals.

## 🏗️ Technical Architecture

We designed the system as a modern microservices application.

### 1. Model Ensemble

We did not rely on a single model. Instead, we orchestrated a pipeline of AI services and custom models:

- **Third-Party APIs**: Integrated **Microsoft Azure Cognitive Services**, **Amazon Rekognition**, and **IBM Watson** for baseline analysis.
- **Custom Models**: Built specialized models using **Google TensorFlow** and **SyntaxNet** to refine sentiment analysis and entity extraction.

### 2. Cloud Native Deployment

- **Containerization**: Dockerized all services to keep development and production behavior consistent.
- **Orchestration**: Deployed the stack on a **Kubernetes** cluster to automate scaling and service discovery.
- **CI/CD**: Configured **TravisCI** for automated testing and deployment pipelines.

## 📈 Outcome

We built a working prototype that could take a raw image or text snippet and output structured JSON targeting data, such as a beach-side sunset signal driving sunscreen or travel ads.

**Tech Stack:**

- **ML Frameworks**: TensorFlow, SyntaxNet
- **Cloud Services**: Azure, AWS, IBM Cloud
- **Infrastructure**: Docker, Kubernetes, TravisCI
- **Languages**: Python

> Note: The demo is offline as the Azure student credits have expired.
