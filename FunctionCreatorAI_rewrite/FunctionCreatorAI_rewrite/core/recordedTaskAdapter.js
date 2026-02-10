// Recorded Task Adapter
// Converts legacy recorded task JSON into the unified generated-function format.

const RecordedTaskAdapter = {
    _toUrlPatternArray(raw) {
        if (Array.isArray(raw)) {
            return raw.map(p => String(p || '').trim()).filter(Boolean);
        }
        if (typeof raw === 'string') {
            return raw.split(',').map(p => p.trim()).filter(Boolean);
        }
        return [];
    },

    _toInputDefinitions(parameters) {
        if (!Array.isArray(parameters)) return [];
        return parameters
            .map(param => {
                const name = param?.name || param?.paramName;
                if (!name) return null;
                return {
                    name: String(name),
                    type: param?.type || 'string',
                    required: param?.required !== false,
                    defaultValue: param?.defaultValue ?? param?.value ?? ''
                };
            })
            .filter(Boolean);
    },

    _resolveParamToken(step, value) {
        if (step?.isParam && step?.paramName) {
            return `{{${step.paramName}}}`;
        }
        return value;
    },

    _deriveStartUrl(steps = []) {
        const navStep = steps.find(step =>
            step?.action === 'navigate' || step?.action === 'startLiteral'
        );
        return navStep?.url || '';
    },

    _deriveUrlPatterns(task = {}, startUrl = '') {
        const explicit = this._toUrlPatternArray(task.urlPatterns);
        if (explicit.length > 0) return explicit;
        if (!startUrl) return [];

        try {
            const parsed = new URL(startUrl);
            return Array.from(new Set([
                `${parsed.origin}${parsed.pathname}*`,
                `${parsed.origin}/*`
            ]));
        } catch {
            return [];
        }
    },

    _mapScrollStep(step = {}) {
        if (step.selector) {
            return {
                type: 'scroll',
                selector: step.selector,
                description: step.elementName || 'Scroll to element'
            };
        }

        const rawY = Number(step?.value?.y);
        const direction = Number.isFinite(rawY) && rawY < 0 ? 'up' : 'down';
        const amount = Number.isFinite(rawY)
            ? Math.min(2000, Math.max(120, Math.abs(Math.round(rawY))))
            : 500;

        return {
            type: 'scroll',
            amount,
            direction,
            description: 'Scroll page'
        };
    },

    _mapStep(step = {}) {
        const action = String(step.action || '').trim();
        if (!action) return null;

        switch (action) {
            case 'navigate':
            case 'startLiteral':
                if (!step.url) return null;
                return {
                    type: 'navigate',
                    url: this._resolveParamToken(step, step.url),
                    description: step.elementName || `Navigate to ${step.url}`
                };

            case 'click':
                if (!step.selector && Number.isFinite(step.x) && Number.isFinite(step.y)) {
                    return {
                        type: 'literalClick',
                        x: step.x,
                        y: step.y,
                        description: step.elementName || 'Click at recorded coordinates'
                    };
                }
                if (!step.selector) return null;
                return {
                    type: 'click',
                    selector: step.selector,
                    description: step.elementName || 'Click element'
                };

            case 'literal_click':
                if (step.selector) {
                    return {
                        type: 'click',
                        selector: step.selector,
                        description: step.elementName || 'Click element'
                    };
                }
                if (Number.isFinite(step.x) && Number.isFinite(step.y)) {
                    return {
                        type: 'literalClick',
                        x: step.x,
                        y: step.y,
                        description: step.elementName || 'Click at recorded coordinates'
                    };
                }
                return null;

            case 'type':
                if (!step.selector) return null;
                return {
                    type: 'type',
                    selector: step.selector,
                    value: this._resolveParamToken(step, step.value || ''),
                    description: step.elementName || 'Type into element'
                };

            case 'literal_type':
                if (step.selector) {
                    return {
                        type: 'type',
                        selector: step.selector,
                        value: this._resolveParamToken(step, step.value || ''),
                        description: step.elementName || 'Type into element'
                    };
                }
                return {
                    type: 'literalType',
                    selector: step.selector || '',
                    value: this._resolveParamToken(step, step.value || ''),
                    description: step.elementName || 'Type text'
                };

            case 'literal_keydown':
                return {
                    type: 'literalKeydown',
                    selector: step.selector || '',
                    key: step.key || 'Enter',
                    code: step.code || step.key || 'Enter',
                    description: step.elementName || `Press key ${step.key || 'Enter'}`
                };

            case 'scroll':
                return this._mapScrollStep(step);

            case 'screenshot':
                return { type: 'screenshot', description: 'Capture screenshot' };

            case 'screenshotFullPage':
                return { type: 'screenshotFullPage', description: 'Capture full-page screenshot' };

            case 'getLargestText':
                return { type: 'getLargestText', description: 'Extract largest text block' };

            case 'hover':
                if (!step.selector) return null;
                return {
                    type: 'hover',
                    selector: step.selector,
                    description: step.elementName || 'Hover element'
                };

            case 'switchTab':
                return {
                    type: 'switchTab',
                    url: step.url || '',
                    title: step.title || '',
                    description: step.title || step.url || 'Switch tab'
                };

            case 'returnValue':
                return {
                    type: 'returnValue',
                    selectedText: step.selectedText || '',
                    description: 'Capture selected return value'
                };

            case 'text_annotation':
                return {
                    type: 'note',
                    noteType: 'text',
                    text: step.text || '',
                    description: 'Text annotation'
                };

            case 'audio_annotation':
                return {
                    type: 'note',
                    noteType: 'audio',
                    text: step.transcription || '',
                    description: 'Audio annotation'
                };

            default:
                return null;
        }
    },

    _appendDelayStep(mappedSteps, originalStep = {}) {
        const delay = Number(originalStep.delay);
        if (!Number.isFinite(delay) || delay <= 0) return;
        mappedSteps.push({
            type: 'wait',
            condition: 'time',
            value: Math.min(Math.max(Math.floor(delay), 50), 60000),
            description: `Wait ${Math.floor(delay)}ms`
        });
    },

    toGeneratedFunction(task = {}, fallbackName = 'RecordedTask') {
        const rawSteps = Array.isArray(task.steps) ? task.steps : [];
        const steps = [];

        for (const step of rawSteps) {
            this._appendDelayStep(steps, step);
            const mapped = this._mapStep(step);
            if (mapped) steps.push(mapped);
        }

        if (task.dynamicContentCheck) {
            steps.push({
                type: 'waitForStableContent',
                timeout: 300000,
                stabilityPeriod: 2500,
                checkInterval: 500,
                description: 'Wait for dynamic page content to stabilize'
            });
        }

        const startUrl = this._deriveStartUrl(rawSteps);
        const urlPatterns = this._deriveUrlPatterns(task, startUrl);
        const inputs = this._toInputDefinitions(task.parameters);

        return {
            name: task.name || fallbackName || 'RecordedTask',
            description: task.description || 'Recorded browser task',
            inputs,
            outputs: {
                type: 'object',
                description: 'Recorded task execution output'
            },
            urlPatterns,
            startUrl: startUrl || null,
            steps,
            source: 'manual-recording',
            testsPassed: false
        };
    }
};

if (typeof self !== 'undefined') self.RecordedTaskAdapter = RecordedTaskAdapter;
