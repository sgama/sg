module.exports = {
  ci: {
    collect: {
      staticDistDir: "/app/public",
      // If you want to audit specific URLs, you can uncomment and list them, 
      // otherwise it will autoscan the staticDistDir.
      // url: ['http://localhost/index.html'],
      settings: {
        chromeFlags: "--no-sandbox --headless --disable-gpu",
      },
    },
    upload: {
      target: "filesystem",
      outputDir: "/app/results",
      reportFilenamePattern: "%%PATHNAME%%-%%DATETIME%%-report.html",
    },
    assert: {
      preset: "lighthouse:no-pwa", // Using no-pwa preset as it's a static site, adjust if needed
      assertions: {
        "categories:performance": ["warn", { minScore: 0.9 }],
        "categories:accessibility": ["warn", { minScore: 0.9 }],
        "categories:best-practices": ["warn", { minScore: 0.9 }],
        "categories:seo": ["warn", { minScore: 0.9 }],
      },
    },
  },
};
