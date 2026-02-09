// Tool Orchestrator - Plans and executes multi-tool chains using Gemini
// Takes a natural language task, plans tool usage via AI, executes step-by-step
// Parallel path to existing workflow/task pipelines (does NOT replace them)

const ToolOrchestrator = {
    // Keywords that suggest a tool-chain approach is needed
    TOOL_KEYWORDS: [
        /\b(filter|classify|sentiment|categorize)\b.*\b(local|ollama|cheap|free)\b/i,
        /\b(embed|embedding|similarity|semantic|similar to|related to)\b/i,
        /\b(save|export|download)\b.*\b(csv|json|markdown|md|file)\b/i,
        /\b(hide|highlight|remove|filter)\b.*\b(on\s+(this|the)\s+page|from\s+(this|the)\s+page|elements)\b/i,
        /\b(compare|comparison|versus|vs\.?)\b.*\b(table|side.by.side|dashboard)\b/i,
        /\b(dashboard|report|summary\s+page|generate.*page|card.*grid|visualization)\b/i,
        /\b(track|monitor|daily|alert|notify|check\s+again|recurring)\b/i,
        /\b(notepad|remember|store.*result|pass.*between)\b/i,
        /\bweighted\b.*\b(score|rank|rating)\b/i,
        /\bollama\b/i,
        /\bboolean\b.*\bcheck\b/i,
    ],

    // Detect if a task should use the tool orchestrator
    detectToolNeeds(taskDescription) {
        const desc = taskDescription.toLowerCase();
        for (const pattern of this.TOOL_KEYWORDS) {
            if (pattern.test(desc)) {
                return { needsTools: true, matchedPattern: pattern.source };
            }
        }
        return { needsTools: false };
    },

    _taskMentionsCurrentTab(taskDescription = '') {
        const text = String(taskDescription || '').toLowerCase();
        return /\b(this page|current tab|current page|on this page|on this tab|already open tab|open tab|active tab)\b/.test(text);
    },

    _normalizePlanForCurrentTab(taskDescription = '', rawPlan = null) {
        if (!rawPlan || typeof rawPlan !== 'object' || Array.isArray(rawPlan)) {
            return rawPlan;
        }
        if (!this._taskMentionsCurrentTab(taskDescription)) {
            return rawPlan;
        }

        const normalized = JSON.parse(JSON.stringify(rawPlan));
        const steps = Array.isArray(normalized.plan) ? normalized.plan : [];
        if (steps.length === 0) {
            return normalized;
        }

        let hasCurrentTabContentStep = false;

        for (const step of steps) {
            if (!step || typeof step !== 'object') continue;
            if (step.tool === 'current_tab_content') {
                hasCurrentTabContentStep = true;
                if (!step.params || typeof step.params !== 'object') step.params = {};
                if (step.params.tabId === undefined) step.params.tabId = '{{tabId}}';
                if (step.params.maxChars === undefined) step.params.maxChars = 8000;
                if (!step.storeAs) step.storeAs = 'current_tab_context';
            }
            if (step.tool === 'computer_use_api') {
                if (!step.params || typeof step.params !== 'object') step.params = {};
                if (step.params.useCurrentTab === undefined) step.params.useCurrentTab = true;
                if (step.params.target === undefined) step.params.target = 'current-tab';
            }
        }

        if (!hasCurrentTabContentStep) {
            steps.unshift({
                stepNumber: 1,
                tool: 'current_tab_content',
                purpose: 'Capture current tab context before acting',
                params: {
                    tabId: '{{tabId}}',
                    maxChars: 8000
                },
                storeAs: 'current_tab_context'
            });
        }

        steps.forEach((step, idx) => {
            if (step && typeof step === 'object') {
                step.stepNumber = idx + 1;
            }
        });

        normalized.plan = steps;
        return normalized;
    },

    // Plan tool chain via Gemini AI
    async planToolChain(taskDescription, apiKey, context = {}) {
        const availableTools = await ToolRegistry.listAvailable();
        const toolSummary = availableTools.map(t =>
            `- ${t.name}: ${t.description} [${t.capabilities.join(', ')}]`
        ).join('\n');
        const currentUrl = context.currentUrl || 'unknown';
        const failure = context.verificationFailure || null;
        const correctionContext = context.verificationFailure
            ? `\nVERIFICATION FAILURE FROM PREVIOUS ATTEMPT:
- Issues: ${(failure.issues || []).join('; ') || 'Unknown issue'}
- Output head (first 100 chars): ${failure.head100 || ''}
- Output tail (last 100 chars): ${failure.tail100 || ''}
- Previous plan tools: ${(failure.previousTools || []).join(' -> ') || 'n/a'}
${Array.isArray(failure.suggestedFixes) && failure.suggestedFixes.length > 0
    ? `- Suggested fixes from verifier: ${JSON.stringify(failure.suggestedFixes)}`
    : ''}
${failure.uiAssessment && typeof failure.uiAssessment === 'object'
    ? `- UI assessment from verifier: ${JSON.stringify(failure.uiAssessment)}`
    : ''}
Use this to produce a corrected plan. If useful, add a computer_use_api step first to dismiss popups/overlays, then continue.`
            : '';

        const prompt = `You are a tool orchestrator for a browser automation Chrome extension. Plan a sequence of tool calls.

TASK: "${taskDescription}"
CURRENT TAB URL: "${currentUrl}"

AVAILABLE TOOLS:
${toolSummary}

RULES:
1. Each step uses exactly one tool.
2. Steps execute sequentially. Later steps can read from shared_notepad keys written by earlier steps.
3. Use shared_notepad to pass data between steps (write results, read them later).
4. Use local_ollama_model only for explicit local filtering/classification/sentiment/boolean tasks. For embedding/similarity ranking, use embedding_handler directly.
5. If Ollama is unavailable, the orchestrator will auto-fallback to remote_intelligence_api.
6. For scraping, use universal_flexible_scraper.
7. For visual/interactive tasks, use computer_use_api.
8. If the task refers to "this page" or "current tab", add current_tab_content early to ground the plan before acting.
9. If computer_use_api should stay on the active tab, pass { "useCurrentTab": true } (or target="current-tab").
10. End with an output step (webpage_generator, file_system_maker, or site_modifier) if the user expects visible results.
11. Keep plans concise: typically 3-7 steps.
12. Always keep current URL context. If scraping a different URL than CURRENT TAB URL, add a navigation step first (computer_use_api or scraper param url).
13. Do not scrape chrome-extension:// pages.
14. If you select local_ollama_model, params MUST include action from: booleanCheck|jsonExtract|sentiment|filterItems|generate|compareTexts|weightedScore.
15. If the task is embedding/similarity ranking, do NOT add a local_ollama_model cleaning step. Use embedding_handler directly with action=rank and pass documents/document_key.
16. When generating UI/report output, preserve as many source fields as possible (including URLs/image URLs) instead of dropping columns.
17. For recurring/monitoring tasks, use task_scheduler with concrete params.
18. For dynamic feeds/pages that change after scroll or live updates, prefer task_scheduler with scheduleType="domChange".
19. For site_modifier:
    - Use "selector" as a CSS selector string, not an object/array payload.
    - For index-based hiding use { "action": "hideByIndices", "selector": "...", "indices": [0,1,2] }.
    - Do not pass full notepad result objects directly as "selector".
20. For remote_intelligence_api steps that are expected to return structured data, set "parseJson": true.
21. If a site may show a country/region gate, pass params.regionPreference ("us" or "ca", default "us") on relevant scraping/interactive steps.
22. Prefer relying on scraper-side auto-handling for country/region overlays; add explicit computer_use_api gate-handling only when needed.
23. For computer_use_api use "taskDescription" as the primary instruction. Shorthand params ("action", "text", "url") are allowed, but still include clear intent.

SCHEDULER EXAMPLES:
- Every 30 minutes:
  {"tool":"task_scheduler","params":{"action":"create","functionName":"RunCheckPrices","scheduleType":"interval","intervalMinutes":30}}
- Daily at 09:00 local:
  {"tool":"task_scheduler","params":{"action":"create","functionName":"RunDailyReport","scheduleType":"atTime","atTime":"09:00"}}
- Trigger when keyword appears on active tab:
  {"tool":"task_scheduler","params":{"action":"create","functionName":"RunCaptureLeads","scheduleType":"keyword","keyword":"Contact us","triggerMode":"oncePerUrl"}}
- Trigger when new content is added (infinite scroll/live feed):
  {"tool":"task_scheduler","params":{"action":"create","functionName":"RunFeedFilter","scheduleType":"domChange","domSelector":"ytd-rich-item-renderer","domDebounceMs":1200,"runOnPageLoad":true,"triggerMode":"everyMatch"}}

${correctionContext}

Reply with ONLY valid JSON (no markdown, no explanation):
{
  "plan": [
    {
      "stepNumber": 1,
      "tool": "tool_name",
      "purpose": "brief description of what this step does",
      "params": { "param1": "value", "param2": "{{notepad:key_from_previous_step}}" },
      "storeAs": "notepad_key_to_store_result"
    }
  ],
  "expectedOutput": "what the user will see at the end"
}

For params that depend on previous results, use {{notepad:keyName}} syntax.
For the active tab ID, use {{tabId}}.
For the API key, use {{apiKey}}.`;

        const requestBody = {
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: {
                responseMimeType: 'application/json',
                temperature: 0.1
            }
        };

        const result = await AIService.callGemini(requestBody, apiKey);
        return this._normalizePlanForCurrentTab(taskDescription, result);
    },

    // Execute a planned tool chain step-by-step
    async executeToolChain(plan, apiKey, options = {}) {
        const { onStatusUpdate = () => {}, tabId, captureStepScreenshots = true, shouldAbort = () => false } = options;
        const steps = plan.plan || plan;

        if (!Array.isArray(steps) || steps.length === 0) {
            throw new Error('Invalid tool chain plan: no steps');
        }
        if (shouldAbort()) {
            throw new Error('Stopped by user');
        }

        onStatusUpdate(`Executing ${steps.length}-step tool chain...`, {
            type: 'tool-chain-start',
            totalSteps: steps.length
        });

        const results = [];
        const stepScreenshots = [];

        for (const step of steps) {
            if (shouldAbort()) {
                throw new Error('Stopped by user');
            }
            const stepNum = step.stepNumber || (results.length + 1);
            onStatusUpdate(`Step ${stepNum}/${steps.length}: ${step.purpose}`, {
                type: 'tool-step-start',
                step: stepNum,
                tool: step.tool,
                purpose: step.purpose
            });

            let resolvedParams = {};
            try {
                // Resolve parameter references
                resolvedParams = this._resolveParams(step.params, {
                    tabId,
                    apiKey
                });
                if (step.tool === 'site_modifier') {
                    resolvedParams = this._normalizeSiteModifierParams(resolvedParams);
                }

                // Execute the tool
                if (step.tool === 'remote_intelligence_api' && resolvedParams.parseJson === undefined) {
                    resolvedParams.parseJson = this._inferRemoteJsonExpectation(resolvedParams);
                }
                const result = await ToolRegistry.execute(step.tool, resolvedParams, {
                    apiKey,
                    tabId
                });

                const localOllamaEmpty =
                    step.tool === 'local_ollama_model' &&
                    this._isEmptyLocalOllamaResult(result, resolvedParams);
                if (localOllamaEmpty) {
                    throw new Error('Ollama returned empty result');
                }

                if (result && typeof result === 'object' && result.success === false) {
                    throw new Error(result.error || `${step.tool} reported success=false`);
                }

                // Store result in notepad if requested
                if (step.storeAs) {
                    const dataToStore = result.data || result.result || result.results || result;
                    NotepadService.write(step.storeAs, dataToStore);
                }

                results.push({
                    step: stepNum,
                    tool: step.tool,
                    success: true,
                    storeAs: step.storeAs,
                    result
                });

                const resultTabId = Number.isInteger(result?.tabId) ? result.tabId : null;
                const screenshotTargetTabId = resultTabId || tabId || null;
                if (captureStepScreenshots && screenshotTargetTabId) {
                    const screenshot = await this._captureTabScreenshot(screenshotTargetTabId);
                    if (screenshot) {
                        stepScreenshots.push({
                            step: stepNum,
                            tool: step.tool,
                            screenshot,
                            tabId: screenshotTargetTabId
                        });
                    }
                }

                onStatusUpdate(`Step ${stepNum} completed: ${step.purpose}`, {
                    type: 'tool-step-complete',
                    step: stepNum,
                    tool: step.tool
                });

            } catch (error) {
                console.error(`[Orchestrator] Step ${stepNum} (${step.tool}) failed:`, error.message);

                // Try Gemini fallback if Ollama tool failed
                if (
                    step.tool === 'local_ollama_model' &&
                    /not available|ollama|403|forbidden/i.test(error.message || '')
                ) {
                    onStatusUpdate(`Step ${stepNum}: Ollama unavailable, falling back to Gemini...`, {
                        type: 'tool-step-fallback',
                        step: stepNum
                    });

                    try {
                        const fallbackResult = await this._ollamaFallbackToGemini(step, apiKey, resolvedParams);
                        if (step.storeAs) {
                            NotepadService.write(step.storeAs, fallbackResult);
                        }
                        results.push({
                            step: stepNum,
                            tool: 'remote_intelligence_api (fallback)',
                            success: true,
                            storeAs: step.storeAs,
                            result: fallbackResult
                        });
                        onStatusUpdate(`Step ${stepNum} completed via Gemini fallback`, {
                            type: 'tool-step-complete',
                            step: stepNum
                        });
                        continue;
                    } catch (fbError) {
                        // Fallback also failed
                        console.error(`[Orchestrator] Gemini fallback also failed:`, fbError.message);
                    }
                }

                results.push({
                    step: stepNum,
                    tool: step.tool,
                    success: false,
                    error: error.message
                });

                if (captureStepScreenshots && tabId) {
                    const screenshot = await this._captureTabScreenshot(tabId);
                    if (screenshot) {
                        stepScreenshots.push({
                            step: stepNum,
                            tool: step.tool,
                            screenshot,
                            tabId,
                            failure: true
                        });
                    }
                }

                onStatusUpdate(`Step ${stepNum} failed: ${error.message}`, {
                    type: 'tool-step-error',
                    step: stepNum,
                    error: error.message
                });

                const hitComputerUseActionLimit =
                    step.tool === 'computer_use_api' &&
                    /max actions reached without task completion/i.test(error.message || '');
                if (hitComputerUseActionLimit) {
                    const increaseMsg = 'Computer Use reached the action limit. Increase "Computer Use Max Actions" in Settings, then run again.';
                    onStatusUpdate(increaseMsg, {
                        type: 'tool-chain-blocked',
                        reason: 'increase_max_actions',
                        step: stepNum
                    });
                    const notepadState = NotepadService.readAll();
                    return {
                        success: false,
                        steps: results,
                        stepScreenshots,
                        notepadState,
                        totalSteps: steps.length,
                        failedSteps: results.filter(r => !r.success).length,
                        aborted: true,
                        abortReason: 'computer_use_max_actions'
                    };
                }

                // Continue to next step for other failures
            }
        }

        const allSucceeded = results.every(r => r.success);
        const notepadState = NotepadService.readAll();

        onStatusUpdate(
            allSucceeded
                ? `Tool chain completed successfully (${results.length} steps)`
                : `Tool chain completed with errors (${results.filter(r => !r.success).length} failed)`,
            { type: 'tool-chain-complete', success: allSucceeded }
        );

        return {
            success: allSucceeded,
            steps: results,
            stepScreenshots,
            notepadState,
            totalSteps: steps.length,
            failedSteps: results.filter(r => !r.success).length
        };
    },

    async _captureTabScreenshot(tabId) {
        if (!tabId) return null;
        try {
            const tab = await chrome.tabs.get(tabId);
            if (!tab?.windowId || !tab?.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
                return null;
            }

            await chrome.tabs.update(tabId, { active: true });
            await chrome.windows.update(tab.windowId, { focused: true });
            await new Promise(r => setTimeout(r, 300));

            const dataUrl = await new Promise(resolve => {
                chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 72 }, (url) => {
                    resolve(chrome.runtime.lastError ? null : url);
                });
            });

            return dataUrl || null;
        } catch {
            return null;
        }
    },

    _stringifyForVerification(value) {
        if (value === undefined || value === null) return '';
        if (typeof value === 'string') return value;
        try {
            return JSON.stringify(value, null, 2);
        } catch {
            return String(value);
        }
    },

    _extractPrimaryOutputText(notepadState = {}, steps = []) {
        const looksMetadataOnly = (value, text) => {
            if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
            const keys = Object.keys(value);
            if (keys.length === 0) return true;
            const lower = keys.map(k => String(k).toLowerCase());
            const metadataKeys = new Set([
                'success', 'tabid', 'template', 'templatetype', 'pageid', 'durationms',
                'status', 'message', 'timestamp', 'createdat'
            ]);
            const allMeta = lower.every(k => metadataKeys.has(k));
            if (allMeta) return true;
            return String(text || '').length < 180 && !/(price|rating|availability|title|summary|comparison|table|\[|\{)/i.test(String(text || ''));
        };

        const successfulSteps = Array.isArray(steps)
            ? steps.filter(s => s && s.success)
            : [];
        for (const step of [...successfulSteps].reverse()) {
            if (!step?.storeAs) continue;
            if (!Object.prototype.hasOwnProperty.call(notepadState || {}, step.storeAs)) continue;
            const value = notepadState[step.storeAs];
            const text = this._stringifyForVerification(value).trim();
            if (!text) continue;
            if (looksMetadataOnly(value, text)) continue;
            return { key: step.storeAs, text, score: 999 };
        }

        const outputTools = new Set(['webpage_generator', 'file_system_maker', 'site_modifier']);
        for (const step of [...successfulSteps].reverse()) {
            if (!outputTools.has(step?.tool)) continue;
            const text = this._stringifyForVerification(step.result).trim();
            if (!text) continue;
            return { key: `${step.tool}_result`, text, score: 998 };
        }

        const scored = [];
        const scoreKey = (key) => {
            const k = String(key || '').toLowerCase();
            let score = 0;
            if (/markdown|md/.test(k)) score += 6;
            if (/html|page|report|summary/.test(k)) score += 5;
            if (/content|output|result|export/.test(k)) score += 4;
            if (/data|rows|items|list/.test(k)) score += 2;
            return score;
        };

        for (const [key, value] of Object.entries(notepadState || {})) {
            const text = this._stringifyForVerification(value).trim();
            if (!text) continue;
            scored.push({
                key,
                text,
                score: scoreKey(key) + Math.min(Math.floor(text.length / 800), 5)
            });
        }

        if (scored.length > 0) {
            scored.sort((a, b) => b.score - a.score);
            return scored[0];
        }

        const lastResult = [...(steps || [])].reverse().find(s => s && s.success);
        if (lastResult) {
            const text = this._stringifyForVerification(lastResult.result).trim();
            if (text) {
                return { key: 'last_step_result', text, score: 1 };
            }
        }

        return { key: 'none', text: '', score: 0 };
    },

    _planNeedsStrictVerification(steps = []) {
        const outputTools = new Set(['file_system_maker', 'webpage_generator', 'site_modifier']);
        return (steps || []).some(s => outputTools.has(s.tool));
    },

    _planHasUiGeneration(steps = []) {
        return (steps || []).some(s => s?.tool === 'webpage_generator');
    },

    _inferRemoteJsonExpectation(params = {}) {
        if (!params || typeof params !== 'object') return false;
        if (typeof params.parseJson === 'boolean') return params.parseJson;
        const prompt = String(params.prompt || '').toLowerCase();
        if (!prompt) return false;
        return /(?:valid\s+)?json|json\s+array|json\s+object|return\s+only\s+json|strict\s+json|reply\s+with\s+only/.test(prompt);
    },

    _stepLikelyRegionGate(step = {}) {
        const text = [
            step?.purpose || '',
            step?.tool || '',
            typeof step?.params === 'object' ? JSON.stringify(step.params) : ''
        ].join(' ').toLowerCase();
        return (
            text.includes('country')
            || text.includes('region')
            || text.includes('intl')
            || text.includes('united states')
            || text.includes('canada')
        );
    },

    async _verifyToolChainExecution(plan, executionResult, apiKey, context = {}) {
        const { tabId, onStatusUpdate = () => {} } = context;
        const primary = this._extractPrimaryOutputText(executionResult?.notepadState, executionResult?.steps);
        const outputText = primary.text || '';
        const head100 = outputText.slice(0, 100);
        const tail100 = outputText.slice(-100);
        const steps = plan?.plan || plan || [];
        const isUiGenerationPlan = this._planHasUiGeneration(steps);

        const allStepShots = Array.isArray(executionResult?.stepScreenshots) ? executionResult.stepScreenshots : [];
        const generatedUiShots = allStepShots
            .filter(s => s?.tool === 'webpage_generator' && typeof s?.screenshot === 'string')
            .map(s => s.screenshot);
        const recentShots = allStepShots
            .map(s => s?.screenshot)
            .filter(Boolean)
            .slice(-3);
        const mergedShots = [...generatedUiShots.slice(-2), ...recentShots];
        const seen = new Set();
        const screenshots = mergedShots.filter((shot) => {
            if (seen.has(shot)) return false;
            seen.add(shot);
            return true;
        });
        const fallbackShot = screenshots.length === 0 && tabId ? await this._captureTabScreenshot(tabId) : null;
        const visualShots = fallbackShot ? [fallbackShot] : screenshots;

        onStatusUpdate('Running verification test (content + screenshot check)...', {
            type: 'tool-chain-verification-start'
        });

        const stepSummary = (executionResult?.steps || []).map(s =>
            `#${s.step} ${s.tool}: ${s.success ? 'ok' : 'failed'}${s.error ? ` (${s.error})` : ''}`
        ).join('\n');

        const uiVerificationRules = isUiGenerationPlan
            ? `\nUI QUALITY CHECK (required because webpage_generator is in the plan):
- Inspect the generated UI screenshot(s) for readability, spacing, visual hierarchy, and useful data density.
- Mark valid=false if UI looks broken, cluttered, empty, or visually low quality for the requested task.
- If invalid, include at least one suggestedFixes entry for "webpage_generator" with improved params/template options.`
            : '';

        const parts = [{
            text: `Validate this tool-chain output.
EXPECTED OUTPUT:
${plan.expectedOutput || 'No explicit expected output'}

PRIMARY OUTPUT KEY: ${primary.key}
PRIMARY OUTPUT LENGTH: ${outputText.length}
FIRST_100_CHARS:
${head100}
LAST_100_CHARS:
${tail100}

STEP SUMMARY:
${stepSummary}

Return strict JSON:
{
  "valid": boolean,
  "issues": ["..."],
  "recommendations": ["..."],
  "suggestedFixes": [
    { "tool": "computer_use_api|current_tab_content|universal_flexible_scraper|remote_intelligence_api|task_scheduler|webpage_generator|site_modifier|file_system_maker", "purpose": "why", "params": {} }
  ]
}

Rules:
- valid=false if output is empty, placeholder-like, or clearly mismatched.
- If visual blockers/popups are likely, recommend a computer_use_api step first.
- For computer_use_api fixes, prefer params.taskDescription (include regionPreference for country/region gates when relevant).
- If extraction quality is poor, recommend scraper refinement.
- Keep issues concise and actionable.${uiVerificationRules}

Also include:
"uiAssessment": { "score": 0-10, "issues": ["..."], "strengths": ["..."] }`
        }];

        for (const shot of visualShots) {
            const mimeType = shot.startsWith('data:image/png') ? 'image/png' : 'image/jpeg';
            const data = shot.replace(/^data:image\/\w+;base64,/, '');
            parts.push({ inlineData: { mimeType, data } });
        }

        try {
            const requestBody = {
                contents: [{ role: 'user', parts }],
                generationConfig: {
                    responseMimeType: 'application/json',
                    temperature: 0.1
                }
            };
            const verdict = await AIService.callGemini(requestBody, apiKey, true);
            const issues = Array.isArray(verdict?.issues) ? [...verdict.issues] : [];
            const recommendations = Array.isArray(verdict?.recommendations) ? verdict.recommendations : [];
            const suggestedFixes = Array.isArray(verdict?.suggestedFixes) ? [...verdict.suggestedFixes] : [];
            const uiAssessment = verdict?.uiAssessment && typeof verdict.uiAssessment === 'object'
                ? verdict.uiAssessment
                : null;
            let valid = !!verdict?.valid;

            if (isUiGenerationPlan) {
                const uiScore = Number(uiAssessment?.score);
                if (Number.isFinite(uiScore) && uiScore < 7) {
                    valid = false;
                    issues.push(`UI quality score ${uiScore}/10 is below required threshold (7/10).`);
                }

                if (visualShots.length === 0) {
                    valid = false;
                    issues.push('UI verification had no screenshots to evaluate.');
                }

                const hasWebpageFix = suggestedFixes.some(fix =>
                    String(fix?.tool || '').toLowerCase() === 'webpage_generator'
                );
                if (!valid && !hasWebpageFix) {
                    suggestedFixes.push({
                        tool: 'webpage_generator',
                        purpose: 'Regenerate the report UI with clearer hierarchy and readability.',
                        params: {
                            templateType: 'summary',
                            options: { title: 'Refined generated report' }
                        }
                    });
                }
            }

            return {
                valid,
                issues,
                recommendations,
                suggestedFixes,
                uiAssessment,
                head100,
                tail100
            };
        } catch (e) {
            return {
                valid: outputText.length > 0,
                issues: [`Verification parser fallback: ${e.message}`],
                recommendations: [],
                suggestedFixes: [],
                head100,
                tail100
            };
        }
    },

    // Resolve {{notepad:key}}, {{tabId}}, {{apiKey}} references in params
    _resolveParams(params, context) {
        if (!params || typeof params !== 'object') return params;

        const resolved = JSON.parse(JSON.stringify(params));

        const resolve = (obj) => {
            for (const [key, value] of Object.entries(obj)) {
                if (typeof value === 'string') {
                    // Replace {{notepad:key}} with actual values
                    obj[key] = value.replace(/\{\{notepad:(\w+)\}\}/g, (match, notepadKey) => {
                        const data = NotepadService.read(notepadKey);
                        if (data === null) return match; // Keep reference if not found
                        return typeof data === 'object' ? JSON.stringify(data) : String(data);
                    });

                    // Replace {{tabId}} and {{apiKey}}
                    if (obj[key] === '{{tabId}}') obj[key] = context.tabId;
                    if (obj[key] === '{{apiKey}}') obj[key] = context.apiKey;
                } else if (typeof value === 'object' && value !== null) {
                    resolve(value);
                }
            }
        };

        resolve(resolved);

        // Special handling: if a param value is a notepad reference and the data is an object/array,
        // inject it directly (not as a stringified version)
        for (const [key, value] of Object.entries(params)) {
            if (typeof value === 'string' && /^\{\{notepad:\w+\}\}$/.test(value)) {
                const notepadKey = value.match(/^\{\{notepad:(\w+)\}\}$/)[1];
                const data = NotepadService.read(notepadKey);
                if (data !== null) {
                    resolved[key] = data;
                }
            }
        }

        return resolved;
    },

    _normalizeSiteModifierParams(params = {}) {
        const normalized = params && typeof params === 'object'
            ? JSON.parse(JSON.stringify(params))
            : {};
        const action = String(normalized?.action || '').trim().toLowerCase();
        const selectorSource =
            normalized?.selector
            ?? normalized?.selectors
            ?? normalized?.containerSelector
            ?? normalized?.targetSelector
            ?? normalized?.videoSelector
            ?? normalized?.itemSelector;
        const indicesSource = normalized?.indices ?? normalized?.matches ?? normalized?.results;

        if (typeof SiteModifier !== 'undefined') {
            if (typeof SiteModifier._normalizeSelectorValue === 'function') {
                normalized.selector = SiteModifier._normalizeSelectorValue(selectorSource);
            }
            if (action === 'hidebyindices' && typeof SiteModifier._normalizeIndices === 'function') {
                normalized.indices = SiteModifier._normalizeIndices(indicesSource);
            }
            return normalized;
        }

        if (Array.isArray(selectorSource)) {
            normalized.selector = selectorSource
                .map(v => String(v || '').trim())
                .filter(Boolean)
                .join(', ');
        } else if (selectorSource && typeof selectorSource === 'object') {
            normalized.selector = String(
                selectorSource.selector
                || selectorSource.containerSelector
                || selectorSource.targetSelector
                || selectorSource.videoSelector
                || selectorSource.itemSelector
                || ''
            ).trim();
        } else {
            normalized.selector = typeof selectorSource === 'string' ? selectorSource.trim() : '';
        }

        if (action === 'hidebyindices') {
            const values = Array.isArray(indicesSource)
                ? indicesSource
                : (indicesSource && typeof indicesSource === 'object' ? (indicesSource.indices || indicesSource.results || []) : []);
            normalized.indices = values
                .map(v => Number(v?.index ?? v))
                .filter(n => Number.isFinite(n) && n >= 0)
                .map(n => Math.floor(n));
        }

        return normalized;
    },

    // Fallback: execute Ollama-intended tasks via Gemini
    _extractTextList(input) {
        const pick = (obj) => {
            if (typeof obj === 'string') return obj.trim();
            if (!obj || typeof obj !== 'object') return '';
            const preferred = [
                'review_text', 'reviewText', 'review', 'comment', 'commentBody', 'body', 'message',
                'title', 'headline', 'name', 'text', 'text_content', 'description', 'summary', 'content'
            ];
            for (const key of preferred) {
                const v = obj[key];
                if (typeof v === 'string' && v.trim()) return v.trim();
            }
            for (const v of Object.values(obj)) {
                if (typeof v === 'string' && v.trim()) return v.trim();
            }
            return '';
        };

        if (!input) return [];
        if (Array.isArray(input)) return input.map(pick).filter(Boolean);
        if (typeof input === 'object') {
            const buckets = [input.items, input.data, input.results, input.result, input.extractedData, input.lastExtractionResult?.result];
            for (const bucket of buckets) {
                if (Array.isArray(bucket)) return bucket.map(pick).filter(Boolean);
            }
            const one = pick(input);
            return one ? [one] : [];
        }
        return [];
    },

    _isEmptyLocalOllamaResult(result, params = {}) {
        if (!result || result.success === false || result.error) return false;
        const action = params.action || params.task || '';
        const output = result.result;

        if (output === null || output === undefined) return true;
        if (action === 'sentiment') {
            if (Array.isArray(params.items) && params.items.length > 0 && Array.isArray(output) && output.length === 0) {
                return true;
            }
            if (!Array.isArray(params.items) && typeof output === 'string') {
                return !['positive', 'negative', 'neutral'].includes(output.toLowerCase().trim());
            }
        }
        return false;
    },

    async _ollamaFallbackToGemini(step, apiKey, resolvedParams = null) {
        const params = resolvedParams || step.params || {};
        const action = params.action;
        const sentimentBatchMode = action === 'sentiment' && Array.isArray(params.items);
        let sentimentBatchInput = null;

        // If no clear action is provided but we have items, return a deterministic text list.
        // This prevents empty downstream ranking inputs.
        if (!action) {
            const texts = this._extractTextList(params.items || params.data || params.documents || params.results || params.result || params);
            if (texts.length > 0) return texts;
        }

        let prompt;
        switch (action) {
            case 'booleanCheck':
                prompt = `Answer ONLY "true" or "false": ${params.question || params.prompt}`;
                break;
            case 'sentiment':
                if (sentimentBatchMode) {
                    const textKey = typeof params.text_key === 'string' ? params.text_key : (typeof params.textKey === 'string' ? params.textKey : null);
                    sentimentBatchInput = params.items.map((item, index) => {
                        let text = '';
                        if (textKey && item && typeof item === 'object' && typeof item[textKey] === 'string') {
                            text = item[textKey];
                        } else if (typeof item === 'string') {
                            text = item;
                        } else if (item && typeof item === 'object') {
                            text = item.review_text || item.reviewText || item.commentBody || item.comment || item.text || item.description || '';
                        }
                        return { index, text: String(text || '').trim(), original: item };
                    }).filter(row => row.text);

                    if (sentimentBatchInput.length === 0) return [];
                    prompt = `Classify each entry sentiment as "positive", "negative", or "neutral".
Return ONLY a JSON array using this schema: [{"index": number, "sentiment": "positive|negative|neutral"}].
Entries: ${JSON.stringify(sentimentBatchInput.map(({ index, text }) => ({ index, text })))}`;
                } else {
                    prompt = `Classify sentiment as "positive", "negative", or "neutral": ${params.text}`;
                }
                break;
            case 'filterItems':
                prompt = `Filter these items by the criteria. Return ONLY a JSON array of matching items.\nItems: ${JSON.stringify(params.items)}\nCriteria: ${params.criteria}`;
                break;
            case 'jsonExtract':
                prompt = `Extract data matching this schema from the text. Return ONLY JSON.\nSchema: ${JSON.stringify(params.schema)}\nText: ${params.text}`;
                break;
            default:
                prompt = params.prompt || params.question || JSON.stringify(params);
        }

        const requestBody = {
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: {
                temperature: 0,
                responseMimeType: action === 'booleanCheck' || (action === 'sentiment' && !sentimentBatchMode) ? 'text/plain' : 'application/json'
            }
        };

        const parseJson = action !== 'booleanCheck' && !(action === 'sentiment' && !sentimentBatchMode);
        const result = await AIService.callGemini(requestBody, apiKey, parseJson);

        if (action === 'booleanCheck') {
            const text = result?.candidates?.[0]?.content?.parts?.[0]?.text || '';
            return text.toLowerCase().includes('true');
        }
        if (action === 'sentiment') {
            if (sentimentBatchMode) {
                const rows = Array.isArray(result) ? result : (Array.isArray(result?.items) ? result.items : []);
                const byIndex = new Map(rows.map(row => [Number(row?.index), String(row?.sentiment || 'neutral').toLowerCase()]));
                return sentimentBatchInput.map(({ index, original, text }) => {
                    const sentiment = byIndex.get(index) || 'neutral';
                    if (original && typeof original === 'object') return { ...original, sentiment };
                    return { text, sentiment };
                });
            }
            const text = result?.candidates?.[0]?.content?.parts?.[0]?.text || '';
            if (text.includes('positive')) return 'positive';
            if (text.includes('negative')) return 'negative';
            return 'neutral';
        }

        return result;
    },

    // Full pipeline: detect -> plan -> execute
    async executeFullPipeline(taskDescription, apiKey, options = {}) {
        const { onStatusUpdate = () => {}, tabId, shouldAbort = () => false } = options;
        if (shouldAbort()) {
            throw new Error('Stopped by user');
        }
        let effectiveTabId = tabId;
        let currentUrl = null;
        if (!effectiveTabId) {
            const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
            effectiveTabId = activeTab?.id;
            currentUrl = activeTab?.url || null;
        } else {
            try {
                const tab = await chrome.tabs.get(effectiveTabId);
                currentUrl = tab?.url || null;
            } catch {
                currentUrl = null;
            }
        }

        // Step 1: Plan
        onStatusUpdate('Planning tool chain...', { type: 'planning' });
        const plan = await this.planToolChain(taskDescription, apiKey, { currentUrl, tabId: effectiveTabId });
        if (shouldAbort()) {
            throw new Error('Stopped by user');
        }

        if (!plan || !plan.plan || plan.plan.length === 0) {
            throw new Error('Failed to generate a tool chain plan');
        }

        onStatusUpdate(`Plan ready: ${plan.plan.length} steps. Expected: ${plan.expectedOutput || 'results'}`, {
            type: 'plan-ready',
            plan: plan.plan,
            expectedOutput: plan.expectedOutput
        });

        // Step 2: Execute
        let activePlan = plan;
        let result = await this.executeToolChain(activePlan, apiKey, {
            onStatusUpdate,
            tabId: effectiveTabId,
            captureStepScreenshots: true,
            shouldAbort
        });

        // Step 3: Mandatory verification test + bounded auto-repair loop
        let verification = null;
        const strictVerification = this._planNeedsStrictVerification(activePlan.plan || activePlan);
        const maxRepairAttempts = 2;
        let repairAttempt = 0;

        while (result.success) {
            if (shouldAbort()) {
                throw new Error('Stopped by user');
            }

            verification = await this._verifyToolChainExecution(activePlan, result, apiKey, {
                tabId: effectiveTabId,
                onStatusUpdate
            });

            if (verification.valid) {
                onStatusUpdate(
                    repairAttempt > 0
                        ? `Verification passed after auto-repair (${repairAttempt}/${maxRepairAttempts}).`
                        : 'Verification test passed.',
                    {
                        type: 'tool-chain-verification-complete',
                        success: true
                    }
                );
                break;
            }

            onStatusUpdate(`Verification failed: ${(verification.issues || []).join('; ') || 'Output mismatch'}`, {
                type: 'tool-chain-verification-complete',
                success: false,
                issues: verification.issues || []
            });

            if (repairAttempt >= maxRepairAttempts) {
                onStatusUpdate(`Auto-repair limit reached (${maxRepairAttempts}).`, {
                    type: 'tool-chain-repair-complete',
                    success: false
                });
                break;
            }

            repairAttempt += 1;
            onStatusUpdate(`Attempting auto-repair plan (${repairAttempt}/${maxRepairAttempts})...`, {
                type: 'tool-chain-repair-start'
            });

            const repairedPlan = await this.planToolChain(taskDescription, apiKey, {
                currentUrl,
                tabId: effectiveTabId,
                verificationFailure: {
                    issues: verification.issues || [],
                    head100: verification.head100 || '',
                    tail100: verification.tail100 || '',
                    previousTools: (activePlan.plan || []).map(s => s.tool),
                    suggestedFixes: verification.suggestedFixes || [],
                    uiAssessment: verification.uiAssessment || null
                }
            });

            if (!(repairedPlan?.plan?.length > 0)) {
                onStatusUpdate('Auto-repair planner did not return a usable plan.', {
                    type: 'tool-chain-repair-complete',
                    success: false
                });
                break;
            }

            onStatusUpdate(`Repair plan ready: ${repairedPlan.plan.length} steps. Re-running...`, {
                type: 'tool-chain-repair-plan',
                plan: repairedPlan.plan
            });

            const repairedResult = await this.executeToolChain(repairedPlan, apiKey, {
                onStatusUpdate,
                tabId: effectiveTabId,
                captureStepScreenshots: true,
                shouldAbort
            });

            activePlan = repairedPlan;
            result = repairedResult;

            if (!repairedResult.success) {
                onStatusUpdate('Auto-repair execution failed before verification.', {
                    type: 'tool-chain-repair-complete',
                    success: false
                });
                break;
            }
        }

        const verificationPassed = verification ? !!verification.valid : true;
        const finalSuccess = result.success && (!strictVerification || verificationPassed);

        let savedFunction = null;
        if (finalSuccess) {
            if (shouldAbort()) {
                throw new Error('Stopped by user');
            }
            try {
                savedFunction = await this._saveToolChainAsFunction(taskDescription, activePlan, currentUrl);
                onStatusUpdate(`Saved tool chain as function "${savedFunction.name}"`, {
                    type: 'tool-chain-saved-function',
                    functionName: savedFunction.name
                });
            } catch (e) {
                console.warn('[ToolOrchestrator] Failed to auto-save tool chain as function:', e.message);
            }
        } else {
            onStatusUpdate('Tool chain failed verification or had execution errors, so it was not saved as a function.', {
                type: 'tool-chain-not-saved',
                reason: result.success ? 'verification_failed' : 'failed_steps'
            });
        }

        return {
            ...result,
            success: finalSuccess,
            plan: activePlan.plan,
            expectedOutput: activePlan.expectedOutput,
            verification,
            savedFunction
        };
    },

    _sanitizeFunctionName(taskDescription = '') {
        const words = String(taskDescription)
            .replace(/[^a-zA-Z0-9\s]/g, ' ')
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 8);
        const base = words
            .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
            .join('') || 'ToolChain';
        return `Run${base}`;
    },

    _resolveUrlPatterns(currentUrl) {
        try {
            if (!currentUrl) return [];
            const parsed = new URL(currentUrl);
            return Array.from(new Set([
                `${parsed.origin}${parsed.pathname}*`,
                `${parsed.origin}/*`
            ]));
        } catch {
            return [];
        }
    },

    _extractQuotedPhrases(text = '') {
        const phrases = [];
        const regex = /"([^"]+)"|'([^']+)'/g;
        let match;
        while ((match = regex.exec(String(text || '')))) {
            const value = (match[1] || match[2] || '').trim();
            if (value) phrases.push(value);
        }
        return Array.from(new Set(phrases));
    },

    _parameterizeToolChainPlan(taskDescription, chainPlan = []) {
        const planCopy = JSON.parse(JSON.stringify(Array.isArray(chainPlan) ? chainPlan : []));
        const inferredInputs = [];

        const addInput = (name, description, defaultValue, type = 'string') => {
            if (inferredInputs.some(inp => inp.name === name)) return;
            inferredInputs.push({
                name,
                type,
                description,
                defaultValue: String(defaultValue || '')
            });
        };

        const taskLower = String(taskDescription || '').toLowerCase();
        const likelyBannedTopicTask = /\b(ban|banned|avoid|exclude|block|hide|filter out|remove)\b/.test(taskLower);
        const queryInputName = likelyBannedTopicTask ? 'bannedTopics' : 'semanticQuery';
        const queryInputDescription = likelyBannedTopicTask
            ? 'Comma-separated topics to hide or exclude semantically.'
            : 'Comma-separated semantic query topics for ranking/filtering.';

        let queryDefault = '';
        for (const step of planCopy) {
            if (step?.tool === 'embedding_handler' && typeof step?.params?.query === 'string' && step.params.query.trim()) {
                if (!queryDefault) queryDefault = step.params.query.trim();
                step.params.query = `{{input:${queryInputName}}}`;
            }
        }

        const quotedPhrases = this._extractQuotedPhrases(taskDescription);
        const quotedDefault = quotedPhrases.join(', ').trim();
        if (queryDefault || quotedDefault) {
            addInput(queryInputName, queryInputDescription, quotedDefault || queryDefault);
        }

        const taskSuggestsRegionGate = /\b(country|region|intl|united states|canada)\b/i.test(String(taskDescription || ''));
        const planSuggestsRegionGate = planCopy.some(step => this._stepLikelyRegionGate(step));
        const needsRegionPreference = taskSuggestsRegionGate || planSuggestsRegionGate;
        if (needsRegionPreference) {
            addInput(
                'regionPreference',
                'Preferred country/region selection for geo gates: "us" for United States or "ca" for Canada.',
                'us'
            );
            for (const step of planCopy) {
                if (!step || typeof step !== 'object') continue;
                if (!step.params || typeof step.params !== 'object') step.params = {};
                if (step.tool === 'universal_flexible_scraper' || step.tool === 'computer_use_api') {
                    if (!step.params.regionPreference) {
                        step.params.regionPreference = '{{input:regionPreference}}';
                    }
                }
            }
        }

        const hasEmbeddingStep = planCopy.some(step => step?.tool === 'embedding_handler');
        const hasHideByIndicesStep = planCopy.some(step =>
            step?.tool === 'site_modifier' &&
            String(step?.params?.action || '').toLowerCase() === 'hidebyindices'
        );
        const iterativeSemanticCleanup = hasEmbeddingStep && hasHideByIndicesStep;
        if (iterativeSemanticCleanup) {
            addInput(
                'maxPasses',
                'How many semantic cleanup passes to run for dynamic feeds.',
                '5',
                'number'
            );
        }

        for (const step of planCopy) {
            if (!step || typeof step !== 'object' || !step.params || typeof step.params !== 'object') continue;

            if (step.tool === 'local_ollama_model') {
                if (typeof step.params.prompt === 'string') {
                    const p = step.params.prompt.toLowerCase();
                    if (
                        p.includes('similarity score') ||
                        p.includes('banned topic') ||
                        p.includes('politic') ||
                        p.includes('gossip') ||
                        p.includes('military')
                    ) {
                        step.params.prompt = `Based on the similarity scores, identify which items are clearly related to these topics: {{input:${queryInputName}}}. Return only a JSON array of the original indices for these items.`;
                    }
                }
                if (typeof step.params.criteria === 'string') {
                    const c = step.params.criteria.toLowerCase();
                    if (c.includes('politic') || c.includes('gossip') || c.includes('military') || c.includes('banned')) {
                        step.params.criteria = `Items semantically related to: {{input:${queryInputName}}}`;
                    }
                }
            }
        }

        return {
            plan: planCopy,
            inferredInputs,
            iterativeSemanticCleanup
        };
    },

    async _saveToolChainAsFunction(taskDescription, plan, currentUrl) {
        const nameBase = this._sanitizeFunctionName(taskDescription);
        const generatedFunctions = (typeof FunctionLibraryService !== 'undefined')
            ? await FunctionLibraryService.getAll()
            : ((await chrome.storage.local.get(['generatedFunctions'])).generatedFunctions || {});
        let name = nameBase;
        let suffix = 2;
        while (generatedFunctions[name]) {
            name = `${nameBase}${suffix}`;
            suffix++;
        }

        const chainPlanRaw = plan.plan || [];
        const parameterized = this._parameterizeToolChainPlan(taskDescription, chainPlanRaw);
        const chainPlan = parameterized.plan;
        const inferredInputs = parameterized.inferredInputs;
        const iterativeSemanticCleanup = parameterized.iterativeSemanticCleanup === true;
        const escapedPlan = JSON.stringify(chainPlan).replace(/\\/g, '\\\\').replace(/`/g, '\\`');
        const escapedExpected = String(plan.expectedOutput || 'Tool-chain output').replace(/\\/g, '\\\\').replace(/`/g, '\\`');
        const inputDefaults = inferredInputs.reduce((acc, input) => {
            acc[input.name] = input.defaultValue;
            return acc;
        }, {});
        const escapedInputDefaults = JSON.stringify(inputDefaults).replace(/\\/g, '\\\\').replace(/`/g, '\\`');
        const optionalInputNames = inferredInputs.map(i => i.name);
        const optionalInputsText = optionalInputNames.length > 0 ? optionalInputNames.join(', ') : 'none';

        const scriptPrelude = [
            `const plan = JSON.parse(\`${escapedPlan}\`);`,
            `const inputDefaults = JSON.parse(\`${escapedInputDefaults}\`);`,
            `const effectiveInputs = { ...inputDefaults, ...((inputs && typeof inputs === 'object') ? inputs : {}) };`,
            `const results = [];`,
            `const resolveToken = async (token) => {`,
            `  if (typeof token !== 'string') return token;`,
            `  const notepad = token.match(/^\\{\\{notepad:(\\w+)\\}\\}$/);`,
            `  if (notepad) return await page.readNotepad(notepad[1]);`,
            `  const input = token.match(/^\\{\\{input:(\\w+)\\}\\}$/);`,
            `  if (input) return effectiveInputs?.[input[1]];`,
            `  if (token === '{{tabId}}' || token === '{{apiKey}}') return undefined;`,
            `  return token;`,
            `};`,
            `const resolveStringRefs = async (str) => {`,
            `  if (typeof str !== 'string') return str;`,
            `  const fullResolved = await resolveToken(str);`,
            `  if (fullResolved !== str) {`,
            `    return fullResolved;`,
            `  }`,
            `  const tokenRegex = /\\{\\{notepad:(\\w+)\\}\\}|\\{\\{input:(\\w+)\\}\\}|\\{\\{tabId\\}\\}|\\{\\{apiKey\\}\\}/g;`,
            `  const matches = Array.from(str.matchAll(tokenRegex));`,
            `  if (matches.length === 0) return str;`,
            `  let out = str;`,
            `  for (const m of matches) {`,
            `    const token = m[0];`,
            `    const data = await resolveToken(token);`,
            `    const repl = typeof data === 'object' ? JSON.stringify(data) : String(data ?? '');`,
            `    out = out.split(token).join(repl);`,
            `  }`,
            `  return out;`,
            `};`,
            `const resolveRef = async (val) => {`,
            `  if (typeof val !== 'string') return val;`,
            `  return await resolveStringRefs(val);`,
            `};`,
            `const resolveDeep = async (obj) => {`,
            `  if (Array.isArray(obj)) {`,
            `    const out = [];`,
            `    for (const x of obj) out.push(await resolveDeep(x));`,
            `    return out;`,
            `  }`,
            `  if (obj && typeof obj === 'object') {`,
            `    const out = {};`,
            `    for (const [k, v] of Object.entries(obj)) out[k] = await resolveDeep(v);`,
            `    return out;`,
            `  }`,
            `  return await resolveRef(obj);`,
            `};`,
            `const runPlanPass = async (passNumber) => {`,
            `  let hiddenCountThisPass = 0;`,
            `  for (const step of plan) {`,
            `    const params = await resolveDeep(step.params || {});`,
            `    if (step.tool === 'remote_intelligence_api' && params.parseJson === undefined && typeof params.prompt === 'string') {`,
            `      const promptLower = params.prompt.toLowerCase();`,
            `      params.parseJson = /(?:valid\\s+)?json|json\\s+array|json\\s+object|return\\s+only\\s+json|strict\\s+json|reply\\s+with\\s+only/.test(promptLower);`,
            `    }`,
            `    let toolResult;`,
            `    try {`,
            `      toolResult = await page.useTool(step.tool, params);`,
            `    } catch (err) {`,
            `      toolResult = { success: false, error: err?.message || String(err) };`,
            `    }`,
            `    const emptyLocal = step.tool === 'local_ollama_model' && (toolResult?.result === null || toolResult?.result === undefined || (Array.isArray(params.items) && params.items.length > 0 && Array.isArray(toolResult?.result) && toolResult.result.length === 0));`,
            `    if (step.tool === 'local_ollama_model' && (toolResult?.success === false || toolResult?.fallback || toolResult?.error || emptyLocal)) {`,
            `      const fallbackPrompt = params.prompt || params.question || JSON.stringify(params);`,
            `      const localAction = String(params.action || params.task || '').toLowerCase();`,
            `      const expectsJson = ['filteritems', 'jsonextract', 'weightedscore'].includes(localAction) || (localAction === 'sentiment' && Array.isArray(params.items));`,
            `      try {`,
            `        toolResult = await page.useTool('remote_intelligence_api', { prompt: fallbackPrompt, parseJson: expectsJson });`,
            `        if (!expectsJson && typeof toolResult === 'string') {`,
            `          const trimmed = toolResult.trim();`,
            `          if (trimmed.startsWith('{') || trimmed.startsWith('[')) {`,
            `            try { toolResult = JSON.parse(trimmed); } catch {}`,
            `          }`,
            `        }`,
            `      } catch (fbErr) {`,
            `        toolResult = { success: false, error: fbErr?.message || String(fbErr) };`,
            `      }`,
            `    }`,
            `    if (toolResult?.success === false || toolResult?.error) {`,
            `      throw new Error(\`Step \${step.stepNumber} (\${step.tool}) failed: \${toolResult?.error || 'Unknown error'}\`);`,
            `    }`,
            `    if (step.storeAs) {`,
            `      const data = toolResult?.data ?? toolResult?.result ?? toolResult?.results ?? toolResult;`,
            `      await page.writeNotepad(step.storeAs, data);`,
            `    }`,
            `    if (step.tool === 'site_modifier') {`,
            `      const hiddenNow = Number(toolResult?.hidden ?? toolResult?.result?.hidden ?? 0);`,
            `      if (Number.isFinite(hiddenNow) && hiddenNow > 0) hiddenCountThisPass += hiddenNow;`,
            `    }`,
            `    results.push({ pass: passNumber, step: step.stepNumber, tool: step.tool, result: toolResult });`,
            `  }`,
            `  return hiddenCountThisPass;`,
            `};`
        ];

        const iterativeBlock = iterativeSemanticCleanup
            ? [
                `const passLimit = Math.max(1, Number(effectiveInputs.maxPasses || 5));`,
                `let passesRun = 0;`,
                `for (let pass = 1; pass <= passLimit; pass++) {`,
                `  passesRun = pass;`,
                `  const hiddenCount = await runPlanPass(pass);`,
                `  if (hiddenCount <= 0) break;`,
                `  await page.wait(400);`,
                `}`,
                `return { success: true, expectedOutput: \`${escapedExpected}\`, passesRun, steps: results };`
            ]
            : [
                `await runPlanPass(1);`,
                `return { success: true, expectedOutput: \`${escapedExpected}\`, steps: results };`
            ];

        const scriptCode = [
            ...scriptPrelude,
            ...iterativeBlock
        ].join('\n');

        const functionDef = {
            name,
            description: `Tool chain: ${taskDescription}\nHow to call: Run this function from the page matching urlPatterns. Optional inputs: ${optionalInputsText}.`,
            inputs: inferredInputs,
            outputs: {
                type: 'object',
                description: plan.expectedOutput || 'Tool chain execution results'
            },
            urlPatterns: this._resolveUrlPatterns(currentUrl),
            startUrl: currentUrl || null,
            steps: [
                {
                    type: 'script',
                    description: 'Execute saved multi-tool chain',
                    code: scriptCode
                }
            ],
            createdAt: Date.now(),
            source: 'tool-chain',
            toolChainPlan: chainPlan
        };

        generatedFunctions[name] = functionDef;
        if (typeof FunctionLibraryService !== 'undefined') {
            await FunctionLibraryService.setAll(generatedFunctions);
        } else {
            await chrome.storage.local.set({ generatedFunctions });
        }
        return { name, functionDef };
    }
};

if (typeof self !== 'undefined') self.ToolOrchestrator = ToolOrchestrator;
