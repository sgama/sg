---
title: Notifications
subtitle: TLDR - Why don't you have monitoring yet?
date: 2018-06-04
tags: ["notifications", "ops", "alertmanager"]
---

Notifications make monitoring useful.

When looking at it from a passive monitoring perspective using Prometheus, Alertmanager is a great service to leverage as it can hook into Slack, PagerDuty, or even SMS.

Other times you may want to know when a client registers on your SaaS product, or when a client is attempting to leave. This is known as Application Performance Monitoring.
One example in my trading bot is that whenever the bot executes a trade or a stoploss is invoked, send me a slack message. If an error occurs while attempting to do the action, send me a slack message.
This allows me to remotely restart my services if necessary and otherwise lets me enjoy my day without needing to open Kibana or sshing into my servers while out and about.