# samsongama.com

A modern, responsive personal website built with [Hugo](https://gohugo.io/) and the [Blowfish](https://blowfish.page/) theme. This repository contains the source code for my personal website featuring blog posts, portfolio projects, and resume.

## 🚀 Quick Start

### Prerequisites

- [Hugo](https://gohugo.io/installation/) (Extended version recommended)
- [Go](https://golang.org/doc/install) 1.25.1 or later
- [Git](https://git-scm.com/)
- [Pre-commit](https://pre-commit.com/) (optional but recommended)

### Local Development

1. **Clone the repository**

   ```bash
   git clone https://github.com/sgama/sg.git
   cd sg
   ```

2. **Initialize submodules** (for the Blowfish theme)

   ```bash
   make init
   ```

3. **Start the development server**

   ```bash
   make serve
   ```

4. **Visit your site**
   Open [http://localhost:1313](http://localhost:1313) in your browser

## 🛠️ Available Commands

Use the Makefile for common development tasks:

| Command | Description |
|---------|-------------|
| `make help` | Show all available commands |
| `make init` | Initialize git submodules |
| `make update` | Update git submodules to latest |
| `make serve` | Start Hugo development server |
| `make build` | Build the static site for production |
| `make clean` | Remove generated files |
| `make deploy` | Build and deploy (customize as needed) |
| `make pre-commit` | Run all pre-commit hooks manually |

## 📁 Project Structure

```md
sg/
├── archetypes/          # Content templates
├── assets/              # Site assets (images, CSS, JS)
├── config/              # Hugo configuration files
│   └── _default/        # Default site configuration
├── content/             # Markdown content files
│   ├── post/           # Blog posts
│   ├── posts/          # Portfolio projects
│   ├── about.md        # About page
│   └── resume.md       # Resume page
├── layouts/             # Custom Hugo templates
│   ├── partials/       # Reusable template components
│   └── shortcodes/     # Custom Hugo shortcodes
├── public/              # Generated static site (git-ignored)
├── resources/           # Hugo processed resources
├── static/              # Static files (copied as-is)
├── go.mod              # Go module dependencies
├── Makefile            # Development commands
└── .pre-commit-config.yaml # Code quality configuration
```

## 🎨 Theme Configuration

This site uses the [Blowfish theme](https://blowfish.page/) with extensive customization:

### Key Features

- **Dark/Light mode** with Catppuccin color scheme
- **Hero background** layout with custom imagery
- **Card-based** post and project listings
- **Search functionality** enabled
- **Table of contents** for articles
- **Reading time** and word count
- **Social media links** integration

### Customization Files

- `config/_default/params.toml` - Theme parameters and styling
- `config/_default/hugo.toml` - Core Hugo configuration
- `config/_default/menus.en.toml` - Navigation menus
- `assets/css/custom.css` - Custom CSS overrides

## ✅ Code Quality & CI/CD

This repository includes comprehensive code quality tools:

### Pre-commit Hooks

The project uses [pre-commit](https://pre-commit.com/) for automated code quality checks:

- **File validation**: Large files, merge conflicts, YAML/TOML syntax
- **Formatting**: YAML, TOML, and Markdown formatting
- **HTML validation**: Template syntax and accessibility checks
- **Hugo-specific**: Build tests, front matter validation, image optimization
- **Go module checks**: Dependency management and security scanning
- **Spell checking**: Automated typo detection

### Setup Pre-commit

```bash
# Install pre-commit
pip install pre-commit

# Install hooks
pre-commit install

# Run all hooks manually
make pre-commit
```

### HTML Template Validation

The project includes HTML validation for Hugo templates using djLint:

- Validates template syntax
- Ensures accessibility compliance (alt tags, proper attributes)
- Maintains consistent formatting

### Go Module Management

Automated checks for:

- `go mod tidy` - Clean dependency management
- `go mod verify` - Cryptographic hash verification
- Security vulnerability scanning with `govulncheck`

## 📝 Content Management

### Adding Blog Posts

1. Create a new markdown file in `content/post/`
2. Use the archetype template: `hugo new post/my-new-post.md`
3. Add required front matter (date, title, tags, etc.)

### Adding Portfolio Projects

1. Create a new directory in `content/posts/YYYY-MM-DD-project-name/`
2. Add `index.md` with project details
3. Include project images and assets in the same directory

### Front Matter Example

```yaml
---
title: "My New Post"
date: 2024-01-01
tags: ["technology", "hugo"]
categories: ["blog"]
draft: false
summary: "A brief description of the post"
---
```

## 🚀 Deployment

### Build for Production

```bash
make build
```

This generates the static site in the `public/` directory.

### Deployment Options

- **GitHub Pages**: Configure repository settings for Pages deployment
- **Netlify**: Connect repository for automatic deployments
- **Vercel**: Import repository for serverless deployment
- **Traditional hosting**: Upload `public/` directory contents

## 🔧 Development Tips

### Local Testing

- Use `make serve` for development with hot reloading
- Test builds with `make build` before deployment
- Run `make pre-commit` to catch issues early

### Content Organization

- Use consistent date-based naming for posts
- Optimize images before adding to `assets/` or `static/`
- Keep image files under 1MB (enforced by pre-commit)

### Theme Updates

```bash
# Update the Blowfish theme
make update

# Check for theme-breaking changes
hugo server
```

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run `make pre-commit` to ensure code quality
5. Submit a pull request

## 📄 License

This project is licensed under the terms specified in the [LICENSE](LICENSE) file.

## 🔗 Links

- **Live site**: [samsongama.com](https://samsongama.com)
- **Hugo documentation**: [gohugo.io/documentation](https://gohugo.io/documentation/)
- **Blowfish theme**: [blowfish.page](https://blowfish.page/)
- **Repository**: [github.com/sgama/sg](https://github.com/sgama/sg)

---
