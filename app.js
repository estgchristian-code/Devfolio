const GITHUB_USER = 'estgchristian-code';

/* ==========================================================================
   Integração com a GitHub REST API
   - Somente dados públicos; nenhum token é utilizado no frontend.
   - Cache em localStorage + revalidação condicional por ETag.
   - Nenhuma requisição extra por repositório (linguagem principal + topics).
   ========================================================================== */

const GITHUB_CONFIG = {
    user: GITHUB_USER,
    apiBase: 'https://api.github.com',
    perPage: 100,
    maxProjects: 10,
    cacheKey: 'portfolio:github:v1',
    cacheVersion: 1,
    ttl: 30 * 60 * 1000,            // dado considerado fresco por 30 minutos
    refreshInterval: 30 * 60 * 1000, // verificação automática a cada 30 minutos
    requestTimeout: 8000,            // aborta requisições travadas
    // Curadoria manual: nomes de repositórios em minúsculas.
    // Edite esta lista para destacar outros projetos do perfil.
    featuredRepos: ['site-confeitaria', 'site-advocacia', 'devfolio'],
    // Topics que promovem o repositório a destaque.
    featuredTopics: ['featured', 'destaque', 'portfolio'],
    // Repositórios que nunca aparecem no portfólio.
    blockedPattern: /(^|[-_.])(test|teste|testes|tests|aula|aulas|estudo|estudos|rascunho|sandbox|dotfiles|config|configs|backup)([-_.]|$)/i,
    // Relevância mínima para o portfólio (não influencia destaques).
    minRelevance: 20,
    minProjects: 3
};

const FRONTEND_LANGUAGES = new Set([
    'javascript', 'js', 'typescript', 'tsx', 'jsx', 'html', 'css', 'scss', 'sass', 'vue', 'svelte', 'astro'
]);

const WEB_LANGUAGES = new Set([
    'php', 'blade', 'python', 'ruby', 'java', 'c#', 'go', 'node', 'shell', 'sql'
]);

const RELEVANCE_KEYWORDS = [
    'front-end', 'frontend', 'web', 'react', 'next', 'vue', 'svelte', 'angular',
    'tailwind', 'bootstrap', 'laravel', 'livewire', 'php', 'api', 'rest', 'ui', 'ux',
    'acessibilidade', 'acessivel', 'portfolio', 'landing', 'site', 'dashboard', 'spa',
    'pwa', 'html', 'css', 'javascript', 'typescript', 'python'
];

// Correspondência por palavra inteira: evita falsos positivos como "ui" em "arquivos".
const RELEVANCE_PATTERNS = RELEVANCE_KEYWORDS.map((keyword) => ({
    keyword,
    pattern: new RegExp(`(^|[^a-z0-9])${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[^a-z0-9]|$)`, 'i')
}));

const FILTER_LABELS = {
    all: 'Todos',
    web: 'HTML / CSS / JS',
    php: 'PHP / Laravel',
    'python-ts': 'Python / TS',
    featured: 'Destaques'
};

/* Conteúdo local usado apenas quando não há cache e a API está indisponível. */
const fallbackRepos = [
    {
        id: 'fallback-site-confeitaria',
        name: 'site-confeitaria',
        description: 'Aplicação web responsiva com foco em acessibilidade e experiência do usuário.',
        language: 'JavaScript',
        topics: [],
        stars: 0,
        url: `https://github.com/${GITHUB_USER}/site-confeitaria`,
        homepage: 'https://norske-confeitaria.vercel.app',
        pushedAt: '2026-08-14T14:28:38Z',
        updatedAt: '2026-08-14T14:28:38Z',
        relevance: 0
    },
    {
        id: 'fallback-site-advocacia',
        name: 'site-advocacia',
        description: 'Portfólio institucional responsivo desenvolvido para apresentação de serviços jurídicos.',
        language: 'CSS',
        topics: [],
        stars: 0,
        url: `https://github.com/${GITHUB_USER}/site-advocacia`,
        homepage: 'https://karen-advocacia.vercel.app',
        pushedAt: '2026-11-17T12:40:37Z',
        updatedAt: '2026-11-17T12:40:37Z',
        relevance: 0
    }
];

