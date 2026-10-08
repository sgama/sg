import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { glob } from 'glob';

const root = fileURLToPath(new URL('../../', import.meta.url));
const exec = promisify(execFile);
const title = 'Layout "quotes" & </script> check';
const buildSha = '0123456789abcdef0123456789abcdef01234567';

function tags(html, name) {
    return [...html.matchAll(new RegExp(`<${name}\\b(?:[^>"']|"[^"]*"|'[^']*')*>`, 'g'))].map((match) => {
        const attributes = {};
        for (const attr of match[0].matchAll(/([\w-]+)=(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
            attributes[attr[1]] = attr[2] ?? attr[3] ?? attr[4];
        }
        return attributes;
    });
}

function schema(html) {
    return [...html.matchAll(/<script type=["']?application\/ld\+json["']?>(.*?)<\/script>/gs)].flatMap((match) => JSON.parse(match[1]));
}

function assertImagePreloads(html) {
    const preloads = tags(html, 'link').filter((tag) => tag.rel === 'preload' && tag.as === 'image');
    const expected = [];
    for (const image of tags(html, 'img').filter((tag) => tag.id === 'background-image' || tag.class?.includes('intro__avatar'))) {
        const picture = [...html.matchAll(/<picture>(.*?)<\/picture>/gs)].find((match) => tags(match[1], 'img').some((tag) => tag.src === image.src));
        const firstSource = picture && tags(picture[1], 'source')[0];
        expected.push({ href: firstSource ? firstSource.srcset : image.src, type: firstSource?.type });
    }
    assert.equal(preloads.length, expected.length);
    for (const image of expected) {
        const preload = preloads.find((tag) => tag.href === image.href);
        assert.ok(preload, `Missing preload for rendered image ${image.href}`);
        if (image.type) assert.equal(preload.type, image.type);
    }
}

test('generated layouts preserve structured types, public indexes, image selection and theme head settings', async (t) => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'sg-layouts-'));
    t.after(() => rm(temp, { recursive: true, force: true }));
    const content = path.join(temp, 'content');
    const assets = path.join(temp, 'assets');
    await cp(path.join(root, 'content'), content, { recursive: true });
    await cp(path.join(root, 'assets'), assets, { recursive: true });
    await mkdir(path.join(content, 'posts/layout-regression'), { recursive: true });
    await writeFile(
        path.join(content, 'posts/layout-regression/index.md'),
        JSON.stringify({
            title,
            date: '2020-01-01',
            description: 'Description <em>preferred</em>',
            summary: 'Summary fallback',
            tags: ['layout-check'],
            showReadingProgress: false,
        }) + '\n\nRegression article.\n',
    );
    await writeFile(
        path.join(assets, 'layout-test.svg'),
        '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="blue"/></svg>',
    );
    await cp(path.join(root, 'content/posts/2018-06-01-monitoring/featured.png'), path.join(assets, 'layout-test.png'));

    async function build(name, params = {}, extra = {}) {
        const config = path.join(temp, `${name}.json`);
        const destination = path.join(temp, name);
        await writeFile(config, JSON.stringify({ assetDir: assets, params, ...extra, languages: { ...extra.languages, en: { params } } }));
        const result = await exec(
            process.env.HUGO ?? 'hugo',
            ['--config', `config.toml,${config}`, '--contentDir', content, '--destination', destination, '--minify', '--panicOnWarning'],
            { cwd: root, env: { ...process.env, HUGO_BUILD_SHA: buildSha }, timeout: 90000, maxBuffer: 2 * 1024 * 1024 },
        );
        assert.doesNotMatch(result.stdout + result.stderr, /\bWARN\b|\bERROR\b/);
        return destination;
    }

    await t.test('default site emits typed JSON-LD, excludes internal context and preloads its actual WebP avatar', async () => {
        const destination = await build(
            'default',
            {},
            {
                menus: { footer: [{ name: 'About', url: '/about/' }] },
            },
        );
        const home = await readFile(path.join(destination, 'index.html'), 'utf8');
        const footer = home.match(/<footer\b[^>]*id=["']?site-footer[^>]*>(.*?)<\/footer>/s)?.[1];
        assert.ok(footer, 'Site footer must render');
        assert.ok(
            tags(footer, 'a').some(
                (tag) =>
                    tag.href === `https://github.com/sgama/sg/commit/${buildSha}` && tag['aria-label'] === `Build commit ${buildSha.slice(0, 6)}`,
            ),
            'Footer must link to the supplied build revision',
        );
        assert.match(footer, />012345<\/a>/);
        assert.ok(tags(footer, 'nav').some((tag) => tag['aria-label'] === 'Footer menu'));
        assert.equal([...home.matchAll(/<h2\b[^>]*>Recent<\/h2>/g)].length, 1, 'Homepage must render recent articles exactly once');
        const person = schema(home).find((node) => node['@type'] === 'Person');
        assert.ok(Array.isArray(person.sameAs));
        assert.ok(person.sameAs.every((url) => typeof url === 'string' && URL.canParse(url)));
        for (const file of await glob('**/*.html', { cwd: destination })) {
            for (const node of schema(await readFile(path.join(destination, file), 'utf8'))) {
                if (['Article', 'BlogPosting'].includes(node['@type'])) {
                    assert.equal(typeof node.wordCount, 'number', file);
                    if (node.copyrightYear) assert.equal(typeof node.copyrightYear, 'number', file);
                    if (node.keywords) assert.ok(Array.isArray(node.keywords), file);
                }
            }
        }
        const article = await readFile(path.join(destination, 'posts/layout-regression/index.html'), 'utf8');
        assert.equal(schema(article)[0].headline, title);
        assert.equal(schema(article)[0].wordCount, 2);
        const llms = await readFile(path.join(destination, 'llms.txt'), 'utf8');
        for (const page of ['about', 'resume', 'contact']) assert.ok(llms.includes(`https://samsongama.com/${page}/`));
        assert.match(llms, /## Recent Posts\n- \[/);
        assert.match(llms, /## Skills \/ Tags Snapshot\n\S/);
        assert.doesNotMatch(llms, /Internal Knowledge|No context found|\/_context\/|FILL IN|## Recent Posts-/);
        assert.ok(!(await glob('_context/**/*.html', { cwd: destination })).length);
        assertImagePreloads(home);
        const avatar = tags(home, 'img').find((tag) => tag.class?.includes('intro__avatar'));
        assert.equal(avatar.src, '/samson.webp');
        assert.ok(tags(home, 'link').some((tag) => tag.href === avatar.src && tag.as === 'image' && tag.type === 'image/webp'));
        assert.ok(tags(home, 'link').some((tag) => tag.rel === 'describedby' && tag.href === '/llms.txt'));
        assert.ok(tags(home, 'script').some((tag) => tag.src?.includes('/a11y.') && tag.integrity));
        assert.doesNotMatch(home, /src=["']?[^ >]*appearance/);
    });

    await t.test('PNG picture variants and preload targets agree; head settings respect page overrides', async () => {
        const destination = await build(
            'processed',
            {
                author: { image: 'layout-test.png' },
                homepage: { homepageImage: 'layout-test.png' },
                article: { showReadingProgress: true },
                seo: { metaDescriptionOrder: ['description', 'summary', 'site'] },
                enableStructuredBreadcrumbs: true,
                disableImageZoom: false,
                languageRedirect: { enabled: true },
                advertisement: { adsense: 'ca-pub-layout-test' },
            },
            { languages: { fr: { locale: 'fr', label: 'French', weight: 2 } } },
        );
        const home = await readFile(path.join(destination, 'index.html'), 'utf8');
        assertImagePreloads(home);
        assert.equal(tags(home, 'link').filter((tag) => tag.as === 'image' && tag.type === 'image/avif').length, 2);
        assert.match(home, /BlowfishLanguageRedirectConfig/);
        assert.match(home, /language-redirect\./);
        assert.doesNotMatch(home, /google-adsense-account|ca-pub-layout-test|adsbygoogle/);
        assert.ok(tags(home, 'script').some((tag) => tag.src?.includes('/medium-zoom.') && tag.integrity));
        const article = await readFile(path.join(destination, 'posts/layout-regression/index.html'), 'utf8');
        assert.doesNotMatch(article, /src=["']?[^ >]*reading-progress/);
        assert.match(article, /name=description content="Description preferred"/);
        const breadcrumbs = schema(article).find((node) => node['@type'] === 'BreadcrumbList');
        assert.equal(breadcrumbs.itemListElement.at(-1).name, title);
        assert.equal(breadcrumbs.itemListElement.at(-1).position, breadcrumbs.itemListElement.length);
        const regular = await readFile(path.join(destination, 'posts/ai-full-stack/index.html'), 'utf8');
        assert.match(regular, /reading-progress\./);
    });

    await t.test('disabled optimization keeps original images in rendering and preloads', async () => {
        const destination = await build('unoptimized', {
            disableImageOptimization: true,
            author: { image: 'layout-test.png' },
            homepage: { homepageImage: 'layout-test.png' },
        });
        const home = await readFile(path.join(destination, 'index.html'), 'utf8');
        assertImagePreloads(home);
        assert.ok(tags(home, 'img').filter((tag) => tag.src === '/layout-test.png').length >= 2, JSON.stringify(tags(home, 'img')));
        assert.ok(
            tags(home, 'link')
                .filter((tag) => tag.as === 'image')
                .every((tag) => tag.type === 'image/png'),
        );
    });

    await t.test('SVG images and URL-only backgrounds do not enter the raster pipeline', async () => {
        const destination = await build('hotlink', {
            author: { image: 'layout-test.svg' },
            defaultBackgroundImage: 'https://example.com/background.webp',
            hotlinkFeatureImage: true,
        });
        const home = await readFile(path.join(destination, 'index.html'), 'utf8');
        assertImagePreloads(home);
        assert.ok(
            tags(home, 'img').some((tag) => tag.id === 'background-image' && tag.src === 'https://example.com/background.webp'),
            JSON.stringify(tags(home, 'img')),
        );
        assert.ok(tags(home, 'link').some((tag) => tag.as === 'image' && tag.href === '/layout-test.svg' && tag.type === 'image/svg+xml'));
    });
});
