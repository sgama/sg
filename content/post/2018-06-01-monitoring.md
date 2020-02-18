---
title: Passive Monitoring
subtitle: TLDR - Why don't you have passive monitoring yet?
date: 2018-06-01
tags: ["monitoring", "ops", "prometheus"]
---

Monitoring is a big topic. I can attempt to simplify it into a few categories.
- Passive Infrastructure Monitoring: Track CPU, Memory, Load, Uptime, Network, etc
- Log shipping: This is where your services stream their logs and you set alerts or metrics on certain patterns
- Active Monitoring: Ping your servers on a timer for aliveness/health, or a full verification of an API endpoint and its response
- Application Performance Monitoring: Metrics through code injection/addition to view application metrics

The one I want to discuss today is passive monitoring. Unless your career depends on things working all the time, you probably don't want to second guess yourself or have to manually check if your services or applications are up all the time.

While working on my trading bot (as seen in my portfolio), I often found that some parts of my program were going down all the time. It's not a huge issue as with docker-compose or Kubernetes, the service will simply be restarted.
However that's not how microservices are meant to work. The solution to errors are not just turn it off and on again. So how would I know if services were restarted? One was it to check docker or kubernetes, but from say a phone while in a restartant prometheus with alerting. It is possible as it would inform me that my services are not behaving as expected and that I should check the logs to debug any further issues.

Another example would be if your application is unstable during load, you'd want to be alerted if CPU or memory has exceeded some threshold so you can find the bottleneck or determine if you need to add more resources to your project.
Granted you'll need something to export node metrics like node-exporter to do this with prometheus.