/* Card manual: aparece independentemente da API e do cache. */
const manualRepos = [
    {
        id: 'manual-devfolio',
        name: 'Devfolio',
        description: 'Portfólio pessoal para apresentação de projetos e experiências em desenvolvimento web.',
        language: 'HTML',
        topics: [],
        stars: 0,
        url: 'https://github.com/estgchristian-code/Devfolio',
        homepage: '',
        pushedAt: '2026-11-23T12:52:46Z',
        updatedAt: '2026-11-23T12:52:06Z',
        relevance: 0
    }
];

function mergeManualRepos(repos) {
    const manualNames = new Set(manualRepos.map((repo) => repo.name.toLowerCase()));
    const withoutDuplicates = repos.filter((repo) => !manualNames.has((repo.name || '').toLowerCase()));
    return [...manualRepos, ...withoutDuplicates];
}

let allRepos = [...fallbackRepos];
let activeFilter = 'all';
let githubInFlight = null;
let githubMemoryCache = null;
let githubRateLimit = { remaining: null, resetAt: 0 };
let githubRefreshTimer = null;

/* ------------------------------- Utilitários ------------------------------ */

const relativeTimeFormatter = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' });
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[char]));
}

function safeUrl(value) {
    if (typeof value !== 'string' || !value) return '';
    try {
        const url = new URL(value);
        return (url.protocol === 'https:' || url.protocol === 'http:') ? url.href : '';
    } catch (error) {
        return '';
    }
}

function formatRelativeDate(value) {
    if (value === null || value === undefined || value === '') return '—';
    const date = value instanceof Date ? value : new Date(value);
    const timestamp = date.getTime();
    if (!Number.isFinite(timestamp)) return '—';

    const diff = timestamp - Date.now();
    const abs = Math.abs(diff);

    if (abs < MINUTE_MS) return 'agora';
    if (abs < HOUR_MS) return relativeTimeFormatter.format(Math.round(diff / MINUTE_MS), 'minute');
    if (abs < DAY_MS) return relativeTimeFormatter.format(Math.round(diff / HOUR_MS), 'hour');
    if (abs < 30 * DAY_MS) return relativeTimeFormatter.format(Math.round(diff / DAY_MS), 'day');
    if (abs < 365 * DAY_MS) return relativeTimeFormatter.format(Math.round(diff / (30 * DAY_MS)), 'month');
    return relativeTimeFormatter.format(Math.round(diff / (365 * DAY_MS)), 'year');
}

function formatAbsoluteDate(value) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleDateString('pt-BR') : '';
}

function formatTimeOfDay(timestamp) {
    const date = new Date(timestamp);
    return Number.isFinite(date.getTime())
        ? date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
        : '';
}

function refreshIcons() {
    if (window.lucide) lucide.createIcons();
}

/* --------------------------------- Cache ---------------------------------- */

function readGithubCache() {
    try {
        const raw = window.localStorage.getItem(GITHUB_CONFIG.cacheKey);
        if (!raw) return githubMemoryCache;

        const parsed = JSON.parse(raw);
        if (!parsed || parsed.version !== GITHUB_CONFIG.cacheVersion || !Array.isArray(parsed.repos)) {
            return null;
        }

        githubMemoryCache = parsed;
        return parsed;
    } catch (error) {
        // localStorage bloqueado (modo privado) ou conteúdo corrompido: memória como fallback.
        return githubMemoryCache;
    }
}

function saveGithubCache(payload) {
    githubMemoryCache = payload;
    try {
        window.localStorage.setItem(GITHUB_CONFIG.cacheKey, JSON.stringify(payload));
    } catch (error) {
        // Sem persistência disponível: o cache em memória continua válido para a sessão.
    }
}

/* --------------------- Normalização, curadoria e destaque ------------------ */

