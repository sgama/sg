#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { globSync } = require("glob");

const repoRoot = process.cwd();
const reportDir = process.env.REPORT_DIR || path.join(repoRoot, "reports");
const allowBroken = (process.env.ALLOW_BROKEN_LINKS || "0") === "1";

function ensureDir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
}

function normalizeTarget(target) {
    let normalized = target.trim();
    if (normalized.startsWith("<") && normalized.endsWith(">")) {
        normalized = normalized.slice(1, -1);
    }
    normalized = normalized.split("#")[0];
    normalized = normalized.split("?")[0];
    return decodeURIComponent(normalized);
}

function shouldSkip(target) {
    if (!target) {
        return true;
    }
    const lower = target.toLowerCase();
    if (
        lower.startsWith("http://") ||
        lower.startsWith("https://") ||
        lower.startsWith("mailto:") ||
        lower.startsWith("tel:") ||
        lower.startsWith("javascript:") ||
        lower.startsWith("data:") ||
        lower.startsWith("#") ||
        lower.startsWith("//")
    ) {
        return true;
    }
    if (target.includes("{{") || target.includes("}}")) {
        return true;
    }
    return false;
}

function resolveCandidates(baseDir, target) {
    const candidates = [];
    const resolved = path.resolve(baseDir, target);
    candidates.push(resolved);

    if (!path.extname(resolved)) {
        candidates.push(`${resolved}.md`);
        candidates.push(path.join(resolved, "index.md"));
        candidates.push(path.join(resolved, "_index.md"));
    }

    return candidates;
}

const contentFiles = globSync("content/**/*.md", { nodir: true });
const linkRegex = /!?\[[^\]]*\]\(([^)]+)\)/g;

const brokenLinks = [];

for (const filePath of contentFiles) {
    const raw = fs.readFileSync(filePath, "utf8");
    const baseDir = path.dirname(filePath);
    const matches = raw.matchAll(linkRegex);

    for (const match of matches) {
        const targetRaw = match[1] || "";
        if (shouldSkip(targetRaw)) {
            continue;
        }

        if (targetRaw.startsWith("/")) {
            continue;
        }

        const target = normalizeTarget(targetRaw);
        const candidates = resolveCandidates(baseDir, target);
        const exists = candidates.some((candidate) => fs.existsSync(candidate));

        if (!exists) {
            const lineNumber = raw.slice(0, match.index).split("\n").length;
            brokenLinks.push({
                file: path.relative(repoRoot, filePath),
                line: lineNumber,
                target: targetRaw,
            });
        }
    }
}

ensureDir(reportDir);
const jsonPath = path.join(reportDir, "link_check.json");
const markdownPath = path.join(reportDir, "link_check.md");

const report = {
    totals: {
        files: contentFiles.length,
        broken: brokenLinks.length,
    },
    broken: brokenLinks,
};

fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));

const markdownLines = [
    "## Link Check Report",
    "",
    `- Files scanned: ${contentFiles.length}`,
    `- Broken links: ${brokenLinks.length}`,
    "",
];

if (brokenLinks.length === 0) {
    markdownLines.push("No broken relative links found.");
} else {
    brokenLinks.forEach((item) => {
        markdownLines.push(`- ${item.file}:${item.line} ${item.target}`);
    });
}

fs.writeFileSync(markdownPath, `${markdownLines.join("\n")}\n`);

if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdownLines.join("\n")}\n`);
}

if (brokenLinks.length > 0 && !allowBroken) {
    console.error(`Found ${brokenLinks.length} broken links.`);
    process.exit(1);
}
