import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import { buildCorpus } from './lib/corpus.mjs';
import { scoreEvidence } from './lib/ai-evaluation.mjs';

export async function auditRag({ root = process.cwd(), now = new Date() } = {}) {
    const config = JSON.parse(await fs.readFile(path.join(root, 'data/rag_audit.json'), 'utf8'));
    const prompts = matter(`---\n${await fs.readFile(path.join(root, 'data/prompts.yml'), 'utf8')}\n---`).data.prompts;
    const errors = [];
    const warnings = [];
    if (
        config.version !== 1 ||
        !config.sources ||
        !config.documents ||
        !Array.isArray(config.questions) ||
        !Array.isArray(prompts) ||
        !prompts.length ||
        prompts.some((query) => typeof query !== 'string' || !query.trim()) ||
        new Set(prompts).size !== prompts.length
    )
        throw new Error('Malformed RAG audit configuration or prompts');
    const safePath = (name) => {
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
    const date = new Date(`${config.reviewed}T00:00:00Z`);
    if (
        !/^\d{4}-\d{2}-\d{2}$/.test(config.reviewed) ||
        !Number.isFinite(date.getTime()) ||
        date.toISOString().slice(0, 10) !== config.reviewed ||
        date > now
    )
        errors.push('Invalid reviewed date');
    else if (now - date > 90 * 86400000) warnings.push('Provenance review is older than 90 days');
    const changed = new Set();
    for (const [source, hash] of Object.entries(config.sources)) {
        const target = safePath(source);
        if (!/^[a-f0-9]{64}$/.test(hash)) errors.push(`Invalid source hash: ${source}`);
        try {
            const raw = await fs.readFile(target);
            if (createHash('sha256').update(raw).digest('hex') !== hash) changed.add(source);
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            errors.push(`Missing canonical source: ${source}`);
        }
    }
    const corpus = await buildCorpus({ root });
    const documents = [];
    for (const source of corpus.sources
        .filter((item) => item.source.startsWith('content/_context/') && !item.source.endsWith('/_index.md'))
        .map((item) => item.source)) {
        const raw = await fs.readFile(safePath(source), 'utf8');
        const data = matter(raw).data;
        const dependencies = config.documents[source];
        if (!dependencies) warnings.push(`Missing provenance mapping: ${source}`);
        else if (!Array.isArray(dependencies) || !dependencies.length) errors.push(`Invalid provenance mapping: ${source}`);
        else
            for (const dependency of dependencies) {
                safePath(dependency);
                if (!Object.hasOwn(config.sources, dependency)) errors.push(`Untracked canonical source: ${dependency}`);
                if (changed.has(dependency)) warnings.push(`Source changed; review ${source}: ${dependency}`);
            }
        if (typeof data.title !== 'string' || !data.title.trim()) errors.push(`Missing context title: ${source}`);
        const gaps = [...raw.matchAll(/<!--[\s\S]*?FILL IN:[\s\S]*?-->/g)].length;
        if (gaps) warnings.push(`Authoring gaps (${gaps}): ${source}`);
        documents.push({ source, authoringGaps: gaps, dependencies: dependencies ?? [] });
    }
    for (const source of Object.keys(config.documents)) {
        safePath(source);
        if (!documents.some((item) => item.source === source)) errors.push(`Missing mapped context document: ${source}`);
    }
    const seen = new Set();
    for (const item of config.questions) {
        if (
            typeof item.query !== 'string' ||
            seen.has(item.query) ||
            !Array.isArray(item.sources) ||
            !item.sources.length ||
            !Array.isArray(item.evidenceTerms) ||
            !item.evidenceTerms.length ||
            item.evidenceTerms.some(
                (group) => !Array.isArray(group) || !group.length || group.some((term) => typeof term !== 'string' || !term.trim()),
            )
        ) {
            throw new Error('Malformed question coverage mapping');
        }
        seen.add(item.query);
        for (const source of item.sources) {
            safePath(source);
            if (!corpus.sources.some((entry) => entry.source === source)) errors.push(`Missing question source: ${source}`);
        }
        if (!prompts.includes(item.query)) warnings.push(`Coverage mapping is not a UI prompt: ${item.query}`);
    }
    const coverage = prompts.map((query) => {
        const item = config.questions.find((item) => item.query === query);
        if (!item) return { query, status: 'unmapped' };
        const chunks = corpus.chunks.filter((chunk) => item.sources.includes(chunk.metadata.source));
        const text = chunks.map((chunk) => chunk.text).join('\n');
        return {
            query,
            sources: item.sources,
            status: scoreEvidence(text, item) ? 'documented' : 'partial',
            missingEvidence: item.evidenceTerms.filter((group) => !group.some((term) => text.toLowerCase().includes(term.toLowerCase()))),
        };
    });
    for (const item of coverage.filter((item) => item.status !== 'documented')) warnings.push(`Question ${item.status}: ${item.query}`);
    return {
        version: 1,
        timestamp: now.toISOString(),
        corpusHash: corpus.hash,
        totals: {
            documents: documents.length,
            questions: coverage.length,
            documented: coverage.filter((item) => item.status === 'documented').length,
            authoringGaps: documents.reduce((sum, item) => sum + item.authoringGaps, 0),
            errors: errors.length,
            warnings: warnings.length,
        },
        changedSources: [...changed],
        coverage,
        documents,
        errors,
        warnings,
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(`RAG audit failed: ${error.message}`);
        process.exitCode = 1;
    });
}