function normalizeRepo(raw) {
    const topics = Array.isArray(raw.topics)
        ? raw.topics.filter((topic) => typeof topic === 'string' && topic.trim()).slice(0, 12)
        : [];

    return {
        id: raw.id ?? raw.full_name ?? raw.name,
        name: typeof raw.name === 'string' ? raw.name : '',
        description: typeof raw.description === 'string' ? raw.description : '',
        language: typeof raw.language === 'string' ? raw.language : '',
        topics,
        stars: Number(raw.stargazers_count) || 0,
        url: safeUrl(raw.html_url),
        homepage: safeUrl(raw.homepage),
        fork: Boolean(raw.fork),
        archived: Boolean(raw.archived),
        disabled: Boolean(raw.disabled),
        isTemplate: Boolean(raw.is_template),
        size: Number(raw.size) || 0,
        pushedAt: raw.pushed_at || raw.updated_at || '',
        updatedAt: raw.updated_at || raw.pushed_at || '',
        relevance: 0
    };
}

function relevanceScore(repo) {
    const language = (repo.language || '').toLowerCase();
    const haystack = `${repo.name} ${repo.description} ${repo.topics.join(' ')}`.toLowerCase();
    let score = 0;

    if (FRONTEND_LANGUAGES.has(language)) {
        score += 40;
    } else if (WEB_LANGUAGES.has(language)) {
        score += 30;
    }

    let keywordMatches = 0;
    for (const { pattern } of RELEVANCE_PATTERNS) {
        if (pattern.test(haystack)) {
            keywordMatches += 1;
            if (keywordMatches >= 3) break;
        }
    }
    score += keywordMatches * 15;

    if (repo.homepage) score += 10;
    if (repo.stars >= 3) score += 5;

    return score;
}

function isFeatured(repo) {
    const name = (repo.name || '').toLowerCase();
    const whitelisted = GITHUB_CONFIG.featuredRepos.includes(name);
    const hasFeaturedTopic = repo.topics.some((topic) =>
        GITHUB_CONFIG.featuredTopics.includes(topic.toLowerCase())
    );
    return whitelisted || hasFeaturedTopic;
}

function classifyRepo(repo) {
    const categories = new Set();
    const language = (repo.language || '').toLowerCase();
    const topics = repo.topics.map((topic) => topic.toLowerCase());
    const matches = (values) => values.some((value) => language === value || topics.includes(value));

    if (matches(['php', 'blade', 'laravel', 'livewire'])) categories.add('php');
    if (matches(['python', 'typescript', 'ts', 'tsx', 'fastapi', 'django', 'flask'])) categories.add('python-ts');
    if (matches(['html', 'css', 'scss', 'javascript', 'js', 'react', 'vue', 'svelte', 'astro', 'nextjs', 'tailwind'])) {
        categories.add('web');
    }

    // Mantém o comportamento anterior: qualquer repositório fora dos grupos acima
    // aparece no filtro HTML / CSS / JS em vez de desaparecer da listagem.
    if (!categories.size) categories.add('web');

    return categories;
}

function sortRepos(a, b) {
    const featuredDiff = Number(isFeatured(b)) - Number(isFeatured(a));
    if (featuredDiff) return featuredDiff;

    const relevanceDiff = (b.relevance || 0) - (a.relevance || 0);
    if (relevanceDiff) return relevanceDiff;

    const aDate = new Date(a.pushedAt || 0).getTime() || 0;
    const bDate = new Date(b.pushedAt || 0).getTime() || 0;
    return bDate - aDate;
}

function curateRepos(rawRepos) {
    const hardFiltered = rawRepos
        .map(normalizeRepo)
        .filter((repo) => {
            if (!repo.name || !repo.url) return false;
            if (repo.fork || repo.archived || repo.disabled || repo.isTemplate) return false;
            // Um repositório com atividade (pushed_at) não é vazio, mesmo que o
            // size ainda seja 0 por atraso na indexação do GitHub.
            if (repo.size === 0 && !repo.pushedAt) return false;
            if (GITHUB_CONFIG.blockedPattern.test(repo.name)) return false;
            return true;
        });

    hardFiltered.forEach((repo) => {
        repo.relevance = relevanceScore(repo);
    });

    // Destaques manuais (whitelist/topic) nunca são descartados pelo filtro de
    // relevância; forks, arquivados e nomes bloqueados continuam excluídos.
    const relevant = hardFiltered.filter((repo) =>
        isFeatured(repo) || repo.relevance >= GITHUB_CONFIG.minRelevance
    );
    const pool = relevant.length >= GITHUB_CONFIG.minProjects ? relevant : hardFiltered;

    return pool.sort(sortRepos).slice(0, GITHUB_CONFIG.maxProjects);
}

