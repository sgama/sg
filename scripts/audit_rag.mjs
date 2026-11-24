import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { z } from 'zod';
import { buildCorpus } from './lib/corpus.mjs';
import { scoreEvidence } from './lib/evaluation/scoring.mjs';
import { runIfMain } from './lib/cli.mjs';

const nonBlank = z.string().refine((value) => value.trim().length > 0);
const Config = z.object({
    version: z.literal(1),
    sources: z.record(z.string(), z.any()),
    documents: z.record(z.string(), z.any()),
    questions: z.array(z.any()),
});
const Prompts = z.array(nonBlank).min(1);
const Question = z.object({
    query: z.string(),
    sources: z.array(z.string()).min(1),
    evidenceTerms: z.array(z.array(nonBlank).min(1)).min(1),
});

/** @typedef {z.infer<typeof Config> & { reviewed: string }} AuditConfig */
/** @typedef {{ errors: string[], warnings: string[] }} Findings */
/** @typedef {Awaited<ReturnType<typeof buildCorpus>>} Corpus */
/** @typedef {(name: string) => string} SafePath */

/**
 * Maps a configured source name to a file under `root`, refusing anything outside content/.
 * @param {string} root
 * @returns {SafePath}
 */
const sourcePathIn = (root) => (name) => {
    if (
        typeof name !== 'string' ||
        !name.startsWith('content/') ||
        name.includes('\\') ||
        name.split('/').some((part) => part === '..' || part === '.' || !part)
    ) {
        throw new Error(`Invalid RAG source path: ${name}`);
    }
    return path.join(root, name);
};

/**
 * @param {string} reviewed
 * @param {Date} now
 * @param {Findings} findings
 */
