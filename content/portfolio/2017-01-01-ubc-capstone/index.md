---
title: "Capstone: Contextual Ad Targeting Engine"
summary: "Machine Learning SaaS platform capable of inferring context (time, location, sentiment) from text/images to optimize ad targeting."
showPagination: true
invertPagination: true
weight: 100
showDate: false
date: 2017-01-01
tags: ["machine-learning", "nlp", "tensorflow", "kubernetes", "microservices", "python"]
---

For my UBC Engineering final year project, our team built a **Contextual Inference Engine**. This SaaS platform analyzed unstructured user content (text and images) to extract metadata—Time, Location, and Sentiment—to serve highly relevant advertising parameters.

## Technical Architecture

The system was designed as a modern microservices application.

### 1. Model Ensemble

We didn't rely on a single model. Instead, we orchestrated a pipeline of various AI services and custom models:

- **Third-Party APIs**: Integrated **Microsoft Azure Cognitive Services**, **Amazon Rekognition**, and **IBM Watson** for robust baseline analysis.
- **Custom Models**: Built specialized models using **Google TensorFlow** and **SyntaxNet** (for dependency parsing) to refine sentiment analysis and entity extraction.

### 2. Cloud Native Deployment

- **Containerization**: All services were Dockerized for consistency across development and production.
- **Orchestration**: Deployed on a **Kubernetes** cluster to manage scaling and service discovery.
- **CI/CD**: Configuring **TravisCI** for automated testing and deployment pipelines.

## Outcome

We successfully built a working prototype that could take a raw image or text snippet and output structured JSON targeting data (e.g., "User is happy, at a beach, during sunset -> Suggest Sunscreen or Travel Ads").

**Tech Stack:**

- **ML Frameworks**: TensorFlow, SyntaxNet
- **Cloud Services**: Azure, AWS, IBM Cloud
- **Infrastructure**: Docker, Kubernetes, TravisCI
- **Languages**: Python

> Note: The demo is offline as the Azure student credits have expired.
