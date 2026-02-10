// Site Modifier - Inject CSS/JS into active tab to hide, highlight, or filter content
// Uses chrome.scripting API for safe injection

const SiteModifier = {
    _normalizeSelectorValue(value) {
        if (typeof value === 'string') {
            const trimmed = value.trim();
            return trimmed || '';
        }
        if (Array.isArray(value)) {
            const selectors = value
                .map(item => this._normalizeSelectorValue(item))
                .filter(Boolean);
            return selectors.join(', ');
        }
        if (!value || typeof value !== 'object') return '';

        const directKeys = [
            'selector',
            'cssSelector',
            'containerSelector',
            'targetSelector',
            'videoSelector',
            'itemSelector'
        ];
        for (const key of directKeys) {
            if (typeof value[key] === 'string' && value[key].trim()) {
                return value[key].trim();
            }
        }

        if (Array.isArray(value.selectors)) {
            return this._normalizeSelectorValue(value.selectors);
        }
        if (Array.isArray(value.results)) {
            const fromResults = value.results
                .map(item => this._normalizeSelectorValue(item))
                .filter(Boolean)
                .join(', ');
            if (fromResults) return fromResults;
        }

        return '';
    },

    _normalizeIndices(value) {
        const values = [];
        if (Array.isArray(value)) {
            values.push(...value);
        } else if (value && typeof value === 'object') {
            if (Array.isArray(value.indices)) values.push(...value.indices);
            if (Array.isArray(value.results)) values.push(...value.results);
            if (Array.isArray(value.matches)) values.push(...value.matches);
            if (Array.isArray(value.rankings)) values.push(...value.rankings);
        } else if (typeof value === 'number') {
            values.push(value);
        }

        const parsed = values
            .map(item => {
                if (typeof item === 'number') return item;
                if (item && typeof item === 'object') {
                    if (Number.isFinite(item.index)) return item.index;
                    if (Number.isFinite(item.itemIndex)) return item.itemIndex;
                    if (Number.isFinite(item.containerIndex)) return item.containerIndex;
                }
                const asNumber = Number(item);
                return Number.isFinite(asNumber) ? asNumber : NaN;
            })
            .filter(n => Number.isFinite(n) && n >= 0)
            .map(n => Math.floor(n));

        return Array.from(new Set(parsed));
    },

    _normalizeFilterCriteria(value) {
        const src = value && typeof value === 'object' ? value : {};
        const contains = typeof src.contains === 'string' ? src.contains : '';
        const notContains = typeof src.notContains === 'string' ? src.notContains : '';
        const matchesRegex = typeof src.matchesRegex === 'string' ? src.matchesRegex : '';
        const hideMatched = src.hideMatched === undefined ? true : !!src.hideMatched;
        return { contains, notContains, matchesRegex, hideMatched };
    },

    async modify(params, tabId) {
        const rawAction = String(params?.action || '').trim();
        const actionAlias = {
            hide: 'hideElements',
            remove: 'hideElements',
            hideElement: 'hideElements',
            hide_elements: 'hideElements',
            highlight: 'highlightElements',
            highlightElement: 'highlightElements',
            highlight_elements: 'highlightElements',
            inject_css: 'injectCSS',
            inject_js: 'injectJS',
            filter: 'filterContent',
            filter_text: 'filterContent',
            hide_by_indices: 'hideByIndices'
        };
        const action = actionAlias[rawAction] || rawAction;
        const selector = this._normalizeSelectorValue(
            params?.selector
            ?? params?.selectors
            ?? params?.containerSelector
            ?? params?.targetSelector
            ?? params?.videoSelector
            ?? params?.itemSelector
        );

        switch (action) {
            case 'hideElements':
                return await this._hideElements(tabId, selector);

            case 'highlightElements':
                return await this._highlightElements(tabId, selector, params.color || 'red');

            case 'injectCSS':
                return await this._injectCSS(tabId, params.css);

            case 'removeCSS':
                return await this._removeCSS(tabId, params.css);

            case 'injectJS':
                return await this._injectJS(tabId, params.code);

            case 'filterContent':
                return await this._filterByText(tabId, selector, this._normalizeFilterCriteria(params.filterCriteria));

            case 'filterBySimilarity':
                return await this._filterBySimilarity(tabId, selector, params.bannedTexts, params.threshold || 0.5);

            case 'hideByIndices':
                return await this.hideByIndices(tabId, selector, this._normalizeIndices(params.indices || params.matches || params.results));

            default:
                return { success: false, error: `Unknown site modifier action: ${rawAction || action}` };
        }
    },

    async _hideElements(tabId, selector) {
        if (!selector || typeof selector !== 'string') {
            return { success: false, error: 'Missing selector for hideElements' };
        }
        try {
            await chrome.scripting.insertCSS({
                target: { tabId },
                css: `${selector} { display: none !important; }`
            });
            return { success: true, action: 'hideElements', selector };
        } catch (e) {
            return { success: false, error: e.message };
        }
    },

    async _highlightElements(tabId, selector, color) {
        if (!selector || typeof selector !== 'string') {
            return { success: false, error: 'Missing selector for highlightElements' };
        }
        const colorMap = {
            red: { outline: '#ff0000', bg: 'rgba(255,0,0,0.1)' },
            green: { outline: '#00cc00', bg: 'rgba(0,204,0,0.1)' },
            blue: { outline: '#0066ff', bg: 'rgba(0,102,255,0.1)' },
            yellow: { outline: '#ffcc00', bg: 'rgba(255,204,0,0.15)' },
            orange: { outline: '#ff6600', bg: 'rgba(255,102,0,0.1)' }
        };
        const c = colorMap[color] || colorMap.red;

        try {
            await chrome.scripting.insertCSS({
                target: { tabId },
                css: `${selector} { outline: 3px solid ${c.outline} !important; background: ${c.bg} !important; }`
            });
            return { success: true, action: 'highlightElements', selector, color };
        } catch (e) {
            return { success: false, error: e.message };
        }
    },

    async _injectCSS(tabId, css) {
        try {
            await chrome.scripting.insertCSS({ target: { tabId }, css });
            return { success: true, action: 'injectCSS' };
        } catch (e) {
            return { success: false, error: e.message };
        }
    },

    async _removeCSS(tabId, css) {
        try {
            await chrome.scripting.removeCSS({ target: { tabId }, css });
            return { success: true, action: 'removeCSS' };
        } catch (e) {
            return { success: false, error: e.message };
        }
    },

    async _injectJS(tabId, code) {
        try {
            const [result] = await chrome.scripting.executeScript({
                target: { tabId },
                func: (jsCode) => {
                    try {
                        const fn = new Function(jsCode);
                        return { success: true, result: fn() };
                    } catch (e) {
                        return { success: false, error: e.message };
                    }
                },
                args: [code]
            });
            return result?.result || { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    },

    async _filterByText(tabId, selector, criteria) {
        // criteria: { contains, notContains, matchesRegex, hideMatched }
        if (!selector || typeof selector !== 'string') {
            return { success: false, error: 'Missing selector for filterContent' };
        }
        const normalizedCriteria = this._normalizeFilterCriteria(criteria);
        try {
            const [result] = await chrome.scripting.executeScript({
                target: { tabId },
                func: (sel, crit) => {
                    const elements = document.querySelectorAll(sel);
                    let hidden = 0;
                    let shown = 0;
                    elements.forEach(el => {
                        const text = el.innerText || el.textContent || '';
                        let shouldHide = false;

                        if (crit.contains && !text.toLowerCase().includes(crit.contains.toLowerCase())) {
                            shouldHide = true;
                        }
                        if (crit.notContains && text.toLowerCase().includes(crit.notContains.toLowerCase())) {
                            shouldHide = true;
                        }
                        if (crit.matchesRegex) {
                            try {
                                const matched = new RegExp(crit.matchesRegex, 'i').test(text);
                                if (crit.hideMatched ? matched : !matched) shouldHide = true;
                            } catch (e) { /* invalid regex, skip */ }
                        }

                        if (shouldHide) {
                            el.style.display = 'none';
                            hidden++;
                        } else {
                            shown++;
                        }
                    });
                    return { success: true, total: elements.length, hidden, shown };
                },
                args: [selector, normalizedCriteria]
            });
            return result?.result || { success: false };
        } catch (e) {
            return { success: false, error: e.message };
        }
    },

    // Filter by semantic similarity using embedding scores
    // bannedTexts: array of strings. Elements whose text is similar to any banned text get hidden.
    async _filterBySimilarity(tabId, selector, bannedTexts, threshold) {
        // First extract all element texts
        try {
            const [textsResult] = await chrome.scripting.executeScript({
                target: { tabId },
                func: (sel) => {
                    const elements = document.querySelectorAll(sel);
                    return Array.from(elements).map((el, i) => ({
                        index: i,
                        text: (el.innerText || el.textContent || '').trim().substring(0, 200)
                    }));
                },
                args: [selector]
            });

            const elementTexts = textsResult?.result || [];
            if (elementTexts.length === 0) return { success: true, hidden: 0, message: 'No elements found' };

            // This method requires EmbeddingService, so we just return the indices to hide
            // The orchestrator should call embedding_handler first, then pass scores here
            return {
                success: true,
                elementTexts,
                message: 'Use embedding_handler to compare texts, then call filterContent with results'
            };
        } catch (e) {
            return { success: false, error: e.message };
        }
    },

    // Utility: hide specific element indices
    async hideByIndices(tabId, selector, indices) {
        const normalizedSelector = this._normalizeSelectorValue(selector);
        const normalizedIndices = this._normalizeIndices(indices);
        if (!normalizedSelector) {
            return { success: false, error: 'Missing selector for hideByIndices' };
        }
        if (!normalizedIndices.length) {
            return { success: true, hidden: 0, warning: 'No valid indices to hide' };
        }
        try {
            const [result] = await chrome.scripting.executeScript({
                target: { tabId },
                func: (sel, idxs) => {
                    const elements = document.querySelectorAll(sel);
                    let hidden = 0;
                    idxs.forEach(i => {
                        if (elements[i]) {
                            elements[i].style.display = 'none';
                            hidden++;
                        }
                    });
                    return { success: true, hidden };
                },
                args: [normalizedSelector, normalizedIndices]
            });
            return result?.result || { success: false };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }
};

// Register as tool
if (typeof ToolRegistry !== 'undefined') {
    ToolRegistry.register('site_modifier', {
        description: 'Inject CSS/JS into active tab to hide, highlight, or filter page content',
        capabilities: ['css-injection', 'js-injection', 'filtering', 'hiding', 'highlighting'],
        parameters: {
            type: 'OBJECT',
            properties: {
                action: { type: 'STRING', enum: ['hideElements', 'highlightElements', 'injectCSS', 'removeCSS', 'injectJS', 'filterContent', 'hideByIndices', 'hide', 'remove', 'highlight', 'inject_css', 'inject_js', 'filter'] },
                selector: { type: 'STRING' },
                css: { type: 'STRING' },
                code: { type: 'STRING' },
                color: { type: 'STRING', enum: ['red', 'green', 'blue', 'yellow', 'orange'] },
                filterCriteria: {
                    type: 'OBJECT',
                    properties: {
                        contains: { type: 'STRING' },
                        notContains: { type: 'STRING' },
                        matchesRegex: { type: 'STRING' },
                        hideMatched: { type: 'BOOLEAN' }
                    }
                },
                indices: { type: 'ARRAY', items: { type: 'NUMBER' } }
            },
            required: ['action']
        },
        execute: async (params, context) => {
            if (params.action === 'hideByIndices') {
                return await SiteModifier.hideByIndices(
                    context.tabId,
                    SiteModifier._normalizeSelectorValue(
                        params?.selector
                        ?? params?.selectors
                        ?? params?.containerSelector
                        ?? params?.targetSelector
                        ?? params?.videoSelector
                        ?? params?.itemSelector
                    ),
                    SiteModifier._normalizeIndices(params.indices || params.matches || params.results)
                );
            }
            return await SiteModifier.modify(params, context.tabId);
        }
    });
}

if (typeof self !== 'undefined') self.SiteModifier = SiteModifier;