/* --------------------------------- Render --------------------------------- */

function getFilteredRepos() {
    if (activeFilter === 'all') return allRepos;
    if (activeFilter === 'featured') return allRepos.filter(isFeatured);
    return allRepos.filter((repo) => classifyRepo(repo).has(activeFilter));
}

function renderSkeleton(count = 4) {
    const grid = document.getElementById('projects-grid');
    if (!grid) return;

    grid.innerHTML = Array.from({ length: count }).map(() => `
        <div class="bg-ide-surface border border-ide-border rounded-2xl p-6 animate-pulse" aria-hidden="true">
            <div class="flex items-center justify-between gap-3 mb-4">
                <div class="h-5 w-2/3 rounded bg-ide-panel"></div>
                <div class="h-6 w-16 rounded bg-ide-panel"></div>
            </div>
            <div class="space-y-2 mb-6">
                <div class="h-3 w-full rounded bg-ide-panel"></div>
                <div class="h-3 w-4/5 rounded bg-ide-panel"></div>
            </div>
            <div class="flex items-center justify-between pt-4 border-t border-ide-border/70">
                <div class="h-3 w-24 rounded bg-ide-panel"></div>
                <div class="h-3 w-16 rounded bg-ide-panel"></div>
            </div>
        </div>
    `).join('');
}

function renderRepoCard(repo) {
    const featured = isFeatured(repo);
    const language = repo.language || 'Code';
    const updatedIso = repo.pushedAt || repo.updatedAt;
    const updatedRelative = formatRelativeDate(updatedIso);
    const updatedAbsolute = formatAbsoluteDate(updatedIso);
    const visibleTopics = repo.topics.slice(0, 4);
    const extraTopics = repo.topics.length - visibleTopics.length;

    return `
        <article class="bg-ide-surface border ${featured ? 'border-ide-amber/50 hover:border-ide-amber/80' : 'border-ide-border hover:border-ide-cyan/60'} rounded-2xl p-6 flex flex-col justify-between transition-all group">
            <div>
                <div class="flex items-start justify-between gap-3 mb-3">
                    <div class="flex items-center gap-2.5 min-w-0">
                        <i data-lucide="folder-git-2" class="w-5 h-5 text-ide-cyan shrink-0"></i>
                        <h3 class="text-lg font-bold text-white group-hover:text-ide-cyan transition-colors break-all">${escapeHtml(repo.name)}</h3>
                    </div>
                    <div class="flex flex-col items-end gap-1.5 shrink-0">
                        ${featured ? `<span class="inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded-md bg-ide-amber/10 border border-ide-amber/40 text-ide-amber"><i data-lucide="star" class="w-3 h-3"></i>Destaque</span>` : ''}
                        <span class="text-xs font-mono px-2.5 py-1 rounded-md bg-ide-bg border border-ide-border text-ide-cyan">
                            ${escapeHtml(language)}
                        </span>
                    </div>
                </div>
                <p class="text-ide-muted text-sm leading-relaxed ${visibleTopics.length ? 'mb-3' : 'mb-5'}">
                    ${escapeHtml(repo.description || 'Repositório público no GitHub.')}
                </p>
                ${visibleTopics.length ? `
                    <div class="flex flex-wrap gap-1.5 mb-5 font-mono text-[11px]">
                        ${visibleTopics.map((topic) => `<span class="px-2 py-0.5 rounded-md bg-ide-bg border border-ide-border text-ide-muted">#${escapeHtml(topic)}</span>`).join('')}
                        ${extraTopics > 0 ? `<span class="px-2 py-0.5 rounded-md bg-ide-bg border border-ide-border text-ide-muted">+${extraTopics}</span>` : ''}
                    </div>
                ` : ''}
            </div>

            <div class="flex items-center justify-between pt-4 border-t border-ide-border/70 font-mono text-xs text-ide-muted">
                <div class="flex items-center gap-4">
                    <span class="flex items-center gap-1" title="${repo.stars} estrelas">
                        <i data-lucide="star" class="w-3.5 h-3.5 text-ide-amber"></i>
                        ${repo.stars}
                    </span>
                    <span title="${escapeHtml(updatedAbsolute)}">Atualizado: ${escapeHtml(updatedRelative)}</span>
                </div>
                <a href="${escapeHtml(repo.url)}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 text-ide-cyan hover:underline">
                    <span>Ver repo</span>
                    <i data-lucide="external-link" class="w-3.5 h-3.5"></i>
                </a>
            </div>
        </article>
    `;
}

