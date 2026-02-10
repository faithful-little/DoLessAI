// Webpage Generator - Create HTML dashboards from JSON data
// Templates: card-grid, comparison-table, timeline, summary
// Opens in viewer.html (bundled with extension) to avoid MV3 data: URL restrictions

const WebpageGenerator = {
    async generate(params, tabId) {
        const rawDataset = params.dataset ?? params.data ?? params.items ?? params.results;
        const normalizedDataset = this._normalizeDataset(rawDataset);
        const templateType = params.templateType ?? params.template ?? 'card-grid';
        const options = {
            ...(params.options || {}),
            title: params.title ?? params.options?.title,
            highlightColumn: params.highlightColumn ?? params.options?.highlightColumn
        };

        // Resolve relative links/images against the source page URL.
        let baseUrl = options.baseUrl || params.baseUrl || null;
        if (!baseUrl && tabId) {
            try {
                const sourceTab = await chrome.tabs.get(tabId);
                if (sourceTab?.url) baseUrl = sourceTab.url;
            } catch {
                // Ignore lookup failure.
            }
        }
        options.baseUrl = baseUrl || options.baseUrl;
        let dataset = this._prepareDatasetForUI(normalizedDataset, options.baseUrl);

        if (dataset === undefined || dataset === null) {
            throw new Error('webpage_generator requires dataset (or data) to generate a page');
        }

        let outputPreview = null;
        if (templateType === 'comparison-table') {
            const prepared = this._prepareComparisonRows(Array.isArray(dataset) ? dataset : [dataset]);
            dataset = prepared.items;
            const rows = Array.isArray(dataset) ? dataset : [dataset];
            const columns = Array.from(new Set(
                rows.flatMap(row => (row && typeof row === 'object') ? Object.keys(row) : ['value'])
            ));
            outputPreview = {
                templateType: 'comparison-table',
                rowCount: rows.length,
                mixedCurrencies: prepared.mixedCurrencies === true,
                note: prepared.note || '',
                columns: columns.slice(0, 24),
                sampleRows: rows.slice(0, 2)
            };
        }

        const template = this.TEMPLATES[templateType] || this.TEMPLATES['card-grid'];
        const html = template(dataset, options);

        // Save generated HTML to storage with an ID to avoid collisions between concurrent generations.
        const pageId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
        await chrome.storage.local.set({
            generatedPageHTML: html,
            generatedPageTitle: options.title || 'Generated Report',
            [`generatedPageHTML_${pageId}`]: html,
            [`generatedPageTitle_${pageId}`]: options.title || 'Generated Report'
        });

        const viewerUrl = chrome.runtime.getURL(`viewer.html?pageId=${encodeURIComponent(pageId)}`);
        // Keep user on current working tab; open generated report in background.
        const tab = await chrome.tabs.create({ url: viewerUrl, active: false });

        console.log(`[WebpageGenerator] Generated ${templateType} page, opened in tab ${tab.id}`);
        return {
            success: true,
            tabId: tab.id,
            templateType,
            pageId,
            outputPreview: outputPreview || {
                templateType,
                rowCount: Array.isArray(dataset) ? dataset.length : 1
            }
        };
    },

    _normalizeDataset(input) {
        let data = input;

        if (typeof data === 'string') {
            const trimmed = data.trim();
            if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
                try {
                    data = JSON.parse(trimmed);
                } catch {
                    // Keep original string.
                }
            }
        }

        if (Array.isArray(data) || data === null || data === undefined) {
            return data;
        }

        if (typeof data === 'object') {
            const arrayKeys = [
                'rankings', 'results', 'result', 'items', 'data',
                'matched', 'rows', 'documents', 'extractedData'
            ];
            for (const key of arrayKeys) {
                if (Array.isArray(data[key])) return data[key];
            }

            const entries = Object.entries(data);
            if (entries.length === 1 && Array.isArray(entries[0][1])) {
                return entries[0][1];
            }
        }

        return data;
    },

    _displayValue(val) {
        if (val === null || val === undefined) return '';
        if (typeof val === 'object') {
            try {
                return JSON.stringify(val);
            } catch {
                return String(val);
            }
        }
        return String(val);
    },

    _isLikelyUrlKey(key) {
        return [
            'url', 'link', 'href', 'articleurl', 'article_url', 'sourceurl', 'source_url',
            'pageurl', 'page_url', 'website', 'web_url', 'canonicalurl', 'canonical_url'
        ].includes(String(key || '').toLowerCase());
    },

    _isLikelyImageKey(key) {
        return [
            'image', 'imageurl', 'image_url', 'thumbnail', 'thumb', 'img', 'icon', 'logo',
            'avatar', 'src', 'photo', 'picture', 'banner', 'cover'
        ].includes(String(key || '').toLowerCase());
    },

    _looksLikeBareDomain(value) {
        if (typeof value !== 'string') return false;
        const v = value.trim();
        if (!v || /\s/.test(v)) return false;
        return /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(?:[/:?#].*)?$/.test(v);
    },

    _looksLikeRelativePath(value) {
        if (typeof value !== 'string') return false;
        const v = value.trim();
        if (!v || /\s/.test(v)) return false;
        if (v.startsWith('/') || v.startsWith('./') || v.startsWith('../')) return true;
        if (v.startsWith('?') || v.startsWith('&')) return true;
        if (v.includes('/')) return true;
        if (/^[^/]+\.(html?|php|asp|aspx|json|xml|csv|jpg|jpeg|png|gif|webp|svg|bmp|ico)([?#].*)?$/i.test(v)) return true;
        return false;
    },

    _looksLikeRelativeOrAbsoluteUrl(value) {
        if (typeof value !== 'string') return false;
        const v = value.trim();
        if (!v) return false;
        if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(v)) return true;
        if (v.startsWith('//')) return true;
        if (v.startsWith('www.')) return true;
        if (this._looksLikeBareDomain(v)) return true;
        return this._looksLikeRelativePath(v);
    },

    _looksLikeImageUrlValue(value) {
        if (typeof value !== 'string') return false;
        const v = value.trim().toLowerCase();
        if (!v) return false;
        if (v.startsWith('data:image/')) return true;
        return /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)([?#].*)?$/.test(v);
    },

    _shouldNormalizeUrl(key, value) {
        if (typeof value !== 'string') return false;
        const v = value.trim();
        if (!v) return false;
        if (/^(data:|blob:|javascript:|#)/i.test(v)) return false;
        if (this._isLikelyUrlKey(key) || this._isLikelyImageKey(key)) return true;
        return this._looksLikeRelativeOrAbsoluteUrl(v);
    },

    _isLikelyLinkFieldValue(key, value) {
        if (typeof value !== 'string') return false;
        const v = value.trim();
        if (!v || /^(javascript:|data:|blob:|#)/i.test(v)) return false;
        return this._isLikelyUrlKey(key) || this._looksLikeRelativeOrAbsoluteUrl(value);
    },

    _isLikelyImageFieldValue(key, value) {
        if (this._isLikelyImageKey(key)) return true;
        return this._looksLikeImageUrlValue(value);
    },

    _toAbsoluteUrl(value, baseUrl) {
        if (typeof value !== 'string') return value;
        const v = value.trim();
        if (!v) return value;
        if (/^(data:|blob:|javascript:|#)/i.test(v)) return value;
        if (/^(mailto:|tel:)/i.test(v)) return v;
        try {
            if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(v)) {
                return new URL(v).href;
            }
            if (v.startsWith('//')) {
                return new URL(`https:${v}`).href;
            }
            if (v.startsWith('www.')) {
                return new URL(`https://${v}`).href;
            }
            if (baseUrl && this._looksLikeRelativeOrAbsoluteUrl(v)) {
                return new URL(v, baseUrl).href;
            }
            if (this._looksLikeBareDomain(v)) {
                return new URL(`https://${v}`).href;
            }
            return v;
        } catch {
            return value;
        }
    },

    _normalizeAnyUrls(value, baseUrl, parentKey = '') {
        if (Array.isArray(value)) {
            return value.map(entry => this._normalizeAnyUrls(entry, baseUrl, parentKey));
        }
        if (value && typeof value === 'object') {
            const out = {};
            for (const [key, val] of Object.entries(value)) {
                out[key] = this._normalizeAnyUrls(val, baseUrl, key);
            }
            return out;
        }
        if (typeof value === 'string' && this._shouldNormalizeUrl(parentKey, value)) {
            return this._toAbsoluteUrl(value, baseUrl);
        }
        return value;
    },

    _prepareDatasetForUI(dataset, baseUrl) {
        if (!dataset || typeof dataset !== 'object') {
            if (typeof dataset === 'string') {
                return this._shouldNormalizeUrl('', dataset) ? this._toAbsoluteUrl(dataset, baseUrl) : dataset;
            }
            return dataset;
        }
        return this._normalizeAnyUrls(dataset, baseUrl);
    },

    _renderValueHtml(key, val, esc, mode = 'default') {
        if (typeof val === 'string' && this._isLikelyImageFieldValue(key, val)) {
            const safeUrl = esc(val);
            return `<div class="field-image-wrap"><img class="field-image" src="${safeUrl}" alt="${esc(key)}" onerror="this.style.display='none'"><a class="field-url" href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeUrl}</a></div>`;
        }

        if (typeof val === 'string' && this._isLikelyLinkFieldValue(key, val)) {
            const safeUrl = esc(val);
            const label = safeUrl;
            return `<a class="field-url" href="${safeUrl}" target="_blank" rel="noopener noreferrer">${label}</a>`;
        }

        return esc(this._displayValue(val));
    },

    _coerceComparisonRow(item) {
        if (item && typeof item === 'object' && !Array.isArray(item)) return item;
        return { value: this._displayValue(item) };
    },

    _findPriceField(row = {}) {
        const entries = Object.entries(row || {});
        if (entries.length === 0) return { key: null, value: null };

        const preferred = ['price', 'currentprice', 'saleprice', 'listprice', 'amount', 'cost'];
        for (const pref of preferred) {
            const exact = entries.find(([key, value]) => {
                return String(key || '').toLowerCase() === pref && this._displayValue(value).trim().length > 0;
            });
            if (exact) return { key: exact[0], value: exact[1] };
        }

        const fallback = entries.find(([key, value]) => {
            return /(price|cost|amount|list|sale)/i.test(String(key || '')) && this._displayValue(value).trim().length > 0;
        });
        return fallback ? { key: fallback[0], value: fallback[1] } : { key: null, value: null };
    },

    _parsePriceValue(value) {
        if (value === null || value === undefined) return { amount: null, currency: null, rawText: '' };

        const rawText = this._displayValue(value).trim();
        if (!rawText) return { amount: null, currency: null, rawText: '' };

        const upper = rawText.toUpperCase();
        let currency = null;
        if (
            /\bINR\b/.test(upper)
            || /\u20B9/.test(rawText)
            || /\bRS\.?\b/.test(upper)
            || /\bRUPEE(?:S)?\b/.test(upper)
        ) currency = 'INR';
        else if (/\bCAD\b/.test(upper) || /(?:\bCA\$|\bC\$)/.test(upper)) currency = 'CAD';
        else if (/\bUSD\b/.test(upper) || /\bUS\$/.test(upper) || rawText.includes('$')) currency = 'USD';
        else if (/\bEUR\b/.test(upper) || /\u20AC/.test(rawText)) currency = 'EUR';
        else if (/\bGBP\b/.test(upper) || /\u00A3/.test(rawText)) currency = 'GBP';
        else if (/\bJPY\b/.test(upper) || /\u00A5/.test(rawText)) currency = 'JPY';

        let numeric = rawText.replace(/[^\d.,-]/g, '');
        if (!numeric) return { amount: null, currency, rawText };

        if (numeric.includes(',') && numeric.includes('.')) {
            numeric = numeric.replace(/,/g, '');
        } else if (numeric.includes(',') && !numeric.includes('.')) {
            if (/,\d{2}$/.test(numeric)) {
                const lastComma = numeric.lastIndexOf(',');
                numeric = `${numeric.slice(0, lastComma).replace(/,/g, '')}.${numeric.slice(lastComma + 1)}`;
            } else {
                numeric = numeric.replace(/,/g, '');
            }
        }

        const amount = Number.parseFloat(numeric);
        return {
            amount: Number.isFinite(amount) ? amount : null,
            currency,
            rawText
        };
    },

    _estimateUsd(amount, currency) {
        if (!Number.isFinite(amount) || !currency) return null;
        const rates = {
            USD: 1,
            INR: 0.012,
            EUR: 1.08,
            GBP: 1.27,
            CAD: 0.74,
            JPY: 0.0067
        };
        const factor = rates[String(currency || '').toUpperCase()];
        if (!Number.isFinite(factor)) return null;
        return amount * factor;
    },

    _inferCurrencyFromRow(row = {}) {
        if (!row || typeof row !== 'object') return null;
        const blob = Object.values(row)
            .map(v => this._displayValue(v).toLowerCase())
            .join(' ');

        if (blob.includes('amazon.in') || /\bindia\b/.test(blob)) return 'INR';
        if (blob.includes('bestbuy.com') || blob.includes('amazon.com') || /\bunited states\b/.test(blob) || /\busa\b/.test(blob)) return 'USD';
        if (blob.includes('amazon.ca') || /\bcanada\b/.test(blob)) return 'CAD';
        return null;
    },

    _prepareComparisonRows(items = []) {
        const rows = (Array.isArray(items) ? items : [items]).map(item => this._coerceComparisonRow(item));
        const priceSignals = rows.map((row) => {
            const { key, value } = this._findPriceField(row);
            const parsed = this._parsePriceValue(value);
            const inferredCurrency = parsed.currency || this._inferCurrencyFromRow(row);
            const usdEstimate = this._estimateUsd(parsed.amount, inferredCurrency);
            return {
                key,
                rawText: parsed.rawText,
                currency: inferredCurrency,
                usdEstimate
            };
        });

        const currencies = new Set(priceSignals.map(s => s.currency).filter(Boolean));
        if (currencies.size <= 1) {
            return { items: rows, note: '', mixedCurrencies: false };
        }

        const currencyList = Array.from(currencies).sort().join(', ');
        const normalizedRows = rows.map((row, index) => {
            const signal = priceSignals[index] || {};
            const next = { ...row };

            if (!Object.prototype.hasOwnProperty.call(next, 'price_original')) {
                next.price_original = signal.rawText || (signal.key ? this._displayValue(row[signal.key]) : '');
            }
            if (!Object.prototype.hasOwnProperty.call(next, 'price_usd_est')) {
                next.price_usd_est = Number.isFinite(signal.usdEstimate)
                    ? `$${signal.usdEstimate.toFixed(2)} (est.)`
                    : 'N/A';
            }
            if (!Object.prototype.hasOwnProperty.call(next, 'price_currency') && signal.currency) {
                next.price_currency = signal.currency;
            }
            return next;
        });

        return {
            items: normalizedRows,
            note: `Mixed currencies detected (${currencyList}). USD estimates use fixed reference rates and are approximate.`,
            mixedCurrencies: true
        };
    },

    TEMPLATES: {
        'card-grid': (data, opts) => {
            const items = Array.isArray(data) ? data : [data];
            const title = opts.title || 'Results';
            const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

            const annotated = items.map((item, index) => {
                const safeItem = (item && typeof item === 'object') ? item : { value: item };
                const entries = Object.entries(safeItem);
                const hasLink = entries.some(([k, v]) => typeof v === 'string' && WebpageGenerator._isLikelyLinkFieldValue(k, v));
                const hasImage = entries.some(([k, v]) => typeof v === 'string' && WebpageGenerator._isLikelyImageFieldValue(k, v));
                const primaryLabel =
                    safeItem.title || safeItem.headline || safeItem.name || safeItem.text || safeItem.text_content || `Item ${index + 1}`;
                const urlValue = safeItem.url || safeItem.link || safeItem.href || '';
                const scoreValue = safeItem.score ?? safeItem.relevance ?? safeItem.similarity ?? safeItem.score_val ?? null;
                const scoreNum = Number.parseFloat(String(scoreValue ?? '').replace(/[^\d.-]/g, ''));
                const searchBlob = entries.map(([k, v]) => `${k}:${WebpageGenerator._displayValue(v)}`).join(' ').toLowerCase();
                return { safeItem, hasLink, hasImage, primaryLabel, urlValue, scoreValue, scoreNum, searchBlob };
            });

            const cards = annotated.map((row, index) => {
                const { safeItem, hasLink, hasImage, primaryLabel, urlValue, scoreValue, scoreNum, searchBlob } = row;
                const rawJson = esc(JSON.stringify(safeItem, null, 2));
                const fields = Object.entries(safeItem).map(([key, val]) => {
                    const renderedValue = WebpageGenerator._renderValueHtml(key, val, esc, 'card');
                    return `<div class="card-field"><span class="field-label">${esc(key)}:</span><div class="field-content">${renderedValue}</div></div>`;
                }).join('');
                const openButton = urlValue
                    ? `<a class="open-btn" href="${esc(urlValue)}" target="_blank" rel="noopener noreferrer">Open ${esc(primaryLabel)}</a>`
                    : '';
                const rawBlock = `<details class="raw-data"><summary>Raw Data</summary><pre>${rawJson}</pre></details>`;
                return `<article class="card" data-card data-index="${index}" data-title="${esc(String(primaryLabel).toLowerCase())}" data-search="${esc(searchBlob)}" data-has-link="${hasLink ? '1' : '0'}" data-has-image="${hasImage ? '1' : '0'}" data-score="${Number.isFinite(scoreNum) ? scoreNum : ''}">
<header class="card-head"><h3>${esc(primaryLabel)}</h3>${scoreValue !== null && scoreValue !== undefined ? `<span class="score-pill">${esc(scoreValue)}</span>` : ''}</header>
${fields}
${openButton}
${rawBlock}
</article>`;
            }).join('\n');

            const totalWithLinks = annotated.filter(x => x.hasLink).length;
            const totalWithImages = annotated.filter(x => x.hasImage).length;

            return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&family=Fraunces:opsz,wght@9..144,600&display=swap');
:root{--bg:#f6f9f7;--ink:#132b24;--ink-soft:#406058;--mint:#b9e9d6;--teal:#0f766e;--card-min:320px;--shadow:0 20px 45px rgba(15,48,40,.12)}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Space Grotesk',sans-serif;background:radial-gradient(circle at 12% -10%,#d4f4e5 0%,transparent 35%),radial-gradient(circle at 100% 0%,#d6f6ff 0%,transparent 30%),var(--bg);color:var(--ink);padding:20px}
.shell{max-width:1320px;margin:0 auto}
.hero{position:relative;background:linear-gradient(120deg,#113f36,#0d6b62 60%,#2ea89f);color:#effff8;padding:28px;border-radius:24px;overflow:hidden;box-shadow:var(--shadow)}
.hero:after{content:'';position:absolute;right:-40px;top:-35px;width:180px;height:180px;border-radius:50%;background:rgba(255,255,255,.16)}
.hero h1{font-family:'Fraunces',serif;font-size:clamp(1.8rem,3vw,2.5rem);letter-spacing:.2px}
.hero p{margin-top:10px;color:#d9fff0}
.controls{display:grid;grid-template-columns:1fr auto auto auto;gap:10px;background:#fff;border-radius:18px;padding:14px;margin-top:14px;box-shadow:0 8px 24px rgba(13,52,44,.08)}
.controls input,.controls select,.controls button{font:inherit;border:1px solid #d2e4db;border-radius:12px;padding:10px 12px;background:#fff;color:var(--ink)}
.controls button{cursor:pointer;background:#f5fcf8}
.controls button.active{background:#103f37;color:#fff;border-color:#103f37}
.slider-wrap{display:flex;align-items:center;gap:8px;color:var(--ink-soft);font-size:13px}
.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-top:14px}
.stat{background:#fff;border-radius:14px;padding:12px 14px;border:1px solid #d9ebe3}
.stat .k{font-size:12px;color:var(--ink-soft);text-transform:uppercase;letter-spacing:.6px}
.stat .v{font-size:22px;font-weight:700;margin-top:4px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(var(--card-min),1fr));gap:14px;margin-top:14px}
.card{background:#fff;border-radius:18px;padding:16px;border:1px solid #dcece6;box-shadow:0 10px 20px rgba(10,36,30,.07)}
.card-head{display:flex;justify-content:space-between;gap:10px;align-items:flex-start;margin-bottom:10px}
.card-head h3{font-size:18px;line-height:1.25}
.score-pill{display:inline-flex;padding:4px 8px;border-radius:999px;background:#e6fff6;color:#0d5a4c;font-size:12px;font-weight:700}
.card-field{margin-bottom:8px}
.field-label{font-weight:700;color:#2f5f54;text-transform:capitalize;display:block;font-size:12px;letter-spacing:.4px}
.field-content{margin-top:2px;word-break:break-word}
.field-image-wrap{display:flex;flex-direction:column;gap:6px}
.field-image{width:100%;max-height:220px;object-fit:cover;border-radius:10px;border:1px solid #d9ece5}
.field-url{display:inline-block;word-break:break-all;color:#0c6b61}
.raw-data{margin-top:10px;padding-top:10px;border-top:1px dashed #cbe0d7}
.raw-data summary{cursor:pointer;font-size:12px;color:#28564c;font-weight:700}
.raw-data pre{margin-top:8px;max-height:180px;overflow:auto;background:#f4fbf7;border-radius:8px;padding:10px;font-size:12px}
.open-btn{margin-top:10px;display:inline-flex;padding:9px 12px;border-radius:10px;background:#0e6d63;color:#fff !important;text-decoration:none;font-weight:700}
.hide-raw .raw-data{display:none}
.meta{text-align:center;color:#587a70;font-size:13px;margin-top:16px}
@media(max-width:980px){.controls{grid-template-columns:1fr 1fr}.stats{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:640px){body{padding:12px}.controls{grid-template-columns:1fr}.stats{grid-template-columns:1fr}}
</style></head><body>
<main class="shell">
<section class="hero"><h1>${esc(title)}</h1><p>Interactive dashboard with filters, tabs, and density controls.</p></section>
<section class="controls" id="controls">
<input id="queryInput" placeholder="Search across all fields..." />
<select id="sortSelect"><option value="default">Sort: Default</option><option value="title">Sort: Title</option><option value="score">Sort: Score</option></select>
<button id="toggleRawBtn" type="button">Toggle Raw JSON</button>
<div class="slider-wrap"><span>Card Size</span><input id="sizeRange" type="range" min="240" max="420" value="320"></div>
<button class="tab-btn active" data-tab="all" type="button">All</button>
<button class="tab-btn" data-tab="link" type="button">With Links</button>
<button class="tab-btn" data-tab="image" type="button">With Images</button>
<button class="tab-btn" data-tab="top" type="button">Top Score</button>
</section>
<section class="stats">
<div class="stat"><div class="k">Total</div><div class="v" id="statTotal">${items.length}</div></div>
<div class="stat"><div class="k">Visible</div><div class="v" id="statVisible">${items.length}</div></div>
<div class="stat"><div class="k">With Links</div><div class="v">${totalWithLinks}</div></div>
<div class="stat"><div class="k">With Images</div><div class="v">${totalWithImages}</div></div>
</section>
<section class="grid" id="cardGrid">${cards}</section>
<div class="meta">Generated by FunctionCreatorAI &middot; ${items.length} items &middot; ${new Date().toLocaleString()}</div>
</main>
<script>
(function(){
  const root=document.documentElement;
  const grid=document.getElementById('cardGrid');
  const cards=Array.from(grid.querySelectorAll('[data-card]'));
  const q=document.getElementById('queryInput');
  const sort=document.getElementById('sortSelect');
  const size=document.getElementById('sizeRange');
  const rawBtn=document.getElementById('toggleRawBtn');
  const statVisible=document.getElementById('statVisible');
  let tab='all';
  let hideRaw=false;
  function scoreOf(card){ const n=parseFloat(card.dataset.score || ''); return Number.isFinite(n)?n:-Infinity; }
  function matchesTab(card){
    if(tab==='link') return card.dataset.hasLink==='1';
    if(tab==='image') return card.dataset.hasImage==='1';
    if(tab==='top'){ const scores=cards.map(scoreOf).filter(v=>v>-Infinity); const max=scores.length?Math.max.apply(null,scores):-Infinity; return scoreOf(card)===max; }
    return true;
  }
  function render(){
    const query=(q.value||'').toLowerCase().trim();
    const visible=cards.filter(card => {
      const matchesQuery=!query || card.dataset.search.includes(query) || card.dataset.title.includes(query);
      const matchesFilter=matchesTab(card);
      const show=matchesQuery && matchesFilter;
      card.style.display=show?'':'none';
      return show;
    });
    const ordered=visible.slice();
    if(sort.value==='title'){ ordered.sort((a,b)=>a.dataset.title.localeCompare(b.dataset.title)); }
    if(sort.value==='score'){ ordered.sort((a,b)=>scoreOf(b)-scoreOf(a)); }
    ordered.forEach(card => grid.appendChild(card));
    statVisible.textContent=String(visible.length);
  }
  q.addEventListener('input', render);
  sort.addEventListener('change', render);
  size.addEventListener('input', () => { root.style.setProperty('--card-min', size.value + 'px'); });
  rawBtn.addEventListener('click', () => {
    hideRaw=!hideRaw;
    document.body.classList.toggle('hide-raw', hideRaw);
  });
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      tab=btn.dataset.tab || 'all';
      document.querySelectorAll('.tab-btn').forEach(x => x.classList.toggle('active', x===btn));
      render();
    });
  });
  render();
})();
</script>
</body></html>`;
        },

        'comparison-table': (data, opts) => {
            const rawItems = Array.isArray(data) ? data : [data];
            const prepared = WebpageGenerator._prepareComparisonRows(rawItems);
            const items = prepared.items;
            const title = opts.title || 'Comparison';
            const highlightColumn = opts.highlightColumn;
            const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

            if (items.length === 0) return '<html><body><p>No data</p></body></html>';
            const headers = Array.from(new Set(items.flatMap(row => Object.keys(row || {}))));

            const headerCells = headers.map(h => `<th>${esc(h)}</th>`).join('');
            const rows = items.map((row, ri) => {
                const cells = headers.map(h => {
                    const val = row[h];
                    const isHighlight = h === highlightColumn;
                    const cls = isHighlight ? ' class="highlight"' : '';
                    const renderedValue = WebpageGenerator._renderValueHtml(h, val, esc, 'table');
                    return `<td${cls}>${renderedValue}</td>`;
                }).join('');
                return `<tr>${cells}</tr>`;
            }).join('\n');

            const estimateNotice = prepared.note
                ? `<div class="notice">${esc(prepared.note)}</div>`
                : '';

            return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f0f2f5;padding:24px;color:#1a1a2e}
h1{text-align:center;margin-bottom:24px;color:#16213e}
.notice{max-width:1200px;margin:0 auto 14px;background:#fff7d6;border:1px solid #f4de8d;border-radius:10px;padding:10px 12px;color:#4e3b00;font-size:14px}
.table-wrap{max-width:1200px;margin:0 auto;overflow-x:auto;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.08)}
table{width:100%;border-collapse:collapse;background:white}
th{background:#4a90d9;color:white;padding:14px 16px;text-align:left;font-weight:600;text-transform:capitalize;position:sticky;top:0}
td{padding:12px 16px;border-bottom:1px solid #eee}
tr:nth-child(even){background:#f8f9fa}
tr:hover{background:#e3f2fd}
.highlight{font-weight:700;color:#d32f2f}
.field-image{width:120px;max-height:80px;object-fit:cover;border-radius:8px}
.field-image-wrap{display:flex;flex-direction:column;gap:6px}
.field-url{display:inline-block;word-break:break-all}
a{color:#0066cc;text-decoration:none}
.meta{text-align:center;color:#888;font-size:13px;margin-top:24px}
</style></head><body>
<h1>${esc(title)}</h1>
${estimateNotice}
<div class="table-wrap"><table><thead><tr>${headerCells}</tr></thead><tbody>${rows}</tbody></table></div>
<div class="meta">Generated by FunctionCreatorAI &middot; ${items.length} rows &middot; ${new Date().toLocaleString()}</div>
</body></html>`;
        },

        'timeline': (data, opts) => {
            const items = Array.isArray(data) ? data : [data];
            const title = opts.title || 'Timeline';
            const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

            const events = items.map((item, i) => {
                const heading = item.title || item.name || item.heading || `Item ${i + 1}`;
                const details = Object.entries(item)
                    .filter(([k]) => k !== 'title' && k !== 'name' && k !== 'heading')
                    .map(([k, v]) => `<div class="tl-detail"><strong>${esc(k)}:</strong> <span class="tl-value">${WebpageGenerator._renderValueHtml(k, v, esc, 'timeline')}</span></div>`)
                    .join('');
                const side = i % 2 === 0 ? 'left' : 'right';
                return `<div class="tl-item tl-${side}">
                    <div class="tl-content">
                        <div class="tl-number">${i + 1}</div>
                        <h3>${esc(heading)}</h3>
                        ${details}
                    </div>
                </div>`;
            }).join('\n');

            return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f0f2f5;padding:24px;color:#1a1a2e}
h1{text-align:center;margin-bottom:32px;color:#16213e}
.timeline{position:relative;max-width:900px;margin:0 auto;padding:20px 0}
.timeline::before{content:'';position:absolute;left:50%;width:3px;height:100%;background:#4a90d9;transform:translateX(-50%)}
.tl-item{position:relative;width:50%;padding:16px 40px;margin-bottom:20px}
.tl-left{left:0;text-align:right}
.tl-right{left:50%}
.tl-content{background:white;padding:20px;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.08);position:relative}
.tl-number{position:absolute;width:32px;height:32px;background:#4a90d9;color:white;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px}
.tl-left .tl-number{right:-56px;top:20px}
.tl-right .tl-number{left:-56px;top:20px}
.tl-content h3{color:#16213e;margin-bottom:8px;margin-top:0}
.tl-detail{margin-bottom:4px;color:#555;font-size:14px;text-align:left}
.tl-value .field-image{width:100%;max-height:140px;object-fit:cover;border-radius:8px}
.tl-value .field-image-wrap{display:flex;flex-direction:column;gap:6px}
.tl-value .field-url{display:inline-block;word-break:break-all}
.meta{text-align:center;color:#888;font-size:13px;margin-top:32px}
@media(max-width:768px){.timeline::before{left:20px}.tl-item{width:100%;left:0;padding-left:60px;text-align:left}.tl-left .tl-number,.tl-right .tl-number{left:-44px;right:auto}}
</style></head><body>
<h1>${esc(title)}</h1>
<div class="timeline">${events}</div>
<div class="meta">Generated by FunctionCreatorAI &middot; ${items.length} items &middot; ${new Date().toLocaleString()}</div>
</body></html>`;
        },

        'summary': (data, opts) => {
            const title = opts.title || 'Summary Report';
            const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

            const rawJson = esc(JSON.stringify(data, null, 2));

            let bodyContent = '';
            let itemCount = 1;
            if (typeof data === 'string') {
                bodyContent = `<article class="panel-card"><h2>Summary</h2><p class="lead">${esc(data).replace(/\n/g, '<br>')}</p></article>`;
            } else if (Array.isArray(data)) {
                itemCount = data.length;
                bodyContent = data.map((section, i) => {
                    if (typeof section === 'string') {
                        return `<article class="panel-card"><h2>Section ${i + 1}</h2><p>${esc(section)}</p></article>`;
                    }
                    const heading = section.title || section.heading || section.name || `Section ${i + 1}`;
                    const content = section.content || section.text || section.description || '';
                    const keyPoints = section.keyPoints || section.points || [];
                    const skipKeys = new Set(['title', 'heading', 'name', 'content', 'text', 'description', 'keyPoints', 'points']);
                    const extraFields = Object.entries(section || {}).filter(([k]) => !skipKeys.has(k));
                    return `<article class="panel-card">
<h2>${esc(heading)}</h2>
${content ? `<p>${esc(content).replace(/\n/g, '<br>')}</p>` : ''}
${keyPoints.length > 0 ? `<ul>${keyPoints.map(p => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
${extraFields.length > 0 ? `<div class="extra-fields">${extraFields.map(([k, v]) => `<div class="extra-field"><strong>${esc(k)}:</strong> ${WebpageGenerator._renderValueHtml(k, v, esc, 'summary')}</div>`).join('')}</div>` : ''}
</article>`;
                }).join('\n');
            } else if (data && typeof data === 'object') {
                itemCount = Object.keys(data).length;
                bodyContent = '<section class="kv-grid">' + Object.entries(data).map(([k, v]) =>
                    `<article class="kv-item"><div class="kv-key">${esc(k)}</div><div class="kv-value">${WebpageGenerator._renderValueHtml(k, v, esc, 'summary')}</div></article>`
                ).join('') + '</section>';
            } else {
                bodyContent = `<article class="panel-card"><h2>No Data</h2><p>Summary template received an empty payload.</p></article>`;
            }

            return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&family=Fraunces:opsz,wght@9..144,600&display=swap');
:root{--bg:#fbfaf4;--ink:#2f2418;--ink-soft:#6a5640;--accent:#af5f18;--accent-2:#f0b24a;--type-scale:1}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Space Grotesk',sans-serif;background:radial-gradient(circle at -10% -20%,#ffe9c6 0%,transparent 35%),radial-gradient(circle at 100% 0%,#f7e8d1 0%,transparent 26%),var(--bg);color:var(--ink);padding:20px;font-size:calc(16px * var(--type-scale))}
.shell{max-width:1060px;margin:0 auto}
.hero{background:linear-gradient(120deg,#4a2f17,#90501f 60%,#cd8a2f);color:#fff7ef;border-radius:22px;padding:26px;box-shadow:0 20px 44px rgba(79,46,16,.2)}
.hero h1{font-family:'Fraunces',serif;font-size:clamp(1.8rem,3vw,2.6rem)}
.hero p{margin-top:8px;color:#ffe7cc}
.toolbar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;background:#fff;border:1px solid #f1e0cd;border-radius:16px;padding:12px;margin-top:14px}
.toolbar button,.toolbar input{font:inherit}
.tab-btn{border:1px solid #d6b999;background:#fff8ef;padding:8px 12px;border-radius:999px;cursor:pointer;color:#6d4929}
.tab-btn.active{background:#5f3819;color:#fff;border-color:#5f3819}
.slider-wrap{margin-left:auto;display:flex;align-items:center;gap:8px;color:var(--ink-soft);font-size:13px}
.stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:12px}
.stat{background:#fff;border:1px solid #efdac2;border-radius:14px;padding:12px}
.stat .k{font-size:12px;color:#7b6146;text-transform:uppercase;letter-spacing:.6px}
.stat .v{font-size:24px;font-weight:700;margin-top:4px}
.panel{margin-top:14px}
.panel[data-hidden="1"]{display:none}
.panel-card{background:#fff;border:1px solid #efdeca;border-radius:16px;padding:18px;box-shadow:0 10px 24px rgba(61,43,22,.08);margin-bottom:12px}
.panel-card h2{font-family:'Fraunces',serif;font-size:1.28rem;color:#57361c;margin-bottom:8px}
.panel-card p,.panel-card li{line-height:1.65;color:#443321}
.lead{font-size:1.05em}
.panel-card ul{margin:8px 0 0 20px}
.extra-fields{margin-top:10px;padding-top:10px;border-top:1px dashed #dcc3a7}
.extra-field{margin-bottom:5px}
.kv-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px}
.kv-item{background:#fff;border:1px solid #efdcc5;border-radius:16px;padding:14px}
.kv-key{font-weight:700;color:#7a4f2a;text-transform:capitalize}
.kv-value{margin-top:4px;color:#473628;line-height:1.5;word-break:break-word}
.field-image{width:100%;max-height:160px;object-fit:cover;border-radius:8px;border:1px solid #ead8c3}
.field-image-wrap{display:flex;flex-direction:column;gap:6px}
.field-url{display:inline-block;color:#94571f;word-break:break-all}
pre.raw{background:#22160d;color:#f8e8cf;padding:16px;border-radius:14px;overflow:auto;max-height:420px;font-size:12px;line-height:1.45}
.meta{text-align:center;color:#8e7152;font-size:13px;margin-top:16px}
@media(max-width:760px){body{padding:12px}.stats{grid-template-columns:1fr}.slider-wrap{margin-left:0}}
</style></head><body>
<main class="shell">
<section class="hero"><h1>${esc(title)}</h1><p>Rich summary view with tabs and readability controls.</p></section>
<section class="toolbar">
<button class="tab-btn active" data-tab-target="overview" type="button">Overview</button>
<button class="tab-btn" data-tab-target="raw" type="button">Raw Data</button>
<div class="slider-wrap"><span>Text Size</span><input id="typeScale" type="range" min="85" max="120" step="1" value="100"></div>
</section>
<section class="stats">
<div class="stat"><div class="k">Primary Items</div><div class="v">${itemCount}</div></div>
<div class="stat"><div class="k">Data Type</div><div class="v">${Array.isArray(data) ? 'Array' : (typeof data === 'object' ? 'Object' : typeof data)}</div></div>
<div class="stat"><div class="k">Generated</div><div class="v">${new Date().toLocaleTimeString()}</div></div>
</section>
<section class="panel" id="panel-overview">${bodyContent}</section>
<section class="panel" id="panel-raw" data-hidden="1"><pre class="raw">${rawJson}</pre></section>
<div class="meta">Generated by FunctionCreatorAI &middot; ${new Date().toLocaleString()}</div>
</main>
<script>
(function(){
  const btns=Array.from(document.querySelectorAll('.tab-btn'));
  const panelOverview=document.getElementById('panel-overview');
  const panelRaw=document.getElementById('panel-raw');
  const scale=document.getElementById('typeScale');
  function show(tab){
    const isOverview=tab==='overview';
    panelOverview.dataset.hidden=isOverview?'0':'1';
    panelRaw.dataset.hidden=isOverview?'1':'0';
    btns.forEach(btn => btn.classList.toggle('active', btn.dataset.tabTarget===tab));
  }
  btns.forEach(btn => btn.addEventListener('click', () => show(btn.dataset.tabTarget || 'overview')));
  scale.addEventListener('input', () => {
    const value = Math.min(120, Math.max(85, parseInt(scale.value || '100', 10)));
    document.documentElement.style.setProperty('--type-scale', String(value / 100));
  });
  show('overview');
})();
</script>
</body></html>`;
        }
    }
};

// Register as tool
if (typeof ToolRegistry !== 'undefined') {
    ToolRegistry.register('webpage_generator', {
        description: 'Generate HTML dashboard pages from JSON data. Templates: card-grid, comparison-table, timeline, summary.',
        capabilities: ['visualization', 'dashboard', 'html', 'report', 'ui'],
        parameters: {
            type: 'OBJECT',
            properties: {
                dataset: { description: 'JSON data to visualize (array of objects or single object)' },
                templateType: { type: 'STRING', enum: ['card-grid', 'comparison-table', 'timeline', 'summary'] },
                options: {
                    type: 'OBJECT',
                    properties: {
                        title: { type: 'STRING' },
                        highlightColumn: { type: 'STRING' }
                    }
                }
            },
            required: ['dataset', 'templateType']
        },
        execute: async (params, context) => WebpageGenerator.generate(params, context.tabId)
    });
}

if (typeof self !== 'undefined') self.WebpageGenerator = WebpageGenerator;
