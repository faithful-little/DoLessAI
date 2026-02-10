
// Vanilla JS AI Service (No Build Required)
const AIService = {
    API_BASE: 'https://generativelanguage.googleapis.com/v1beta',
    MODEL: 'gemini-3-flash-preview',

    // Rate Limiting State
    RATE_LIMIT_RPM: 5,
    requestTimestamps: [],
    _stopRequested: false,
    _stopReason: '',
    _activeControllers: new Set(),

    // ==================== TOOL DEFINITIONS ====================
    // These define all available step types for the AI-generated functions.
    // The AI must use these exact types and include all required fields.
    TOOL_DEFINITIONS: {
        navigate: {
            description: "Navigate browser to a URL. MUST be the first step.",
            required: ["url"],
            optional: ["timeout"],
            example: { type: "navigate", url: "https://mail.google.com/mail/u/0/#inbox", description: "Open Gmail inbox" }
        },
        click: {
            description: "Click on an element",
            required: ["selector"],
            optional: ["elementName", "timeout", "description"],
            example: { type: "click", selector: "div[role='row']", elementName: "Email Row", description: "Click email" }
        },
        type: {
            description: "Type text into an input field",
            required: ["selector", "value"],
            optional: ["elementName", "description"],
            example: { type: "type", selector: "input[name='q']", value: "{{searchQuery}}", description: "Enter search" }
        },
        pressKey: {
            description: "Press a keyboard key",
            required: ["key"],
            optional: ["selector", "description"],
            example: { type: "pressKey", key: "Enter", selector: "input[name='q']", description: "Submit search" }
        },
        scroll: {
            description: "Scroll page or element",
            required: [],
            optional: ["selector", "amount", "direction", "description"],
            example: { type: "scroll", direction: "down", amount: 300, description: "Scroll down" }
        },
        wait: {
            description: "Wait for element, text, or time",
            required: [],
            optional: ["selector", "timeout", "condition", "value", "description"],
            conditions: ["selector", "text", "time"],
            example: { type: "wait", selector: "div.loaded", timeout: 5000, description: "Wait for content" }
        },
        extract: {
            description: "Extract text from element",
            required: ["selector"],
            optional: ["pattern", "description"],
            example: { type: "extract", selector: "h1.title", description: "Get page title" }
        },
        script: {
            description: "Execute JavaScript code. Use for loops/complex logic. Has access to 'page' API and 'inputs' object.",
            required: ["code"],
            optional: ["description"],
            pageAPI: [
                "await page.click(selector)",
                "await page.type(selector, text)",
                "await page.pressKey(selector, key)",
                "await page.scroll(selectorOrAmount)",
                "await page.wait(selectorOrTime)",
                "await page.navigate(url)",
                "await page.extract(selector) // Returns innerText",
                "await page.extractAttribute(selector, attributeName) // Returns attribute value (e.g. 'href', 'src', 'data-id')",
                "await page.getElements(selector) // Returns array of selectors for looping",
                "await page.log(message)",
                "await page.executeFunction(name, inputs) // Call another saved function as sub-routine",
                "await page.smartScrape(description) // Invoke agentic scraper to extract structured data from current page",
                "// --- Tool System APIs ---",
                "await page.writeNotepad(key, data) // Write data to shared session notepad",
                "await page.readNotepad(key) // Read data from shared session notepad",
                "await page.getCurrentTabContent(maxChars) // Snapshot current tab URL/title/headings/body text preview",
                "await page.generatePage(dataset, templateType, options) // Generate HTML dashboard ('card-grid'|'comparison-table'|'timeline'|'summary')",
                "await page.modifySite(action, params) // Modify active page: 'hideElements'|'highlightElements'|'filterContent'|'injectCSS'",
                "await page.downloadFile(data, format, filename) // Save data as file ('csv'|'json'|'md'|'html'|'txt')",
                "await page.embedText(text, options) // Generate embedding vector for semantic similarity",
                "await page.askOllama(prompt, options) // Query local Ollama LLM (returns null if unavailable)",
                "await page.savePersistent(key, data) // Save data persistently across sessions",
                "await page.loadPersistent(key) // Load persistent data by key"
            ],
            loopExample: `{
  type: "script",
  description: "Process first N emails",
  code: \`
    const items = await page.getElements('.email-row');
    const max = Math.min(items.length, inputs.maxEmails || 5);
    for (let i = 0; i < max; i++) {
      await page.click(items[i]);
      await page.wait(1000);
    }
  \`
}`
        },
        smartScrape: {
            description: "Invoke AI-powered agentic scraper to extract structured data from the current page. Use when you need to extract repeating list/grid items from the page. Returns array of extracted objects.",
            required: [],
            optional: ["description", "returnAs"],
            example: { type: "smartScrape", description: "Extract product listings with title, price, and URL", returnAs: "products" },
            note: "This step takes a screenshot, analyzes the page visually, and creates an extraction function automatically. Use when recording involves data extraction from lists/tables/grids."
        }
    },

    // ==================== SMART SCRAPE TOOL DECLARATIONS ====================
    // These define the tools available to the agentic scraping loop via Gemini function calling.
    // Uses structured extraction (selector-based) to avoid CSP issues with eval/new Function.
    SCRAPE_TOOL_DECLARATIONS: [
        {
            name: "getPageContentSnapshot",
            description: "Get a direct text snapshot of the CURRENT tab without navigating: URL, title, headings, and a truncated body text preview. Use this first when page context is unclear.",
            parameters: {
                type: "OBJECT",
                properties: {
                    maxChars: {
                        type: "NUMBER",
                        description: "Maximum body text characters to return (default 6000, max 12000)."
                    }
                }
            }
        },
        {
            name: "searchPageForText",
            description: "Search the page for specific text phrases. Returns matching DOM elements with CSS selectors, parent context, and repeating ancestor info (the list container that wraps each item). IMPORTANT: Search for phrases from DIFFERENT entity types at once (e.g. a title, a price, AND a rating) to get a complete picture of the DOM structure in one call.",
            parameters: {
                type: "OBJECT",
                properties: {
                    phrases: {
                        type: "ARRAY",
                        items: { type: "STRING" },
                        description: "Text phrases to search for. Include phrases from DIFFERENT fields (title, price, rating, etc.) and from DIFFERENT items in the list. 4-8 phrases recommended for comprehensive results."
                    }
                },
                required: ["phrases"]
            }
        },
        {
            name: "runStructuredExtraction",
            description: "Extract data from repeating elements using CSS selectors. Finds all elements matching containerSelector, then extracts each field from within each container. Returns the extracted array of objects. This uses safe DOM APIs (no eval) so it works on all pages regardless of CSP.",
            parameters: {
                type: "OBJECT",
                properties: {
                    containerSelector: {
                        type: "STRING",
                        description: "CSS selector for the repeating container elements (e.g. '[data-component-type=\"s-search-result\"]', '.product-card', 'tr.result-row'). Each match becomes one item in the output array."
                    },
                    fields: {
                        type: "ARRAY",
                        items: {
                            type: "OBJECT",
                            properties: {
                                name: {
                                    type: "STRING",
                                    description: "Field name in the output object (e.g. 'title', 'price', 'rating', 'url', 'imageUrl')"
                                },
                                selector: {
                                    type: "STRING",
                                    description: "CSS selector relative to the container (e.g. 'h2 span', '.a-price .a-offscreen', 'a.product-link')"
                                },
                                extractType: {
                                    type: "STRING",
                                    description: "What to extract: 'text' for innerText, 'attribute' for an HTML attribute value"
                                },
                                attributeName: {
                                    type: "STRING",
                                    description: "Only needed when extractType is 'attribute'. The attribute to read (e.g. 'href', 'src', 'data-price')"
                                }
                            },
                            required: ["name", "selector", "extractType"]
                        },
                        description: "Array of field definitions. Each field specifies what data to extract from each container."
                    }
                },
                required: ["containerSelector", "fields"]
            }
        },
        {
            name: "saveAsFunction",
            description: "Save the working extraction config as a reusable function. Only call AFTER runStructuredExtraction returned correct results.",
            parameters: {
                type: "OBJECT",
                properties: {
                    name: {
                        type: "STRING",
                        description: "CamelCase function name (e.g. 'ScrapeAmazonSearchResults')"
                    },
                    description: {
                        type: "STRING",
                        description: "What this function extracts"
                    },
                    containerSelector: {
                        type: "STRING",
                        description: "The container selector that worked"
                    },
                    fields: {
                        type: "ARRAY",
                        items: {
                            type: "OBJECT",
                            properties: {
                                name: { type: "STRING" },
                                selector: { type: "STRING" },
                                extractType: { type: "STRING" },
                                attributeName: { type: "STRING" }
                            },
                            required: ["name", "selector", "extractType"]
                        },
                        description: "The field definitions that worked"
                    },
                    outputs: {
                        type: "STRING",
                        description: "Description of output structure (e.g. 'Array of {title, price, url, rating}')"
                    }
                },
                required: ["name", "description", "containerSelector", "fields", "outputs"]
            }
        }
    ],

    /**
     * Enforce Rate Limit (Sliding Window)
     */
    async checkRateLimit() {
        const now = Date.now();
        const sixtySecondsAgo = now - 60000;

        // Filter out old timestamps
        this.requestTimestamps = this.requestTimestamps.filter(t => t > sixtySecondsAgo);

        if (this.requestTimestamps.length >= this.RATE_LIMIT_RPM) {
            // Calculate wait time: time until the oldest request expires
            const oldest = this.requestTimestamps[0];
            const waitTime = (oldest + 60000) - now + 1000; // +1s buffer

            console.warn(`â³ Rate limit reached (${this.RATE_LIMIT_RPM} rpm). Waiting ${Math.ceil(waitTime / 1000)}s...`);

            // Wait
            await new Promise(resolve => setTimeout(resolve, waitTime));

            // Recursive check in case multiple queued up
            return this.checkRateLimit();
        }

        this.requestTimestamps.push(Date.now());
    },

    requestStopAllRequests(reason = 'Stopped by user') {
        this._stopRequested = true;
        this._stopReason = reason || 'Stopped by user';
        for (const controller of this._activeControllers) {
            try { controller.abort(); } catch {}
        }
        this._activeControllers.clear();
    },

    clearStopRequest() {
        this._stopRequested = false;
        this._stopReason = '';
    },

    _extractJsonFromText(rawText) {
        const text = String(rawText || '').trim();
        if (!text) throw new Error('AI returned empty JSON text');

        const candidates = [text];
        const fenceMatch = text.match(/```json\s*([\s\S]*?)\s*```/i) || text.match(/```\s*([\s\S]*?)\s*```/i);
        if (fenceMatch?.[1]) candidates.push(fenceMatch[1].trim());

        const objectStart = text.indexOf('{');
        const objectEnd = text.lastIndexOf('}');
        if (objectStart !== -1 && objectEnd > objectStart) {
            candidates.push(text.slice(objectStart, objectEnd + 1).trim());
        }

        const arrayStart = text.indexOf('[');
        const arrayEnd = text.lastIndexOf(']');
        if (arrayStart !== -1 && arrayEnd > arrayStart) {
            candidates.push(text.slice(arrayStart, arrayEnd + 1).trim());
        }

        let lastError = null;
        for (const candidate of candidates) {
            try {
                return JSON.parse(candidate);
            } catch (e) {
                lastError = e;
            }
        }

        throw lastError || new Error('Invalid JSON response');
    },

    _patternToRegex(pattern) {
        const raw = String(pattern || '').trim();
        if (!raw) return null;
        try {
            const escaped = raw
                .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
                .replace(/\*/g, '.*');
            return new RegExp(`^${escaped}$`, 'i');
        } catch {
            return null;
        }
    },

    _urlMatchesPatterns(url, patterns = []) {
        if (!url || !Array.isArray(patterns) || patterns.length === 0) return true;
        return patterns.some(pattern => {
            if (!pattern) return false;
            if (pattern === '<all_urls>' || pattern === '*://*/*' || pattern === 'http://*/*' || pattern === 'https://*/*') {
                return true;
            }
            const rx = this._patternToRegex(pattern);
            return rx ? rx.test(url) : false;
        });
    },

    _coerceBoolean(value, fallback = false) {
        if (typeof value === 'boolean') return value;
        if (typeof value === 'number') return value !== 0;
        if (typeof value === 'string') {
            const normalized = value.trim().toLowerCase();
            if (['true', '1', 'yes', 'y'].includes(normalized)) return true;
            if (['false', '0', 'no', 'n'].includes(normalized)) return false;
        }
        return fallback;
    },

    _coerceNumber(value, fallback = 1) {
        const n = Number(value);
        return Number.isFinite(n) ? n : fallback;
    },

    _defaultInputValue(inputDef, testIndex = 0, functionDef = null) {
        const def = inputDef || {};
        const rawDefault = def.defaultValue;
        const type = String(def.type || 'string').toLowerCase();
        const name = String(def.name || '').toLowerCase();

        if (rawDefault !== undefined && rawDefault !== null && String(rawDefault).trim() !== '') {
            if (type === 'number') return this._coerceNumber(rawDefault, 1);
            if (type === 'boolean') return this._coerceBoolean(rawDefault, true);
            return String(rawDefault);
        }

        if (type === 'number') {
            const presets = [3, 5, 1];
            return presets[testIndex % presets.length];
        }
        if (type === 'boolean') {
            return testIndex % 2 === 0;
        }

        if (name.includes('url')) {
            const patterns = Array.isArray(functionDef?.urlPatterns) ? functionDef.urlPatterns : [];
            const firstUrlPattern = patterns.find(p => /^https?:\/\//i.test(String(p || '')));
            if (firstUrlPattern) {
                const trimmed = firstUrlPattern.replace(/\*.*$/, '').trim();
                if (trimmed) return trimmed;
            }
            return 'https://example.com';
        }
        if (name.includes('query') || name.includes('search') || name.includes('keyword')) {
            const variants = ['test', 'mechanical keyboard', 'wireless mouse'];
            return variants[testIndex % variants.length];
        }
        return 'test';
    },

    _normalizeTestUrl(rawUrl, functionDef = null) {
        if (typeof rawUrl !== 'string') return '';
        let candidate = rawUrl.trim();
        if (!candidate) return '';

        try {
            let parsed = new URL(candidate);
            const isAmazon = /(^|\.)amazon\./i.test(parsed.hostname);

            if (isAmazon && (parsed.pathname.includes('/sspa/click') || parsed.pathname.includes('/gp/slredirect'))) {
                const embedded = parsed.searchParams.get('url');
                if (embedded) {
                    const decoded = decodeURIComponent(embedded);
                    const absolute = decoded.startsWith('http')
                        ? decoded
                        : `${parsed.origin}${decoded.startsWith('/') ? decoded : `/${decoded}`}`;
                    parsed = new URL(absolute);
                } else {
                    return '';
                }
            }

            if (isAmazon) {
                const dpMatch = parsed.pathname.match(/\/dp\/([A-Z0-9]{10})/i)
                    || parsed.pathname.match(/\/gp\/product\/([A-Z0-9]{10})/i);
                if (dpMatch?.[1]) {
                    candidate = `${parsed.origin}/dp/${dpMatch[1].toUpperCase()}`;
                } else {
                    parsed.hash = '';
                    candidate = parsed.toString();
                }
            } else {
                parsed.hash = '';
                candidate = parsed.toString();
            }
        } catch {
            return '';
        }

        const patterns = Array.isArray(functionDef?.urlPatterns) ? functionDef.urlPatterns : [];
        if (!this._urlMatchesPatterns(candidate, patterns)) {
            return '';
        }
        return candidate;
    },

    _normalizeGeneratedTestInputs(rawInputs, functionDef, testIndex = 0) {
        const inputDefs = Array.isArray(functionDef?.inputs) ? functionDef.inputs : [];
        const source = (rawInputs && typeof rawInputs === 'object') ? rawInputs : {};
        const normalized = {};

        for (const def of inputDefs) {
            if (!def?.name) continue;
            const type = String(def.type || 'string').toLowerCase();
            const lowerName = String(def.name).toLowerCase();
            const fallback = this._defaultInputValue(def, testIndex, functionDef);
            let value = Object.prototype.hasOwnProperty.call(source, def.name) ? source[def.name] : fallback;

            if (type === 'number') {
                value = this._coerceNumber(value, this._coerceNumber(fallback, 1));
            } else if (type === 'boolean') {
                value = this._coerceBoolean(value, this._coerceBoolean(fallback, true));
            } else {
                value = value === undefined || value === null ? '' : String(value).trim();
                if (!value) value = String(fallback);
                if (lowerName.includes('url')) {
                    const preferredDefaultUrl = this._normalizeTestUrl(String(def.defaultValue || ''), functionDef);
                    if (preferredDefaultUrl) {
                        value = preferredDefaultUrl;
                    } else {
                        const normalizedUrl = this._normalizeTestUrl(value, functionDef);
                        if (normalizedUrl) {
                            value = normalizedUrl;
                        } else {
                            const fallbackUrl = this._normalizeTestUrl(String(fallback || ''), functionDef);
                            value = fallbackUrl || String(fallback || 'https://example.com');
                        }
                    }
                }
            }

            normalized[def.name] = value;
        }

        if (inputDefs.length === 0) {
            return source;
        }
        return normalized;
    },

    _buildFallbackTestCases(functionDef) {
        const labels = ['Baseline', 'Variation A', 'Variation B'];
        const cases = [];

        for (let i = 0; i < 3; i++) {
            const inputs = this._normalizeGeneratedTestInputs({}, functionDef, i);
            cases.push({
                name: `${labels[i]} Test`,
                inputs,
                expectedOutcome: 'Function runs successfully and returns usable output'
            });
        }

        return cases;
    },

    /**
     * Format recording data efficiently for AI consumption
     */
    formatRecordingForAI(recording, userNotes = []) {
        const steps = recording.steps.map((step, index) => {
            const formattedStep = {
                stepNumber: index + 1,
                action: step.action,
                elementName: step.elementName || null,
                selector: step.selector || null,
                value: step.value || null,
                url: step.url || null
            };

            // Include rich element context if available (much more useful than raw HTML)
            if (step.elementContext) {
                formattedStep.elementContext = {
                    // Basic identification
                    tagName: step.elementContext.tagName,
                    id: step.elementContext.id,
                    className: step.elementContext.className,

                    // All attributes for selector building
                    attributes: step.elementContext.attributes,

                    // Text content for identification
                    innerText: step.elementContext.innerText,
                    value: step.elementContext.value,
                    placeholder: step.elementContext.placeholder,

                    // Accessibility (great for robust selectors)
                    role: step.elementContext.role,
                    ariaLabel: step.elementContext.ariaLabel,

                    // Link URL (if this element is a link)
                    href: step.elementContext.href,

                    // Parent hierarchy (for context and fallback selectors)
                    ancestors: step.elementContext.ancestors,

                    // Sibling context (for nth-child patterns)
                    siblings: step.elementContext.siblings,

                    // Nearby text for semantic context
                    nearbyText: step.elementContext.nearbyText
                };

                // Include list item container info (the repeating container like ytd-video-renderer)
                if (step.elementContext.listItemContainer) {
                    formattedStep.listItemContainer = {
                        tagName: step.elementContext.listItemContainer.tagName,
                        selector: step.elementContext.listItemContainer.selector,
                        // Include truncated HTML for pattern matching
                        outerHTML: step.elementContext.listItemContainer.outerHTML
                            ? step.elementContext.listItemContainer.outerHTML.substring(0, 3000)
                            : null
                    };

                    // CRITICAL: Include all child elements with their selectors
                    // This tells the AI exactly what selectors are available inside the container
                    formattedStep.containerChildElements = step.elementContext.containerChildElements;
                } else if (step.elementContext.containerHTML) {
                    // Fallback to container HTML
                    formattedStep.containerHTML = step.elementContext.containerHTML.substring(0, 1500);
                }
            } else if (step.html) {
                // Fallback: Include HTML snippet if no element context (legacy steps)
                formattedStep.htmlSnippet = step.html.substring(0, 2000);
            }

            if (step.action === 'text_annotation') formattedStep.noteText = step.text;
            if (step.action === 'audio_annotation') formattedStep.noteText = step.transcription || '[Audio Note]';

            return formattedStep;
        });

        return {
            steps,
            userNotes,
            startUrl: steps.length > 0 ? steps[0].url : null,
            totalSteps: steps.length
        };
    },

    /**
     * Build the system prompt with clear tool definitions
     * @param {string} startUrl - The starting URL from the recording
     * @param {Array} referenceFunctions - Optional array of existing functions to include as context
     */
    buildSystemPrompt(startUrl = null, referenceFunctions = []) {
        const toolDocs = Object.entries(this.TOOL_DEFINITIONS).map(([name, def]) => {
            const required = def.required.length > 0 ? `Required: ${def.required.join(', ')}` : 'No required fields';
            const optional = def.optional.length > 0 ? `Optional: ${def.optional.join(', ')}` : '';
            return `- ${name}: ${def.description}\n    ${required}${optional ? '\n    ' + optional : ''}`;
        }).join('\n');

        const pageAPIDocs = this.TOOL_DEFINITIONS.script.pageAPI.join('\n    ');

        let prompt = `You are an expert automation engineer.
        
GOAL: Convert user recording steps into a robust, reusable automation function.

CRITICAL RULES:
1. **First step MUST be 'navigate'** with the startUrl: "${startUrl || 'URL_FROM_RECORDING'}"
2. **Use exact step types**: navigate, click, type, pressKey, scroll, wait, extract, script
3. **Required fields must be present** - see tool definitions below
4. **For loops/iteration**: Use 'script' step with page.getElements(), NOT a 'loop' step
5. **Inputs**: Use {{inputName}} syntax for parameterized values

AVAILABLE STEP TYPES:
${toolDocs}

SCRIPT STEP - PAGE API:
When using 'script' type, you have access to 'page' object and 'inputs' object:
    ${pageAPIDocs}

ELEMENT CONTEXT DATA:
Each recorded step includes rich context about the element AND its container:

**Element-Level Data (elementContext):**
- tagName, id, className, attributes, href
- innerText, value, placeholder (text content)
- role, ariaLabel (accessibility - great for selectors)
- ancestors (parent hierarchy up to 5 levels)
- siblings (for nth-child patterns)

**Container-Level Data (CRITICAL for list items):**
- **listItemContainer**: The repeating container (e.g., ytd-video-renderer, article, [role=listitem])
  - tagName, selector: How to select all items of this type
- **containerChildElements**: Array of ALL important child elements inside this container
  - Each child has: selector, tagName, id, className, text, href, src, ariaLabel

USE THIS CONTEXT TO BUILD ROBUST SELECTORS:
1. Prefer selectors from containerChildElements when available.
2. Use extractAttribute for URL/media fields and extract for visible text.
3. Prefer stable attributes (id, data-testid, aria-label) over fragile class chains.

smartScrape vs script:
- Prefer smartScrape for list/grid/table extraction.
- Use script for simple one-off actions or control flow.
`;

        // Add reference functions context if provided
        if (referenceFunctions && referenceFunctions.length > 0) {
            prompt += `

AVAILABLE FUNCTIONS FOR REUSE:
The following ${referenceFunctions.length} function(s) already exist and operate on similar URLs.
You may CALL them using: await page.executeFunction('FunctionName', { input1: value1 })
Or use their implementation as a PATTERN for similar logic.

${referenceFunctions.map(f => `
â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”
FUNCTION: ${f.name}
DESCRIPTION: ${f.description || 'No description'}
URL PATTERNS: ${(f.urlPatterns || []).join(', ')}
INPUTS: ${JSON.stringify(f.inputs || [], null, 2)}
OUTPUTS: ${JSON.stringify(f.outputs || {}, null, 2)}
STEPS: ${JSON.stringify(f.steps || [], null, 2)}
â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”
`).join('\n')}

GUIDELINES FOR FUNCTION COMPOSITION:
- If the new task can be COMPOSED from existing functions, CALL them with page.executeFunction()
- If you need SIMILAR logic, reference their selector patterns and approach
- You may call multiple functions in sequence or within script loops
- Orchestration functions can call multiple sub-functions to complete complex workflows
- Always pass the correct inputs that the sub-function expects
- The result of page.executeFunction() is the return value of that function
- IMPORTANT: Do NOT overwrite an existing function's behavior/name unless explicitly asked.
  If adapting an existing function, create a NEW function name (e.g., ExistingNameV2 / ExistingNameForNews).
`;
        }

        return prompt;
    },

    /**
     * Step 1: Analyze recording and generate spec
     */
    async analyzeRecording(recording, userNotes, apiKey, settings = {}) {
        const { referenceFunctions = [] } = settings;
        const formattedData = this.formatRecordingForAI(recording, userNotes);
        const schema = {
            type: "OBJECT",
            properties: {
                analysis: {
                    type: "OBJECT",
                    properties: {
                        name: { type: "STRING", description: "CamelCase function name" },
                        description: { type: "STRING" },
                        logicExplanation: { type: "STRING", description: "Plain text explanation of how the function will work (e.g. 'I will loop through...')" },
                        urlPatterns: { type: "ARRAY", items: { type: "STRING" } },
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
                        usesReferenceFunctions: {
                            type: "ARRAY",
                            items: { type: "STRING" },
                            description: "Names of reference functions this will call (if any)"
                        },
                        requiresSmartScrape: {
                            type: "BOOLEAN",
                            description: "MUST be true if this function extracts data from a list/grid of repeating items (e.g. product listings, search results, table rows). When true, the implementation MUST use a 'smartScrape' step instead of manual script extraction."
                        }
                    },
                    required: ["name", "description", "logicExplanation", "inputs", "outputs", "requiresSmartScrape"]
                }
            },
            required: ["analysis"]
        };

        const isRepairMode = userNotes && JSON.stringify(userNotes).includes("Verification failed");

        let prompt;
        if (isRepairMode) {
            prompt = `You are an expert automation engineer specializing in DEBUGGING and REPAIRING.
            GOAL: Analyze the failed attempt and the original recording to design a FIXED automation function.
            
            CONTEXT:
            The previous attempt failed verification.
            ERROR LOGS: ${JSON.stringify(userNotes)}
            
            YOUR TASK:
            1. Analyze the errors (e.g., Timeout, Element Not Found).
            2. Adjust the function design to handle these cases.
               - If Timeout: Suggest simpler logic, less waiting, or more efficient selectors.
               - If Element Not Found: Suggest alternative selectors or logic.
            3. Preserve the core intent but make it ROBUST.
            
            CRITICAL REQUIREMENT:
            The function MUST return useful output data for downstream workflows.
            - NEVER return "void".
            - If scraping: Return an array of objects or strings.
            - If actions: Return a status object or screenshot.
            
            Define the inputs, outputs, and logic explanation for the FIXED function.
            `;
        } else {
            prompt = `You are an expert automation engineer.
            GOAL: Analyze this user recording and design a reusable automation function.
            
            CRITICAL REQUIREMENTS:
            1. The function MUST return useful output data for downstream workflows.
               - NEVER return "void" or empty results.
               - If scraping: Return an array of objects with ALL extracted fields.
               - If performing actions: Return a status object with actionable info.
            
            2. ELEMENT IDENTIFIERS (only for NON-smartScrape functions):
               - If requiresSmartScrape is true, do NOT include "selector" in the output schema.
                 SmartScrape handles extraction automatically and does not produce element selectors.
               - If requiresSmartScrape is false, include "selector" or "elementIndex" alongside data.
               - Example (non-smartScrape): { title: "Product", price: "$10", selector: "div.product:nth-child(3)" }
            
            3. DESIGN MODULAR FUNCTIONS:
               - Prefer small, focused, reusable functions over large monolithic ones.
               - A complex task should be broken into: Search, Evaluate, Select, Act.
               - Each function does ONE thing well and returns data for the next.
            
            4. USE 'smartScrape' FOR DATA EXTRACTION (CRITICAL - DO NOT USE MANUAL SCRIPT EXTRACTION):
               - Set requiresSmartScrape=true if ANY of these are true:
                 a) The recording shows HOVER actions on list/grid items (products, search results, table rows, cards)
                 b) User annotations mention "scrape", "extract", "get all", "list", "data"
                 c) listItemContainer info is present in the element context
                 d) The function needs to return an array of items extracted from a page
               - When requiresSmartScrape=true, the implementation MUST use a 'smartScrape' step
               - NEVER use a 'script' step with page.getElements()/page.extract() loops for list extraction
               - The smartScrape step uses an AI-powered iterative scraper that discovers correct selectors automatically
               - Manual script extraction (getElements + extract) is FRAGILE and often returns null values
               - Example: { type: "smartScrape", description: "Extract product listings with title, price, and URL", returnAs: "products" }
            
            PERFORMANCE GUIDELINES:
            - AVOID hardcoded waits (e.g. wait(5000)) by default.
            - PREFER 'wait' with a selector (e.g. wait('div.result')) which is faster and cleaner.
            - Only wait for time if necessary for animations.
            
            SELECTOR ROBUSTNESS:
            - Use multiple fallback selectors if possible (try ID, then class, then structure).
            - Test that selectors return values, not null.
            - For extraction: if a selector might be empty, handle it gracefully.
            
            YOUR TASK:
            1. Identify the core intent (e.g. "Search Products", "Extract Item Details").
            2. Define the inputs needed (e.g. "searchQuery", "maxCount").
            3. Define the output format with element identifiers for follow-up actions.
            4. Explain the logic in plain English.
            5. If extraction from lists is needed, recommend using 'smartScrape' step.
            `;
        }

        // Add reference functions note if available
        if (referenceFunctions.length > 0) {
            prompt += `\n\nREFERENCE FUNCTIONS AVAILABLE:\n${referenceFunctions.length} related function(s) already exist for this site: ${referenceFunctions.map(f => f.name).join(', ')}.\nConsider whether this recording should CALL existing functions using page.executeFunction() or create new logic.\nIf composing from existing functions, list them in 'usesReferenceFunctions'.\nDO NOT reuse an existing function name for the new function unless the user explicitly requested an update.`;
        }

        const requestBody = {
            contents: [{
                role: 'user',
                parts: [{
                    text: prompt + `\n\nRecording: ${JSON.stringify(formattedData)}\nNotes: ${JSON.stringify(userNotes)}`
                }]
            }],
            generationConfig: {
                responseMimeType: 'application/json',
                responseJsonSchema: schema,
                maxOutputTokens: 8192
            }
        };

        return await this.callGemini(requestBody, apiKey);
    },

    /**
     * Step 2: Generate technical steps based on analysis
     */
    async generateFunctionSteps(recording, analysis, userNotes, apiKey, settings = {}) {
        const { referenceFunctions = [] } = settings;
        // Get startUrl from recording
        const formattedRecording = this.formatRecordingForAI(recording);
        const startUrl = formattedRecording.startUrl;

        // Schema for steps - NO LOOP, use script for iteration
        const schema = {
            type: "OBJECT",
            properties: {
                implementation: {
                    type: "OBJECT",
                    properties: {
                        startUrl: { type: "STRING", description: "The starting URL from recording" },
                        steps: {
                            type: "ARRAY",
                            items: {
                                type: "OBJECT",
                                properties: {
                                    type: { type: "STRING", enum: ["click", "type", "pressKey", "scroll", "wait", "navigate", "extract", "script", "smartScrape"] },
                                    selector: { type: "STRING" },
                                    elementName: { type: "STRING" },
                                    value: { type: "STRING" },
                                    key: { type: "STRING" },
                                    url: { type: "STRING" },
                                    timeout: { type: "INTEGER" },
                                    description: { type: "STRING" },
                                    condition: { type: "STRING", description: "For wait: 'selector', 'text', or 'time'" },
                                    amount: { type: "INTEGER", description: "For scroll: pixels to scroll" },
                                    direction: { type: "STRING", description: "For scroll: 'up' or 'down'" },
                                    code: { type: "STRING", description: "For script: JavaScript code using page API" },
                                    returnAs: { type: "STRING", description: "For smartScrape: variable name to store extracted data (e.g. 'products', 'results')" }
                                },
                                required: ["type", "description"]
                            }
                        }
                    },
                    required: ["steps", "startUrl"]
                }
            },
            required: ["implementation"]
        };

        const isRepairMode = userNotes && JSON.stringify(userNotes).includes("Verification failed");

        let prompt;
        if (isRepairMode) {
            prompt = this.buildSystemPrompt(startUrl, referenceFunctions) +
                `\n\nCONTEXT: You are REPAIRING a function that failed verification.` +
                `\n\nANALYSIS OF FIX: ${JSON.stringify(analysis)}` +
                `\n\nERROR LOGS: ${JSON.stringify(userNotes)}` +
                `\n\nTASK: Generate the FIXED execution STEPS. Address the specific errors reported.` +
                `\n- If "Value is unserializable": Ensure optional arguments in page API calls are null, not undefined.` +
                `\n- If "Element not found": Use more robust selectors or different logic.` +
                `\n- If "Timeout": Reduce waits or optimize loops.` +
                `\n\nIMPORTANT: Maintain the Extract/Return logic.`;
        } else {
            prompt = this.buildSystemPrompt(startUrl, referenceFunctions) +
                `\n\nCONTEXT: You have analyzed the recording and produced this spec: ${JSON.stringify(analysis)}` +
                `\n\nTASK: Now generate the actual execution STEPS to implement this. REMEMBER: First step MUST be navigate with url: "${startUrl}"` +
                `\n\nIMPORTANT: You MUST implement the Extract/Return logic defined in the spec. If the output is an array of items, your script step must COLLECT that data and return it.`;

            // If analysis flagged smartScrape, add strong instruction
            if (analysis.requiresSmartScrape) {
                prompt += `\n\nCRITICAL - SMART SCRAPE REQUIRED:
The analysis determined this function requires data extraction from a list/grid of items.
You MUST use a 'smartScrape' step for the extraction part. DO NOT use a 'script' step with page.getElements()/page.extract() loops.

CORRECT: { "type": "smartScrape", "description": "Extract product listings with title, price, rating, and URL", "returnAs": "products" }
WRONG: { "type": "script", "code": "const items = await page.getElements(...); for (...) { await page.extract(...) }" }

The smartScrape step invokes an AI-powered iterative scraper that discovers correct selectors automatically.
Manual script extraction is fragile and returns null values. Use smartScrape instead.`;
            }
        }

        const requestBody = {
            contents: [{
                role: 'user',
                parts: [{
                    text: prompt + `\n\nRecording: ${JSON.stringify(formattedRecording.steps)}`
                }]
            }],
            generationConfig: {
                responseMimeType: 'application/json',
                responseJsonSchema: schema,
                maxOutputTokens: 8192
            }
        };

        return await this.callGemini(requestBody, apiKey);
    },

    async callGemini(requestBody, apiKey, parseJson = true, options = {}) {
        // Enforce Client-Side Rate Limit
        await this.checkRateLimit();

        const requestedModel = typeof options?.model === 'string' ? options.model.trim() : '';
        const modelToUse = requestedModel || this.MODEL;
        const maxRetries = Number.isInteger(options?.maxRetries) && options.maxRetries > 0 ? options.maxRetries : 3;
        const allowJsonTokenExpansion = options?.allowJsonTokenExpansion !== false;
        const maxOutputTokensCap = Number.isFinite(Number(options?.maxOutputTokensCap))
            ? Math.max(2048, Math.floor(Number(options.maxOutputTokensCap)))
            : 24576;
        const mutableRequestBody = JSON.parse(JSON.stringify(requestBody || {}));
        if (
            mutableRequestBody?.generationConfig
            && typeof mutableRequestBody.generationConfig === 'object'
            && mutableRequestBody.generationConfig.responseJsonSchema
            && !mutableRequestBody.generationConfig.responseSchema
        ) {
            // Gemini REST uses responseSchema. Keep responseJsonSchema for backward compatibility.
            mutableRequestBody.generationConfig.responseSchema = mutableRequestBody.generationConfig.responseJsonSchema;
        }
        let retryCount = 0;
        let responseSchemaFallbackApplied = false;

        while (retryCount < maxRetries) {
            let controller = null;
            try {
                if (this._stopRequested) {
                    throw new Error(this._stopReason || 'Stopped by user');
                }

                const promptParts = [];
                const requestContents = Array.isArray(mutableRequestBody?.contents) ? mutableRequestBody.contents : [];
                for (const content of requestContents) {
                    const role = content?.role || 'unknown';
                    const parts = Array.isArray(content?.parts) ? content.parts : [];
                    for (const part of parts) {
                        if (typeof part?.text === 'string') {
                            promptParts.push({ role, text: part.text });
                        }
                    }
                }

                const requestBodyForLog = JSON.parse(JSON.stringify(mutableRequestBody || {}));
                if (Array.isArray(requestBodyForLog?.contents)) {
                    for (const content of requestBodyForLog.contents) {
                        if (!Array.isArray(content?.parts)) continue;
                        for (const part of content.parts) {
                            if (part?.inlineData?.data) {
                                const byteLen = Math.round((part.inlineData.data.length * 3) / 4);
                                part.inlineData.data = `[base64 omitted, ~${byteLen} bytes]`;
                            }
                            if (part?.inline_data?.data) {
                                const byteLen = Math.round((part.inline_data.data.length * 3) / 4);
                                part.inline_data.data = `[base64 omitted, ~${byteLen} bytes]`;
                            }
                        }
                    }
                }

                console.log(`[AI Request] Sending request to ${modelToUse} (attempt ${retryCount + 1})...`);
                const fullPromptText = promptParts.map((p, idx) => `[[part ${idx + 1} role=${p.role}]]\n${p.text}`).join('\n\n');
                console.log(`[AI Request] Full text prompt parts JSON:\n${JSON.stringify(promptParts, null, 2)}`);
                console.log(`[AI Request] Full text prompt merged:\n${fullPromptText}`);
                console.log(`[AI Request] Full request body JSON:\n${JSON.stringify(requestBodyForLog, null, 2)}`);
                controller = new AbortController();
                this._activeControllers.add(controller);
                const response = await fetch(
                    `${this.API_BASE}/models/${modelToUse}:generateContent?key=${apiKey}`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(mutableRequestBody),
                        signal: controller.signal
                    }
                );

                if (response.status === 503 || response.status === 429) {
                    const waitTime = Math.pow(2, retryCount) * 2000 + (Math.random() * 1000);
                    console.warn(`Server error (${response.status}). Retrying in ${Math.round(waitTime)}ms...`);
                    await new Promise(r => setTimeout(r, waitTime));
                    retryCount++;
                    continue;
                }

                if (!response.ok) {
                    let message = `API error: ${response.status}`;
                    try {
                        const error = await response.json();
                        message = error.error?.message || message;
                    } catch {
                        const errorText = await response.text();
                        if (errorText) message = `${message} - ${errorText.slice(0, 300)}`;
                    }

                    const usesResponseSchema =
                        !!mutableRequestBody?.generationConfig
                        && Object.prototype.hasOwnProperty.call(mutableRequestBody.generationConfig, 'responseSchema');
                    const isResponseSchemaError =
                        response.status === 400
                        && /generation_config\.response_schema|response_schema/i.test(String(message || ''));

                    if (usesResponseSchema && isResponseSchemaError && !responseSchemaFallbackApplied) {
                        delete mutableRequestBody.generationConfig.responseSchema;
                        responseSchemaFallbackApplied = true;
                        console.warn('[AI Request] Gemini rejected response_schema; retrying with responseJsonSchema only.');
                        continue;
                    }

                    throw new Error(message);
                }

                const result = await response.json();
                if (!result.candidates || !result.candidates[0] || !result.candidates[0].content) {
                    console.error("AI Error:", JSON.stringify(result, null, 2));
                    throw new Error("AI returned empty response.");
                }

                if (parseJson) {
                    const textParts = (result.candidates?.[0]?.content?.parts || [])
                        .map(part => typeof part?.text === 'string' ? part.text : '')
                        .filter(Boolean);
                    const text = textParts.join('').trim();
                    if (!text) {
                        throw new Error('AI returned no JSON text content');
                    }
                    console.log("Raw AI Response:", text.substring(0, 200) + "...");
                    try {
                        return this._extractJsonFromText(text);
                    } catch (e) {
                        if (retryCount < maxRetries - 1) {
                            let waitTime = 1200 + Math.random() * 800;
                            const parseErrorText = String(e?.message || '');
                            const finishReason = String(result?.candidates?.[0]?.finishReason || '').toUpperCase();
                            const likelyTruncatedJson =
                                finishReason.includes('MAX')
                                || /unterminated|unexpected end|end of json|end of input|eof/i.test(parseErrorText);

                            if (allowJsonTokenExpansion && likelyTruncatedJson) {
                                if (!mutableRequestBody.generationConfig || typeof mutableRequestBody.generationConfig !== 'object') {
                                    mutableRequestBody.generationConfig = {};
                                }
                                const currentTokens = Number(mutableRequestBody.generationConfig.maxOutputTokens);
                                const baseTokens = Number.isFinite(currentTokens) && currentTokens > 0 ? Math.floor(currentTokens) : 4096;
                                const nextTokens = Math.min(maxOutputTokensCap, Math.max(baseTokens + 1024, Math.floor(baseTokens * 1.6)));
                                if (nextTokens > baseTokens) {
                                    mutableRequestBody.generationConfig.maxOutputTokens = nextTokens;
                                    if (
                                        mutableRequestBody.generationConfig.temperature === undefined
                                        || Number(mutableRequestBody.generationConfig.temperature) > 0.2
                                    ) {
                                        mutableRequestBody.generationConfig.temperature = 0.1;
                                    }
                                    waitTime += 400;
                                    console.warn(`[AI Request] JSON looked truncated (finishReason=${finishReason || 'UNKNOWN'}). Increasing maxOutputTokens ${baseTokens} -> ${nextTokens}.`);
                                }
                            }

                            console.warn(`Invalid JSON from model (attempt ${retryCount + 1}). Retrying in ${Math.round(waitTime)}ms...`);
                            await new Promise(r => setTimeout(r, waitTime));
                            retryCount++;
                            continue;
                        }
                        throw new Error(`Invalid JSON from model: ${e.message}`);
                    }
                }

                return result;

            } catch (error) {
                if (error?.name === 'AbortError' || /Stopped by user/i.test(String(error?.message || ''))) {
                    throw new Error(this._stopReason || 'Stopped by user');
                }
                if (retryCount < maxRetries - 1 && (error.message.includes('fetch') || error.message.includes('network'))) {
                    console.warn(`Network error: ${error.message}. Retrying...`);
                    await new Promise(r => setTimeout(r, 2000));
                    retryCount++;
                    continue;
                }
                console.error("AI Generation Failed:", error);
                throw error;
            } finally {
                if (controller) {
                    this._activeControllers.delete(controller);
                }
            }
        }
        throw new Error("Max retries exceeded calling Gemini API");
    },
    async invokeSmartScrapeTool(toolName, toolArgs, tabId) {
        // In background/service-worker context, call directly to avoid message round-trip flakiness.
        if (typeof self !== 'undefined' && typeof self.__smartScrapeToolInvoker === 'function') {
            try {
                const direct = await self.__smartScrapeToolInvoker(toolName, toolArgs, tabId);
                if (direct !== undefined && direct !== null) return direct;
            } catch (e) {
                return { error: e.message || String(e) };
            }
        }

        // Popup context fallback: runtime messaging with small retry for transient undefined responses.
        let lastError = null;
        const attempts = 2;
        for (let i = 0; i < attempts; i++) {
            try {
                const response = await chrome.runtime.sendMessage({
                    type: 'smartScrapeToolCall',
                    toolName,
                    toolArgs,
                    tabId
                });
                if (response !== undefined && response !== null) return response;
                lastError = new Error(`No response from tool "${toolName}"`);
            } catch (e) {
                lastError = e;
            }
            if (i < attempts - 1) {
                await new Promise(r => setTimeout(r, 250));
            }
        }

        return { error: lastError?.message || `No response from tool "${toolName}"` };
    },

    // Legacy wrapper if needed, or we update popup.js
    async generateFunction(recording, userNotes, apiKey, settings = {}) {
        const { referenceFunctions = [] } = settings;

        const analysis = await this.analyzeRecording(recording, userNotes, apiKey, { ...settings, referenceFunctions });
        const impl = await this.generateFunctionSteps(recording, analysis.analysis, userNotes, apiKey, { referenceFunctions });

        // Include startUrl for navigation fallback
        const startUrl = impl.implementation.startUrl || this.formatRecordingForAI(recording).startUrl;

        return {
            function: {
                ...analysis.analysis,
                startUrl: startUrl,
                steps: impl.implementation.steps
            }
        };
    },

    /**
     * Generate test cases using Fetch
     */
    async generateTestCases(functionDef, apiKey) {
        // Use inputsJson (STRING) instead of inputs (OBJECT) to avoid schema validation errors
        const schema = {
            type: "OBJECT",
            properties: {
                testCases: {
                    type: "ARRAY",
                    items: {
                        type: "OBJECT",
                        properties: {
                            name: { type: "STRING" },
                            inputsJson: { type: "STRING", description: "JSON string of key-value pair inputs" },
                            expectedOutcome: { type: "STRING" }
                        },
                        required: ["name", "inputsJson", "expectedOutcome"]
                    }
                }
            },
            required: ["testCases"]
        };

        const requestBody = {
            contents: [{
                role: 'user',
                parts: [{
                    text: `Generate 3 diverse test cases for this automation function:
${JSON.stringify(functionDef)}

STRICT RULES:
1. Return inputs as a JSON string in "inputsJson".
2. Use the function's declared input names exactly.
3. If any input is URL-like, keep it on the SAME domain/pattern as urlPatterns.
4. Prefer provided defaultValue inputs when available.
5. Do not invent random or unrelated product URLs.`
                }]
            }],
            generationConfig: {
                responseMimeType: 'application/json',
                responseSchema: schema
            }
        };

        if (this._stopRequested) {
            throw new Error(this._stopReason || 'Stopped by user');
        }

        const controller = new AbortController();
        this._activeControllers.add(controller);
        let response;
        try {
            response = await fetch(
                `${this.API_BASE}/models/${this.MODEL}:generateContent?key=${apiKey}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(requestBody),
                    signal: controller.signal
                }
            );
        } finally {
            this._activeControllers.delete(controller);
        }

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error?.message || `API error: ${response.status}`);
        }

        const result = await response.json();

        if (!result.candidates || !result.candidates[0] || !result.candidates[0].content) {
            console.error("AI Test Gen Error. Full Response:", JSON.stringify(result, null, 2));
            throw new Error("AI returned malformed response for test cases.");
        }

        const text = (result.candidates?.[0]?.content?.parts || [])
            .map(part => typeof part?.text === 'string' ? part.text : '')
            .join('')
            .trim();
        const parsed = this._extractJsonFromText(text);
        const rawCases = Array.isArray(parsed?.testCases) ? parsed.testCases : [];
        const normalizedCases = [];
        const seenInputShapes = new Set();

        for (let i = 0; i < rawCases.length; i++) {
            const tc = rawCases[i] || {};
            let parsedInputs = {};
            try {
                parsedInputs = JSON.parse(tc.inputsJson || '{}');
            } catch {
                parsedInputs = {};
            }

            const inputs = this._normalizeGeneratedTestInputs(parsedInputs, functionDef, i);
            const key = JSON.stringify(inputs);
            if (seenInputShapes.has(key)) continue;
            seenInputShapes.add(key);

            normalizedCases.push({
                name: String(tc.name || `Test Case ${i + 1}`),
                inputs,
                expectedOutcome: String(tc.expectedOutcome || 'Function runs successfully and returns usable output')
            });
        }

        const fallbackCases = this._buildFallbackTestCases(functionDef);
        for (const fallback of fallbackCases) {
            if (normalizedCases.length >= 3) break;
            const key = JSON.stringify(fallback.inputs);
            if (seenInputShapes.has(key)) continue;
            seenInputShapes.add(key);
            normalizedCases.push(fallback);
        }

        if (normalizedCases.length === 0) {
            return { testCases: fallbackCases };
        }

        return { testCases: normalizedCases.slice(0, 3) };
    },

    // ==================== AGENTIC SMART SCRAPE ====================

    /**
     * Agentic scraping loop: Takes a screenshot, sends to Gemini vision,
     * and iteratively calls tools (search DOM, structured extraction, save)
     * until a working extraction function is created.
     *
     * @param {string} screenshotBase64 - Base64 data URL of the page screenshot
     * @param {string} pageUrl - The URL of the page being scraped
     * @param {string} apiKey - Gemini API key
     * @param {number} tabId - The tab ID to execute tools on (captured once at start)
     * @param {function} onStatusUpdate - Callback for real-time status updates: (message: string) => void
     * @returns {object} { savedFunction, lastExtractionResult, totalTurns }
     */
    async agenticScrape(screenshotBase64, pageUrl, apiKey, tabId, onStatusUpdate, extractionHints = null) {
        const MAX_TURNS = 10;

        // Strip the data URL prefix to get raw base64
        const base64Data = screenshotBase64.replace(/^data:image\/\w+;base64,/, '');
        const mimeType = screenshotBase64.startsWith('data:image/png') ? 'image/png' : 'image/jpeg';

        // Build initial conversation history with screenshot
        const conversationHistory = [
            {
                role: 'user',
                parts: [
                    {
                        inlineData: {
                            mimeType: mimeType,
                            data: base64Data
                        }
                    },
                    {
                        text: `You are an expert web scraping agent analyzing this page: ${pageUrl}

Your goal: Extract ALL structured data from this page in as few tool calls as possible.
${extractionHints ? `\nSPECIFIC FIELDS TO EXTRACT: ${extractionHints}\nNOTE: This page may have BOTH single items (like a title/description) AND repeating items (like comments). You may need to do MULTIPLE extraction calls â€” one for each section type. For single items, use a broad container (like "body" or a main content area) with selectors targeting specific elements. For lists, find the repeating container.\n` : ''}
WORKFLOW:

1. SNAPSHOT: Call getPageContentSnapshot FIRST to confirm the current tab content before choosing selectors.

2. SEARCH: Call searchPageForText with 4-8 phrases covering DIFFERENT field types you need to extract.

3. EXTRACT: Call runStructuredExtraction with identified containerSelector and fields.
   - For REPEATING items (lists, comments, results): use a container that matches ALL items, with field selectors RELATIVE to it.
   - For SINGLE items (page title, description): use a broad container like the page body, with specific selectors.
   - You CAN call runStructuredExtraction MULTIPLE TIMES to extract different sections.

4. SAVE: Once you have working extraction(s), call saveAsFunction to save it.
   CRITICAL NAMING RULE: Use GENERIC names ensuring usability for ANY page of this type.
   - âŒ BAD: "ScrapeAmazonBatterySearch", "ScrapeIphoneResults"
   - âœ… GOOD: "ScrapeAmazonSearchResults", "ScrapeProductList"
   - The function should be named "Scrape[Domain][PageType]", NOT "Scrape[InputQuery]".

IMPORTANT: You have up to ${MAX_TURNS} tool calls. Use them wisely but don't rush â€” accuracy matters more than speed. If your first extraction attempt returns nulls or misses fields, try different selectors.

TIPS FOR SELECTORS:
- The containerSelector should match ALL repeating items.
- Field selectors are RELATIVE to the container.
- Use data attributes like '[data-component-type]' where possible.
- For YouTube comments, look for 'ytd-comment-view-model' or '#content-text' inside '#comments'.
- ALWAYS call saveAsFunction when you have a working extraction â€” don't keep iterating after success.
- Do NOT navigate. Operate on the CURRENT tab only.

HANDLING DYNAMIC CONTENT:
- Some sites hide content behind expandable sections.
- Use ONLY valid CSS selectors compatible with querySelector/querySelectorAll.
- Do NOT use unsupported pseudo-selectors like :contains(...) or :has-text(...).
- Preflight may already expand content; prioritize stable selectors for extraction.`
                    }
                ]
            }
        ];

        // Gemini function calling tools configuration
        const tools = [{
            function_declarations: this.SCRAPE_TOOL_DECLARATIONS
        }];

        let savedFunction = null;
        let lastExtractionResult = null;
        let lastExtractionArgs = null;
        let bestExtractionResult = null;
        let bestExtractionArgs = null;
        let bestExtractionScore = Number.NEGATIVE_INFINITY;
        let terminalError = null;
        const normalizedHints = String(extractionHints || '').toLowerCase();
        let snapshotWasRequested = false;

        const isMeaningfulValue = (value) => {
            if (value === null || value === undefined) return false;
            if (typeof value === 'string') return value.trim().length > 0;
            if (Array.isArray(value)) return value.length > 0;
            if (typeof value === 'object') return Object.values(value).some(v => isMeaningfulValue(v));
            return true;
        };

        const hasMeaningfulExtraction = (toolResult) => {
            if (!toolResult || toolResult.error) return false;
            if (Array.isArray(toolResult.result)) {
                if (toolResult.result.length === 0) return false;
                return toolResult.result.some(item => {
                    if (item && typeof item === 'object') return Object.values(item).some(isMeaningfulValue);
                    return isMeaningfulValue(item);
                });
            }
            if (toolResult.result && typeof toolResult.result === 'object') {
                return Object.values(toolResult.result).some(isMeaningfulValue);
            }
            return !!toolResult.success && isMeaningfulValue(toolResult.result);
        };

        // Prime the model with direct current-page text context before first tool-call turn.
        try {
            const initialSnapshot = await this.invokeSmartScrapeTool('getPageContentSnapshot', { maxChars: 6000 }, tabId);
            if (initialSnapshot && !initialSnapshot.error) {
                conversationHistory.push({
                    role: 'user',
                    parts: [{
                        text: `CURRENT TAB CONTENT SNAPSHOT (no navigation):
URL: ${initialSnapshot.url || pageUrl}
Title: ${initialSnapshot.title || ''}
Headings: ${(initialSnapshot.headings || []).slice(0, 10).join(' | ')}
BodyTextPreview: ${(initialSnapshot.bodyTextPreview || '').slice(0, 2500)}`
                    }]
                });
                snapshotWasRequested = true;
                console.log('[Smart Scrape] Prefetched current-tab snapshot for grounding.');
            }
        } catch (e) {
            console.warn('[Smart Scrape] Prefetch snapshot failed:', e.message);
        }

        const evaluateExtractionCandidate = (toolResult, args) => {
            if (!toolResult || toolResult.error) return null;
            if (!(toolResult.success || Array.isArray(toolResult.result) || (toolResult.result && typeof toolResult.result === 'object'))) {
                return null;
            }

            const resultList = Array.isArray(toolResult.result)
                ? toolResult.result
                : (Array.isArray(toolResult) ? toolResult : []);
            const resultLength = Array.isArray(resultList)
                ? resultList.length
                : (toolResult.result && typeof toolResult.result === 'object' ? 1 : 0);
            const nonEmptyCount = resultList.length > 0
                ? resultList.filter(item => {
                    if (item && typeof item === 'object') return Object.values(item).some(isMeaningfulValue);
                    return isMeaningfulValue(item);
                }).length
                : (toolResult.result && typeof toolResult.result === 'object' ? 1 : 0);
            const fieldNames = Array.isArray(args?.fields)
                ? args.fields.map(f => String(f?.name || '').toLowerCase()).filter(Boolean)
                : [];
            const hasUrlField = fieldNames.some(name => /(url|href|link)/.test(name));
            const hasImageField = fieldNames.some(name => /(image|thumbnail|img|photo|icon|logo)/.test(name));
            const hasReviewField = fieldNames.some(name => /(review|comment|text|body|sentiment|rating|stars)/.test(name));

            let score = 0;
            score += resultLength * 10;
            score += nonEmptyCount * 2;
            if (hasUrlField) score += 3;
            if (hasImageField) score += 2;
            if (hasReviewField && /(review|comment|feedback|sentiment|rating)/.test(normalizedHints)) score += 15;
            if (resultLength === 0) score -= 30;

            return { score };
        };

        for (let turn = 0; turn < MAX_TURNS; turn++) {
            onStatusUpdate(`Step ${turn + 1}/${MAX_TURNS}: AI is analyzing...`);

            const requestBody = {
                contents: conversationHistory,
                tools: tools,
                generationConfig: {
                    maxOutputTokens: 8192
                }
            };

            let result;
            try {
                // Use callGemini with parseJson=false to handle full response with tools
                // This gives us retry logic for 503/429 errors
                result = await this.callGemini(requestBody, apiKey, false);
            } catch (e) {
                // Rate limit or retries failed
                throw new Error(e.message);
            }

            // Legacy check (callGemini throws on error, but keeping structure safe)
            if (!result) throw new Error("No response from AI service");

            if (!result.candidates?.[0]?.content) {
                console.error('[Smart Scrape] Empty response:', JSON.stringify(result, null, 2));
                throw new Error('AI returned empty response');
            }

            const aiContent = result.candidates[0].content;
            console.log('[Smart Scrape] AI response parts:', aiContent.parts.map(p => p.functionCall ? `functionCall:${p.functionCall.name}` : 'text').join(', '));

            // Add AI response to conversation history
            conversationHistory.push(aiContent);

            // Check for function calls
            const functionCalls = aiContent.parts.filter(p => p.functionCall);

            if (functionCalls.length === 0) {
                // AI responded with text only - it's done or explaining something
                const textPart = aiContent.parts.find(p => p.text);
                onStatusUpdate(textPart?.text?.substring(0, 200) || 'AI finished without saving a function.');
                break;
            }

            // Process each function call
            const functionResponses = [];

            for (const part of functionCalls) {
                const { name, args } = part.functionCall;
                onStatusUpdate(`Calling tool: ${name}...`);
                console.log(`[Smart Scrape] Tool call: ${name}`, args);

                if (name === 'runStructuredExtraction') {
                    lastExtractionArgs = args;
                }
                const toolResult = await this.invokeSmartScrapeTool(name, args, tabId);

                console.log(`[Smart Scrape] Tool result for ${name}:`, toolResult);

                const toolErrorText = String(toolResult?.error || '');
                const tabGone = /No tab with id/i.test(toolErrorText);
                const contextGone = /Extension context invalidated/i.test(toolErrorText);
                if (tabGone || contextGone) {
                    terminalError = toolErrorText || 'Target tab is no longer available';
                }

                if (name === 'runStructuredExtraction') {
                    const candidate = evaluateExtractionCandidate(toolResult, args);
                    if (candidate) {
                        const meaningful = hasMeaningfulExtraction(toolResult);
                        if (meaningful || !lastExtractionResult) {
                            lastExtractionResult = toolResult;
                        }
                        if (candidate.score > bestExtractionScore) {
                            bestExtractionScore = candidate.score;
                            bestExtractionResult = toolResult;
                            bestExtractionArgs = args;
                        }
                    }
                }

                // Track save calls only when we already have meaningful extraction data.
                const extractionForSave = bestExtractionResult || lastExtractionResult;
                if (name === 'saveAsFunction' && toolResult && !toolResult.error && hasMeaningfulExtraction(extractionForSave)) {
                    const persistedName = toolResult?.functionName || args.name;
                    savedFunction = {
                        name: persistedName,
                        description: args.description,
                        containerSelector: args.containerSelector,
                        fields: args.fields,
                        outputs: args.outputs,
                        lastExtractionResult: extractionForSave
                    };
                } else if (name === 'saveAsFunction' && hasMeaningfulExtraction(extractionForSave)) {
                    // Messaging can occasionally return an empty response even after save side-effects.
                    // Keep the workflow moving when we already have a valid extraction.
                    const persistedName = toolResult?.functionName || args.name;
                    savedFunction = {
                        name: persistedName,
                        description: args.description,
                        containerSelector: args.containerSelector,
                        fields: args.fields,
                        outputs: args.outputs,
                        lastExtractionResult: extractionForSave,
                        warning: toolResult?.error || 'Tool response missing during save'
                    };
                } else if (name === 'saveAsFunction') {
                    console.warn('[Smart Scrape] Ignoring saveAsFunction because extraction result is empty or invalid.');
                }

                functionResponses.push({
                    functionResponse: {
                        name: name,
                        response: toolResult || { error: 'No response from tool' }
                    }
                });

                if (terminalError) {
                    break;
                }
            }

            if (terminalError) {
                onStatusUpdate(`Smart Scrape stopped: ${terminalError}`);
                break;
            }

            // Add function responses to conversation history
            conversationHistory.push({
                role: 'user',
                parts: functionResponses
            });

            // If we saved a function, we're done
            if (savedFunction) {
                onStatusUpdate(`Function "${savedFunction.name}" saved successfully!`);
                break;
            }
        }

        if (!snapshotWasRequested) {
            try {
                const snapshot = await this.invokeSmartScrapeTool('getPageContentSnapshot', { maxChars: 5000 }, tabId);
                console.log('[Smart Scrape] Auto snapshot (model did not request one):', snapshot);
            } catch (e) {
                console.warn('[Smart Scrape] Auto snapshot failed:', e.message);
            }
        }

        // Fallback: auto-save the last successful extraction config if AI never called save.
        const extractionForAutoSave = bestExtractionResult || lastExtractionResult;
        const extractionArgsForAutoSave = bestExtractionArgs || lastExtractionArgs;
        if (!terminalError && !savedFunction && hasMeaningfulExtraction(extractionForAutoSave) && extractionArgsForAutoSave?.containerSelector && Array.isArray(extractionArgsForAutoSave?.fields)) {
            let domainToken = 'Page';
            try {
                const host = new URL(pageUrl).hostname.replace(/^www\./, '');
                domainToken = host
                    .split('.')
                    .filter(Boolean)
                    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
                    .join('');
            } catch { /* ignore */ }

            const fieldList = extractionArgsForAutoSave.fields.map(f => f.name).filter(Boolean);
            const autoArgs = {
                name: `Scrape${domainToken}Data`,
                description: extractionHints ? `Extract ${extractionHints}` : `Extract structured data from this page`,
                containerSelector: extractionArgsForAutoSave.containerSelector,
                fields: extractionArgsForAutoSave.fields,
                outputs: fieldList.length > 0 ? `Array of {${fieldList.join(', ')}}` : 'Array of extracted items'
            };

            try {
                const autoSaveResult = await this.invokeSmartScrapeTool('saveAsFunction', autoArgs, tabId);
                if (autoSaveResult && !autoSaveResult.error) {
                    const persistedName = autoSaveResult?.functionName || autoArgs.name;
                    savedFunction = {
                        ...autoArgs,
                        name: persistedName,
                        lastExtractionResult: extractionForAutoSave,
                        autoSaved: true
                    };
                    onStatusUpdate(`Function "${savedFunction.name}" auto-saved from last successful extraction.`);
                }
            } catch (e) {
                console.warn('[Smart Scrape] Auto-save fallback failed:', e.message);
            }
        }

        // Log failure details if scraper didn't save a function
        if (!savedFunction) {
            console.warn(`[Smart Scrape] FAILED after ${MAX_TURNS} turns. No saveAsFunction called.`);
            console.warn(`[Smart Scrape] Page: ${pageUrl}`);
            if (terminalError) {
                console.warn(`[Smart Scrape] Terminal error: ${terminalError}`);
            }
            const finalExtraction = bestExtractionResult || lastExtractionResult;
            if (finalExtraction) {
                const preview = JSON.stringify(finalExtraction).substring(0, 500);
                console.warn(`[Smart Scrape] Last extraction result: ${preview}`);
            } else {
                console.warn(`[Smart Scrape] No extraction results at all â€” AI never got a successful extraction.`);
            }
            if (extractionHints) {
                console.warn(`[Smart Scrape] Extraction hints were: ${extractionHints}`);
            }
            onStatusUpdate(
                terminalError
                    ? `Scraper stopped: ${terminalError}`
                    : `Scraper failed after ${MAX_TURNS} turns without saving a function.`
            );
        }

        const finalExtractionResult = bestExtractionResult || lastExtractionResult;
        return {
            savedFunction,
            lastExtractionResult: finalExtractionResult,
            totalTurns: conversationHistory.length
        };
    },

    /**
     * Verify if the function output is valid using AI
     * Checks for nulls, empty arrays, or schema mismatches
     */
    async verifyFunctionOutput(functionDef, executionResult, apiKey) {
        // If execution failed technically, it's already invalid
        if (!executionResult || !executionResult.success) {
            return { valid: false, reason: executionResult?.error || "Execution failed" };
        }

        const outputData = executionResult.data;

        // Fast paths for obvious failures
        if (outputData === undefined || outputData === null) {
            return { valid: false, reason: "Function returned null or undefined. Expected data." };
        }
        if (Array.isArray(outputData) && outputData.length === 0) {
            return { valid: false, reason: "Function returned an empty array. Expected at least one result." };
        }

        // Use AI to verify data quality against expectation
        const prompt = `
        You are a QA engineer. Verify this function output is USABLE.

        FUNCTION: ${functionDef.name}
        DESCRIPTION: ${functionDef.description}
        EXPECTED OUTPUT SCHEMA: ${JSON.stringify(functionDef.outputs)}

        ACTUAL OUTPUT:
        ${JSON.stringify(outputData).substring(0, 5000)} // Truncated if too large

        TASK:
        1. Does the output contain meaningful data? (e.g., at least some items with non-null core fields)
        2. Are CORE fields present and non-null in MOST items? (e.g., title/name and price for products)
        3. Is the data usable for downstream workflows?

        IMPORTANT LENIENCY RULES:
        - Mark as VALID if the output has useful data, even if some secondary fields are null.
        - Some null values are ACCEPTABLE (e.g., url, selector, badge might be null for some items).
        - Only mark as INVALID if ALL items have null core fields (title AND price are both null) or the array is empty.
        - Schema field names may differ slightly from the expected schema - focus on DATA QUALITY not exact field name matching.
        - If the output is wrapped in an extra object/array layer but the data is present, mark as VALID.
        - Do NOT fail just because a "selector" or "elementIndex" field is missing.

        Return JSON: { "valid": boolean, "reason": "Short explanation" }
        `;

        const requestBody = {
            contents: [{
                role: 'user',
                parts: [{ text: prompt }]
            }],
            generationConfig: {
                responseMimeType: 'application/json'
            }
        };

        try {
            const result = await this.callGemini(requestBody, apiKey);
            return result;
        } catch (e) {
            // Fallback if AI fails: assume valid if data exists
            console.warn("Verification AI failed, defaulting to basic check", e);
            return { valid: true, reason: "Basic check passed" };
        }
    },

    /**
     * Verify function output using both data analysis AND a screenshot of the page.
     * More thorough than verifyFunctionOutput â€” the AI can see whether the page
     * actually shows the expected content and whether the extracted data matches.
     *
     * @param {object} functionDef - The function definition being tested
     * @param {object} executionResult - Result from executeGeneratedFunction ({success, data, error})
     * @param {string} screenshotBase64 - PNG screenshot data URL of the page after execution
     * @param {string} apiKey - Gemini API key
     * @returns {object} { valid: boolean, issues: string[], canFix: boolean }
     */
    async verifyWithScreenshot(functionDef, executionResult, screenshotBase64, apiKey) {
        // Fast paths for obvious failures
        if (!executionResult?.success) {
            return { valid: false, issues: [executionResult?.error || 'Execution failed'], canFix: true };
        }
        const outputData = executionResult.data;
        if (outputData === null || outputData === undefined) {
            return { valid: false, issues: ['Function returned null/undefined'], canFix: true };
        }
        if (Array.isArray(outputData) && outputData.length === 0) {
            return { valid: false, issues: ['Function returned empty array'], canFix: true };
        }

        const isWorkflow = functionDef?.source === 'ai-workflow' || !!functionDef?.workflowMetadata;
        const hasMeaningfulValue = (value) => {
            if (value === null || value === undefined) return false;
            if (typeof value === 'string') return value.trim().length > 0;
            if (Array.isArray(value)) return value.some(v => hasMeaningfulValue(v));
            if (typeof value === 'object') return Object.values(value).some(v => hasMeaningfulValue(v));
            return true;
        };

        // Workflow outputs aggregate many pages; one screenshot often shows only the final page.
        // Avoid false failures from visual mismatch between aggregated output and single screenshot.
        if (isWorkflow) {
            const records = Array.isArray(outputData) ? outputData : [outputData];
            const hasUsableRows = records.some(row => hasMeaningfulValue(row));
            const hasNumericWrapperIssue = records.some(row => {
                if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
                const keys = Object.keys(row);
                return keys.length === 1 && /^\d+$/.test(keys[0]) && typeof row[keys[0]] === 'object';
            });

            if (hasNumericWrapperIssue) {
                return {
                    valid: false,
                    issues: ['Output rows are incorrectly nested under numeric keys (e.g., "0").'],
                    canFix: true
                };
            }

            if (hasUsableRows) {
                return { valid: true, issues: [], canFix: false };
            }

            const fallbackWorkflow = await this.verifyFunctionOutput(functionDef, executionResult, apiKey);
            return {
                valid: !!fallbackWorkflow?.valid,
                issues: fallbackWorkflow?.valid ? [] : [fallbackWorkflow?.reason || 'Workflow output validation failed'],
                canFix: !fallbackWorkflow?.valid
            };
        }

        // If no screenshot, fall back to non-visual verification
        if (!screenshotBase64) {
            const fallback = await this.verifyFunctionOutput(functionDef, executionResult, apiKey);
            return { valid: fallback.valid, issues: fallback.valid ? [] : [fallback.reason], canFix: !fallback.valid };
        }

        const base64Data = screenshotBase64.replace(/^data:image\/\w+;base64,/, '');
        const outputJson = JSON.stringify(outputData);
        const outputHead100 = outputJson.slice(0, 100);
        const outputTail100 = outputJson.slice(-100);
        const prompt = `You are a QA engineer verifying browser automation output.

FUNCTION: ${functionDef.name}
DESCRIPTION: ${functionDef.description}
EXPECTED OUTPUT: ${JSON.stringify(functionDef.outputs)}

ACTUAL OUTPUT (truncated):
${JSON.stringify(outputData).substring(0, 3000)}

FIRST_100_CHARS:
${outputHead100}
LAST_100_CHARS:
${outputTail100}

SCREENSHOT: Shows the current page state after execution.

VERIFY:
1. Does the screenshot show the expected page/content for this function?
2. Does the output data match what's visible on the page?
3. Are the core fields populated with real data (not placeholders/nulls)?
4. Is the data structurally correct (matching expected schema)?

LENIENCY: Some null secondary fields are OK. Minor field name differences OK.
Focus on: Is the data USABLE and REAL?

Return JSON: { "valid": boolean, "issues": ["list of specific issues found, empty if valid"], "canFix": boolean }`;

        const body = {
            contents: [{ role: 'user', parts: [
                { text: prompt },
                { inline_data: { mime_type: 'image/png', data: base64Data } }
            ]}],
            generationConfig: { responseMimeType: 'application/json', temperature: 0.1 }
        };

        try {
            return await this.callGemini(body, apiKey);
        } catch (e) {
            console.warn('Screenshot verification failed, falling back to basic:', e);
            const fallback = await this.verifyFunctionOutput(functionDef, executionResult, apiKey);
            return { valid: fallback.valid, issues: fallback.valid ? [] : [fallback.reason], canFix: !fallback.valid };
        }
    },

    _compactFunctionForEditPrompt(functionDef, options = {}) {
        const maxCodeChars = Math.max(1200, Math.min(Number(options.maxCodeChars) || 12000, 40000));
        const includeTestCases = options.includeTestCases !== false;
        const maxTestCases = Math.max(0, Math.min(Number(options.maxTestCases) || 3, 5));
        const truncate = (value, maxChars) => {
            const text = String(value || '');
            if (text.length <= maxChars) return text;
            return `${text.slice(0, Math.max(0, maxChars - 32))}\n/* ...truncated for prompt... */`;
        };

        const compactStep = (step) => {
            if (!step || typeof step !== 'object') return step;
            const copy = { ...step };
            if (typeof copy.code === 'string') {
                copy.code = truncate(copy.code, maxCodeChars);
            }
            return copy;
        };

        const compact = {
            name: functionDef?.name,
            description: functionDef?.description,
            source: functionDef?.source,
            inputs: Array.isArray(functionDef?.inputs) ? functionDef.inputs : [],
            outputs: functionDef?.outputs || {},
            urlPatterns: Array.isArray(functionDef?.urlPatterns) ? functionDef.urlPatterns : [],
            referenceFunctions: Array.isArray(functionDef?.referenceFunctions) ? functionDef.referenceFunctions : [],
            navigationStrategy: functionDef?.navigationStrategy || '',
            extractionStrategy: functionDef?.extractionStrategy || '',
            steps: Array.isArray(functionDef?.steps) ? functionDef.steps.map(compactStep) : []
        };

        if (includeTestCases && Array.isArray(functionDef?.testCases) && functionDef.testCases.length > 0 && maxTestCases > 0) {
            compact.testCases = functionDef.testCases.slice(0, maxTestCases);
        }
        if (functionDef?.workflowMetadata && typeof functionDef.workflowMetadata === 'object') {
            compact.workflowMetadata = {
                subFunctions: Array.isArray(functionDef.workflowMetadata.subFunctions)
                    ? functionDef.workflowMetadata.subFunctions
                    : [],
                orchestrationStrategy: truncate(functionDef.workflowMetadata.orchestrationStrategy || '', 1500)
            };
        }

        return compact;
    },

    _isCodeBearingStep(step = null) {
        if (!step || typeof step !== 'object') return false;
        if (typeof step.code === 'string' && step.code.trim().length > 0) return true;
        const stepType = String(step.type || '').toLowerCase();
        return stepType === 'script' || stepType === 'extractscript';
    },

    _sanitizeUnsupportedScriptCode(code = '') {
        let sanitized = String(code || '');

        // page.goto is blocked in sandbox scripts; page.navigate is supported.
        sanitized = sanitized.replace(/\bpage\s*\.\s*goto\s*\(/gi, 'page.navigate(');

        // page.extract must receive a selector string, not an object payload.
        sanitized = sanitized.replace(
            /\bpage\s*\.\s*extract\s*\(\s*\{\s*(?:blocks|selector)\s*:\s*(["'`])([\s\S]*?)\1\s*\}\s*\)/gi,
            (_m, quote, selector) => `page.extract(${quote}${selector}${quote})`
        );

        return sanitized;
    },

    _sanitizeUnsupportedScriptUsage(steps = []) {
        const list = Array.isArray(steps) ? steps : [];
        let changed = false;

        const sanitizedSteps = list.map(step => {
            if (!step || typeof step !== 'object' || !this._isCodeBearingStep(step)) return step;
            const originalCode = String(step.code || '');
            const nextCode = this._sanitizeUnsupportedScriptCode(originalCode);
            if (nextCode === originalCode) return step;
            changed = true;
            return { ...step, code: nextCode };
        });

        return { steps: sanitizedSteps, changed };
    },

    _findUnsupportedScriptUsage(steps = []) {
        const blockedRules = [
            { label: 'eval()', regex: /(^|[^\w$])eval\s*\(/i },
            { label: 'new Function()', regex: /\bnew\s+Function\s*\(/i },
            { label: 'Function()', regex: /(^|[^\w$])Function\s*\(/i },
            { label: 'page.evaluate()', regex: /\bpage\s*\.\s*evaluate\s*\(/i },
            { label: 'page.goto()', regex: /\bpage\s*\.\s*goto\s*\(/i },
            { label: 'page.extract({...})', regex: /\bpage\s*\.\s*extract\s*\(\s*\{/i },
            { label: 'XMLHttpRequest', regex: /\bXMLHttpRequest\b/i },
            { label: 'document.cookie', regex: /\bdocument\s*\.\s*cookie\b/i },
            { label: 'localStorage', regex: /\blocalStorage\b/i },
            { label: 'sessionStorage', regex: /\bsessionStorage\b/i },
            { label: 'page.waitForSelector()', regex: /\bpage\s*\.\s*waitForSelector\s*\(/i }
        ];

        const list = Array.isArray(steps) ? steps : [];
        for (let i = 0; i < list.length; i++) {
            const step = list[i];
            if (!step || typeof step !== 'object') continue;
            if (!this._isCodeBearingStep(step)) continue;
            const code = String(step.code || '');
            for (const rule of blockedRules) {
                if (rule.regex.test(code)) {
                    return {
                        operation: rule.label,
                        stepIndex: i,
                        stepType: step.type || 'script'
                    };
                }
            }
        }

        return null;
    },

    _applyStepPatches(baseSteps = [], patches = []) {
        const steps = Array.isArray(baseSteps)
            ? baseSteps.map(step => (step && typeof step === 'object' ? { ...step } : step))
            : [];
        const list = Array.isArray(patches) ? patches : [];

        for (const patch of list) {
            const idx = Number(patch?.index);
            if (!Number.isInteger(idx) || idx < 0 || idx >= steps.length) continue;
            const current = steps[idx];
            if (!current || typeof current !== 'object') continue;

            if (patch?.step && typeof patch.step === 'object') {
                steps[idx] = { ...current, ...patch.step };
                continue;
            }

            const merged = { ...current };
            const fields = [
                'type', 'description', 'selector', 'value', 'key', 'url',
                'timeout', 'condition', 'amount', 'direction', 'code', 'returnAs'
            ];
            for (const field of fields) {
                if (patch?.[field] !== undefined) {
                    merged[field] = patch[field];
                }
            }
            steps[idx] = merged;
        }

        return steps;
    },

    _applyCodeReplacements(code = '', replacements = []) {
        let nextCode = String(code || '');
        let appliedCount = 0;
        let missingCount = 0;
        const list = Array.isArray(replacements) ? replacements : [];

        for (const replacement of list) {
            const find = typeof replacement?.find === 'string' ? replacement.find : '';
            const replace = replacement?.replace === undefined ? '' : String(replacement.replace);
            if (!find) continue;
            if (!nextCode.includes(find)) {
                missingCount++;
                continue;
            }
            nextCode = nextCode.split(find).join(replace);
            appliedCount++;
        }

        return { code: nextCode, appliedCount, missingCount };
    },

    _applyReplacementPatches(baseSteps = [], patches = []) {
        const steps = Array.isArray(baseSteps)
            ? baseSteps.map(step => (step && typeof step === 'object' ? { ...step } : step))
            : [];
        const list = Array.isArray(patches) ? patches : [];
        let appliedCount = 0;

        for (const patch of list) {
            const idx = Number(patch?.index);
            if (!Number.isInteger(idx) || idx < 0 || idx >= steps.length) continue;
            const current = steps[idx];
            if (!current || typeof current !== 'object') continue;

            const merged = { ...current };
            if (typeof patch?.description === 'string' && patch.description.trim()) {
                merged.description = patch.description.trim();
            }

            if (typeof merged.code === 'string' && Array.isArray(patch?.replacements)) {
                const replacementResult = this._applyCodeReplacements(merged.code, patch.replacements);
                merged.code = replacementResult.code;
                appliedCount += replacementResult.appliedCount;
            }

            steps[idx] = merged;
        }

        return { steps, appliedCount };
    },

    async _modifyFunctionWithPromptPatchFallback(functionDef, userPrompt, apiKey, primaryError = null) {
        const baseSteps = Array.isArray(functionDef?.steps) ? functionDef.steps : [];
        if (baseSteps.length === 0) return null;

        const compactTarget = {
            name: functionDef?.name,
            description: functionDef?.description,
            source: functionDef?.source,
            inputs: Array.isArray(functionDef?.inputs) ? functionDef.inputs : [],
            outputs: functionDef?.outputs || {},
            urlPatterns: Array.isArray(functionDef?.urlPatterns) ? functionDef.urlPatterns : [],
            steps: baseSteps.map((step, index) => {
                const out = {
                    index,
                    type: step?.type || '',
                    description: step?.description || ''
                };
                if (typeof step?.selector === 'string' && step.selector) out.selector = step.selector;
                if (typeof step?.url === 'string' && step.url) out.url = step.url;
                if (typeof step?.code === 'string') out.code = step.code.slice(0, 5000);
                return out;
            })
        };

        const schema = {
            type: 'OBJECT',
            properties: {
                stepPatches: {
                    type: 'ARRAY',
                    items: {
                        type: 'OBJECT',
                        properties: {
                            index: { type: 'INTEGER' },
                            step: {
                                type: 'OBJECT',
                                properties: {
                                    type: { type: 'STRING' },
                                    description: { type: 'STRING' },
                                    selector: { type: 'STRING' },
                                    value: { type: 'STRING' },
                                    key: { type: 'STRING' },
                                    url: { type: 'STRING' },
                                    timeout: { type: 'INTEGER' },
                                    condition: { type: 'STRING' },
                                    amount: { type: 'INTEGER' },
                                    direction: { type: 'STRING' },
                                    code: { type: 'STRING' },
                                    returnAs: { type: 'STRING' }
                                }
                            },
                            type: { type: 'STRING' },
                            description: { type: 'STRING' },
                            selector: { type: 'STRING' },
                            value: { type: 'STRING' },
                            key: { type: 'STRING' },
                            url: { type: 'STRING' },
                            timeout: { type: 'INTEGER' },
                            condition: { type: 'STRING' },
                            amount: { type: 'INTEGER' },
                            direction: { type: 'STRING' },
                            code: { type: 'STRING' },
                            returnAs: { type: 'STRING' }
                        },
                        required: ['index']
                    }
                },
                updatedDescription: { type: 'STRING' },
                changeSummary: { type: 'STRING' }
            },
            required: ['stepPatches']
        };

        const prompt = `You are editing an existing browser automation function.

FUNCTION (do not rename):
${JSON.stringify(compactTarget, null, 2)}

USER REQUEST:
${String(userPrompt || '').trim()}

PRIMARY ATTEMPT ERROR:
${String(primaryError?.message || 'none')}

RULES:
1. Keep function name, inputs, outputs, and number of steps unchanged.
2. Return ONLY changed step patches, not full fixedSteps.
3. Each patch must include "index" and the updated fields for that step.
4. Do not use unsupported APIs: no eval, Function constructor, page.evaluate, page.goto, XMLHttpRequest, document.cookie, localStorage, sessionStorage, page.waitForSelector.
5. page.extract accepts only a CSS selector string. Do not pass an object payload.
6. Prefer minimal edits.

Return JSON:
{
  "stepPatches": [
    { "index": 0, "code": "updated code...", "description": "optional" }
  ],
  "updatedDescription": "optional improved description",
  "changeSummary": "one-line summary"
}

IMPORTANT:
- Output JSON only.
- Keep code compact JavaScript.
- If no change is needed for a step, do not include a patch for it.`;

        const result = await this.callGemini({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: {
                responseMimeType: 'application/json',
                responseJsonSchema: schema,
                temperature: 0.1,
                maxOutputTokens: 4096
            }
        }, apiKey, true, {
            maxRetries: 3,
            allowJsonTokenExpansion: true,
            maxOutputTokensCap: 16384
        });

        if (!Array.isArray(result?.stepPatches) || result.stepPatches.length === 0) {
            return null;
        }

        let fixedSteps = this._applyStepPatches(baseSteps, result.stepPatches);
        const sanitized = this._sanitizeUnsupportedScriptUsage(fixedSteps);
        if (sanitized.changed) fixedSteps = sanitized.steps;
        const unsupported = this._findUnsupportedScriptUsage(fixedSteps);
        if (unsupported) {
            throw new Error(`Fallback produced unsupported script operation: ${unsupported.operation} (step ${unsupported.stepIndex + 1})`);
        }

        return {
            fixedSteps,
            updatedDescription: typeof result.updatedDescription === 'string' ? result.updatedDescription.trim() : '',
            changeSummary: typeof result.changeSummary === 'string' ? result.changeSummary.trim() : ''
        };
    },

    async _modifyFunctionWithPromptReplacementFallback(functionDef, userPrompt, apiKey, primaryError = null) {
        const baseSteps = Array.isArray(functionDef?.steps) ? functionDef.steps : [];
        if (baseSteps.length === 0) return null;

        const compactTarget = {
            name: functionDef?.name,
            description: functionDef?.description,
            source: functionDef?.source,
            inputs: Array.isArray(functionDef?.inputs) ? functionDef.inputs : [],
            outputs: functionDef?.outputs || {},
            urlPatterns: Array.isArray(functionDef?.urlPatterns) ? functionDef.urlPatterns : [],
            steps: baseSteps.map((step, index) => {
                const out = {
                    index,
                    type: step?.type || '',
                    description: step?.description || ''
                };
                if (typeof step?.selector === 'string' && step.selector) out.selector = step.selector;
                if (typeof step?.url === 'string' && step.url) out.url = step.url;
                if (typeof step?.code === 'string') out.code = step.code.slice(0, 2800);
                return out;
            })
        };

        const schema = {
            type: 'OBJECT',
            properties: {
                replacementPatches: {
                    type: 'ARRAY',
                    items: {
                        type: 'OBJECT',
                        properties: {
                            index: { type: 'INTEGER' },
                            description: { type: 'STRING' },
                            replacements: {
                                type: 'ARRAY',
                                items: {
                                    type: 'OBJECT',
                                    properties: {
                                        find: { type: 'STRING' },
                                        replace: { type: 'STRING' }
                                    },
                                    required: ['find', 'replace']
                                }
                            }
                        },
                        required: ['index', 'replacements']
                    }
                },
                updatedDescription: { type: 'STRING' },
                changeSummary: { type: 'STRING' }
            },
            required: ['replacementPatches']
        };

        const prompt = `You are editing an existing browser automation function.

FUNCTION (do not rename):
${JSON.stringify(compactTarget, null, 2)}

USER REQUEST:
${String(userPrompt || '').trim()}

PRIMARY ATTEMPT ERROR:
${String(primaryError?.message || 'none')}

RULES:
1. Keep function name, inputs, outputs, and number of steps unchanged.
2. Return ONLY replacement patches, not full fixedSteps.
3. Each patch must include "index" and a "replacements" array of exact string edits.
4. Each replacement item must be: {"find":"exact existing substring","replace":"new substring"}.
5. DO NOT return full script code. Keep patches minimal.
6. Do not use unsupported APIs: no eval, Function constructor, page.evaluate, page.goto, XMLHttpRequest, document.cookie, localStorage, sessionStorage, page.waitForSelector.
7. page.extract accepts only a CSS selector string. Do not pass an object payload.

Return JSON:
{
  "replacementPatches": [
    {
      "index": 0,
      "description": "optional",
      "replacements": [
        { "find": "old code", "replace": "new code" }
      ]
    }
  ],
  "updatedDescription": "optional improved description",
  "changeSummary": "one-line summary"
}

IMPORTANT:
- Output JSON only.
- Keep response very compact.
- If no change is needed for a step, do not include it.`;

        const result = await this.callGemini({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: {
                responseMimeType: 'application/json',
                responseJsonSchema: schema,
                temperature: 0.1,
                maxOutputTokens: 1400
            }
        }, apiKey, true, {
            maxRetries: 3,
            allowJsonTokenExpansion: true,
            maxOutputTokensCap: 4096
        });

        if (!Array.isArray(result?.replacementPatches) || result.replacementPatches.length === 0) {
            return null;
        }

        const replacementResult = this._applyReplacementPatches(baseSteps, result.replacementPatches);
        if (!replacementResult.appliedCount) {
            return null;
        }

        let fixedSteps = replacementResult.steps;
        const sanitized = this._sanitizeUnsupportedScriptUsage(fixedSteps);
        if (sanitized.changed) fixedSteps = sanitized.steps;
        const unsupported = this._findUnsupportedScriptUsage(fixedSteps);
        if (unsupported) {
            throw new Error(`Replacement fallback produced unsupported script operation: ${unsupported.operation} (step ${unsupported.stepIndex + 1})`);
        }

        return {
            fixedSteps,
            updatedDescription: typeof result.updatedDescription === 'string' ? result.updatedDescription.trim() : '',
            changeSummary: typeof result.changeSummary === 'string' ? result.changeSummary.trim() : ''
        };
    },

    async modifyFunctionWithPrompt(functionDef, userPrompt, apiKey) {
        if (!functionDef || typeof functionDef !== 'object') {
            throw new Error('Invalid function definition');
        }
        if (!userPrompt || !String(userPrompt).trim()) {
            throw new Error('Prompt is required');
        }

        const existingSteps = Array.isArray(functionDef?.steps) ? functionDef.steps : [];
        const totalCodeChars = existingSteps.reduce((sum, step) => (
            sum + (typeof step?.code === 'string' ? step.code.length : 0)
        ), 0);
        const preferPatchMode = totalCodeChars > 1800 || existingSteps.length > 4;

        if (preferPatchMode) {
            const patchModeReason = new Error(`Large function payload (${totalCodeChars} code chars / ${existingSteps.length} steps); using compact patch mode`);
            try {
                const replacementFirst = await this._modifyFunctionWithPromptReplacementFallback(
                    functionDef,
                    userPrompt,
                    apiKey,
                    patchModeReason
                );
                if (replacementFirst && Array.isArray(replacementFirst.fixedSteps) && replacementFirst.fixedSteps.length > 0) {
                    return replacementFirst;
                }
            } catch (replacementErr) {
                console.warn('modifyFunctionWithPrompt: replacement-first strategy failed, trying patch fallback:', replacementErr?.message || replacementErr);
            }

            try {
                const patchFirst = await this._modifyFunctionWithPromptPatchFallback(
                    functionDef,
                    userPrompt,
                    apiKey,
                    patchModeReason
                );
                if (patchFirst && Array.isArray(patchFirst.fixedSteps) && patchFirst.fixedSteps.length > 0) {
                    return patchFirst;
                }
            } catch (patchErr) {
                console.warn('modifyFunctionWithPrompt: patch-first strategy failed, falling back to full-steps strategy:', patchErr?.message || patchErr);
            }
        }

        try {
        const schema = {
            type: 'OBJECT',
            properties: {
                fixedSteps: {
                    type: 'ARRAY',
                    items: { type: 'OBJECT' }
                },
                updatedDescription: { type: 'STRING' },
                changeSummary: { type: 'STRING' }
            },
            required: ['fixedSteps']
        };
        const compactFunctionDef = this._compactFunctionForEditPrompt(functionDef, {
            maxCodeChars: 4500,
            includeTestCases: false,
            maxTestCases: 0
        });

        const basePrompt = `You are editing an existing browser automation function.

FUNCTION (do not rename):
${JSON.stringify(compactFunctionDef, null, 2)}

USER REQUEST:
${String(userPrompt).trim()}

RULES:
1. Keep function name, inputs, and outputs schema unchanged.
2. Return COMPLETE updated steps in "fixedSteps".
3. Do not add unsupported APIs (no eval, no Function constructor, no page.evaluate, no page.goto, no XMLHttpRequest, no document.cookie, no localStorage, no sessionStorage, no page.waitForSelector).
4. Prefer minimal edits over full rewrites.
5. If current extraction already calls page.executeFunction(savedScraper), preserve that strategy.
6. Keep waits short and avoid unnecessary delays.
7. page.extract accepts only a CSS selector string. Do not call page.extract with an object payload.
8. Keep number of steps unchanged unless the user request clearly requires adding/removing a step.

Return JSON:
{
  "fixedSteps": [...],
  "updatedDescription": "optional improved description",
  "changeSummary": "one-line summary of what changed"
}

IMPORTANT:
- Output JSON only (no markdown, no code fences).
- Keep script code compact and valid JavaScript.`;

        const maxAttempts = 3;
        let prompt = basePrompt;
        let result = null;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                result = await this.callGemini({
                    contents: [{ role: 'user', parts: [{ text: prompt }] }],
                    generationConfig: {
                        responseMimeType: 'application/json',
                        responseJsonSchema: schema,
                        temperature: 0.1,
                        maxOutputTokens: 6144
                    }
                }, apiKey, true, {
                    maxRetries: 4,
                    allowJsonTokenExpansion: true,
                    maxOutputTokensCap: 24576
                });
            } catch (error) {
                const message = String(error?.message || '');
                const isJsonFailure = /invalid json|empty json|malformed|unterminated|unexpected end/i.test(message);
                if (!isJsonFailure || attempt >= maxAttempts) {
                    throw error;
                }
                prompt = `${basePrompt}

RETRY NOTE:
Your previous response was invalid/truncated JSON.
Return ONLY compact JSON with keys fixedSteps, updatedDescription, changeSummary.
Do not include markdown or any commentary.`;
                continue;
            }

            if (!Array.isArray(result?.fixedSteps) || result.fixedSteps.length === 0) {
                throw new Error('AI returned no updated steps');
            }

            const sanitized = this._sanitizeUnsupportedScriptUsage(result.fixedSteps);
            if (sanitized.changed) {
                result.fixedSteps = sanitized.steps;
            }

            const unsupported = this._findUnsupportedScriptUsage(result.fixedSteps);
            if (!unsupported) break;

            if (attempt >= maxAttempts) {
                throw new Error(`AI returned unsupported script operation in fixedSteps: ${unsupported.operation} (step ${unsupported.stepIndex + 1})`);
            }

            prompt = `${basePrompt}

RETRY NOTE:
Your previous response included disallowed operation "${unsupported.operation}" in fixedSteps[${unsupported.stepIndex + 1}].
Regenerate fixedSteps without any disallowed API usage.
Use page.navigate (not page.goto), and pass a selector string to page.extract.`;
        }

        return {
            fixedSteps: result.fixedSteps,
            updatedDescription: typeof result.updatedDescription === 'string' ? result.updatedDescription.trim() : '',
            changeSummary: typeof result.changeSummary === 'string' ? result.changeSummary.trim() : ''
        };
        } catch (error) {
            console.warn('modifyFunctionWithPrompt: primary full-steps strategy failed, trying patch fallback:', error?.message || error);
            try {
                const fallback = await this._modifyFunctionWithPromptPatchFallback(functionDef, userPrompt, apiKey, error);
                if (fallback && Array.isArray(fallback.fixedSteps) && fallback.fixedSteps.length > 0) {
                    return fallback;
                }
            } catch (patchError) {
                console.warn('modifyFunctionWithPrompt: patch fallback failed, trying replacement fallback:', patchError?.message || patchError);
            }

            const replacementFallback = await this._modifyFunctionWithPromptReplacementFallback(functionDef, userPrompt, apiKey, error);
            if (replacementFallback && Array.isArray(replacementFallback.fixedSteps) && replacementFallback.fixedSteps.length > 0) {
                return replacementFallback;
            }

            throw error;
        }
    },

    /**
     * Given a failing function + screenshot + issues, ask AI to generate a targeted fix.
     * Returns corrected steps array + description of what changed.
     * Much faster than regenerating the entire function from scratch.
     *
     * @param {object} functionDef - The function definition that failed
     * @param {object} testResult - Execution result ({success, data, error})
     * @param {string} screenshot - PNG screenshot data URL (or null)
     * @param {string[]} issues - List of issues from verification
     * @param {string} apiKey - Gemini API key
     * @returns {object|null} { fixedSteps: array, fixDescription: string } or null if fix failed
     */
    async generateFunctionFix(functionDef, testResult, screenshot, issues, apiKey, context = {}) {
        const base64Data = screenshot?.replace(/^data:image\/\w+;base64,/, '');
        const trimContext = (value, maxChars = 900) => {
            if (value === undefined || value === null) return '';
            const text = String(value)
                .replace(/\r/g, '')
                .replace(/[ \t]+\n/g, '\n')
                .replace(/[ \t]{2,}/g, ' ')
                .trim();
            if (!text) return '';
            if (text.length <= maxChars) return text;
            return `${text.slice(0, Math.max(0, maxChars - 15))}...[truncated]`;
        };
        const issueList = (Array.isArray(issues) ? issues : [issues]).filter(Boolean);

        // Build context about what's working
        let workingInfo = '';
        if (context.passingTests?.length > 0) {
            workingInfo = `\nWHAT IS ALREADY WORKING (DO NOT BREAK THESE):
${context.passingTests.map(t => `- Test "${t.name}": PASSED. Data sample: ${(JSON.stringify(t.output) || '').substring(0, 500)}`).join('\n')}
`;
        }
        if (context.workingFields?.length > 0) {
            workingInfo += `\nFIELDS THAT WORK CORRECTLY: ${context.workingFields.join(', ')}
FIELDS THAT ARE BROKEN: ${context.brokenFields?.join(', ') || 'unknown'}
ONLY fix the broken fields â€” do NOT touch extraction logic for working fields.
`;
        }

        let diagnosticInfo = '';
        const failureContext = trimContext(context.failureContext, 700);
        if (failureContext) {
            diagnosticInfo += `\nFAILURE CONTEXT:
${failureContext}
`;
        }
        // Structured findings from proactive exploration + enhanced diagnosis
        const structuredFindings = trimContext(context.structuredFindings, 1200);
        if (structuredFindings) {
            diagnosticInfo += `\nPAGE INVESTIGATION (AI visually explored and tested the page):
${structuredFindings}
Use these findings as PRIMARY evidence for what to fix. The investigation
identified actual page elements and selector issues through interactive testing.
`;
        }
        const computerUseDiagnosis = trimContext(context.computerUseDiagnosis, 1200);
        if (computerUseDiagnosis && !structuredFindings) {
            // Only include raw diagnosis if structured findings aren't available (backward compat)
            diagnosticInfo += `\nCOMPUTER-USE DIAGNOSIS (VISUAL INVESTIGATION):
${computerUseDiagnosis}
Use this diagnosis as primary evidence for deciding what to fix.
`;
        }

        const parts = [
            { text: `You are a browser automation expert. A generated function has failed testing.
Fix the function by modifying its steps.

FUNCTION DEFINITION:
${JSON.stringify(functionDef, null, 2)}

TEST RESULT:
- Success: ${testResult?.success}
- Error: ${testResult?.error || 'none'}
- Data returned: ${(JSON.stringify(testResult?.data) || 'undefined').substring(0, 2000)}

ISSUES FOUND:
${issueList.map((issue, i) => `${i + 1}. ${issue}`).join('\n')}
${diagnosticInfo}
${workingInfo}
RULES:
1. Return the COMPLETE corrected steps array (same format as functionDef.steps)
2. Only modify what's broken - don't rewrite working parts
3. CRITICAL: If a script step uses page.executeFunction() to call a saved scraper, KEEP that approach.
   Do NOT replace page.executeFunction() calls with raw DOM selectors - the scraper already works.
   Instead, fix issues by adding scrolling/waiting before the scraper call, or post-processing after it.
4. If some output fields are correct but others are wrong, only fix the broken fields' extraction.
   Do NOT rewrite the entire script - add targeted fixes for the broken fields only.
5. Common fixes: add more scrolling to trigger lazy-loading, add waits for dynamic content,
   click "show more"/"expand"/"see more" buttons before extraction, add post-processing after the main scraper call.
   Keep waits short; avoid long static waits when selector waits or existing sub-functions already handle loading.
6. If a popup/cookie/login modal blocks interactions, add an initial dismissal step
   (close/cancel/accept) before main actions.
7. If extraction is fundamentally wrong on this page, switch to smartScrape or call another saved scraper
   via page.executeFunction() rather than forcing brittle selectors.
8. Keep scraping generation consistent with manual Smart Scrape:
   - Prefer a smartScrape step for list/grid extraction.
   - In script steps, prefer page.executeFunction(existingScraperName) for extraction.
9. If computer-use diagnosis identifies a better target page URL/state, update navigation and scraper placement accordingly.
10. Do NOT change the function name, inputs, or outputs schema
11. Preserve page-type intent:
   - For list/search outputs, do NOT inject product-detail expansion clicks/selectors.
   - Only add expansion-click logic when the function is clearly a detail-page extractor.
12. For workflow/orchestration functions (source = ai-workflow):
   - Do NOT add page.smartScrape() calls.
   - Do NOT add extra page.navigate/page.scroll loops before calling detail sub-functions unless absolutely required.
   - Prefer fixing data mapping and fallback handling over adding heavy navigation logic.
13. Return ONLY a JSON object: { "fixedSteps": [...], "fixDescription": "what was changed" }

CRITICAL SANDBOX RESTRICTIONS - scripts run in a sandboxed iframe:
- NEVER use eval(), Function(), page.evaluate(), or any variant containing "eval" - BLOCKED
- NEVER use page.goto(); use page.navigate(url) instead.
- NEVER use XMLHttpRequest, document.cookie, localStorage, sessionStorage - BLOCKED
- Available page API:
  page.click(selector), page.type(selector, text), page.pressKey(selector, key),
  page.scroll(selectorOrAmount), page.wait(selectorOrTime), page.navigate(url),
  page.extract(selector), page.extractAttribute(selector, attributeName),
  page.getElements(selector), page.executeFunction(name, inputs),
  page.smartScrape(description), page.log(message), page.getCurrentTabContent(maxChars)
- page.extract only accepts a CSS selector string, not an object.
- Do NOT use page.waitForSelector(), page.$(), or page.querySelectorAll() - they are not available.
- Do NOT use document.querySelector/querySelectorAll inside script steps to target the live tab.
- For data extraction, use page.executeFunction(savedScraper) or page.smartScrape().
` }
        ];
        if (base64Data) {
            parts.push({ inline_data: { mime_type: 'image/png', data: base64Data } });
        }

        const body = {
            contents: [{ role: 'user', parts }],
            generationConfig: { responseMimeType: 'application/json', temperature: 0.2 }
        };

        try {
            const result = await this.callGemini(body, apiKey);
            if (result?.fixedSteps && Array.isArray(result.fixedSteps)) {
                const sanitized = this._sanitizeUnsupportedScriptUsage(result.fixedSteps);
                const fixedSteps = sanitized.changed ? sanitized.steps : result.fixedSteps;
                const unsupported = this._findUnsupportedScriptUsage(fixedSteps);
                if (unsupported) {
                    console.warn(`generateFunctionFix: rejected unsupported script operation "${unsupported.operation}" at step ${unsupported.stepIndex + 1}`);
                    return null;
                }
                return { ...result, fixedSteps };
            }
            console.warn('generateFunctionFix: AI response missing fixedSteps array:', result);
            return null;
        } catch (e) {
            console.warn('Function fix generation failed:', e);
            return null;
        }
    }
};

// Expose globally (works in both popup window and service worker contexts)
if (typeof window !== 'undefined') window.AIService = AIService;
if (typeof self !== 'undefined') self.AIService = AIService;