function renderProjects() {
    const grid = document.getElementById('projects-grid');
    if (!grid) return;

    allRepos = mergeManualRepos(allRepos);

    const filtered = getFilteredRepos();

    if (!filtered.length) {
        grid.innerHTML = `
            <div class="col-span-full bg-ide-surface border border-ide-border rounded-2xl p-8 text-center font-mono text-sm text-ide-muted">
                Nenhum repositório encontrado para o filtro <span class="text-ide-cyan">${escapeHtml(FILTER_LABELS[activeFilter] || activeFilter)}</span>.
            </div>
        `;
        refreshIcons();
        return;
    }

    grid.innerHTML = filtered.map(renderRepoCard).join('');
    refreshIcons();
}

/* ------------------------- Status, aviso e botão de sync ------------------- */

const STATUS_STYLES = {
    loading: 'bg-ide-cyan/10 text-ide-cyan border-ide-cyan/30',
    synced: 'bg-ide-green/10 text-ide-green border-ide-green/30',
    cache: 'bg-ide-amber/10 text-ide-amber border-ide-amber/30',
    error: 'bg-rose-500/10 text-rose-400 border-rose-500/30'
};

function setApiStatus(state, text, detail) {
    const statusEl = document.getElementById('github-api-status');
    if (!statusEl) return;

    statusEl.className = `inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full border ${STATUS_STYLES[state] || STATUS_STYLES.cache}`;
    statusEl.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-current ${state === 'loading' ? 'animate-pulse' : ''}"></span><span></span>`;
    statusEl.querySelector('span:last-child').textContent = text;
    statusEl.title = detail || '';
}

function showGithubNotice(message) {
    const notice = document.getElementById('github-notice');
    const text = document.getElementById('github-notice-text');
    if (!notice || !text) return;
    text.textContent = message;
    notice.classList.remove('hidden');
    notice.classList.add('flex');
}

function hideGithubNotice() {
    const notice = document.getElementById('github-notice');
    if (!notice) return;
    notice.classList.add('hidden');
    notice.classList.remove('flex');
}

function setSyncLoading(loading) {
    const button = document.getElementById('sync-github-btn');
    if (!button) return;

    button.disabled = loading;
    button.classList.toggle('opacity-60', loading);
    button.classList.toggle('cursor-wait', loading);

    const icon = button.querySelector('svg, i');
    if (icon) icon.classList.toggle('animate-spin', loading);
}

function updateRateLimit(response) {
    const remainingHeader = response.headers.get('x-ratelimit-remaining');
    const resetHeader = response.headers.get('x-ratelimit-reset');

    if (remainingHeader !== null) {
        const remaining = Number(remainingHeader);
        if (Number.isFinite(remaining)) githubRateLimit.remaining = remaining;
    }

    if (resetHeader !== null) {
        const reset = Number(resetHeader);
        if (Number.isFinite(reset) && reset > 0) githubRateLimit.resetAt = reset * 1000;
    }
}

/* -------------------------------- Requisição ------------------------------ */

function fetchGitHubRepos(showToast = false) {
    // Mantém a assinatura usada pelos botões do HTML.
    const notify = showToast === true;

    if (githubInFlight) return githubInFlight;

    githubInFlight = refreshGitHub({ force: notify, notify })
        .catch((error) => {
            console.error('[GitHub] Falha inesperada na sincronização:', error);
        })
        .finally(() => {
            githubInFlight = null;
        });

    return githubInFlight;
}

