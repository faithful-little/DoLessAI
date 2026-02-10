/**
 * AI Task Service - Natural Language Function Generator
 *
 * Orchestrator that takes a natural language task description and generates
 * a complete, tested, reusable automation function. Composes:
 * - AIService (Gemini API calls, agentic scraping, test generation, verification)
 * - ComputerUseService (visual screenshot-based browser navigation)
 *
 * Flow: planTask -> generateSteps -> preflight/scrape -> test -> save
 */
const AITaskService = {

    WORKFLOW_DETECTION_PATTERNS: [
        /for each/i,
        /loop over/i,
        /visit each/i,
        /get details from multiple/i,
        /from every/i,
        /all\b.*\bpages?\b/i,
        /including\b.*\bfrom\b/i,
        /with\b.*\bdetails\b.*\bfrom/i,
        /and\b.*\bfrom\b.*\bpage/i,
        /go to each/i,
        /open each/i,
        /click on each/i,
        /then\b.*\bextract\b.*\bfrom\b.*\beach/i
    ],

    // ==================== WORKFLOW DETECTION ====================

    /**
     * Detect whether a task requires a workflow (multiple sub-functions coordinating
     * across different pages) vs a single function.
     */
    async detectWorkflowNeeds(taskDescription, apiKey) {
        // Quick pattern check
        const hasWorkflowPattern = this.WORKFLOW_DETECTION_PATTERNS.some(
            pattern => pattern.test(taskDescription)
        );

        if (!hasWorkflowPattern) {
            return { needsWorkflow: false, reasoning: 'Single-page task detected' };
        }

        // AI confirmation
        const prompt = `Analyze this automation task: "${taskDescription}"

Does this require a WORKFLOW (multiple sub-functions coordinating across different pages)?

WORKFLOW indicators:
- Needs to visit multiple DIFFERENT pages (e.g., search results page + each individual item page)
- Aggregates data from different page types
- "For each" pattern: get a list, then visit each item individually
- Multiple distinct actions on fundamentally different pages

SINGLE FUNCTION indicators:
- All actions happen on ONE page (or same page type)
- Simple search/extraction with scroll-and-load-more on same page
- Just navigating to a URL and extracting data

Reply with JSON:
{
  "needsWorkflow": true or false,
  "reasoning": "brief 10-word max explanation"
}`;

        try {
            const result = await AIService.callGemini({
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                generationConfig: {
                    responseMimeType: 'application/json',
                    maxOutputTokens: 512
                }
            }, apiKey);

            return result || { needsWorkflow: hasWorkflowPattern, reasoning: 'AI returned empty' };
        } catch (e) {
            console.warn('[Workflow] detectWorkflowNeeds AI check failed:', e.message);
            // If AI check fails, use pattern-based result
            return { needsWorkflow: hasWorkflowPattern, reasoning: 'Pattern-based detection (AI check failed)' };
        }
    },

    // ==================== TOOL CHAIN DETECTION ====================

    /**
     * Detect whether a task should use the Tool Orchestrator (multi-tool chain)
     * instead of the standard function generation pipeline.
     * Tool chains are used for: filtering, embeddings, file export, page modification,
     * comparisons, dashboards, local LLM usage, persistent state tracking.
     */
    detectToolNeeds(taskDescription) {
        if (typeof ToolOrchestrator !== 'undefined') {
            return ToolOrchestrator.detectToolNeeds(taskDescription);
        }
        return { needsTools: false };
    },

    async _loadFunctionLibrary() {
        if (typeof FunctionLibraryService !== 'undefined') {
            return await FunctionLibraryService.getAll();
        }
        const storage = await chrome.storage.local.get(['generatedFunctions']);
        return storage.generatedFunctions || {};
    },

    async _saveFunctionLibrary(functions) {
        if (typeof FunctionLibraryService !== 'undefined') {
            return await FunctionLibraryService.setAll(functions || {});
        }
        const normalized = (functions && typeof functions === 'object') ? functions : {};
        await chrome.storage.local.set({ generatedFunctions: normalized });
        return normalized;
    },

    async _upsertFunctionDef(functionDef, options = { unique: false }) {
        if (typeof FunctionLibraryService !== 'undefined') {
            return await FunctionLibraryService.upsert(functionDef, options || { unique: false });
        }
        const all = await this._loadFunctionLibrary();
        const name = functionDef?.name || `Generated_${Date.now()}`;
        all[name] = { ...functionDef, name };
        await this._saveFunctionLibrary(all);
        return { name, functionDef: all[name], allFunctions: all, renamed: false };
    },

    _buildSmokeTestInputs(inputDefs = []) {
        const defs = Array.isArray(inputDefs) ? inputDefs : [];
        const inputs = {};

        for (const def of defs) {
            if (!def?.name) continue;
            if (def.defaultValue !== undefined && def.defaultValue !== null && String(def.defaultValue).trim() !== '') {
                const raw = String(def.defaultValue).trim();
                if (def.type === 'number') {
                    const n = Number(raw);
                    inputs[def.name] = Number.isFinite(n) ? n : 1;
                } else if (def.type === 'boolean') {
                    inputs[def.name] = /^(true|1|yes)$/i.test(raw);
                } else {
                    inputs[def.name] = raw;
                }
                continue;
            }

            const lname = String(def.name).toLowerCase();
            if (def.type === 'number') inputs[def.name] = 1;
            else if (def.type === 'boolean') inputs[def.name] = true;
            else if (lname.includes('url')) inputs[def.name] = 'https://example.com';
            else if (lname.includes('query') || lname.includes('search') || lname.includes('keyword')) inputs[def.name] = 'test';
            else inputs[def.name] = 'test';
        }

        return inputs;
    },

    _ensureAtLeastOneTestCase(functionDef, testCases = []) {
        if (Array.isArray(testCases) && testCases.length > 0) return testCases;
        return [{
            name: 'Smoke Test',
            inputs: this._buildSmokeTestInputs(functionDef?.inputs || []),
            expectedOutcome: 'Function runs successfully and returns usable output'
        }];
    },

    _isInternalPageUrl(url) {
        return !url
            || url.startsWith('chrome://')
            || url.startsWith('edge://')
            || url.startsWith('about:')
            || url.startsWith('chrome-extension://');
    },

    async _getCurrentContextUrl() {
        try {
            const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (activeTab?.url && !this._isInternalPageUrl(activeTab.url)) {
                return activeTab.url;
            }
            const tabs = await chrome.tabs.query({ active: true });
            const fallback = (tabs || [])
                .find(tab => tab?.url && !this._isInternalPageUrl(tab.url));
            return fallback?.url || '';
        } catch {
            return '';
        }
    },

    _taskMentionsCurrentTab(taskDescription = '') {
        const text = String(taskDescription || '').toLowerCase();
        return /\b(this page|current tab|current page|on this tab|on this page|already open tab|open tab)\b/.test(text);
    },

    async _getCurrentTabContext(maxChars = 4000) {
        const cappedMaxChars = Math.max(1000, Math.min(Number(maxChars) || 4000, 12000));
        try {
            let [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!activeTab?.id || this._isInternalPageUrl(activeTab.url)) {
                const allActiveTabs = await chrome.tabs.query({ active: true });
                activeTab = (allActiveTabs || [])
                    .filter(tab => tab?.id && !this._isInternalPageUrl(tab.url))
                    .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0] || activeTab;
            }
            if (!activeTab?.id || this._isInternalPageUrl(activeTab.url)) return null;

            const [result] = await chrome.scripting.executeScript({
                target: { tabId: activeTab.id },
                func: (limit) => {
                    const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
                    const headings = Array.from(document.querySelectorAll('h1,h2,h3'))
                        .slice(0, 12)
                        .map(el => (el.innerText || '').trim())
                        .filter(Boolean);
                    return {
                        url: location.href,
                        title: document.title || '',
                        headings,
                        bodyTextPreview: bodyText.slice(0, limit),
                        bodyTextLength: bodyText.length
                    };
                },
                args: [cappedMaxChars]
            });

            const snapshot = result?.result;
            if (!snapshot || typeof snapshot !== 'object') return null;
            return {
                tabId: activeTab.id,
                windowId: activeTab.windowId,
                ...snapshot
            };
        } catch {
            return null;
        }
    },

    _formatCurrentTabContextForPrompt(context = null, maxChars = 2600) {
        if (!context || typeof context !== 'object') return '';
        const headings = Array.isArray(context.headings) ? context.headings.slice(0, 8) : [];
        const headingText = headings.length > 0 ? headings.join(' | ') : '(none)';
        const bodyPreview = String(context.bodyTextPreview || '').trim();
        const lines = [
            `URL: ${context.url || ''}`,
            `Title: ${context.title || ''}`,
            `Headings: ${headingText}`,
            `Body preview: ${bodyPreview}`,
            `Body length: ${Number(context.bodyTextLength) || 0}`
        ];
        const combined = lines.join('\n');
        return combined.length > maxChars ? `${combined.slice(0, maxChars - 15)}...[truncated]` : combined;
    },

    _normalizePatternList(urlPatterns) {
        if (Array.isArray(urlPatterns)) {
            return urlPatterns.map(p => String(p || '').trim()).filter(Boolean);
        }
        if (typeof urlPatterns === 'string') {
            return urlPatterns
                .split(',')
                .map(p => p.trim())
                .filter(Boolean);
        }
        return [];
    },

    _patternToRegex(pattern) {
        if (!pattern) return null;
        const escaped = String(pattern)
            .trim()
            .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*');
        if (!escaped) return null;
        try {
            return new RegExp(`^${escaped}$`, 'i');
        } catch {
            return null;
        }
    },

    _hostnameFromPattern(pattern) {
        const raw = String(pattern || '').trim();
        if (!raw) return '';
        try {
            const normalized = raw.includes('://') ? raw : `https://${raw}`;
            return new URL(normalized.replace(/\*/g, 'x')).hostname || '';
        } catch {
            return '';
        }
    },

    _urlMatchesPattern(url, pattern) {
        if (!url || !pattern) return false;
        const p = String(pattern).trim();
        if (!p) return false;

        if (
            p === '<all_urls>' ||
            p === '*://*/*' ||
            p === 'http://*/*' ||
            p === 'https://*/*'
        ) {
            return true;
        }

        const regex = this._patternToRegex(p);
        if (regex && regex.test(url)) return true;

        try {
            const u = new URL(url);
            const ph = this._hostnameFromPattern(p);
            return !!(ph && u.hostname && (u.hostname === ph || u.hostname.endsWith(`.${ph}`)));
        } catch {
            return false;
        }
    },

    _isFunctionRelevantToUrl(func, currentUrl) {
        if (!func || typeof func !== 'object' || !currentUrl) return false;
        const patterns = this._normalizePatternList(func.urlPatterns);
        if (patterns.length === 0) return false;
        return patterns.some(pattern => this._urlMatchesPattern(currentUrl, pattern));
    },

    _filterFunctionsForCurrentUrl(existingFunctions = {}, currentUrl = '') {
        if (!existingFunctions || typeof existingFunctions !== 'object') return {};
        if (!currentUrl) return {};

        const entries = Object.entries(existingFunctions);
        const filtered = entries.filter(([, func]) => this._isFunctionRelevantToUrl(func, currentUrl));
        return Object.fromEntries(filtered);
    },

    _requiresCurrentPageForTesting(functionDef) {
        if (functionDef?.requiresCurrentTab === true) return true;
        if (String(functionDef?.navigationStrategy || '').toLowerCase() === 'current-tab') return true;
        const steps = Array.isArray(functionDef?.steps) ? functionDef.steps : [];
        if (steps.length === 0) return false;
        const firstActionable = steps.find(step => step && step.type && step.type !== 'wait');
        return firstActionable?.type === 'computerUseNavigate';
    },

    async _createTestExecutionContext(functionDef, showTestsForeground = true, onStatusUpdate = () => {}) {
        if (this._requiresCurrentPageForTesting(functionDef)) {
            let [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });

            if (!activeTab?.id || this._isInternalPageUrl(activeTab.url)) {
                const allActiveTabs = await chrome.tabs.query({ active: true });
                activeTab = (allActiveTabs || [])
                    .filter(tab => tab?.id && !this._isInternalPageUrl(tab.url))
                    .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0] || activeTab;
            }

            if (!activeTab?.id) {
                throw new Error('No active tab available for current-tab test');
            }

            if (this._isInternalPageUrl(activeTab.url)) {
                throw new Error('Current-tab tests need a regular webpage tab (http/https), not an internal page.');
            }
            onStatusUpdate(`Using current page for test context: ${activeTab.url}`);

            return {
                tabId: activeTab.id,
                windowId: activeTab.windowId,
                tempWindowId: null
            };
        }

        const windowState = showTestsForeground ? 'normal' : 'minimized';
        const testWindow = await chrome.windows.create({
            url: 'about:blank',
            type: 'normal',
            state: windowState
        });
        const testTabId = testWindow?.tabs?.[0]?.id;
        if (!testTabId) {
            throw new Error('Failed to create test tab');
        }
        await new Promise(r => setTimeout(r, 500));

        return {
            tabId: testTabId,
            windowId: testWindow.id,
            tempWindowId: testWindow.id
        };
    },

    async _captureTestScreenshot(windowId, tabId = null) {
        if (!windowId && !Number.isInteger(tabId)) return null;
        try {
            let captureWindowId = windowId;
            if (Number.isInteger(tabId)) {
                try {
                    const tab = await chrome.tabs.get(tabId);
                    if (tab?.windowId) captureWindowId = tab.windowId;
                } catch {}
            }

            if (!captureWindowId) return null;
            await chrome.windows.update(captureWindowId, { focused: true, state: 'normal' });
            if (Number.isInteger(tabId)) {
                try {
                    await chrome.tabs.update(tabId, { active: true });
                    await this._waitForTabComplete(tabId, 6000);
                } catch {}
            }
            await new Promise(r => setTimeout(r, 600));
            return await new Promise(resolve => {
                chrome.tabs.captureVisibleTab(captureWindowId, { format: 'png' }, (url) => {
                    resolve(chrome.runtime.lastError ? null : url);
                });
            });
        } catch {
            return null;
        }
    },

    _extractLikelyUrlFromInputs(inputs = {}) {
        if (!inputs || typeof inputs !== 'object') return '';
        const entries = Object.entries(inputs);
        const byName = entries
            .filter(([k, v]) => /url/i.test(String(k)) && typeof v === 'string' && /^https?:\/\//i.test(v.trim()))
            .map(([, v]) => v.trim());
        if (byName.length > 0) return byName[0];

        const anyUrl = entries
            .map(([, v]) => (typeof v === 'string' ? v.trim() : ''))
            .find(v => /^https?:\/\//i.test(v));
        return anyUrl || '';
    },

    async _waitForTabComplete(tabId, timeoutMs = 15000) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            try {
                const tab = await chrome.tabs.get(tabId);
                if (tab?.status === 'complete') return true;
            } catch {
                return false;
            }
            await new Promise(r => setTimeout(r, 250));
        }
        return false;
    },

    async _navigateTabToUrl(tabId, url) {
        if (!Number.isInteger(tabId) || !url || !/^https?:\/\//i.test(String(url))) return false;
        try {
            await chrome.tabs.update(tabId, { url: String(url).trim() });
            await this._waitForTabComplete(tabId, 18000);
            await new Promise(r => setTimeout(r, 400));
            return true;
        } catch {
            return false;
        }
    },

    async _scrollTabToTop(tabId) {
        if (!Number.isInteger(tabId)) return false;
        try {
            await chrome.scripting.executeScript({
                target: { tabId },
                func: () => {
                    try {
                        window.scrollTo(0, 0);
                        const anchor = document.querySelector('#productTitle, #title, main, [role="main"], body');
                        if (anchor && typeof anchor.scrollIntoView === 'function') {
                            anchor.scrollIntoView({ block: 'start', inline: 'nearest' });
                        }
                        return true;
                    } catch {
                        return false;
                    }
                }
            });
            await new Promise(r => setTimeout(r, 350));
            return true;
        } catch {
            return false;
        }
    },

    async _restoreDiagnosisContext({
        tabId,
        lastWorkingSnapshot = null,
        failingTestCase = null,
        functionDef = null,
        onStatusUpdate = () => {}
    } = {}) {
        if (!Number.isInteger(tabId)) return { restored: false, finalUrl: '' };

        const knownGoodUrl =
            this._extractLikelyUrlFromInputs(lastWorkingSnapshot?.inputs || {})
            || String(lastWorkingSnapshot?.url || '').trim();
        const failingUrl = this._extractLikelyUrlFromInputs(failingTestCase?.inputs || {});
        const fallbackStartUrl =
            typeof functionDef?.startUrl === 'string' && /^https?:\/\//i.test(functionDef.startUrl)
                ? functionDef.startUrl
                : '';
        const fallbackPatternUrl = (() => {
            const pattern = Array.isArray(functionDef?.urlPatterns)
                ? functionDef.urlPatterns.find(p => typeof p === 'string' && /^https?:\/\//i.test(p))
                : '';
            if (!pattern) return '';
            if (pattern.includes('{{')) return '';
            const trimmed = pattern.replace(/\*.*$/, '').trim();
            if (!trimmed) return '';
            if (/^https?:\/\//i.test(trimmed)) return trimmed;
            return '';
        })();

        const navTargets = [];
        if (knownGoodUrl && knownGoodUrl !== failingUrl) {
            navTargets.push({ label: 'known-good', url: knownGoodUrl });
        }
        if (failingUrl) {
            navTargets.push({ label: 'failing-case', url: failingUrl });
        } else if (!knownGoodUrl && fallbackStartUrl) {
            navTargets.push({ label: 'function-start', url: fallbackStartUrl });
        } else if (!knownGoodUrl && !fallbackStartUrl && fallbackPatternUrl) {
            navTargets.push({ label: 'function-pattern', url: fallbackPatternUrl });
        }

        if (navTargets.length > 0) {
            onStatusUpdate(`[Diagnosis] Resetting page context before computer-use diagnosis...`);
        }

        for (const target of navTargets) {
            const ok = await this._navigateTabToUrl(tabId, target.url);
            if (!ok) {
                onStatusUpdate(`[Diagnosis] Could not navigate to ${target.label} URL. Continuing diagnosis from current page.`);
                break;
            }
        }

        await this._scrollTabToTop(tabId);

        let finalUrl = '';
        try {
            const tab = await chrome.tabs.get(tabId);
            finalUrl = tab?.url || '';
        } catch {
            finalUrl = '';
        }
        return { restored: true, finalUrl };
    },

    async _cleanupTestExecutionContext(context) {
        if (context?.tempWindowId) {
            try { await chrome.windows.remove(context.tempWindowId); } catch {}
        }
    },

    _isAbortRequested(options = {}) {
        try {
            return !!(typeof options.shouldAbort === 'function' && options.shouldAbort());
        } catch {
            return false;
        }
    },

    _isStopTestsAndSaveRequested(options = {}) {
        try {
            return !!(typeof options.shouldStopTestingAndSave === 'function' && options.shouldStopTestingAndSave());
        } catch {
            return false;
        }
    },

    _throwIfAbortRequested(options = {}, stage = 'operation') {
        if (this._isAbortRequested(options)) {
            throw new Error(`Stopped by user during ${stage}`);
        }
    },

    _publishBuiltFunction(functionDef, options = {}) {
        if (!functionDef) return;
        try {
            if (typeof options.onFunctionBuilt === 'function') {
                options.onFunctionBuilt(functionDef);
            }
        } catch (e) {
            console.warn('[AITaskService] onFunctionBuilt callback failed:', e?.message || e);
        }
    },

    _truncateForContext(value, maxChars = 600) {
        if (value === undefined || value === null) return '';
        const text = String(value)
            .replace(/\r/g, '')
            .replace(/[ \t]+\n/g, '\n')
            .replace(/[ \t]{2,}/g, ' ')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
        if (!text) return '';
        if (text.length <= maxChars) return text;
        return `${text.slice(0, Math.max(0, maxChars - 15))}...[truncated]`;
    },

    _summarizeIssueList(issues = [], maxItems = 4, maxCharsPerItem = 160) {
        const list = Array.isArray(issues) ? issues : [issues];
        return list
            .filter(Boolean)
            .slice(0, maxItems)
            .map(issue => this._truncateForContext(issue, maxCharsPerItem));
    },

    _summarizeActionArgs(args = {}, maxChars = 140) {
        if (!args || typeof args !== 'object') return '';
        const chunks = [];
        if (typeof args.description === 'string' && args.description.trim()) {
            chunks.push(`desc="${this._truncateForContext(args.description, 70)}"`);
        }
        if (typeof args.text === 'string' && args.text.trim()) {
            chunks.push(`text="${this._truncateForContext(args.text, 50)}"`);
        }
        if (typeof args.url === 'string' && args.url.trim()) {
            chunks.push(`url="${this._truncateForContext(args.url, 90)}"`);
        }
        if (typeof args.direction === 'string' && args.direction.trim()) {
            chunks.push(`dir=${args.direction}`);
        }
        if (typeof args.success === 'boolean') {
            chunks.push(`success=${args.success}`);
        }
        return this._truncateForContext(chunks.join(', '), maxChars);
    },

    _buildComputerUseActionSummary(actions = [], maxActions = 6) {
        if (!Array.isArray(actions) || actions.length === 0) return 'none';
        const selected = actions.slice(-Math.max(1, maxActions));
        return selected.map((entry, index) => {
            const turn = Number.isFinite(entry?.turn) ? entry.turn : '?';
            const actionName = entry?.action || 'unknown';
            const argSummary = this._summarizeActionArgs(entry?.args || {}, 120);
            return `${index + 1}. t${turn} ${actionName}${argSummary ? ` (${argSummary})` : ''}`;
        }).join('; ');
    },

    _appendBoundedRetryNote(retryNotes, note, maxEntries = 8, maxChars = 1800) {
        if (!Array.isArray(retryNotes)) return;
        const compact = this._truncateForContext(note, maxChars);
        if (!compact) return;
        retryNotes.push(compact);
        if (retryNotes.length > maxEntries) {
            retryNotes.splice(0, retryNotes.length - maxEntries);
        }
    },

    _buildFailureDiagnosisPrompt({
        functionDef,
        taskDescription = '',
        testCase = null,
        errorMessage = '',
        issues = [],
        currentUrl = ''
    } = {}) {
        const functionName = functionDef?.name || 'generated_function';
        const goal = this._truncateForContext(taskDescription || functionDef?.description || '', 260);
        const testName = testCase?.name ? String(testCase.name) : 'Unnamed test';
        const compactError = this._truncateForContext(errorMessage || 'none', 260);
        const issueLines = this._summarizeIssueList(issues, 4, 140);
        const issueText = issueLines.length > 0
            ? issueLines.map((issue, i) => `${i + 1}. ${issue}`).join('\n')
            : '1. Unknown issue';
        const urlLine = currentUrl ? `Current URL: ${currentUrl}` : 'Current URL: unknown';

        return `You are diagnosing a failed browser automation run.

Function: ${functionName}
Goal: ${goal || 'No goal provided'}
Failed test: ${testName}
${urlLine}
Observed error: ${compactError}

Observed issues:
${issueText}

Use computer-use actions (click/type/scroll/navigate) to inspect the live page.
Focus on:
1) Root cause of failure.
2) Best page URL/state where scraping should run.
3) If product/price data is relevant, capture 1-3 concrete price examples visible on page.
4) Minimal function changes needed to fix this failure.

When done, call task_complete with:
- result: {"rootCause":"...","targetPageUrl":"...","priceExamples":["..."],"fixPlan":["..."]}
- summary: one short sentence.`;
    },

    _formatComputerUseDiagnosisResult(result, finalUrl = '') {
        const status = result?.success ? 'success' : 'failed';
        const turns = Number.isFinite(result?.totalTurns) ? result.totalTurns : 'unknown';
        const summary = this._truncateForContext(
            result?.summary || result?.error || result?.result?.summary || '',
            320
        );
        let observedResult = '';
        if (result?.result !== undefined) {
            try {
                observedResult = this._truncateForContext(JSON.stringify(result.result), 500);
            } catch {
                observedResult = '';
            }
        }
        const actionSummary = this._buildComputerUseActionSummary(result?.actions || [], 6);
        const finalUrlLine = finalUrl ? `Final URL: ${this._truncateForContext(finalUrl, 220)}` : '';

        const lines = [
            `Status: ${status} (${turns} turns)`,
            summary ? `Summary: ${summary}` : '',
            finalUrlLine,
            observedResult ? `Observed result: ${observedResult}` : '',
            `Recent actions: ${actionSummary}`
        ].filter(Boolean);

        return this._truncateForContext(lines.join('\n'), 1400);
    },

    async _runComputerUseFailureDiagnosis({
        functionDef,
        taskDescription = '',
        testCase = null,
        errorMessage = '',
        issues = [],
        apiKey,
        tabId,
        onStatusUpdate = () => {},
        control = null,
        contextLabel = 'failure'
    } = {}) {
        if (!apiKey || !Number.isInteger(tabId)) return null;
        if (control) {
            this._throwIfAbortRequested(control, `${contextLabel} diagnosis`);
        }

        let currentUrl = '';
        try {
            const tab = await chrome.tabs.get(tabId);
            currentUrl = tab?.url || '';
        } catch {
            currentUrl = '';
        }

        const prompt = this._buildFailureDiagnosisPrompt({
            functionDef,
            taskDescription,
            testCase,
            errorMessage,
            issues,
            currentUrl
        });

        try {
            onStatusUpdate(`[Diagnosis] Running computer-use diagnosis for ${contextLabel}...`);
            const response = await chrome.runtime.sendMessage({
                type: 'executeToolAction',
                toolName: 'computer_use_api',
                apiKey,
                tabId,
                params: {
                    taskDescription: prompt,
                    tabId,
                    options: {
                        collectDebugImages: false,
                        diagnosticActionLimit: 14
                    }
                }
            });

            const runResult = response?.result || null;
            if (!response?.success || !runResult) {
                const reason = this._truncateForContext(
                    response?.error || runResult?.error || 'No diagnosis response',
                    260
                );
                onStatusUpdate(`[Diagnosis] Computer-use diagnosis failed: ${reason}`);
                return { success: false, contextText: `Status: failed\nReason: ${reason}` };
            }

            let finalUrl = currentUrl;
            try {
                const tab = await chrome.tabs.get(tabId);
                finalUrl = tab?.url || currentUrl;
            } catch {
                finalUrl = currentUrl;
            }

            const contextText = this._formatComputerUseDiagnosisResult(runResult, finalUrl);
            if (runResult?.success) {
                onStatusUpdate('[Diagnosis] Computer-use diagnosis complete.');
            } else {
                onStatusUpdate(`[Diagnosis] Computer-use diagnosis returned failure: ${this._truncateForContext(runResult?.error || 'unknown', 200)}`);
            }
            return { success: !!runResult?.success, contextText, rawResult: runResult };
        } catch (e) {
            const reason = this._truncateForContext(e?.message || e, 260);
            onStatusUpdate(`[Diagnosis] Computer-use diagnosis error: ${reason}`);
            return { success: false, contextText: `Status: failed\nReason: ${reason}` };
        }
    },

    // ==================== PAGE INVESTIGATION (Computer-Use Exploration & Diagnosis) ====================

    /**
     * Parse a raw task_complete result from computer use into a normalized PageInvestigationReport.
     * Handles JSON strings, objects, or malformed data gracefully.
     * @param {*} rawResult - The result field from task_complete (string or object)
     * @param {'proactive'|'diagnostic'} mode
     * @returns {object} PageInvestigationReport
     */
    _parseToFindings(rawResult, mode = 'proactive') {
        let parsed = null;
        if (typeof rawResult === 'string') {
            try { parsed = JSON.parse(rawResult); } catch { parsed = null; }
        } else if (rawResult && typeof rawResult === 'object') {
            // Could be the full run result; check for nested .result
            parsed = rawResult.result ?? rawResult;
            if (typeof parsed === 'string') {
                try { parsed = JSON.parse(parsed); } catch { parsed = null; }
            }
        }
        if (!parsed || typeof parsed !== 'object') parsed = {};

        const ensureArray = (v) => Array.isArray(v) ? v : [];
        const ensureString = (v) => (typeof v === 'string' ? v : '');
        const ensureObj = (v) => (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};

        const findings = {
            pageType: ensureString(parsed.pageType) || 'unknown',
            currentUrl: ensureString(parsed.currentUrl || parsed.targetPageUrl || parsed.url) || '',
            structure: {
                repeatingElements: ensureArray(parsed.repeatingElements || parsed.structure?.repeatingElements).slice(0, 5),
                interactiveElements: ensureArray(parsed.interactiveElements || parsed.structure?.interactiveElements).slice(0, 5),
                dynamicBehavior: ensureString(parsed.dynamicBehavior || parsed.structure?.dynamicBehavior) || 'unknown'
            },
            dataFindings: {
                visibleFields: ensureArray(parsed.visibleFields || parsed.dataFindings?.visibleFields),
                sampleData: ensureArray(parsed.sampleData || parsed.dataFindings?.sampleData).slice(0, 2),
                fieldLocations: ensureObj(parsed.fieldLocations || parsed.dataFindings?.fieldLocations)
            },
            diagnosis: mode === 'diagnostic' ? {
                rootCause: ensureString(parsed.rootCause || parsed.diagnosis?.rootCause),
                selectorIssues: ensureArray(parsed.selectorIssues || parsed.diagnosis?.selectorIssues).slice(0, 5),
                fixPlan: ensureArray(parsed.fixPlan || parsed.diagnosis?.fixPlan).slice(0, 4)
            } : null,
            actionsUsed: Number.isFinite(parsed.actionsUsed) ? parsed.actionsUsed : 0,
            mode
        };

        return findings;
    },

    /**
     * Merge proactive exploration findings with diagnostic findings into one report.
     * Takes structure/dataFindings from proactive, diagnosis from diagnostic.
     * Does NOT stack across correction attempts — each call replaces previous.
     */
    _mergeFindings(proactiveFindings, diagnosticFindings) {
        if (!proactiveFindings && !diagnosticFindings) return null;
        if (!proactiveFindings) return diagnosticFindings;
        if (!diagnosticFindings) return proactiveFindings;

        return {
            pageType: proactiveFindings.pageType || diagnosticFindings.pageType || 'unknown',
            currentUrl: diagnosticFindings.currentUrl || proactiveFindings.currentUrl || '',
            structure: proactiveFindings.structure || diagnosticFindings.structure || {},
            dataFindings: proactiveFindings.dataFindings || diagnosticFindings.dataFindings || {},
            diagnosis: diagnosticFindings.diagnosis || null,
            actionsUsed: (proactiveFindings.actionsUsed || 0) + (diagnosticFindings.actionsUsed || 0),
            mode: 'merged'
        };
    },

    /**
     * Serialize PageInvestigationReport to compact text for injection into LLM prompts.
     * Each section is truncated independently to preserve the most useful parts.
     * @param {object} findings - PageInvestigationReport
     * @param {number} maxChars - Total character budget (default 1500)
     * @returns {string}
     */
    _findingsToContextString(findings, maxChars = 1500) {
        if (!findings) return '';
        const lines = [];

        // Header
        lines.push(`[PAGE INVESTIGATION]`);
        if (findings.pageType || findings.currentUrl) {
            const parts = [];
            if (findings.pageType && findings.pageType !== 'unknown') parts.push(`Type: ${findings.pageType}`);
            if (findings.currentUrl) parts.push(`URL: ${this._truncateForContext(findings.currentUrl, 120)}`);
            lines.push(parts.join(' | '));
        }

        // Structure section (budget: 400 chars)
        const struct = findings.structure;
        if (struct) {
            const structParts = [];
            if (struct.repeatingElements?.length > 0) {
                const elSummaries = struct.repeatingElements.map(e => {
                    const desc = e.description || 'elements';
                    const count = e.approximateCount ? ` (${e.approximateCount})` : '';
                    const hint = e.containerHint ? ` in ${e.containerHint}` : '';
                    return `${desc}${count}${hint}`;
                });
                structParts.push(`Repeating: ${elSummaries.join('; ')}`);
            }
            if (struct.dynamicBehavior && struct.dynamicBehavior !== 'unknown') {
                structParts.push(`Behavior: ${struct.dynamicBehavior}`);
            }
            if (struct.interactiveElements?.length > 0) {
                const elSummaries = struct.interactiveElements.map(e =>
                    `${e.description || e.type || 'element'}${e.locationHint ? ` (${e.locationHint})` : ''}`
                );
                structParts.push(`Interactive: ${elSummaries.join('; ')}`);
            }
            if (structParts.length > 0) {
                lines.push(this._truncateForContext(`Structure: ${structParts.join('. ')}`, 400));
            }
        }

        // Data findings section (budget: 300 chars)
        const data = findings.dataFindings;
        if (data) {
            const dataParts = [];
            if (data.visibleFields?.length > 0) {
                const fieldLocs = data.fieldLocations || {};
                const fieldDescs = data.visibleFields.map(f => {
                    const loc = fieldLocs[f];
                    return loc ? `${f} (${loc})` : f;
                });
                dataParts.push(`Fields: ${fieldDescs.join(', ')}`);
            }
            if (data.sampleData?.length > 0) {
                try {
                    const sampleStr = JSON.stringify(data.sampleData[0]);
                    dataParts.push(`Sample: ${sampleStr.substring(0, 150)}`);
                } catch {}
            }
            if (dataParts.length > 0) {
                lines.push(this._truncateForContext(dataParts.join('. '), 300));
            }
        }

        // Diagnosis section (budget: 500 chars)
        const diag = findings.diagnosis;
        if (diag) {
            lines.push('[DIAGNOSIS]');
            const diagParts = [];
            if (diag.rootCause) {
                diagParts.push(`Root cause: ${diag.rootCause}`);
            }
            if (diag.selectorIssues?.length > 0) {
                const selectorFixes = diag.selectorIssues.map(s =>
                    `${s.original || '?'} -> ${s.suggested || '?'} (${s.problem || 'issue'})`
                );
                diagParts.push(`Selector fixes: ${selectorFixes.join('; ')}`);
            }
            if (diag.fixPlan?.length > 0) {
                diagParts.push(`Fix plan: ${diag.fixPlan.map((f, i) => `${i + 1}) ${f}`).join(' ')}`);
            }
            if (diagParts.length > 0) {
                lines.push(this._truncateForContext(diagParts.join('\n'), 500));
            }
        }

        const result = lines.join('\n');
        return this._truncateForContext(result, maxChars);
    },

    /**
     * Build prompt for proactive page exploration via computer use.
     * Tells AI to investigate page structure WITHOUT extracting data.
     */
    _buildProactiveExplorationPrompt({ plan, currentUrl }) {
        const fields = plan?.outputs?.fields || plan?.outputs?.description || 'structured data';
        const name = plan?.name || 'data extraction';
        return `You are investigating a webpage to understand its structure BEFORE building an automated scraper.

URL: ${currentUrl || 'unknown'}
Task: ${name}
Target data to extract: ${fields}

INVESTIGATION TASKS (keep it quick — around 8-12 actions):
1. Look at the page layout. Identify the main content area and any repeating elements (cards, rows, list items).
2. Click on 1-2 items to see if they lead to detail pages with more data, then go BACK.
3. Scroll down to check for pagination, infinite scroll, or "load more" buttons.
4. Note any dynamic content that requires interaction (tabs, accordions, expand buttons).
5. Identify WHERE each target field is displayed (which section of the page, what kind of element).

DO NOT try to extract data or build selectors. Just investigate and report.

When done, call task_complete with:
- success: true
- result: JSON with these keys: pageType (e.g. "product-listing", "search-results", "detail-page"), repeatingElements (array of {description, approximateCount, containerHint}), interactiveElements (array of {description, type, locationHint}), dynamicBehavior ("infinite-scroll"|"pagination"|"load-more"|"static"|"tabs"), visibleFields (array of field names you can see), sampleData (1-2 example data items you observed), fieldLocations (object mapping field names to where they appear)
- summary: one sentence describing the page`;
    },

    /**
     * Run proactive page exploration using computer use.
     * Called during preflight, AFTER navigation and pre-scroll, BEFORE content expansion and screenshot.
     */
    async _runProactiveExploration({ plan, tabId, apiKey, onStatusUpdate = () => {}, control = null, actionBudget = 12 }) {
        if (!apiKey || !Number.isInteger(tabId)) return null;
        if (control) this._throwIfAbortRequested(control, 'proactive exploration');

        let currentUrl = '';
        try {
            const tab = await chrome.tabs.get(tabId);
            currentUrl = tab?.url || '';
        } catch { currentUrl = ''; }

        const prompt = this._buildProactiveExplorationPrompt({ plan, currentUrl });

        try {
            onStatusUpdate('Preflight: AI is exploring page structure...');
            const response = await chrome.runtime.sendMessage({
                type: 'executeToolAction',
                toolName: 'computer_use_api',
                apiKey,
                tabId,
                params: {
                    taskDescription: prompt,
                    tabId,
                    options: {
                        collectDebugImages: false,
                        diagnosticActionLimit: actionBudget
                    }
                }
            });

            const runResult = response?.result || null;
            if (!response?.success || !runResult) {
                const reason = this._truncateForContext(
                    response?.error || runResult?.error || 'No exploration response', 260
                );
                onStatusUpdate(`[Exploration] Failed: ${reason}`);
                return { success: false, findings: null };
            }

            const findings = this._parseToFindings(runResult, 'proactive');
            findings.actionsUsed = runResult?.totalTurns || 0;
            if (findings.currentUrl === '' && currentUrl) findings.currentUrl = currentUrl;

            onStatusUpdate(`Exploration: ${findings.pageType || 'unknown'} page, ${findings.structure?.repeatingElements?.length || 0} repeating elements found`);
            return { success: true, findings };
        } catch (e) {
            const reason = this._truncateForContext(e?.message || e, 260);
            onStatusUpdate(`[Exploration] Error: ${reason}`);
            return { success: false, findings: null };
        }
    },

    /**
     * Build enhanced diagnosis prompt that includes function step details and selector info,
     * plus any prior exploration findings. Asks AI to interactively TEST selectors.
     */
    _buildEnhancedDiagnosisPrompt({ functionDef, taskDescription = '', testCase = null, errorMessage = '', issues = [], currentUrl = '', priorFindings = null, actionBudget = 10 }) {
        const functionName = functionDef?.name || 'generated_function';
        const goal = this._truncateForContext(taskDescription || functionDef?.description || '', 260);
        const testName = testCase?.name ? String(testCase.name) : 'Unnamed test';
        const compactError = this._truncateForContext(errorMessage || 'none', 260);
        const issueLines = this._summarizeIssueList(issues, 4, 140);
        const issueText = issueLines.length > 0
            ? issueLines.map((issue, i) => `${i + 1}. ${issue}`).join('\n')
            : '1. Unknown issue';

        // Extract selector/code info from function steps for the AI to test
        let stepsInfo = '';
        const relevantSteps = (functionDef?.steps || []).filter(s => s.selector || s.code || s.type === 'script');
        if (relevantSteps.length > 0) {
            const stepSummaries = relevantSteps.slice(0, 5).map((s, i) => {
                if (s.type === 'script' && s.code) {
                    return `Step ${i + 1} [script]: ${this._truncateForContext(s.code, 200)}`;
                }
                return `Step ${i + 1} [${s.type}]: selector="${s.selector || 'none'}" value="${s.value || ''}"`;
            });
            stepsInfo = `\nFUNCTION STEPS TO TEST:\n${stepSummaries.join('\n')}\n`;
        }

        // Include prior exploration findings if available
        let priorContext = '';
        if (priorFindings) {
            priorContext = `\nPRIOR PAGE EXPLORATION:\n${this._findingsToContextString(priorFindings, 500)}\n`;
        }

        return `You are diagnosing a failed browser automation run by INTERACTIVELY testing the page.

Function: ${functionName}
Goal: ${goal || 'No goal provided'}
Failed test: ${testName}
Current URL: ${currentUrl || 'unknown'}
Observed error: ${compactError}

Observed issues:
${issueText}
${stepsInfo}${priorContext}
INTERACTIVE DIAGNOSIS (use up to ${actionBudget} actions):
1. Try clicking or hovering on elements the function targets — do they exist? Are they visible?
2. If selectors fail, visually find the actual elements containing the target data.
3. Scroll through the page to check if content loads dynamically (lazy-loaded sections).
4. If there's a popup, cookie banner, or login modal blocking content, note it.
5. Try alternative navigation paths if the current page state seems wrong.
6. Identify the REAL CSS selectors or page structure for the target data.

When done, call task_complete with:
- success: true
- result: JSON with keys: rootCause (one sentence), selectorIssues (array of {original, problem, suggested}), fixPlan (array of fix description strings), targetPageUrl (if different from current), pageType
- summary: one short sentence describing what you found`;
    },

    /**
     * Run enhanced computer-use diagnosis with higher action budget, structured findings,
     * and optional prior exploration context. Wraps _runComputerUseFailureDiagnosis.
     */
    async _runEnhancedDiagnosis({
        functionDef, taskDescription = '', testCase = null, errorMessage = '',
        issues = [], apiKey, tabId, onStatusUpdate = () => {}, control = null,
        contextLabel = 'failure', priorFindings = null, actionBudget = 10
    }) {
        if (!apiKey || !Number.isInteger(tabId)) return null;
        if (control) this._throwIfAbortRequested(control, `${contextLabel} enhanced diagnosis`);

        let currentUrl = '';
        try {
            const tab = await chrome.tabs.get(tabId);
            currentUrl = tab?.url || '';
        } catch { currentUrl = ''; }

        const prompt = this._buildEnhancedDiagnosisPrompt({
            functionDef, taskDescription, testCase, errorMessage,
            issues, currentUrl, priorFindings, actionBudget
        });

        try {
            onStatusUpdate(`[Diagnosis] Running enhanced computer-use diagnosis for ${contextLabel}...`);
            const response = await chrome.runtime.sendMessage({
                type: 'executeToolAction',
                toolName: 'computer_use_api',
                apiKey,
                tabId,
                params: {
                    taskDescription: prompt,
                    tabId,
                    options: {
                        collectDebugImages: false,
                        diagnosticActionLimit: actionBudget
                    }
                }
            });

            const runResult = response?.result || null;
            if (!response?.success || !runResult) {
                const reason = this._truncateForContext(
                    response?.error || runResult?.error || 'No diagnosis response', 260
                );
                onStatusUpdate(`[Diagnosis] Enhanced diagnosis failed: ${reason}`);
                return { success: false, findings: null, contextText: `Status: failed\nReason: ${reason}` };
            }

            // Parse into structured findings
            const diagFindings = this._parseToFindings(runResult, 'diagnostic');
            diagFindings.actionsUsed = runResult?.totalTurns || 0;
            if (diagFindings.currentUrl === '' && currentUrl) diagFindings.currentUrl = currentUrl;

            // Merge with prior exploration findings
            const mergedFindings = this._mergeFindings(priorFindings, diagFindings);

            // Also produce legacy contextText for backward compatibility
            let finalUrl = currentUrl;
            try {
                const tab = await chrome.tabs.get(tabId);
                finalUrl = tab?.url || currentUrl;
            } catch { finalUrl = currentUrl; }
            const contextText = this._formatComputerUseDiagnosisResult(runResult, finalUrl);

            if (runResult?.success) {
                onStatusUpdate('[Diagnosis] Enhanced diagnosis complete.');
            } else {
                onStatusUpdate(`[Diagnosis] Enhanced diagnosis returned failure: ${this._truncateForContext(runResult?.error || 'unknown', 200)}`);
            }

            return {
                success: !!runResult?.success,
                findings: mergedFindings,
                contextText,
                rawResult: runResult
            };
        } catch (e) {
            const reason = this._truncateForContext(e?.message || e, 260);
            onStatusUpdate(`[Diagnosis] Enhanced diagnosis error: ${reason}`);
            return { success: false, findings: null, contextText: `Status: failed\nReason: ${reason}` };
        }
    },

    // ==================== DETAILED WORKFLOW PLAN ====================

    /**
     * Generate a detailed, numbered execution plan from the high-level workflow plan.
     * Each sub-function gets concrete steps (plan, generate, preflight, scrape, build, sample-run).
     * Used to show exact progress in the UI and follow the plan step by step.
     */
    generateDetailedWorkflowPlan(workflowPlan) {
        const phases = [];

        for (let i = 0; i < workflowPlan.subFunctions.length; i++) {
            const sub = workflowPlan.subFunctions[i];
            const phaseNum = i + 1;
            const steps = [];
            let stepNum = 1;

            // URL injection step (if this function takes a URL input and it's not the first)
            if (i > 0) {
                const hasUrlInput = (sub.inputs || []).some(inp =>
                    inp.name.toLowerCase().includes('url') && inp.type === 'string'
                );
                if (hasUrlInput) {
                    steps.push({
                        id: `${phaseNum}.${stepNum++}`,
                        action: 'inject-url',
                        label: `Inject sample URL from ${workflowPlan.subFunctions[i - 1].name}`
                    });
                }
            }

            // Plan
            steps.push({
                id: `${phaseNum}.${stepNum++}`,
                action: 'plan',
                label: `Plan "${sub.name}" structure`
            });

            // Generate steps
            steps.push({
                id: `${phaseNum}.${stepNum++}`,
                action: 'generate-steps',
                label: 'Generate execution steps'
            });

            // Preflight navigation
            if (sub.navigationStrategy === 'computer-use') {
                const site = sub.urlPatterns?.[0]?.replace(/\*.*$/, '').replace(/\/$/, '') || 'target site';
                steps.push({
                    id: `${phaseNum}.${stepNum++}`,
                    action: 'preflight',
                    label: `Preflight: navigate to ${site} (visual agent)`
                });
            } else {
                const urlLabel = sub.urlTemplate
                    ? sub.urlTemplate.substring(0, 50) + (sub.urlTemplate.length > 50 ? '...' : '')
                    : 'target URL';
                steps.push({
                    id: `${phaseNum}.${stepNum++}`,
                    action: 'preflight',
                    label: `Preflight: navigate to ${urlLabel}`
                });
            }

            // Explore page structure (if smartScrape — exploration happens during preflight)
            if (sub.extractionStrategy === 'smartScrape') {
                steps.push({
                    id: `${phaseNum}.${stepNum++}`,
                    action: 'explore',
                    label: `Explore page structure for "${sub.name}"`
                });
            }

            // Scrape
            if (sub.extractionStrategy === 'smartScrape') {
                steps.push({
                    id: `${phaseNum}.${stepNum++}`,
                    action: 'scrape',
                    label: 'Create AI scraper from page'
                });
            }

            // Build
            steps.push({
                id: `${phaseNum}.${stepNum++}`,
                action: 'build',
                label: `Build "${sub.name}" function`
            });

            // Test & correct (screenshot-verified testing with AI correction)
            steps.push({
                id: `${phaseNum}.${stepNum++}`,
                action: 'test',
                label: `Test "${sub.name}" with screenshot verification`
            });

            // Sample run (if array output and not last sub-function)
            if (sub.outputs?.type === 'array' && i < workflowPlan.subFunctions.length - 1) {
                steps.push({
                    id: `${phaseNum}.${stepNum++}`,
                    action: 'sample-run',
                    label: 'Run sample to get URLs for next function'
                });
            }

            phases.push({
                name: sub.name,
                purpose: sub.purpose,
                type: 'sub-function',
                index: i,
                steps: steps
            });
        }

        // Master function phase
        const masterNum = workflowPlan.subFunctions.length + 1;
        phases.push({
            name: workflowPlan.masterFunction.name,
            purpose: workflowPlan.masterFunction.description,
            type: 'master',
            index: workflowPlan.subFunctions.length,
            steps: [
                { id: `${masterNum}.1`, action: 'generate-orchestration', label: 'Generate orchestration code' },
                { id: `${masterNum}.2`, action: 'assemble', label: 'Assemble master function' },
                { id: `${masterNum}.3`, action: 'workflow-test', label: 'End-to-end workflow test' },
                { id: `${masterNum}.4`, action: 'save', label: 'Save all functions to storage' }
            ]
        });

        const totalSteps = phases.reduce((sum, p) => sum + p.steps.length, 0);
        return { phases, totalSteps };
    },

    // ==================== WORKFLOW PLANNING ====================

    /**
     * Decompose a complex task into sub-functions + a master orchestrator.
     */
    async planWorkflow(taskDescription, apiKey, existingFunctions = {}) {
        const existingFuncSummary = Object.values(existingFunctions).map(f => ({
            name: f.name,
            description: f.description,
            inputs: f.inputs,
            outputs: f.outputs
        }));

        // NOTE: We use responseMimeType without responseJsonSchema because the
        // workflow schema is too deeply nested for Gemini's max nesting depth.
        // The prompt provides detailed format instructions and examples instead.

        let prompt = `You are a workflow architect for browser automation.

TASK: "${taskDescription}"

Decompose this into a WORKFLOW with sub-functions and a master orchestrator.
Return a JSON object with this EXACT structure:

{
  "workflow": {
    "subFunctions": [
      {
        "name": "CamelCaseName",
        "purpose": "What this sub-function does",
        "taskDescription": "Full standalone task description for the function generator",
        "inputs": [{"name": "paramName", "type": "string|number|boolean", "description": "...", "defaultValue": "optional"}],
        "outputs": {"type": "array|object|string", "description": "...", "fields": "comma,separated,fields"},
        "navigationStrategy": "url" or "computer-use" or "current-tab",
        "useCurrentTab": true/false (true when operating directly on current page context),
        "urlTemplate": "https://example.com/{{inputName}} (only if navigationStrategy is url)",
        "navigationInstructions": "Natural language for visual agent (always provide)",
        "extractionStrategy": "smartScrape" or "script" or "none",
        "needsScrollLoop": true/false,
        "urlPatterns": ["https://example.com/*"],
        "waitForSelector": "optional CSS selector"
      }
    ],
    "masterFunction": {
      "name": "CamelCaseName",
      "description": "What the master function does",
      "inputs": [{"name": "paramName", "type": "string|number|boolean", "description": "...", "defaultValue": "optional"}],
      "outputs": {"type": "array|object|string", "description": "...", "fields": "comma,separated,fields"},
      "orchestrationStrategy": "Natural language: how master coordinates sub-functions"
    }
  }
}

WORKFLOW DESIGN PRINCIPLES:
- Each sub-function should be INDEPENDENT and REUSABLE on its own
- Sub-functions handle their OWN navigation to their target pages
- The master function receives user inputs and coordinates sub-function calls
- The master function loops over results from one sub-function to call another
- Data flows: master -> sub1 -> master -> sub2 -> master -> return

IMPORTANT: Each sub-function's "taskDescription" should be a complete, standalone task description
that can be given to the function generator independently. Include all relevant details.

Keep output minimal and practical: define the smallest set of sub-functions needed.

Workflow guidance:
- Use 2 sub-functions by default (list/search page + detail page) when needed.
- Use URL input on detail sub-functions so master can pass per-item links.
- Keep orchestration strategy concise and deterministic.


CRITICAL RULES:
- Sub-functions that take a URL input (like a detail page URL) should use navigationStrategy "url" with urlTemplate "{{inputName}}"
- List/search sub-functions can use either "url" or "computer-use" navigation based on reliability
- The detail extraction sub-function MUST have a URL input so the master can pass URLs from the list
- Master function inputs should cover what the END USER provides (e.g., searchQuery, numberOfResults)
- Keep sub-function count minimal: typically 2 (list + detail) is enough
- Always provide navigationInstructions for every sub-function`;

        if (existingFuncSummary.length > 0) {
            prompt += `\n\nEXISTING FUNCTIONS (consider reusing instead of creating new):
${JSON.stringify(existingFuncSummary, null, 2)}`;
        }

        const requestBody = {
            contents: [{
                role: 'user',
                parts: [{ text: prompt }]
            }],
            generationConfig: {
                responseMimeType: 'application/json',
                maxOutputTokens: 8192
            }
        };

        const result = await AIService.callGemini(requestBody, apiKey);
        return result.workflow;
    },

    // ==================== ORCHESTRATION CODE GENERATION ====================

    /**
     * Generate the JavaScript code for the master function's orchestration step.
     * This code calls sub-functions via page.executeFunction() and aggregates results.
     */
    async generateOrchestrationCode(workflowPlan, generatedSubFunctions, apiKey) {
        const subFuncSummaries = generatedSubFunctions.map(f => ({
            name: f.name,
            description: f.description,
            inputs: f.inputs,
            outputs: f.outputs
        }));

        // Extract site domain for URL normalization
        const siteOrigin = (() => {
            for (const sub of workflowPlan.subFunctions) {
                if (sub.urlPatterns?.[0]) {
                    try { return new URL(sub.urlPatterns[0].replace(/\*/g, 'x')).origin; } catch {}
                }
                if (sub.urlTemplate) {
                    try { return new URL(sub.urlTemplate.replace(/\{\{.*?\}\}/g, 'test')).origin; } catch {}
                }
            }
            return null;
        })();

        const prompt = `Generate JavaScript orchestration code for a workflow function.

MASTER FUNCTION:
- Name: ${workflowPlan.masterFunction.name}
- Description: ${workflowPlan.masterFunction.description}
- Inputs: ${JSON.stringify(workflowPlan.masterFunction.inputs, null, 2)}
- Outputs: ${JSON.stringify(workflowPlan.masterFunction.outputs, null, 2)}
- Strategy: ${workflowPlan.masterFunction.orchestrationStrategy}
${siteOrigin ? `- Site Origin: ${siteOrigin} (use this to normalize relative URLs like "/watch?v=abc" → "${siteOrigin}/watch?v=abc")` : ''}

SUB-FUNCTIONS AVAILABLE:
${subFuncSummaries.map((f, i) => `${i + 1}. ${f.name}
   ${f.description}
   Call: await page.executeFunction('${f.name}', { ${f.inputs.map(inp => `${inp.name}: value`).join(', ')} })
   Returns: ${f.outputs?.description || JSON.stringify(f.outputs)}`).join('\n\n')}

REQUIREMENTS:
1. Write ONLY the JavaScript code body (no markdown, no explanations, no function wrapper)
2. Use await page.executeFunction('SubFunctionName', { inputs }) to call sub-functions
3. Access master function inputs via inputs.parameterName
4. Include try-catch around each sub-function call for error handling
5. Use await page.log() to report progress to the user
6. If looping over items: continue processing even if one item fails (collect partial results)
7. Return the final aggregated data matching the master function's output spec
8. Available API: page.executeFunction(name, inputs), page.log(msg), page.wait(ms), page.navigate(url), page.getCurrentTabContent(maxChars)
9. Keep delays minimal. Use short waits only when necessary (prefer ~200-500ms, avoid long static waits).
10. CRITICAL: URLs from scrapers may be RELATIVE (e.g., "/watch?v=abc" instead of "https://www.youtube.com/watch?v=abc"). When passing URL values to sub-functions, ALWAYS normalize them to absolute URLs first. If a URL starts with "/" and doesn't start with "http", prepend the site origin.
11. page.executeFunction may return an error object {success: false, error: "..."} on failure. Always check if the result is valid (Array.isArray for arrays, or check result && !result.error for objects).
12. If this is a master/orchestration workflow:
   - Do NOT add page.smartScrape() calls inside orchestration.
   - Do NOT duplicate heavy navigation/scroll logic if detail sub-functions already handle navigation.
   - Keep orchestration focused on calling sub-functions and aggregating outputs.

PATTERN:
// Helper: ensure URLs are absolute
function normalizeUrl(url, siteOrigin) {
  if (!url) return url;
  if (url.startsWith('http')) return url;
  if (url.startsWith('/')) return siteOrigin + url;
  return url;
}

const listResults = await page.executeFunction('ListFunction', {
  query: inputs.searchQuery,
  count: inputs.numberOfResults
});

if (!listResults || !Array.isArray(listResults) || listResults.length === 0) {
  return [];
}

const allDetails = [];
const max = Math.min(listResults.length, inputs.numberOfResults || 10);

for (let i = 0; i < max; i++) {
  const item = listResults[i];
  await page.log('Processing ' + (i + 1) + '/' + max + ': ' + (item.title || item.name || item.url));

  try {
    const itemUrl = normalizeUrl(item.url, 'https://www.example.com');
    const details = await page.executeFunction('DetailFunction', {
      url: itemUrl
    });
    if (details && !details.error) {
      allDetails.push({ ...item, ...details });
    } else {
      allDetails.push({ ...item, error: details?.error || 'Unknown error' });
    }
  } catch (error) {
    await page.log('Error on item ' + (i + 1) + ': ' + error.message);
    allDetails.push({ ...item, error: error.message });
  }

  await page.wait(300);
}

return allDetails;

Generate the orchestration code now (code only, no markdown fences):`;

        const result = await AIService.callGemini({
            contents: [{
                role: 'user',
                parts: [{ text: prompt }]
            }],
            generationConfig: {
                temperature: 0.3,
                maxOutputTokens: 4096
            }
        }, apiKey, false);

        let code = result.candidates?.[0]?.content?.parts?.[0]?.text || '';

        // Clean markdown code fences if present
        code = code.replace(/^```(?:javascript|js)?\n?/, '').replace(/\n?```$/, '').trim();

        return code;
    },

    // ==================== WORKFLOW PIPELINE ====================

    /**
     * Full workflow pipeline: plan -> detailed plan -> generate sub-functions -> orchestrate -> save
     * Features:
     * - Generates a detailed step-by-step execution plan visible in the UI
     * - Tracks exact position in the workflow (emits workflow-step events)
     * - Retries failed sub-functions at the workflow level before falling back to stubs
     * - Runs list functions to get sample data (real URLs) for detail functions
     */
    async executeWorkflowPipeline(taskDescription, apiKey, options = {}) {
        const {
            onStatusUpdate = () => {},
            maxRetries = 3,
            existingFunctions = {},
            shouldAbort = () => false,
            shouldStopTestingAndSave = () => false,
            enableProactiveExploration = false
        } = options;
        const control = { shouldAbort, shouldStopTestingAndSave };

        try {
            this._throwIfAbortRequested(control, 'workflow planning');
            const currentContextUrl = await this._getCurrentContextUrl();
            const relevantExistingFunctions = this._filterFunctionsForCurrentUrl(existingFunctions, currentContextUrl);
            const totalExisting = Object.keys(existingFunctions || {}).length;
            const relevantCount = Object.keys(relevantExistingFunctions).length;
            if (totalExisting > 0) {
                onStatusUpdate(`Context functions: using ${relevantCount}/${totalExisting} URL-relevant functions${currentContextUrl ? ` for ${currentContextUrl}` : ''}.`);
            }
            // 1. PLAN WORKFLOW
            onStatusUpdate('Planning workflow decomposition...', { type: 'planning' });
            const workflowPlan = await this.planWorkflow(taskDescription, apiKey, relevantExistingFunctions);
            console.log('[Workflow] Plan:', JSON.stringify(workflowPlan, null, 2));

            // 2. GENERATE DETAILED EXECUTION PLAN
            const detailedPlan = this.generateDetailedWorkflowPlan(workflowPlan);
            console.log('[Workflow] Detailed plan:', JSON.stringify(detailedPlan, null, 2));

            onStatusUpdate(
                `Workflow planned: ${workflowPlan.subFunctions.length} sub-functions, ${detailedPlan.totalSteps} steps`,
                {
                    type: 'workflow-plan',
                    plan: workflowPlan,
                    detailedPlan: detailedPlan
                }
            );

            // 3. EXECUTE SUB-FUNCTIONS WITH STEP TRACKING & RETRY
            const generatedSubFunctions = [];
            const allFunctions = { ...relevantExistingFunctions };
            let lastSampleData = null;

            for (let i = 0; i < workflowPlan.subFunctions.length; i++) {
                this._throwIfAbortRequested(control, `workflow sub-function ${i + 1}`);
                const subFuncSpec = workflowPlan.subFunctions[i];
                const total = workflowPlan.subFunctions.length;
                const phase = detailedPlan.phases[i];

                // Helper: emit a workflow step event
                const emitStep = (stepAction, status, message) => {
                    const stepIdx = phase.steps.findIndex(s => s.action === stepAction);
                    if (stepIdx === -1) return;
                    const stepMeta = phase.steps[stepIdx];
                    console.log(`[Workflow][Step] ${subFuncSpec.name} :: ${stepMeta.id} :: ${stepMeta.action} :: ${status}`);
                    onStatusUpdate(
                        message || `[${stepMeta.id}] ${stepMeta.label}`,
                        {
                            type: 'workflow-step',
                            phaseIndex: i,
                            stepIndex: stepIdx,
                            stepId: stepMeta.id,
                            status: status
                        }
                    );
                };

                // INJECT REAL URLs FROM PREVIOUS FUNCTION'S SAMPLE DATA
                if (lastSampleData && Array.isArray(lastSampleData) && lastSampleData.length > 0) {
                    // Get source domain from the previous sub-function spec for relative URL resolution
                    const prevSpec = i > 0 ? workflowPlan.subFunctions[i - 1] : null;
                    const sourceDomain = prevSpec ? this._getDomainFromSpec(prevSpec) : null;

                    for (const input of (subFuncSpec.inputs || [])) {
                        if (input.name.toLowerCase().includes('url') && input.type === 'string') {
                            const sampleUrl = this._findUrlInSampleData(lastSampleData, sourceDomain);
                            if (sampleUrl) {
                                input.defaultValue = sampleUrl;
                                emitStep('inject-url', 'completed',
                                    `[${phase.steps[0]?.id}] Injected URL: ${sampleUrl}`);
                                console.log(`[Workflow] Injected defaultValue for ${input.name}: ${sampleUrl}`);
                            } else {
                                console.warn(`[Workflow] Could not find URL for ${input.name} in sample data`);
                                onStatusUpdate(`Warning: No URL found for ${input.name} input — detail function may fail`);
                            }
                        }
                    }
                }

                onStatusUpdate(`[${i + 1}/${total}] Generating: ${subFuncSpec.name}...`, {
                    type: 'subfunction-start',
                    index: i,
                    name: subFuncSpec.name
                });

                // RETRY LOOP: try generating the sub-function multiple times
                let subFuncResult = null;
                let lastSubError = null;
                const maxSubRetries = 2;

                for (let subAttempt = 1; subAttempt <= maxSubRetries; subAttempt++) {
                    this._throwIfAbortRequested(control, `sub-function generation (${subFuncSpec.name})`);
                    try {
                        if (subAttempt > 1) {
                            onStatusUpdate(
                                `[${i + 1}/${total}] Retrying ${subFuncSpec.name} (attempt ${subAttempt}/${maxSubRetries})...`,
                                {
                                    type: 'subfunction-retry',
                                    index: i,
                                    attempt: subAttempt,
                                    name: subFuncSpec.name,
                                    previousError: lastSubError
                                }
                            );
                        }

                        // Step-tracking wrapper: pattern-match pipeline messages to plan steps
                        const stepTrackingUpdate = (msg) => {
                            if (msg.includes('pre-planned function') || msg.includes('Planning task')) {
                                emitStep('plan', 'active');
                            } else if (msg.includes('Generating execution steps')) {
                                emitStep('generate-steps', 'active');
                            } else if (msg.includes('Pre-generating scraper') || msg.includes('Preflight: Navigating')) {
                                emitStep('preflight', 'active');
                            } else if (msg.includes('Preflight: Arrived')) {
                                emitStep('preflight', 'completed');
                            } else if (msg.includes('exploring page structure')) {
                                emitStep('explore', 'active');
                            } else if (msg.includes('Exploration:')) {
                                emitStep('explore', 'completed');
                            } else if (msg.includes('Capturing page') || msg.includes('creating extraction')) {
                                emitStep('scrape', 'active');
                            } else if (msg.includes('Scraper created') || msg.includes('Reusing existing scraper')) {
                                emitStep('scrape', 'completed');
                            } else if (msg.includes('generated') && msg.includes('Function')) {
                                emitStep('build', 'completed');
                            }
                            // Always pass through to parent
                            onStatusUpdate(`  ${msg}`);
                        };

                        subFuncResult = await this.executeTaskPipeline(
                            subFuncSpec.taskDescription || subFuncSpec.purpose,
                            apiKey,
                            {
                                prePlannedFunction: subFuncSpec,
                                skipTesting: true,
                                existingFunctions: allFunctions,
                                maxRetries: Math.min(maxRetries, 2),
                                onStatusUpdate: stepTrackingUpdate,
                                shouldAbort: control.shouldAbort,
                                shouldStopTestingAndSave: control.shouldStopTestingAndSave,
                                enableProactiveExploration
                            }
                        );
                        if (subFuncResult?.aborted) {
                            throw new Error(subFuncResult.error || 'Stopped by user');
                        }

                        if (subFuncResult.success) {
                            break; // Success - exit retry loop
                        } else {
                            lastSubError = subFuncResult.error || 'Sub-function generation failed';
                        }
                    } catch (error) {
                        lastSubError = error.message;
                        console.warn(`[Workflow] Sub-function ${subFuncSpec.name} attempt ${subAttempt} failed:`, error);
                        if (/Stopped by user/i.test(String(lastSubError || ''))) {
                            throw error;
                        }
                    }

                    // Brief pause before retry
                    if (subAttempt < maxSubRetries) {
                        await new Promise(r => setTimeout(r, 600));
                    }
                }

                if (subFuncResult?.success) {
                    generatedSubFunctions.push(subFuncResult.functionDef);
                    allFunctions[subFuncResult.functionDef.name] = subFuncResult.functionDef;

                    emitStep('build', 'completed');
                    onStatusUpdate(`[${i + 1}/${total}] ${subFuncSpec.name} generated successfully`, {
                        type: 'subfunction-complete',
                        index: i,
                        name: subFuncSpec.name
                    });

                    // TEST & CORRECT: run diverse tests with screenshot verification
                    emitStep('test', 'active');
                    let testResult;
                    if (this._isStopTestsAndSaveRequested(control)) {
                        onStatusUpdate(`  [Test] Skipping tests for "${subFuncSpec.name}" (requested by user).`);
                        testResult = {
                            success: true,
                            functionDef: { ...subFuncResult.functionDef, testsPassed: false, testResults: [] },
                            corrected: false,
                            skippedByUser: true
                        };
                    } else {
                        testResult = await this.testAndCorrectSubFunction(
                            subFuncResult.functionDef, apiKey,
                            {
                                onStatusUpdate: (msg) => onStatusUpdate(`  [Test] ${msg}`),
                                maxCorrections: 1,
                                shouldAbort: control.shouldAbort,
                                shouldStopTestingAndSave: control.shouldStopTestingAndSave
                            }
                        );
                    }

                    if (testResult.success) {
                        // Use potentially corrected function definition
                        const testedFunc = testResult.functionDef;
                        generatedSubFunctions[generatedSubFunctions.length - 1] = testedFunc;
                        allFunctions[testedFunc.name] = testedFunc;

                        // Save sub-function to storage immediately after testing (don't wait until workflow end)
                        await this._upsertFunctionDef(testedFunc, { unique: false });

                        emitStep('test', 'completed');
                        const testMessage = testResult.skippedByUser
                            ? `[${i + 1}/${total}] ${subFuncSpec.name} tests skipped by user`
                            : `[${i + 1}/${total}] ${subFuncSpec.name} tests passed${testResult.corrected ? ' (AI-corrected)' : ''}`;
                        onStatusUpdate(testMessage, {
                            type: 'subfunction-test-passed',
                            index: i,
                            name: subFuncSpec.name,
                            corrected: testResult.corrected
                        });
                    } else {
                        emitStep('test', 'failed');
                        onStatusUpdate(`[${i + 1}/${total}] ${subFuncSpec.name} failed some tests. Using best version.`, {
                            type: 'subfunction-test-failed',
                            index: i,
                            name: subFuncSpec.name
                        });
                        // Still use the function — it was generated, just didn't pass all tests
                        const bestFunc = testResult.functionDef;
                        generatedSubFunctions[generatedSubFunctions.length - 1] = bestFunc;
                        allFunctions[bestFunc.name] = bestFunc;

                        // Do not persist failed variants yet. We may still fix/replace them during
                        // workflow-level testing; final save step will persist the chosen versions.
                    }

                    // SAMPLE RUN: get real URLs for the next detail function
                    if (subFuncSpec.outputs?.type === 'array' && i < workflowPlan.subFunctions.length - 1) {
                        emitStep('sample-run', 'active');
                        const sampleDomain = this._getDomainFromSpec(subFuncSpec);
                        lastSampleData = await this._runSubFunctionForSampleData(
                            generatedSubFunctions[generatedSubFunctions.length - 1], onStatusUpdate, sampleDomain
                        );
                        emitStep('sample-run', lastSampleData ? 'completed' : 'failed');
                    }
                } else {
                    console.warn(`[Workflow] Sub-function ${subFuncSpec.name} failed after ${maxSubRetries} attempts:`, lastSubError);

                    // Create stub function as fallback
                    onStatusUpdate(
                        `[${i + 1}/${total}] ${subFuncSpec.name} failed after ${maxSubRetries} attempts, creating stub...`,
                        {
                            type: 'subfunction-failed',
                            index: i,
                            name: subFuncSpec.name,
                            error: lastSubError
                        }
                    );

                    const stubFunction = {
                        name: subFuncSpec.name,
                        description: `${subFuncSpec.purpose} (STUB - generation failed: ${lastSubError})`,
                        inputs: subFuncSpec.inputs || [],
                        outputs: subFuncSpec.outputs || {},
                        steps: [{
                            type: 'script',
                            code: `return { error: "Sub-function ${subFuncSpec.name} could not be generated" };`,
                            description: 'Stub function - returns error'
                        }],
                        source: 'workflow-stub',
                        createdAt: Date.now()
                    };

                    generatedSubFunctions.push(stubFunction);
                    allFunctions[stubFunction.name] = stubFunction;
                }
            }

            // 4. GENERATE ORCHESTRATION CODE (master phase)
            const masterPhaseIdx = detailedPlan.phases.length - 1;
            const masterPhase = detailedPlan.phases[masterPhaseIdx];

            onStatusUpdate(`[${masterPhase.steps[0].id}] Generating orchestration code...`, {
                type: 'workflow-step',
                phaseIndex: masterPhaseIdx,
                stepIndex: 0,
                stepId: masterPhase.steps[0].id,
                status: 'active'
            });

            // Also mark master phase as generating
            onStatusUpdate(`Generating master orchestrator...`, {
                type: 'subfunction-start',
                index: masterPhaseIdx,
                name: masterPhase.name
            });

            const orchestrationCode = await this.generateOrchestrationCode(
                workflowPlan,
                generatedSubFunctions,
                apiKey
            );
            console.log('[Workflow] Orchestration code:', orchestrationCode);

            onStatusUpdate(`[${masterPhase.steps[0].id}] Orchestration code generated`, {
                type: 'workflow-step',
                phaseIndex: masterPhaseIdx,
                stepIndex: 0,
                stepId: masterPhase.steps[0].id,
                status: 'completed'
            });

            // 5. ASSEMBLE MASTER FUNCTION
            onStatusUpdate(`[${masterPhase.steps[1].id}] Assembling master function...`, {
                type: 'workflow-step',
                phaseIndex: masterPhaseIdx,
                stepIndex: 1,
                stepId: masterPhase.steps[1].id,
                status: 'active'
            });

            let masterFunctionDef = {
                name: workflowPlan.masterFunction.name,
                description: workflowPlan.masterFunction.description,
                inputs: workflowPlan.masterFunction.inputs,
                outputs: workflowPlan.masterFunction.outputs,
                steps: [{
                    type: 'script',
                    description: 'Orchestrate workflow: coordinate sub-function calls and aggregate results',
                    code: orchestrationCode
                }],
                referenceFunctions: generatedSubFunctions.map(f => f.name),
                source: 'ai-workflow',
                workflowMetadata: {
                    subFunctions: generatedSubFunctions.map(f => f.name),
                    generatedAt: Date.now(),
                    orchestrationStrategy: workflowPlan.masterFunction.orchestrationStrategy
                },
                createdAt: Date.now(),
                testsPassed: false
            };

            const inheritedPatterns = Array.from(new Set(
                generatedSubFunctions
                    .flatMap(f => Array.isArray(f?.urlPatterns) ? f.urlPatterns : [])
                    .filter(Boolean)
            ));
            if (inheritedPatterns.length > 0) {
                masterFunctionDef.urlPatterns = inheritedPatterns;
            }

            onStatusUpdate(`[${masterPhase.steps[1].id}] Master function assembled`, {
                type: 'workflow-step',
                phaseIndex: masterPhaseIdx,
                stepIndex: 1,
                stepId: masterPhase.steps[1].id,
                status: 'completed'
            });

            // 6. TEST WORKFLOW END-TO-END (before saving, after assembly)
            // Only run if no stubs exist (otherwise workflow will definitely fail)
            const hasStubs = generatedSubFunctions.some(f => f.source === 'workflow-stub');
            if (!hasStubs) {
                this._throwIfAbortRequested(control, 'workflow end-to-end test');
                // Pre-save sub-functions to storage so master function's page.executeFunction() calls can find them
                const preSaved = await this._loadFunctionLibrary();
                for (const subFunc of generatedSubFunctions) {
                    preSaved[subFunc.name] = subFunc;
                }
                await this._saveFunctionLibrary(preSaved);
                console.log(`[Workflow] Pre-saved ${generatedSubFunctions.length} sub-functions for workflow test`);
                onStatusUpdate(`Testing workflow end-to-end...`, {
                    type: 'workflow-step',
                    phaseIndex: masterPhaseIdx,
                    stepIndex: masterPhase.steps.findIndex(s => s.action === 'workflow-test') ?? 2,
                    stepId: masterPhase.steps.find(s => s.action === 'workflow-test')?.id || `${masterPhaseIdx + 1}.3`,
                    status: 'active'
                });

                let workflowTest;
                if (this._isStopTestsAndSaveRequested(control)) {
                    onStatusUpdate(`[Workflow Test] Skipping end-to-end workflow test (requested by user).`);
                    workflowTest = {
                        success: true,
                        masterDef: { ...masterFunctionDef, testsPassed: false },
                        skippedByUser: true
                    };
                } else {
                    workflowTest = await this.testAndCorrectWorkflow(
                        masterFunctionDef, generatedSubFunctions, apiKey,
                        {
                            onStatusUpdate: (msg) => onStatusUpdate(`[Workflow Test] ${msg}`),
                            maxCorrections: 1,
                            shouldAbort: control.shouldAbort,
                            shouldStopTestingAndSave: control.shouldStopTestingAndSave
                        }
                    );
                }

                // Use potentially corrected master function
                masterFunctionDef = workflowTest.masterDef;

                if (workflowTest.success) {
                    onStatusUpdate(workflowTest.skippedByUser ? `Workflow end-to-end test skipped by user.` : `Workflow end-to-end test passed!`, {
                        type: 'workflow-step',
                        phaseIndex: masterPhaseIdx,
                        stepIndex: masterPhase.steps.findIndex(s => s.action === 'workflow-test') ?? 2,
                        stepId: masterPhase.steps.find(s => s.action === 'workflow-test')?.id || `${masterPhaseIdx + 1}.3`,
                        status: 'completed'
                    });
                } else {
                    onStatusUpdate(`Workflow test failed — saving anyway with best version.`, {
                        type: 'workflow-step',
                        phaseIndex: masterPhaseIdx,
                        stepIndex: masterPhase.steps.findIndex(s => s.action === 'workflow-test') ?? 2,
                        stepId: masterPhase.steps.find(s => s.action === 'workflow-test')?.id || `${masterPhaseIdx + 1}.3`,
                        status: 'failed'
                    });
                }
            }

            // 7. CHECK FOR STUBS — DON'T SAVE IF ANY SUB-FUNCTIONS FAILED
            const failedSubs = generatedSubFunctions.filter(f => f.source === 'workflow-stub');
            const successfulSubs = generatedSubFunctions.filter(f => f.source !== 'workflow-stub');

            if (failedSubs.length > 0) {
                const failedNames = failedSubs.map(f => f.name).join(', ');
                const failureMsg = `Workflow generation FAILED. ${failedSubs.length} sub-function(s) could not be generated: ${failedNames}`;
                console.error(`[Workflow] ${failureMsg}`);

                const saveStepIdx = masterPhase.steps.findIndex(s => s.action === 'save');
                onStatusUpdate(failureMsg, {
                    type: 'workflow-step',
                    phaseIndex: masterPhaseIdx,
                    stepIndex: saveStepIdx,
                    stepId: masterPhase.steps[saveStepIdx].id,
                    status: 'failed'
                });

                onStatusUpdate(`Workflow not saved — fix the failing sub-functions and try again.`, {
                    type: 'subfunction-failed',
                    index: masterPhaseIdx,
                    name: masterPhase.name,
                    error: failureMsg
                });

                // Clean up any successfully generated sub-functions that were part of this failed workflow
                // (don't leave orphans in storage)
                try {
                    const currentLib = await this._loadFunctionLibrary();
                    for (const subFunc of successfulSubs) {
                        if (currentLib[subFunc.name]) {
                            delete currentLib[subFunc.name];
                        }
                    }
                    if (currentLib[masterFunctionDef.name]) {
                        delete currentLib[masterFunctionDef.name];
                    }
                    await this._saveFunctionLibrary(currentLib);
                } catch (cleanupErr) {
                    console.warn('[Workflow] Cleanup of orphaned functions failed:', cleanupErr);
                }

                return {
                    success: false,
                    error: failureMsg,
                    failedSubFunctions: failedSubs.map(f => f.name),
                    successfulSubFunctions: successfulSubs.map(f => f.name)
                };
            }

            // All sub-functions succeeded — save everything
            this._throwIfAbortRequested(control, 'workflow save');
            const saveIdx = masterPhase.steps.findIndex(s => s.action === 'save');
            onStatusUpdate(`[${masterPhase.steps[saveIdx].id}] Saving all functions...`, {
                type: 'workflow-step',
                phaseIndex: masterPhaseIdx,
                stepIndex: saveIdx,
                stepId: masterPhase.steps[saveIdx].id,
                status: 'active'
            });

            const savedFunctions = await this._loadFunctionLibrary();

            for (const subFunc of generatedSubFunctions) {
                savedFunctions[subFunc.name] = subFunc;
            }
            savedFunctions[masterFunctionDef.name] = masterFunctionDef;

            await this._saveFunctionLibrary(savedFunctions);

            const prunedCount = await this._pruneFailedVersionedSiblings(
                [...generatedSubFunctions.map(f => f.name), masterFunctionDef.name]
            );
            if (prunedCount > 0) {
                onStatusUpdate(`Cleaned up ${prunedCount} failed previous version(s).`);
            }

            onStatusUpdate(
                `Workflow saved! Master: "${masterFunctionDef.name}" + ${generatedSubFunctions.length} sub-functions`,
                {
                    type: 'subfunction-complete',
                    index: masterPhaseIdx,
                    name: masterPhase.name
                }
            );

            return {
                success: true,
                functionDef: masterFunctionDef,
                subFunctions: generatedSubFunctions
            };

        } catch (error) {
            console.error('[Workflow] Pipeline error:', error);
            return {
                success: false,
                error: error.message,
                aborted: /Stopped by user/i.test(String(error?.message || ''))
            };
        }
    },

    // ==================== SCREENSHOT-BASED TESTING & AI CORRECTION ====================

    /**
     * Test a sub-function with diverse test cases, screenshot verification, and AI-guided correction.
     * Flow: generate tests → run each test → screenshot → AI verify → if fail → AI fix → retest.
     * Up to maxCorrections AI fix attempts before giving up.
     *
     * @param {object} functionDef - The generated function to test
     * @param {string} apiKey - Gemini API key
     * @param {object} options - { onStatusUpdate, maxCorrections, showTestsForeground }
     * @returns {object} { success, functionDef (potentially corrected), testResults, corrected }
     */
    async testAndCorrectSubFunction(functionDef, apiKey, options = {}) {
        const {
            onStatusUpdate = () => {},
            maxCorrections = 3,
            showTestsForeground = true,
            shouldAbort = () => false,
            shouldStopTestingAndSave = () => false
        } = options;

        const control = { shouldAbort, shouldStopTestingAndSave };
        this._throwIfAbortRequested(control, 'sub-function test setup');
        if (this._isStopTestsAndSaveRequested(control)) {
            onStatusUpdate(`Skipping tests for "${functionDef.name}" (requested by user).`);
            const skippedFunc = { ...functionDef, testsPassed: false, testResults: [] };
            return { success: true, functionDef: skippedFunc, testResults: [], corrected: false, skippedByUser: true };
        }

        // 1. Generate diverse test cases
        onStatusUpdate(`Testing "${functionDef.name}": generating test cases...`);
        let testCases = [];
        try {
            const testResult = await AIService.generateTestCases(functionDef, apiKey);
            testCases = testResult.testCases || [];
        } catch (e) {
            console.warn(`[Test] Test generation failed for ${functionDef.name}:`, e);
            onStatusUpdate(`Could not generate tests for "${functionDef.name}". Using fallback smoke test.`);
        }

        testCases = this._ensureAtLeastOneTestCase(functionDef, testCases);

        onStatusUpdate(`Testing "${functionDef.name}": ${testCases.length} test cases`);

        // 2. CORRECTION LOOP: test → diagnose → fix → retest
        // Track the best version (most tests passing) to avoid regression from bad corrections
        let currentFuncDef = { ...functionDef, steps: [...functionDef.steps] };
        let allTestResults = [];
        let bestVersion = { funcDef: { ...currentFuncDef }, passCount: 0, testResults: [] };
        let lastWorkingSnapshot = null;

        for (let correction = 0; correction <= maxCorrections; correction++) {
            this._throwIfAbortRequested(control, 'sub-function testing');
            if (this._isStopTestsAndSaveRequested(control)) {
                onStatusUpdate(`Stopping tests early for "${functionDef.name}" and keeping current version.`);
                currentFuncDef.testsPassed = false;
                currentFuncDef.testResults = allTestResults;
                return { success: true, functionDef: currentFuncDef, testResults: allTestResults, corrected: correction > 0, skippedByUser: true };
            }
            const isRetry = correction > 0;
            if (isRetry) {
                onStatusUpdate(`Correction attempt ${correction}/${maxCorrections} for "${functionDef.name}"...`);
            }

            let allPassed = true;
            let failedTests = [];
            let passingTests = [];
            allTestResults = [];

            // Run each test case
            for (const testCase of testCases) {
                this._throwIfAbortRequested(control, `sub-function test "${testCase.name}"`);
                if (this._isStopTestsAndSaveRequested(control)) {
                    onStatusUpdate(`Stopping remaining tests for "${functionDef.name}" and keeping current version.`);
                    currentFuncDef.testsPassed = false;
                    currentFuncDef.testResults = allTestResults;
                    return { success: true, functionDef: currentFuncDef, testResults: allTestResults, corrected: isRetry, skippedByUser: true };
                }
                let testContext = null;
                try {
                    onStatusUpdate(`  Running test: "${testCase.name}"...`);
                    testContext = await this._createTestExecutionContext(
                        currentFuncDef,
                        showTestsForeground,
                        onStatusUpdate
                    );

                    // Execute function
                    const execResult = await chrome.runtime.sendMessage({
                        type: 'executeGeneratedFunction',
                        functionDef: currentFuncDef,
                        inputs: testCase.inputs,
                        tabId: testContext.tabId
                    });

                    // Stabilize viewport before screenshot verification.
                    await this._scrollTabToTop(testContext.tabId);

                    // Capture screenshot (bring window to foreground — required by captureVisibleTab)
                    let screenshot = null;
                    try {
                        screenshot = await this._captureTestScreenshot(testContext.windowId, testContext.tabId);
                    } catch (e) {
                        console.warn('[Test] Screenshot capture failed:', e);
                    }

                    // Verify with screenshot + data
                    const verification = await AIService.verifyWithScreenshot(
                        currentFuncDef, execResult, screenshot, apiKey
                    );

                    const testResultEntry = {
                        name: testCase.name,
                        inputs: testCase.inputs,
                        passed: verification.valid,
                        issues: verification.issues || [],
                        hasScreenshot: !!screenshot
                    };
                    allTestResults.push(testResultEntry);

                    if (!verification.valid) {
                        allPassed = false;
                        failedTests.push({
                            testCase,
                            execResult,
                            screenshot,
                            issues: verification.issues,
                            tabId: testContext?.tabId
                        });
                        onStatusUpdate(`  FAIL: "${testCase.name}" — ${(verification.issues || []).join('; ')}`);
                    } else {
                        passingTests.push({ name: testCase.name, output: execResult?.data });
                        let finalUrl = '';
                        try {
                            const finalTab = await chrome.tabs.get(testContext.tabId);
                            finalUrl = finalTab?.url || '';
                        } catch {
                            finalUrl = '';
                        }
                        lastWorkingSnapshot = {
                            testName: testCase.name,
                            inputs: { ...(testCase.inputs || {}) },
                            url: finalUrl
                        };
                        onStatusUpdate(`  PASS: "${testCase.name}"`);
                    }

                } catch (e) {
                    allPassed = false;
                    const errorIssue = `Test error: ${e.message}`;
                    failedTests.push({
                        testCase,
                        execResult: { success: false, error: e.message },
                        screenshot: null,
                        issues: [errorIssue],
                        tabId: testContext?.tabId
                    });
                    allTestResults.push({ name: testCase.name, passed: false, issues: [errorIssue], hasScreenshot: false });
                    onStatusUpdate(`  ERROR: "${testCase.name}" — ${e.message}`);
                } finally {
                    // Don't cleanup the FIRST failed test window yet - we need it for diagnosis
                    // Only cleanup if this test passed OR if we already have a failed test saved
                    const isFirstFailure = !allPassed && failedTests.length === 1;
                    if (!isFirstFailure) {
                        await this._cleanupTestExecutionContext(testContext);
                    }
                }
            }

            // Track best version to avoid regression from bad corrections
            const currentPassCount = allTestResults.filter(t => t.passed).length;
            if (currentPassCount > bestVersion.passCount) {
                bestVersion = {
                    funcDef: { ...currentFuncDef },
                    passCount: currentPassCount,
                    testResults: [...allTestResults]
                };
            }

            // All tests passed — success!
            if (allPassed) {
                const msg = isRetry
                    ? `All ${testCases.length} tests passed for "${functionDef.name}" (after ${correction} correction(s))`
                    : `All ${testCases.length} tests passed for "${functionDef.name}"`;
                onStatusUpdate(msg);
                currentFuncDef.testCases = testCases;
                currentFuncDef.testsPassed = true;
                currentFuncDef.testResults = allTestResults;
                return { success: true, functionDef: currentFuncDef, testResults: allTestResults, corrected: isRetry };
            }

            // Tests failed — attempt AI correction (if attempts remain)
            if (correction < maxCorrections) {
                const firstFailure = failedTests[0];
                const allIssues = failedTests.flatMap(f => f.issues);
                onStatusUpdate(`${failedTests.length}/${testCases.length} test(s) failed. Asking AI for correction...`);

                // Analyze which fields work vs broken (from passing vs failing test data)
                let workingFields = [];
                let brokenFields = [];
                if (passingTests.length > 0 && failedTests.length > 0) {
                    const passingData = passingTests[0]?.output;
                    const failingIssues = allIssues.join(' ').toLowerCase();
                    if (passingData && typeof passingData === 'object') {
                        const sampleObj = Array.isArray(passingData) ? passingData[0] : passingData;
                        if (sampleObj) {
                            for (const key of Object.keys(sampleObj)) {
                                if (failingIssues.includes(key.toLowerCase())) {
                                    brokenFields.push(key);
                                } else {
                                    workingFields.push(key);
                                }
                            }
                        }
                    }
                }

                // Reset to a stable/known state before computer-use diagnosis.
                await this._restoreDiagnosisContext({
                    tabId: firstFailure?.tabId,
                    lastWorkingSnapshot,
                    failingTestCase: firstFailure?.testCase,
                    functionDef: currentFuncDef,
                    onStatusUpdate
                });

                // Enhanced diagnosis: interactive computer-use investigation with structured findings
                const diagnosis = await this._runEnhancedDiagnosis({
                    functionDef: currentFuncDef,
                    taskDescription: functionDef?.description || '',
                    testCase: firstFailure?.testCase,
                    errorMessage: firstFailure?.execResult?.error || allIssues[0] || 'Unknown failure',
                    issues: allIssues,
                    apiKey,
                    tabId: firstFailure?.tabId,
                    onStatusUpdate,
                    control,
                    contextLabel: `${functionDef.name} test failure`,
                    priorFindings: currentFuncDef._explorationFindings || null,
                    actionBudget: 10
                });
                const diagnosisContext = this._truncateForContext(diagnosis?.contextText || '', 900);
                const structuredFindings = diagnosis?.findings
                    ? this._findingsToContextString(diagnosis.findings, 1200)
                    : '';
                const issuesForFix = [...allIssues];
                if (diagnosisContext) {
                    issuesForFix.push(`Computer-use diagnosis: ${diagnosisContext}`);
                }

                // Cleanup the first failed test window now that diagnosis is complete
                if (failedTests.length > 0 && failedTests[0].tabId) {
                    try {
                        const tab = await chrome.tabs.get(failedTests[0].tabId);
                        if (tab?.windowId) {
                            await chrome.windows.remove(tab.windowId);
                        }
                    } catch (e) {
                        // Window may already be closed, ignore
                    }
                }

                const fix = await AIService.generateFunctionFix(
                    currentFuncDef,
                    firstFailure.execResult,
                    firstFailure.screenshot,
                    issuesForFix,
                    apiKey,
                    {
                        passingTests,
                        workingFields,
                        brokenFields,
                        structuredFindings,
                        computerUseDiagnosis: diagnosisContext,
                        failureContext: this._truncateForContext(
                            `Failed test "${firstFailure?.testCase?.name || 'unknown'}". Error: ${firstFailure?.execResult?.error || 'none'}`,
                            500
                        )
                    }
                );

                if (fix?.fixedSteps) {
                    const optimizedFix = this._optimizeSubFunctionFixedSteps(currentFuncDef, fix.fixedSteps);
                    if (!optimizedFix.accepted) {
                        onStatusUpdate(`Rejected AI fix: ${optimizedFix.reason}`);
                        console.warn(`[Test] Rejected fix for ${functionDef.name}:`, optimizedFix.reason);
                    } else {
                        onStatusUpdate(`AI fix applied: ${fix.fixDescription || 'Steps corrected'}`);
                        console.log(`[Test] Fix for ${functionDef.name}:`, fix.fixDescription);
                        currentFuncDef = { ...currentFuncDef, steps: optimizedFix.steps };
                    }
                } else {
                    onStatusUpdate(`AI could not generate a fix. Stopping corrections.`);
                    break;
                }
            }
        }

        // All corrections exhausted — use the BEST version (most tests passing), not the last one
        const finalPassCount = allTestResults.filter(t => t.passed).length;
        const useBest = bestVersion.passCount > finalPassCount;
        const finalFunc = useBest ? bestVersion.funcDef : currentFuncDef;
        const finalResults = useBest ? bestVersion.testResults : allTestResults;
        const displayCount = useBest ? bestVersion.passCount : finalPassCount;

        if (useBest) {
            onStatusUpdate(`Corrections made things worse — reverting to best version (${bestVersion.passCount}/${testCases.length} passed).`);
        }

        onStatusUpdate(`"${functionDef.name}" finished testing: ${displayCount}/${testCases.length} passed after ${maxCorrections} correction attempts.`);
        finalFunc.testsPassed = false;
        finalFunc.testResults = finalResults;
        return { success: false, functionDef: finalFunc, testResults: finalResults, corrected: false };
    },

    /**
     * Test the entire workflow end-to-end: run the master function and verify output.
     * If it fails, AI attempts to fix the orchestration code (master function's script step).
     * Uses only 1 test case since full workflow execution is expensive.
     *
     * @param {object} masterDef - The master function definition
     * @param {object[]} subFunctions - Array of sub-function definitions
     * @param {string} apiKey - Gemini API key
     * @param {object} options - { onStatusUpdate, maxCorrections, showTestsForeground }
     * @returns {object} { success, masterDef (potentially corrected), subFunctions, testResults }
     */
    async testAndCorrectWorkflow(masterDef, subFunctions, apiKey, options = {}) {
        const {
            onStatusUpdate = () => {},
            maxCorrections = 3,
            showTestsForeground = true,
            shouldAbort = () => false,
            shouldStopTestingAndSave = () => false
        } = options;

        const control = { shouldAbort, shouldStopTestingAndSave };
        this._throwIfAbortRequested(control, 'workflow test setup');
        if (this._isStopTestsAndSaveRequested(control)) {
            onStatusUpdate(`Skipping workflow tests for "${masterDef.name}" (requested by user).`);
            const skippedMaster = { ...masterDef, testsPassed: false };
            return {
                success: true,
                masterDef: skippedMaster,
                subFunctions,
                testResults: [{ name: 'Workflow Test', passed: false, skippedByUser: true }],
                skippedByUser: true
            };
        }

        onStatusUpdate(`Testing full workflow "${masterDef.name}"...`);

        // Generate test cases for the master function
        let testCases = [];
        try {
            const testResult = await AIService.generateTestCases(masterDef, apiKey);
            testCases = testResult.testCases || [];
        } catch (e) {
            console.warn('[WorkflowTest] Test generation failed:', e);
            onStatusUpdate(`Could not generate workflow tests. Using fallback smoke test.`);
        }

        testCases = this._ensureAtLeastOneTestCase(masterDef, testCases);

        // Use first test case only (workflow execution is expensive)
        const testCase = testCases[0];

        let currentMasterDef = { ...masterDef };

        for (let attempt = 0; attempt <= maxCorrections; attempt++) {
            this._throwIfAbortRequested(control, 'workflow testing');
            if (this._isStopTestsAndSaveRequested(control)) {
                onStatusUpdate(`Stopping workflow tests early and keeping current orchestration.`);
                currentMasterDef.testsPassed = false;
                return {
                    success: true,
                    masterDef: currentMasterDef,
                    subFunctions,
                    testResults: [{ name: testCase.name, passed: false, skippedByUser: true }],
                    skippedByUser: true
                };
            }
            let testContext = null;
            try {
                const attemptLabel = attempt > 0 ? ` (correction ${attempt}/${maxCorrections})` : '';
                onStatusUpdate(`Workflow test${attemptLabel}: "${testCase.name}"...`);

                testContext = await this._createTestExecutionContext(
                    currentMasterDef,
                    showTestsForeground,
                    onStatusUpdate
                );

                // Execute master function (this calls sub-functions internally)
                const execResult = await chrome.runtime.sendMessage({
                    type: 'executeGeneratedFunction',
                    functionDef: currentMasterDef,
                    inputs: testCase.inputs,
                    tabId: testContext.tabId
                });

                // Capture screenshot
                await this._scrollTabToTop(testContext.tabId);
                let screenshot = null;
                try {
                    screenshot = await this._captureTestScreenshot(testContext.windowId, testContext.tabId);
                } catch {}

                // Verify
                const verification = await AIService.verifyWithScreenshot(
                    currentMasterDef, execResult, screenshot, apiKey
                );

                if (verification.valid) {
                    onStatusUpdate(`Workflow test passed!`);
                    currentMasterDef.testsPassed = true;
                    currentMasterDef.testCases = testCases;
                    return {
                        success: true,
                        masterDef: currentMasterDef,
                        subFunctions,
                        testResults: [{ name: testCase.name, passed: true }]
                    };
                }

                // Failed — try AI correction of orchestration code
                onStatusUpdate(`Workflow test failed: ${(verification.issues || []).join('; ')}`);

                if (attempt < maxCorrections) {
                    const issueList = verification.issues || ['Workflow produced incorrect results'];

                    // Enhanced diagnosis with interactive investigation
                    await this._restoreDiagnosisContext({
                        tabId: testContext?.tabId,
                        lastWorkingSnapshot: null,
                        failingTestCase: testCase,
                        functionDef: currentMasterDef,
                        onStatusUpdate
                    });
                    const diagnosis = await this._runEnhancedDiagnosis({
                        functionDef: currentMasterDef,
                        taskDescription: masterDef?.description || '',
                        testCase,
                        errorMessage: execResult?.error || issueList[0] || 'Workflow verification failed',
                        issues: issueList,
                        apiKey,
                        tabId: testContext?.tabId,
                        onStatusUpdate,
                        control,
                        contextLabel: `${masterDef.name} workflow failure`,
                        priorFindings: currentMasterDef._explorationFindings || null,
                        actionBudget: 10
                    });
                    const diagnosisContext = this._truncateForContext(diagnosis?.contextText || '', 900);
                    const structuredFindings = diagnosis?.findings
                        ? this._findingsToContextString(diagnosis.findings, 1200)
                        : '';
                    const issuesForFix = [...issueList];
                    if (diagnosisContext) {
                        issuesForFix.push(`Computer-use diagnosis: ${diagnosisContext}`);
                    }

                    onStatusUpdate(`Asking AI to fix orchestration code...`);
                    const fix = await AIService.generateFunctionFix(
                        currentMasterDef, execResult, screenshot,
                        issuesForFix,
                        apiKey,
                        {
                            structuredFindings,
                            computerUseDiagnosis: diagnosisContext,
                            failureContext: this._truncateForContext(
                                `Workflow test "${testCase?.name || 'unknown'}" failed. Error: ${execResult?.error || 'none'}`,
                                500
                            )
                        }
                    );
                    if (fix?.fixedSteps) {
                        const optimizedFix = this._optimizeWorkflowFixedSteps(fix.fixedSteps);
                        if (!optimizedFix.accepted) {
                            onStatusUpdate(`Rejected workflow fix: ${optimizedFix.reason}`);
                            console.warn('[WorkflowTest] Rejected fix:', optimizedFix.reason);
                        } else {
                            onStatusUpdate(`Workflow fix applied: ${fix.fixDescription || 'Orchestration corrected'}`);
                            console.log('[WorkflowTest] Fix:', fix.fixDescription);
                            currentMasterDef = { ...currentMasterDef, steps: optimizedFix.steps };
                        }
                    } else {
                        onStatusUpdate(`AI could not generate a workflow fix. Stopping.`);
                        break;
                    }
                }
            } catch (e) {
                console.warn(`[WorkflowTest] Attempt ${attempt + 1} error:`, e);
                onStatusUpdate(`Workflow test error: ${e.message}`);
                if (attempt >= maxCorrections) break;
            } finally {
                await this._cleanupTestExecutionContext(testContext);
            }
        }

        onStatusUpdate(`Workflow test failed after ${maxCorrections} correction attempts.`);
        currentMasterDef.testsPassed = false;
        return {
            success: false,
            masterDef: currentMasterDef,
            subFunctions,
            testResults: [{ name: testCase.name, passed: false }]
        };
    },

    // ==================== TASK PLANNING ====================

    /**
     * Analyze the natural language task and produce a structured plan.
     * Determines: function name, inputs, outputs, navigation strategy,
     * extraction strategy, scroll-loop needs.
     */
    async planTask(taskDescription, apiKey, existingFunctions = {}, retryNotes = [], currentTabContext = null) {
        const existingFuncSummary = Object.values(existingFunctions).map(f => ({
            name: f.name,
            description: f.description,
            urlPatterns: f.urlPatterns,
            inputs: f.inputs,
            outputs: f.outputs
        }));

        const schema = {
            type: "OBJECT",
            properties: {
                plan: {
                    type: "OBJECT",
                    properties: {
                        name: { type: "STRING", description: "CamelCase function name" },
                        description: { type: "STRING" },
                        inputs: {
                            type: "ARRAY",
                            items: {
                                type: "OBJECT",
                                properties: {
                                    name: { type: "STRING" },
                                    type: { type: "STRING", enum: ["string", "number", "boolean"] },
                                    description: { type: "STRING" },
                                    defaultValue: { type: "STRING" }
                                },
                                required: ["name", "type"]
                            }
                        },
                        outputs: {
                            type: "OBJECT",
                            properties: {
                                type: { type: "STRING", enum: ["string", "object", "array"] },
                                description: { type: "STRING" },
                                fields: { type: "STRING" }
                            }
                        },
                        navigationStrategy: { type: "STRING", enum: ["url", "computer-use", "current-tab"] },
                        useCurrentTab: { type: "BOOLEAN", description: "True when the function should operate on the currently active tab context instead of opening/navigating elsewhere first." },
                        urlTemplate: { type: "STRING", description: "URL with {{inputName}} placeholders. Only when navigationStrategy is 'url'." },
                        navigationInstructions: { type: "STRING", description: "Natural language instructions for the visual agent. Only when navigationStrategy is 'computer-use'." },
                        extractionStrategy: { type: "STRING", enum: ["smartScrape", "script", "none"] },
                        needsScrollLoop: { type: "BOOLEAN" },
                        urlPatterns: { type: "ARRAY", items: { type: "STRING" } },
                        waitForSelector: { type: "STRING", description: "CSS selector to wait for after navigation, confirming page loaded" }
                    },
                    required: ["name", "description", "inputs", "outputs", "navigationStrategy", "extractionStrategy", "needsScrollLoop"]
                }
            },
            required: ["plan"]
        };

        const currentTabContextText = this._formatCurrentTabContextForPrompt(currentTabContext);
        let prompt = `You are an expert browser automation architect.

TASK: The user wants an automation function that does: "${taskDescription}"

CURRENT TAB SNAPSHOT (live page context):
${currentTabContextText || '(unavailable)'}

Your job is to PLAN this function - do NOT generate code or steps yet.

ANALYSIS REQUIRED:
1. FUNCTION NAME: CamelCase name (e.g., "ScrapeFlipkartSearchResults")
2. DESCRIPTION: What this function does
3. INPUTS: What parameters does the user need to provide?
   - Example: { name: "numberOfResults", type: "number", description: "How many results to return", defaultValue: "10" }
   - Example: { name: "searchQuery", type: "string", description: "What to search for" }
4. OUTPUTS: What data will be returned?
   - type: "array" for lists, "object" for single items, "string" for text
   - fields: comma-separated field names (e.g., "title, price, rating, imageUrl, productUrl")
5. NAVIGATION STRATEGY: How to get to the target page?
   - "url": Can construct a direct URL (e.g., "https://www.flipkart.com/search?q={{searchQuery}}")
     Use this when: URL query parameters are well-known (Google, Amazon, Flipkart, YouTube, eBay, etc.)
   - "computer-use": Need visual navigation (click search bar, type, submit)
     Use this when: The site has no obvious URL pattern, requires login, or has multi-step navigation
   - "current-tab": Work directly on the currently open tab/page content without initial navigation
     Use this when: The request refers to "this page", "current tab", "on this page", or current-page context
   - Include useCurrentTab=true when strategy is "current-tab"
   - Include the urlTemplate if strategy is "url" (with {{inputName}} placeholders for inputs)
   - Include navigationInstructions if strategy is "computer-use" (natural language for the visual agent)
6. EXTRACTION STRATEGY:
   - "smartScrape": For extracting lists/grids of repeating items (products, search results, table rows, cards, articles)
   - "script": For simple single-value extraction or custom logic
   - "none": For action-only tasks (no data extraction needed)
7. NEEDS SCROLL LOOP: true if the user wants more results than typically fit on one screen
   - If true, the function will scroll + re-extract until enough results are gathered
8. URL PATTERNS: Array of URL glob patterns this function operates on (e.g., ["https://www.flipkart.com/*"])
9. WAIT FOR SELECTOR: A CSS selector to wait for after navigation to confirm the page has loaded
   (e.g., "[data-component-type='s-search-result']" for Amazon search, ".search-card" for Flipkart)

CRITICAL RULES:
- Choose the simplest reliable navigation strategy for this task.
- Prefer direct "url" navigation when a stable URL template is available.
- If the task is clearly about the currently open page/tab, choose "current-tab".
- Use "computer-use" navigation only when URL-based navigation is not reliable or the task requires UI-only flows.
- ALWAYS provide navigationInstructions (natural language for the visual agent) regardless of strategy.
- The function MUST return useful data. Never return void.
- If extracting a list, outputs.type MUST be "array" and include the relevant fields.`;

        if (existingFuncSummary.length > 0) {
            prompt += `\n\nEXISTING FUNCTIONS IN LIBRARY:
${JSON.stringify(existingFuncSummary, null, 2)}
Consider whether any existing function can be REUSED or COMPOSED with for this task.`;
        }

        if (retryNotes.length > 0) {
            prompt += `\n\nPREVIOUS ATTEMPT ERRORS (fix these):
${retryNotes.join('\n')}`;
        }

        const requestBody = {
            contents: [{
                role: 'user',
                parts: [{ text: prompt }]
            }],
            generationConfig: {
                responseMimeType: 'application/json',
                responseJsonSchema: schema,
                maxOutputTokens: 4096
            }
        };

        return await AIService.callGemini(requestBody, apiKey);
    },

    // ==================== STEP GENERATION ====================

    /**
     * Generate concrete execution steps from the plan.
     * Uses AIService.TOOL_DEFINITIONS step types.
     */
    async generateTaskSteps(plan, apiKey, retryNotes = [], currentTabContext = null) {
        const stepSchema = {
            type: "OBJECT",
            properties: {
                implementation: {
                    type: "OBJECT",
                    properties: {
                        steps: {
                            type: "ARRAY",
                            items: {
                                type: "OBJECT",
                                properties: {
                                    type: { type: "STRING", enum: ["click", "type", "pressKey", "scroll", "wait", "navigate", "extract", "script", "smartScrape"] },
                                    selector: { type: "STRING" },
                                    value: { type: "STRING" },
                                    key: { type: "STRING" },
                                    url: { type: "STRING" },
                                    timeout: { type: "INTEGER" },
                                    description: { type: "STRING" },
                                    condition: { type: "STRING" },
                                    amount: { type: "INTEGER" },
                                    direction: { type: "STRING" },
                                    code: { type: "STRING" },
                                    returnAs: { type: "STRING" }
                                },
                                required: ["type", "description"]
                            }
                        }
                    },
                    required: ["steps"]
                }
            },
            required: ["implementation"]
        };

        // Build the page API docs from AIService
        const pageAPIDocs = AIService.TOOL_DEFINITIONS.script.pageAPI.join('\n    ');
        const currentTabContextText = this._formatCurrentTabContextForPrompt(currentTabContext, 2200);

        // Determine the number input name for scroll-loop
        const countInputName = plan.inputs.find(i => i.type === 'number')?.name || 'count';

        let prompt = `You are an expert automation engineer.

GOAL: Generate execution STEPS for this planned automation function.

PLAN:
- Name: ${plan.name}
- Description: ${plan.description}
- Inputs: ${JSON.stringify(plan.inputs)}
- Outputs: ${JSON.stringify(plan.outputs)}
- Navigation: ${plan.navigationStrategy}
- Use Current Tab: ${plan.useCurrentTab === true || String(plan.navigationStrategy || '').toLowerCase() === 'current-tab'}
- Extraction: ${plan.extractionStrategy}
- Needs Scroll Loop: ${plan.needsScrollLoop}

CURRENT TAB SNAPSHOT (for selector grounding when relevant):
${currentTabContextText || '(unavailable)'}

AVAILABLE STEP TYPES:
- navigate: Navigate browser to a URL. Use {{inputName}} for parameterized URLs.
- click: Click on an element. Required: selector.
- type: Type text into input. Required: selector, value. Use {{inputName}} for inputs.
- pressKey: Press a keyboard key. Required: key.
- scroll: Scroll page. Optional: direction, amount, selector.
- wait: Wait for element or time. Optional: selector, timeout, condition (selector/text/time), value.
- extract: Extract text from element. Required: selector.
- script: Execute JavaScript code with page API access. Required: code.
- smartScrape: AI-powered structured data extraction from lists/grids. Optional: description, returnAs.

SCRIPT STEP - PAGE API:
    ${pageAPIDocs}

CRITICAL RULES:
1. Use {{inputName}} syntax for parameterized values in type steps and URL templates
2. If Navigation is "url", first step MUST be 'navigate' with the target URL.
3. If Navigation is "current-tab" or "computer-use", do NOT add an initial navigate step unless the task explicitly requires leaving the current page.
4. For data extraction from lists/grids, prefer 'smartScrape' over manual script loops
5. Use script when the task needs custom logic not covered by smartScrape`;

        // Navigation-specific instructions
        if (plan.navigationStrategy === 'url' && plan.urlTemplate) {
            prompt += `

NAVIGATION: Use direct URL navigation.
First step: { type: "navigate", url: "${plan.urlTemplate}", description: "Navigate to target page" }`;
        } else if (String(plan.navigationStrategy || '').toLowerCase() === 'current-tab') {
            prompt += `

NAVIGATION: Operate on the currently active tab/page context.
Do NOT include a navigate step for initial page load.
Start from the current tab state with wait/click/type/extract/script steps.`;
        } else if (plan.navigationStrategy === 'computer-use') {
            prompt += `

NAVIGATION: A computer-use visual agent will handle navigation SEPARATELY.
Do NOT include a navigate step for the initial page load.
Instead, start with a "wait" step for "${plan.waitForSelector || 'body'}" to confirm the page is loaded after visual navigation.
The computer-use agent will be injected before your steps automatically.`;
        }

        // Extraction instructions
        if (plan.extractionStrategy === 'smartScrape') {
            prompt += `

EXTRACTION: Use a 'smartScrape' step for data extraction.
Example: { type: "smartScrape", description: "Extract ${plan.outputs?.description || 'data'}", returnAs: "results" }
Do NOT use script steps with page.getElements()/page.extract() loops - smartScrape is more reliable.`;
        }

        // Scroll-loop instructions
        if (plan.needsScrollLoop) {
            prompt += `

SCROLL-AND-LOOP PATTERN REQUIRED:
The user needs up to inputs.${countInputName} results.
IMPORTANT: Each script step runs in an ISOLATED sandbox. Variables do NOT carry over between steps.
You MUST generate ONLY the smartScrape step - do NOT add a separate scroll-loop script step.
The system will automatically handle pagination by merging the smartScrape with scroll logic at runtime.

Generate ONLY these steps (no separate scroll-loop step):
1. Navigation step(s) as needed
2. A single smartScrape step for extraction
That's it. The system handles scroll-loop pagination automatically.`;
        }

        if (retryNotes.length > 0) {
            prompt += `\n\nPREVIOUS ERRORS (fix these):
${retryNotes.join('\n')}`;
        }

        const requestBody = {
            contents: [{
                role: 'user',
                parts: [{ text: prompt }]
            }],
            generationConfig: {
                responseMimeType: 'application/json',
                responseJsonSchema: stepSchema,
                maxOutputTokens: 8192
            }
        };

        return await AIService.callGemini(requestBody, apiKey);
    },

    // ==================== ORCHESTRATED EXECUTION ====================

    /**
     * Full pipeline: plan -> generate steps -> preflight scrape -> test -> save
     */
    async executeTaskPipeline(taskDescription, apiKey, options = {}) {
        const {
            onStatusUpdate = () => {},
            maxRetries: retryCount = 3,
            existingFunctions = {},
            showTestsForeground = true,
            prePlannedFunction = null,
            skipTesting = false,
            shouldAbort = () => false,
            shouldStopTestingAndSave = () => false,
            onFunctionBuilt = () => {},
            enableProactiveExploration = false
        } = options;
        const control = { shouldAbort, shouldStopTestingAndSave, onFunctionBuilt };
        const currentContextUrl = await this._getCurrentContextUrl();
        const currentTabContext = await this._getCurrentTabContext();
        const relevantExistingFunctions = this._filterFunctionsForCurrentUrl(existingFunctions, currentContextUrl);
        const totalExisting = Object.keys(existingFunctions || {}).length;
        const relevantCount = Object.keys(relevantExistingFunctions).length;
        if (totalExisting > 0) {
            onStatusUpdate(`Context functions: using ${relevantCount}/${totalExisting} URL-relevant functions${currentContextUrl ? ` for ${currentContextUrl}` : ''}.`);
        }

        let lastError = null;
        let attemptErrors = [];

        for (let attempt = 1; attempt <= retryCount; attempt++) {
            try {
                this._throwIfAbortRequested(control, `task pipeline attempt ${attempt}`);
                // 1. PLAN (skip if prePlannedFunction provided)
                let plan;
                const retryNotes = attempt > 1 ? attemptErrors : [];
                if (prePlannedFunction) {
                    plan = prePlannedFunction;
                    onStatusUpdate(`Using pre-planned function: ${plan.name}`);
                } else {
                    onStatusUpdate(`Attempt ${attempt}/${retryCount}: Planning task...`);
                    this._throwIfAbortRequested(control, 'task planning');
                    const planResult = await this.planTask(
                        taskDescription,
                        apiKey,
                        relevantExistingFunctions,
                        retryNotes,
                        currentTabContext
                    );
                    plan = planResult.plan;
                }

                const navStrategy = String(plan?.navigationStrategy || '').toLowerCase();
                if (navStrategy === 'current-tab') {
                    plan.useCurrentTab = true;
                } else if (plan?.useCurrentTab === undefined && this._taskMentionsCurrentTab(taskDescription)) {
                    plan.useCurrentTab = true;
                }

                // Single-item outputs should not use pagination loops.
                if (String(plan?.outputs?.type || '').toLowerCase() === 'object' && plan?.needsScrollLoop) {
                    plan.needsScrollLoop = false;
                    onStatusUpdate(`Adjusted plan: disabled scroll loop for single-object output "${plan.name}".`);
                }

                onStatusUpdate(`Plan: "${plan.name}" | Nav: ${plan.navigationStrategy}${plan.useCurrentTab ? ' (current-tab context)' : ''} | Extract: ${plan.extractionStrategy}`);
                console.log('[TaskPipeline] Plan selected:', JSON.stringify(plan, null, 2));

                // 2. GENERATE STEPS
                onStatusUpdate(`Generating execution steps...`);
                this._throwIfAbortRequested(control, 'step generation');
                const stepsResult = await this.generateTaskSteps(plan, apiKey, retryNotes, currentTabContext);
                let steps = stepsResult.implementation.steps;
                console.log('[TaskPipeline] Initial generated steps:', JSON.stringify(steps, null, 2));

                // 3. INJECT COMPUTER-USE NAVIGATION (if needed)
                if (plan.navigationStrategy === 'computer-use') {
                    const useCurrentTab = !!plan.useCurrentTab;
                    // First navigate to the site homepage, then use computer-use to click through
                    let homepageUrl = null;
                    if (!useCurrentTab) {
                        homepageUrl = (plan.urlPatterns && plan.urlPatterns.length > 0)
                            ? plan.urlPatterns[0].replace(/\*.*$/, '').replace(/\/$/, '') || plan.urlPatterns[0]
                            : null;
                    }

                    // Validate the computed URL — generic patterns like "https://*" produce "https:/" which is invalid
                    if (homepageUrl) {
                        try {
                            const parsed = new URL(homepageUrl);
                            if (!parsed.hostname || parsed.hostname.length < 3) {
                                homepageUrl = null; // Too generic, skip homepage nav
                            }
                        } catch {
                            homepageUrl = null; // Malformed URL, skip homepage nav
                        }
                    }

                    if (homepageUrl) {
                        steps.unshift({
                            type: 'navigate',
                            url: homepageUrl,
                            description: `Navigate to ${homepageUrl} homepage`
                        });
                    }

                    // Insert computer-use step after the homepage navigation
                    const cuInsertIdx = homepageUrl ? 1 : 0;
                    steps.splice(cuInsertIdx, 0, {
                        type: 'computerUseNavigate',
                        taskDescription: plan.navigationInstructions || `Navigate to the appropriate page for: ${taskDescription}`,
                        description: 'Visual navigation via Computer Use',
                        useCurrentTab,
                        target: useCurrentTab ? 'current-tab' : 'auto'
                    });
                    console.log('[TaskPipeline] Steps after computer-use injection:', JSON.stringify(steps, null, 2));
                }

                // 4. HANDLE SMART SCRAPE PRE-GENERATION
                const smartScrapeStepIndex = steps.findIndex(s => s.type === 'smartScrape');
                if (smartScrapeStepIndex !== -1) {
                    // Reuse a compatible scraper if one already exists for this domain and page type.
                    const existingFuncs = await this._loadFunctionLibrary();
                    let recordingDomain = null;
                    try {
                        if (plan.urlTemplate) {
                            recordingDomain = new URL(plan.urlTemplate.replace(/\{\{.*?\}\}/g, 'test')).hostname;
                        } else if (plan.urlPatterns && plan.urlPatterns.length > 0) {
                            recordingDomain = new URL(plan.urlPatterns[0].replace(/\*/g, 'example')).hostname;
                        }
                    } catch { /* ignore */ }

                    const normalizeField = (fieldName) => String(fieldName || '')
                        .trim()
                        .toLowerCase()
                        .replace(/[^a-z0-9]+/g, '');

                    const parseFieldList = (raw) => {
                        if (!raw) return [];
                        if (Array.isArray(raw)) {
                            return raw
                                .map(v => normalizeField(typeof v === 'string' ? v : v?.name))
                                .filter(Boolean);
                        }
                        if (typeof raw === 'string') {
                            return raw
                                .split(/[,\n;|]/)
                                .map(v => normalizeField(v))
                                .filter(Boolean);
                        }
                        if (typeof raw === 'object') {
                            return Object.keys(raw).map(k => normalizeField(k)).filter(Boolean);
                        }
                        return [];
                    };

                    const getScraperFieldSet = (funcDef) => {
                        const fromExtract = [];
                        for (const stepDef of (funcDef?.steps || [])) {
                            if (stepDef?.type === 'extractScript' && Array.isArray(stepDef.fields)) {
                                for (const fieldDef of stepDef.fields) {
                                    fromExtract.push(fieldDef?.name);
                                }
                            }
                        }
                        const fromOutputs = parseFieldList(funcDef?.outputs?.fields);
                        const merged = [
                            ...parseFieldList(fromExtract),
                            ...fromOutputs
                        ];
                        return new Set(merged.filter(Boolean));
                    };

                    const getPathHints = (patterns) => {
                        const hints = [];
                        for (const rawPattern of (patterns || [])) {
                            if (!rawPattern) continue;
                            try {
                                const normalized = String(rawPattern)
                                    .replace(/\{\{.*?\}\}/g, 'sample')
                                    .replace(/\*/g, '');
                                const parsed = new URL(normalized);
                                const firstSegment = parsed.pathname.split('/').filter(Boolean)[0] || '';
                                if (firstSegment) hints.push(firstSegment.toLowerCase());
                            } catch {
                                // ignore malformed patterns
                            }
                        }
                        return Array.from(new Set(hints));
                    };

                    const expectedFields = new Set(parseFieldList(plan.outputs?.fields));
                    const planPathHints = getPathHints([...(plan.urlPatterns || []), plan.urlTemplate].filter(Boolean));

                    const domainCandidates = recordingDomain ? Object.values(existingFuncs).filter(f => {
                        if (f.source !== 'smartScrape') return false;
                        return (f.urlPatterns || []).some(p => {
                            try { return p.includes(recordingDomain); } catch { return false; }
                        });
                    }) : [];

                    const rankedCandidates = domainCandidates
                        .map(funcDef => {
                            const candidateFields = getScraperFieldSet(funcDef);
                            const fieldOverlap = expectedFields.size > 0
                                ? Array.from(expectedFields).filter(f => candidateFields.has(f)).length
                                : 1;

                            const candidatePathHints = getPathHints([...(funcDef.urlPatterns || []), funcDef.startUrl].filter(Boolean));
                            const pathCompatible = planPathHints.length === 0
                                || candidatePathHints.length === 0
                                || candidatePathHints.some(h => planPathHints.includes(h));

                            const typeCompatible = !plan.outputs?.type
                                || !funcDef.outputs?.type
                                || String(plan.outputs.type).toLowerCase() === String(funcDef.outputs.type).toLowerCase();

                            const expectedCount = Math.max(expectedFields.size, 1);
                            const overlapRatio = fieldOverlap / expectedCount;
                            const score = (pathCompatible ? 100 : 0) + (typeCompatible ? 10 : 0) + Math.round(overlapRatio * 100);

                            return { funcDef, pathCompatible, typeCompatible, fieldOverlap, overlapRatio, score };
                        })
                        .filter(c => c.pathCompatible && c.typeCompatible)
                        .sort((a, b) => b.score - a.score);

                    // Require strong field compatibility when the plan defines explicit fields.
                    const existingScraper = rankedCandidates.find(c => expectedFields.size === 0 || c.overlapRatio >= 0.8)?.funcDef || null;

                    if (!existingScraper && domainCandidates.length > 0) {
                        onStatusUpdate(`Found existing domain scrapers, but none matched expected page type/fields. Generating a new scraper.`);
                    }

                    if (existingScraper) {
                        let reuseName = existingScraper.name;
                        // Prevent name collision with parent function
                        if (reuseName === plan.name || reuseName.toLowerCase() === plan.name.toLowerCase()) {
                            reuseName = reuseName + '_extractor';
                            // Rename in storage
                            const renameFuncs = await this._loadFunctionLibrary();
                            if (renameFuncs[existingScraper.name]) {
                                renameFuncs[reuseName] = { ...renameFuncs[existingScraper.name], name: reuseName };
                                delete renameFuncs[existingScraper.name];
                                await this._saveFunctionLibrary(renameFuncs);
                            }
                        }
                        onStatusUpdate(`Reusing existing scraper: ${reuseName}`);
                        const reusedFields = Array.from(getScraperFieldSet(existingScraper));
                        if (reusedFields.length > 0) {
                            plan.outputs = {
                                type: plan.outputs?.type || 'array',
                                description: plan.outputs?.description || plan.description,
                                fields: reusedFields.join(', ')
                            };
                        }
                        const reuseCountInput = (plan.inputs || []).find(i => i.type === 'number')?.name || 'count';

                        // Remove any AI-generated scroll-loop steps after smartScrape
                        while (smartScrapeStepIndex + 1 < steps.length) {
                            const nextStep = steps[smartScrapeStepIndex + 1];
                            if (nextStep.type === 'script' && nextStep.code &&
                                (nextStep.code.includes('allResults') || nextStep.code.includes('smartScrape') ||
                                 nextStep.code.includes('scraperName') || nextStep.code.includes('scroll'))) {
                                steps.splice(smartScrapeStepIndex + 1, 1);
                            } else {
                                break;
                            }
                        }

                        const reuseShouldPaginate = !!plan.needsScrollLoop
                            && String(plan.outputs?.type || '').toLowerCase() === 'array';
                        if (reuseShouldPaginate) {
                            steps[smartScrapeStepIndex] = {
                                type: 'script',
                                description: 'Extract data and paginate for more results',
                                code: [
                                    `let missingContainer = false;`,
                                    `const runScraper = async () => {`,
                                    `  try {`,
                                    `    return await page.executeFunction('${reuseName}');`,
                                    `  } catch (e) {`,
                                    `    const msg = String(e?.message || e || '');`,
                                    `    if (msg.includes('Wait timeout') || msg.includes('element not found')) {`,
                                    `      missingContainer = true;`,
                                    `      return [];`,
                                    `    }`,
                                    `    throw e;`,
                                    `  }`,
                                    `};`,
                                    `let initial = await runScraper();`,
                                    `let allResults = Array.isArray(initial) ? initial : [];`,
                                    `if (missingContainer && allResults.length === 0) return [];`,
                                    `const target = inputs.${reuseCountInput} || 10;`,
                                    `const maxScrolls = 6;`,
                                    `let noNewDataCount = 0;`,
                                    `for (let s = 0; s < maxScrolls && allResults.length < target; s++) {`,
                                    `  const prevCount = allResults.length;`,
                                    `  await page.scroll(800);`,
                                    `  await page.wait(1200);`,
                                    `  const batch = await runScraper();`,
                                    `  for (const item of (batch || [])) {`,
                                        `    const isDuplicate = allResults.some(r => JSON.stringify(r) === JSON.stringify(item));`,
                                        `    if (!isDuplicate) allResults.push(item);`,
                                    `  }`,
                                    `  if (missingContainer && allResults.length === 0) break;`,
                                    `  if (allResults.length === prevCount) noNewDataCount++;`,
                                    `  else noNewDataCount = 0;`,
                                    `  if (noNewDataCount >= 3) break;`,
                                    `}`,
                                    `return allResults.slice(0, target);`
                                ].join('\n')
                            };
                        } else {
                            steps[smartScrapeStepIndex] = {
                                type: 'script',
                                description: steps[smartScrapeStepIndex].description,
                                code: `const extractedData = await page.executeFunction('${reuseName}');\nreturn extractedData;`
                            };
                        }
                    } else {
                        // Run fresh preflight + smartScrape generation
                        onStatusUpdate(`Pre-generating scraper function...`);
                        this._throwIfAbortRequested(control, 'preflight scraping');
                        // Auto-enable proactive exploration on retry (attempt > 1) even if user didn't toggle it
                        const enableExploration = enableProactiveExploration || attempt > 1;
                        const preflightResult = await this.preflightAndScrape(plan, steps, apiKey, smartScrapeStepIndex, onStatusUpdate, { enableProactiveExploration: enableExploration });
                        steps = preflightResult.steps;

                        // Update output schema to match actual scraper fields
                        if (preflightResult.scraperFields) {
                            plan.outputs = {
                                type: plan.outputs?.type || 'array',
                                description: plan.outputs?.description || plan.description,
                                fields: preflightResult.scraperFields.join(', ')
                            };
                        }
                    }
                }

                // 5. ENSURE TYPE STEPS ARE PARAMETERIZED
                const funcInputs = plan.inputs || [];
                for (const step of steps) {
                    if (step.type === 'type' && step.value && !step.value.includes('{{')) {
                        const matchInput = funcInputs.find(i => i.type === 'string');
                        if (matchInput) {
                            step.value = `{{${matchInput.name}}}`;
                        }
                    }
                }

                // 6. BUILD FUNCTION DEFINITION
                const functionDef = this.buildFunctionDef(plan, steps);
                this._publishBuiltFunction(functionDef, control);
                onStatusUpdate(`Function "${functionDef.name}" generated. Creating tests...`);

                // 7. GENERATE TEST CASES (skip if skipTesting)
                let testCases = [];
                const stopTestsAndSave = this._isStopTestsAndSaveRequested(control);
                const skipTestsForThisRun = !!skipTesting || stopTestsAndSave;
                if (stopTestsAndSave && !skipTesting) {
                    onStatusUpdate('Stop requested: skipping remaining tests and saving generated function.');
                }

                if (!skipTestsForThisRun) {
                    try {
                        this._throwIfAbortRequested(control, 'test case generation');
                        const testResult = await AIService.generateTestCases(functionDef, apiKey);
                        testCases = testResult.testCases || [];
                    } catch (testError) {
                        console.warn('Failed to generate test cases:', testError);
                        onStatusUpdate('Could not generate tests. Using fallback smoke test.');
                    }
                    testCases = this._ensureAtLeastOneTestCase(functionDef, testCases);
                } else {
                    onStatusUpdate(skipTesting ? 'Skipping tests (sub-function mode).' : 'Skipping tests (requested by user).');
                }

                // 8. RUN TESTS & VERIFY (skip if skipTesting)
                let testsStoppedEarly = false;
                if (!skipTestsForThisRun && testCases.length > 0) {
                    onStatusUpdate(`Running ${testCases.length} verification tests...`);
                    let allTestsPassed = true;
                    let testReport = '';
                    let attemptDiagnosisContext = '';
                    let attemptDiagnosisFindings = null;

                    for (const testCase of testCases) {
                        this._throwIfAbortRequested(control, `verification test "${testCase.name}"`);
                        if (this._isStopTestsAndSaveRequested(control)) {
                            testsStoppedEarly = true;
                            onStatusUpdate('Stop requested: ending test loop and saving current function.');
                            break;
                        }
                        onStatusUpdate(`Testing: ${testCase.name}...`);
                        let testContext = null;
                        try {
                            testContext = await this._createTestExecutionContext(
                                functionDef,
                                showTestsForeground,
                                onStatusUpdate
                            );

                            const executionResult = await chrome.runtime.sendMessage({
                                type: 'executeGeneratedFunction',
                                functionDef: functionDef,
                                inputs: testCase.inputs,
                                tabId: testContext.tabId
                            });

                            if (!executionResult || !executionResult.success) {
                                allTestsPassed = false;
                                const failMsg = `Test "${testCase.name}" failed: ${executionResult?.error || 'execution error'}`;
                                testReport += failMsg + '\n';
                                if (!attemptDiagnosisContext && Number.isInteger(testContext?.tabId)) {
                                    await this._restoreDiagnosisContext({
                                        tabId: testContext.tabId,
                                        lastWorkingSnapshot: null,
                                        failingTestCase: testCase,
                                        functionDef,
                                        onStatusUpdate
                                    });
                                    const diagnosis = await this._runEnhancedDiagnosis({
                                        functionDef,
                                        taskDescription,
                                        testCase,
                                        errorMessage: executionResult?.error || failMsg,
                                        issues: [failMsg],
                                        apiKey,
                                        tabId: testContext.tabId,
                                        onStatusUpdate,
                                        control,
                                        contextLabel: `verification failure (${functionDef.name})`,
                                        priorFindings: plan._explorationFindings || null,
                                        actionBudget: 10
                                    });
                                    attemptDiagnosisContext = this._truncateForContext(diagnosis?.contextText || '', 1100);
                                    if (diagnosis?.findings) attemptDiagnosisFindings = diagnosis.findings;
                                }
                            } else {
                                // Capture screenshot and verify output quality (visual + data)
                                await this._scrollTabToTop(testContext.tabId);
                                let screenshot = null;
                                try {
                                    screenshot = await this._captureTestScreenshot(testContext.windowId, testContext.tabId);
                                } catch {}

                                const verification = await AIService.verifyWithScreenshot(
                                    functionDef,
                                    executionResult,
                                    screenshot,
                                    apiKey
                                );
                                if (!verification.valid) {
                                    allTestsPassed = false;
                                    const failMsg = `Output verification failed for "${testCase.name}": ${(verification.issues || [verification.reason || 'Unknown issue']).join('; ')}`;
                                    testReport += failMsg + '\n';
                                    if (!attemptDiagnosisContext && Number.isInteger(testContext?.tabId)) {
                                        await this._restoreDiagnosisContext({
                                            tabId: testContext.tabId,
                                            lastWorkingSnapshot: null,
                                            failingTestCase: testCase,
                                            functionDef,
                                            onStatusUpdate
                                        });
                                        const diagnosis = await this._runEnhancedDiagnosis({
                                            functionDef,
                                            taskDescription,
                                            testCase,
                                            errorMessage: verification?.reason || failMsg,
                                            issues: verification.issues || [verification.reason || failMsg],
                                            apiKey,
                                            tabId: testContext.tabId,
                                            onStatusUpdate,
                                            control,
                                            contextLabel: `verification failure (${functionDef.name})`,
                                            priorFindings: plan._explorationFindings || null,
                                            actionBudget: 10
                                        });
                                        attemptDiagnosisContext = this._truncateForContext(diagnosis?.contextText || '', 1100);
                                        if (diagnosis?.findings) attemptDiagnosisFindings = diagnosis.findings;
                                    }
                                }
                            }
                        } catch (e) {
                            allTestsPassed = false;
                            testReport += `Test "${testCase.name}" error: ${e.message}\n`;
                            if (!attemptDiagnosisContext && Number.isInteger(testContext?.tabId)) {
                                await this._restoreDiagnosisContext({
                                    tabId: testContext.tabId,
                                    lastWorkingSnapshot: null,
                                    failingTestCase: testCase,
                                    functionDef,
                                    onStatusUpdate
                                });
                                const diagnosis = await this._runEnhancedDiagnosis({
                                    functionDef,
                                    taskDescription,
                                    testCase,
                                    errorMessage: e.message,
                                    issues: [`Test execution error: ${e.message}`],
                                    apiKey,
                                    tabId: testContext.tabId,
                                    onStatusUpdate,
                                    control,
                                    contextLabel: `test error (${functionDef.name})`,
                                    priorFindings: plan._explorationFindings || null,
                                    actionBudget: 10
                                });
                                attemptDiagnosisContext = this._truncateForContext(diagnosis?.contextText || '', 1100);
                                if (diagnosis?.findings) attemptDiagnosisFindings = diagnosis.findings;
                            }
                        } finally {
                            if (testContext?.tempWindowId) {
                                try { await new Promise(r => setTimeout(r, 250)); } catch {}
                            }
                            await this._cleanupTestExecutionContext(testContext);
                        }
                    }

                    if (!testsStoppedEarly && !allTestsPassed) {
                        let retryContext = `Attempt ${attempt} verification failed:\n${this._truncateForContext(testReport, 1200)}`;
                        if (attemptDiagnosisContext) {
                            retryContext += `\nComputer-use diagnosis:\n${this._truncateForContext(attemptDiagnosisContext, 1200)}`;
                        }
                        // Save structured findings so next retry's proactive exploration has context
                        if (attemptDiagnosisFindings) {
                            plan._explorationFindings = attemptDiagnosisFindings;
                        }
                        this._appendBoundedRetryNote(attemptErrors, retryContext);
                        throw new Error('Test verification failed');
                    }
                }

                // 9. SUCCESS - Return the function
                functionDef.createdAt = Date.now();
                functionDef.testCases = testCases;
                const testsWereSkipped = skipTestsForThisRun || testsStoppedEarly;
                functionDef.testsPassed = !testsWereSkipped;
                functionDef.source = 'ai-task';
                await this._pruneFailedVersionedSiblings([functionDef.name]);

                return {
                    success: true,
                    functionDef: functionDef,
                    stoppedTestingAndSaved: !!(stopTestsAndSave || testsStoppedEarly)
                };

            } catch (error) {
                if (/Stopped by user/i.test(String(error?.message || ''))) {
                    return { success: false, error: error.message, aborted: true };
                }
                lastError = error;
                if (!/Test verification failed/i.test(String(error?.message || ''))) {
                    this._appendBoundedRetryNote(
                        attemptErrors,
                        `Attempt ${attempt}: ${this._truncateForContext(error?.message || 'Unknown error', 900)}`
                    );
                }
                if (attempt < retryCount) {
                    onStatusUpdate(`Attempt ${attempt} failed: ${error.message}. Retrying...`);
                    await new Promise(r => setTimeout(r, 1000));
                }
            }
        }

        return { success: false, error: lastError?.message || 'Unknown error', attempts: attemptErrors };
    },

    // ==================== PREFLIGHT & SCRAPE ====================

    /**
     * Navigate to the target page and run agenticScrape to create a scraper function.
     * Uses current tab context when requested; otherwise creates a temporary window and navigates.
     * takes a screenshot, runs the agentic scraper, then replaces the smartScrape step.
     */
    async preflightAndScrape(plan, steps, apiKey, smartScrapeIdx, onStatusUpdate, options = {}) {
        let preflightWindow = null;
        let tabId = null;

        try {
            const useCurrentTab =
                plan?.useCurrentTab === true
                || String(plan?.navigationStrategy || '').toLowerCase() === 'current-tab';

            if (useCurrentTab) {
                let [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
                if (!activeTab?.id || this._isInternalPageUrl(activeTab.url)) {
                    const allActiveTabs = await chrome.tabs.query({ active: true });
                    activeTab = (allActiveTabs || [])
                        .filter(tab => tab?.id && !this._isInternalPageUrl(tab.url))
                        .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0] || activeTab;
                }
                if (!activeTab?.id || this._isInternalPageUrl(activeTab.url)) {
                    throw new Error('Current-tab preflight requires an active regular webpage tab (http/https).');
                }
                tabId = activeTab.id;
                onStatusUpdate(`Preflight: Using current tab context: ${activeTab.url}`);
            } else {
                // Create a temporary window for isolated preflight navigation
                preflightWindow = await chrome.windows.create({
                    url: 'about:blank',
                    type: 'normal',
                    state: 'normal'
                });
                tabId = preflightWindow.tabs[0].id;
                await new Promise(r => setTimeout(r, 500));
            }

            // Execute navigation steps (everything before the smartScrape)
            const navSteps = steps.slice(0, smartScrapeIdx);
            const defaultInputs = this.getDefaultInputs(plan.inputs);

            if (navSteps.length > 0) {
                const tempFunc = {
                    name: '__preflight_nav__',
                    steps: navSteps,
                    inputs: plan.inputs,
                    urlPatterns: plan.urlPatterns || []
                };

                onStatusUpdate('Preflight: Navigating to target page...');

                const navResult = await chrome.runtime.sendMessage({
                    type: 'executeGeneratedFunction',
                    functionDef: tempFunc,
                    inputs: defaultInputs,
                    tabId: tabId
                });

                if (!navResult || !navResult.success) {
                    // Capture screenshot for error analysis before failing
                    let errorContext = navResult?.error || 'unknown error';
                    try {
                        const errorTab = await chrome.tabs.get(tabId);
                        const errorScreenshot = await new Promise(resolve => {
                            chrome.tabs.captureVisibleTab(errorTab.windowId, { format: 'png' }, (dataUrl) => {
                                resolve(chrome.runtime.lastError ? null : dataUrl);
                            });
                        });
                        if (errorScreenshot && apiKey) {
                            onStatusUpdate('Analyzing navigation failure...');
                            const analysisResult = await this.analyzeErrorScreenshot(
                                errorScreenshot, errorTab.url, errorContext, apiKey
                            );
                            if (analysisResult) {
                                errorContext += ` | Page analysis: ${analysisResult}`;
                            }
                        }
                    } catch (e) {
                        // Error analysis is best-effort
                        console.warn('Error analysis failed:', e);
                    }
                    await this._restoreDiagnosisContext({
                        tabId,
                        lastWorkingSnapshot: null,
                        failingTestCase: { name: 'Preflight navigation', inputs: defaultInputs },
                        functionDef: tempFunc,
                        onStatusUpdate
                    });
                    const diagnosis = await this._runEnhancedDiagnosis({
                        functionDef: tempFunc,
                        taskDescription: plan?.description || '',
                        testCase: { name: 'Preflight navigation', inputs: defaultInputs },
                        errorMessage: errorContext,
                        issues: ['Preflight navigation failed before scraper generation'],
                        apiKey,
                        tabId,
                        onStatusUpdate,
                        contextLabel: `${plan?.name || 'function'} preflight`,
                        priorFindings: plan._explorationFindings || null,
                        actionBudget: 10
                    });
                    if (diagnosis?.contextText) {
                        errorContext += ` | Computer-use diagnosis: ${this._truncateForContext(diagnosis.contextText, 700)}`;
                    }
                    if (diagnosis?.findings) {
                        plan._explorationFindings = diagnosis.findings;
                    }
                    throw new Error(`Preflight navigation failed: ${errorContext}`);
                }
            }

            // Wait for page to settle
            await new Promise(r => setTimeout(r, 2000));

            // URL LEARNING: After navigation (especially computer-use), capture the actual URL
            // and check if input values appear in it. If so, construct a URL template.
            try {
                const tab = await chrome.tabs.get(tabId);
                const actualUrl = tab.url;
                onStatusUpdate(`Preflight: Arrived at ${actualUrl}`);

                // Check if we used computer-use navigation
                const usedComputerUse = navSteps.some(s => s.type === 'computerUseNavigate');
                if (usedComputerUse && actualUrl && !actualUrl.startsWith('about:')) {
                    // Try to detect input parameter values in the URL
                    let learnedUrlTemplate = actualUrl;
                    let foundParameterizedInputs = false;

                    for (const input of (plan.inputs || [])) {
                        const defaultVal = String(defaultInputs[input.name] || '');
                        if (defaultVal && defaultVal.length > 1) {
                            // Check URL for the default value (encoded and raw)
                            const encodedVal = encodeURIComponent(defaultVal);
                            if (actualUrl.includes(encodedVal)) {
                                learnedUrlTemplate = learnedUrlTemplate.replace(encodedVal, `{{${input.name}}}`);
                                foundParameterizedInputs = true;
                            } else if (actualUrl.includes(defaultVal)) {
                                learnedUrlTemplate = learnedUrlTemplate.replace(defaultVal, `{{${input.name}}}`);
                                foundParameterizedInputs = true;
                            } else if (actualUrl.includes(defaultVal.replace(/\s+/g, '+'))) {
                                learnedUrlTemplate = learnedUrlTemplate.replace(defaultVal.replace(/\s+/g, '+'), `{{${input.name}}}`);
                                foundParameterizedInputs = true;
                            }
                        }
                    }

                    // ALWAYS replace computer-use with direct navigate if we reached a valid URL
                    // This avoids expensive AI calls on every execution, even for static URLs
                    if (foundParameterizedInputs) {
                        onStatusUpdate(`URL pattern learned with parameters: ${learnedUrlTemplate}`);
                    } else {
                        onStatusUpdate(`Static URL learned (no parameters): ${learnedUrlTemplate}`);
                    }

                    // Replace the computer-use navigate step(s) with a direct navigate step
                    const newNavSteps = [{
                        type: 'navigate',
                        url: learnedUrlTemplate,
                        description: 'Navigate to target page (URL learned from computer-use preflight)'
                    }];

                    // Keep any wait steps that were after navigate
                    const waitSteps = navSteps.filter(s => s.type === 'wait');
                    if (waitSteps.length > 0) {
                        newNavSteps.push(waitSteps[0]); // Keep the first wait step
                    }

                    // Replace steps before smartScrape with the learned URL navigation
                    steps.splice(0, smartScrapeIdx, ...newNavSteps);
                    // Update smartScrapeIdx to point to new position
                    smartScrapeIdx = newNavSteps.length;

                    // Update plan metadata
                    plan.navigationStrategy = 'url';
                    plan.urlTemplate = learnedUrlTemplate;
                }
            } catch (e) {
                // URL learning is best-effort, don't fail on errors
                console.warn('URL learning failed:', e);
            }

            // Pre-scroll to trigger lazy-loading with a small budget.
            // Keep this lightweight to avoid unnecessary startup delays.
            try {
                const outputType = String(plan?.outputs?.type || '').toLowerCase();
                const maxScrolls = outputType === 'array' ? 3 : 1;
                const scrollStep = outputType === 'array' ? 650 : 450;
                const perScrollWaitMs = outputType === 'array' ? 500 : 350;
                onStatusUpdate('Preflight: Scrolling page to load dynamic content...');
                await chrome.scripting.executeScript({
                    target: { tabId },
                    func: async (scrollCfg) => {
                        const scrollStep = scrollCfg.scrollStep;
                        const maxScrolls = scrollCfg.maxScrolls;
                        const perScrollWaitMs = scrollCfg.perScrollWaitMs;
                        for (let i = 0; i < maxScrolls; i++) {
                            window.scrollBy(0, scrollStep);
                            await new Promise(r => setTimeout(r, perScrollWaitMs));
                        }
                        // Scroll back to top for the screenshot
                        window.scrollTo(0, 0);
                        await new Promise(r => setTimeout(r, 250));
                    },
                    args: [{ scrollStep, maxScrolls, perScrollWaitMs }]
                });
                console.log('[Preflight] Pre-scroll completed to load lazy content');
            } catch (e) {
                console.warn('[Preflight] Pre-scroll failed (non-fatal):', e.message);
            }

            // PROACTIVE EXPLORATION: Let AI visually explore the page before scraping
            // Gated by enableProactiveExploration flag. Happens after pre-scroll, before expansion/screenshot.
            if (options.enableProactiveExploration) {
                try {
                    const exploration = await this._runProactiveExploration({
                        plan, tabId, apiKey, onStatusUpdate, control: null, actionBudget: 12
                    });
                    if (exploration?.findings) {
                        plan._explorationFindings = exploration.findings;
                        console.log('[Preflight] Proactive exploration completed:', exploration.findings.pageType);
                    }
                    // Reset page state after exploration (AI may have clicked/scrolled)
                    await chrome.scripting.executeScript({
                        target: { tabId },
                        func: () => { window.scrollTo(0, 0); }
                    });
                    await new Promise(r => setTimeout(r, 500));
                } catch (e) {
                    console.warn('[Preflight] Proactive exploration failed (non-fatal):', e.message);
                }
            }

            // Expand collapsed content — click "show more", "see more", "expand" buttons etc.
            // This is general-purpose: works on any site, not specific to YouTube.
            // Must happen AFTER scrolling (to trigger lazy-loaded sections) and BEFORE screenshot.
            try {
                const outputType = String(plan?.outputs?.type || '').toLowerCase();
                const shouldExpand = outputType === 'object';
                if (!shouldExpand) {
                    onStatusUpdate('Preflight: Skipping aggressive expand pass for list output.');
                }
                const expandResult = await chrome.scripting.executeScript({
                    target: { tabId },
                    func: async (cfg) => {
                        if (!cfg.shouldExpand) return 0;
                        let clickedCount = 0;
                        const maxClicks = cfg.maxClicks;
                        const selectors = [
                            '[data-action="a-expander-toggle"]',
                            '.a-expander-prompt',
                            '[aria-expanded="false"]',
                            'details:not([open]) > summary'
                        ];

                        for (const selector of selectors) {
                            if (clickedCount >= maxClicks) break;
                            const nodes = document.querySelectorAll(selector);
                            for (const node of nodes) {
                                if (clickedCount >= maxClicks) break;
                                const isVisible = node.offsetParent !== null || node.getClientRects().length > 0;
                                if (!isVisible) continue;
                                const isNavMenu = node.closest('nav, header, [role="navigation"]');
                                if (isNavMenu) continue;
                                try {
                                    node.click();
                                    clickedCount++;
                                    await new Promise(r => setTimeout(r, 120));
                                } catch {}
                            }
                        }

                        // Wait for expanded content to load
                        if (clickedCount > 0) {
                            await new Promise(r => setTimeout(r, 450));
                        }

                        // Scroll back to top for screenshot
                        window.scrollTo(0, 0);
                        await new Promise(r => setTimeout(r, 200));

                        return clickedCount;
                    },
                    args: [{ shouldExpand, maxClicks: 8 }]
                });
                const clicked = expandResult?.[0]?.result || 0;
                if (clicked > 0) {
                    console.log(`[Preflight] Expanded ${clicked} collapsed content sections`);
                    onStatusUpdate(`Preflight: Expanded ${clicked} collapsed sections`);
                }
            } catch (e) {
                console.warn('[Preflight] Content expansion failed (non-fatal):', e.message);
            }

            // Take screenshot and run agenticScrape
            onStatusUpdate('Preflight: Capturing page for AI analysis...');
            const tabData = await chrome.runtime.sendMessage({
                type: 'startSmartScrape',
                tabId: tabId
            });

            if (!tabData?.screenshot) {
                throw new Error(`Failed to capture screenshot: ${tabData?.error || 'unknown'}`);
            }

            // Build extraction hints from plan's output spec
            let extractionHints = plan.outputs?.fields
                ? `${plan.outputs.fields}${plan.outputs.type === 'object' ? ' (single item, not a list)' : ' (list of items)'}`
                : null;

            // Enrich extraction hints with proactive exploration findings
            if (plan._explorationFindings) {
                const findingsStr = this._findingsToContextString(plan._explorationFindings, 800);
                if (findingsStr) {
                    extractionHints = extractionHints
                        ? `${extractionHints}\n\nPAGE INVESTIGATION:\n${findingsStr}`
                        : `PAGE INVESTIGATION:\n${findingsStr}`;
                }
            }

            if (extractionHints) {
                console.log(`[Preflight] Passing extraction hints to scraper: ${extractionHints.substring(0, 200)}...`);
            }

            onStatusUpdate('Preflight: AI is creating extraction function...');
            const scrapeResult = await AIService.agenticScrape(
                tabData.screenshot,
                tabData.url,
                apiKey,
                tabData.tabId,
                (status) => onStatusUpdate(`Scraper: ${status}`),
                extractionHints
            );

            if (!scrapeResult.savedFunction) {
                const lastResult = scrapeResult.lastExtractionResult
                    ? JSON.stringify(scrapeResult.lastExtractionResult).substring(0, 300)
                    : 'none';
                console.error(`[Preflight] Scraper failed. Turns used: ${scrapeResult.totalTurns}. Last extraction: ${lastResult}`);
                onStatusUpdate(`Scraper failed after ${scrapeResult.totalTurns} turns. Last extraction preview: ${lastResult}`);
                throw new Error(`Failed to generate scraper function from agentic loop (${scrapeResult.totalTurns} turns, last extraction: ${lastResult})`);
            }

            onStatusUpdate(`Scraper created: ${scrapeResult.savedFunction.name}`);
            let scraperFuncName = scrapeResult.savedFunction.name;

            // CRITICAL: Prevent name collision between scraper and parent function.
            // If the agentic scraper chose the same name as the parent function,
            // calling page.executeFunction(name) would create infinite recursion.
            if (scraperFuncName === plan.name || scraperFuncName.toLowerCase() === plan.name.toLowerCase()) {
                const newScraperName = scraperFuncName + '_extractor';
                console.log(`[aiTaskService] Renaming scraper "${scraperFuncName}" -> "${newScraperName}" to avoid collision with parent function "${plan.name}"`);

                // Rename in storage
                const savedFunctions = await this._loadFunctionLibrary();
                if (savedFunctions[scraperFuncName]) {
                    savedFunctions[newScraperName] = { ...savedFunctions[scraperFuncName], name: newScraperName };
                    delete savedFunctions[scraperFuncName];
                    await this._saveFunctionLibrary(savedFunctions);
                }

                scraperFuncName = newScraperName;
                onStatusUpdate(`Scraper renamed to: ${scraperFuncName} (avoid collision with parent)`);
            }

            const countInputName = (plan.inputs || []).find(i => i.type === 'number')?.name || 'count';

            // Remove any AI-generated scroll-loop steps after smartScrape
            // (they reference undefined variables like 'results' and 'scraperName')
            while (smartScrapeIdx + 1 < steps.length) {
                const nextStep = steps[smartScrapeIdx + 1];
                if (nextStep.type === 'script' && nextStep.code &&
                    (nextStep.code.includes('allResults') || nextStep.code.includes('smartScrape') ||
                     nextStep.code.includes('scraperName') || nextStep.code.includes('scroll'))) {
                    steps.splice(smartScrapeIdx + 1, 1);
                    console.log(`[aiTaskService] Removed AI-generated scroll-loop step`);
                } else {
                    break;
                }
            }

            // Replace the smartScrape step with a single script that handles
            // both initial extraction AND pagination (if needed).
            // This must be a SINGLE step because sandbox steps run in isolation.
            // Common content expansion code — click "show more" / "expand" / "see more" buttons
            // before extraction. General-purpose: works on any site.
            const outputType = String(plan.outputs?.type || '').toLowerCase();
            const outputFieldsText = String(plan.outputs?.fields || '').toLowerCase();
            const shouldPaginate = !!plan.needsScrollLoop && outputType === 'array';
            const shouldExpandDetailSections =
                outputType === 'object'
                || /(feature|bullet|about|description|qa|question|answer|rating)/.test(outputFieldsText);

            const expandCode = shouldExpandDetailSections
                ? [
                    `// Expand likely collapsed sections on detail pages`,
                    `const expandSelectors = [`,
                    `  '[data-action="a-expander-toggle"]',`,
                    `  '.a-expander-prompt',`,
                    `  '[aria-expanded="false"]',`,
                    `  'details:not([open]) > summary'`,
                    `];`,
                    `for (const sel of expandSelectors) {`,
                    `  try {`,
                    `    const matches = await page.getElements(sel);`,
                    `    if (!Array.isArray(matches) || matches.length === 0) continue;`,
                    `    await page.click(sel);`,
                    `    await page.wait(120);`,
                    `  } catch {}`,
                    `}`,
                    `await page.wait(250);`,
                ].join('\n')
                : `// No detail-page expansion needed before extraction`;
            if (shouldPaginate) {
                steps[smartScrapeIdx] = {
                    type: 'script',
                    description: 'Extract data and paginate for more results',
                    code: [
                        `let missingContainer = false;`,
                        `const runScraper = async () => {`,
                        `  try {`,
                        `    return await page.executeFunction('${scraperFuncName}');`,
                        `  } catch (e) {`,
                        `    const msg = String(e?.message || e || '');`,
                        `    if (msg.includes('Wait timeout') || msg.includes('element not found')) {`,
                        `      missingContainer = true;`,
                        `      return [];`,
                        `    }`,
                        `    throw e;`,
                        `  }`,
                        `};`,
                        `let rawResult = await runScraper();`,
                        `let allResults = Array.isArray(rawResult) ? rawResult : [];`,
                        `if (missingContainer && allResults.length === 0) return [];`,
                        `const target = inputs.${countInputName} || 10;`,
                        `const maxScrolls = 4;`,
                        `let noNewDataCount = 0;`,
                        `for (let s = 0; s < maxScrolls && allResults.length < target; s++) {`,
                        `  const prevCount = allResults.length;`,
                        `  await page.scroll(800);`,
                        `  await page.wait(700);`,
                        `  const batchRaw = await runScraper();`,
                        `  const batch = Array.isArray(batchRaw) ? batchRaw : [];`,
                        `  for (const item of batch) {`,
                        `    const isDuplicate = allResults.some(r => JSON.stringify(r) === JSON.stringify(item));`,
                        `    if (!isDuplicate) allResults.push(item);`,
                        `  }`,
                        `  if (missingContainer && allResults.length === 0) break;`,
                        `  if (allResults.length === prevCount) noNewDataCount++;`,
                        `  else noNewDataCount = 0;`,
                        `  if (noNewDataCount >= 2) break;`,
                        `}`,
                        `// Return viewport to top so verification sees primary content`,
                        `for (let i = 0; i < 4; i++) {`,
                        `  await page.scroll(-1400);`,
                        `  await page.wait(80);`,
                        `}`,
                        `return allResults.slice(0, target);`
                    ].join('\n')
                };
                console.log(`[aiTaskService] Generated combined extract+scroll step for '${scraperFuncName}'`);
            } else {
                // Detail page: expand content, scroll to load lazy sections, then extract
                steps[smartScrapeIdx] = {
                    type: 'script',
                    description: 'Expand content and extract data using saved scraper',
                    code: [
                        expandCode,
                        `const hasMeaningfulData = (value) => {`,
                        `  if (value === null || value === undefined) return false;`,
                        `  if (typeof value === 'string') return value.trim().length > 0;`,
                        `  if (Array.isArray(value)) return value.length > 0;`,
                        `  if (typeof value === 'object') return Object.values(value).some(v => hasMeaningfulData(v));`,
                        `  return true;`,
                        `};`,
                        `let extractedData = await page.executeFunction('${scraperFuncName}');`,
                        `if (!hasMeaningfulData(extractedData)) {`,
                        `  await page.scroll(900);`,
                        `  await page.wait(350);`,
                        `  extractedData = await page.executeFunction('${scraperFuncName}');`,
                        `}`,
                        `return extractedData;`
                    ].join('\n')
                };
                console.log(`[aiTaskService] Generated expand+extract step for '${scraperFuncName}'`);
            }

            // Get the scraper's field names for output schema
            const scraperFields = scrapeResult.savedFunction.fields
                ? scrapeResult.savedFunction.fields.map(f => f.name)
                : null;

            return { steps, scraperName: scraperFuncName, scraperFields };

        } finally {
            // Cleanup preflight window
            if (preflightWindow) {
                try {
                    await chrome.windows.remove(preflightWindow.id);
                } catch { /* ignore */ }
            }
        }
    },

    // ==================== HELPERS ====================

    /**
     * Build a function definition from the plan and generated steps.
     */
    buildFunctionDef(plan, steps) {
        const normalizedNav = String(plan?.navigationStrategy || '').toLowerCase();
        const requiresCurrentTab = plan?.useCurrentTab === true || normalizedNav === 'current-tab';
        let urlPatterns = Array.isArray(plan.urlPatterns) ? plan.urlPatterns.filter(Boolean) : [];
        if (urlPatterns.length === 0) {
            const candidateUrl = plan.urlTemplate || steps.find(s => s.type === 'navigate' && typeof s.url === 'string')?.url;
            if (candidateUrl && !candidateUrl.includes('{{')) {
                try {
                    const parsed = new URL(candidateUrl);
                    urlPatterns = Array.from(new Set([
                        `${parsed.origin}${parsed.pathname}*`,
                        `${parsed.origin}/*`
                    ]));
                } catch {
                    // Ignore malformed URL templates.
                }
            }
        }

        return {
            name: plan.name,
            description: plan.description,
            inputs: plan.inputs || [],
            outputs: plan.outputs || {},
            urlPatterns,
            startUrl: plan.urlTemplate || null,
            steps: steps,
            navigationStrategy: plan.navigationStrategy,
            extractionStrategy: plan.extractionStrategy,
            requiresCurrentTab
        };
    },

    /**
     * Keep sub-function fixes aligned with the original navigation strategy and bounded waits.
     * - If original steps used computerUseNavigate, reject fixes that remove it.
     * - Clamp long static waits in script code.
     */
    _optimizeSubFunctionFixedSteps(originalFuncDef, fixedSteps = []) {
        if (!Array.isArray(fixedSteps) || fixedSteps.length === 0) {
            return { accepted: false, reason: 'fixed steps are empty', steps: [] };
        }

        const originalSteps = Array.isArray(originalFuncDef?.steps) ? originalFuncDef.steps : [];
        const originalUsedComputerUse = originalSteps.some(step => step?.type === 'computerUseNavigate');
        const fixedUsesComputerUse = fixedSteps.some(step => step?.type === 'computerUseNavigate');
        const originalUsesSavedScraper = originalSteps.some(step =>
            step?.type === 'script' && /page\.executeFunction\s*\(/.test(String(step?.code || ''))
        );
        const fixedUsesSavedScraper = fixedSteps.some(step =>
            step?.type === 'script' && /page\.executeFunction\s*\(/.test(String(step?.code || ''))
        );

        if (originalUsedComputerUse && !fixedUsesComputerUse) {
            return {
                accepted: false,
                reason: 'fix removed computer-use navigation; keep computerUseNavigate for this function',
                steps: fixedSteps
            };
        }
        if (originalUsesSavedScraper && !fixedUsesSavedScraper) {
            return {
                accepted: false,
                reason: 'fix removed saved-scraper executeFunction call; keep existing extraction tool-call strategy',
                steps: fixedSteps
            };
        }

        const outputType = String(originalFuncDef?.outputs?.type || '').toLowerCase();
        const isListLike = outputType === 'array' || outputType === 'arrayofobjects';
        if (isListLike) {
            const hasDetailExpansionSelectors = fixedSteps.some(step => {
                if (step?.type !== 'script' || typeof step.code !== 'string') return false;
                return /a-expander-toggle|askATF_feature_div|feature-bullets|productDescription_feature_div|details:not\(\[open\]\)/i.test(step.code);
            });
            if (hasDetailExpansionSelectors) {
                return {
                    accepted: false,
                    reason: 'list/search function fix injected detail-page expansion selectors',
                    steps: fixedSteps
                };
            }
        }

        const optimized = fixedSteps.map(step => {
            if (!step || step.type !== 'script' || typeof step.code !== 'string') return step;
            const code = step.code.replace(
                /await\s+page\.wait\(\s*(\d+)\s*\)/g,
                (full, msRaw) => {
                    const ms = Number(msRaw);
                    if (!Number.isFinite(ms)) return full;
                    return `await page.wait(${Math.min(ms, 1500)})`;
                }
            );
            return { ...step, code };
        });

        return { accepted: true, reason: '', steps: optimized };
    },

    /**
     * Keep workflow-fix scripts fast and bounded.
     * - Rejects orchestration fixes that inject page.smartScrape() (too slow/unreliable in loop).
     * - Clamps long static waits in script code.
     */
    _optimizeWorkflowFixedSteps(steps = []) {
        if (!Array.isArray(steps) || steps.length === 0) {
            return { accepted: false, reason: 'fixed steps are empty', steps: [] };
        }

        const hasSmartScrape = steps.some(step =>
            step?.type === 'script' && /page\.smartScrape\s*\(/.test(String(step?.code || ''))
        );
        if (hasSmartScrape) {
            return {
                accepted: false,
                reason: 'workflow fixes cannot call page.smartScrape inside orchestration loops',
                steps
            };
        }

        const hasManualNavigation = steps.some(step =>
            step?.type === 'script' && /page\.navigate\s*\(/.test(String(step?.code || ''))
        );
        if (hasManualNavigation) {
            return {
                accepted: false,
                reason: 'workflow fixes should not add manual page.navigate calls in orchestration',
                steps
            };
        }

        const excessiveScrolls = steps.some(step => {
            if (step?.type !== 'script') return false;
            const code = String(step?.code || '');
            const matches = code.match(/page\.scroll\s*\(/g);
            return (matches?.length || 0) > 4;
        });
        if (excessiveScrolls) {
            return {
                accepted: false,
                reason: 'workflow fixes added excessive scrolling in orchestration',
                steps
            };
        }

        const optimized = steps.map(step => {
            if (!step || step.type !== 'script' || typeof step.code !== 'string') return step;

            // Clamp explicit numeric waits to keep workflow test runtime bounded.
            const code = step.code.replace(
                /await\s+page\.wait\(\s*(\d+)\s*\)/g,
                (full, msRaw) => {
                    const ms = Number(msRaw);
                    if (!Number.isFinite(ms)) return full;
                    const clamped = Math.min(ms, 1200);
                    return `await page.wait(${clamped})`;
                }
            );
            return { ...step, code };
        });

        return { accepted: true, reason: '', steps: optimized };
    },

    /**
     * Remove failed versioned siblings (BaseV2, BaseV3...) while keeping current run's winners.
     * This keeps the library from accumulating failed retries.
     */
    async _pruneFailedVersionedSiblings(keepNames = []) {
        const keepSet = new Set((keepNames || []).filter(Boolean));
        if (keepSet.size === 0) return 0;

        const baseNames = Array.from(new Set(
            Array.from(keepSet).map(name => String(name).replace(/V\d+$/i, ''))
        ));
        const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        const all = await this._loadFunctionLibrary();
        let removed = 0;
        for (const [name, def] of Object.entries(all)) {
            if (keepSet.has(name)) continue;
            const source = String(def?.source || '');
            const isGenerated = source === 'smartScrape' || source === 'ai-task' || source === 'ai-workflow';
            const isFailed = def?.testsPassed === false || (isGenerated && def?.testsPassed !== true);
            if (!isFailed) continue;

            const matchesBase = baseNames.some(base => new RegExp(`^${escapeRegex(base)}V\\d+$`, 'i').test(name));
            if (!matchesBase) continue;

            delete all[name];
            removed++;
        }

        if (removed > 0) {
            await this._saveFunctionLibrary(all);
        }
        return removed;
    },

    /**
     * Generate default input values for preflight execution.
     */
    /**
     * Analyze a screenshot after a navigation error to understand what went wrong.
     * Returns a short diagnostic string to include in the retry error context.
     */
    async analyzeErrorScreenshot(screenshotDataUrl, currentUrl, errorMessage, apiKey) {
        try {
            const base64Data = screenshotDataUrl.replace(/^data:image\/\w+;base64,/, '');
            const result = await AIService.callGemini({
                contents: [{
                    role: 'user',
                    parts: [
                        {
                            text: `You are debugging a browser automation failure. The automation was navigating a webpage and encountered this error: "${errorMessage}".

Current URL: ${currentUrl}

Look at the screenshot and describe in 1-2 sentences:
1. What page/state the browser is currently showing
2. Why the automation likely failed (e.g., page didn't load, wrong page, popup blocking, login required, search didn't execute)
3. A concrete suggestion for what to do differently

Reply with ONLY a brief diagnostic (no markdown, no extra formatting).`
                        },
                        {
                            inline_data: {
                                mime_type: 'image/png',
                                data: base64Data
                            }
                        }
                    ]
                }],
                generationConfig: { temperature: 0.1, maxOutputTokens: 200 }
            }, apiKey, false);

            return result?.candidates?.[0]?.content?.parts?.[0]?.text || null;
        } catch (e) {
            console.warn('Error screenshot analysis failed:', e);
            return null;
        }
    },

    getDefaultInputs(inputDefs) {
        const defaults = {};
        for (const input of (inputDefs || [])) {
            if (input.defaultValue) {
                defaults[input.name] = input.type === 'number'
                    ? parseInt(input.defaultValue)
                    : input.defaultValue;
            } else if (input.type === 'number') {
                defaults[input.name] = 5;
            } else if (input.type === 'string') {
                defaults[input.name] = 'test';
            } else {
                defaults[input.name] = true;
            }
        }
        return defaults;
    },

    /**
     * Run a generated sub-function to get sample data.
     * Used after generating a list function to obtain real URLs for the next detail function.
     * Returns the sample data array, or null on failure.
     */
    async _runSubFunctionForSampleData(functionDef, onStatusUpdate, sourceDomain = null) {
        let sampleWindow = null;
        try {
            onStatusUpdate(`Running ${functionDef.name} to get sample data for next function...`);

            sampleWindow = await chrome.windows.create({
                url: 'about:blank',
                type: 'normal',
                state: 'minimized'
            });
            const sampleTabId = sampleWindow.tabs[0].id;
            await new Promise(r => setTimeout(r, 500));

            const defaultInputs = this.getDefaultInputs(functionDef.inputs);
            console.log(`[Workflow] Running sample: ${functionDef.name} with inputs:`, defaultInputs);

            const sampleResult = await chrome.runtime.sendMessage({
                type: 'executeGeneratedFunction',
                functionDef: functionDef,
                inputs: defaultInputs,
                tabId: sampleTabId
            });

            if (sampleResult?.success && sampleResult.data) {
                const data = Array.isArray(sampleResult.data) ? sampleResult.data : [sampleResult.data];

                // Log available fields for debugging
                if (data.length > 0 && typeof data[0] === 'object') {
                    const fields = Object.keys(data[0]);
                    console.log(`[Workflow] Sample data fields: ${fields.join(', ')}`);
                    onStatusUpdate(`Sample data fields: ${fields.join(', ')}`);
                }

                // Try structured data first (with sourceDomain for relative URLs)
                let sampleUrl = this._findUrlInSampleData(data, sourceDomain);

                // Fallback: extract links directly from the page DOM (before closing the window!)
                if (!sampleUrl) {
                    console.log('[Workflow] No URL in structured data, trying page link extraction...');
                    onStatusUpdate('No URL in structured data, extracting links from page...');
                    sampleUrl = await this._extractFirstContentLink(sampleTabId);
                    if (sampleUrl) {
                        // Inject the extracted URL into the data so _findUrlInSampleData finds it next time
                        data[0]._extractedUrl = sampleUrl;
                        console.log(`[Workflow] Extracted URL from page DOM: ${sampleUrl}`);
                    }
                }

                if (sampleUrl) {
                    onStatusUpdate(`Sample data obtained. Found URL: ${sampleUrl}`);
                    console.log(`[Workflow] Sample data from ${functionDef.name}: ${data.length} items, sample URL: ${sampleUrl}`);
                } else {
                    onStatusUpdate(`Sample data obtained (${data.length} items) but no URLs found in data or page.`);
                    console.log(`[Workflow] Sample data from ${functionDef.name}: ${data.length} items, NO URLs found anywhere.`);
                    if (data.length > 0 && typeof data[0] === 'object') {
                        console.log('[Workflow] First item:', JSON.stringify(data[0]).substring(0, 500));
                    }
                }
                return data;
            } else {
                console.warn(`[Workflow] Sample run of ${functionDef.name} failed:`, sampleResult?.error);
                onStatusUpdate(`Sample run failed: ${sampleResult?.error || 'unknown'}. Continuing anyway.`);
                return null;
            }
        } catch (e) {
            console.warn(`[Workflow] Sample run error for ${functionDef.name}:`, e);
            onStatusUpdate(`Could not get sample data: ${e.message}. Continuing.`);
            return null;
        } finally {
            if (sampleWindow) {
                try { await chrome.windows.remove(sampleWindow.id); } catch { /* ignore */ }
            }
        }
    },

    /**
     * Find a URL in sample data from a list function's output.
     * Searches for any http/https URL in the first few items.
     * Prioritizes fields named "url", "link", "href", or containing "Url".
     * Falls back to relative URL detection using sourceDomain.
     */
    _findUrlInSampleData(data, sourceDomain = null) {
        if (!Array.isArray(data) || data.length === 0) return null;

        // Priority field names for URL detection
        const urlFieldPriority = ['url', 'link', 'href', 'pageUrl', 'videoUrl', 'productUrl', 'itemUrl', '_extractedUrl'];
        const skipKeyPatterns = ['image', 'thumbnail', 'avatar', 'icon', 'logo', 'poster'];
        const directProductPath = /(\/dp\/|\/gp\/product\/)/i;

        const normalizeCandidate = (rawUrl) => {
            if (typeof rawUrl !== 'string' || !rawUrl.startsWith('http')) return null;
            try {
                let parsed = new URL(rawUrl);
                const isAmazon = /(^|\.)amazon\./i.test(parsed.hostname);

                if (isAmazon) {
                    // Convert ad/tracking redirects to canonical product URLs when possible.
                    if (parsed.pathname.includes('/sspa/click') || parsed.pathname.includes('/gp/slredirect')) {
                        const embedded = parsed.searchParams.get('url');
                        if (embedded) {
                            const decoded = decodeURIComponent(embedded);
                            const absolute = decoded.startsWith('http')
                                ? decoded
                                : `${parsed.origin}${decoded.startsWith('/') ? decoded : `/${decoded}`}`;
                            parsed = new URL(absolute);
                        } else {
                            return null;
                        }
                    }

                    const dpMatch = parsed.pathname.match(/\/dp\/([A-Z0-9]{10})/i)
                        || parsed.pathname.match(/\/gp\/product\/([A-Z0-9]{10})/i);
                    if (dpMatch?.[1]) {
                        return `${parsed.origin}/dp/${dpMatch[1].toUpperCase()}`;
                    }
                }

                parsed.hash = '';
                return parsed.toString();
            } catch {
                return null;
            }
        };

        const pickBestCandidate = (candidates) => {
            if (!Array.isArray(candidates) || candidates.length === 0) return null;
            const direct = candidates.find(url => directProductPath.test(url));
            return direct || candidates[0];
        };

        const candidates = [];

        for (const item of data.slice(0, 5)) {
            if (!item || typeof item !== 'object') continue;

            // First pass: check priority field names for absolute URLs
            for (const fieldName of urlFieldPriority) {
                const val = item[fieldName];
                const normalized = normalizeCandidate(val);
                if (normalized) {
                    candidates.push(normalized);
                }
            }

            // Second pass: check any field containing "url" (case-insensitive)
            for (const [key, val] of Object.entries(item)) {
                if (key.toLowerCase().includes('url')) {
                    if (!skipKeyPatterns.some(p => key.toLowerCase().includes(p))) {
                        const normalized = normalizeCandidate(val);
                        if (normalized) candidates.push(normalized);
                    }
                }
            }

            // Third pass: any field with an absolute http value (skip images)
            for (const [key, val] of Object.entries(item)) {
                if (!skipKeyPatterns.some(p => key.toLowerCase().includes(p))) {
                    const normalized = normalizeCandidate(val);
                    if (normalized) candidates.push(normalized);
                }
            }
        }

        const bestAbsolute = pickBestCandidate(Array.from(new Set(candidates)));
        if (bestAbsolute) return bestAbsolute;

        // Fourth pass: relative URLs — construct absolute URLs using sourceDomain
        if (sourceDomain) {
            const skipPathPatterns = [/^\/@/, /^\/channel\//, /^\/user\//, /^\/c\//];
            const relativeCandidates = [];
            for (const item of data.slice(0, 5)) {
                if (!item || typeof item !== 'object') continue;

                // Check priority fields for relative URLs
                for (const fieldName of urlFieldPriority) {
                    const val = item[fieldName];
                    if (typeof val === 'string' && val.startsWith('/') &&
                        !skipPathPatterns.some(p => p.test(val))) {
                        relativeCandidates.push(`https://${sourceDomain}${val}`);
                    }
                }

                // Check any field with a relative content path (must have query params or meaningful path)
                for (const [key, val] of Object.entries(item)) {
                    if (typeof val === 'string' && val.startsWith('/') &&
                        !skipPathPatterns.some(p => p.test(val)) &&
                        !skipKeyPatterns.some(p => key.toLowerCase().includes(p)) &&
                        (val.includes('?') || val.split('/').filter(Boolean).length >= 1)) {
                        relativeCandidates.push(`https://${sourceDomain}${val}`);
                    }
                }
            }
            const bestRelative = pickBestCandidate(Array.from(new Set(relativeCandidates)));
            if (bestRelative) return bestRelative;
        }

        return null;
    },

    /**
     * Extract the first content link from a page by querying the DOM.
     * Used as a fallback when structured scraper data doesn't contain URLs.
     * Filters out profile, channel, image, and navigation links.
     */
    async _extractFirstContentLink(tabId) {
        try {
            const results = await chrome.scripting.executeScript({
                target: { tabId },
                func: () => {
                    const anchors = document.querySelectorAll('a[href]');
                    const links = [];
                    for (const a of anchors) {
                        const href = a.href;
                        if (!href || !href.startsWith('http')) continue;
                        try {
                            const url = new URL(href);
                            const path = url.pathname;
                            const isAmazon = /(^|\.)amazon\./i.test(url.hostname);
                            if (isAmazon && (path.includes('/sspa/click') || path.includes('/gp/slredirect'))) {
                                const embedded = url.searchParams.get('url');
                                if (embedded) {
                                    const decoded = decodeURIComponent(embedded);
                                    const absolute = decoded.startsWith('http')
                                        ? decoded
                                        : `${url.origin}${decoded.startsWith('/') ? decoded : `/${decoded}`}`;
                                    try {
                                        const embeddedUrl = new URL(absolute);
                                        const dpMatch = embeddedUrl.pathname.match(/\/dp\/([A-Z0-9]{10})/i)
                                            || embeddedUrl.pathname.match(/\/gp\/product\/([A-Z0-9]{10})/i);
                                        if (dpMatch?.[1]) {
                                            links.push(`${embeddedUrl.origin}/dp/${dpMatch[1].toUpperCase()}`);
                                        } else {
                                            embeddedUrl.hash = '';
                                            links.push(embeddedUrl.toString());
                                        }
                                    } catch {}
                                }
                                continue;
                            }
                            if (isAmazon) {
                                const dpMatch = path.match(/\/dp\/([A-Z0-9]{10})/i)
                                    || path.match(/\/gp\/product\/([A-Z0-9]{10})/i);
                                if (dpMatch?.[1]) {
                                    links.push(`${url.origin}/dp/${dpMatch[1].toUpperCase()}`);
                                    continue;
                                }
                            }
                            // Skip profile/channel URLs
                            if (path.startsWith('/@') || path.startsWith('/channel/') ||
                                path.startsWith('/user/') || path.startsWith('/c/')) continue;
                            // Skip image CDN URLs
                            if (href.includes('ytimg.com') || href.includes('googleapis.com') ||
                                href.includes('googleusercontent.com') || href.includes('ggpht.com')) continue;
                            // Skip static assets
                            if (/\.(jpg|jpeg|png|gif|svg|webp|ico|css|js)$/i.test(path)) continue;
                            // Skip same-page anchor links and navigation
                            if (url.origin === window.location.origin && path === window.location.pathname) continue;
                            // Must have a meaningful path or query params
                            if (path.length > 1 || url.search.length > 0) {
                                links.push(href);
                            }
                        } catch { /* skip malformed URLs */ }
                    }
                    return [...new Set(links)].slice(0, 10);
                }
            });
            const links = results?.[0]?.result || [];
            if (links.length > 0) {
                console.log('[Workflow] Extracted page links:', links.slice(0, 5));
                const directAmazon = links.find(link => /(^https?:\/\/[^/]*amazon\.)/i.test(link) && /\/dp\/[A-Z0-9]{10}/i.test(link));
                return directAmazon || links[0];
            }
        } catch (e) {
            console.warn('[Workflow] Page link extraction failed:', e);
        }
        return null;
    },

    /**
     * Extract the domain from a sub-function spec's urlPatterns.
     */
    _getDomainFromSpec(subFuncSpec) {
        try {
            if (subFuncSpec.urlPatterns && subFuncSpec.urlPatterns.length > 0) {
                return new URL(subFuncSpec.urlPatterns[0].replace(/\*/g, 'x')).hostname;
            }
            if (subFuncSpec.urlTemplate) {
                return new URL(subFuncSpec.urlTemplate.replace(/\{\{.*?\}\}/g, 'test')).hostname;
            }
        } catch { /* ignore */ }
        return null;
    }
};

// Expose to window (popup context)
window.AITaskService = AITaskService;
