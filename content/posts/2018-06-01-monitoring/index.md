---
title: 'Passive Monitoring'
summary: 'Essential infrastructure monitoring with Prometheus - track system health, prevent downtime, and get alerts before issues become critical'
showPagination: true
invertPagination: true
weight: 100
showDate: false
date: 2018-06-01
tags: ["monitoring", "ops", "prometheus", "devops", "infrastructure"]
---

Monitoring is a big topic. I can attempt to simplify it into a few categories:

## Types of Monitoring

- **Passive Infrastructure Monitoring**: Track CPU, Memory, Load, Uptime, Network, etc
- **Log Shipping**: Services stream their logs and you set alerts or metrics on certain patterns
- **Active Monitoring**: Ping your servers on a timer for aliveness/health, or full verification of API endpoints
- **Application Performance Monitoring**: Metrics through code injection/addition to view application metrics

## Why Passive Monitoring Matters

The one I want to discuss today is **passive monitoring**. Unless your career depends on things working all the time, you probably don't want to second guess yourself or have to manually check if your services or applications are up all the time.

### Real-World Example: Trading Bot

While working on my trading bot (as seen in my portfolio), I often found that some parts of my program were going down all the time. It's not a huge issue as with docker-compose or Kubernetes, the service will simply be restarted.

However that's not how microservices are meant to work. The solution to errors are not just "turn it off and on again." 

**The question becomes**: How would I know if services were restarted?

## The Solution: Prometheus + AlertManager

One approach is to check Docker or Kubernetes manually, but that's not practical from a phone while in a restaurant. 

**Better approach**: Prometheus with alerting. It can inform me that my services are not behaving as expected and that I should check the logs to debug any further issues.

### Use Cases

**Performance Monitoring:**
- If your application is unstable during load, you'd want to be alerted if CPU or memory has exceeded some threshold
- Find bottlenecks or determine if you need to add more resources to your project
- Requires node-exporter to export node metrics to Prometheus

**Service Health:**
- Automatic restart detection
- Service availability tracking  
- Resource utilization alerts
- Network connectivity monitoring

## Implementation Benefits

- **Proactive**: Catch issues before they impact users
- **Remote**: Monitor from anywhere via mobile alerts
- **Automated**: No manual checking required
- **Scalable**: Works across multiple services and environments

**Bottom line**: If you don't have passive monitoring yet, you're flying blind and wasting time on manual checks that could be automated.