async function refreshGitHub({ force = false, notify = false } = {}) {
    const cached = readGithubCache();
    const isFresh = Boolean(cached) && (Date.now() - cached.fetchedAt < GITHUB_CONFIG.ttl);

    if (!force && isFresh) return;

    if (githubRateLimit.remaining !== null && githubRateLimit.remaining <= 0 && Date.now() < githubRateLimit.resetAt) {
        const resetLabel = formatTimeOfDay(githubRateLimit.resetAt);
        const message = `Limite de requisições do GitHub atingido.${resetLabel ? ` Nova tentativa após ${resetLabel}.` : ''}`;
        const hasCache = Boolean(cached && cached.repos.length);
        setApiStatus(hasCache ? 'cache' : 'error', hasCache ? 'Limite da API — cache' : 'Limite da API', message);
        showGithubNotice(`${message} ${hasCache ? 'Os dados em cache continuam sendo exibidos.' : 'Exibindo conteúdo local.'}`);
        if (notify) showToastMessage('Limite da API do GitHub atingido. Tentando novamente mais tarde.');
        return;
    }

    setApiStatus('loading', 'Sincronizando GitHub API...', 'Buscando repositórios públicos');
    setSyncLoading(true);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), GITHUB_CONFIG.requestTimeout);

    try {
        const query = `type=owner&sort=pushed&direction=desc&per_page=${GITHUB_CONFIG.perPage}`;
        const url = `${GITHUB_CONFIG.apiBase}/users/${encodeURIComponent(GITHUB_CONFIG.user)}/repos?${query}`;
        const headers = { Accept: 'application/vnd.github+json' };

        // Revalidação condicional: 304 não devolve payload e evita re-render.
        if (cached && cached.etag) headers['If-None-Match'] = cached.etag;

        const response = await fetch(url, {
            headers,
            signal: controller.signal,
            cache: 'no-store'
        });

        updateRateLimit(response);

        if (response.status === 304 && cached) {
            const refreshed = { ...cached, fetchedAt: Date.now() };
            saveGithubCache(refreshed);
            allRepos = refreshed.repos;
            renderProjects();
            setApiStatus('synced', `GitHub Sincronizado (${allRepos.length})`, 'Dados revalidados sem novas requisições');
            hideGithubNotice();
            if (notify) showToastMessage('Os dados do GitHub já estavam atualizados.');
            return;
        }

        if (!response.ok) {
            const error = new Error(`GitHub respondeu com status ${response.status}`);
            error.kind = (response.status === 403 || response.status === 429) ? 'rate-limit' : 'http';
            throw error;
        }

        const data = await response.json();
        if (!Array.isArray(data)) {
            const error = new Error('Formato de resposta inesperado da API do GitHub');
            error.kind = 'payload';
            throw error;
        }

        const repos = curateRepos(data);
        if (!repos.length) {
            const error = new Error('Nenhum repositório relevante retornado pela API');
            error.kind = 'empty';
            throw error;
        }

        const payload = {
            version: GITHUB_CONFIG.cacheVersion,
            fetchedAt: Date.now(),
            etag: response.headers.get('etag') || '',
            repos
        };

        saveGithubCache(payload);
        allRepos = repos;
        renderProjects();
        setApiStatus('synced', `GitHub Sincronizado (${allRepos.length})`, `Atualizado ${formatRelativeDate(payload.fetchedAt)}`);
        hideGithubNotice();
        if (notify) showToastMessage(`${repos.length} repositórios sincronizados.`);
    } catch (error) {
        handleGithubFailure(error, Boolean(cached && cached.repos.length), notify);
    } finally {
        clearTimeout(timeoutId);
        setSyncLoading(false);
    }
}

function handleGithubFailure(error, hasCache, notify) {
    if (!hasCache) {
        allRepos = [...fallbackRepos];
        renderProjects();
    }

    const isTimeout = error && error.name === 'AbortError';
    const kind = error?.kind || (isTimeout ? 'timeout' : 'network');
    const resetLabel = githubRateLimit.resetAt > Date.now() ? formatTimeOfDay(githubRateLimit.resetAt) : '';

    const messages = {
        'rate-limit': `Limite de requisições do GitHub atingido.${resetLabel ? ` Nova tentativa após ${resetLabel}.` : ''}`,
        timeout: 'O GitHub demorou para responder. A página continua funcionando normalmente.',
        empty: 'Nenhum repositório público relevante foi encontrado no GitHub.',
        payload: 'O GitHub retornou uma resposta inesperada.',
        http: 'A API do GitHub está indisponível no momento.',
        network: 'Não foi possível conectar à API do GitHub.'
    };

    const message = messages[kind] || messages.network;
    const statusText = hasCache
        ? (kind === 'rate-limit' ? 'Limite da API — cache' : 'Cache — GitHub indisponível')
        : 'Modo offline';

    setApiStatus(hasCache ? 'cache' : 'error', statusText, message);
    showGithubNotice(`${message} ${hasCache ? 'Os dados em cache continuam sendo exibidos.' : 'Exibindo conteúdo local.'}`);

    if (notify) {
        showToastMessage(hasCache ? 'GitHub indisponível — exibindo cache.' : 'GitHub indisponível — exibindo conteúdo local.');
    }
}

