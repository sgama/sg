---
title: "Privacy"
description: "How this website uses contact submissions, AI chat, analytics, and hosting services."
showDate: false
draft: true
---

This page explains what information this website processes and why. This is a plain-language description of the current setup, not legal advice.

## At a glance

| Area | Provider | What it touches |
|------|----------|-----------------|
| Contact form | Formspree | Name, email, subject, message |
| AI assistant | Cloudflare AI | Question and relevant context for response generation |
| Chat records | Cloudflare KV | Question and response, kept up to 30 days |
| Analytics | Umami (self-hosted on Cloudflare) | Aggregate page usage |
| Hosting | Cloudflare | Site delivery and AI features |
| Source and deployment | GitHub | Website source code |

## How the site is delivered

Changes to the website's source code live on GitHub. Deployments are made from that project to Cloudflare, which hosts and delivers the site and its AI features.

{{< mermaid >}}
flowchart LR
    Dev["Source code<br/>(GitHub)"] --> Deploy["Deployment<br/>from GitHub"]
    Deploy --> CF["Cloudflare<br/>hosting and delivery"]
    CF --> Visitor(["Visitor"])
{{< /mermaid >}}

## Where your data can go

{{< mermaid >}}
flowchart TD
    V(["You"]) --> F["Contact form"]
    V --> A["AI assistant"]
    V --> P["Pages and analytics"]
    F -->|"name, email, subject, message"| Formspree["Formspree<br/>(delivers to me)"]
    A -->|"question and context"| CFAI["Cloudflare AI<br/>(generates response)"]
    CFAI -->|"generated response"| A
    A -->|"question and response"| Chat[("Cloudflare KV<br/>kept up to 30 days")]
    Chat -.->|"owner review for<br/>content gaps"| Owner["Me"]
    A -.->|"saved in your browser"| Local[("Browser history<br/>cleared separately")]
    P -->|"aggregate usage"| Umami["Umami<br/>(self-hosted on Cloudflare)"]
{{< /mermaid >}}

## Contact form

If you contact me through the form, it sends the name, email address, subject, and message you provide to Formspree so the message can be delivered to me. Please avoid sending information you would not want included in an email.

## AI assistant

When you use the AI assistant, your question and relevant conversation context are processed by Cloudflare's AI services to generate a response. The question and response may be stored in Cloudflare KV for up to 30 days. I may review them to find unanswered questions or gaps in the website's content and AI context, and use those observations to decide what information to publish or improve.

The chat also saves conversation history in your browser so you can return to it later. Clearing that browser history does not remove separately stored chat records. Do not include passwords, financial details, confidential material, or other sensitive information in a chat.

## Analytics

This website uses Umami analytics, which I self-host on Cloudflare, to understand how visitors use the site and improve it. Umami is part of this site's infrastructure; I do not use a hosted Umami analytics account.

## Hosting and deployment

Cloudflare hosts and delivers the website and its AI features. The website's source code is maintained on GitHub, and deployments are made from that project. GitHub is used for the site's development and deployment workflow.

## Service providers

Cloudflare, Formspree, and GitHub provide services used by this website. Those providers may process information as needed to provide their services, subject to their own terms and privacy practices. Their handling and retention periods may differ from the periods described here.

## Your choices and requests

You can choose not to use the contact form or AI assistant. Depending on where you live, applicable privacy laws may give you rights to request access to, correction of, or deletion of personal information. To ask a question or make a request, use the [contact page](/contact/).

## Changes to this notice

I may update this page when the website or its data practices change. The latest version of this notice will be published here.

<!-- Editor note: Keep this page in draft until public access to chat records is restricted. Verify the notice against current practices and applicable requirements before publishing. -->
