// Tool Registry - Central registration and dispatch for all tools
// Each tool self-registers at load time. The orchestrator queries this registry.

const ToolRegistry = {
    _tools: {},
    _isServiceWorkerContext() {
        return typeof ServiceWorkerGlobalScope !== 'undefined'
            && typeof self !== 'undefined'
            && self instanceof ServiceWorkerGlobalScope;
    },

    /**
     * Register a tool.
     * @param {string} name - Unique tool identifier (e.g., 'computer_use_api')
     * @param {object} config
     * @param {string} config.description - What the tool does
     * @param {string[]} config.capabilities - Capability tags for matching
     * @param {object} config.parameters - Gemini-compatible JSON schema for inputs
     * @param {Function} config.execute - async (params, context) => result
     * @param {Function} [config.isAvailable] - async () => boolean
     */
    register(name, config) {
        const alreadyRegistered = !!this._tools[name];
        this._tools[name] = {
            name,
            description: config.description,
            capabilities: config.capabilities || [],
            parameters: config.parameters || {},
            execute: config.execute,
            isAvailable: config.isAvailable || (() => Promise.resolve(true)),
            registeredAt: Date.now()
        };
        // Reduce duplicate noise from popup/offscreen contexts.
        if (this._isServiceWorkerContext()) {
            if (alreadyRegistered) {
                console.log(`[ToolRegistry] Updated tool: ${name}`);
            } else {
                console.log(`[ToolRegistry] Registered tool: ${name}`);
            }
        }
    },

    get(name) {
        return this._tools[name] || null;
    },

    list() {
        return Object.values(this._tools).map(t => ({
            name: t.name,
            description: t.description,
            capabilities: t.capabilities
        }));
    },

    async listAvailable() {
        const results = [];
        for (const tool of Object.values(this._tools)) {
            try {
                const available = await tool.isAvailable();
                if (available) {
                    results.push({
                        name: tool.name,
                        description: tool.description,
                        capabilities: tool.capabilities
                    });
                }
            } catch (e) {
                // Tool availability check failed, skip it
                console.warn(`[ToolRegistry] Availability check failed for ${tool.name}:`, e.message);
            }
        }
        return results;
    },

    async execute(name, params, context = {}) {
        const tool = this._tools[name];
        if (!tool) throw new Error(`Tool "${name}" not registered`);

        try {
            const available = await tool.isAvailable();
            if (!available) throw new Error(`Tool "${name}" is not currently available`);
        } catch (e) {
            throw new Error(`Tool "${name}" availability check failed: ${e.message}`);
        }

        console.log(`[ToolRegistry] Executing tool: ${name}`, params);
        const startTime = Date.now();

        try {
            const result = await tool.execute(params, context);
            console.log(`[ToolRegistry] Tool ${name} completed in ${Date.now() - startTime}ms`);
            return result;
        } catch (e) {
            console.error(`[ToolRegistry] Tool ${name} failed:`, e.message);
            throw e;
        }
    },

    // Generate Gemini-compatible function declarations for tool-use prompts
    toGeminiFunctionDeclarations() {
        return Object.values(this._tools).map(tool => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters
        }));
    },

    // Get a human-readable summary for the orchestrator prompt
    toToolSummary() {
        return Object.values(this._tools).map(t =>
            `- ${t.name}: ${t.description} [${t.capabilities.join(', ')}]`
        ).join('\n');
    },

    // Check if a specific tool is registered
    has(name) {
        return name in this._tools;
    },

    // Get count of registered tools
    count() {
        return Object.keys(this._tools).length;
    }
};

// Export for service worker (importScripts) and popup (<script> tag)
if (typeof self !== 'undefined') self.ToolRegistry = ToolRegistry;