/* ------------------------------ Inicialização ----------------------------- */

function initGitHub() {
    const cached = readGithubCache();

    if (cached && cached.repos.length) {
        allRepos = cached.repos;
        renderProjects();

        const fresh = Date.now() - cached.fetchedAt < GITHUB_CONFIG.ttl;
        setApiStatus(
            fresh ? 'synced' : 'cache',
            fresh ? `GitHub Sincronizado (${allRepos.length})` : `Cache — atualizado ${formatRelativeDate(cached.fetchedAt)}`,
            `Última sincronização: ${formatAbsoluteDate(cached.fetchedAt)}`
        );
    } else {
        renderSkeleton();
    }

    fetchGitHubRepos(false);
    startAutoRefresh();
}

function shouldRefresh() {
    const cached = readGithubCache();
    if (!cached) return true;
    return Date.now() - cached.fetchedAt >= GITHUB_CONFIG.ttl;
}

function handleVisibilityChange() {
    if (document.visibilityState !== 'visible') return;
    if (shouldRefresh()) fetchGitHubRepos(false);
}

function startAutoRefresh() {
    if (githubRefreshTimer) clearInterval(githubRefreshTimer);

    githubRefreshTimer = setInterval(() => {
        if (document.visibilityState !== 'visible') return;
        if (shouldRefresh()) fetchGitHubRepos(false);
    }, GITHUB_CONFIG.refreshInterval);

    document.addEventListener('visibilitychange', handleVisibilityChange);
}

/* ------------------------------ Filtros ---------------------------------- */

document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.filter-btn').forEach(b => {
            b.className = 'filter-btn px-3.5 py-2 rounded-xl font-mono text-xs bg-ide-surface text-ide-muted hover:text-white border border-ide-border transition-all';
        });
        btn.className = 'filter-btn active px-3.5 py-2 rounded-xl font-mono text-xs bg-ide-cyan text-ide-bg font-semibold transition-all';
        activeFilter = btn.dataset.filter;
        renderProjects();
    });
});

/* --------------------------- Terminal interativo -------------------------- */

const terminalOutput = document.getElementById('terminal-output');
const terminalForm = document.getElementById('terminal-form');
const terminalInput = document.getElementById('terminal-input');

function appendTerminalLine(cmd, htmlResponse) {
    if (!terminalOutput) return;
    const block = document.createElement('div');
    block.className = 'space-y-1 pt-1';
    block.innerHTML = `
        <div class="flex items-center gap-2 text-ide-text">
            <span class="text-ide-green">christian@dev:~$</span>
            <span class="text-ide-cyan">${cmd}</span>
        </div>
        <div class="pl-4 text-ide-muted border-l-2 border-ide-border space-y-1">${htmlResponse}</div>
    `;
    terminalOutput.appendChild(block);
    terminalOutput.scrollTop = terminalOutput.scrollHeight;
}

function clearTerminal() {
    if (!terminalOutput) return;
    terminalOutput.innerHTML = `<div class="text-ide-muted">Terminal limpo. Digite <span class="text-ide-cyan">help</span>.</div>`;
}

