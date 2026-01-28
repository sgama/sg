---
title: "Internship: OpenStack Virtual Router Plugin"
summary: "Developed a Neutron SDN plugin for managing virtual Ericsson routers, streamlining network configuration in cloud environments."
showPagination: true
invertPagination: true
weight: 100
showDate: false
date: 2016-01-01
slug: "ericsson-openstack"
tags: ["cloud-infrastructure", "openstack", "python", "networking", "sdn", "docker"]
---

During my internship at **Ericsson**, I worked on integrating their telecommunications hardware into the cloud via OpenStack.

## Key Contributions

### 1. Neutron Plugin Development

- **Software Defined Networking (SDN)**: Co-developed a plugin for **OpenStack Neutron**, the networking component of OpenStack. This plugin allowed OpenStack to act as a control plane for managing virtualized Ericsson routers.
- **API Integration**: The plugin translated standard OpenStack API calls into specific configuration commands for the Ericsson routing hardware.

### 2. Testing & Automation

- **Integration Testing**: Enhanced the team's CI/CD pipeline by writing Python scripts to automate scenario-based testing across different environments.
- **Dockerization**: Leveraged Docker containers within the OpenStack environment to isolate test components and simulate complex network topologies.

### 3. Network Security

- **Inter-VM Communication**: Investigated and implemented secure communication channels between multiple Virtual Machines (VMs) without requiring runtime reconfiguration of Linux network interfaces.

**Tech Stack:**

- **Platform**: OpenStack (Neutron)
- **Languages**: Python, Bash
- **Tools**: Docker, Git, Jenkins
- **Domain**: SDN, Virtualization, L2/L3 Networking

[Learn more about Ericsson Virtual Routers](https://www.ericsson.com/ourportfolio/products/virtual-router)