function checkReviewed(reviewed, now, { errors, warnings }) {
    const date = new Date(`${reviewed}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(reviewed) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== reviewed || date > now) {
        errors.push('Invalid reviewed date');
    } else if (now.getTime() - date.getTime() > 90 * 86400000) {
        warnings.push('Provenance review is older than 90 days');
    }
}

/**
 * Compares every canonical source with the hash the corpus build already computed; returns the ones that changed.
 * @param {Record<string, string>} sources
 * @param {Corpus} corpus
 * @param {SafePath} safePath
 * @param {Findings} findings
 */
function checkSourceHashes(sources, corpus, safePath, { errors }) {
    const current = new Map(corpus.sources.map((entry) => [entry.source, entry.hash]));
    /** @type {Set<string>} */
    const changed = new Set();
    for (const [source, hash] of Object.entries(sources)) {
        safePath(source);
        if (!/^[a-f0-9]{64}$/.test(hash)) errors.push(`Invalid source hash: ${source}`);
        if (!current.has(source)) errors.push(`Missing canonical source: ${source}`);
        else if (current.get(source) !== hash) changed.add(source);
    }
    return changed;
}

/**
 * @param {string} source
 * @param {unknown} dependencies
 * @param {{ sources: Record<string, unknown>, changed: Set<string>, safePath: SafePath }} context
 * @param {Findings} findings
 */
function checkDependencies(source, dependencies, { sources, changed, safePath }, { errors, warnings }) {
    if (!dependencies) return warnings.push(`Missing provenance mapping: ${source}`);
    if (!Array.isArray(dependencies) || !dependencies.length) return errors.push(`Invalid provenance mapping: ${source}`);
    for (const dependency of dependencies) {
        safePath(dependency);
        if (!Object.hasOwn(sources, dependency)) errors.push(`Untracked canonical source: ${dependency}`);
        if (changed.has(dependency)) warnings.push(`Source changed; review ${source}: ${dependency}`);
    }
}

/**
 * Audits each internal context document: title, provenance mapping and unfinished "FILL IN" gaps.
 * @param {AuditConfig} config
 * @param {Corpus} corpus
 * @param {Set<string>} changed
 * @param {SafePath} safePath
 * @param {Findings} findings
 */
async function checkContextDocuments(config, corpus, changed, safePath, findings) {
    /** @type {{ source: string, authoringGaps: number, dependencies: string[] }[]} */
    const documents = [];
    const contextSources = corpus.sources
        .map((item) => item.source)
        .filter((source) => source.startsWith('content/_context/') && !source.endsWith('/_index.md'));
    for (const source of contextSources) {
        const raw = await fs.readFile(safePath(source), 'utf8');
        const dependencies = config.documents[source];
        checkDependencies(source, dependencies, { sources: config.sources, changed, safePath }, findings);
        if (!nonBlank.safeParse(matter(raw).data.title).success) findings.errors.push(`Missing context title: ${source}`);
        const gaps = [...raw.matchAll(/<!--[\s\S]*?FILL IN:[\s\S]*?-->/g)].length;
        if (gaps) findings.warnings.push(`Authoring gaps (${gaps}): ${source}`);
        documents.push({ source, authoringGaps: gaps, dependencies: dependencies ?? [] });
    }
    for (const source of Object.keys(config.documents)) {
        safePath(source);
        if (!documents.some((item) => item.source === source)) findings.errors.push(`Missing mapped context document: ${source}`);
    }
    return documents;
}

/**
 * @param {AuditConfig['questions']} questions
 * @param {string[]} prompts
 * @param {Corpus} corpus
 * @param {SafePath} safePath
 * @param {Findings} findings
 */
function checkQuestions(questions, prompts, corpus, safePath, { errors, warnings }) {
    const seen = new Set();
    for (const item of questions) {
        if (!Question.safeParse(item).success || seen.has(item.query)) throw new Error('Malformed question coverage mapping');
        seen.add(item.query);
        for (const source of item.sources) {
            safePath(source);
            if (!corpus.sources.some((entry) => entry.source === source)) errors.push(`Missing question source: ${source}`);
        }
        if (!prompts.includes(item.query)) warnings.push(`Coverage mapping is not a UI prompt: ${item.query}`);
    }
}

/**
 * How well the indexed sources cover each question the UI suggests.
 * @param {string[]} prompts
 * @param {z.infer<typeof Question>[]} questions
 * @param {Corpus} corpus
 */
function coverageOf(prompts, questions, corpus) {
    return prompts.map((query) => {
        const item = questions.find((entry) => entry.query === query);
        if (!item) return { query, status: 'unmapped' };
        const text = corpus.chunks
            .filter((chunk) => item.sources.includes(chunk.metadata.source))
            .map((chunk) => chunk.text)
            .join('\n');
        return {
            query,
            sources: item.sources,
            status: scoreEvidence(text, item) ? 'documented' : 'partial',
            missingEvidence: item.evidenceTerms.filter((group) => !group.some((term) => text.toLowerCase().includes(term.toLowerCase()))),
        };
    });
}

/** @param {{ root?: string, now?: Date }} [options] */
export async function auditRag({ root = process.cwd(), now = new Date() } = {}) {
    const rawConfig = JSON.parse(await fs.readFile(path.join(root, 'data/rag_audit.json'), 'utf8'));
    const rawPrompts = matter(`---\n${await fs.readFile(path.join(root, 'data/prompts.yml'), 'utf8')}\n---`).data.prompts;
    const parsed = Config.safeParse(rawConfig);
    const prompts = Prompts.safeParse(rawPrompts);
    if (!parsed.success || !prompts.success || new Set(prompts.data).size !== prompts.data.length) {
        throw new Error('Malformed RAG audit configuration or prompts');
    }
    /** @type {AuditConfig} */
    const config = { ...rawConfig, ...parsed.data };
    const safePath = sourcePathIn(root);
    /** @type {Findings} */
    const findings = { errors: [], warnings: [] };
    checkReviewed(config.reviewed, now, findings);
    const corpus = await buildCorpus({ root });
    const changed = checkSourceHashes(config.sources, corpus, safePath, findings);
    const documents = await checkContextDocuments(config, corpus, changed, safePath, findings);
    checkQuestions(config.questions, prompts.data, corpus, safePath, findings);
    const coverage = coverageOf(prompts.data, config.questions, corpus);
    for (const item of coverage.filter((entry) => entry.status !== 'documented')) findings.warnings.push(`Question ${item.status}: ${item.query}`);
    return {
        version: 1,
        timestamp: now.toISOString(),
        corpusHash: corpus.hash,
        totals: {
            documents: documents.length,
            questions: coverage.length,
            documented: coverage.filter((item) => item.status === 'documented').length,
            authoringGaps: documents.reduce((sum, item) => sum + item.authoringGaps, 0),
            errors: findings.errors.length,
            warnings: findings.warnings.length,
        },
        changedSources: [...changed],
        coverage,
        documents,
        errors: findings.errors,
        warnings: findings.warnings,
    };
}

export async function main() {
    const report = await auditRag();
    const output = path.join(process.env.REPORT_DIR || 'reports', 'rag-audit.json');
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify(report.totals, null, 2));
    for (const warning of report.warnings) console.warn(`RAG audit warning: ${warning}`);
    console.log(`Report: ${output}`);
    if (report.errors.length) throw new Error(report.errors.join('; '));
}

runIfMain(import.meta.url, main, 'RAG audit failed');
