// Sandbox Driver Script
// Hosts the AI-generated code and communicates with background.js

window.addEventListener('message', async (event) => {
    const { command, scriptCode, inputs, messageId } = event.data;

    if (command === 'EXECUTE_DRIVER_SCRIPT') {
        try {
            const result = await executeUserCode(scriptCode, inputs);
            event.source.postMessage({
                type: 'EXECUTION_COMPLETE',
                success: true,
                result: result,
                messageId
            }, event.origin);
        } catch (error) {
            event.source.postMessage({
                type: 'EXECUTION_COMPLETE',
                success: false,
                error: error.message,
                messageId
            }, event.origin);
        }
    }
});

// The "Page" API exposed to the AI script
const page = {
    async _sendAction(action, data) {
        return new Promise((resolve, reject) => {
            const messageId = Date.now() + Math.random().toString(36).substr(2, 9);

            // Listen for response
            const responseListener = (event) => {
                if (event.data.messageId === messageId && event.data.type === 'DRIVER_ACTION_RESULT') {
                    window.removeEventListener('message', responseListener);
                    if (event.data.success) {
                        resolve(event.data.result);
                    } else {
                        reject(new Error(event.data.error || 'Unknown action error'));
                    }
                }
            };
            window.addEventListener('message', responseListener);

            // Send request to background
            window.parent.postMessage({
                type: 'DRIVER_ACTION',
                action: action,
                data: data,
                messageId: messageId
            }, '*');
        });
    },

    async click(selector) {
        return this._sendAction('click', { selector });
    },

    async type(selector, text) {
        return this._sendAction('type', { selector, text });
    },

    async pressKey(selector, key) {
        return this._sendAction('pressKey', { selector, key });
    },

    async scroll(selectorOrAmount) {
        // Handle both selector or simple amount interaction if needed, 
        // but for now AI service sends structured data usually.
        // Let's support object or string
        return this._sendAction('scroll', { selector: typeof selectorOrAmount === 'string' ? selectorOrAmount : null, amount: typeof selectorOrAmount === 'number' ? selectorOrAmount : null });
    },

    async wait(selectorOrTime) {
        if (typeof selectorOrTime === 'number') {
            return this._sendAction('wait', { condition: 'time', value: selectorOrTime });
        } else {
            return this._sendAction('wait', { condition: 'selector', value: selectorOrTime });
        }
    },

    // Backward compatibility for older/generated scripts that use Puppeteer-like naming.
    async waitForSelector(selector) {
        return this.wait(selector);
    },

    async navigate(url) {
        return this._sendAction('navigate', { url });
    },

    async extract(selector, pattern) {
        if (typeof selector !== 'string') {
            throw new Error('page.extract(selector) requires selector to be a CSS selector string');
        }
        // Unwrap the result object from background.js to return just the string
        const result = await this._sendAction('extract', { selector, pattern });
        return result && result.extracted ? result.extracted : null;
    },

    async extractAttribute(selector, attributeName) {
        // Extract an HTML attribute (href, src, data-*, etc.) from an element
        const result = await this._sendAction('extractAttribute', { selector, attribute: attributeName });
        return result && result.result !== undefined ? result.result : null;
    },

    async getElements(selector) {
        // Helper to get count or list of items for looping
        return this._sendAction('getElements', { selector });
    },

    async executeFunction(name, inputs) {
        // Execute another saved function as a sub-routine
        // Unwrap the result object to return just the data (like extract/extractAttribute)
        const result = await this._sendAction('executeFunction', { name, inputs });
        return result && result.result !== undefined ? result.result : result;
    },

    async evaluate(code) {
        // Execute raw code in the page context (if capable) - limiting for now to avoid complexity
        // But might be needed for complex logic if AI hallucinates it. 
        // For now, let's not add it unless requested to keep sandbox safe.
        // If AI tries to use it, it will fail, which is better than unsafe eval.
        throw new Error("page.evaluate is not supported in this environment");
    },

    async smartScrape(description) {
        // Invoke the agentic scraper to extract structured data from the current page
        // Returns the extracted data array directly
        const result = await this._sendAction('smartScrape', { description: description || 'Extract data from page' });
        return result && result.result ? result.result : [];
    },

    async log(message) {
        return this._sendAction('log', { message });
    },

    // ===== Tool System APIs =====

    async writeNotepad(key, data) {
        return this._sendAction('writeNotepad', { key, data });
    },

    async readNotepad(key) {
        const result = await this._sendAction('readNotepad', { key });
        return result && result.result !== undefined ? result.result : null;
    },

    async getCurrentTabContent(maxChars) {
        const result = await this.useTool('current_tab_content', {
            ...(maxChars !== undefined ? { maxChars } : {})
        });
        return result && result.success !== false ? result : null;
    },

    async generatePage(dataset, templateType, options) {
        return this._sendAction('generatePage', { dataset, templateType, options: options || {} });
    },

    async modifySite(action, params) {
        return this._sendAction('modifySite', { action, ...(params || {}) });
    },

    async downloadFile(data, format, filename) {
        return this._sendAction('downloadFile', { data, format, filename });
    },

    async embedText(text, options) {
        const result = await this._sendAction('embedText', { text, ...(options || {}) });
        return result && result.result !== undefined ? result.result : result;
    },

    async askOllama(prompt, options) {
        const result = await this._sendAction('askOllama', { prompt, ...(options || {}) });
        return result && result.result !== undefined ? result.result : result;
    },

    async useTool(toolName, params) {
        const result = await this._sendAction('useTool', { toolName, params: params || {} });
        return result && result.result !== undefined ? result.result : result;
    },

    async savePersistent(key, data) {
        return this._sendAction('savePersistent', { key, data });
    },

    async loadPersistent(key) {
        const result = await this._sendAction('loadPersistent', { key });
        return result && result.result !== undefined ? result.result : null;
    }
};

async function executeUserCode(code, inputs) {
    // 1. Wrap code in an async function
    // 2. Provide 'page' and 'inputs' in scope

    // Safety: 'inputs' are passed as arguments. 'page' is in closure.
    // We use new Function to parse, but we bind it to our safe scope.

    const augmentedCode = `
        return (async (page, inputs) => {
            ${code}
        })(page, inputs);
    `;

    const func = new Function('page', 'inputs', augmentedCode);
    return await func(page, inputs);
}
