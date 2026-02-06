---
title: "Ansible, why didn't I use this sooner"
summary: 'Automation that saved days of manual server setup time - from 1 hour manual configuration to 2 minutes automated deployment'
showPagination: true
invertPagination: true
showDate: true
date: 2017-07-01
slug: "ansible"
tags: ["ansible", "ops", "docker", "automation", "devops"]
---

![Featured image](featured.jpg)

I've been working with Linux since 2008. Back then, I mostly used a spare machine to run FreeNAS, Apache, MySQL, Python to host a static or Wordpress website.

Then as I got more invested with projects running on Linux, I started to set up VPSes to start hosting online in 2011. Everytime, it was the same process. Login as root, set up new user, disable root, set up PKA, enable firewall... etcetc. Took about 30min-1hour depending on how much of the process I remembered. I continued this process till 2015.

By this point, I was starting VPSes for every small project. Even if I wanted a scratch Linux server to work on a proof of concept to run for a couple of hours. I often needed a VPS to make it accessible by all viewers. After all, what good is a REST API if its only accessible to your internal network. Heroku existed at the time, however I wasn't fond of the CPU/Memory restrictions available on the free tier.

## The Solution: Ansible

In comes Ansible and Ansible-Playbooks, "the simplest way to automate apps and IT infrastructure".

I'll skip the details for now but with Ansible I was able to write my default setup as config files. Include my SSH Keys, and b64-ed passwords. Run the playbook and it takes care of the rest.

Now my **1 hour server setup takes 2 minutes** (times may vary based on CPU power of your VM). I no longer cringe at the idea of setting up a new VPS/VM to work on.

## Key Benefits

- **Time Savings**: Reduced setup time by 97% (60 minutes → 2 minutes)
- **Consistency**: Every server configured identically
- **Reproducibility**: Playbooks serve as infrastructure documentation
- **Error Reduction**: Eliminates manual configuration mistakes

I wish I knew about this sooner as I could have potentially saved **days of my life**.

If you're in a similar position of needing to set up VMs for POCs or new projects, I highly recommend adding Ansible into your automation pipeline.
