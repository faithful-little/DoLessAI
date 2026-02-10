/**
 * Computer Use Service
 * Uses Gemini's native Computer Use API for autonomous browser control.
 * 
 * The Computer Use tool provides built-in UI actions (click_at, type_text_at,
 * scroll_document, navigate, etc.) with normalized coordinates (0-999).
 * No custom function declarations needed for core browser actions.
 *
 * COORDINATE SYSTEM:
 * - Gemini Computer Use outputs normalized coordinates (0-999)
 * - Converted to actual pixels at execution time based on screen dimensions
 * - Recommended screen size: 1440x900
 */
const ComputerUseService = {
    MODEL: 'gemini-3-flash-preview',
    API_BASE: 'https://generativelanguage.googleapis.com/v1beta/models',
    MAX_ACTIONS: 50,
    COORDINATE_SCALE: 1000, // Normalized coordinate range (0-999)
    _stopRequested: false,
    _stopReason: '',
    _activeControllers: new Set(),
    _lastScreenshotFailure: '',

    // Recommended screen dimensions for Computer Use
    RECOMMENDED_WIDTH: 1440,
    RECOMMENDED_HEIGHT: 900,

    requestStopAll(reason = 'Stopped by user') {
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

    // ==================== COORDINATE HELPERS ====================

    /**
     * Convert normalized coordinates (0-999) to actual pixels
     */
    denormalizeCoordinates(normalizedX, normalizedY, screenWidth, screenHeight) {
        return {
            x: Math.round((normalizedX / this.COORDINATE_SCALE) * screenWidth),
            y: Math.round((normalizedY / this.COORDINATE_SCALE) * screenHeight)
        };
    },

    async normalizeNavigationUrl(rawUrl, tabId) {
        const url = typeof rawUrl === 'string' ? rawUrl.trim() : '';
        if (!url) return null;

        if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(url)) {
            try {
                return new URL(url).href;
            } catch {
                return null;
            }
        }

        if (url.startsWith('//')) {
            try {
                return new URL(`https:${url}`).href;
            } catch {
                return null;
            }
        }

        if (url.startsWith('/')) {
            try {
                const tab = await chrome.tabs.get(tabId);
                if (!tab?.url) return null;
                return new URL(url, tab.url).href;
            } catch {
                return null;
            }
        }

        try {
            return new URL(`https://${url}`).href;
        } catch {
            return null;
        }
    },

    // ==================== TOOL CONFIGURATION ====================

    /**
     * Build the Computer Use tool config for the API request.
     * Uses the native computer_use tool — no manual function declarations needed.
     * Optionally exclude actions or add custom functions.
     */
    buildToolConfig(options = {}) {
        const {
            excludedFunctions = [],
            customFunctionDeclarations = null
        } = options;

        const tools = [
            {
                computer_use: {
                    environment: 'ENVIRONMENT_BROWSER',
                    ...(excludedFunctions.length > 0 && {
                        excluded_predefined_functions: excludedFunctions
                    })
                }
            }
        ];

        // Add custom function declarations if provided
        if (customFunctionDeclarations) {
            tools.push({
                function_declarations: customFunctionDeclarations
            });
        }

        return tools;
    },

    /**
     * Custom function declarations for actions beyond built-in Computer Use.
     * For example: extract_data and task_complete are not built-in actions.
     */
    CUSTOM_FUNCTION_DECLARATIONS: [
        {
            name: "extract_data",
            description: "Extract visible data from the current page view. Describe what data to extract.",
            parameters: {
                type: "OBJECT",
                properties: {
                    description: { type: "STRING", description: "What data to extract from the visible page" },
                    format: { type: "STRING", enum: ["text", "json", "list"], description: "Output format" }
                },
                required: ["description", "format"]
            }
        },
        {
            name: "task_complete",
            description: "Signal that the task is complete. Call this when the goal is achieved.",
            parameters: {
                type: "OBJECT",
                properties: {
                    success: { type: "BOOLEAN", description: "Whether the task was successful" },
                    result: { type: "STRING", description: "Final result or extracted data" },
                    summary: { type: "STRING", description: "Brief summary of what was accomplished" }
                },
                required: ["success", "summary"]
            }
        }
    ],

    // ==================== SYSTEM PROMPT ====================

    buildSystemPrompt(taskDescription) {
        return `You are an AI browser automation agent. You can see the current webpage screenshot and execute actions to complete the user's task.

TASK: ${taskDescription}

You have access to the Computer Use tool which provides built-in browser actions:
- click_at(x, y) — Click at normalized coordinates (0-999 scale)
- type_text_at(x, y, text, press_enter, clear_before_typing) — Type text at coordinates
- scroll_document(direction) — Scroll "up", "down", "left", or "right"
- scroll_at(x, y, direction, magnitude) — Scroll at a specific element
- navigate(url) — Navigate to a URL
- go_back() — Go to previous page
- go_forward() — Go to next page
- key_combination(keys) — Press keyboard keys (e.g., "Enter", "Control+C")
- hover_at(x, y) — Hover at coordinates
- wait_5_seconds() — Wait for content to load
- drag_and_drop(x, y, destination_x, destination_y) — Drag and drop
- search() — Go to default search engine
- open_web_browser() — Open the browser

You also have custom functions:
- extract_data(description, format) — Extract data from the visible page
- task_complete(success, result, summary) — Signal task completion

EXECUTION STRATEGY:
1. Analyze the screenshot to understand the current page state
2. Identify the element you need to interact with
3. Estimate its position in normalized coordinates (0-999 scale)
4. Execute ONE action at a time, then wait for the next screenshot
5. After each action, verify the result before proceeding
6. If an action fails, try an alternative approach
7. When the task is complete, call task_complete with the results

IMPORTANT:
- Execute ONE action per turn, then analyze the new screenshot
- Be precise with coordinates — look carefully at element positions
- Call task_complete when finished`;
    },

    // ==================== DEBUG VISUALIZATION ====================

    /**
     * Create a debug image showing where the click occurred
     */
    async createClickVisualization(screenshotDataUrl, normalizedX, normalizedY, screenWidth, screenHeight, description) {
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = img.width;
                canvas.height = img.height;
                const ctx = canvas.getContext('2d');

                ctx.drawImage(img, 0, 0);

                const actualX = (normalizedX / this.COORDINATE_SCALE) * img.width;
                const actualY = (normalizedY / this.COORDINATE_SCALE) * img.height;

                // Crosshair + circle
                ctx.strokeStyle = '#FF0000';
                ctx.lineWidth = 3;
                ctx.beginPath();
                ctx.arc(actualX, actualY, 25, 0, 2 * Math.PI);
                ctx.stroke();

                ctx.fillStyle = 'rgba(255, 0, 0, 0.5)';
                ctx.beginPath();
                ctx.arc(actualX, actualY, 8, 0, 2 * Math.PI);
                ctx.fill();

                ctx.beginPath();
                ctx.moveTo(actualX - 35, actualY);
                ctx.lineTo(actualX + 35, actualY);
                ctx.moveTo(actualX, actualY - 35);
                ctx.lineTo(actualX, actualY + 35);
                ctx.stroke();

                ctx.font = 'bold 14px Arial';
                ctx.fillStyle = '#FF0000';
                ctx.strokeStyle = '#FFFFFF';
                ctx.lineWidth = 3;
                const label = `${description} (${normalizedX}, ${normalizedY})`;
                ctx.strokeText(label, actualX + 30, actualY - 10);
                ctx.fillText(label, actualX + 30, actualY - 10);

                resolve(canvas.toDataURL('image/jpeg', 0.8));
            };
            img.src = screenshotDataUrl;
        });
    },

    // ==================== MAIN EXECUTION LOOP ====================

    /**
     * Execute an autonomous task with Gemini Computer Use API.
     *
     * @param {string} taskDescription - Natural language task description
     * @param {string} apiKey - Gemini API key
     * @param {number} tabId - Chrome tab ID to control
     * @param {object} options - { onProgress, onDebugImage, screenWidth, screenHeight, excludedFunctions, maxActions }
     * @returns {object} { success, actions, result, debugImages }
     */
    async executeAutonomousTask(taskDescription, apiKey, tabId, options = {}) {
        const {
            onProgress = () => {},
            onDebugImage = () => {},
            onScreenshot = () => {},
            excludedFunctions = [],
            maxActions,
            diagnosticActionLimit = null,
            collectDebugImages = true,
            shouldAbort = () => false
        } = options;
        const configuredMaxActions = Number(maxActions);
        let actionBudget = Number.isFinite(configuredMaxActions)
            ? Math.max(1, Math.floor(configuredMaxActions))
            : this.MAX_ACTIONS;
        const configuredDiagnosticLimit = Number(diagnosticActionLimit);
        if (Number.isFinite(configuredDiagnosticLimit) && configuredDiagnosticLimit > 0) {
            actionBudget = Math.min(actionBudget, Math.max(1, Math.floor(configuredDiagnosticLimit)));
        }

        const actions = [];
        const debugImages = [];
        let contents = [];
        const stopError = () => this._stopReason || 'Stopped by user';
        const isStopped = () => this._stopRequested || (typeof shouldAbort === 'function' && shouldAbort());

        if (isStopped()) {
            return { success: false, error: stopError(), actions, debugImages, aborted: true };
        }

        onProgress('Starting autonomous agent...');

        // Get actual viewport dimensions - CRITICAL for correct coordinate mapping.
        // document.elementFromPoint() uses CSS viewport coordinates, and the screenshot
        // from captureVisibleTab represents exactly the viewport, so we must denormalize
        // to the real viewport size, not a hardcoded value.
        const viewport = await this.getViewportDimensions(tabId);
        if (isStopped()) {
            return { success: false, error: stopError(), actions, debugImages, aborted: true };
        }
        const screenWidth = viewport.width;
        const screenHeight = viewport.height;
        onProgress(`Viewport: ${screenWidth}x${screenHeight}`);

        // Take initial screenshot
        const initialScreenshot = await this.captureTabScreenshot(tabId);
        if (!initialScreenshot) {
            const detail = String(this._lastScreenshotFailure || '').trim();
            const hint = 'Keep the target tab active and its window visible (not minimized/covered), then retry.';
            const withDetail = detail ? `Failed to capture initial screenshot: ${detail}` : 'Failed to capture initial screenshot';
            return { success: false, error: `${withDetail}. ${hint}`, actions, debugImages };
        }
        if (isStopped()) {
            return { success: false, error: stopError(), actions, debugImages, aborted: true };
        }

        const tab = await chrome.tabs.get(tabId);
        const base64Data = initialScreenshot.replace(/^data:image\/\w+;base64,/, '');

        // Log and forward the initial screenshot
        const initialSizeKB = Math.round(base64Data.length * 3 / 4 / 1024);
        onProgress(`📸 Initial screenshot: ${initialSizeKB}KB (${tab.url})`);
        onScreenshot(initialScreenshot, 'initial', { url: tab.url, turn: 0 });

        // Build initial contents with the task prompt + screenshot
        contents.push({
            role: 'user',
            parts: [
                { text: this.buildSystemPrompt(taskDescription) },
                {
                    inline_data: {
                        mime_type: 'image/png',
                        data: base64Data
                    }
                }
            ]
        });

        // Build tool config with native Computer Use + custom functions
        const tools = this.buildToolConfig({
            excludedFunctions,
            customFunctionDeclarations: this.CUSTOM_FUNCTION_DECLARATIONS
        });

        let noCandidateStreak = 0;
        let noFunctionCallStreak = 0;

        for (let turn = 0; turn < actionBudget; turn++) {
            if (isStopped()) {
                return { success: false, error: stopError(), actions, debugImages, totalTurns: turn, aborted: true };
            }
            onProgress(`Turn ${turn + 1}: AI analyzing page...`);

            // Call Gemini API with Computer Use tool
            const response = await this.callGeminiComputerUse(contents, tools, apiKey);

            if (!response || response.error) {
                return { success: false, error: response?.error || 'API call failed', actions, debugImages };
            }

            const candidate = response.candidates?.[0];
            if (!candidate) {
                noCandidateStreak += 1;
                const blockReason = response?.promptFeedback?.blockReason;
                if (blockReason) {
                    return { success: false, error: `Model response blocked: ${blockReason}`, actions, debugImages };
                }
                if (noCandidateStreak < 3) {
                    onProgress('No candidate in response, retrying...');
                    await new Promise(r => setTimeout(r, 800));
                    continue;
                }
                return { success: false, error: 'No candidate in response', actions, debugImages };
            }
            noCandidateStreak = 0;

            // Detect thought-loop: if the model generates a very long text-only response
            // with repetitive content, it's stuck in a loop. Break out early.
            const textParts = (candidate.content?.parts || []).filter(p => p.text);
            if (textParts.length > 0) {
                const fullText = textParts.map(p => p.text).join('');
                if (this.detectThoughtLoop(fullText)) {
                    onProgress('Detected repetitive thought loop, resetting...');
                    // Remove the looping response and inject a corrective prompt
                    contents.push({
                        role: 'user',
                        parts: [{ text: 'You seem stuck. Please look at the screenshot carefully and execute exactly ONE action. Do not overthink.' }]
                    });
                    continue;
                }
            }

            // Append model response to conversation history
            contents.push(candidate.content);

            // Extract function calls from response
            const functionCalls = this.extractFunctionCalls(response);

            if (functionCalls.length === 0) {
                // Text-only response - model may be done or asking a question
                const textResponse = this.extractTextResponse(response);
                onProgress(`AI response: ${textResponse}`);

                const completionFromText = this.extractTaskCompleteFromText(textResponse);
                if (completionFromText) {
                    onProgress(completionFromText.success ? 'Task completed!' : 'Task failed');
                    return {
                        success: completionFromText.success,
                        result: completionFromText.result,
                        summary: completionFromText.summary,
                        actions,
                        debugImages,
                        totalTurns: turn + 1
                    };
                }

                noFunctionCallStreak += 1;
                if (noFunctionCallStreak >= 2) {
                    return {
                        success: false,
                        error: 'Model did not issue actionable function calls',
                        actions,
                        debugImages,
                        totalTurns: turn + 1
                    };
                }

                contents.push({
                    role: 'user',
                    parts: [{ text: 'Respond with exactly one tool action function call, or call task_complete if the task is done.' }]
                });
                continue;
            }
            noFunctionCallStreak = 0;

            // Execute each function call and collect results
            const functionResponses = [];

            for (const funcCall of functionCalls) {
                if (isStopped()) {
                    return { success: false, error: stopError(), actions, debugImages, totalTurns: turn + 1, aborted: true };
                }
                const { name, args } = funcCall;
                onProgress(`Executing: ${name}${args.description ? ` - ${args.description}` : ''}`);

                // Check for safety_decision requiring confirmation
                if (args.safety_decision?.decision === 'require_confirmation') {
                    onProgress(`⚠️ Safety confirmation required: ${args.safety_decision.explanation}`);
                    // In a production app, prompt the user here.
                    // For now, we skip the action.
                    functionResponses.push({
                        name,
                        response: { error: 'Action requires user confirmation', url: tab.url }
                    });
                    continue;
                }

                // Record action
                actions.push({
                    action: name,
                    args: { ...args },
                    timestamp: Date.now(),
                    turn: turn + 1
                });

                // Debug visualization for coordinate-based actions
                if (collectDebugImages && (name === 'click_at' || name === 'type_text_at' || name === 'hover_at') && args.x !== undefined) {
                    const currentScreenshot = await this.captureTabScreenshot(tabId);
                    if (currentScreenshot) {
                        const debugImage = await this.createClickVisualization(
                            currentScreenshot,
                            args.x,
                            args.y,
                            screenWidth,
                            screenHeight,
                            args.description || name
                        );
                        debugImages.push({
                            action: name,
                            description: args.description,
                            coordinates: { x: args.x, y: args.y },
                            image: debugImage,
                            turn: turn + 1
                        });
                        onDebugImage(debugImage, name, args);
                    }
                }

                // Check for task completion (custom function)
                if (name === 'task_complete') {
                    onProgress(args.success ? '✅ Task completed!' : '❌ Task failed');
                    return {
                        success: args.success,
                        result: args.result,
                        summary: args.summary,
                        actions,
                        debugImages,
                        totalTurns: turn + 1
                    };
                }

                // Capture URL before action for navigation detection
                let preActionUrl = '';
                try {
                    const preTab = await chrome.tabs.get(tabId);
                    preActionUrl = preTab.url;
                } catch (e) { /* ignore */ }

                // Execute the action
                const result = await this.executeAction(name, args, tabId, screenWidth, screenHeight);
                if (isStopped()) {
                    return { success: false, error: stopError(), actions, debugImages, totalTurns: turn + 1, aborted: true };
                }

                if (result.error) {
                    onProgress(`Action error: ${result.error}`);
                }

                // Wait for page to settle after action.
                // Navigation-triggering actions need longer waits for page load.
                const isNavAction = name === 'navigate' || name === 'search' ||
                    (name === 'type_text_at' && args.press_enter !== false) ||
                    name === 'click_at' || name === 'go_back' || name === 'go_forward';

                if (isNavAction) {
                    await this.waitForPageLoad(tabId, 5000, preActionUrl);
                } else {
                    await new Promise(r => setTimeout(r, 1000));
                }

                // Capture new screenshot + URL for function response
                const postActionScreenshot = await this.captureTabScreenshot(tabId);
                const currentTab = await chrome.tabs.get(tabId);
                const postBase64 = postActionScreenshot
                    ? postActionScreenshot.replace(/^data:image\/\w+;base64,/, '')
                    : null;

                // Log and forward the post-action screenshot
                if (postBase64) {
                    const postSizeKB = Math.round(postBase64.length * 3 / 4 / 1024);
                    onProgress(`📸 Post-action screenshot: ${postSizeKB}KB (${currentTab.url})`);
                    onScreenshot(postActionScreenshot, `after_${name}`, {
                        url: currentTab.url, turn: turn + 1, action: name
                    });
                } else {
                    const detail = String(this._lastScreenshotFailure || '').trim();
                    const hint = 'Keep the target tab active and visible.';
                    onProgress(`⚠️ Failed to capture post-action screenshot${detail ? `: ${detail}` : ''}. ${hint}`);
                }

                // Build function response with screenshot (per Gemini Computer Use spec)
                const frResponse = {
                    url: currentTab.url,
                    ...(result.error ? { error: result.error } : {}),
                    // Include safety_acknowledgement if we confirmed a safety decision
                    ...(args.safety_decision ? { safety_acknowledgement: 'true' } : {})
                };

                const frParts = [];
                if (postBase64) {
                    frParts.push({
                        inline_data: {
                            mime_type: 'image/png',
                            data: postBase64
                        }
                    });
                }

                functionResponses.push({
                    name,
                    response: frResponse,
                    parts: frParts
                });
            }

            // Send all function responses back to the model in the next user turn
            // Computer Use API requires screenshots as separate inline_data parts
            // alongside function_response parts (not nested inside them)
            if (functionResponses.length > 0) {
                const responseParts = [];
                for (const fr of functionResponses) {
                    responseParts.push({
                        function_response: {
                            name: fr.name,
                            response: fr.response
                        }
                    });
                    // Add screenshot as separate inline_data part (required by Computer Use API)
                    if (fr.parts && fr.parts.length > 0) {
                        responseParts.push(...fr.parts);
                    }
                }
                contents.push({
                    role: 'user',
                    parts: responseParts
                });
            }
        }

        return {
            success: false,
            error: 'Max actions reached without task completion',
            actions,
            debugImages,
            totalTurns: actionBudget
        };
    },

    // ==================== ACTION EXECUTION ====================

    /**
     * Execute a Computer Use action in the target tab.
     * Handles both built-in Computer Use actions and custom functions.
     */
    async executeAction(name, args, tabId, screenWidth, screenHeight) {
        try {
            switch (name) {
                // ---- Built-in Computer Use Actions ----

                case 'click_at': {
                    const { x, y } = this.denormalizeCoordinates(args.x, args.y, screenWidth, screenHeight);
                    const [result] = await chrome.scripting.executeScript({
                        target: { tabId },
                        func: (px, py) => {
                            const el = document.elementFromPoint(px, py);
                            if (el) {
                                // Full mouse event sequence for proper SPA handling
                                const opts = { bubbles: true, cancelable: true, view: window, clientX: px, clientY: py };
                                el.dispatchEvent(new MouseEvent('mousedown', opts));
                                el.dispatchEvent(new MouseEvent('mouseup', opts));
                                el.dispatchEvent(new MouseEvent('click', opts));
                                // Also try native click for links/buttons
                                if (typeof el.click === 'function') el.click();
                                return { success: true, element: el.tagName, id: el.id, className: String(el.className).slice(0, 50) };
                            }
                            return { success: false, error: 'No element at coordinates' };
                        },
                        args: [x, y]
                    });
                    return result?.result || { error: 'Script execution failed' };
                }

                case 'type_text_at': {
                    const { x, y } = this.denormalizeCoordinates(args.x, args.y, screenWidth, screenHeight);
                    const text = args.text || '';
                    const pressEnter = args.press_enter !== false; // default true per API spec
                    const clearFirst = args.clear_before_typing !== false; // default true per API spec
                    const [result] = await chrome.scripting.executeScript({
                        target: { tabId },
                        func: (px, py, txt, enter, clear) => {
                            const el = document.elementFromPoint(px, py);
                            if (!el) return { success: false, error: 'No element at coordinates' };

                            // Find the actual input element (might be nested)
                            const inputEl = el.closest('input, textarea, [contenteditable]') ||
                                            el.querySelector('input, textarea, [contenteditable]') || el;

                            // Click and focus
                            inputEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: px, clientY: py }));
                            inputEl.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: px, clientY: py }));
                            inputEl.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: px, clientY: py }));
                            inputEl.focus();

                            if (clear) {
                                if (inputEl.select) inputEl.select();
                                document.execCommand('selectAll');
                                document.execCommand('delete');
                            }

                            // Use native setter to bypass React's controlled input detection
                            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                                window.HTMLInputElement.prototype, 'value'
                            )?.set;
                            const nativeTextareaValueSetter = Object.getOwnPropertyDescriptor(
                                window.HTMLTextAreaElement.prototype, 'value'
                            )?.set;

                            if (inputEl.tagName === 'TEXTAREA' && nativeTextareaValueSetter) {
                                nativeTextareaValueSetter.call(inputEl, txt);
                            } else if (nativeInputValueSetter && inputEl.value !== undefined) {
                                nativeInputValueSetter.call(inputEl, txt);
                            } else if (inputEl.isContentEditable) {
                                inputEl.textContent = txt;
                            } else {
                                inputEl.value = txt;
                            }

                            // Fire events in the correct order for React/Angular/Vue
                            inputEl.dispatchEvent(new Event('input', { bubbles: true }));
                            inputEl.dispatchEvent(new Event('change', { bubbles: true }));

                            if (enter) {
                                inputEl.dispatchEvent(new KeyboardEvent('keydown', {
                                    key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true
                                }));
                                inputEl.dispatchEvent(new KeyboardEvent('keypress', {
                                    key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true
                                }));
                                inputEl.dispatchEvent(new KeyboardEvent('keyup', {
                                    key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true
                                }));
                                // Also try submitting via form if present
                                const form = inputEl.closest('form');
                                if (form) {
                                    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
                                }
                            }
                            return { success: true, element: inputEl.tagName };
                        },
                        args: [x, y, text, pressEnter, clearFirst]
                    });
                    return result?.result || { error: 'Script execution failed' };
                }

                case 'hover_at': {
                    const { x, y } = this.denormalizeCoordinates(args.x, args.y, screenWidth, screenHeight);
                    const [result] = await chrome.scripting.executeScript({
                        target: { tabId },
                        func: (px, py) => {
                            const el = document.elementFromPoint(px, py);
                            if (el) {
                                el.dispatchEvent(new MouseEvent('mouseover', {
                                    bubbles: true, clientX: px, clientY: py
                                }));
                                el.dispatchEvent(new MouseEvent('mouseenter', {
                                    bubbles: false, clientX: px, clientY: py
                                }));
                                return { success: true, element: el.tagName };
                            }
                            return { success: false, error: 'No element at coordinates' };
                        },
                        args: [x, y]
                    });
                    return result?.result || { error: 'Script execution failed' };
                }

                case 'scroll_document': {
                    const scrollMap = { down: [0, 500], up: [0, -500], left: [-500, 0], right: [500, 0] };
                    const [dx, dy] = scrollMap[args.direction] || [0, 500];
                    const [result] = await chrome.scripting.executeScript({
                        target: { tabId },
                        func: (scrollX, scrollY) => {
                            window.scrollBy(scrollX, scrollY);
                            return { success: true };
                        },
                        args: [dx, dy]
                    });
                    return result?.result || { error: 'Scroll failed' };
                }

                case 'scroll_at': {
                    const { x, y } = this.denormalizeCoordinates(args.x, args.y, screenWidth, screenHeight);
                    const magnitude = args.magnitude || 800;
                    const pixelMagnitude = Math.round((magnitude / this.COORDINATE_SCALE) * screenHeight);
                    const dirMap = { down: [0, 1], up: [0, -1], left: [-1, 0], right: [1, 0] };
                    const [mx, my] = dirMap[args.direction] || [0, 1];
                    const [result] = await chrome.scripting.executeScript({
                        target: { tabId },
                        func: (px, py, deltaX, deltaY) => {
                            const el = document.elementFromPoint(px, py);
                            if (el) {
                                el.dispatchEvent(new WheelEvent('wheel', {
                                    bubbles: true, deltaX, deltaY, clientX: px, clientY: py
                                }));
                                return { success: true };
                            }
                            window.scrollBy(deltaX, deltaY);
                            return { success: true };
                        },
                        args: [x, y, mx * pixelMagnitude, my * pixelMagnitude]
                    });
                    return result?.result || { error: 'Scroll failed' };
                }

                case 'navigate': {
                    const url = await this.normalizeNavigationUrl(args.url, tabId);
                    if (!url) return { success: false, error: `Invalid navigation URL: ${args.url}` };
                    await chrome.tabs.update(tabId, { url });
                    await new Promise(r => setTimeout(r, 2000)); // Wait for navigation
                    return { success: true };
                }

                case 'go_back': {
                    const [result] = await chrome.scripting.executeScript({
                        target: { tabId },
                        func: () => { window.history.back(); return { success: true }; }
                    });
                    await new Promise(r => setTimeout(r, 1000));
                    return result?.result || { error: 'Go back failed' };
                }

                case 'go_forward': {
                    const [result] = await chrome.scripting.executeScript({
                        target: { tabId },
                        func: () => { window.history.forward(); return { success: true }; }
                    });
                    await new Promise(r => setTimeout(r, 1000));
                    return result?.result || { error: 'Go forward failed' };
                }

                case 'key_combination': {
                    const keys = args.keys || '';
                    const [result] = await chrome.scripting.executeScript({
                        target: { tabId },
                        func: (keyCombo) => {
                            const parts = keyCombo.split('+').map(k => k.trim());
                            const key = parts[parts.length - 1];
                            const modifiers = parts.slice(0, -1).map(m => m.toLowerCase());
                            document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {
                                key,
                                code: key,
                                ctrlKey: modifiers.includes('control') || modifiers.includes('ctrl'),
                                shiftKey: modifiers.includes('shift'),
                                altKey: modifiers.includes('alt'),
                                metaKey: modifiers.includes('meta') || modifiers.includes('command'),
                                bubbles: true,
                                cancelable: true
                            }));
                            return { success: true };
                        },
                        args: [keys]
                    });
                    return result?.result || { error: 'Key combination failed' };
                }

                case 'drag_and_drop': {
                    const from = this.denormalizeCoordinates(args.x, args.y, screenWidth, screenHeight);
                    const to = this.denormalizeCoordinates(args.destination_x, args.destination_y, screenWidth, screenHeight);
                    const [result] = await chrome.scripting.executeScript({
                        target: { tabId },
                        func: (fx, fy, tx, ty) => {
                            const el = document.elementFromPoint(fx, fy);
                            if (!el) return { success: false, error: 'No element at source' };
                            el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: fx, clientY: fy }));
                            el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: tx, clientY: ty }));
                            const target = document.elementFromPoint(tx, ty) || el;
                            target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: tx, clientY: ty }));
                            target.dispatchEvent(new MouseEvent('drop', { bubbles: true, clientX: tx, clientY: ty }));
                            return { success: true };
                        },
                        args: [from.x, from.y, to.x, to.y]
                    });
                    return result?.result || { error: 'Drag and drop failed' };
                }

                case 'open_web_browser': {
                    // Browser is already open in extension context
                    return { success: true };
                }

                case 'search': {
                    await chrome.tabs.update(tabId, { url: 'https://www.google.com' });
                    await new Promise(r => setTimeout(r, 2000));
                    return { success: true };
                }

                case 'wait_5_seconds': {
                    await new Promise(r => setTimeout(r, 5000));
                    return { success: true };
                }

                // ---- Custom Functions ----

                case 'extract_data': {
                    // Handled by AI vision — the model reads the screenshot
                    return { success: true, note: 'Data extraction handled by AI vision' };
                }

                default:
                    return { error: `Unknown action: ${name}` };
            }
        } catch (e) {
            return { error: e.message };
        }
    },

    // ==================== PAGE LOAD HELPERS ====================

    /**
     * Wait for the tab to finish loading after a navigation-triggering action.
     *
     * Two-phase approach:
     * Phase 1: Wait for navigation to START (URL changes or status goes to 'loading')
     * Phase 2: Wait for navigation to COMPLETE (status returns to 'complete')
     *
     * This prevents capturing a screenshot of the OLD page when the new page
     * hasn't started loading yet.
     */
    async waitForPageLoad(tabId, timeout = 5000, preActionUrl = '') {
        const start = Date.now();
        const oldUrl = preActionUrl;

        // Phase 1: Wait for navigation to START (up to 2s)
        // Look for either URL change or tab status going to 'loading'
        let navigationDetected = false;
        while (Date.now() - start < Math.min(timeout, 2000)) {
            await new Promise(r => setTimeout(r, 200));
            try {
                const tab = await chrome.tabs.get(tabId);
                if (tab.status === 'loading' || tab.url !== oldUrl) {
                    navigationDetected = true;
                    break;
                }
            } catch (e) {
                break;
            }
        }

        if (!navigationDetected) {
            // No navigation detected — might be an in-page action (SPA)
            // Still give a short settle time for JS rendering
            await new Promise(r => setTimeout(r, 1000));
            return;
        }

        // Phase 2: Wait for navigation to COMPLETE
        while (Date.now() - start < timeout) {
            try {
                const tab = await chrome.tabs.get(tabId);
                if (tab.status === 'complete') {
                    // Extra settle time after load for JS rendering
                    await new Promise(r => setTimeout(r, 800));
                    return;
                }
            } catch (e) {
                break;
            }
            await new Promise(r => setTimeout(r, 300));
        }
        // If we timed out, give a final settle
        await new Promise(r => setTimeout(r, 500));
    },

    // ==================== VIEWPORT HELPERS ====================

    /**
     * Get the actual CSS viewport dimensions of the tab.
     * This is critical because document.elementFromPoint() uses viewport coordinates,
     * not arbitrary screen dimensions. The screenshot from captureVisibleTab represents
     * exactly this viewport, so the model's normalized coordinates must map to it.
     */
    async getViewportDimensions(tabId) {
        try {
            const [result] = await chrome.scripting.executeScript({
                target: { tabId },
                func: () => ({
                    width: window.innerWidth,
                    height: window.innerHeight
                })
            });
            if (result?.result?.width && result?.result?.height) {
                return result.result;
            }
        } catch (e) {
            console.error('Failed to get viewport dimensions:', e);
        }
        // Fallback to recommended dimensions
        return { width: this.RECOMMENDED_WIDTH, height: this.RECOMMENDED_HEIGHT };
    },

    // ==================== API HELPERS ====================

    async captureTabScreenshot(tabId) {
        try {
            const tab = await chrome.tabs.get(tabId);
            const win = await chrome.windows.get(tab.windowId);
            this._lastScreenshotFailure = '';
            if (win?.state === 'minimized') {
                this._lastScreenshotFailure = 'Browser window is minimized';
            }
            await chrome.tabs.update(tabId, { active: true });
            await chrome.windows.update(tab.windowId, { focused: true });
            await new Promise(r => setTimeout(r, 300));

            return new Promise((resolve) => {
                chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }, (dataUrl) => {
                    if (chrome.runtime.lastError) {
                        this._lastScreenshotFailure = chrome.runtime.lastError.message || 'captureVisibleTab failed';
                        resolve(null);
                        return;
                    }
                    if (!dataUrl) {
                        this._lastScreenshotFailure = 'captureVisibleTab returned empty image';
                        resolve(null);
                        return;
                    }
                    this._lastScreenshotFailure = '';
                    resolve(dataUrl);
                });
            });
        } catch (e) {
            this._lastScreenshotFailure = e?.message || 'Screenshot capture failed';
            console.error('Screenshot capture failed:', e);
            return null;
        }
    },

    /**
     * Call Gemini API with the native Computer Use tool.
     */
    async callGeminiComputerUse(contents, tools, apiKey) {
        const url = `${this.API_BASE}/${this.MODEL}:generateContent?key=${apiKey}`;

        const requestBody = {
            contents,
            tools,
            generationConfig: {
                temperature: 0.2,
                maxOutputTokens: 2048
            }
        };

        try {
            if (this._stopRequested) {
                return { error: this._stopReason || 'Stopped by user' };
            }
            const controller = new AbortController();
            this._activeControllers.add(controller);
            let response;
            try {
                response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(requestBody),
                    signal: controller.signal
                });
            } finally {
                this._activeControllers.delete(controller);
            }

            if (!response.ok) {
                const error = await response.json();
                return { error: error.error?.message || `API request failed (${response.status})` };
            }

            return await response.json();
        } catch (e) {
            if (e?.name === 'AbortError') {
                return { error: this._stopReason || 'Stopped by user' };
            }
            return { error: e.message };
        }
    },

    extractFunctionCalls(response) {
        const calls = [];
        const parts = response?.candidates?.[0]?.content?.parts || [];
        for (const part of parts) {
            const fc = part.function_call || part.functionCall;
            if (fc) {
                calls.push({ name: fc.name, args: fc.args || {} });
            }
        }
        return calls;
    },

    extractTextResponse(response) {
        const parts = response?.candidates?.[0]?.content?.parts || [];
        return parts.filter(p => p.text).map(p => p.text).join(' ');
    },

    extractTaskCompleteFromText(text) {
        if (!text || typeof text !== 'string') return null;

        let payload = text.trim();
        const fenced = payload.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (fenced?.[1]) {
            payload = fenced[1].trim();
        }

        let parsed;
        try {
            parsed = JSON.parse(payload);
        } catch {
            return null;
        }

        const actionName = String(parsed?.action || parsed?.name || '').trim();
        if (actionName !== 'task_complete') return null;

        let actionInput = parsed?.action_input ?? parsed?.args ?? parsed;
        if (typeof actionInput === 'string') {
            try {
                actionInput = JSON.parse(actionInput);
            } catch {
                actionInput = { result: actionInput };
            }
        }

        const success = actionInput?.success !== false;
        const result = actionInput?.result ?? parsed?.result ?? '';
        const summary = actionInput?.summary || parsed?.summary || parsed?.thought || (success ? 'Task completed' : 'Task failed');

        return { success, result, summary };
    },

    /**
     * Detect if the model is stuck in a repetitive thought loop.
     * Looks for patterns like repeated phrases or sentences.
     */
    detectThoughtLoop(text) {
        if (!text || text.length < 200) return false;

        // Method 1: Exact line dedup — catches copy-paste repetition
        const lines = text.split(/[\n.!?]+/).map(l => l.trim()).filter(l => l.length > 20);
        if (lines.length >= 5) {
            const seen = {};
            let repeats = 0;
            for (const line of lines) {
                const normalized = line.replace(/\s+/g, ' ').toLowerCase();
                seen[normalized] = (seen[normalized] || 0) + 1;
                if (seen[normalized] > 1) repeats++;
            }
            if ((repeats / lines.length) > 0.4) return true;
        }

        // Method 2: Keyword frequency — catches "Wait, I'll use..." style loops
        // where each line is slightly different but uses the same phrases
        const keywords = ['wait', "i'll", "actually", "let me", "let's"];
        let keywordHits = 0;
        const lowerText = text.toLowerCase();
        for (const kw of keywords) {
            const regex = new RegExp(kw, 'gi');
            const matches = lowerText.match(regex);
            if (matches) keywordHits += matches.length;
        }
        // If indecisive keywords appear more than 15 times, it's a loop
        if (keywordHits > 15) return true;

        // Method 3: Sheer length without action — if the text-only response
        // is extremely long (>2000 chars), the model is overthinking
        if (text.length > 2000 && lines.length > 10) return true;

        return false;
    },

    // ==================== CONVERT TO REUSABLE FUNCTION ====================

    /**
     * Convert recorded actions to a reusable function definition
     */
    convertActionsToFunction(actions, taskDescription, startUrl) {
        const steps = actions
            .filter(a => a.action !== 'task_complete' && a.action !== 'extract_data')
            .map((action) => {
                switch (action.action) {
                    case 'click_at':
                        return {
                            type: 'coordinateClick',
                            normalizedX: action.args.x,
                            normalizedY: action.args.y,
                            description: action.args.description || 'Click',
                            timeout: 5000
                        };
                    case 'type_text_at':
                        return {
                            type: 'coordinateType',
                            normalizedX: action.args.x,
                            normalizedY: action.args.y,
                            value: action.args.text,
                            pressEnter: action.args.press_enter !== false,
                            clearFirst: action.args.clear_before_typing !== false,
                            description: action.args.description || 'Type text',
                            timeout: 5000
                        };
                    case 'scroll_document':
                        return {
                            type: 'scroll',
                            direction: action.args.direction,
                            description: `Scroll ${action.args.direction}`
                        };
                    case 'scroll_at':
                        return {
                            type: 'scrollAt',
                            normalizedX: action.args.x,
                            normalizedY: action.args.y,
                            direction: action.args.direction,
                            magnitude: action.args.magnitude || 800,
                            description: `Scroll at element ${action.args.direction}`
                        };
                    case 'navigate':
                        return {
                            type: 'navigate',
                            url: action.args.url,
                            description: `Navigate to ${action.args.url}`
                        };
                    case 'key_combination':
                        return {
                            type: 'keyCombo',
                            keys: action.args.keys,
                            description: `Press ${action.args.keys}`
                        };
                    case 'go_back':
                        return { type: 'goBack', description: 'Go back' };
                    case 'go_forward':
                        return { type: 'goForward', description: 'Go forward' };
                    case 'hover_at':
                        return {
                            type: 'hover',
                            normalizedX: action.args.x,
                            normalizedY: action.args.y,
                            description: 'Hover'
                        };
                    case 'wait_5_seconds':
                        return { type: 'wait', timeout: 5000, description: 'Wait for page' };
                    case 'drag_and_drop':
                        return {
                            type: 'dragAndDrop',
                            fromX: action.args.x,
                            fromY: action.args.y,
                            toX: action.args.destination_x,
                            toY: action.args.destination_y,
                            description: 'Drag and drop'
                        };
                    default:
                        return null;
                }
            })
            .filter(Boolean);

        const completeAction = actions.find(a => a.action === 'task_complete');

        return {
            name: this.generateFunctionName(taskDescription),
            description: taskDescription,
            startUrl,
            urlPatterns: [new URL(startUrl).origin + '/*'],
            inputs: [],
            outputs: completeAction?.args?.result ? { description: 'Extracted data', type: 'json' } : null,
            steps,
            source: 'computer-use',
            createdAt: new Date().toISOString()
        };
    },

    generateFunctionName(description) {
        return description
            .replace(/[^a-zA-Z0-9\s]/g, '')
            .split(/\s+/)
            .slice(0, 4)
            .map((w, i) => i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
            .join('');
    }
};

// Export for use in popup.js and background.js (service worker)
(typeof self !== 'undefined' ? self : window).ComputerUseService = ComputerUseService;
