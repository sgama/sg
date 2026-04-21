#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const matter = require("gray-matter");
const { globSync } = require("glob");

const repoRoot = process.cwd();
const reportDir = process.env.REPORT_DIR || path.join(repoRoot, "reports");
const requiredFields = (process.env.CONTENT_REQUIRED_FIELDS || "title,date")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
const recommendedFieldsRaw = (process.env.CONTENT_RECOMMENDED_FIELDS || "tags,description|summary")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
const requiredMin = Number.parseFloat(process.env.CONTENT_REQUIRED_MIN || "1.0");
const recommendedMin = Number.parseFloat(process.env.CONTENT_RECOMMENDED_MIN || "0.8");

const recommendedGroups = recommendedFieldsRaw.map((entry) => entry.split("|").map((value) => value.trim()));

function isValuePresent(value) {
    if (value === null || value === undefined) {
        return false;
    }
    if (Array.isArray(value)) {
        return value.length > 0;
    }
    if (typeof value === "string") {
        return value.trim().length > 0;
    }
    return true;
}

function groupSatisfied(data, group) {
    return group.some((field) => isValuePresent(data[field]));
}

function ensureDir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
}

function formatPercent(value) {
    return `${(value * 100).toFixed(1)}%`;
}

const contentFiles = globSync("content/**/*.md", {
    nodir: true,
    ignore: ["**/_index.md"],
});

const results = contentFiles.map((filePath) => {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = matter(raw);
    const data = parsed.data || {};
    const missingRequired = requiredFields.filter((field) => !isValuePresent(data[field]));
    const missingRecommended = recommendedGroups
        .filter((group) => !groupSatisfied(data, group))
        .map((group) => group.join("|"));

    return {
        file: path.relative(repoRoot, filePath),
        missingRequired,
        missingRecommended,
    };
});

const totalFiles = results.length;
const requiredTotal = totalFiles * requiredFields.length;
const recommendedTotal = totalFiles * recommendedGroups.length;
const requiredMissing = results.reduce((sum, item) => sum + item.missingRequired.length, 0);
const recommendedMissing = results.reduce((sum, item) => sum + item.missingRecommended.length, 0);
const requiredCoverage = requiredTotal === 0 ? 1 : (requiredTotal - requiredMissing) / requiredTotal;
const recommendedCoverage = recommendedTotal === 0 ? 1 : (recommendedTotal - recommendedMissing) / recommendedTotal;

const report = {
    totals: {
        files: totalFiles,
        requiredFields,
        recommendedFields: recommendedGroups.map((group) => group.join("|")),
        requiredCoverage,
        recommendedCoverage,
        requiredMissing,
        recommendedMissing,
    },
    missing: results.filter((item) => item.missingRequired.length > 0 || item.missingRecommended.length > 0),
};

ensureDir(reportDir);
const jsonPath = path.join(reportDir, "content_audit.json");
const markdownPath = path.join(reportDir, "content_audit.md");

fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));

const markdownLines = [
    "## Content Coverage Report",
    "",
    `- Files scanned: ${totalFiles}`,
    `- Required coverage: ${formatPercent(requiredCoverage)} (min ${formatPercent(requiredMin)})`,
    `- Recommended coverage: ${formatPercent(recommendedCoverage)} (min ${formatPercent(recommendedMin)})`,
    "",
    "### Missing Fields",
    "",
];

if (report.missing.length === 0) {
    markdownLines.push("All content meets required and recommended fields.");
} else {
    report.missing.forEach((item) => {
        const missingParts = [];
        if (item.missingRequired.length > 0) {
            missingParts.push(`required: ${item.missingRequired.join(", ")}`);
        }
        if (item.missingRecommended.length > 0) {
            missingParts.push(`recommended: ${item.missingRecommended.join(", ")}`);
        }
        markdownLines.push(`- ${item.file} (${missingParts.join("; ")})`);
    });
}

fs.writeFileSync(markdownPath, `${markdownLines.join("\n")}\n`);

if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdownLines.join("\n")}\n`);
}

const failures = [];
if (requiredCoverage < requiredMin) {
    failures.push(`Required coverage ${formatPercent(requiredCoverage)} below ${formatPercent(requiredMin)}`);
}
if (recommendedCoverage < recommendedMin) {
    failures.push(`Recommended coverage ${formatPercent(recommendedCoverage)} below ${formatPercent(recommendedMin)}`);
}

if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exit(1);
}
