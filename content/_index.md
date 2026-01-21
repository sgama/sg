---
title: "Samson Gama"
description: "Portfolio"
---

<style>
        /* Modern CSS Custom Properties */
        :root {
            --gradient-1: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            --gradient-2: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
            --gradient-3: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%);
            --shadow-color: 220 3% 15%;
            --shadow-strength: 1%;
        }

        /* Container Query Support */
        @container (min-width: 400px) {
            .intro-hero h1 {
                font-size: clamp(2.5rem, 8vw, 4rem);
            }
        }

        /* CSS Grid Layout */
        .intro-container {
            display: grid;
            grid-template-columns: 1fr;
            grid-template-areas:
                "hero"
                "content"
                "skills"
                "connect";
            gap: 0rem;
            container-type: inline-size;
            margin: 1rem 0;
            width: 100%;
            max-width: none;
        }


        /* Hero Section with Modern Typography */
        .intro-hero {
            grid-area: hero;
            text-align: center;
            padding-bottom: 1em;
            position: relative;
            overflow: hidden;
        }


        .intro-hero h1 {
            font-family: sans-serif;
            font-weight: 900;
            font-size: clamp(2rem, 5vw, 3.5rem);
            margin: 0;
            background: linear-gradient(135deg,
                #ffffff 0%,
                #e0e0e0 25%,
                #ffffff 50%,
                #d0d0d0 75%,
                #ffffff 100%);
            background-size: 200% 200%;
            -webkit-background-clip: text;
            background-clip: text;
            -webkit-text-fill-color: transparent;
            animation: shimmer 3s ease-in-out infinite;
            position: relative;
            z-index: 1;
        }

        .intro-hero .typing-effect {
            font-family: 'JetBrains Mono', monospace;
            font-weight: 400;
            font-size: clamp(1rem, 2.5vw, 1.5rem);
            color: #a0a0a0;
            margin-top: 1rem;
            position: relative;
            display: inline-block;
        }

        .intro-hero .typing-effect::after {
            content: '|';
            color: #4facfe;
            animation: blink 1s infinite;
            margin-left: 2px;
        }

        /* Content Section */
        .intro-content {
            grid-area: content;
            padding: 1rem;
            background: rgba(255, 255, 255, 0.02);
            border-radius: 20px;
            border: 1px solid rgba(255, 255, 255, 0.1);
            backdrop-filter: blur(10px);
            position: relative;
            overflow: hidden;
        }

        .intro-content::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: linear-gradient(135deg, transparent 0%, rgba(255, 255, 255, 0.02) 50%, transparent 100%);
            pointer-events: none;
        }

        .intro-content h2 {
            font-family: sans-serif;
            font-weight: 700;
            font-size: clamp(1.5rem, 3vw, 2rem);
            margin-top: 1rem;
            margin-bottom: 1rem;
            color: #ffffff;
            position: relative;
        }

        .intro-content p {
            font-family: sans-serif;
            font-weight: 400;
            color: #c0c0c0;
            font-size: clamp(0.9rem, 2vw, 1.1rem);
        }

        /* Skills Section with CSS Logical Properties */
        .skills-grid {
            grid-area: skills;
            padding: 1.5rem;
            background: rgba(255, 255, 255, 0.02);
            border-radius: 20px;
            border: 1px solid rgba(255, 255, 255, 0.1);
            backdrop-filter: blur(10px);
        }

        .skills-grid h3 {
            font-family: sans-serif;
            font-weight: 700;
            color: #ffffff;
            margin-block-end: 1.5rem;
            font-size: clamp(1.2rem, 2.5vw, 1.5rem);
        }

        .skills-list {
            display: flex;
            flex-wrap: wrap;
            gap: 0.75rem;
        }

        .skill-tag {
            font-family: 'JetBrains Mono', monospace;
            font-size: 0.85rem;
            padding: 0.5rem 1rem;
            background: linear-gradient(135deg, rgba(79, 172, 254, 0.2), rgba(0, 242, 254, 0.2));
            border: 1px solid rgba(79, 172, 254, 0.3);
            border-radius: 50px;
            color: #4facfe;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            position: relative;
            overflow: hidden;
        }

        .skill-tag::before {
            content: '';
            position: absolute;
            top: 0;
            left: -100%;
            width: 100%;
            height: 100%;
            background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.1), transparent);
            transition: left 0.5s;
        }

        .skill-tag:hover::before {
            left: 100%;
        }

        .skill-tag:hover {
            transform: translateY(-2px);
            box-shadow: 0 10px 25px rgba(79, 172, 254, 0.2);
        }

        /* Connect Section */
        .connect-section {
            grid-area: connect;
            text-align: center;
            padding: 1rem 0;
        }

        .connect-links {
            display: flex;
            justify-content: center;
            gap: 1rem;
            flex-wrap: wrap;
            margin-top: 1rem;
        }

        .connect-link {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            padding: 1rem 1.5rem;
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 15px;
            color: #e0e0e0;
            text-decoration: none;
            font-family: sans-serif;
            font-weight: 500;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            position: relative;
            overflow: hidden;
        }

        .connect-link::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: linear-gradient(135deg, rgba(255, 255, 255, 0.1), transparent);
            opacity: 0;
            transition: opacity 0.3s;
        }

        .connect-link:hover::before {
            opacity: 1;
        }

        .connect-link:hover {
            transform: translateY(-3px) scale(1.02);
            box-shadow: 0 15px 30px rgba(0, 0, 0, 0.2);
            border-color: rgba(255, 255, 255, 0.2);
        }

        /* Modern Animations */
        @keyframes shimmer {
            0%, 100% { background-position: 0% 50%; }
            50% { background-position: 100% 50%; }
        }

        @keyframes rotate {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
        }

        @keyframes blink {
            0%, 50% { opacity: 1; }
            51%, 100% { opacity: 0; }
        }

        @keyframes fadeInUp {
            from {
                opacity: 0;
                transform: translateY(30px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }

        /* Animation delays for staggered effect */
        .intro-hero { animation: fadeInUp 0.8s ease-out; }
        .intro-content { animation: fadeInUp 0.8s ease-out 0.2s both; }
        .skills-grid { animation: fadeInUp 0.8s ease-out 0.4s both; }
        .connect-section { animation: fadeInUp 0.8s ease-out 0.6s both; }

        /* CSS Color Mix (where supported) */
        @supports (color: color-mix(in srgb, white, black)) {
            .skill-tag {
                background: color-mix(in srgb, #4facfe 20%, transparent);
            }
        }

        /* Modern scrollbar */
        ::-webkit-scrollbar {
            width: 8px;
        }

        ::-webkit-scrollbar-track {
            background: rgba(255, 255, 255, 0.05);
        }

        ::-webkit-scrollbar-thumb {
            background: linear-gradient(180deg, #4facfe, #00f2fe);
            border-radius: 4px;
        }
    </style>

<div class="intro-container">
    <section class="intro-hero">
        <!-- <h1>Hi, I'm Samson</h1> -->
        <div class="typing-effect">DevOps | OSCP | CEH</div>
    </section>
    <section class="intro-content">
        <!-- <h2>What do I do?</h2> -->
        <p>I create scalable, high-performance systems that power products, accelerate teams, and enable growth. From APIs and microservices to distributed architectures, I combine Cybersecurity and DevOps expertise to drive automation, reliability, and cloud-ready infrastructure.</p>
    </section>
    <!-- Skills Section -->
    <!-- <section class="skills-grid">
        <h3>Expertise</h3>
        <div class="skills-list">
            <span class="skill-tag">DevOps</span>
            <span class="skill-tag">Cloud Architecture</span>
            <span class="skill-tag">Cybersecurity</span>
            <span class="skill-tag">OSCP</span>
            <span class="skill-tag">CEH</span>
            <span class="skill-tag">Kubernetes</span>
            <span class="skill-tag">AWS</span>
            <span class="skill-tag">CI/CD</span>
            <span class="skill-tag">Automation</span>
            <span class="skill-tag">Microservices</span>
        </div>
    </section> -->
</div>
