# RedAmon Agent Dockerfile
# Python-based LangGraph agent with MCP and Neo4j integration

FROM python:3.11-slim

# Set working directory
WORKDIR /app

# Set environment variables
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    DEBIAN_FRONTEND=noninteractive

# Keep the image's bootstrap tooling inside the supported security window. The
# base Python image intentionally ships a small pip/setuptools pair, but those
# versions are part of the runtime image and are included in the CI audit.
RUN python -m pip install --no-cache-dir --upgrade "pip>=26.2.0" "setuptools>=83.0.0"

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    git \
    ripgrep \
    jq \
    make \
    gcc \
    g++ \
    libreadline-dev \
    openssh-client \
    unzip \
    wget \
    file \
    ca-certificates \
    gnupg \
    golang-go \
    clangd \
    && go version \
    && rm -rf /var/lib/apt/lists/*

# Retry helper for transient network failures
RUN printf '#!/bin/sh\nmax=5; n=0; until "$@"; do n=$((n+1)); [ $n -ge $max ] && exit 1; echo "Retry $n/$max ..."; sleep $((n*5)); done\n' \
    > /usr/local/bin/retry && chmod +x /usr/local/bin/retry

# Install Node.js 20 LTS + npm (for JS/TS projects)
# Pin the package managers; newer pnpm releases pull bundled executables for
# multiple platforms, which slows this single-platform image build.
RUN retry curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors \
        -o /tmp/nodesource.sh https://deb.nodesource.com/setup_20.x \
    && bash /tmp/nodesource.sh \
    && rm /tmp/nodesource.sh \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g --force yarn@1.22.22 pnpm@10.34.8

# Install Debian's supported Go compiler so agent builds don't depend on
# upstream archives that disappear after their supported release window.
ENV PATH="/root/go/bin:${PATH}"

# LuaLS provides semantic binding identity and rename edits for standard Lua.
# Keep it pinned and checksum verified; Luau remains on its own grammar/toolchain.
ENV REAMON_LUALS_VERSION=3.19.2 \
    REAMON_LUALS=/opt/lua-language-server/bin/lua-language-server
RUN arch="${TARGETARCH:-$(dpkg --print-architecture)}" \
    && case "$arch" in \
         amd64) asset_arch=x64; sha=93ad326b10f6c00911dd8c450fa098332dbd8f9f45d1052f5636a2d54479b947 ;; \
         arm64) asset_arch=arm64; sha=17b8e401a874440adeb649e5024c364f2bb9d15156c74a40e56d1ae9a1b2e4f2 ;; \
         *) echo "unsupported LuaLS architecture: $arch" >&2; exit 1 ;; \
       esac \
    && retry curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors \
        -o /tmp/luals.tar.gz "https://github.com/LuaLS/lua-language-server/releases/download/${REAMON_LUALS_VERSION}/lua-language-server-${REAMON_LUALS_VERSION}-linux-${asset_arch}.tar.gz" \
    && echo "${sha}  /tmp/luals.tar.gz" | sha256sum -c - \
    && mkdir -p /opt/lua-language-server \
    && tar -xzf /tmp/luals.tar.gz -C /opt/lua-language-server \
    && rm /tmp/luals.tar.gz \
    && test -x /opt/lua-language-server/bin/lua-language-server \
    && mkdir -p /usr/share/licenses/lua-language-server \
    && retry curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors \
        -o /usr/share/licenses/lua-language-server/LICENSE https://raw.githubusercontent.com/LuaLS/lua-language-server/3.19.2/LICENSE \
    && echo "a0a65ffcdc8620548598ce8ac5ce1a7ec36edf3034a5df2d6593e49fcececa64  /usr/share/licenses/lua-language-server/LICENSE" | sha256sum -c -

# rust-analyzer supplies semantic local references and rename edits for Rust.
# Use the official dated release and verify the architecture-specific asset.
ENV REAMON_RUST_ANALYZER_VERSION=2026-10-12 \
    REAMON_RUST_ANALYZER=/usr/local/bin/rust-analyzer
RUN arch="${TARGETARCH:-$(dpkg --print-architecture)}" \
    && case "$arch" in \
         amd64) asset_arch=x86_64; sha=040cab4e2abc490fadd95c3f6cbc60b941a78761dbc3acf0ec66fd7a97f31db3 ;; \
         arm64) asset_arch=aarch64; sha=d7219d5d8f5537bb227b521157aebddfe7e4a90f4a85a74f31e53722f5691025 ;; \
         *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
       esac \
    && retry curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors \
        -o /tmp/rust-analyzer.gz "https://github.com/rust-lang/rust-analyzer/releases/download/${REAMON_RUST_ANALYZER_VERSION}/rust-analyzer-${asset_arch}-unknown-linux-gnu.gz" \
    && echo "${sha}  /tmp/rust-analyzer.gz" | sha256sum -c - \
    && gzip -dc /tmp/rust-analyzer.gz > "$REAMON_RUST_ANALYZER" \
    && chmod 0555 "$REAMON_RUST_ANALYZER" \
    && rm /tmp/rust-analyzer.gz \
    && mkdir -p /usr/share/licenses/rust-analyzer \
    && retry curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors \
        -o /usr/share/licenses/rust-analyzer/LICENSE-APACHE "https://raw.githubusercontent.com/rust-lang/rust-analyzer/${REAMON_RUST_ANALYZER_VERSION}/LICENSE-APACHE" \
    && retry curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors \
        -o /usr/share/licenses/rust-analyzer/LICENSE-MIT "https://raw.githubusercontent.com/rust-lang/rust-analyzer/${REAMON_RUST_ANALYZER_VERSION}/LICENSE-MIT" \
    && "$REAMON_RUST_ANALYZER" --version

# Pin official PUC-Lua compiler releases for exact-dialect syntax-only checks.
# Each version gets its own binary so REAmon never validates recovered code
# against a different Lua grammar by accident.
RUN set -eu; \
    build_luac() { \
      version="$1"; sha256="$2"; \
      curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors \
        -o "/tmp/lua-${version}.tar.gz" "https://www.lua.org/ftp/lua-${version}.tar.gz"; \
      echo "${sha256}  /tmp/lua-${version}.tar.gz" | sha256sum -c -; \
      mkdir -p "/tmp/lua-${version}"; \
      tar -xzf "/tmp/lua-${version}.tar.gz" -C "/tmp/lua-${version}" --strip-components=1; \
      make -C "/tmp/lua-${version}" linux; \
      install -m 0755 "/tmp/lua-${version}/src/luac" "/usr/local/bin/luac${version%.*}"; \
      rm -rf "/tmp/lua-${version}" "/tmp/lua-${version}.tar.gz"; \
    }; \
    build_luac 5.1.5 2640fc56a795f29d28ef15e13c34a47e223960b0240e8cb0a82d9b0738695333; \
    build_luac 5.2.4 b9e2e4aad6789b3b63a056d442f7b39f0ecfca3ae0f1fc0ae4e9614401b69f4b; \
    build_luac 5.3.6 fc5fd69bb8736323f026672b1b7235da613d7177e72558893a0bdcd320466d60; \
    build_luac 5.4.9 2335b6c582a52654f94612bf10d2f4672805d05329aa6568b1d8cd9e5c6fb8e6; \
    build_luac 5.5.1 1c4b4068d67061f2a2231ad2b5422e77acea1487ea9890f6320af614f4373dce

# Pin the official Luau compiler for syntax-only validation of recovered Luau.
# The upstream Ubuntu release asset is x86_64; other architectures retain the
# Tree-sitter fallback in the REAmon validation endpoint.
ENV REAMON_LUAU_COMPILER_VERSION=0.742
RUN if [ "${TARGETARCH:-amd64}" = "amd64" ]; then \
      retry curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors \
        -o /tmp/luau-ubuntu.zip https://github.com/luau-lang/luau/releases/download/0.742/luau-ubuntu.zip \
      && echo "152058b98c60ff1f5b5ec9bca0b8eb37793cae161dd3a05608cc3d8738ba1a4d  /tmp/luau-ubuntu.zip" | sha256sum -c - \
      && mkdir -p /tmp/luau-release \
      && unzip -q /tmp/luau-ubuntu.zip -d /tmp/luau-release \
      && install -m 0755 /tmp/luau-release/luau-compile /usr/local/bin/luau-compile \
      && rm -rf /tmp/luau-ubuntu.zip /tmp/luau-release; \
    fi

# The upstream Luau LSP supplies semantic local references and rename edits.
# Pin architecture-specific release archives and verify both before installation.
ENV REAMON_LUAU_LSP_VERSION=1.70.1 \
    REAMON_LUAU_LSP=/usr/local/bin/luau-lsp
RUN arch="${TARGETARCH:-$(dpkg --print-architecture)}" \
    && case "$arch" in \
         amd64) asset_arch=x86_64; sha=1a2ea1ae4f98f8946cefd970a4b54853e11ab4775e6932faa7f60cf920346567 ;; \
         arm64) asset_arch=arm64; sha=6062345b95124ca937b8c324b74bc3fddb1d6919ba133c58f8b17945ce1acbc2 ;; \
         *) echo "unsupported Luau LSP architecture: $arch" >&2; exit 1 ;; \
       esac \
    && retry curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors \
        -o /tmp/luau-lsp.zip "https://github.com/JohnnyMorganz/luau-lsp/releases/download/${REAMON_LUAU_LSP_VERSION}/luau-lsp-linux-${asset_arch}.zip" \
    && echo "${sha}  /tmp/luau-lsp.zip" | sha256sum -c - \
    && unzip -q /tmp/luau-lsp.zip -d /tmp/luau-lsp \
    && install -m 0755 /tmp/luau-lsp/luau-lsp "$REAMON_LUAU_LSP" \
    && rm -rf /tmp/luau-lsp /tmp/luau-lsp.zip \
    && mkdir -p /usr/share/licenses/luau-lsp \
    && retry curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors \
        -o /usr/share/licenses/luau-lsp/LICENSE.md "https://raw.githubusercontent.com/JohnnyMorganz/luau-lsp/${REAMON_LUAU_LSP_VERSION}/LICENSE.md" \
    && echo "5bf374ce7ab54c8d75f14e21f04932cae10708189afaec95321aed1a47701935  /usr/share/licenses/luau-lsp/LICENSE.md" | sha256sum -c -

# Install Ruby + Bundler (for Ruby/Rails projects)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ruby ruby-dev libyaml-dev pkg-config \
    && rm -rf /var/lib/apt/lists/* \
    && gem install bundler --no-document

# Solargraph resolves Ruby local-variable and parameter references by binding
# identity. Keep its complete gem set isolated and pinned by the committed lock.
ENV REAMON_SOLARGRAPH_RUBY=/usr/local/bin/reamon-solargraph-ruby
COPY agentic/analyzers/solargraph/Gemfile agentic/analyzers/solargraph/Gemfile.lock /opt/reamon-solargraph/
RUN BUNDLE_GEMFILE=/opt/reamon-solargraph/Gemfile bundle install --gemfile /opt/reamon-solargraph/Gemfile \
        --path /opt/reamon-solargraph/bundle --jobs 4 --retry 3 \
    && printf '#!/bin/sh\nBUNDLE_GEMFILE=/opt/reamon-solargraph/Gemfile exec bundle exec ruby "$@"\n' \
        > "$REAMON_SOLARGRAPH_RUBY" \
    && chmod 0755 "$REAMON_SOLARGRAPH_RUBY" \
    && mkdir -p /usr/share/licenses/solargraph
COPY agentic/analyzers/solargraph/LICENSE /usr/share/licenses/solargraph/LICENSE

# Install Java 17 JDK + Maven (for Java projects)
RUN apt-get update && apt-get install -y --no-install-recommends \
    default-jdk-headless \
    maven \
    && rm -rf /var/lib/apt/lists/*

# Install PHP + Composer (for PHP projects)
RUN apt-get update && apt-get install -y --no-install-recommends \
    php-cli php-xml php-mbstring php-curl php-zip \
    && rm -rf /var/lib/apt/lists/* \
    && retry curl -sS --retry 5 --retry-delay 5 --retry-all-errors \
        -o /tmp/composer-setup.php https://getcomposer.org/installer \
    && php /tmp/composer-setup.php --install-dir=/usr/local/bin --filename=composer \
    && rm /tmp/composer-setup.php

# Pin Phpactor's standalone LSP runtime by both release and artifact digest.
ARG PHPACTOR_VERSION=2026.10.07.0
ARG PHPACTOR_SHA256=b28bf6166e016d539fc2f2aec18ef918b12590e436a6f1ccbdf30b5bbdbdb16b
RUN mkdir -p /opt/phpactor \
    && retry curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors \
        -o /opt/phpactor/phpactor.phar "https://github.com/phpactor/phpactor/releases/download/${PHPACTOR_VERSION}/phpactor.phar" \
    && echo "${PHPACTOR_SHA256}  /opt/phpactor/phpactor.phar" | sha256sum -c - \
    && printf '#!/bin/sh\nexec php /opt/phpactor/phpactor.phar "$@"\n' > /usr/local/bin/phpactor \
    && chmod 0755 /usr/local/bin/phpactor
COPY analyzers/phpactor/LICENSE.md /usr/share/licenses/phpactor/LICENSE.md

# Install .NET 8 SDK (for C# projects)
RUN apt-get update && apt-get install -y --no-install-recommends libicu-dev && rm -rf /var/lib/apt/lists/* \
    && retry curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors \
        -o /tmp/dotnet-install.sh https://dot.net/v1/dotnet-install.sh \
    && bash /tmp/dotnet-install.sh --channel 8.0 --install-dir /usr/share/dotnet \
    && rm /tmp/dotnet-install.sh \
    && ln -s /usr/share/dotnet/dotnet /usr/local/bin/dotnet
ENV DOTNET_ROOT="/usr/share/dotnet"

# Copy requirements first for better caching.
# NOTE: build context is the project root (./), not ./agentic — see docker-compose.yml
COPY agentic/requirements.txt ./
COPY agentic/requirements-kb.txt ./

# Core Python dependencies (always installed)
RUN pip install --no-cache-dir -r requirements.txt

# Install uv (~10 MB) for stdio Python-ecosystem MCP servers (`uvx mcp-...`).
# Lets users add stdio MCPs via the Settings UI without rebuilding the image.
RUN pip install --no-cache-dir uv

# Build arg: set to "true" to skip heavy KB dependencies (~4.4 GB saved)
# Use ./redamon.sh install --skipkbase to activate
# Declared AFTER core pip install so changing SKIP_KB doesn't bust that cache layer.
ARG SKIP_KB=false

# PyTorch wheel source. Defaults to the CPU-only index (~200 MB). `pip install
# torch` on linux/amd64 otherwise pulls the CUDA wheel, which vendors ~2.5 GB of
# nvidia-* runtime libs this workload never uses (embeddings run on CPU via
# faiss-cpu). A GPU host builds with
#   --build-arg TORCH_INDEX_URL=https://download.pytorch.org/whl/cu124
# which redamon.sh sets from the frozen build decision (`.gpu-enabled` marker).
# Pre-installing torch here means sentence-transformers below finds it already
# satisfied and never reaches for the default CUDA wheel.
ARG TORCH_INDEX_URL=https://download.pytorch.org/whl/cpu

# KB heavy dependencies: torch, sentence-transformers, faiss-cpu
# Skipped when SKIP_KB=true (--skipkbase flag)
RUN if [ "$SKIP_KB" != "true" ]; then \
        pip install --no-cache-dir torch --index-url "$TORCH_INDEX_URL" \
        && pip install --no-cache-dir -r requirements-kb.txt \
        && TORCH_INDEX_URL="$TORCH_INDEX_URL" python -c "import torch,os,sys; \
want_cpu='/cpu' in os.environ.get('TORCH_INDEX_URL',''); \
got_cpu=torch.__version__.endswith('+cpu'); \
sys.exit(0) if want_cpu==got_cpu else (print(f'FATAL: TORCH_INDEX_URL asked for {\"cpu\" if want_cpu else \"cuda\"} but torch is {torch.__version__}'), sys.exit(1))"; \
    fi

# Pre-download the embedding model (~1.3 GB) unless KB is skipped.
# Cached at /root/.cache/huggingface/.
# Override at build time with --build-arg KB_EMBEDDING_MODEL=<other-model>.
ARG KB_EMBEDDING_MODEL=intfloat/e5-large-v2
ENV KB_EMBEDDING_MODEL=${KB_EMBEDDING_MODEL}
RUN if [ "$SKIP_KB" != "true" ]; then \
        python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('${KB_EMBEDDING_MODEL}')"; \
    fi

# Pre-download the cross-encoder reranker model (~568 MB) unless KB is skipped.
# Override at build time with --build-arg KB_RERANKER_MODEL=<other>.
# Disable the reranker at runtime via KB_RERANK_ENABLED=false.
ARG KB_RERANKER_MODEL=BAAI/bge-reranker-base
ENV KB_RERANKER_MODEL=${KB_RERANKER_MODEL}
RUN if [ "$SKIP_KB" != "true" ]; then \
        python -c "from sentence_transformers import CrossEncoder; CrossEncoder('${KB_RERANKER_MODEL}')"; \
    fi

# CVE Intel (extended) MCP server. Baked in so the "CVE Intel (extended)"
# preset works out of the box and SURVIVES container restarts (issue #165),
# instead of requiring a manual git-clone into an ephemeral /tmp dir. The
# upstream package is `cve_mcp`, exposed as the `cve-mcp` console script
# (stdio by default) — the preset invokes that binary directly, no cwd needed.
# Placed after the heavy KB layers so it never busts their (slow) build cache.
# The `git config` is not incidental: pip shells out to bookworm's git 2.39 for
# this VCS install, and GitHub answers its HTTP/2 git-upload-pack POST with 401
# (surfacing as a credential prompt in a TTY-less build).
RUN git config --system http.version HTTP/1.1 && \
    pip install --no-cache-dir "git+https://github.com/mukul975/cve-mcp-server.git@main"

# Trivy vuln scanner + its MCP plugin, baked in so the "Trivy" preset works
# out of the box (issue #165 audit). Two gotchas handled here: (1) Trivy is
# NOT in the Debian apt repos, so it's installed via the official script;
# (2) `trivy mcp` is a PLUGIN (github.com/aquasecurity/trivy-mcp), not a
# built-in subcommand — so the binary alone is not enough, the plugin must
# be installed too. The plugin lands in /root/.trivy (the runtime HOME) and
# is baked into the image, surviving container restarts. Version pinned for
# reproducible builds.
ARG TRIVY_VERSION=v0.75.0
RUN curl -sfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh \
        | sh -s -- -b /usr/local/bin "${TRIVY_VERSION}" \
    && trivy plugin install mcp

# Copy application code
# - graph_db/ : shared Neo4j schema (used by both agent and KB)
# - services/knowledge_base/ : KB package (COPY-baked, imported as `knowledge_base`)
# - agentic/ : the agent itself (orchestrator, tools, prompts, skills, ...)
COPY graph_db/ ./graph_db/    
COPY services/knowledge_base/ ./knowledge_base/
# - recon_settings/ : the recon settings registry (bounds, units, meanings). The
#   agent serves it to describe_recon_settings and reads it to validate a write.
COPY recon_settings/ ./recon_settings/
COPY agentic/ ./
RUN GO111MODULE=off go build -trimpath -o /usr/local/bin/reamon-gorefactor ./reamon_gorefactor \
    && chmod 0555 /usr/local/bin/reamon-gorefactor
RUN dotnet publish ./reamon_csharp_refactor/Reamon.CSharpRefactor.csproj -c Release -o /opt/reamon-csharprefactor \
    && printf '#!/bin/sh\nexec /usr/share/dotnet/dotnet /opt/reamon-csharprefactor/Reamon.CSharpRefactor.dll "$@"\n' > /usr/local/bin/reamon-csharprefactor \
    && chmod 0555 /usr/local/bin/reamon-csharprefactor
RUN mkdir -p /opt/reamon-javarefactor \
    && javac --release 17 -d /opt/reamon-javarefactor ./reamon_java_refactor/ReamonJavaRefactor.java \
    && printf '#!/bin/sh\nexec java -cp /opt/reamon-javarefactor ReamonJavaRefactor "$@"\n' > /usr/local/bin/reamon-javarefactor \
    && chmod 0555 /usr/local/bin/reamon-javarefactor

# Make knowledge_base and graph_db importable as top-level packages
ENV PYTHONPATH="/app:${PYTHONPATH}"

# Ensure KB data + cache directories exist (mounted as a volume at runtime).
# Created BEFORE the chmod -R a-w below so the volume mountpoint exists when
# nothing is mounted (the agent gracefully degrades to no-op KB in that case).
RUN mkdir -p /app/knowledge_base/data/sources /app/knowledge_base/data/cache

# Note: the container currently runs as root (no USER directive), so
# CAP_DAC_OVERRIDE lets the process bypass these permissions at runtime.
# The chmod still provides defense-in-depth against accidental writes
# (typos, buggy code) and surfaces EACCES errors early instead of silent
# corruption. For stronger enforcement, add a non-root USER directive
# and drop CAP_DAC_OVERRIDE via docker-compose.
#
# The `|| true` fallback is scoped to ONLY the __pycache__ chmod via
# parentheses — a failure of the two chmods above is a real build failure,
# not silently swallowed. Previously the ungrouped `|| true` applied to
# the whole `&&` chain and could ship an image with writable source code
# if any chmod in the chain failed. The __pycache__ restore itself is a
# no-op under PYTHONDONTWRITEBYTECODE=1 (set at the top of this file),
# but preserved as a defensive fallback for anyone who unsets that env
# var at runtime.
RUN chmod -R a-w /app/knowledge_base \
    && chmod -R u+w /app/knowledge_base/data \
    && ( chmod -R u+w /app/knowledge_base/__pycache__ 2>/dev/null || true )

# Expose API port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

# Run the API server. Single-worker by design: the fireteam confirmation
# registry uses an in-process dict (orchestrator_helpers/
# fireteam_confirmation_registry.py). The startup guard in api.py refuses
# to start if WORKERS / UVICORN_WORKERS / WEB_CONCURRENCY / GUNICORN_WORKERS
# is > 1. To scale horizontally, first move the registry to a shared store.
CMD ["uvicorn", "api:app", "--host", "0.0.0.0", "--port", "8080"]