function runCommand(rawCmd) {
    const cmd = (rawCmd || '').trim();
    if (!cmd) return;

    if (cmd === 'clear') {
        clearTerminal();
        return;
    }

    if (cmd === 'help') {
        appendTerminalLine(cmd, `
            <p><span class="text-ide-cyan">whoami</span> — Exibe perfil e trajetória</p>
            <p><span class="text-ide-purple">stack --list</span> — Lista tecnologias principais</p>
            <p><span class="text-ide-blue">projects --featured</span> — Resumo de projetos</p>
            <p><span class="text-ide-cyan">github --repos</span> — Lista repositórios de ${GITHUB_USER}</p>
            <p><span class="text-ide-green">contact</span> — Links e localização</p>
            <p><span class="text-ide-amber">clear</span> — Limpa o terminal</p>
        `);
        return;
    }

    if (cmd === 'whoami') {
        appendTerminalLine(cmd, `
            <p><span class="text-white font-semibold">Nome:</span> Christian Bodziack Dainez</p>
            <p><span class="text-white font-semibold">Experiência:</span> Estagiário de TI @ CRCPR</p>
            <p><span class="text-white font-semibold">Formação:</span> ADS @ PUCPR</p>
        `);
        return;
    }

    if (cmd === 'stack --list') {
        appendTerminalLine(cmd, `
            <p><span class="text-white">Web / Back-End:</span> PHP, Laravel, Livewire, Python, FastAPI</p>
            <p><span class="text-white">Front-End:</span> JavaScript, TypeScript, React, Tailwind CSS, HTML5</p>
            <p><span class="text-white">Dados &amp; Tools:</span> MySQL, PostgreSQL, SQLite, Docker, Git/GitHub</p>
        `);
        return;
    }

    if (cmd === 'projects --featured') {
        const featured = allRepos.filter(isFeatured);
        const list = featured.length ? featured : allRepos.slice(0, 5);
        const html = list.length
            ? list.map((repo) => `• <span class="text-white">${escapeHtml(repo.name)}</span> (${escapeHtml(repo.language || 'Code')})${isFeatured(repo) ? ' <span class="text-ide-amber">★</span>' : ''}<br><span class="pl-3 text-[11px]">${escapeHtml(repo.description || 'Repositório público no GitHub.')}</span>`).join('<br>')
            : 'Nenhum projeto disponível no momento.';
        appendTerminalLine(cmd, `<p>${html}</p>`);
        return;
    }

    if (cmd === 'github --repos') {
        const html = allRepos.length
            ? allRepos.map((repo) => `• <span class="text-white">${escapeHtml(repo.name)}</span> (${escapeHtml(repo.language || 'Code')})${isFeatured(repo) ? ' <span class="text-ide-amber">★</span>' : ''}`).join('<br>')
            : 'Nenhum repositório disponível no momento.';
        appendTerminalLine(cmd, `<p>${html}</p>`);
        return;
    }

    if (cmd === 'contact') {
        appendTerminalLine(cmd, `
            <p><span class="text-white">GitHub:</span> https://github.com/${GITHUB_USER}</p>
            <p><span class="text-white">LinkedIn:</span> https://www.linkedin.com/in/christian-bodziack-dainez-b59418254</p>
            <p><span class="text-white">Local:</span> Curitiba, PR — Brasil</p>
        `);
        return;
    }

    appendTerminalLine(cmd, `<p class="text-rose-400">Comando não encontrado: "${cmd}". Digite <span class="text-ide-cyan">help</span>.</p>`);
}

if (terminalForm && terminalInput) {
    terminalForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const val = terminalInput.value;
        terminalInput.value = '';
        runCommand(val);
    });
}

/* ------------------------------ Modal Currículo --------------------------- */

function openResumeModal() {
    const modal = document.getElementById('resume-modal');
    if (!modal) return;
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    if (window.lucide) lucide.createIcons();
}

function closeResumeModal() {
    const modal = document.getElementById('resume-modal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.classList.remove('flex');
}

/* ------------------------------ Toast & Clipboard ------------------------- */

function showToastMessage(msg) {
    const toast = document.getElementById('toast');
    const toastMsg = document.getElementById('toast-message');
    if (!toast || !toastMsg) return;
    toastMsg.textContent = msg;
    toast.classList.remove('hidden');
    toast.classList.add('flex');
    if (window.lucide) lucide.createIcons();
    setTimeout(() => {
        toast.classList.add('hidden');
        toast.classList.remove('flex');
    }, 2600);
}

function copyToClipboard(text, message) {
    navigator.clipboard?.writeText(text);
    showToastMessage(message || 'Copiado para a área de transferência!');
}

/* --------------------------------- Início --------------------------------- */

if (window.lucide) lucide.createIcons();
initGitHub();
