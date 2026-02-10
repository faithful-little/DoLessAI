function loadWorkerScript(path) {
    try {
        importScripts(path);
        console.log(`[SW] Loaded: ${path}`);
        return true;
    } catch (e) {
        console.error(`[SW] Failed to load ${path}: ${e?.message || e}`);
        return false;
    }
}

// Import ComputerUseService for computerUseNavigate step support
loadWorkerScript('services/computerUseService.js');

// Import AI Service (needed by tool registrations and orchestrator in service worker context)
loadWorkerScript('ai/ai-service.js');

// Shared function and task adapters
loadWorkerScript('core/functionLibraryService.js');
loadWorkerScript('core/recordedTaskAdapter.js');

// Import Tool System services
loadWorkerScript('core/toolRegistry.js');
loadWorkerScript('services/notepadService.js');
loadWorkerScript('services/ollamaService.js');
loadWorkerScript('services/embeddingService.js');
loadWorkerScript('services/backendFunctionService.js');
loadWorkerScript('services/fileSystemService.js');
loadWorkerScript('services/siteModifier.js');
loadWorkerScript('services/webpageGenerator.js');
loadWorkerScript('core/toolOrchestrator.js');
// Patch for service worker: createClickVisualization uses DOM APIs (Image, canvas)
// that don't exist in service workers. Pass through the raw screenshot instead.
// The popup will draw the crosshair overlay since it has DOM access.
if (typeof ComputerUseService !== 'undefined') {
    ComputerUseService.createClickVisualization = async (screenshotDataUrl) => screenshotDataUrl;
} else {
    console.warn('[SW] ComputerUseService unavailable at startup; click visualization patch skipped.');
}

let isRecording = false;
let recordingMode = 'selector'; // 'selector' or 'literal'
let currentRecording = { steps: [] };
let allTasks = {};
let literalTypingDebounceTimer = null;

chrome.storage.local.get(['tasks', 'currentRecording', 'isRecording', 'recordingMode'], (data) => {
    if (data.tasks) allTasks = data.tasks;
    if (data.isRecording) {
        isRecording = data.isRecording;
        currentRecording = data.currentRecording || { steps: [] };
        recordingMode = data.recordingMode || 'selector';
    }
});

async function syncOllamaRuntimeSettings(overrides = null) {
    const data = overrides || await chrome.storage.local.get(['ollamaUrl', 'ollamaModel', 'ollamaEmbeddingModel', 'embeddingEngine']);
    const normalized = {
        ollamaUrl: data.ollamaUrl || 'http://localhost:11434',
        ollamaModel: typeof data.ollamaModel === 'string' ? data.ollamaModel.trim() : '',
        ollamaEmbeddingModel: typeof data.ollamaEmbeddingModel === 'string'
            ? data.ollamaEmbeddingModel.trim()
            : (typeof data.ollamaModel === 'string' ? data.ollamaModel.trim() : ''),
        embeddingEngine: data.embeddingEngine || 'gemini'
    };

    try {
        OllamaService.configure(normalized.ollamaUrl, normalized.ollamaModel, normalized.ollamaEmbeddingModel || normalized.ollamaModel);
        if (normalized.embeddingEngine) {
            EmbeddingService.setEngine(normalized.embeddingEngine);
        }
    } catch (e) {
        console.warn('[Startup] Failed to load Ollama settings:', e.message);
    }

    return normalized;
}

syncOllamaRuntimeSettings();

function normalizeGeneratedFunctionsMap(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return value;
}

function getFunctionSyncSignature(functionDef) {
    if (!functionDef || typeof functionDef !== 'object') return '';
    const stable = {
        name: functionDef.name || '',
        description: functionDef.description || '',
        urlPatterns: Array.isArray(functionDef.urlPatterns) ? functionDef.urlPatterns : [],
        inputs: Array.isArray(functionDef.inputs) ? functionDef.inputs : [],
        outputs: functionDef.outputs || {},
        steps: Array.isArray(functionDef.steps) ? functionDef.steps : [],
        testsPassed: functionDef.testsPassed === true
    };
    return JSON.stringify(stable);
}

function shouldUploadFunctionToBackend(functionDef) {
    if (!functionDef || typeof functionDef !== 'object') return false;
    if (functionDef.testsPassed !== true) return false;
    if (functionDef.syncedFromBackend === true) return false;
    if (String(functionDef.source || '').toLowerCase() === 'backend-import') return false;
    return true;
}

async function handleGeneratedFunctionsStorageChange(change) {
    if (typeof BackendFunctionService === 'undefined') return;
    const settings = await BackendFunctionService.getSettings();
    if (!settings.backendUploadEnabled) return;

    const oldMap = normalizeGeneratedFunctionsMap(change?.oldValue);
    const newMap = normalizeGeneratedFunctionsMap(change?.newValue);

    for (const [name, functionDef] of Object.entries(newMap)) {
        if (!shouldUploadFunctionToBackend(functionDef)) continue;

        const previous = oldMap[name];
        if (shouldUploadFunctionToBackend(previous)) {
            const oldSig = getFunctionSyncSignature(previous);
            const newSig = getFunctionSyncSignature(functionDef);
            if (oldSig && oldSig === newSig) {
                continue;
            }
        }

        try {
            const uploadResult = await BackendFunctionService.uploadVerifiedFunction(functionDef);
            if (uploadResult?.success) {
                log(`☁️ Uploaded verified function to backend: ${name}`);
            }
        } catch (error) {
            log(`⚠️ Backend upload failed for "${name}": ${error.message}`);
        }
    }
}

chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes?.generatedFunctions) return;
    handleGeneratedFunctionsStorageChange(changes.generatedFunctions).catch((error) => {
        console.warn('[Backend] generatedFunctions sync failed:', error.message);
    });
});

function saveStateToStorage() {
    chrome.storage.local.set({
        currentRecording,
        isRecording,
        recordingMode
    });
}

// --- Startup Cleanup ---
async function cleanupStaleCursor() {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
        if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('edge://')) continue;
        try {
            await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: () => {
                    const style = document.getElementById('automator-mic-cursor-style');
                    if (style) style.remove();
                }
            });
        } catch (e) {
            // Ignore errors (e.g. tab closed, restricted url)
        }
    }
}
cleanupStaleCursor();

// --- Side Panel Logic ---
chrome.action.onClicked.addListener(async (tab) => {
    await chrome.sidePanel.open({ windowId: tab.windowId });
});

function safeSendMessage(message) {
    chrome.runtime.sendMessage(message).catch(error => {
        if (!error.message.includes("Receiving end does not exist") && !error.message.includes("Extension context invalidated")) {
            console.error("Error sending message:", error);
        }
    });
}

const DEFAULT_COMPUTER_USE_MAX_ACTIONS = 50;
const MIN_COMPUTER_USE_MAX_ACTIONS = 1;
const MAX_COMPUTER_USE_MAX_ACTIONS = 500;

function getIncreaseMaxActionsHint(maxActions) {
    return `Computer Use hit the action limit (${maxActions}). Increase "Computer Use Max Actions" in Settings and try again.`;
}

function getKeepTabActiveHint(errorText = '') {
    const msg = String(errorText || '').toLowerCase();
    if (
        msg.includes('image readback failed')
        || msg.includes('capturevisibletab')
        || msg.includes('failed to capture')
        || msg.includes('initial screenshot')
    ) {
        return 'Keep the target tab active and the browser window visible (not minimized) while this runs, then retry.';
    }
    return '';
}

async function getConfiguredComputerUseMaxActions() {
    try {
        const storage = await chrome.storage.local.get(['computerUseMaxActions']);
        const raw = Number(storage?.computerUseMaxActions);
        if (!Number.isFinite(raw)) return DEFAULT_COMPUTER_USE_MAX_ACTIONS;
        const normalized = Math.floor(raw);
        return Math.min(MAX_COMPUTER_USE_MAX_ACTIONS, Math.max(MIN_COMPUTER_USE_MAX_ACTIONS, normalized));
    } catch {
        return DEFAULT_COMPUTER_USE_MAX_ACTIONS;
    }
}

async function runComputerUseWithSettings(taskDescription, apiKey, tabId, options = {}) {
    const maxActions = await getConfiguredComputerUseMaxActions();
    const sanitizedOptions = { ...(options || {}) };
    if ('maxActions' in sanitizedOptions) delete sanitizedOptions.maxActions;
    const callerShouldAbort = typeof sanitizedOptions.shouldAbort === 'function'
        ? sanitizedOptions.shouldAbort
        : (() => false);
    sanitizedOptions.shouldAbort = () => isAiStopRequested() || callerShouldAbort();
    const result = await ComputerUseService.executeAutonomousTask(taskDescription, apiKey, tabId, {
        ...sanitizedOptions,
        maxActions
    });
    if (!result?.success && /max actions reached without task completion/i.test(String(result?.error || ''))) {
        return {
            ...result,
            maxActions,
            error: `${result.error}. ${getIncreaseMaxActionsHint(maxActions)}`
        };
    }
    return result;
}

// Store logs for the session
let sessionLogs = [];

function log(message) {
    const timestamp = new Date().toLocaleTimeString();
    const logEntry = `[${timestamp}] ${message}`;
    console.log(logEntry);
    sessionLogs.push(logEntry);
    safeSendMessage({ type: 'logUpdate', message: logEntry });
}

const aiStopState = {
    stopRequested: false,
    reason: '',
    updatedAt: 0
};

function setAiStopState(stop, reason = '') {
    aiStopState.stopRequested = !!stop;
    aiStopState.reason = reason || (stop ? 'stopped-by-user' : '');
    aiStopState.updatedAt = Date.now();

    if (stop) {
        if (typeof AIService?.requestStopAllRequests === 'function') {
            AIService.requestStopAllRequests(aiStopState.reason);
        }
        if (typeof ComputerUseService?.requestStopAll === 'function') {
            ComputerUseService.requestStopAll(aiStopState.reason);
        }
    } else {
        if (typeof AIService?.clearStopRequest === 'function') {
            AIService.clearStopRequest();
        }
        if (typeof ComputerUseService?.clearStopRequest === 'function') {
            ComputerUseService.clearStopRequest();
        }
    }
}

function isAiStopRequested() {
    return !!aiStopState.stopRequested;
}

let currentExecutionModelPreferences = null;

function normalizeFunctionModelPreferences(prefs = {}) {
    const normalized = {
        aiProvider: ['default', 'gemini', 'ollama'].includes(String(prefs.aiProvider || '').toLowerCase())
            ? String(prefs.aiProvider).toLowerCase()
            : 'default',
        aiModel: typeof prefs.aiModel === 'string' ? prefs.aiModel.trim() : '',
        embeddingProvider: ['default', 'gemini', 'ollama'].includes(String(prefs.embeddingProvider || '').toLowerCase())
            ? String(prefs.embeddingProvider).toLowerCase()
            : 'default',
        embeddingModel: typeof prefs.embeddingModel === 'string' ? prefs.embeddingModel.trim() : ''
    };
    return normalized;
}

function applyFunctionModelPreferences(modelPreferences = {}) {
    const prefs = normalizeFunctionModelPreferences(modelPreferences);
    currentExecutionModelPreferences = prefs;

    const snapshot = {
        aiServiceModel: AIService.MODEL,
        ollamaModel: OllamaService._model,
        ollamaEmbeddingModel: OllamaService._embeddingModel,
        embeddingEngine: EmbeddingService._engine
    };

    if (prefs.aiProvider === 'gemini' && prefs.aiModel) {
        AIService.MODEL = prefs.aiModel;
    }
    if (prefs.aiProvider === 'ollama' && prefs.aiModel) {
        OllamaService._model = prefs.aiModel;
    }
    if (prefs.embeddingProvider === 'gemini' || prefs.embeddingProvider === 'ollama') {
        EmbeddingService.setEngine(prefs.embeddingProvider);
    }
    if (prefs.embeddingModel) {
        OllamaService._embeddingModel = prefs.embeddingModel;
    }

    return snapshot;
}

function restoreFunctionModelPreferences(snapshot) {
    if (!snapshot) {
        currentExecutionModelPreferences = null;
        return;
    }
    AIService.MODEL = snapshot.aiServiceModel;
    OllamaService._model = snapshot.ollamaModel;
    OllamaService._embeddingModel = snapshot.ollamaEmbeddingModel;
    if (snapshot.embeddingEngine) {
        EmbeddingService.setEngine(snapshot.embeddingEngine);
    }
    currentExecutionModelPreferences = null;
}

function applyModelPreferencesToToolParams(toolName, params = {}, prefs = null) {
    const normalizedPrefs = normalizeFunctionModelPreferences(prefs || {});
    if (
        normalizedPrefs.aiProvider === 'default' &&
        !normalizedPrefs.aiModel &&
        normalizedPrefs.embeddingProvider === 'default' &&
        !normalizedPrefs.embeddingModel
    ) {
        return params;
    }

    const cloned = params && typeof params === 'object'
        ? JSON.parse(JSON.stringify(params))
        : {};

    if (toolName === 'embedding_handler') {
        if (!cloned.engine && (normalizedPrefs.embeddingProvider === 'gemini' || normalizedPrefs.embeddingProvider === 'ollama')) {
            cloned.engine = normalizedPrefs.embeddingProvider;
        }
        if (!cloned.embeddingModel && normalizedPrefs.embeddingModel) {
            cloned.embeddingModel = normalizedPrefs.embeddingModel;
        }
    }

    if (toolName === 'local_ollama_model' && !cloned.model && normalizedPrefs.aiModel) {
        cloned.model = normalizedPrefs.aiModel;
    }

    if (toolName === 'remote_intelligence_api') {
        if (!cloned.provider && (normalizedPrefs.aiProvider === 'gemini' || normalizedPrefs.aiProvider === 'ollama')) {
            cloned.provider = normalizedPrefs.aiProvider;
        }
        if (!cloned.model && normalizedPrefs.aiModel) {
            cloned.model = normalizedPrefs.aiModel;
        }
    }

    return cloned;
}

// ==================== SCHEDULER ====================
const SCHEDULER_STORAGE_KEY = 'schedulerJobs';
const SCHEDULER_ALARM_PREFIX = 'scheduler_job_';
let schedulerJobs = {};
let schedulerInitPromise = null;
let schedulerKeywordCheckInFlight = false;
const schedulerDomRunInFlight = new Set();
const schedulerDomSuppressUntil = new Map();
const schedulerDomLastTriggerAt = new Map();

function isInternalPageUrl(url) {
    return !url
        || url.startsWith('chrome://')
        || url.startsWith('edge://')
        || url.startsWith('about:')
        || url.startsWith('chrome-extension://');
}

function functionNeedsCurrentPageContext(functionDef) {
    if (functionDef?.requiresCurrentTab === true) return true;
    if (String(functionDef?.navigationStrategy || '').toLowerCase() === 'current-tab') return true;
    const steps = Array.isArray(functionDef?.steps) ? functionDef.steps : [];
    if (steps.length === 0) return false;
    const firstActionable = steps.find(step => step && step.type && step.type !== 'wait');
    if (!firstActionable) return false;

    const stepType = String(firstActionable.type || '').toLowerCase();
    if (stepType === 'navigate') return false;
    if (stepType === 'computerusenavigate') {
        return firstActionable?.useCurrentTab === true
            || String(firstActionable?.target || '').toLowerCase() === 'current-tab';
    }

    const contextRequiredTypes = new Set([
        'click',
        'type',
        'presskey',
        'scroll',
        'extract',
        'extractattribute',
        'getelements',
        'smartscrape',
        'modifywebsite',
        'hover',
        'waitforstablecontent',
        'literalclick',
        'literaltype',
        'literalkeydown',
        'returnvalue',
        'getlargesttext'
    ]);
    return contextRequiredTypes.has(stepType);
}

async function findFallbackAutomationTab(preferredWindowId = null, excludeTabId = null) {
    const activeTabs = await chrome.tabs.query({ active: true });
    const candidates = (activeTabs || [])
        .filter(tab => tab?.id && tab.id !== excludeTabId && !isInternalPageUrl(tab.url))
        .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));

    if (preferredWindowId) {
        const preferred = candidates.find(tab => tab.windowId === preferredWindowId);
        if (preferred) return preferred;
    }
    return candidates[0] || null;
}

function resolveBootstrapUrlFromFunction(functionDef) {
    const candidates = [];
    if (typeof functionDef?.startUrl === 'string') candidates.push(functionDef.startUrl);
    if (typeof functionDef?.urlTemplate === 'string') {
        candidates.push(functionDef.urlTemplate.replace(/\{\{[^}]+\}\}/g, ''));
    }
    if (Array.isArray(functionDef?.urlPatterns)) {
        for (const pattern of functionDef.urlPatterns) {
            if (typeof pattern === 'string') candidates.push(pattern.replace(/\*/g, ''));
        }
    }

    for (const raw of candidates) {
        const candidate = String(raw || '').trim();
        if (!candidate || isInternalPageUrl(candidate)) continue;
        try {
            const parsed = new URL(candidate);
            if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
                return parsed.href;
            }
        } catch {
            // Ignore invalid candidate
        }
    }

    return 'https://example.com/';
}

async function createAutomationExecutionTab(functionDef) {
    const bootstrapUrl = resolveBootstrapUrlFromFunction(functionDef);
    return await chrome.tabs.create({ url: bootstrapUrl, active: true });
}

function schedulerAlarmName(jobId) {
    return `${SCHEDULER_ALARM_PREFIX}${jobId}`;
}

function createSchedulerJobId() {
    return `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function clearDomRuntimeStateForJob(jobId) {
    const prefix = `${jobId}:`;
    for (const key of Array.from(schedulerDomRunInFlight)) {
        if (key.startsWith(prefix)) schedulerDomRunInFlight.delete(key);
    }
    for (const key of Array.from(schedulerDomSuppressUntil.keys())) {
        if (key.startsWith(prefix)) schedulerDomSuppressUntil.delete(key);
    }
    for (const key of Array.from(schedulerDomLastTriggerAt.keys())) {
        if (key.startsWith(prefix)) schedulerDomLastTriggerAt.delete(key);
    }
}

function clearDomRuntimeStateForTab(tabId) {
    const suffix = `:${tabId}`;
    for (const key of Array.from(schedulerDomRunInFlight)) {
        if (key.endsWith(suffix)) schedulerDomRunInFlight.delete(key);
    }
    for (const key of Array.from(schedulerDomSuppressUntil.keys())) {
        if (key.endsWith(suffix)) schedulerDomSuppressUntil.delete(key);
    }
    for (const key of Array.from(schedulerDomLastTriggerAt.keys())) {
        if (key.endsWith(suffix)) schedulerDomLastTriggerAt.delete(key);
    }
}

function clearAllDomRuntimeState() {
    schedulerDomRunInFlight.clear();
    schedulerDomSuppressUntil.clear();
    schedulerDomLastTriggerAt.clear();
}

function escapeRegex(text) {
    return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseSchedulerAtTime(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'string') return null;

    const trimmed = value.trim();
    if (!trimmed) return null;

    if (/^\d+$/.test(trimmed)) {
        const asNumber = Number(trimmed);
        return Number.isFinite(asNumber) ? asNumber : null;
    }

    const hhmm = trimmed.match(/^(\d{1,2}):(\d{2})$/);
    if (hhmm) {
        const hour = Number(hhmm[1]);
        const minute = Number(hhmm[2]);
        if (hour > 23 || minute > 59) return null;
        const now = new Date();
        const next = new Date();
        next.setHours(hour, minute, 0, 0);
        if (next.getTime() <= now.getTime()) {
            next.setDate(next.getDate() + 1);
        }
        return next.getTime();
    }

    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? null : parsed;
}

function matchesSchedulerUrlFilter(job, url) {
    if (!url) return false;
    const patterns = [];
    if (typeof job?.urlPattern === 'string' && job.urlPattern.trim()) {
        patterns.push(job.urlPattern.trim());
    }
    if (Array.isArray(job?.urlPatterns)) {
        for (const p of job.urlPatterns) {
            if (typeof p === 'string' && p.trim()) patterns.push(p.trim());
        }
    }
    if (patterns.length === 0) return true;
    return patterns.some(pattern => {
        try {
            return urlMatchesPattern(url, pattern);
        } catch {
            return false;
        }
    });
}

function sanitizeSchedulerJob(job) {
    if (!job) return null;
    return {
        id: job.id,
        name: job.name,
        functionName: job.functionName,
        scheduleType: job.scheduleType,
        enabled: !!job.enabled,
        createdAt: job.createdAt,
        intervalMinutes: job.intervalMinutes,
        atTimeMs: job.atTimeMs,
        atTimeISO: job.atTimeISO,
        keyword: job.keyword,
        domSelector: job.domSelector,
        domDebounceMs: job.domDebounceMs,
        minAddedNodes: job.minAddedNodes,
        runOnPageLoad: job.runOnPageLoad,
        runOnScroll: job.runOnScroll,
        caseSensitive: !!job.caseSensitive,
        matchWholeWord: !!job.matchWholeWord,
        triggerMode: job.triggerMode,
        cooldownMinutes: job.cooldownMinutes,
        target: job.target,
        tabId: job.tabId,
        urlPattern: job.urlPattern,
        urlPatterns: Array.isArray(job.urlPatterns) ? job.urlPatterns : undefined,
        lastRunAt: job.lastRunAt,
        lastStatus: job.lastStatus,
        lastError: job.lastError,
        lastTrigger: job.lastTrigger,
        lastKeywordUrl: job.lastKeywordUrl,
        lastDomChangeUrl: job.lastDomChangeUrl
    };
}

async function persistSchedulerJobs() {
    await chrome.storage.local.set({ [SCHEDULER_STORAGE_KEY]: schedulerJobs });
}

async function scheduleAlarmForJob(job) {
    if (!job?.id) return;
    const alarmName = schedulerAlarmName(job.id);
    await chrome.alarms.clear(alarmName);

    if (!job.enabled) return;

    if (job.scheduleType === 'interval') {
        const minutes = Number(job.intervalMinutes);
        if (!Number.isFinite(minutes) || minutes < 1) {
            throw new Error('intervalMinutes must be >= 1');
        }
        chrome.alarms.create(alarmName, { delayInMinutes: minutes, periodInMinutes: minutes });
        return;
    }

    if (job.scheduleType === 'atTime') {
        const when = Number(job.atTimeMs);
        if (!Number.isFinite(when) || when <= Date.now()) {
            job.enabled = false;
            job.lastError = 'Scheduled time is in the past';
            return;
        }
        chrome.alarms.create(alarmName, { when });
    }
}

async function syncSchedulerAlarms() {
    const alarms = await chrome.alarms.getAll();
    for (const alarm of alarms) {
        if (alarm.name.startsWith(SCHEDULER_ALARM_PREFIX)) {
            await chrome.alarms.clear(alarm.name);
        }
    }

    let stateChanged = false;
    for (const job of Object.values(schedulerJobs)) {
        try {
            await scheduleAlarmForJob(job);
            if (!job.enabled && job.lastError === 'Scheduled time is in the past') {
                stateChanged = true;
            }
        } catch (e) {
            job.enabled = false;
            job.lastError = e.message;
            stateChanged = true;
        }
    }

    if (stateChanged) {
        await persistSchedulerJobs();
    }
}

async function initializeScheduler() {
    const data = await chrome.storage.local.get([SCHEDULER_STORAGE_KEY]);
    schedulerJobs = data[SCHEDULER_STORAGE_KEY] || {};
    await syncSchedulerAlarms();
}

async function resolveSchedulerTargetTab(job, runtimeContext = {}) {
    if (Number.isInteger(runtimeContext.tabId)) {
        try {
            const explicitTab = await chrome.tabs.get(runtimeContext.tabId);
            if (explicitTab && !isInternalPageUrl(explicitTab.url)) return explicitTab.id;
        } catch {
            // Ignore invalid tab and continue with fallback resolution.
        }
    }

    if (job.target === 'fixedTab' && Number.isInteger(job.tabId)) {
        try {
            const fixedTab = await chrome.tabs.get(job.tabId);
            if (fixedTab && !isInternalPageUrl(fixedTab.url) && matchesSchedulerUrlFilter(job, fixedTab.url)) {
                return fixedTab.id;
            }
        } catch {
            // Tab may be closed; fallback to active tab lookup.
        }
    }

    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab?.id && !isInternalPageUrl(activeTab.url) && matchesSchedulerUrlFilter(job, activeTab.url)) {
        return activeTab.id;
    }

    if (job.urlPattern || (Array.isArray(job.urlPatterns) && job.urlPatterns.length > 0)) {
        const allTabs = await chrome.tabs.query({});
        const matching = allTabs.find(t => t.id && !isInternalPageUrl(t.url) && matchesSchedulerUrlFilter(job, t.url));
        if (matching?.id) return matching.id;
    }

    return null;
}

async function executeSchedulerJob(jobId, runtimeContext = {}) {
    await schedulerInitPromise;

    const job = schedulerJobs[jobId];
    if (!job) return { success: false, error: `Scheduler job "${jobId}" not found` };
    if (!job.enabled) return { success: false, error: `Scheduler job "${jobId}" is disabled` };

    const now = Date.now();
    const cooldownMinutes = Number(job.cooldownMinutes || 0);
    if (cooldownMinutes > 0 && job.lastRunAt && now - job.lastRunAt < cooldownMinutes * 60000) {
        return { success: false, skipped: true, error: 'Job is in cooldown window' };
    }

    try {
        const generatedFunctions = await FunctionLibraryService.getAll();
        const functionDef = generatedFunctions[job.functionName];
        if (!functionDef) {
            throw new Error(`Function "${job.functionName}" not found`);
        }

        const targetTabId = await resolveSchedulerTargetTab(job, runtimeContext);
        if (!targetTabId) {
            throw new Error('No suitable tab found for scheduled run');
        }

        const runResult = await executeGeneratedFunction(functionDef, job.inputs || {}, targetTabId);
        if (!runResult?.success) {
            throw new Error(runResult?.error || 'Scheduled execution failed');
        }

        job.lastRunAt = now;
        job.lastStatus = 'success';
        job.lastError = null;
        job.lastTrigger = {
            type: runtimeContext.trigger || 'manual',
            reason: runtimeContext.reason || null,
            at: now,
            tabId: targetTabId
        };

        // atTime is a one-shot schedule. Disable after first run.
        if (job.scheduleType === 'atTime') {
            job.enabled = false;
            await chrome.alarms.clear(schedulerAlarmName(job.id));
        }

        await persistSchedulerJobs();
        log(`[Scheduler] Job "${job.name}" executed successfully via ${job.lastTrigger.type}`);
        return { success: true, result: runResult.data, job: sanitizeSchedulerJob(job) };
    } catch (e) {
        job.lastRunAt = now;
        job.lastStatus = 'error';
        job.lastError = e.message;
        job.lastTrigger = {
            type: runtimeContext.trigger || 'manual',
            reason: runtimeContext.reason || null,
            at: now
        };

        if (job.scheduleType === 'atTime') {
            job.enabled = false;
            await chrome.alarms.clear(schedulerAlarmName(job.id));
        }

        await persistSchedulerJobs();
        log(`[Scheduler] Job "${job.name}" failed: ${e.message}`);
        return { success: false, error: e.message, job: sanitizeSchedulerJob(job) };
    }
}

function keywordMatchesPageText(pageText, job) {
    const keyword = String(job.keyword || '');
    if (!keyword.trim()) return false;

    if (job.matchWholeWord) {
        const flags = job.caseSensitive ? 'g' : 'gi';
        const regex = new RegExp(`\\b${escapeRegex(keyword.trim())}\\b`, flags);
        return regex.test(pageText);
    }

    if (job.caseSensitive) {
        return pageText.includes(keyword);
    }
    return pageText.toLowerCase().includes(keyword.toLowerCase());
}

async function runKeywordSchedulesForActiveTab(reason = 'tab-event') {
    if (schedulerKeywordCheckInFlight) return;
    schedulerKeywordCheckInFlight = true;

    try {
        await schedulerInitPromise;
        const keywordJobs = Object.values(schedulerJobs).filter(job =>
            job.enabled && job.scheduleType === 'keyword' && typeof job.keyword === 'string' && job.keyword.trim()
        );
        if (keywordJobs.length === 0) return;

        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!activeTab?.id || isInternalPageUrl(activeTab.url)) return;

        let pageText = '';
        try {
            const [res] = await chrome.scripting.executeScript({
                target: { tabId: activeTab.id },
                func: () => (document.body?.innerText || '').slice(0, 250000)
            });
            pageText = String(res?.result || '');
        } catch {
            return;
        }

        if (!pageText) return;

        for (const job of keywordJobs) {
            if (!matchesSchedulerUrlFilter(job, activeTab.url)) continue;
            if (!keywordMatchesPageText(pageText, job)) continue;

            const triggerMode = job.triggerMode || 'oncePerUrl';
            if (triggerMode === 'oncePerUrl' && job.lastKeywordUrl === activeTab.url) {
                continue;
            }

            const runResult = await executeSchedulerJob(job.id, {
                trigger: 'keyword',
                reason,
                tabId: activeTab.id
            });

            if (runResult?.success || runResult?.skipped) {
                job.lastKeywordUrl = activeTab.url;
                await persistSchedulerJobs();
            }
        }
    } finally {
        schedulerKeywordCheckInFlight = false;
    }
}

function matchesDomChangeTarget(job, tab) {
    if (!job || !tab?.id) return false;
    if (job.target === 'fixedTab') {
        return Number.isInteger(job.tabId) && job.tabId === tab.id;
    }
    return !!tab.active;
}

function getDomChangeJobsForTab(tab) {
    if (!tab?.id || !tab.url || isInternalPageUrl(tab.url)) return [];
    return Object.values(schedulerJobs).filter(job =>
        job?.enabled
        && job.scheduleType === 'domChange'
        && matchesSchedulerUrlFilter(job, tab.url)
        && matchesDomChangeTarget(job, tab)
    );
}

function buildDomWatcherConfig(job) {
    const debounceRaw = Number(job?.domDebounceMs);
    const debounceMs = Number.isFinite(debounceRaw) ? Math.max(200, Math.min(60000, debounceRaw)) : 1200;
    const minAddedRaw = Number(job?.minAddedNodes);
    const minAddedNodes = Number.isFinite(minAddedRaw) ? Math.max(1, Math.floor(minAddedRaw)) : 1;
    return {
        id: String(job?.id || '').trim(),
        domSelector: typeof job?.domSelector === 'string' && job.domSelector.trim() ? job.domSelector.trim() : 'body',
        domDebounceMs: debounceMs,
        minAddedNodes,
        runOnPageLoad: job?.runOnPageLoad !== false,
        runOnScroll: job?.runOnScroll === true
    };
}

async function injectDomWatchersIntoTab(tabId, watcherConfigs) {
    try {
        await chrome.scripting.executeScript({
            target: { tabId },
            func: (configs) => {
                const namespace = '__taskAutomatorDomScheduler';
                const state = window[namespace] || (window[namespace] = {
                    jobs: {},
                    scrollHandler: null,
                    lastScrollY: 0
                });

                const sendEvent = (payload) => {
                    try {
                        chrome.runtime.sendMessage({ type: 'schedulerDomChangeDetected', event: payload }, () => {
                            const err = chrome.runtime.lastError;
                            if (err) void err.message;
                        });
                    } catch {
                        // Ignore extension messaging errors.
                    }
                };

                const disconnectJob = (job) => {
                    if (!job) return;
                    if (job.timer) {
                        clearTimeout(job.timer);
                        job.timer = null;
                    }
                    if (job.observer) {
                        job.observer.disconnect();
                        job.observer = null;
                    }
                    job.target = null;
                    job.scheduleNotify = null;
                };

                const normalizedConfigs = Array.isArray(configs) ? configs : [];
                const desiredIds = new Set(
                    normalizedConfigs
                        .map(cfg => String(cfg?.id || '').trim())
                        .filter(Boolean)
                );

                for (const existingId of Object.keys(state.jobs)) {
                    if (!desiredIds.has(existingId)) {
                        disconnectJob(state.jobs[existingId]);
                        delete state.jobs[existingId];
                    }
                }

                const currentUrl = location.href;

                for (const cfg of normalizedConfigs) {
                    const id = String(cfg?.id || '').trim();
                    if (!id) continue;

                    const normalizedCfg = {
                        id,
                        domSelector: typeof cfg?.domSelector === 'string' && cfg.domSelector.trim() ? cfg.domSelector.trim() : 'body',
                        domDebounceMs: Number.isFinite(Number(cfg?.domDebounceMs))
                            ? Math.max(200, Math.min(60000, Number(cfg.domDebounceMs)))
                            : 1200,
                        minAddedNodes: Number.isFinite(Number(cfg?.minAddedNodes))
                            ? Math.max(1, Math.floor(Number(cfg.minAddedNodes)))
                            : 1,
                        runOnPageLoad: cfg?.runOnPageLoad !== false,
                        runOnScroll: cfg?.runOnScroll === true
                    };

                    let job = state.jobs[id];
                    if (!job) {
                        job = {
                            id,
                            cfg: normalizedCfg,
                            timer: null,
                            observer: null,
                            target: null,
                            lastUrl: currentUrl,
                            lastPageLoadUrl: null,
                            pendingReason: 'dom-change',
                            pendingMeta: {}
                        };
                        state.jobs[id] = job;
                    } else {
                        job.cfg = normalizedCfg;
                    }

                    if (job.lastUrl !== currentUrl) {
                        job.lastUrl = currentUrl;
                        job.lastPageLoadUrl = null;
                    }

                    job.scheduleNotify = (reason, meta = {}) => {
                        job.pendingReason = reason || 'dom-change';
                        job.pendingMeta = meta && typeof meta === 'object' ? meta : {};
                        if (job.timer) clearTimeout(job.timer);
                        job.timer = setTimeout(() => {
                            job.timer = null;
                            const urlNow = location.href;
                            if (job.lastUrl !== urlNow) {
                                job.lastUrl = urlNow;
                                job.lastPageLoadUrl = null;
                            }
                            sendEvent({
                                jobId: job.id,
                                reason: job.pendingReason,
                                url: urlNow,
                                meta: job.pendingMeta,
                                at: Date.now()
                            });
                            job.pendingMeta = {};
                        }, job.cfg.domDebounceMs);
                    };

                    let target = null;
                    try {
                        target = document.querySelector(job.cfg.domSelector);
                    } catch {
                        target = null;
                    }
                    target = target || document.body || document.documentElement;

                    if (!target) {
                        disconnectJob(job);
                        continue;
                    }

                    if (job.target !== target || !job.observer) {
                        if (job.observer) job.observer.disconnect();
                        job.target = target;
                        job.observer = new MutationObserver((mutations) => {
                            let addedNodes = 0;
                            for (const mutation of mutations || []) {
                                addedNodes += Number(mutation?.addedNodes?.length || 0);
                            }
                            if (addedNodes >= job.cfg.minAddedNodes) {
                                job.scheduleNotify('dom-added', {
                                    addedNodes,
                                    mutationCount: mutations?.length || 0
                                });
                            }
                        });
                        job.observer.observe(target, { childList: true, subtree: true });
                    }

                    if (job.cfg.runOnPageLoad && job.lastPageLoadUrl !== currentUrl) {
                        job.lastPageLoadUrl = currentUrl;
                        job.scheduleNotify('page-load', { addedNodes: 0 });
                    }
                }

                const hasScrollJobs = Object.values(state.jobs).some(job => job?.cfg?.runOnScroll === true);
                if (hasScrollJobs && !state.scrollHandler) {
                    state.lastScrollY = window.scrollY || 0;
                    state.scrollHandler = () => {
                        const currentY = window.scrollY || 0;
                        const deltaY = currentY - (state.lastScrollY || 0);
                        state.lastScrollY = currentY;
                        if (deltaY < 80) return;
                        for (const job of Object.values(state.jobs)) {
                            if (job?.cfg?.runOnScroll === true && typeof job.scheduleNotify === 'function') {
                                job.scheduleNotify('scroll', { scrollY: currentY, deltaY });
                            }
                        }
                    };
                    window.addEventListener('scroll', state.scrollHandler, { passive: true });
                } else if (!hasScrollJobs && state.scrollHandler) {
                    window.removeEventListener('scroll', state.scrollHandler);
                    state.scrollHandler = null;
                }

                return { success: true, watchedJobs: Object.keys(state.jobs).length };
            },
            args: [Array.isArray(watcherConfigs) ? watcherConfigs : []]
        });
        return { success: true };
    } catch (e) {
        const msg = String(e?.message || '');
        if (
            msg.includes('Cannot access contents of the page')
            || msg.includes('The extensions gallery cannot be scripted')
        ) {
            return { success: false, skipped: true, reason: 'tab-not-scriptable', error: msg };
        }
        return { success: false, error: e.message };
    }
}

async function syncDomChangeObserverForTab(tabRef, reason = 'scheduler-sync') {
    let tab = tabRef;
    if (Number.isInteger(tabRef)) {
        try {
            tab = await chrome.tabs.get(tabRef);
        } catch {
            return { success: false, skipped: true, reason: 'tab-not-found' };
        }
    }
    if (!tab?.id || !tab.url || isInternalPageUrl(tab.url)) {
        return { success: false, skipped: true, reason: 'unsupported-tab' };
    }

    const watcherConfigs = getDomChangeJobsForTab(tab).map(buildDomWatcherConfig).filter(cfg => cfg.id);
    if (watcherConfigs.length === 0) {
        return { success: true, skipped: true, reason: 'no-domchange-jobs' };
    }
    const injectResult = await injectDomWatchersIntoTab(tab.id, watcherConfigs);
    if (!injectResult.success && !injectResult.skipped) {
        console.warn(`[Scheduler] DOM watcher sync failed (${reason}) for tab ${tab.id}: ${injectResult.error}`);
    }
    return injectResult;
}

async function syncDomChangeObservers(reason = 'scheduler-sync') {
    await schedulerInitPromise;
    const tabs = await chrome.tabs.query({});
    if (!Array.isArray(tabs) || tabs.length === 0) return { success: true, syncedTabs: 0 };

    const results = await Promise.allSettled(tabs.map(tab => syncDomChangeObserverForTab(tab, reason)));
    const syncedTabs = results.filter(r => r.status === 'fulfilled' && r.value?.success).length;
    return { success: true, syncedTabs };
}

async function handleSchedulerDomChangeEvent(message = {}, sender = {}) {
    await schedulerInitPromise;

    const event = (message?.event && typeof message.event === 'object') ? message.event : {};
    const jobId = String(event.jobId || '').trim();
    const tabId = Number.isInteger(sender?.tab?.id) ? sender.tab.id : (Number.isInteger(message.tabId) ? message.tabId : null);
    const observedUrl = String(sender?.tab?.url || event.url || '').trim();

    if (!jobId || !Number.isInteger(tabId)) {
        return { success: false, ignored: true, error: 'Missing dom-change jobId or tabId' };
    }

    const job = schedulerJobs[jobId];
    if (!job || !job.enabled || job.scheduleType !== 'domChange') {
        return { success: false, ignored: true, error: `DOM-change job "${jobId}" is not active` };
    }
    if (!observedUrl || isInternalPageUrl(observedUrl) || !matchesSchedulerUrlFilter(job, observedUrl)) {
        return { success: false, ignored: true, error: 'DOM-change event URL does not match job filters' };
    }

    if (job.target === 'fixedTab' && Number.isInteger(job.tabId) && job.tabId !== tabId) {
        return { success: false, ignored: true, error: 'DOM-change event tab does not match fixedTab target' };
    }
    if (job.target !== 'fixedTab' && sender?.tab && sender.tab.active !== true) {
        log(`?? Scheduler "${job.name}" is waiting: bring tab "${sender.tab.title || sender.tab.url || tabId}" to active/focused state to continue DOM-change monitoring.`);
        return { success: false, ignored: true, error: 'DOM-change event ignored because tab is not active' };
    }

    const triggerMode = job.triggerMode || 'everyMatch';
    if (triggerMode === 'oncePerUrl' && job.lastDomChangeUrl === observedUrl) {
        return { success: false, skipped: true, ignored: true, error: 'Job already ran once for this URL' };
    }

    const lockKey = `${jobId}:${tabId}`;
    if (schedulerDomRunInFlight.has(lockKey)) {
        return { success: false, skipped: true, ignored: true, error: 'Job is already running for this tab' };
    }

    const now = Date.now();
    const suppressUntil = Number(schedulerDomSuppressUntil.get(lockKey) || 0);
    if (now < suppressUntil) {
        return { success: false, skipped: true, ignored: true, error: 'DOM-change trigger is in suppression window' };
    }

    const debounceMsRaw = Number(job.domDebounceMs || 1200);
    const debounceMs = Number.isFinite(debounceMsRaw) ? Math.max(200, Math.min(60000, debounceMsRaw)) : 1200;
    const lastTriggeredAt = Number(schedulerDomLastTriggerAt.get(lockKey) || 0);
    if (now - lastTriggeredAt < debounceMs) {
        return { success: false, skipped: true, ignored: true, error: 'DOM-change trigger debounced' };
    }

    schedulerDomRunInFlight.add(lockKey);
    schedulerDomLastTriggerAt.set(lockKey, now);
    try {
        const runResult = await executeSchedulerJob(jobId, {
            trigger: 'domChange',
            reason: String(event.reason || 'dom-change'),
            tabId
        });

        const suppressMs = Math.max(1000, Math.min(30000, debounceMs * 2));
        schedulerDomSuppressUntil.set(lockKey, Date.now() + suppressMs);

        if (runResult?.success) {
            job.lastDomChangeUrl = observedUrl;
            await persistSchedulerJobs();
        }
        return runResult;
    } finally {
        schedulerDomRunInFlight.delete(lockKey);
    }
}

async function executeTaskSchedulerAction(params = {}, context = {}) {
    await schedulerInitPromise;

    const action = String(params.action || 'create').trim().toLowerCase();

    if (action === 'list') {
        return { success: true, jobs: Object.values(schedulerJobs).map(sanitizeSchedulerJob) };
    }

    if (action === 'remove' || action === 'delete') {
        const id = String(params.id || '').trim();
        if (!id || !schedulerJobs[id]) return { success: false, error: `Scheduler job "${id}" not found` };
        await chrome.alarms.clear(schedulerAlarmName(id));
        delete schedulerJobs[id];
        clearDomRuntimeStateForJob(id);
        await persistSchedulerJobs();
        await syncDomChangeObservers('remove');
        return { success: true, removedId: id };
    }

    if (action === 'runnow') {
        const id = String(params.id || '').trim();
        if (!id) return { success: false, error: 'runNow requires job id' };
        return await executeSchedulerJob(id, { trigger: 'manual', tabId: context.tabId });
    }

    if (action === 'enable' || action === 'disable') {
        const id = String(params.id || '').trim();
        if (!id || !schedulerJobs[id]) return { success: false, error: `Scheduler job "${id}" not found` };
        schedulerJobs[id].enabled = action === 'enable';
        if (schedulerJobs[id].enabled) {
            await scheduleAlarmForJob(schedulerJobs[id]);
        } else {
            await chrome.alarms.clear(schedulerAlarmName(id));
            clearDomRuntimeStateForJob(id);
        }
        await persistSchedulerJobs();
        await syncDomChangeObservers(action);
        return { success: true, job: sanitizeSchedulerJob(schedulerJobs[id]) };
    }

    if (action === 'clear') {
        const ids = Object.keys(schedulerJobs);
        for (const id of ids) {
            await chrome.alarms.clear(schedulerAlarmName(id));
        }
        schedulerJobs = {};
        clearAllDomRuntimeState();
        await persistSchedulerJobs();
        await syncDomChangeObservers('clear');
        return { success: true, cleared: ids.length };
    }

    if (action !== 'create') {
        return { success: false, error: `Unknown scheduler action: ${action}` };
    }

    const functionName = String(params.functionName || params.name || '').trim();
    if (!functionName) {
        return { success: false, error: 'create requires functionName' };
    }

    const scheduleTypeRaw = String(params.scheduleType || params.type || 'interval').trim().toLowerCase();
    let normalizedScheduleType = 'interval';
    if (['interval', 'every', 'repeat'].includes(scheduleTypeRaw)) {
        normalizedScheduleType = 'interval';
    } else if (['at', 'attime', 'at-time', 'time', 'datetime', 'once'].includes(scheduleTypeRaw)) {
        normalizedScheduleType = 'atTime';
    } else if (['keyword', 'text'].includes(scheduleTypeRaw)) {
        normalizedScheduleType = 'keyword';
    } else if (['domchange', 'dom-change', 'contentchange', 'content-change', 'mutation', 'pagechange', 'page-change'].includes(scheduleTypeRaw)) {
        normalizedScheduleType = 'domChange';
    } else {
        return { success: false, error: `Unsupported scheduleType: ${scheduleTypeRaw}` };
    }
    const id = String(params.id || createSchedulerJobId());
    if (schedulerJobs[id]) {
        return { success: false, error: `Scheduler job "${id}" already exists` };
    }

    const now = Date.now();
    const defaultTriggerMode = normalizedScheduleType === 'domChange' ? 'everyMatch' : 'oncePerUrl';
    const normalizedTriggerMode = params.triggerMode === 'oncePerUrl' || params.triggerMode === 'everyMatch'
        ? params.triggerMode
        : defaultTriggerMode;
    const job = {
        id,
        name: String(params.jobName || `${functionName}_${normalizedScheduleType}_${id.slice(-4)}`),
        functionName,
        inputs: (params.inputs && typeof params.inputs === 'object') ? params.inputs : {},
        scheduleType: normalizedScheduleType,
        enabled: params.enabled !== false,
        createdAt: now,
        target: params.target === 'fixedTab' ? 'fixedTab' : 'activeTab',
        tabId: Number.isInteger(params.tabId) ? params.tabId : (params.target === 'fixedTab' ? context.tabId : null),
        urlPattern: typeof params.urlPattern === 'string' ? params.urlPattern.trim() : '',
        urlPatterns: Array.isArray(params.urlPatterns) ? params.urlPatterns : undefined,
        cooldownMinutes: Number.isFinite(Number(params.cooldownMinutes)) ? Number(params.cooldownMinutes) : 0,
        triggerMode: normalizedTriggerMode,
        caseSensitive: !!params.caseSensitive,
        matchWholeWord: !!params.matchWholeWord
    };

    if (job.scheduleType === 'interval') {
        const minutes = Number(params.intervalMinutes ?? params.everyMinutes ?? params.minutes ?? 5);
        if (!Number.isFinite(minutes) || minutes < 1) {
            return { success: false, error: 'interval schedule requires intervalMinutes >= 1' };
        }
        job.intervalMinutes = minutes;
    } else if (job.scheduleType === 'atTime') {
        const atTimeMs = parseSchedulerAtTime(params.atTime ?? params.when ?? params.time);
        if (!Number.isFinite(atTimeMs)) {
            return { success: false, error: 'atTime schedule requires valid atTime/when/time' };
        }
        if (atTimeMs <= Date.now()) {
            return { success: false, error: 'atTime must be in the future' };
        }
        job.atTimeMs = atTimeMs;
        job.atTimeISO = new Date(atTimeMs).toISOString();
    } else if (job.scheduleType === 'keyword') {
        const keyword = String(params.keyword || '').trim();
        if (!keyword) {
            return { success: false, error: 'keyword schedule requires keyword' };
        }
        job.keyword = keyword;
        job.target = 'activeTab';
        job.tabId = null;
    } else if (job.scheduleType === 'domChange') {
        const selector = String(params.domSelector || params.selector || 'body').trim();
        const debounceRaw = Number(params.domDebounceMs ?? params.debounceMs ?? params.debounce ?? 1200);
        const minAddedRaw = Number(params.minAddedNodes ?? params.minAdded ?? 1);

        job.domSelector = selector || 'body';
        job.domDebounceMs = Number.isFinite(debounceRaw)
            ? Math.max(200, Math.min(60000, debounceRaw))
            : 1200;
        job.minAddedNodes = Number.isFinite(minAddedRaw)
            ? Math.max(1, Math.floor(minAddedRaw))
            : 1;
        job.runOnPageLoad = params.runOnPageLoad !== false;
        job.runOnScroll = params.runOnScroll === true;
        if (job.target === 'fixedTab' && !Number.isInteger(job.tabId)) {
            return { success: false, error: 'domChange fixedTab schedules require tabId or active tab context' };
        }
    }

    schedulerJobs[id] = job;
    await persistSchedulerJobs();

    if (job.scheduleType === 'interval' || job.scheduleType === 'atTime') {
        await scheduleAlarmForJob(job);
        await persistSchedulerJobs();
    }
    if (job.scheduleType === 'domChange') {
        await syncDomChangeObservers('create');
    }

    let runResult = null;
    if (params.runNow === true || params.runOnCreate === true) {
        runResult = await executeSchedulerJob(id, { trigger: 'manual', tabId: context.tabId });
    }

    return { success: true, job: sanitizeSchedulerJob(job), runResult };
}

schedulerInitPromise = initializeScheduler().catch((e) => {
    console.warn('[Scheduler] Initialization failed:', e.message);
    schedulerJobs = {};
});

schedulerInitPromise.then(() => {
    runKeywordSchedulesForActiveTab('startup').catch(() => { });
    syncDomChangeObservers('startup').catch((e) => {
        console.warn('[Scheduler] Startup DOM watcher sync skipped:', e.message);
    });
}).catch((e) => {
    // Guard against unhandled promise rejections in startup sequencing.
    console.warn('[Scheduler] Startup keyword check skipped:', e.message);
});

chrome.alarms.onAlarm.addListener((alarm) => {
    if (!alarm?.name || !alarm.name.startsWith(SCHEDULER_ALARM_PREFIX)) return;
    const jobId = alarm.name.slice(SCHEDULER_ALARM_PREFIX.length);
    executeSchedulerJob(jobId, { trigger: 'alarm' }).catch((e) => {
        console.warn(`[Scheduler] Alarm execution failed for ${jobId}:`, e.message);
    });
});

chrome.windows.onFocusChanged.addListener((windowId) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) return;
    runKeywordSchedulesForActiveTab('window-focus').catch(() => { });
    syncDomChangeObservers('window-focus').catch(() => { });
});

// --- Listeners to Keep UI in Sync ---
const takeScreenshot = (tabId) => new Promise(async (resolve) => {
    try {
        const tab = await chrome.tabs.get(tabId);
        // Bring the tab into focus before capturing (captureVisibleTab requires visible tab)
        await chrome.tabs.update(tabId, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
        // Small delay to ensure tab is rendered
        setTimeout(() => {
            chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 75 }, (dataUrl) => {
                if (chrome.runtime.lastError) {
                    const rawError = chrome.runtime.lastError.message || 'captureVisibleTab failed';
                    const hint = getKeepTabActiveHint(rawError);
                    log(`❌ Screenshot failed: ${rawError}${hint ? ` ${hint}` : ''}`);
                    resolve(null);
                } else {
                    resolve(dataUrl);
                }
            });
        }, 400);
    } catch (e) {
        log(`❌ Screenshot failed: Could not get tab details. ${e.message}`);
        resolve(null);
    }
});

// --- Navigation Recording ---
chrome.webNavigation.onCommitted.addListener((details) => {
    if (isRecording && details.frameId === 0) {
        // Filter out internal chrome:// and edge:// URLs
        if (details.url.startsWith('chrome://') || details.url.startsWith('edge://') || details.url.startsWith('about:') || details.url.startsWith('chrome-extension://')) {
            log(`⚠️ Skipping internal page: ${details.url}`);
            return;
        }

        // Check if this is a redundant event
        const lastStep = currentRecording.steps[currentRecording.steps.length - 1];
        if (lastStep && lastStep.action === 'navigate' && lastStep.url === details.url) {
            return;
        }

        // Add navigation step
        const stepId = Date.now() + Math.random().toString(36).substr(2, 9);

        // Distinguish between direct navigation and action result
        const directTransitions = ['typed', 'generated', 'auto_bookmark', 'reload', 'manual_subframe'];
        const isDirect = directTransitions.includes(details.transitionType);

        const newStep = {
            action: 'navigate',
            url: details.url,
            timestamp: Date.now(),
            stepId: stepId,
            transitionType: details.transitionType,
            navigationSource: isDirect ? 'Direct' : 'Result'
        };
        currentRecording.steps.push(newStep);
        saveStateToStorage();
        log(`Recorded: NAVIGATE to ${details.url} (${details.transitionType}) - ${newStep.navigationSource}`);

        safeSendMessage({ type: 'recordingStateUpdate', isRecording, recording: currentRecording, recordingMode });
    }
});

chrome.webNavigation.onCompleted.addListener((details) => {
    if (isRecording && details.frameId === 0) {
        chrome.tabs.get(details.tabId, (tab) => {
            if (!tab.active || tab.url.startsWith('chrome://')) return;
            chrome.scripting.executeScript({ target: { tabId: details.tabId }, files: ['content/content.js'] }).catch(err => console.log("Failed to inject script:", err));
        });
    }
});

// Inject content script when user switches to a new tab during recording
chrome.tabs.onActivated.addListener((activeInfo) => {
    if (isRecording) {
        chrome.tabs.get(activeInfo.tabId, (tab) => {
            if (chrome.runtime.lastError || !tab) return;
            if (tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('edge://') && !tab.url.startsWith('about:')) {
                chrome.scripting.executeScript({ target: { tabId: activeInfo.tabId }, files: ['content/content.js'] }).catch(err => console.log("Failed to inject on tab switch:", err));
            }
        });
    }
});

// --- Tab Switching Recording ---
chrome.tabs.onActivated.addListener(async (activeInfo) => {
    // Sync UI
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab && tab.url) safeSendMessage({ type: 'tasksUpdate', tasks: allTasks, currentUrl: tab.url });
    runKeywordSchedulesForActiveTab('tab-activated').catch(() => { });
    syncDomChangeObservers('tab-activated').catch(() => { });

    if (isRecording) {
        const stepId = Date.now() + Math.random().toString(36).substr(2, 9);
        const newStep = {
            action: 'switchTab',
            url: tab.url,
            title: tab.title,
            timestamp: Date.now(),
            stepId: stepId
        };
        currentRecording.steps.push(newStep);
        log(`Recorded: SWITCH TAB to ${tab.title}`);
        safeSendMessage({ type: 'recordingStateUpdate', isRecording, recording: currentRecording, recordingMode });

        // Capture screenshot of the new tab
        setTimeout(async () => {
            const dataUrl = await takeScreenshot(activeInfo.tabId);
            if (dataUrl) {
                // We can't crop an element here, just full view
                // We can artificially create a "Viewport" rect
                chrome.runtime.sendMessage({
                    type: 'process-screenshot-with-element',
                    target: 'offscreen',
                    data: {
                        screenshot: dataUrl,
                        rect: { x: 0, y: 0, width: 1920, height: 1080 }, // Dummy full rect or just don't pass rect
                        elementName: `Tab: ${tab.title}`,
                        originalStepId: stepId
                    }
                });
            }
        }, 500);
    }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab.url) {
        syncDomChangeObserverForTab(tab, 'tab-updated').catch(() => { });
        chrome.tabs.query({ active: true, currentWindow: true }, (activeTabs) => {
            if (activeTabs.length > 0 && activeTabs[0].id === tabId) {
                safeSendMessage({ type: 'tasksUpdate', tasks: allTasks, currentUrl: tab.url });
                runKeywordSchedulesForActiveTab('tab-updated').catch(() => { });
            }
        });
    }
});

chrome.tabs.onRemoved.addListener((tabId) => {
    clearDomRuntimeStateForTab(tabId);
});

function generalizeUrl(url) { if (!url || !url.startsWith('http')) return url; try { const urlObj = new URL(url); const patterns = [/(\/c\/)[\w-]+/, /(\/search\/)[\w-.~%]+/, /(\/watch\?v=)[\w-]+/, /(\/t\/)[\w-]+/, /(\/d\/)[\w-]+/]; for (const pattern of patterns) { if (pattern.test(urlObj.pathname)) { urlObj.pathname = urlObj.pathname.replace(pattern, '$1*'); return urlObj.href.endsWith('/') ? urlObj.href.slice(0, -1) : urlObj.href; } } return url; } catch (e) { return url; } }

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    let responded = false;
    const rawSendResponse = sendResponse;
    sendResponse = (payload) => {
        if (responded) return;
        responded = true;
        try {
            rawSendResponse(payload);
        } catch {
            // Ignore response channel errors.
        }
    };

    (async () => {
        try {
        switch (message.type) {
            case 'getInitialState': { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); safeSendMessage({ type: 'recordingStateUpdate', isRecording, recording: currentRecording, recordingMode }); safeSendMessage({ type: 'tasksUpdate', tasks: allTasks, currentUrl: tab?.url }); break; }
            case 'getSessionLogs': { sendResponse({ logs: sessionLogs }); break; }
            case 'startRecording': { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); if (tab) await startRecording(tab.id, tab.url, 'selector'); break; }
            case 'startLiteralRecording': { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); if (tab) await startRecording(tab.id, tab.url, 'literal'); break; }
            case 'stopRecording': { stopRecording(); break; }
            case 'recordEvent': {
                if (!isRecording) break;
                const { event } = message;

                // Create a unique ID for this step to match with screenshot later
                const stepId = Date.now() + Math.random().toString(36).substr(2, 9);

                let newStep = null;

                if (recordingMode === 'literal') {
                    // ... Literal mode logic (simplified for this edit, assume mostly same but adding screenshot trigger) ...
                    // For now, focusing on Selector mode as that's the primary context for "element labeled"
                    // But user said "every step". 

                    const lastStep = currentRecording.steps[currentRecording.steps.length - 1];
                    const isTypingEvent = event.action === 'literal_keydown' && event.key.length === 1;
                    clearTimeout(literalTypingDebounceTimer);

                    if (isTypingEvent) {
                        // ... (typing grouping logic) ...
                        if (lastStep && lastStep.action === 'literal_type' && lastStep.selector === event.selector) {
                            lastStep.value += event.key; lastStep.timestamp = Date.now(); log(`Recorded [L]: Key '${event.key}' (grouped)`);
                            // Update screenshot not needed for every single keystroke in partial group, maybe just last one?
                            // Let's attach the ID to the lastStep so we can update it if needed.
                            lastStep.stepId = stepId;
                            newStep = lastStep;
                        } else {
                            newStep = { action: 'literal_type', value: event.key, selector: event.selector, elementName: event.elementName, timestamp: Date.now(), stepId };
                            currentRecording.steps.push(newStep); log(`Recorded [L]: Started typing '${event.key}'`);
                        }
                        literalTypingDebounceTimer = setTimeout(() => { log(`- Typing paused, group finalized.`); literalTypingDebounceTimer = null; }, 750);
                    } else {
                        newStep = { ...event, timestamp: Date.now(), stepId };
                        currentRecording.steps.push(newStep); const actionName = newStep.action.replace('literal_', '').toUpperCase(); log(`Recorded [L]: ${actionName}`);
                    }

                } else { // Selector mode
                    newStep = {
                        action: event.action,
                        selector: event.selector,
                        value: event.value,
                        url: event.url,
                        elementName: event.elementName,
                        html: event.html, // Ensure HTML is stored
                        href: event.href, // For hover links
                        selectedText: event.selectedText,
                        timestamp: Date.now(),
                        stepId: stepId
                    };

                    const lastStep = currentRecording.steps[currentRecording.steps.length - 1];

                    // Grouping logic for type / scroll
                    if (lastStep && lastStep.action === 'type' && newStep.action === 'type' && lastStep.selector === newStep.selector) {
                        lastStep.value = newStep.value;
                        lastStep.stepId = stepId; // Update ID to latest interaction
                        newStep = lastStep;
                        log(`Updated value for [${lastStep.elementName}]`);
                    }
                    else if (lastStep && lastStep.action === 'scroll' && newStep.action === 'scroll') {
                        lastStep.value = newStep.value;
                        newStep = lastStep;
                    }
                    else if (newStep.action === 'hover') {
                        // Hover logic: Don't spam.
                        if (lastStep && lastStep.action === 'hover' && lastStep.selector === newStep.selector) {
                            newStep = null; // Duplicate hover
                        } else {
                            currentRecording.steps.push(newStep);
                            log(`Recorded: HOVER on [${newStep.elementName}]`);
                        }
                    }
                    else {
                        currentRecording.steps.push(newStep);
                        const actionName = newStep.action.toUpperCase();
                        const targetName = newStep.elementName ? ` on [${newStep.elementName}]` : '';
                        log(`Recorded: ${actionName}${targetName}`);
                    }
                }
                saveStateToStorage();
                safeSendMessage({ type: 'recordingStateUpdate', isRecording, recording: currentRecording, recordingMode });

                // --- Trigger Screenshot Processing ---
                // We do this for all steps where it makes sense (clicks, type, etc).
                // Avoid screenshot for hover unless we really want it (user said "save screenshots at everystep").
                // Let's include hover for now, it might be useful to see what was hovered.
                if (newStep && (newStep.action !== 'scroll' && newStep.action !== 'literal_keydown' || event.key === 'Enter')) {
                    // Start async screenshot process

                    (async () => {
                        const tab = sender.tab; // Use sender tab
                        if (tab && !tab.url.startsWith('chrome://') && !tab.url.startsWith('edge://') && !tab.url.startsWith('about:')) {
                            const dataUrl = await takeScreenshot(tab.id);
                            if (dataUrl) {
                                // Create offscreen to process
                                await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['BLOBS'], justification: 'Processing screenshot' }).catch(() => { });
                                chrome.runtime.sendMessage({
                                    type: 'process-screenshot-with-element',
                                    target: 'offscreen',
                                    data: {
                                        screenshot: dataUrl,
                                        rect: event.rect,
                                        elementName: event.elementName,
                                        scroll: event.scroll,
                                        viewport: event.viewport,
                                        devicePixelRatio: event.devicePixelRatio,
                                        originalStepId: stepId
                                    }
                                });
                            }
                        }
                    })();
                }
                break;
            }
            case 'processed-screenshot': {
                const { labeledDataUrl, croppedDataUrl, originalStepId } = message;
                // Find the step and update it
                const stepIndex = currentRecording.steps.findIndex(s => s.stepId === originalStepId);
                if (stepIndex !== -1) {
                    currentRecording.steps[stepIndex].screenshotLabeledUrl = labeledDataUrl;
                    currentRecording.steps[stepIndex].elementCropUrl = croppedDataUrl;
                    log(`✅ Screenshot processed for step ${stepIndex + 1}`);
                }
                break;
            }
            case 'addScreenshotStep': { if (!isRecording) break; clearTimeout(literalTypingDebounceTimer); const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); if (tab) { currentRecording.steps.push({ action: 'screenshot', elementName: 'Capture Page', url: tab.url, timestamp: Date.now() }); saveStateToStorage(); log(`Recorded: SCREENSHOT`); safeSendMessage({ type: 'recordingStateUpdate', isRecording, recording: currentRecording, recordingMode }); } break; }
            case 'addFullPageScreenshotStep': { if (!isRecording) break; clearTimeout(literalTypingDebounceTimer); const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); if (tab) { currentRecording.steps.push({ action: 'screenshotFullPage', elementName: 'Capture Full Page', url: tab.url, timestamp: Date.now() }); saveStateToStorage(); log(`Recorded: FULL PAGE SCREENSHOT`); safeSendMessage({ type: 'recordingStateUpdate', isRecording, recording: currentRecording, recordingMode }); } break; }
            case 'addLargestTextStep': { if (!isRecording) break; clearTimeout(literalTypingDebounceTimer); const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); if (tab) { currentRecording.steps.push({ action: 'getLargestText', elementName: 'Find Largest Text Block', url: tab.url, timestamp: Date.now() }); saveStateToStorage(); log(`Recorded: GET LARGEST TEXT`); safeSendMessage({ type: 'recordingStateUpdate', isRecording, recording: currentRecording, recordingMode }); } break; }
            case 'saveCurrentTask': {
                if (message.name && currentRecording.steps.length > 0) {
                    clearTimeout(literalTypingDebounceTimer);
                    if (currentRecording.steps.length > 1) { for (let i = 1; i < currentRecording.steps.length; i++) { currentRecording.steps[i].delay = currentRecording.steps[i].timestamp - currentRecording.steps[i - 1].timestamp; } }
                    if (currentRecording.steps.length > 0) currentRecording.steps[0].delay = 500;

                    currentRecording.steps.forEach(step => { delete step.screenshot; delete step.timestamp; if (step.url && recordingMode === 'selector') step.url = generalizeUrl(step.url); });
                    const uniqueUrls = [...new Set(currentRecording.steps.filter(s => s.action !== 'navigate' && s.url).map(step => new URL(step.url).origin + '/*'))];

                    const taskToSave = { name: message.name, description: message.description || '', mode: recordingMode, urlPatterns: uniqueUrls.join(',') || 'https://*/*', steps: currentRecording.steps, parameters: [], dynamicContentCheck: false };
                    allTasks[message.name] = taskToSave;

                    log(`Task '${message.name}' saved.`);
                    await chrome.storage.local.set({ tasks: allTasks });
                    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                    safeSendMessage({ type: 'tasksUpdate', tasks: allTasks, currentUrl: tab?.url });
                    currentRecording = { steps: [] };
                    safeSendMessage({ type: 'recordingStateUpdate', isRecording, recording: currentRecording, recordingMode });
                }
                break;
            }
            case 'updateTask': { const { taskName, updatedTask } = message; if (allTasks[taskName] && updatedTask) { allTasks[taskName] = updatedTask; await chrome.storage.local.set({ tasks: allTasks }); log(`Task '${taskName}' updated successfully.`); } else { log(`Error: Could not find task '${taskName}' to update.`); } break; }
            case 'executeTask': { await executeTask(message.name, message.params); break; }
            case 'deleteTask': { delete allTasks[message.name]; log(`Task '${message.name}' deleted.`); await chrome.storage.local.set({ tasks: allTasks }); const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); safeSendMessage({ type: 'tasksUpdate', tasks: allTasks, currentUrl: tab?.url }); break; }
            case 'clickElementByText': {
                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                if (tab) {
                    log(`Attempting to click element containing text: "${message.text}"`);
                    const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: clickElementByText, args: [message.text] });
                    if (result?.result?.success) { log(`✅ Clicked element. Found ${result.result.count} match(es).`); }
                    else { log(`❌ Could not find a clickable element with that text.`); }
                }
                break;
            }
            case 'stitchedImage': {
                if (message.dataUrl) { safeSendMessage({ type: 'returnValueUpdate', value: { text: [], screenshots: [message.dataUrl] } }); log('✅ Full page screenshot captured.'); }
                else { log('❌ Full page screenshot failed during stitching.'); }
                break;
            }
            case 'startAudioRecording': {
                await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['USER_MEDIA'], justification: 'Recording user audio' }).catch(() => { });
                const storage = await chrome.storage.local.get('selectedAudioDeviceId');
                chrome.runtime.sendMessage({
                    type: 'start-recording-audio',
                    target: 'offscreen',
                    deviceId: storage.selectedAudioDeviceId || null
                });
                log('🎙️ Microphone started...');
                break;
            }
            case 'stopAudioRecording': {
                chrome.runtime.sendMessage({ type: 'stop-recording-audio', target: 'offscreen' });
                log('🛑 Microphone stopped.');
                break;
            }
            case 'audioRecorded': {
                const { audioData } = message; // Base64
                if (isRecording && currentRecording.steps.length > 0) {
                    // Attach to the last step? or Create a new "Annotation" step? 
                    // User said "attach it in between the steps"
                    // Let's create a distinct Audio Step
                    const stepId = Date.now() + Math.random().toString(36).substr(2, 9);
                    const newStep = {
                        action: 'audio_annotation',
                        audioData: audioData,
                        timestamp: Date.now(),
                        stepId: stepId,
                        elementName: 'Audio Note',
                        html: '<html><body>Audio Note</body></html>', // Placeholder HTML
                        url: currentRecording.steps.length > 0 ? currentRecording.steps[currentRecording.steps.length - 1].url : 'unknown'
                    };
                    currentRecording.steps.push(newStep);
                    saveStateToStorage();
                    log(`Recorded: 🎵 Audio Annotation`);
                    safeSendMessage({ type: 'recordingStateUpdate', isRecording, recording: currentRecording, recordingMode });
                }
                break;
            }
            case 'addTextNote': {
                if (isRecording) {
                    const stepId = Date.now() + Math.random().toString(36).substr(2, 9);
                    const newStep = {
                        action: 'text_annotation',
                        text: message.text,
                        timestamp: Date.now(),
                        stepId: stepId,
                        elementName: 'Text Note',
                        html: '<html><body>Text Note</body></html>', // Placeholder HTML
                        url: currentRecording.steps.length > 0 ? currentRecording.steps[currentRecording.steps.length - 1].url : 'unknown'
                    };
                    currentRecording.steps.push(newStep);
                    saveStateToStorage();
                    log(`Recorded: 🗒️ Text Note`);
                    safeSendMessage({ type: 'recordingStateUpdate', isRecording, recording: currentRecording, recordingMode });
                }
                break;
            }
            case 'setAiStopState': {
                setAiStopState(!!message.stop, message.reason || '');
                sendResponse({
                    success: true,
                    stopRequested: isAiStopRequested(),
                    reason: aiStopState.reason
                });
                break;
            }
            case 'executeGeneratedFunction': {
                const { functionDef, inputs, tabId } = message;
                const result = await executeGeneratedFunction(functionDef, inputs, tabId);
                sendResponse(result);
                break;
            }
            case 'startSmartScrape': {
                try {
                    // Use provided tabId if available, otherwise find by URL, otherwise active tab
                    let tab;
                    if (message.tabId) {
                        try {
                            tab = await chrome.tabs.get(message.tabId);
                        } catch (e) {
                            log(`⚠️ startSmartScrape: Provided tabId ${message.tabId} not found, falling back to active tab`);
                        }
                    }
                    if (!tab && message.pageUrl) {
                        // Try to find a tab matching the recording URL
                        const matchingTabs = await chrome.tabs.query({ url: message.pageUrl + '*' });
                        if (matchingTabs.length > 0) {
                            tab = matchingTabs[0];
                            log(`📍 startSmartScrape: Found tab by URL match: ${tab.url}`);
                        }
                    }
                    if (!tab) {
                        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
                        tab = activeTab;
                    }
                    if (!tab || !tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('edge://') || tab.url.startsWith('about:') || tab.url.startsWith('chrome-extension://')) {
                        log(`❌ startSmartScrape: No suitable tab found (tab=${!!tab}, url=${tab?.url})`);
                        sendResponse({ error: 'Cannot scrape this page', screenshot: null });
                        break;
                    }
                    log(`📸 startSmartScrape: Capturing tab ${tab.id} (${tab.url.substring(0, 60)}...)`);
                    const screenshot = await takeScreenshot(tab.id);
                    if (!screenshot) {
                        log(`❌ startSmartScrape: Screenshot capture returned null`);
                        log(`?? Keep the target tab active and window visible (not minimized) during Smart Scrape.`);
                    }
                    sendResponse({ screenshot, url: tab.url, tabId: tab.id });
                } catch (e) {
                    log(`❌ startSmartScrape error: ${e.message}`);
                    sendResponse({ error: e.message, screenshot: null });
                }
                break;
            }
            case 'captureTabScreenshot': {
                try {
                    const tab = await chrome.tabs.get(message.tabId);
                    await chrome.tabs.update(message.tabId, { active: true });
                    await chrome.windows.update(tab.windowId, { focused: true });
                    await new Promise(r => setTimeout(r, 500));
                    const dataUrl = await new Promise(resolve => {
                        chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }, (url) => {
                            if (chrome.runtime.lastError) {
                                const rawError = chrome.runtime.lastError.message || 'captureVisibleTab failed';
                                const hint = getKeepTabActiveHint(rawError);
                                log(`❌ captureTabScreenshot failed: ${rawError}${hint ? ` ${hint}` : ''}`);
                                resolve(null);
                                return;
                            }
                            resolve(url);
                        });
                    });
                    sendResponse({ screenshot: dataUrl });
                } catch (e) {
                    log(`❌ captureTabScreenshot error: ${e.message}`);
                    sendResponse({ screenshot: null, error: e.message });
                }
                break;
            }
            case 'smartScrapeToolCall': {
                const { toolName, toolArgs, tabId: scrapeTabId } = message;
                try {
                    const toolResult = await self.__smartScrapeToolInvoker(toolName, toolArgs, scrapeTabId);
                    sendResponse(toolResult ?? { error: `No response from tool "${toolName}"` });
                } catch (e) {
                    sendResponse({ error: e.message });
                }
                break;
            }
            case 'schedulerDomChangeDetected': {
                const domResult = await handleSchedulerDomChangeEvent(message, sender);
                sendResponse(domResult);
                break;
            }

            // ===== Tool System Message Handlers =====
            case 'executeToolAction': {
                try {
                    const toolApiKey = message.apiKey || (await chrome.storage.local.get(['geminiApiKey'])).geminiApiKey;
                    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
                    const result = await ToolRegistry.execute(message.toolName, message.params || {}, {
                        apiKey: toolApiKey,
                        tabId: message.tabId || activeTab?.id
                    });
                    sendResponse({ success: true, result });
                } catch (e) {
                    sendResponse({ success: false, error: e.message });
                }
                break;
            }
            case 'getAvailableTools': {
                try {
                    const tools = await ToolRegistry.listAvailable();
                    sendResponse({ success: true, tools });
                } catch (e) {
                    sendResponse({ success: false, tools: [], error: e.message });
                }
                break;
            }
            case 'ollamaHealthCheck': {
                try {
                    const available = await OllamaService.healthCheck(true);
                    const models = available ? await OllamaService.listModels() : [];
                    sendResponse({ available, models });
                } catch (e) {
                    sendResponse({ available: false, models: [], error: e.message });
                }
                break;
            }
            case 'saveOllamaSettings': {
                const embeddingModel = message.embeddingModel || message.model;
                const normalized = {
                    ollamaUrl: message.url || 'http://localhost:11434',
                    ollamaModel: (message.model || '').trim(),
                    ollamaEmbeddingModel: (embeddingModel || '').trim(),
                    embeddingEngine: message.embeddingEngine || 'gemini'
                };
                await chrome.storage.local.set(normalized);
                await syncOllamaRuntimeSettings(normalized);
                sendResponse({ success: true });
                break;
            }
            case 'getBackendSettings': {
                if (typeof BackendFunctionService === 'undefined') {
                    sendResponse({ success: false, error: 'BackendFunctionService unavailable' });
                    break;
                }
                const settings = await BackendFunctionService.getSettings();
                sendResponse({ success: true, settings });
                break;
            }
            case 'saveBackendSettings': {
                if (typeof BackendFunctionService === 'undefined') {
                    sendResponse({ success: false, error: 'BackendFunctionService unavailable' });
                    break;
                }
                const normalized = BackendFunctionService.normalizeSettings({
                    backendEnabled: message.backendEnabled,
                    backendUrl: message.backendUrl,
                    backendUploadEnabled: message.backendUploadEnabled,
                    backendSearchTopK: message.backendSearchTopK
                });
                await chrome.storage.local.set(normalized);
                sendResponse({ success: true, settings: normalized });
                break;
            }
            case 'backendHealthCheck': {
                if (typeof BackendFunctionService === 'undefined') {
                    sendResponse({ success: false, status: 'offline', error: 'BackendFunctionService unavailable' });
                    break;
                }
                const health = await BackendFunctionService.healthCheck({
                    backendEnabled: message.backendEnabled,
                    backendUrl: message.backendUrl,
                    backendUploadEnabled: message.backendUploadEnabled,
                    backendSearchTopK: message.backendSearchTopK
                });
                sendResponse(health);
                break;
            }
            case 'hydrateBackendFunctionsForTask': {
                if (typeof BackendFunctionService === 'undefined') {
                    sendResponse({ success: false, error: 'BackendFunctionService unavailable' });
                    break;
                }
                const hydrate = await BackendFunctionService.hydrateForTask({
                    query: message.query || message.taskDescription || '',
                    currentUrl: message.currentUrl || '',
                    topK: message.topK,
                    onlyWhenNoLocalMatches: message.onlyWhenNoLocalMatches === true
                });
                if (hydrate?.allFunctions) {
                    safeSendMessage({
                        type: 'functionsLibraryUpdated',
                        functions: hydrate.allFunctions
                    });
                }
                sendResponse({ success: true, result: hydrate });
                break;
            }
            case 'searchBackendFunctions': {
                if (typeof BackendFunctionService === 'undefined') {
                    sendResponse({ success: false, error: 'BackendFunctionService unavailable' });
                    break;
                }
                const result = await BackendFunctionService.searchFunctions({
                    query: message.query || '',
                    currentUrl: message.currentUrl || '',
                    topK: message.topK,
                    queryEmbedding: message.queryEmbedding
                });
                sendResponse({ success: true, result });
                break;
            }
            case 'executeToolChain': {
                try {
                    if (isAiStopRequested()) {
                        throw new Error(aiStopState.reason || 'Stopped by user');
                    }
                    const chainApiKey = message.apiKey || (await chrome.storage.local.get(['geminiApiKey'])).geminiApiKey;
                    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
                    const result = await ToolOrchestrator.executeFullPipeline(message.taskDescription, chainApiKey, {
                        tabId: message.tabId || activeTab?.id,
                        shouldAbort: () => isAiStopRequested(),
                        onStatusUpdate: (msg, meta) => {
                            safeSendMessage({ type: 'toolChainStatus', message: msg, metadata: meta });
                        }
                    });
                    sendResponse({ success: true, result });
                } catch (e) {
                    sendResponse({ success: false, error: e.message });
                }
                break;
            }

            case 'testDriverAction': {
                try {
                    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
                    const tabId = message.tabId || activeTab?.id;
                    const result = await executeDriverAction(message.action, message.data, tabId);
                    sendResponse({ success: true, result });
                } catch (e) {
                    sendResponse({ success: false, error: e.message });
                }
                break;
            }

            case 'listRegisteredTools': {
                try {
                    const tools = await ToolRegistry.listAvailable();
                    sendResponse({ success: true, tools });
                } catch (e) {
                    sendResponse({ success: false, error: e.message });
                }
                break;
            }
        }
        } catch (e) {
            log(`❌ onMessage handler error (${message?.type || 'unknown'}): ${e.message}`);
            sendResponse({ success: false, error: e.message });
        } finally {
            if (!responded) {
                sendResponse({ success: true });
            }
        }
    })();
    return true; // Keep channel open for async response
});

// Register existing services as tools in the ToolRegistry
ToolRegistry.register('computer_use_api', {
    description: 'Autonomous browser control via screenshots and Gemini Computer Use API. Navigates, clicks, types on any page visually.',
    capabilities: ['navigation', 'interaction', 'visual', 'autonomous'],
    parameters: {
        type: 'OBJECT',
        properties: {
            taskDescription: { type: 'STRING', description: 'What to do on the page' },
            action: { type: 'STRING', enum: ['click', 'type', 'scroll', 'navigate', 'wait'], description: 'Optional shorthand action when taskDescription is not supplied.' },
            text: { type: 'STRING', description: 'Optional shorthand target text for click/type actions.' },
            url: { type: 'STRING', description: 'Optional URL to navigate to before acting.' },
            regionPreference: { type: 'STRING', enum: ['us', 'ca', 'auto'], description: 'Preferred country selection when a geo splash appears.' },
            tabId: { type: 'NUMBER' },
            useCurrentTab: { type: 'BOOLEAN', description: 'When true, constrain actions to the current tab and avoid opening new tabs/windows.' },
            target: { type: 'STRING', enum: ['auto', 'current-tab'], description: 'Tab behavior hint. Use \"current-tab\" to stay in the active tab.' },
            options: { type: 'OBJECT', description: 'Optional Computer Use runtime options (maxActions, excludedFunctions, etc.).' }
        },
        required: []
    },
    execute: async (params, context) => {
        const clickByVisibleTextFallback = async (tabId, targetText) => {
            if (!tabId || !targetText) return { success: false, reason: 'missing-tab-or-text' };
            try {
                const [execResult] = await chrome.scripting.executeScript({
                    target: { tabId },
                    func: (text) => {
                        const needle = String(text || '').trim().toLowerCase();
                        if (!needle) return { clicked: false, reason: 'empty-text' };
                        const selectors = [
                            'button',
                            'a',
                            '[role="button"]',
                            'input[type="button"]',
                            'input[type="submit"]',
                            'label'
                        ];
                        const nodes = Array.from(document.querySelectorAll(selectors.join(',')));
                        const getText = (el) => (
                            (el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || '').trim()
                        );
                        let best = null;
                        let bestScore = 0;
                        for (const el of nodes) {
                            const textValue = getText(el).toLowerCase();
                            if (!textValue) continue;
                            let score = 0;
                            if (textValue === needle) score = 3;
                            else if (textValue.includes(needle)) score = 2;
                            else if (needle.includes(textValue)) score = 1;
                            if (score > bestScore) {
                                best = el;
                                bestScore = score;
                            }
                        }
                        if (!best) return { clicked: false, reason: 'no-matching-element' };
                        best.click();
                        return {
                            clicked: true,
                            matchedText: getText(best),
                            tagName: best.tagName
                        };
                    },
                    args: [targetText]
                });
                const payload = execResult?.result || {};
                return { success: !!payload.clicked, ...payload };
            } catch (error) {
                return { success: false, reason: error?.message || String(error) };
            }
        };

        let effectiveTabId = params.tabId || context.tabId;
        if (!Number.isInteger(effectiveTabId)) {
            const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
            effectiveTabId = activeTab?.id;
        }
        if (!Number.isInteger(effectiveTabId)) {
            throw new Error('No active tab available for computer_use_api');
        }

        const useCurrentTab =
            params.useCurrentTab === true
            || String(params.target || '').toLowerCase() === 'current-tab';
        const runOptions = (params.options && typeof params.options === 'object')
            ? { ...params.options }
            : {};
        const shorthandAction = String(params.action || '').trim().toLowerCase();
        const shorthandText = String(params.text || '').trim();
        const shorthandUrl = String(params.url || '').trim();
        const normalizedRegion = String(params.regionPreference || params.region || 'auto').trim().toLowerCase();
        const regionPreference = (normalizedRegion === 'us' || normalizedRegion === 'ca') ? normalizedRegion : 'auto';
        const regionLabel = regionPreference === 'ca' ? 'Canada' : 'United States';
        let taskDescription = String(params.taskDescription || '').trim();

        if (!taskDescription) {
            const parts = [];
            if (shorthandUrl) {
                parts.push(`Navigate to ${shorthandUrl}.`);
            }
            if (regionPreference !== 'auto') {
                parts.push(`If a country or region selection prompt appears, choose "${regionLabel}".`);
            }
            if (shorthandAction === 'click') {
                parts.push(shorthandText
                    ? `Click the control with visible text "${shorthandText}".`
                    : 'Click the required control.');
            } else if (shorthandAction === 'type') {
                parts.push(shorthandText
                    ? `Type "${shorthandText}" into the appropriate input field.`
                    : 'Type into the required input field.');
            } else if (shorthandAction === 'scroll') {
                parts.push(shorthandText
                    ? `Scroll ${shorthandText}.`
                    : 'Scroll down and continue.');
            } else if (shorthandAction === 'wait') {
                parts.push('Wait for the page to load and stabilize.');
            } else if (shorthandAction === 'navigate') {
                if (!shorthandUrl) {
                    parts.push('Navigate to the required page and continue.');
                }
            }
            taskDescription = parts.join(' ').trim();
        }
        if (!taskDescription) {
            taskDescription = 'Complete the requested browser task.';
        }

        if (regionPreference !== 'auto' && !/country|region|united states|canada/i.test(taskDescription)) {
            taskDescription += ` If a country/region selector appears, click "${regionLabel}".`;
        }

        if (shorthandUrl) {
            try {
                await executeAINavigate({ url: shorthandUrl }, effectiveTabId, 20000);
            } catch (navError) {
                console.warn('[computer_use_api] Pre-navigation failed, falling back to visual navigation:', navError?.message || navError);
            }
        }

        let constrainedTaskDescription = taskDescription;
        if (useCurrentTab) {
            constrainedTaskDescription += '\n\nTAB CONSTRAINT: Operate only in the current existing tab. Do not open a new tab or browser window unless explicitly asked.';
            const excludedFunctions = Array.isArray(runOptions.excludedFunctions)
                ? runOptions.excludedFunctions.filter(Boolean)
                : [];
            if (!excludedFunctions.includes('open_web_browser')) {
                excludedFunctions.push('open_web_browser');
            }
            runOptions.excludedFunctions = excludedFunctions;
        }

        const runResult = await runComputerUseWithSettings(
            constrainedTaskDescription,
            context.apiKey,
            effectiveTabId,
            runOptions
        );
        if (
            !runResult?.success
            && /invalid argument/i.test(String(runResult?.error || ''))
            && shorthandAction === 'click'
            && shorthandText
        ) {
            const fallbackClick = await clickByVisibleTextFallback(effectiveTabId, shorthandText);
            if (fallbackClick.success) {
                return {
                    success: true,
                    fallback: 'dom-click-by-text',
                    matchedText: fallbackClick.matchedText || shorthandText,
                    tagName: fallbackClick.tagName || ''
                };
            }
        }
        return runResult;
    }
});

ToolRegistry.register('current_tab_content', {
    description: 'Read a text snapshot of the current tab (URL, title, headings, and body preview) without navigating.',
    capabilities: ['context', 'current-tab', 'snapshot', 'grounding'],
    parameters: {
        type: 'OBJECT',
        properties: {
            tabId: { type: 'NUMBER', description: 'Optional tab ID. Defaults to active tab.' },
            maxChars: { type: 'NUMBER', description: 'Max body text chars to return (1000-12000, default 6000).' }
        },
        required: []
    },
    execute: async (params, context) => {
        let effectiveTabId = params.tabId || context.tabId;
        if (!Number.isInteger(effectiveTabId)) {
            const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
            effectiveTabId = activeTab?.id;
        }
        if (!Number.isInteger(effectiveTabId)) {
            throw new Error('No active tab available for current_tab_content');
        }

        const tab = await chrome.tabs.get(effectiveTabId);
        if (!tab?.url || isInternalPageUrl(tab.url)) {
            return {
                success: false,
                tabId: effectiveTabId,
                url: tab?.url || '',
                error: `Cannot read tab content from internal URL: ${tab?.url || 'unknown'}`
            };
        }

        const snapshot = await getPageContentSnapshot(effectiveTabId, params.maxChars);
        if (snapshot?.error) {
            return {
                success: false,
                tabId: effectiveTabId,
                url: tab.url,
                error: snapshot.error
            };
        }

        return {
            success: true,
            tabId: effectiveTabId,
            ...snapshot
        };
    }
});

ToolRegistry.register('remote_intelligence_api', {
    description: 'Complex reasoning, code generation, and analysis via Gemini API. Use for tasks too complex for local LLM.',
    capabilities: ['reasoning', 'code-generation', 'analysis', 'summarization', 'complex-tasks'],
    parameters: {
        type: 'OBJECT',
        properties: {
            prompt: { type: 'STRING' },
            parseJson: { type: 'BOOLEAN' },
            provider: { type: 'STRING', enum: ['gemini', 'ollama'] },
            model: { type: 'STRING' }
        },
        required: ['prompt']
    },
    execute: async (params, context) => {
        const provider = String(params.provider || 'gemini').toLowerCase();
        const promptText = String(params.prompt || '');
        const inferredJson = params.parseJson === undefined
            && /(?:valid\s+)?json|json\s+array|json\s+object|return\s+only\s+json|strict\s+json|reply\s+with\s+only/i.test(promptText);
        const wantsJson = params.parseJson === true || inferredJson;
        if (provider === 'ollama') {
            const local = await OllamaService.generate(params.prompt, { model: params.model });
            if (!local?.success) {
                throw new Error(local?.error || 'Ollama request failed');
            }
            if (!wantsJson) return local.response;
            try {
                return AIService._extractJsonFromText(local.response || '');
            } catch (e) {
                throw new Error(`Ollama JSON parse failed: ${e.message}`);
            }
        }
        const requestBody = {
            contents: [{ role: 'user', parts: [{ text: params.prompt }] }],
            generationConfig: wantsJson ? { responseMimeType: 'application/json' } : {}
        };
        const geminiResult = await AIService.callGemini(
            requestBody,
            context.apiKey,
            wantsJson,
            { model: params.model }
        );
        if (wantsJson) return geminiResult;
        const text = geminiResult?.candidates?.[0]?.content?.parts?.find(p => typeof p.text === 'string')?.text;
        return text ?? geminiResult;
    }
});

function tokenizeForMatch(text) {
    return new Set(
        String(text || '')
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .split(/\s+/)
            .map(t => t.trim())
            .filter(t => t.length >= 3)
    );
}

function normalizePatternList(patterns) {
    if (Array.isArray(patterns)) return patterns.filter(Boolean);
    if (typeof patterns === 'string') {
        return patterns.split(',').map(p => p.trim()).filter(Boolean);
    }
    return [];
}

function scoreFunctionForTask(func, taskDescription) {
    const taskTokens = tokenizeForMatch(taskDescription);
    if (taskTokens.size === 0) return 0;

    const extractStep = (func.steps || []).find(s => s.type === 'extractScript');
    const fieldNames = (extractStep?.fields || []).map(f => f.name).join(' ');
    const functionText = [
        func.name,
        func.description,
        func.outputs?.description,
        fieldNames
    ].filter(Boolean).join(' ');
    const fnTokens = tokenizeForMatch(functionText);

    let overlap = 0;
    for (const tok of taskTokens) {
        if (fnTokens.has(tok)) overlap++;
    }
    return overlap;
}

async function findReusableSmartScraper(currentUrl, taskDescription) {
    const generatedFunctions = Object.values(await FunctionLibraryService.getAll());

    const isSmartScrapeLike = (func) => {
        if (!func || typeof func !== 'object') return false;
        if (func.source === 'smartScrape') return true;
        return Array.isArray(func.steps) && func.steps.some(step => step?.type === 'extractScript');
    };

    const urlMatched = generatedFunctions.filter(func => {
        if (!isSmartScrapeLike(func)) return false;
        const patterns = normalizePatternList(func.urlPatterns);
        if (patterns.length === 0) return false;
        return patterns.some(pattern => {
            try {
                return urlMatchesPattern(currentUrl, pattern);
            } catch {
                return false;
            }
        });
    });

    if (urlMatched.length === 0 && typeof BackendFunctionService !== 'undefined') {
        try {
            const backendSearch = await BackendFunctionService.searchFunctions({
                query: taskDescription || '',
                currentUrl,
                topK: 5
            });
            if (backendSearch?.success && Array.isArray(backendSearch.results) && backendSearch.results.length > 0) {
                const scraperCandidates = backendSearch.results.filter(entry => {
                    const func = entry?.functionDef;
                    return isSmartScrapeLike(func);
                });
                if (scraperCandidates.length > 0) {
                    const imported = await BackendFunctionService.importResults(scraperCandidates.slice(0, 1), { unique: true });
                    const importedFunction = imported?.saved?.[0]?.functionDef || null;
                    if (importedFunction) {
                        safeSendMessage({
                            type: 'functionsLibraryUpdated',
                            functions: imported.allFunctions
                        });
                        return importedFunction;
                    }
                }
            }
        } catch (error) {
            console.warn('[Backend] Smart scraper fallback search failed:', error.message);
        }
        return null;
    }

    if (urlMatched.length === 0) return null;

    const ranked = urlMatched
        .map(func => ({ func, score: scoreFunctionForTask(func, taskDescription) }))
        .sort((a, b) => b.score - a.score);

    const best = ranked[0];
    if (!best) return null;

    // If we don't have a meaningful text match, still allow single clear URL match.
    if (best.score <= 0 && ranked.length > 1) return null;
    return best.func;
}

function normalizeRegionPreference(value, fallback = 'us') {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'ca' || normalized === 'canada') return 'ca';
    if (normalized === 'us' || normalized === 'usa' || normalized === 'united states') return 'us';
    return fallback;
}

function _isMeaningfulFieldValue(value) {
    if (value === null || value === undefined) return false;
    if (typeof value === 'number') return Number.isFinite(value);
    const text = String(value).trim();
    if (!text) return false;
    if (/^(n\/a|na|null|undefined|see site|check link|check website)$/i.test(text)) return false;
    return true;
}

function _requestedComparisonFields(taskDescription = '') {
    const text = String(taskDescription || '').toLowerCase();
    const requested = new Set();
    if (/\btitle|name|product\b/.test(text)) requested.add('title');
    if (/\bprice|cost\b/.test(text)) requested.add('price');
    if (/\brating|stars?|review\b/.test(text)) requested.add('rating');
    if (/\bavailability|in stock|stock\b/.test(text)) requested.add('availability');
    if (/\bimage|thumbnail|photo|picture\b/.test(text)) requested.add('imageUrl');
    return requested;
}

function _isReusableExtractionUseful(rows, taskDescription = '') {
    if (!Array.isArray(rows) || rows.length === 0) return false;

    const sample = rows.slice(0, 12);
    const requestedFields = _requestedComparisonFields(taskDescription);
    const hasSingleLinkOnly = sample.every(item => {
        if (!item || typeof item !== 'object') return false;
        const keys = Object.keys(item);
        if (keys.length === 0) return true;
        const lowerKeys = keys.map(k => k.toLowerCase());
        return lowerKeys.every(k => k === 'link' || k === 'url');
    });
    if (hasSingleLinkOnly) return false;

    if (requestedFields.size === 0) return true;
    for (const field of requestedFields) {
        const hasAny = sample.some(item => _isMeaningfulFieldValue(item?.[field]));
        if (!hasAny) return false;
    }
    return true;
}

async function _isGenericRegionSplashVisible(tabId) {
    try {
        const snapshot = await getPageContentSnapshot(tabId, 3200);
        if (snapshot?.error) return false;
        const combined = [
            snapshot?.title || '',
            snapshot?.headings || '',
            snapshot?.bodyTextPreview || '',
            snapshot?.url || ''
        ].join(' ').toLowerCase();
        const hasRegionWords =
            /\b(country|region|locale|location)\b/.test(combined)
            || /select\s+(your\s+)?country/.test(combined)
            || /choose\s+(your\s+)?country/.test(combined);
        const hasOptionWords =
            combined.includes('united states')
            || combined.includes('canada')
            || combined.includes('international');
        return hasRegionWords && hasOptionWords;
    } catch {
        return false;
    }
}

async function ensureRegionGateSelection(tabId, apiKey, regionPreference = 'us') {
    const region = normalizeRegionPreference(regionPreference, 'us');
    const label = region === 'ca' ? 'Canada' : 'United States';

    const genericVisible = await _isGenericRegionSplashVisible(tabId);
    if (!genericVisible) return { success: true, handled: false };

    const taskDescription = [
        `A country/region selection screen is visible.`,
        `Choose "${label}" if available.`,
        `Stay in the current tab.`,
        `Do not open new tabs or windows.`,
        `After selection, wait for product content to load.`
    ].join(' ');

    await runComputerUseWithSettings(
        taskDescription,
        apiKey,
        tabId,
        {
            maxActions: 12,
            excludedFunctions: ['open_web_browser']
        }
    );

    const stillVisible = await _isGenericRegionSplashVisible(tabId);
    if (stillVisible) {
        return {
            success: false,
            handled: true,
            error: `Country/region selector is still visible after trying "${label}".`
        };
    }
    return { success: true, handled: true, region };
}

ToolRegistry.register('universal_flexible_scraper', {
    description: 'AI-powered web scraper with auto-scroll, pagination detection, and structured JSON output. Extracts data from any page.',
    capabilities: ['scraping', 'extraction', 'pagination', 'auto-scroll', 'structured-data'],
    parameters: {
        type: 'OBJECT',
        properties: {
            description: { type: 'STRING', description: 'What data to extract from the page' },
            tabId: { type: 'NUMBER' },
            extractionHints: { type: 'ARRAY', items: { type: 'STRING' } },
            url: { type: 'STRING', description: 'Optional target URL to navigate before scraping' },
            instructions: { type: 'STRING', description: 'Optional detailed scrape instruction alias for description' },
            prompt: { type: 'STRING', description: 'Alias for description/instructions' },
            schema: { type: 'OBJECT', description: 'Optional schema hints for extraction fields' },
            regionPreference: { type: 'STRING', enum: ['us', 'ca'], description: 'Preferred country selection when a region/country gate appears.' },
            forceFresh: { type: 'BOOLEAN', description: 'When true, skip reusable scraper and run a fresh agentic scrape.' }
        },
        required: []
    },
    execute: async (params, context) => {
        const tabId = params.tabId || context.tabId;
        const taskDescription = params.description || params.instructions || params.prompt || params.query || params.task || 'Extract structured data from the page';
        const forceFresh = params.forceFresh === true || params.forceRescrape === true;
        const regionPreference = normalizeRegionPreference(params.regionPreference, 'us');
        let tab = await chrome.tabs.get(tabId);

        const targetUrl = typeof params.url === 'string' ? params.url.trim() : '';
        if (targetUrl) {
            let shouldNavigate = true;
            try {
                shouldNavigate = new URL(tab.url).href !== new URL(targetUrl).href;
            } catch {
                shouldNavigate = tab.url !== targetUrl;
            }

            if (shouldNavigate) {
                const navResult = await executeAINavigate({ url: targetUrl }, tabId, 20000);
                if (!navResult?.success) {
                    await runComputerUseWithSettings(
                        `Navigate to this URL and wait until the page is ready: ${targetUrl}`,
                        context.apiKey,
                        tabId,
                        {}
                    );
                }
                tab = await chrome.tabs.get(tabId);
            }
        }

        const genericRegionResult = await ensureRegionGateSelection(tabId, context.apiKey, regionPreference);
        if (!genericRegionResult?.success) {
            return {
                success: false,
                error: genericRegionResult?.error || 'Failed to pass country/region selector',
                regionPreference
            };
        }

        if (!tab?.url || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('chrome://') || tab.url.startsWith('edge://') || tab.url.startsWith('about:')) {
            return {
                success: false,
                error: `Cannot run scraper on internal URL: ${tab?.url || 'unknown'}`
            };
        }

        // Reuse existing URL-matched scraper first to keep workflows fast and stable.
        const reusable = forceFresh ? null : await findReusableSmartScraper(tab.url, taskDescription);
        if (reusable) {
            try {
                const reusedRun = await executeGeneratedFunction(reusable, {}, tabId);
                const reusedData = reusedRun?.data;
                if (
                    reusedRun?.success
                    && Array.isArray(reusedData)
                    && reusedData.length > 0
                    && _isReusableExtractionUseful(reusedData, taskDescription)
                ) {
                    console.log(`[UniversalScraper] Reused existing scraper "${reusable.name}" on ${tab.url}`);
                    return {
                        success: true,
                        reused: true,
                        reusedFunctionName: reusable.name,
                        result: reusedData,
                        savedFunction: {
                            name: reusable.name,
                            description: reusable.description
                        },
                        lastExtractionResult: {
                            success: true,
                            result: reusedData,
                            resultLength: reusedData.length
                        },
                        totalTurns: 0
                    };
                }
                if (reusedRun?.success && Array.isArray(reusedData) && reusedData.length > 0) {
                    console.warn(`[UniversalScraper] Reusable scraper "${reusable.name}" returned low-quality data for requested fields. Running fresh scrape.`);
                }
            } catch (e) {
                console.warn(`[UniversalScraper] Reuse attempt failed (${reusable.name}):`, e.message);
            }
        }

        const screenshot = await takeScreenshot(tabId);
        if (!screenshot) {
            return {
                success: false,
                error: `Failed to capture screenshot before scraping: ${tab.url}`
            };
        }
        const schemaHints = params.schema && typeof params.schema === 'object'
            ? Object.keys(params.schema).join(', ')
            : '';
        const mergedHints = [params.extractionHints, schemaHints].filter(Boolean).join(', ');
        const result = await AIService.agenticScrape(
            screenshot, tab.url, context.apiKey, tabId,
            params.onStatusUpdate || (() => {}),
            [taskDescription, mergedHints].filter(Boolean).join(', ')
        );
        const primaryRows = Array.isArray(result?.lastExtractionResult?.result) ? result.lastExtractionResult.result : [];
        const qualityOk = _isReusableExtractionUseful(primaryRows, taskDescription);
        if (!qualityOk) {
            const retryScreenshot = await takeScreenshot(tabId);
            if (retryScreenshot) {
                const qualityHint = [
                    taskDescription,
                    'REQUIRED FIELDS: title, price, rating, availability, imageUrl, url.',
                    'For each required field: if present on page, extract it; avoid returning null placeholders.',
                    'Prefer product-card container selectors and relative field selectors.'
                ].join(' ');
                const retryResult = await AIService.agenticScrape(
                    retryScreenshot,
                    tab.url,
                    context.apiKey,
                    tabId,
                    params.onStatusUpdate || (() => {}),
                    qualityHint
                );
                const retryRows = Array.isArray(retryResult?.lastExtractionResult?.result) ? retryResult.lastExtractionResult.result : [];
                if (_isReusableExtractionUseful(retryRows, taskDescription)) {
                    return {
                        ...retryResult,
                        success: !!retryResult?.savedFunction,
                        qualityRetried: true,
                        result: retryRows
                    };
                }
            }
        }
        return {
            ...result,
            success: !!result?.savedFunction,
            qualityRetried: !qualityOk,
            result: primaryRows
        };
    }
});

ToolRegistry.register('task_scheduler', {
    description: 'Schedule saved functions by interval, specific time, keyword detection, or live DOM/content change triggers. Examples: every 30m (scheduleType=interval), daily at 09:00 (scheduleType=atTime), keyword trigger (scheduleType=keyword), feed updates/infinite scroll (scheduleType=domChange).',
    capabilities: ['scheduler', 'automation', 'time-based', 'trigger', 'keyword-monitoring', 'dom-change-monitoring'],
    parameters: {
        type: 'OBJECT',
        properties: {
            action: {
                type: 'STRING',
                enum: ['create', 'list', 'remove', 'delete', 'runNow', 'enable', 'disable', 'clear']
            },
            id: { type: 'STRING', description: 'Scheduler job ID for runNow/remove/enable/disable' },
            functionName: { type: 'STRING', description: 'Saved function name to run' },
            jobName: { type: 'STRING', description: 'Optional human-readable scheduler name' },
            inputs: { type: 'OBJECT', description: 'Inputs to pass to the function at execution time' },
            scheduleType: { type: 'STRING', enum: ['interval', 'atTime', 'keyword', 'domChange'] },
            intervalMinutes: { type: 'NUMBER', description: 'For interval schedules, run every N minutes (>= 1)' },
            atTime: { type: 'STRING', description: 'For atTime schedules: ISO datetime, timestamp, or HH:mm' },
            keyword: { type: 'STRING', description: 'For keyword schedules: trigger when this text appears on active tab' },
            domSelector: { type: 'STRING', description: 'For domChange schedules: observe this CSS selector subtree (default: body)' },
            domDebounceMs: { type: 'NUMBER', description: 'For domChange schedules: debounce delay before triggering run (200-60000ms)' },
            minAddedNodes: { type: 'NUMBER', description: 'For domChange schedules: minimum number of added nodes before firing trigger' },
            runOnPageLoad: { type: 'BOOLEAN', description: 'For domChange schedules: trigger once after page load/refresh' },
            runOnScroll: { type: 'BOOLEAN', description: 'For domChange schedules: also trigger after downward scroll activity' },
            caseSensitive: { type: 'BOOLEAN', description: 'Keyword matching case sensitivity' },
            matchWholeWord: { type: 'BOOLEAN', description: 'Keyword matching as whole word only' },
            triggerMode: { type: 'STRING', enum: ['oncePerUrl', 'everyMatch'] },
            cooldownMinutes: { type: 'NUMBER', description: 'Minimum time between runs for this job' },
            enabled: { type: 'BOOLEAN' },
            target: { type: 'STRING', enum: ['activeTab', 'fixedTab'] },
            tabId: { type: 'NUMBER', description: 'Optional fixed tab for scheduled execution' },
            urlPattern: { type: 'STRING', description: 'Optional URL wildcard pattern filter' },
            urlPatterns: { type: 'ARRAY', items: { type: 'STRING' } },
            runNow: { type: 'BOOLEAN', description: 'Run immediately after creating the job' },
            runOnCreate: { type: 'BOOLEAN', description: 'Alias for runNow' }
        },
        required: ['action']
    },
    execute: async (params, context) => {
        return await executeTaskSchedulerAction(params, context);
    }
});

async function startRecording(tabId, currentUrl, mode = 'selector') {
    if (isRecording) return;
    // Skip internal pages
    if (currentUrl.startsWith('chrome://') || currentUrl.startsWith('chrome-extension://') || currentUrl.startsWith('edge://') || currentUrl.startsWith('about:')) {
        log('❌ Cannot record on internal Chrome pages.');
        safeSendMessage({ type: 'recordingStateUpdate', isRecording: false, recording: { steps: [] }, recordingMode: 'selector' });
        return;
    }
    isRecording = true; recordingMode = mode;
    log(`Recording started in ${mode.toUpperCase()} mode...`);

    if (mode === 'literal') {
        const tab = await chrome.tabs.get(tabId);
        await chrome.windows.update(tab.windowId, { state: 'maximized' });
        currentRecording = { steps: [{ action: 'startLiteral', url: currentUrl, timestamp: Date.now() }] };
    } else {
        currentRecording = { steps: [{ action: 'navigate', url: currentUrl, timestamp: Date.now() }] };
        log(`Starting on page: ${currentUrl}`);
    }

    safeSendMessage({ type: 'recordingStateUpdate', isRecording, recording: currentRecording, recordingMode });
    saveStateToStorage();

    try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content/content.js'] });
        await chrome.scripting.executeScript({ target: { tabId }, func: (recMode) => { if (window.setAutomatorRecordingMode) { window.setAutomatorRecordingMode(recMode); } }, args: [mode] });
    } catch (err) {
        log(`⚠️ Could not inject content script: ${err.message}`);
    }
}

async function stopRecording() {
    if (!isRecording) return;
    isRecording = false;
    clearTimeout(literalTypingDebounceTimer);
    literalTypingDebounceTimer = null;

    // Notify content script to stop listening
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
        chrome.tabs.sendMessage(tab.id, { action: "stopRecording" }).catch(() => { });
    }

    log('Recording stopped.');
    safeSendMessage({ type: 'recordingStateUpdate', isRecording, recording: currentRecording, recordingMode });
    saveStateToStorage();
}

async function executeTask(taskName, params = {}) {
    const task = allTasks[taskName];
    if (!task) {
        log(`Error: Task '${taskName}' not found.`);
        return { success: false, error: `Task "${taskName}" not found` };
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
        log('No active tab found for task execution; runtime will bootstrap an execution tab if needed.');
    }

    if (typeof RecordedTaskAdapter === 'undefined') {
        log('Error: RecordedTaskAdapter is not loaded.');
        return { success: false, error: 'RecordedTaskAdapter not loaded' };
    }

    const functionDef = RecordedTaskAdapter.toGeneratedFunction(task, taskName);
    if (!Array.isArray(functionDef?.steps) || functionDef.steps.length === 0) {
        const err = `Task "${taskName}" has no executable steps after normalization`;
        log(`Error: ${err}`);
        return { success: false, error: err };
    }

    log(`Executing task "${taskName}" via unified function runtime...`);
    if (Object.keys(params || {}).length > 0) {
        log(`- With parameters: ${JSON.stringify(params)}`);
    }

    const result = await executeGeneratedFunction(functionDef, params, tab?.id || null);
    if (!result?.success) {
        log(`❌ Task "${taskName}" failed: ${result?.error || 'Unknown error'}`);
        return result;
    }

    log(`✅ Task "${taskName}" finished.`);
    return result;
}

// In-page execution functions
function executeLiteralClickOnPage(x, y) { try { const el = document.elementFromPoint(x, y); if (!el) return { success: false, error: `No element found at (${x}, ${y})` }; el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y })); el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y })); el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y })); return { success: true }; } catch (e) { return { success: false, error: e.message }; } }
function executeLiteralKeydownOnPage(key, code, selector) {
    try {
        const el = document.querySelector(selector) || document.activeElement;
        if (!el) return { success: false, error: 'No active element to type into.' };
        el.focus();
        el.dispatchEvent(new KeyboardEvent('keydown', { key: key, code: code, bubbles: true, cancelable: true, composed: true }));

        if (key.length === 1) {
            if (el.isContentEditable) {
                document.execCommand('insertText', false, key);
            } else if (typeof el.value !== 'undefined') {
                el.value += key;
            }
            el.dispatchEvent(new Event('input', { bubbles: true }));
        } else if (key === 'Backspace' && typeof el.value !== 'undefined') {
            el.value = el.value.slice(0, -1);
            el.dispatchEvent(new Event('input', { bubbles: true }));
        } else if (key === 'Enter') {
            const parentForm = el.closest('form');
            if (parentForm) {
                if (typeof parentForm.requestSubmit === 'function') {
                    parentForm.requestSubmit();
                } else {
                    parentForm.submit();
                }
            }
        }

        el.dispatchEvent(new KeyboardEvent('keyup', { key: key, code: code, bubbles: true, cancelable: true, composed: true }));
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
}
async function executeLiteralTypeOnPage(text, selector) { const el = document.querySelector(selector) || document.activeElement; if (!el) return { success: false, error: 'No active element to type into.' }; el.focus(); const isContentEditable = el.isContentEditable; if (!isContentEditable && typeof el.value !== 'undefined') el.value = ''; else if (isContentEditable) el.textContent = ''; for (const char of text) { el.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true, cancelable: true })); if (isContentEditable) document.execCommand('insertText', false, char); else if (typeof el.value !== 'undefined') el.value += char; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true, cancelable: true })); await new Promise(r => setTimeout(r, 30 + Math.random() * 50)); } return { success: true }; }

// Helper and Utility Functions
function waitForPageContentToSettle(timeout, stabilityPeriod, checkInterval) {
    return new Promise((resolve) => {
        const startTime = Date.now();
        let lastText = document.body.innerText;
        let stableSince = Date.now();
        const intervalId = setInterval(() => {
            if (Date.now() - startTime > timeout) {
                clearInterval(intervalId);
                resolve({ success: false, error: 'timed out' });
                return;
            }
            const currentText = document.body.innerText;
            if (currentText === lastText) {
                if (Date.now() - stableSince > stabilityPeriod) {
                    clearInterval(intervalId);
                    resolve({ success: true, final_text: currentText.substring(0, 5000) });
                }
            } else {
                lastText = currentText;
                stableSince = Date.now();
            }
        }, checkInterval);
    });
}
async function getLargestTextElement(tabId) { const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: () => { const candidates = Array.from(document.querySelectorAll('div, main, article, section, p')); if (candidates.length === 0) return document.body.innerText.trim(); const largestElement = candidates.filter(el => el.offsetHeight > 0).reduce((largest, current) => { const currentText = current.innerText || ''; const largestText = largest.innerText || ''; return currentText.length > largestText.length ? current : largest; }, candidates[0]); return largestElement ? largestElement.innerText.trim() : document.body.innerText.trim(); } }); return res?.result; }
function clickElementByText(text) { const escapeXPath = (str) => { const parts = str.split("'"); if (parts.length === 1) return `'${str}'`; return `concat(${parts.map(p => `'${p}'`).join(", \"'\", ")})`; }; const iterator = document.evaluate(`.//*[not(self::script) and not(self::style) and text()[contains(., ${escapeXPath(text)})]]`, document.body, null, XPathResult.ORDERED_NODE_ITERATOR_TYPE, null); const candidates = []; let node = iterator.iterateNext(); while (node) { const rect = node.getBoundingClientRect(); if (rect.width > 0 && rect.height > 0) { candidates.push(node); } node = iterator.iterateNext(); } if (candidates.length === 0) return { success: false }; for (const candidate of candidates.reverse()) { let el = candidate; while (el && el !== document.body) { if (el.tagName === 'A' || el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' || el.onclick) { el.click(); return { success: true, count: candidates.length }; } el = el.parentElement; } } if (candidates.length > 0) { candidates[candidates.length - 1].click(); return { success: true, count: candidates.length }; } return { success: false }; }
function urlMatchesPattern(url, pattern) { if (!pattern || !url) return false; try { const regex = new RegExp("^" + pattern.split("*").map(s => s.replace(/([.*+?^=!:${}()|\[\]\/\\])/g, "\\$1")).join(".*") + "$"); return regex.test(url); } catch (e) { return url === pattern; } }
function waitForElement(tabId, selector, timeout = 10000) {
    return new Promise(async (resolve) => {
        if (!selector) {
            resolve(false);
            return;
        }
        try {
            const [res] = await chrome.scripting.executeScript({
                target: { tabId },
                func: (sel, to) => new Promise(r => {
                    const start = Date.now();
                    const i = setInterval(() => {
                        if (document.querySelector(sel)) {
                            clearInterval(i);
                            r(true);
                        } else if (Date.now() - start > to) {
                            clearInterval(i);
                            r(false);
                        }
                    }, 100);
                }),
                args: [selector, timeout]
            });
            resolve(res?.result);
        } catch (e) {
            resolve(false);
        }
    });
}
async function takeFullPageScreenshot(tabId) { const [pageDetails] = await chrome.scripting.executeScript({ target: { tabId }, func: () => ({ height: document.body.scrollHeight, width: document.body.scrollWidth, vh: window.innerHeight, vw: window.innerWidth }) }); const { height, width, vh, vw } = pageDetails.result; let captures = []; for (let y = 0; y < height; y += vh) { await chrome.scripting.executeScript({ target: { tabId }, func: (yPos) => window.scrollTo(0, yPos), args: [y] }); await new Promise(r => setTimeout(r, 500)); const dataUrl = await takeScreenshot(tabId); if (dataUrl) captures.push(dataUrl); } await chrome.scripting.executeScript({ target: { tabId }, func: () => window.scrollTo(0, 0) }); if (captures.length > 0) { const offscreen = await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['BLOBS'], justification: 'Stitching screenshots' }).catch(() => { }); if (offscreen) chrome.runtime.sendMessage({ type: 'stitch-images', target: 'offscreen', data: { captures, width, height, vh, vw } }); } }

// ==================== AI-GENERATED FUNCTION EXECUTION ====================

async function executeGeneratedFunction(functionDef, inputs = {}, targetTabId = null) {
    const modelStateSnapshot = applyFunctionModelPreferences(functionDef?.modelPreferences || {});
    const needsCurrentContext = functionNeedsCurrentPageContext(functionDef);
    let tab;
    if (targetTabId) {
        try {
            tab = await chrome.tabs.get(targetTabId);
        } catch (e) {
            log(`Target tab ${targetTabId} not found: ${e.message}`);
            if (needsCurrentContext) {
                restoreFunctionModelPreferences(modelStateSnapshot);
                return { success: false, error: 'Target tab not found for current-page function' };
            }
            tab = null;
        }
    }

    if (!tab) {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        tab = activeTab || null;
    }

    if (!tab) {
        if (needsCurrentContext) {
            log('Error: No active tab found for current-page function.');
            restoreFunctionModelPreferences(modelStateSnapshot);
            return { success: false, error: 'No active tab found for current-page function' };
        }
        try {
            tab = await createAutomationExecutionTab(functionDef);
            log(`No active tab found; created execution tab ${tab.id} (${tab.url}).`);
        } catch (createError) {
            log(`Error: Failed to create execution tab: ${createError.message}`);
            restoreFunctionModelPreferences(modelStateSnapshot);
            return { success: false, error: 'Unable to create execution tab' };
        }
    }

    if (tab && !needsCurrentContext && isInternalPageUrl(tab.url)) {
        try {
            const replacementTab = await createAutomationExecutionTab(functionDef);
            log(`Active tab was internal; created execution tab ${replacementTab.id} (${replacementTab.url}).`);
            tab = replacementTab;
        } catch (createError) {
            log(`Error: Failed to create execution tab from internal active tab: ${createError.message}`);
            restoreFunctionModelPreferences(modelStateSnapshot);
            return { success: false, error: 'Unable to create execution tab' };
        }
    }

    if (isAiStopRequested()) {
        const reason = aiStopState.reason || 'Stopped by user';
        log(`?? Execution cancelled before start: ${reason}`);
        restoreFunctionModelPreferences(modelStateSnapshot);
        return { success: false, error: reason, aborted: true };
    }

    if (needsCurrentContext && isInternalPageUrl(tab.url)) {
        const fallbackTab = await findFallbackAutomationTab(tab.windowId, tab.id);
        if (!fallbackTab) {
            const error = 'Current-page function needs a regular webpage tab, but current tab is internal/about.';
            log(`❌ ${error}`);
            restoreFunctionModelPreferences(modelStateSnapshot);
            return { success: false, error };
        }
        tab = fallbackTab;
        log(`  ℹ️ Using active webpage tab for Computer Use context: ${tab.url}`);
    }

    log(`🤖 Executing AI function: ${functionDef.name}`);
    if (Object.keys(inputs).length > 0) {
        log(`  With inputs: ${JSON.stringify(inputs)}`);
    }

    let executionResults = { text: [], screenshots: [], data: null };
    safeSendMessage({ type: 'clearReturnValue' });

    // Initialize Sandbox (for script steps) - MUST use offscreen.html which relays to sandbox iframe
    await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['DOM_PARSER'],
        justification: 'Sandboxed script execution'
    }).catch(() => { });

    try {
        // Check URL pattern match
        const currentUrl = tab.url;
        const urlPatterns = functionDef.urlPatterns || [];
        const matchesUrl = urlPatterns.length === 0 || urlPatterns.some(pattern => urlMatchesPattern(currentUrl, pattern));

        if (!matchesUrl) {
            log(`⚠️ Warning: Current URL may not match function's expected patterns.`);
        }

        // Execute each step
        for (let i = 0; i < functionDef.steps.length; i++) {
            if (isAiStopRequested()) {
                const reason = aiStopState.reason || 'Stopped by user';
                log(`?? Execution cancelled at step ${i + 1}: ${reason}`);
                return { success: false, error: reason, step: i + 1, aborted: true };
            }
            const step = functionDef.steps[i];
            const stepNum = i + 1;

            // Basic parameter substitution outside of loops
            // Deep clone to avoid mutating original definition across runs
            const stepClone = JSON.parse(JSON.stringify(step));
            substituteStepParams(stepClone, inputs);

            // Fallback: If navigate step has no URL, use function's startUrl
            if (stepClone.type === 'navigate' && !stepClone.url && functionDef.startUrl) {
                stepClone.url = functionDef.startUrl;
                log(`  📍 Using startUrl fallback: ${stepClone.url}`);
            }

            // Fix relative URLs in navigate steps — resolve using urlPatterns or current tab
            if (stepClone.type === 'navigate' && stepClone.url && stepClone.url.startsWith('/')) {
                let resolvedOrigin = null;

                // Try urlPatterns first (most reliable)
                const patterns = functionDef.urlPatterns || [];
                for (const pattern of patterns) {
                    try {
                        const cleanUrl = pattern.replace(/\*/g, 'x');
                        const parsed = new URL(cleanUrl);
                        resolvedOrigin = parsed.origin;
                        break;
                    } catch { /* skip malformed patterns */ }
                }

                // Fallback: use current tab URL if it's a web page
                if (!resolvedOrigin) {
                    try {
                        const currentTab = await chrome.tabs.get(tab.id);
                        if (currentTab.url && currentTab.url.startsWith('http')) {
                            resolvedOrigin = new URL(currentTab.url).origin;
                        }
                    } catch { /* ignore */ }
                }

                if (resolvedOrigin) {
                    const absoluteUrl = resolvedOrigin + stepClone.url;
                    log(`  🔗 Resolved relative URL: ${stepClone.url} → ${absoluteUrl}`);
                    stepClone.url = absoluteUrl;
                }
            }

            log(`  Step ${stepNum}/${functionDef.steps.length}: ${stepClone.type.toUpperCase()}`);

            const stepResult = await executeAIStep(stepClone, tab.id, inputs);

            if (!stepResult || !stepResult.success) {
                const errorMsg = stepResult?.error || 'Unknown error';
                log(`  ❌ Step ${stepNum} failed: ${errorMsg}`);
                return { success: false, error: errorMsg, step: stepNum };
            }

            if (stepResult?.nextTabId && stepResult.nextTabId !== tab.id) {
                try {
                    tab = await chrome.tabs.get(stepResult.nextTabId);
                } catch (tabSwitchError) {
                    log(`  ⚠️ Step ${stepNum} switched tab but could not resolve new tab: ${tabSwitchError.message}`);
                }
            }

            if (stepResult) {
                if (stepResult.extracted) {
                    if (!executionResults.data) executionResults.data = [];
                    if (Array.isArray(stepResult.extracted)) {
                        executionResults.data.push(...stepResult.extracted);
                    } else {
                        executionResults.data.push(stepResult.extracted);
                    }
                } else if (stepResult.result !== undefined) {
                    // Script steps usually return the full dataset
                    // If it's an array, we might want to use it as the main result
                    if (!executionResults.data) executionResults.data = stepResult.result;
                    else if (Array.isArray(stepResult.result) && Array.isArray(executionResults.data)) {
                        executionResults.data.push(...stepResult.result);
                    } else {
                        // If type mismatch or single value, just overwrite or push?
                        // Let's assume script result is authoritative if present
                        executionResults.data = stepResult.result;
                    }
                }
                if (stepResult.text !== undefined && stepResult.text !== null && String(stepResult.text).trim()) {
                    executionResults.text.push(String(stepResult.text));
                }
                if (stepResult.screenshot) {
                    executionResults.screenshots.push(stepResult.screenshot);
                }
                if (Array.isArray(stepResult.screenshots) && stepResult.screenshots.length > 0) {
                    executionResults.screenshots.push(...stepResult.screenshots.filter(Boolean));
                }
            }

            log(`  ✅ Step ${stepNum} completed`);
        }

        // Return results
        if (executionResults.data) {
            safeSendMessage({
                type: 'returnValueUpdate',
                value: {
                    text: [JSON.stringify(executionResults.data, null, 2)],
                    screenshots: []
                }
            });
        } else if (executionResults.text.length > 0 || executionResults.screenshots.length > 0) {
            safeSendMessage({
                type: 'returnValueUpdate',
                value: {
                    text: executionResults.text,
                    screenshots: executionResults.screenshots
                }
            });
        }

        log(`✅ Function "${functionDef.name}" completed successfully.`);
        const outputData = executionResults.data !== null
            ? executionResults.data
            : {
                text: executionResults.text,
                screenshots: executionResults.screenshots
            };
        return { success: true, data: outputData };

    } catch (error) {
        log(`❌ Function execution error: ${error.message}`);
        return { success: false, error: error.message };
    } finally {
        restoreFunctionModelPreferences(modelStateSnapshot);
    }
}

function substituteStepParams(step, inputs) {
    if (step.value) step.value = substituteParams(step.value, inputs);
    if (step.url) step.url = substituteParams(step.url, inputs);
    if (step.selector) step.selector = substituteParams(step.selector, inputs);
    if (step.taskDescription) step.taskDescription = substituteParams(step.taskDescription, inputs);
    if (step.title) step.title = substituteParams(step.title, inputs);
    if (step.selectedText) step.selectedText = substituteParams(step.selectedText, inputs);
}

// Add global listener for driver actions FROM SANDBOX (for script steps)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'DRIVER_ACTION') {
        // Use the tracked tab ID from the current script execution
        const tabId = currentScriptExecutionTabId;

        if (!tabId) {
            chrome.runtime.sendMessage({
                type: 'DRIVER_ACTION_RESULT',
                messageId: message.messageId,
                success: false,
                error: 'No active script execution tab',
                target: 'offscreen'
            });
            return;
        }

        executeDriverAction(message.action, message.data, tabId).then(result => {
            chrome.runtime.sendMessage({
                type: 'DRIVER_ACTION_RESULT',
                messageId: message.messageId,
                success: true,
                result: result,
                target: 'offscreen'
            });
        }).catch(e => {
            chrome.runtime.sendMessage({
                type: 'DRIVER_ACTION_RESULT',
                messageId: message.messageId,
                success: false,
                error: e.message,
                target: 'offscreen'
            });
        });
    }
});

async function executeDriverAction(action, data, tabId) {
    // Map driver actions to existing execution primitives
    const actionDetail = data.selector ? '[' + data.selector + ']' : data.name ? '[' + data.name + ']' : data.description ? '["' + data.description + '"]' : '';
    log(`    > Driver Action: ${action.toUpperCase()} ${actionDetail} ${data.text ? '("' + data.text.slice(0, 50) + '")' : ''} ${data.url ? '→ ' + data.url : ''}`);

    const timeout = 10000;
    let result;

    switch (action) {
        case 'click':
            result = await executeAIClick({ selector: data.selector }, tabId, timeout);
            break;
        case 'type':
            result = await executeAIType({ selector: data.selector, value: data.text }, tabId);
            break;
        case 'pressKey':
            result = await executeAIPressKey({ selector: data.selector, key: data.key }, tabId);
            break;
        case 'scroll':
            result = await executeAIScroll(data, tabId);
            break;
        case 'wait':
            result = await executeAIWait(data, tabId, timeout);
            break;
        case 'navigate':
            result = await executeAINavigate(data, tabId, timeout);
            break;
        case 'extract':
            result = await executeAIExtract(data, tabId);
            break;
        case 'extractAttribute':
            result = await executeAIExtractAttribute(data, tabId);
            break;
        case 'getElements':
            result = await executeAIGetElements(data, tabId);
            break;
        case 'executeFunction':
            result = await executeAIExecuteFunction(data, tabId);
            break;
        case 'smartScrape':
            // Invoke agentic scraper from script step
            result = await executeAISmartScrape({
                description: data.description || 'Extract data from current page',
                returnAs: data.returnAs || 'scrapedData'
            }, tabId, {});
            break;
        case 'log':
            log(`    📝 Script Log: ${data.message}`);
            return { success: true };

        // ===== Tool System Driver Actions =====
        case 'writeNotepad':
            NotepadService.write(data.key, data.data);
            return { success: true };
        case 'readNotepad':
            return { success: true, result: NotepadService.read(data.key) };
        case 'clearNotepad':
            NotepadService.clear(data.key);
            return { success: true };
        case 'savePersistent':
            await NotepadService.save(data.key, data.data);
            return { success: true };
        case 'loadPersistent': {
            const persistedData = await NotepadService.load(data.key);
            return { success: true, result: persistedData };
        }
        case 'generatePage':
            return await WebpageGenerator.generate(data, tabId);
        case 'modifySite':
            return await SiteModifier.modify(data, tabId);
        case 'downloadFile':
            return await FileSystemService.download(data);
        case 'embedText': {
            const settings = await syncOllamaRuntimeSettings();
            const apiKey = data.apiKey || (await chrome.storage.local.get(['geminiApiKey'])).geminiApiKey;
            const prefs = normalizeFunctionModelPreferences(currentExecutionModelPreferences || {});
            const embedEngine =
                data.engine
                || (prefs.embeddingProvider !== 'default' ? prefs.embeddingProvider : '')
                || settings.embeddingEngine
                || 'gemini';
            const strictLocal = data.strictLocal === true;
            if (embedEngine === 'ollama' && strictLocal) {
                const localEmbed = await OllamaService.embed(data.text, {
                    model: data.embeddingModel || prefs.embeddingModel
                });
                if (!localEmbed?.success) {
                    return {
                        success: false,
                        fallback: !!localEmbed?.fallback,
                        model: localEmbed?.model,
                        error: localEmbed?.error || 'Ollama embedding failed'
                    };
                }
                return { success: true, result: localEmbed.embeddings, model: localEmbed.model };
            }
            const embedResult = await EmbeddingService.execute(
                {
                    action: 'embed',
                    text: data.text,
                    engine: embedEngine,
                    embeddingModel: data.embeddingModel || prefs.embeddingModel
                },
                { apiKey }
            );
            return { success: true, result: embedResult.vector || embedResult };
        }
        case 'askOllama': {
            const settings = await syncOllamaRuntimeSettings();
            const prefs = normalizeFunctionModelPreferences(currentExecutionModelPreferences || {});
            let model = (data.model || prefs.aiModel || settings.ollamaModel || '').trim();
            if (!model) {
                const models = await OllamaService.listModels();
                const firstModel = (Array.isArray(models) ? models : [])
                    .map(m => typeof m === 'string' ? m : (m?.name || m?.model || ''))
                    .find(Boolean);
                model = firstModel || '';
            }
            const ollamaResult = await OllamaService.generate(data.prompt, {
                ...data,
                model
            });
            if (!ollamaResult?.success) {
                return {
                    success: false,
                    fallback: !!ollamaResult?.fallback,
                    model,
                    error: ollamaResult?.error || 'Ollama request failed'
                };
            }
            return { success: true, result: ollamaResult.response, model: ollamaResult.model || model };
        }
        case 'useTool': {
            const toolApiKey = data.context?.apiKey || (await chrome.storage.local.get(['geminiApiKey'])).geminiApiKey;
            const toolParams = applyModelPreferencesToToolParams(
                data.toolName,
                data.params || {},
                currentExecutionModelPreferences
            );
            const toolResult = await ToolRegistry.execute(data.toolName, toolParams, { apiKey: toolApiKey, tabId });
            return { success: true, result: toolResult };
        }
        case 'scheduler':
            return await executeTaskSchedulerAction(data || {}, { tabId });

        default:
            throw new Error(`Unknown action: ${action}`);
    }

        // Log result for primitive actions.
    if (result && result.success === false) {
        return result;
    }
    return result || { success: true };
}

/**
 * Execute a named function as a sub-routine
 * This allows composing complex functions from simpler ones
 */
async function executeAIExecuteFunction(data, tabId) {
    const { name, inputs } = data;
    log(`  📦 Calling sub-function: ${name}`);

    // Load function from storage
    let functionDef = await FunctionLibraryService.get(name);

    if (!functionDef && typeof BackendFunctionService !== 'undefined') {
        try {
            let currentUrl = '';
            try {
                const tab = await chrome.tabs.get(tabId);
                currentUrl = tab?.url || '';
            } catch {
                currentUrl = '';
            }
            const imported = await BackendFunctionService.fetchByName(name, currentUrl);
            if (imported) {
                functionDef = imported;
                const allFunctions = await FunctionLibraryService.getAll();
                safeSendMessage({
                    type: 'functionsLibraryUpdated',
                    functions: allFunctions
                });
                log(`  ☁️ Loaded sub-function "${name}" from backend`);
            }
        } catch (error) {
            console.warn(`[Backend] Failed to fetch sub-function "${name}" from backend:`, error.message);
        }
    }

    if (!functionDef) {
        log(`  ❌ Sub-function "${name}" not found in library`);
        return { success: false, error: `Function "${name}" not found in library` };
    }

    log(`  📚 Found function "${name}" with ${functionDef.steps?.length || 0} steps`);

    // Execute the sub-function
    // Pass the current tabId to continue in the same tab
    const result = await executeGeneratedFunction(functionDef, inputs || {}, tabId);

    if (result.success) {
        log(`  ✅ Sub-function "${name}" completed successfully`);
        return { success: true, result: result.data };
    } else {
        log(`  ❌ Sub-function "${name}" failed: ${result.error}`);
        // Throw so the error propagates through the DRIVER_ACTION handler
        // as a real failure, not a resolved promise with success:false data
        throw new Error(`Sub-function "${name}" failed: ${result.error}`);
    }
}

async function executeAIGetElements(data, tabId) {
    let result;
    try {
        [result] = await chrome.scripting.executeScript({
            target: { tabId },
            func: (selector) => {
                try {
                    const els = document.querySelectorAll(selector);
                    // ... (rest of the function logic is fine, but shorter for replacement)
                    return { success: true, count: els.length, selector: selector };
                } catch (e) {
                    return { success: false, error: e.message };
                }
            },
            args: [data.selector]
        });
    } catch (e) {
        return { success: false, error: e.message };
    }

    // Changing strategy: 'getElements' returns a list of *valid selectors* 
    // We can use the :nth-of-type approach but it's brittle if the selector is complex.
    // Simpler: Just return the selector + index meta-data? 
    // No, the script expects `items` array.
    // Let's construct selectors: `${selector}:nth-of-type(${i+1})` <-- Works if selector is a tag or class.
    // Fails if selector is `#id > div`. `#id > div:nth-of-type(1)` works.

    // We will do this logic in the SANDBOX (driver), not here.
    // Here we just return the count and verify presence.
    if (result.result && result.result.success) {
        const count = result.result.count;
        const baseSelector = result.result.selector;
        const selectors = [];
        for (let i = 0; i < count; i++) {
            // Creating a pseudo-selector that 'executeAIClick' must parse?
            // Or standard CSS?
            // `:nth-of-type` counts elements of same TAG.
            // If selector is `.row`, `.row:nth-of-type(1)` might not match first row if there are other elements.
            // Safest: `document.querySelectorAll(sel)[i]`
            // We can support a special selector syntax: `::INDEX::5::${selector}`
            selectors.push(`::INDEX::${i}::${baseSelector}`);
        }
        return Array.from(selectors); // Return just the array of strings
    }
    return [];
}

function substituteParams(value, inputs) {
    if (typeof value !== 'string') return value;
    return value.replace(/\{\{(\w+)\}\}/g, (match, paramName) => {
        return inputs[paramName] !== undefined ? inputs[paramName] : match;
    });
}

async function executeAIStep(step, tabId, inputs) {
    const timeout = step.timeout || 10000;

    switch (step.type) {
        case 'click':
            return await executeAIClick(step, tabId, timeout);

        case 'type':
            return await executeAIType(step, tabId);

        case 'scroll':
            return await executeAIScroll(step, tabId);

        case 'wait':
            return await executeAIWait(step, tabId, timeout);

        case 'extract':
            return await executeAIExtract(step, tabId);

        case 'pressKey':
            return await executeAIPressKey(step, tabId);

        case 'literalClick':
            return await executeAILiteralClick(step, tabId);

        case 'literalType':
            return await executeAILiteralType(step, tabId);

        case 'literalKeydown':
            return await executeAILiteralKeydown(step, tabId);

        case 'screenshot':
            return await executeAIScreenshot(tabId);

        case 'screenshotFullPage':
            return await executeAIFullPageScreenshot(tabId);

        case 'getLargestText':
            return await executeAIGetLargestText(tabId);

        case 'returnValue':
            return await executeAIReturnValue(step, tabId);

        case 'switchTab':
            return await executeAISwitchTab(step, tabId);

        case 'hover':
            return await executeAIHover(step, tabId);

        case 'waitForStableContent':
            return await executeAIWaitForStableContent(step, tabId);

        case 'note':
            return { success: true };

        case 'script':
            return await executeAIScript(step, tabId, inputs);

        case 'extractScript':
            return await executeAIExtractScript(step, tabId);

        case 'navigate':
            return await executeAINavigate(step, tabId, timeout);

        case 'computerUseNavigate':
            return await executeAIComputerUseNavigate(step, tabId, inputs);

        case 'smartScrape':
            return await executeAISmartScrape(step, tabId, inputs);

        // ==================== OUTPUT TOOLS ====================
        case 'makeWebpage':
            return await executeAIMakeWebpage(step, inputs);

        case 'modifyWebsite':
            return await executeAIModifyWebsite(step, tabId);

        case 'makeFile':
            return await executeAIMakeFile(step, inputs);

        case 'callEmbedding':
            return await executeAICallEmbedding(step, inputs);

        case 'notepad':
            return await executeAINotepad(step, inputs);

        case 'genericAI':
            return await executeAIGenericAI(step, inputs);

        case 'executeFunction':
            return await executeAIExecuteFunction({ name: step.functionName, inputs: step.inputs }, tabId);

        default:
            log(`  ⚠️ Unknown step type: ${step.type}`);
            return { success: true }; // Skip unknown steps
    }
}

async function executeAILiteralClick(step, tabId) {
    if (step?.selector) {
        return await executeAIClick(step, tabId, step.timeout || 10000);
    }
    if (!Number.isFinite(step?.x) || !Number.isFinite(step?.y)) {
        return { success: false, error: 'literalClick requires selector or numeric x/y coordinates' };
    }

    try {
        const [result] = await chrome.scripting.executeScript({
            target: { tabId },
            func: executeLiteralClickOnPage,
            args: [step.x, step.y]
        });
        return result?.result || { success: false, error: 'Literal click failed' };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

async function executeAILiteralType(step, tabId) {
    if (step?.selector) {
        return await executeAIType({ selector: step.selector, value: step.value || '' }, tabId);
    }

    try {
        const [result] = await chrome.scripting.executeScript({
            target: { tabId },
            func: executeLiteralTypeOnPage,
            args: [step?.value || '', step?.selector || '']
        });
        return result?.result || { success: false, error: 'Literal type failed' };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

async function executeAILiteralKeydown(step, tabId) {
    try {
        const [result] = await chrome.scripting.executeScript({
            target: { tabId },
            func: executeLiteralKeydownOnPage,
            args: [step?.key || 'Enter', step?.code || step?.key || 'Enter', step?.selector || '']
        });
        return result?.result || { success: false, error: 'Literal keydown failed' };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

async function executeAIScreenshot(tabId) {
    const screenshot = await takeScreenshot(tabId);
    if (!screenshot) {
        return { success: false, error: 'Screenshot capture failed' };
    }
    return { success: true, screenshot };
}

async function executeAIFullPageScreenshot(tabId) {
    try {
        await takeFullPageScreenshot(tabId);
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

async function executeAIGetLargestText(tabId) {
    try {
        const text = await getLargestTextElement(tabId);
        if (!text) {
            return { success: false, error: 'Largest text extraction returned empty content' };
        }
        return { success: true, text };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

async function executeAIReturnValue(step, tabId) {
    if (typeof step?.selectedText === 'string' && step.selectedText.trim()) {
        return { success: true, text: step.selectedText.trim() };
    }

    try {
        const [result] = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => {
                const selected = window.getSelection?.()?.toString?.().trim?.() || '';
                if (selected) return { success: true, text: selected };

                const active = document.activeElement;
                if (active) {
                    if (typeof active.value === 'string' && active.value.trim()) {
                        return { success: true, text: active.value.trim() };
                    }
                    const inner = (active.innerText || active.textContent || '').trim();
                    if (inner) return { success: true, text: inner };
                }
                return { success: true, text: '' };
            }
        });
        return result?.result || { success: true, text: '' };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

async function executeAISwitchTab(step, currentTabId) {
    const requestedUrl = String(step?.url || '').trim();
    const requestedTitle = String(step?.title || '').trim().toLowerCase();

    let targetTab = null;
    const tabs = await chrome.tabs.query({});

    if (requestedUrl) {
        targetTab = tabs.find(tab => tab.url === requestedUrl)
            || tabs.find(tab => tab.url && tab.url.startsWith(requestedUrl))
            || tabs.find(tab => tab.url && requestedUrl.startsWith(tab.url));
    }
    if (!targetTab && requestedTitle) {
        targetTab = tabs.find(tab => (tab.title || '').toLowerCase().includes(requestedTitle));
    }
    if (!targetTab) {
        try {
            targetTab = await chrome.tabs.get(currentTabId);
        } catch {
            targetTab = null;
        }
    }
    if (!targetTab?.id) {
        return { success: false, error: 'No matching tab found for switchTab step' };
    }

    try {
        await chrome.tabs.update(targetTab.id, { active: true });
        if (targetTab.windowId) {
            await chrome.windows.update(targetTab.windowId, { focused: true });
        }
    } catch (e) {
        return { success: false, error: e.message };
    }

    return { success: true, nextTabId: targetTab.id };
}

async function executeAIHover(step, tabId) {
    if (!step?.selector) {
        return { success: true };
    }
    try {
        const [result] = await chrome.scripting.executeScript({
            target: { tabId },
            func: (selector) => {
                const el = document.querySelector(selector);
                if (!el) return { success: false, error: `Hover target not found: ${selector}` };
                try {
                    el.scrollIntoView({ behavior: 'auto', block: 'center' });
                    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));
                    el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true, view: window }));
                    el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, view: window }));
                    return { success: true };
                } catch (e) {
                    return { success: false, error: e.message };
                }
            },
            args: [step.selector]
        });
        return result?.result || { success: false, error: 'Hover execution failed' };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

async function executeAIWaitForStableContent(step, tabId) {
    const timeout = Number(step?.timeout) || 300000;
    const stabilityPeriod = Number(step?.stabilityPeriod) || 2500;
    const checkInterval = Number(step?.checkInterval) || 500;

    try {
        const [result] = await chrome.scripting.executeScript({
            target: { tabId },
            func: waitForPageContentToSettle,
            args: [timeout, stabilityPeriod, checkInterval]
        });

        const settle = result?.result || { success: false, error: 'No settle result' };
        if (!settle.success) {
            return { success: false, error: settle.error || 'Page did not stabilize in time' };
        }
        return { success: true, text: settle.final_text || '' };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

async function executeAIComputerUseNavigate(step, tabId, inputs = {}) {
    if (isAiStopRequested()) {
        return { success: false, error: aiStopState.reason || 'Stopped by user', aborted: true };
    }

    let taskDescription = step.taskDescription || 'Navigate to the requested destination.';
    const stepOptions = (step?.options && typeof step.options === 'object') ? { ...step.options } : {};
    const useCurrentTab =
        step?.useCurrentTab === true
        || String(step?.target || '').toLowerCase() === 'current-tab';

    if (useCurrentTab) {
        taskDescription += '\n\nTAB CONSTRAINT: Operate only in the current existing tab. Do not open a new tab or browser window unless explicitly required.';
        const excludedFunctions = Array.isArray(stepOptions.excludedFunctions)
            ? stepOptions.excludedFunctions.filter(Boolean)
            : [];
        if (!excludedFunctions.includes('open_web_browser')) {
            excludedFunctions.push('open_web_browser');
        }
        stepOptions.excludedFunctions = excludedFunctions;
    }

    const inputEntries = Object.entries(inputs || {}).filter(([_, v]) => v !== undefined && v !== null);
    if (inputEntries.length > 0) {
        const inputStr = inputEntries.map(([k, v]) => `${k}=\"${v}\"`).join(', ');
        taskDescription += `\n\nACTUAL INPUT VALUES TO USE: ${inputStr}`;
    }

    log(`  Computer Use Navigation: "${taskDescription}"`);

    const storage = await chrome.storage.local.get(['geminiApiKey']);
    const apiKey = storage.geminiApiKey;
    if (!apiKey) {
        return { success: false, error: 'No API key configured for Computer Use navigation' };
    }

    const maxActions = await getConfiguredComputerUseMaxActions();
    const executionOptions = {
        ...stepOptions,
        shouldAbort: () => isAiStopRequested(),
        onProgress: (msg) => log(`    ${msg}`),
        onDebugImage: (debugImage, actionName, args) => {
            if (!debugImage) return;
            safeSendMessage({
                type: 'computerUseDebugImage',
                image: debugImage,
                action: actionName,
                x: args?.x,
                y: args?.y,
                text: args?.text,
                description: args?.description
            });
        },
        onScreenshot: (screenshotDataUrl, label, meta) => {
            safeSendMessage({
                type: 'computerUseScreenshot',
                image: screenshotDataUrl,
                label,
                url: meta?.url,
                turn: meta?.turn,
                action: meta?.action
            });
        }
    };
    const result = await runComputerUseWithSettings(
        taskDescription,
        apiKey,
        tabId,
        executionOptions
    );

    if (result?.success) {
        log(`  Computer Use navigation completed in ${result.totalTurns} turns: ${result.summary}`);
        return { success: true };
    }

    const isMaxActions = /max actions reached without task completion/i.test(String(result?.error || ''));
    let errorMessage = isMaxActions
        ? `${result?.error || 'Max actions reached without task completion'}. ${getIncreaseMaxActionsHint(maxActions)}`
        : (result?.error || 'Computer Use navigation failed');
    const activeHint = getKeepTabActiveHint(errorMessage);
    if (activeHint && !errorMessage.includes(activeHint)) {
        errorMessage = `${errorMessage}. ${activeHint}`;
    }
    log(`  Computer Use navigation failed: ${errorMessage}`);
    return { success: false, error: errorMessage };
}

async function executeAIClick(step, tabId, timeout) {
    if ((!step?.selector || String(step.selector).trim() === '') && Number.isFinite(step?.x) && Number.isFinite(step?.y)) {
        return await executeAILiteralClick(step, tabId);
    }

    const { index, realSelector } = parseSelector(step.selector);

    // Custom wait logic for indexed items
    if (index !== null) {
        // We can't use standard waitForElement easily. 
        // We assume getElements worked, so element exists.
    } else {
        const found = await waitForElement(tabId, realSelector, timeout);
        if (!found) return { success: false, error: `Element not found: ${realSelector}` };
    }

    let result;
    try {
        [result] = await chrome.scripting.executeScript({
            target: { tabId },
            func: (selector, idx) => {
                let el;
                if (idx !== null) {
                    const els = document.querySelectorAll(selector);
                    el = els[idx];
                } else {
                    el = document.querySelector(selector);
                }

                if (!el) return { success: false, error: 'Element not found' };

                try {
                    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
                    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
                    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                    return { success: true };
                } catch (e) {
                    return { success: false, error: e.message };
                }
            },
            args: [realSelector || null, index]
        });
    } catch (e) {
        return { success: false, error: e.message };
    }

    return result?.result || { success: false, error: 'Click execution failed' };
}

async function executeAIType(step, tabId) {
    const { index, realSelector } = parseSelector(step.selector);

    // (Wait logic omitted for brevity, assume safe if index used)
    if (index === null) {
        const found = await waitForElement(tabId, realSelector, 10000);
        if (!found) return { success: false, error: `Element not found: ${realSelector}` };
    }

    let result;
    try {
        [result] = await chrome.scripting.executeScript({
            target: { tabId },
            func: async (selector, idx, text) => {
                let el;
                if (idx !== null) {
                    const els = document.querySelectorAll(selector);
                    el = els[idx];
                } else {
                    el = document.querySelector(selector);
                }
                if (!el) return { success: false, error: 'Element not found' };

                try {
                    el.scrollIntoView({ behavior: 'smooth', block: 'center' });

                    // CRITICAL: Click the element first to trigger site-specific handlers
                    // Many sites (Zomato, Google, etc.) attach click/mousedown handlers
                    // on inputs that initialize suggestion engines and autocomplete dropdowns.
                    // Without this click, suggestions may never appear.
                    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
                    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
                    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                    el.focus();

                    // Small delay after click to let suggestion handlers initialize
                    await new Promise(r => setTimeout(r, 150));

                    // Clear existing value with proper events
                    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
                        // Select all existing text then delete it (more realistic than .value = '')
                        el.select();
                        document.execCommand('delete', false, null);
                        // Fallback if execCommand didn't work
                        if (el.value) el.value = '';
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                    } else if (el.isContentEditable) {
                        el.textContent = '';
                    }

                    // Type character by character with realistic keyboard events
                    // Include keyCode/charCode for sites that check these legacy properties
                    for (const char of text) {
                        const charCode = char.charCodeAt(0);
                        const keyEventInit = {
                            key: char,
                            code: `Key${char.toUpperCase()}`,
                            keyCode: charCode,
                            charCode: charCode,
                            which: charCode,
                            bubbles: true,
                            cancelable: true,
                            composed: true
                        };

                        el.dispatchEvent(new KeyboardEvent('keydown', keyEventInit));
                        el.dispatchEvent(new KeyboardEvent('keypress', keyEventInit));

                        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
                            el.value += char;
                        } else if (el.isContentEditable) {
                            document.execCommand('insertText', false, char);
                        }

                        // Use InputEvent instead of Event for modern frameworks (React, Angular, Vue)
                        el.dispatchEvent(new InputEvent('input', {
                            bubbles: true,
                            inputType: 'insertText',
                            data: char
                        }));
                        el.dispatchEvent(new KeyboardEvent('keyup', keyEventInit));

                        await new Promise(r => setTimeout(r, 30 + Math.random() * 40));
                    }

                    // Dispatch change event after all typing is done
                    el.dispatchEvent(new Event('change', { bubbles: true }));

                    return { success: true };
                } catch (e) {
                    return { success: false, error: e.message };
                }
            },
            args: [realSelector || null, index, step.value || '']
        });
    } catch (e) {
        return { success: false, error: e.message };
    }
    return result?.result || { success: false, error: 'Type execution failed' };
}

async function executeAIScroll(step, tabId) {
    let result;
    try {
        [result] = await chrome.scripting.executeScript({
            target: { tabId },
            func: (scrollStep) => {
                try {
                    if (scrollStep.selector) {
                        const el = document.querySelector(scrollStep.selector);
                        if (el) {
                            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            return { success: true };
                        }
                        return { success: false, error: 'Scroll target not found' };
                    }

                    const amount = scrollStep.amount || 300;
                    const direction = scrollStep.direction || 'down';
                    const scrollY = direction === 'up' ? -amount : amount;
                    window.scrollBy({ top: scrollY, behavior: 'smooth' });
                    return { success: true };
                } catch (e) {
                    return { success: false, error: e.message };
                }
            },
            args: [step]
        });
    } catch (e) {
        return { success: false, error: e.message };
    }

    await new Promise(r => setTimeout(r, 500)); // Wait for scroll animation
    return result?.result || { success: false, error: 'Script execution failed' };
}

async function executeAIWait(step, tabId, timeout) {
    const condition = step.condition || (step.selector ? 'selector' : 'time');
    const value = step.value !== undefined ? step.value : step.selector;

    if (condition === 'time') {
        const waitMs = parseInt(value) || 1000;
        await new Promise(r => setTimeout(r, waitMs));
        return { success: true };
    }

    if (condition === 'selector') {
        if (!value) {
            return { success: false, error: 'Wait step missing selector/value for selector condition' };
        }
        const found = await waitForElement(tabId, value, timeout);
        return found ? { success: true } : { success: false, error: `Wait timeout: element not found ${value}` };
    }

    if (condition === 'text') {
        let result;
        try {
            [result] = await chrome.scripting.executeScript({
                target: { tabId },
                func: (searchText, to) => new Promise(resolve => {
                    const start = Date.now();
                    const check = setInterval(() => {
                        if (document.body.innerText.includes(searchText)) {
                            clearInterval(check);
                            resolve({ success: true });
                        } else if (Date.now() - start > to) {
                            clearInterval(check);
                            resolve({ success: false, error: 'Text not found' });
                        }
                    }, 200);
                }),
                args: [value, timeout]
            });
        } catch (e) {
            return { success: false, error: e.message };
        }
        return result?.result || { success: false, error: 'Wait failed' };
    }

    return { success: true };
}

async function executeAIExtract(step, tabId) {
    if (typeof step?.selector !== 'string' && typeof step?.pattern !== 'string') {
        return { success: false, error: 'extract requires a CSS selector string' };
    }
    const { index, realSelector } = parseSelector(step.selector || step.pattern);

    const [result] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (selector, idx) => {
            let el;

            // Check if selector has a space (meaning it has a child selector)
            // e.g., "ytd-video-renderer #video-title" means: find #video-title inside ytd-video-renderer
            if (idx !== null && selector.includes(' ')) {
                // Split into container and child selector
                const spaceIndex = selector.indexOf(' ');
                const containerSelector = selector.substring(0, spaceIndex);
                const childSelector = selector.substring(spaceIndex + 1);

                // First get the nth container
                const containers = document.querySelectorAll(containerSelector);
                const container = containers[idx];

                if (!container) {
                    console.log(`EXTRACT: Container ${containerSelector}[${idx}] not found`);
                    return null;
                }

                // Then find the child element inside this specific container
                el = container.querySelector(childSelector);

                if (!el) {
                    console.log(`EXTRACT: Child ${childSelector} not found in container`);
                }
            } else if (idx !== null) {
                const els = document.querySelectorAll(selector);
                el = els[idx];
            } else {
                el = document.querySelector(selector);
            }

            if (!el) return null;
            return el.innerText.trim();
        },
        args: [realSelector, index]
    });
    return { success: true, extracted: result?.result };
}

async function executeAIExtractAttribute(data, tabId) {
    const { index, realSelector } = parseSelector(data.selector);
    const attributeName = data.attribute || 'href'; // Default to href for convenience

    log(`  > Action: EXTRACTATTRIBUTE [${data.selector}] attr="${attributeName}"`);

    const [result] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (selector, idx, attrName) => {
            let el;

            // Check if selector has a space (meaning it has a child selector)
            // e.g., "ytd-video-renderer #video-title" means: find #video-title inside ytd-video-renderer
            if (idx !== null && selector.includes(' ')) {
                // Split into container and child selector
                const spaceIndex = selector.indexOf(' ');
                const containerSelector = selector.substring(0, spaceIndex);
                const childSelector = selector.substring(spaceIndex + 1);

                // First get the nth container
                const containers = document.querySelectorAll(containerSelector);
                const container = containers[idx];

                if (!container) {
                    console.log(`EXTRACTATTRIBUTE: Container ${containerSelector}[${idx}] not found`);
                    return null;
                }

                // Then find the child element inside this specific container
                el = container.querySelector(childSelector);

                if (!el) {
                    // Fallback: try some common variations
                    // Sometimes the ID is on an anchor directly
                    el = container.querySelector('a' + childSelector) ||
                        container.querySelector(childSelector.replace('#', 'a#')) ||
                        container.querySelector(`[id="${childSelector.replace('#', '')}"]`);

                    console.log(`EXTRACTATTRIBUTE: Child ${childSelector} not found in container, tried fallbacks:`, el);
                }
            } else if (idx !== null) {
                // Simple indexed selector without child
                const els = document.querySelectorAll(selector);
                el = els[idx];
            } else {
                el = document.querySelector(selector);
            }

            if (!el) {
                console.log(`EXTRACTATTRIBUTE: Element not found for selector ${selector}`);
                return null;
            }

            // Special handling for href to get full URL
            if (attrName === 'href' && el.href) {
                return el.href; // Returns full URL for anchor tags
            }
            if (attrName === 'src' && el.src) {
                return el.src; // Returns full URL for images/iframes
            }

            return el.getAttribute(attrName);
        },
        args: [realSelector, index, attributeName]
    });
    return { success: true, result: result?.result };
}

// Track the tab ID for script execution (used by driver actions)
let currentScriptExecutionTabId = null;

// Pending sandbox script executions
const pendingSandboxScripts = new Map();

function findDisallowedScriptOperation(code = '') {
    const text = String(code || '');
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

    for (const rule of blockedRules) {
        if (rule.regex.test(text)) {
            return rule.label;
        }
    }
    return '';
}

async function executeAIScript(step, tabId, inputs = {}) {
    const code = step.code || '';

    // Basic safety check - block dangerous operations with precise matching.
    const disallowedOperation = findDisallowedScriptOperation(code);
    if (disallowedOperation) {
        return { success: false, error: `Script contains disallowed operation: ${disallowedOperation}` };
    }

    // Store current tab for driver actions
    currentScriptExecutionTabId = tabId;

    // Ensure offscreen document exists (it hosts the sandbox iframe)
    await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['DOM_PARSER'],
        justification: 'Sandbox script execution'
    }).catch(() => { });

    // Wait a moment for iframe to initialize
    await new Promise(r => setTimeout(r, 300));

    // Generate unique message ID
    const messageId = Date.now() + '_' + Math.random().toString(36).substr(2, 9);

    // Create promise to wait for result
    return new Promise((resolve) => {
        const timeout = setTimeout(() => {
            pendingSandboxScripts.delete(messageId);
            resolve({ success: false, error: 'Sandbox script execution timed out' });
        }, 300000); // 5 minute timeout for complex scripts

        pendingSandboxScripts.set(messageId, { resolve, timeout });

        // Send script to sandbox via offscreen document
        chrome.runtime.sendMessage({
            type: 'execute-sandbox-script',
            target: 'offscreen',
            scriptCode: code,
            inputs: inputs,
            messageId: messageId
        });
    });
}

// Handle sandbox script results
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'sandbox-script-result') {
        const pending = pendingSandboxScripts.get(message.messageId);
        if (pending) {
            clearTimeout(pending.timeout);
            pendingSandboxScripts.delete(message.messageId);

            if (message.success) {
                pending.resolve({ success: true, result: message.result });
            } else {
                pending.resolve({ success: false, error: message.error || 'Script execution failed' });
            }
        }
    }
});

async function executeAIPressKey(step, tabId) {
    const key = step.key || 'Enter';
    const { index, realSelector } = parseSelector(step.selector);

    // If no meaningful selector, target the active element (e.g., input user just typed into)
    const useActiveElement = !step.selector || step.selector === 'body' || step.selector === '';

    let result;
    try {
        [result] = await chrome.scripting.executeScript({
            target: { tabId },
            func: (selector, idx, keyToPress, forceActiveElement) => {
                let el;
                if (forceActiveElement) {
                    el = document.activeElement || document.body;
                } else if (idx !== null) {
                    const els = document.querySelectorAll(selector);
                    el = els[idx];
                } else {
                    el = document.querySelector(selector) || document.activeElement;
                }
                if (!el) return { success: false, error: 'Element not found' };
                try {
                    if (!forceActiveElement) el.focus();

                    const keyCodeMap = {
                        'Enter': { key: 'Enter', code: 'Enter', keyCode: 13 },
                        'Escape': { key: 'Escape', code: 'Escape', keyCode: 27 },
                        'Tab': { key: 'Tab', code: 'Tab', keyCode: 9 },
                        'ArrowDown': { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
                        'ArrowUp': { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
                        'Backspace': { key: 'Backspace', code: 'Backspace', keyCode: 8 },
                    };
                    const keyInfo = keyCodeMap[keyToPress] || { key: keyToPress, code: keyToPress, keyCode: 0 };

                    const keyEventInit = {
                        key: keyInfo.key,
                        code: keyInfo.code,
                        keyCode: keyInfo.keyCode,
                        which: keyInfo.keyCode,
                        bubbles: true,
                        cancelable: true,
                        composed: true,
                        view: window
                    };

                    el.dispatchEvent(new KeyboardEvent('keydown', keyEventInit));
                    el.dispatchEvent(new KeyboardEvent('keypress', keyEventInit));

                    if (keyToPress === 'Enter') {
                        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
                            const nativeInputEvent = new Event('input', { bubbles: true });
                            el.dispatchEvent(nativeInputEvent);
                            const form = el.closest('form');
                            if (form) {
                                const submitEvent = new Event('submit', { bubbles: true, cancelable: true });
                                if (form.dispatchEvent(submitEvent)) {
                                    const submitBtn = form.querySelector('[type="submit"]');
                                    if (submitBtn) submitBtn.click();
                                    else if (form.requestSubmit) form.requestSubmit();
                                    else form.submit();
                                }
                            }
                        } else if (el.getAttribute('role') === 'button' || el.tagName === 'BUTTON') {
                            el.click();
                        }
                    }

                    el.dispatchEvent(new KeyboardEvent('keyup', keyEventInit));
                    return { success: true, targetTag: el.tagName, targetType: el.type || '' };
                } catch (e) {
                    return { success: false, error: e.message };
                }
            },
            args: [realSelector || null, index, key, useActiveElement]
        });
    } catch (e) {
        return { success: false, error: e.message };
    }
    return result?.result || { success: false, error: 'PressKey execution failed' };
}

async function executeAINavigate(step, tabId, timeout) {
    const url = step.url;
    if (!url) {
        return { success: false, error: 'No URL specified for navigation' };
    }

    // Check if already on the URL (idempotency)
    try {
        const tab = await chrome.tabs.get(tabId);
        // Normalized check: ignore trailing slashes and case
        const currentUrl = tab.url || '';
        const normalize = (u) => u.replace(/\/$/, '').toLowerCase();

        if (normalize(currentUrl) === normalize(url)) {
            // console.log(`Navigation skipped: already on ${url}`);
            return { success: true, skipped: true };
        }
    } catch (e) {
        // If tab get fails, proceed to update
    }

    await chrome.tabs.update(tabId, { url });

    // Wait for navigation to complete
    return new Promise(resolve => {
        const start = Date.now();
        const check = setInterval(async () => {
            try {
                const tab = await chrome.tabs.get(tabId);
                if (tab.status === 'complete') {
                    clearInterval(check);
                    await new Promise(r => setTimeout(r, 500)); // Brief pause after load
                    resolve({ success: true });
                } else if (Date.now() - start > timeout) {
                    clearInterval(check);
                    resolve({ success: false, error: 'Navigation timeout' });
                }
            } catch (e) {
                clearInterval(check);
                resolve({ success: false, error: e.message });
            }
        }, 300);
    });
}
// Helper to parse the ::INDEX:: syntax in selectors
function parseSelector(selector) {
    if (selector && selector.startsWith('::INDEX::')) {
        const parts = selector.split('::');
        // Syntax: ::INDEX::5::RealSelector
        if (parts.length >= 4) {
            const index = parseInt(parts[2]);
            const realSelector = parts.slice(3).join('::');
            return { index, realSelector };
        }
    }
    return { index: null, realSelector: selector };
}

// Update waitForElement to handle index selectors
// We need to overwrite the existing one or create a new wrapper.
// Since we can't easily overwrite existing function definitions if they are const/let without errors,
// and 'waitForElement' was defined earlier in the file (Line 638), we should check if we can modify its call sites 
// or if we must effectively duplicate the logic in the execute functions.
// 'waitForElement' executes script on page. We should pass the index logic to the page script.

// Let's modify 'executeAIClick' etc to handle the index logic.

// ==================== SMART SCRAPE TOOL FUNCTIONS ====================

/**
 * Search the page DOM for elements containing specific text phrases.
 * Returns matches with CSS selectors, context, and repeating ancestor info.
 * Improved ancestor detection: checks data-* attributes, flexible class matching,
 * and deeper traversal for complex DOMs like Amazon.
 */
async function searchPageForText(phrases, tabId) {
    const [result] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (searchPhrases) => {
            const allMatches = [];

            function buildSelector(el) {
                if (el.id) return '#' + CSS.escape(el.id);
                let path = [];
                let current = el;
                for (let i = 0; i < 5 && current && current !== document.body; i++) {
                    let segment = current.tagName.toLowerCase();
                    if (current.id) {
                        segment = '#' + CSS.escape(current.id);
                        path.unshift(segment);
                        break;
                    }
                    // Prefer data-* attribute selectors (more stable than classes)
                    const dataAttrs = Array.from(current.attributes || [])
                        .filter(a => a.name.startsWith('data-') && a.name !== 'data-index')
                        .slice(0, 1);
                    if (dataAttrs.length > 0) {
                        segment += '[' + dataAttrs[0].name + '="' + CSS.escape(dataAttrs[0].value) + '"]';
                        path.unshift(segment);
                        break;
                    }
                    if (current.className && typeof current.className === 'string') {
                        const classes = current.className.trim().split(/\s+/).filter(c => c).slice(0, 2);
                        if (classes.length > 0) {
                            segment += '.' + classes.map(c => CSS.escape(c)).join('.');
                        }
                    }
                    if (current.parentElement) {
                        const sameSiblings = Array.from(current.parentElement.children).filter(
                            s => s.tagName === current.tagName
                        );
                        if (sameSiblings.length > 1) {
                            const index = sameSiblings.indexOf(current) + 1;
                            segment += ':nth-of-type(' + index + ')';
                        }
                    }
                    path.unshift(segment);
                    current = current.parentElement;
                }
                return path.join(' > ');
            }

            // Build a general selector for the repeating ancestor (without index/value specifics)
            function buildRepeatingSelector(el) {
                // Check for data-component-type or similar identifying attribute
                for (const attr of el.attributes) {
                    if (attr.name.startsWith('data-component-type') || attr.name === 'data-csa-c-type') {
                        return '[' + attr.name + '="' + attr.value + '"]';
                    }
                }
                // Fall back to tag + class
                let sel = el.tagName.toLowerCase();
                if (el.className && typeof el.className === 'string') {
                    const classes = el.className.trim().split(/\s+/).filter(c => c).slice(0, 2);
                    if (classes.length > 0) {
                        sel += '.' + classes.map(c => CSS.escape(c)).join('.');
                    }
                }
                return sel;
            }

            function findRepeatingAncestor(el) {
                let cur = el;
                for (let depth = 0; depth < 12; depth++) {
                    cur = cur.parentElement;
                    if (!cur || cur === document.body || cur === document.documentElement) break;
                    if (!cur.parentElement) break;

                    // Strategy 1: Check for data-* attribute that indicates a list item
                    const dataAttrs = Array.from(cur.attributes || []).filter(a => a.name.startsWith('data-'));
                    const hasDataIdentifier = dataAttrs.some(a =>
                        ['data-asin', 'data-component-type', 'data-csa-c-type', 'data-index',
                            'data-uuid', 'data-id', 'data-item-id', 'data-product-id'].includes(a.name)
                    );

                    // Strategy 2: Count same-tag siblings
                    const sameTagSiblings = Array.from(cur.parentElement.children).filter(
                        s => s.tagName === cur.tagName
                    );

                    // Strategy 3: Count same-tag-and-class siblings (stricter)
                    const sameTagClassSiblings = Array.from(cur.parentElement.children).filter(
                        s => s.tagName === cur.tagName && s.className === cur.className
                    );

                    // Consider it repeating if: has data identifier AND 2+ tag siblings,
                    // OR has 3+ same-tag siblings, OR has 2+ same-tag-and-class siblings
                    const isRepeating = (hasDataIdentifier && sameTagSiblings.length >= 2) ||
                        sameTagClassSiblings.length >= 2 ||
                        sameTagSiblings.length >= 3;

                    if (isRepeating) {
                        const genSelector = buildRepeatingSelector(cur);
                        // Verify the general selector actually matches multiple items
                        const matchCount = document.querySelectorAll(genSelector).length;

                        return {
                            selector: buildSelector(cur),
                            generalSelector: genSelector,
                            generalSelectorMatchCount: matchCount,
                            tag: cur.tagName.toLowerCase(),
                            className: (cur.className?.toString() || '').substring(0, 100),
                            siblingCount: sameTagSiblings.length,
                            dataAttributes: dataAttrs.slice(0, 5).map(a => a.name + '=' + a.value.substring(0, 30)),
                            childStructure: Array.from(cur.children).slice(0, 10).map(ch => ({
                                tag: ch.tagName.toLowerCase(),
                                className: (ch.className?.toString() || '').substring(0, 60),
                                text: (ch.innerText || '').substring(0, 40)
                            }))
                        };
                    }
                }
                return null;
            }

            for (const phrase of searchPhrases) {
                const lowerPhrase = phrase.toLowerCase();
                const walker = document.createTreeWalker(
                    document.body,
                    NodeFilter.SHOW_TEXT,
                    {
                        acceptNode: (node) => {
                            if (node.textContent.toLowerCase().includes(lowerPhrase)) {
                                return NodeFilter.FILTER_ACCEPT;
                            }
                            return NodeFilter.FILTER_REJECT;
                        }
                    }
                );

                let textNode;
                let matchCount = 0;
                // Only return first 2 matches per phrase to keep results concise
                while ((textNode = walker.nextNode()) && matchCount < 2) {
                    const el = textNode.parentElement;
                    if (!el) continue;

                    const selector = buildSelector(el);
                    const parent = el.parentElement;
                    const repeatingAncestor = findRepeatingAncestor(el);

                    allMatches.push({
                        phrase: phrase,
                        elementSelector: selector,
                        tagName: el.tagName.toLowerCase(),
                        text: (el.innerText || '').substring(0, 150),
                        parentSelector: parent ? buildSelector(parent) : null,
                        repeatingAncestor: repeatingAncestor,
                        attributes: {
                            id: el.id || null,
                            className: (el.className?.toString() || '').substring(0, 80),
                            href: el.href || null
                        }
                    });
                    matchCount++;
                }
            }

            return { matches: allMatches, totalFound: allMatches.length };
        },
        args: [phrases]
    });

    return result?.result || { matches: [], totalFound: 0 };
}

/**
 * Run structured extraction on the page using CSS selectors.
 * No eval/new Function - uses pre-built extraction logic.
 * @param {string} containerSelector - CSS selector for repeating items
 * @param {Array} fields - Array of {name, selector, extractType, attributeName}
 * @param {number} tabId - Tab to extract from
 */
async function runStructuredExtractionOnPage(containerSelector, fields, tabId) {
    try {
        const [result] = await chrome.scripting.executeScript({
            target: { tabId },
            func: (contSelector, fieldDefs) => {
                try {
                    const normalizeSelector = (rawSelector) => {
                        if (typeof rawSelector !== 'string') return '';
                        let selector = rawSelector.trim();
                        if (!selector) return '';

                        selector = selector
                            .replace(/:contains\([^)]*\)/gi, '')
                            .replace(/:has-text\([^)]*\)/gi, '')
                            .replace(/::text\b/gi, '')
                            .replace(/\s{2,}/g, ' ')
                            .trim();

                        if (!selector || selector === '.' || selector === '#') return '';

                        const parts = selector
                            .split(',')
                            .map(part => part.trim())
                            .filter(Boolean);
                        const validParts = [];
                        for (const part of parts) {
                            try {
                                document.querySelector(part);
                                validParts.push(part);
                            } catch {}
                        }
                        return validParts.join(', ');
                    };

                    const selectorWarnings = [];

                    const normalizedContainerSelector = normalizeSelector(contSelector);
                    if (!normalizedContainerSelector) {
                        return {
                            success: false,
                            error: 'No valid container selector provided: ' + contSelector,
                            suggestion: 'Try a different/broader container selector'
                        };
                    }
                    if (normalizedContainerSelector !== contSelector) {
                        selectorWarnings.push(
                            `Container selector normalized from "${contSelector}" to "${normalizedContainerSelector}"`
                        );
                    }

                    const normalizedFields = Array.isArray(fieldDefs)
                        ? fieldDefs.map((field, index) => {
                            const fieldName = String(field?.name || `field_${index + 1}`);
                            const rawFieldSelector = String(field?.selector || '');
                            const normalizedFieldSelector = normalizeSelector(rawFieldSelector);

                            if (!normalizedFieldSelector) {
                                selectorWarnings.push(
                                    `Field "${fieldName}" has invalid selector "${rawFieldSelector}"`
                                );
                            } else if (normalizedFieldSelector !== rawFieldSelector) {
                                selectorWarnings.push(
                                    `Field "${fieldName}" selector normalized from "${rawFieldSelector}" to "${normalizedFieldSelector}"`
                                );
                            }

                            return {
                                ...field,
                                name: fieldName,
                                selector: normalizedFieldSelector
                            };
                        })
                        : [];

                    if (normalizedFields.length === 0) {
                        return {
                            success: false,
                            error: 'No extraction fields provided',
                            suggestion: 'Provide at least one field with name + selector'
                        };
                    }

                    const containers = document.querySelectorAll(normalizedContainerSelector);
                    if (containers.length === 0) {
                        return {
                            success: false,
                            error: 'No elements found for container selector: ' + normalizedContainerSelector,
                            suggestion: 'Try a different/broader container selector'
                        };
                    }

                    const urlFieldNames = /\b(url|link|href|uri|permalink)\b/i;
                    const imgFieldNames = /\b(image|img|photo|thumbnail|picture|avatar|icon|src)\b/i;

                    const results = [];
                    for (const container of containers) {
                        const item = {};
                        for (const field of normalizedFields) {
                            let el = null;
                            if (field.selector) {
                                try {
                                    el = container.querySelector(field.selector);
                                } catch (selectorErr) {
                                    selectorWarnings.push(
                                        `Field "${field.name}" selector error: ${selectorErr?.message || selectorErr}`
                                    );
                                }
                            }

                            if (!el) {
                                if (urlFieldNames.test(field.name)) {
                                    const fallbackA = container.querySelector('a[href]');
                                    if (fallbackA) {
                                        item[field.name] = fallbackA.href || null;
                                        continue;
                                    }
                                }
                                if (imgFieldNames.test(field.name)) {
                                    const fallbackImg = container.querySelector('img[src]');
                                    if (fallbackImg) {
                                        item[field.name] = fallbackImg.src || null;
                                        continue;
                                    }
                                }
                                item[field.name] = null;
                                continue;
                            }

                            let value = null;
                            const isUrlField = urlFieldNames.test(field.name);
                            const isImgField = imgFieldNames.test(field.name);

                            if (isUrlField) {
                                if (el.tagName === 'A') {
                                    value = el.href || null;
                                } else {
                                    const closestA = el.querySelector('a[href]') || el.closest('a[href]');
                                    if (closestA) value = closestA.href || null;
                                }
                                if (!value) value = el.innerText?.trim() || null;
                            } else if (isImgField) {
                                if (el.tagName === 'IMG') {
                                    value = el.src || null;
                                } else {
                                    const closestImg = el.querySelector('img[src]');
                                    if (closestImg) value = closestImg.src || null;
                                }
                                if (!value) {
                                    const imgEl = el.tagName === 'IMG' ? el : el.querySelector('img');
                                    if (imgEl) {
                                        value = imgEl.getAttribute('data-src') || imgEl.getAttribute('data-lazy-src') || null;
                                        if (!value && imgEl.srcset) {
                                            const firstSrc = imgEl.srcset.split(',')[0]?.trim()?.split(' ')[0];
                                            if (firstSrc) value = firstSrc;
                                        }
                                    }
                                }
                                if (!value) value = el.innerText?.trim() || null;
                            } else {
                                switch (field.extractType) {
                                    case 'attribute':
                                        value = el.getAttribute(field.attributeName) || null;
                                        break;
                                    case 'text':
                                    default:
                                        value = el.innerText?.trim() || null;
                                        break;
                                }
                            }

                            item[field.name] = value;
                        }

                        const hasData = Object.values(item).some(v => v !== null);
                        if (hasData) results.push(item);
                    }

                    const nullWarnings = [];
                    if (results.length > 0) {
                        for (const field of normalizedFields) {
                            const nullCount = results.filter(r => r[field.name] === null).length;
                            const nullPct = Math.round((nullCount / results.length) * 100);
                            if (nullPct > 50) {
                                nullWarnings.push(`"${field.name}": null in ${nullCount}/${results.length} items (${nullPct}%) - selector "${field.selector}" may be incorrect`);
                            }
                        }
                    }

                    const warnings = [...selectorWarnings, ...nullWarnings];

                    return {
                        success: true,
                        result: results,
                        resultLength: results.length,
                        containersFound: containers.length,
                        warnings: warnings.length > 0 ? warnings : undefined
                    };
                } catch (e) {
                    return { success: false, error: e.message };
                }
            },
            args: [containerSelector, fields]
        });

        return result?.result || { success: false, error: 'No result returned' };
    } catch (e) {
        return { success: false, error: e.message };
    }
}
async function saveScrapeFunctionToLibrary(toolArgs, currentUrl) {
    const { name, description, containerSelector, fields, outputs } = toolArgs;

    let urlPattern;
    try {
        const url = new URL(currentUrl);
        urlPattern = url.origin + '/*';
    } catch (e) {
        urlPattern = currentUrl;
    }

    const functionDef = {
        name: name,
        description: description,
        urlPatterns: [currentUrl, urlPattern], // Include both specific URL and pattern
        inputs: [],
        outputs: {
            type: 'array',
            description: outputs
        },
        // Scraper functions should NOT have a navigate step - they run on the current page
        // The parent function is responsible for navigation before calling the scraper
        steps: [
            {
                type: 'wait',
                selector: containerSelector,
                timeout: 10000,
                description: 'Wait for ' + name + ' content'
            },
            {
                type: 'extractScript',
                containerSelector: containerSelector,
                fields: fields,
                description: 'Extract data: ' + description
            }
        ],
        startUrl: currentUrl, // Keep for reference, but don't navigate there
        createdAt: Date.now(),
        source: 'smartScrape',
        testsPassed: undefined
    };

    const saveResult = await FunctionLibraryService.upsert(functionDef, { unique: true });
    const savedName = saveResult.name;
    const savedFunctions = saveResult.allFunctions;

    if (savedName !== name) {
        log(`Smart Scrape function name "${name}" already existed. Saved as "${savedName}".`);
    } else {
        log('Smart Scrape saved function: ' + savedName);
    }

    // Notify popup to refresh
    safeSendMessage({
        type: 'functionsLibraryUpdated',
        functions: savedFunctions
    });

    return { success: true, functionName: savedName };
}

async function getPageContentSnapshot(tabId, maxChars = 6000) {
    try {
        const cappedMaxChars = Math.max(1000, Math.min(Number(maxChars) || 6000, 12000));
        const [result] = await chrome.scripting.executeScript({
            target: { tabId },
            func: (limit) => {
                const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
                const headings = Array.from(document.querySelectorAll('h1,h2,h3'))
                    .slice(0, 20)
                    .map(el => (el.innerText || '').trim())
                    .filter(Boolean);
                const metaDescription = document.querySelector('meta[name="description"]')?.getAttribute('content') || '';
                return {
                    url: location.href,
                    title: document.title || '',
                    metaDescription,
                    headings,
                    bodyTextPreview: text.slice(0, limit),
                    bodyTextLength: text.length
                };
            },
            args: [cappedMaxChars]
        });

        return result?.result || { error: 'No snapshot result returned' };
    } catch (e) {
        return { error: e.message };
    }
}

/**
 * Execute an extractScript step - runs structured extraction on the page.
 * Uses containerSelector + fields config (no eval/new Function).
 */
async function executeAIExtractScript(step, tabId) {
    const containerSelector = step.containerSelector;
    const fields = step.fields;

    if (!containerSelector || !fields) {
        return { success: false, error: 'extractScript step missing containerSelector or fields' };
    }

    return await runStructuredExtractionOnPage(containerSelector, fields, tabId);
}

async function invokeSmartScrapeTool(toolName, toolArgs = {}, tabId, pageUrl = null) {
    switch (toolName) {
        case 'getPageContentSnapshot':
            return await getPageContentSnapshot(tabId, toolArgs?.maxChars);
        case 'searchPageForText':
            return await searchPageForText(toolArgs?.phrases, tabId);
        case 'runStructuredExtraction':
            return await runStructuredExtractionOnPage(toolArgs?.containerSelector, toolArgs?.fields, tabId);
        case 'saveAsFunction': {
            let resolvedPageUrl = pageUrl;
            if (!resolvedPageUrl) {
                try {
                    const tab = await chrome.tabs.get(tabId);
                    resolvedPageUrl = tab?.url || '';
                } catch {
                    resolvedPageUrl = '';
                }
            }
            return await saveScrapeFunctionToLibrary(toolArgs || {}, resolvedPageUrl || '');
        }
        default:
            return { error: `Unknown tool: ${toolName}` };
    }
}

if (typeof self !== 'undefined') {
    self.__smartScrapeToolInvoker = invokeSmartScrapeTool;
}

/**
 * Execute a smartScrape step - invokes the agentic scraper to create and run
 * a structured extraction function automatically.
 * 
 * @param {object} step - The smartScrape step { type, description, returnAs }
 * @param {number} tabId - Tab ID to scrape
 * @param {object} inputs - Workflow inputs (used to get API key if needed)
 * @returns {object} { success, result (extracted data), savedFunctionName }
 */
async function executeAISmartScrape(step, tabId, inputs) {
    const description = step.description || 'Extract structured data from page';
    const returnAs = step.returnAs || 'scrapedData';

    log(`  🕷️ SmartScrape: "${description}"`);
    log(`  🕷️ SmartScrape: tabId=${tabId}, returnAs=${returnAs}`);

    try {
        // Get API key from storage
        log(`  🕷️ SmartScrape: Getting API key from storage...`);
        const storage = await chrome.storage.local.get(['geminiApiKey']);
        const apiKey = storage.geminiApiKey;
        log(`  🕷️ SmartScrape: API key ${apiKey ? 'found' : 'NOT found'} (length: ${apiKey?.length || 0})`);

        if (!apiKey) {
            log(`  ❌ SmartScrape: No API key configured`);
            return { success: false, error: 'SmartScrape requires Gemini API key in settings' };
        }

        // Get current tab URL
        log(`  🕷️ SmartScrape: Getting tab info...`);
        const tab = await chrome.tabs.get(tabId);
        const pageUrl = tab.url;
        log(`  🕷️ SmartScrape: Page URL: ${pageUrl}`);

        // Take screenshot of current page state
        log(`  🕷️ SmartScrape: Taking screenshot...`);
        const screenshot = await takeScreenshot(tabId);
        if (!screenshot) {
            log(`  ❌ SmartScrape: Screenshot capture failed`);
            return { success: false, error: 'SmartScrape failed to capture screenshot' };
        }
        log(`  📸 SmartScrape: Screenshot captured (${Math.round(screenshot.length / 1024)}KB)`);

        // Invoke the shared agentic scraper implementation (same path as manual Smart Scrape)
        log(`  🕷️ SmartScrape: Starting shared agentic scrape loop...`);
        const scrapeResult = await AIService.agenticScrape(
            screenshot,
            pageUrl,
            apiKey,
            tabId,
            (statusMsg) => log(`  🕷️ ${statusMsg}`),
            description
        );

        const savedFunctionName = scrapeResult?.savedFunction?.name || null;
        const extractionRaw = scrapeResult?.lastExtractionResult;
        const extractedData = Array.isArray(extractionRaw?.result)
            ? extractionRaw.result
            : (Array.isArray(extractionRaw) ? extractionRaw : []);
        const scrapeSuccess = !!savedFunctionName;

        log(`  🕷️ SmartScrape: Shared loop complete. Success: ${scrapeSuccess}`);

        if (!scrapeSuccess) {
            const failureReason = 'SmartScrape failed to create extraction function';
            log(`  ❌ SmartScrape: Failed - ${failureReason}`);
            return {
                success: false,
                error: failureReason,
                result: extractedData
            };
        }

        log(`  ✅ SmartScrape created function: ${savedFunctionName}`);
        log(`  📊 Extracted ${extractedData.length} items`);

        return {
            success: true,
            result: extractedData,
            savedFunctionName,
            returnAs: returnAs
        };

    } catch (e) {
        log(`  ❌ SmartScrape error: ${e.message}`);
        console.error('[SmartScrape] Exception:', e);
        return { success: false, error: e.message, result: [] };
    }
}

// ==================== OUTPUT TOOL EXECUTORS ====================

/**
 * Generate and display HTML webpage from data
 */
async function executeAIMakeWebpage(step, inputs) {
    log(`  📄 Creating webpage: ${step.title || 'Generated Page'}`);

    const content = substituteParams(step.content, inputs);
    const title = step.title || 'Task Automator Pro - Generated Page';
    const template = step.template || 'minimal';

    // Build HTML based on template
    let html;
    const contentData = typeof content === 'string' ? content : JSON.stringify(content, null, 2);

    switch (template) {
        case 'table':
            html = buildTableTemplate(title, contentData);
            break;
        case 'cards':
            html = buildCardsTemplate(title, contentData);
            break;
        case 'report':
            html = buildReportTemplate(title, contentData);
            break;
        case 'minimal':
        default:
            html = buildMinimalTemplate(title, contentData);
    }

    // Open in new tab as data URL
    const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
    await chrome.tabs.create({ url: dataUrl });

    log(`  ✅ Webpage created and opened in new tab`);
    return { success: true, template };
}

function buildMinimalTemplate(title, content) {
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;max-width:800px;margin:40px auto;padding:20px;background:#f5f5f5;}
h1{color:#333;}pre{background:#fff;padding:15px;border-radius:8px;overflow-x:auto;}</style>
</head><body><h1>${title}</h1><pre>${content}</pre></body></html>`;
}

function buildTableTemplate(title, content) {
    let tableHtml = '';
    try {
        const data = typeof content === 'string' ? JSON.parse(content) : content;
        if (Array.isArray(data) && data.length > 0) {
            const headers = Object.keys(data[0]);
            tableHtml = `<table><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>`;
            data.forEach(row => {
                tableHtml += `<tr>${headers.map(h => `<td>${row[h] || ''}</td>`).join('')}</tr>`;
            });
            tableHtml += '</tbody></table>';
        }
    } catch (e) {
        tableHtml = `<pre>${content}</pre>`;
    }
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;padding:20px;background:#f5f5f5;}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;}
th,td{padding:12px;text-align:left;border-bottom:1px solid #eee;}
th{background:#667eea;color:#fff;}</style>
</head><body><h1>${title}</h1>${tableHtml}</body></html>`;
}

function buildCardsTemplate(title, content) {
    let cardsHtml = '';
    try {
        const data = typeof content === 'string' ? JSON.parse(content) : content;
        if (Array.isArray(data)) {
            data.forEach(item => {
                cardsHtml += `<div class="card">${Object.entries(item).map(([k, v]) =>
                    `<div><strong>${k}:</strong> ${v}</div>`).join('')}</div>`;
            });
        }
    } catch (e) {
        cardsHtml = `<pre>${content}</pre>`;
    }
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;padding:20px;background:#f5f5f5;}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:15px;}
.card{background:#fff;padding:15px;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,0.1);}</style>
</head><body><h1>${title}</h1><div class="cards">${cardsHtml}</div></body></html>`;
}

function buildReportTemplate(title, content) {
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:Georgia,serif;max-width:800px;margin:40px auto;padding:20px;background:#fff;line-height:1.6;}
h1{border-bottom:3px solid #667eea;padding-bottom:10px;}
pre{background:#f5f5f5;padding:15px;border-radius:4px;overflow-x:auto;}</style>
</head><body><h1>${title}</h1><pre>${content}</pre>
<footer style="margin-top:40px;padding-top:20px;border-top:1px solid #eee;color:#888;font-size:0.9em;">
Generated by Task Automator Pro at ${new Date().toLocaleString()}</footer></body></html>`;
}

/**
 * Modify current page DOM
 */
async function executeAIModifyWebsite(step, tabId) {
    log(`  🔧 Modifying website with ${step.modifications?.length || 0} modifications`);

    const modifications = step.modifications || [];

    try {
        const [result] = await chrome.scripting.executeScript({
            target: { tabId },
            func: (mods) => {
                const results = [];
                mods.forEach(mod => {
                    try {
                        const elements = document.querySelectorAll(mod.selector);
                        elements.forEach(el => {
                            switch (mod.action) {
                                case 'hide':
                                    el.style.display = 'none';
                                    break;
                                case 'show':
                                    el.style.display = '';
                                    break;
                                case 'remove':
                                    el.remove();
                                    break;
                                case 'highlight':
                                    el.style.cssText += mod.style || 'outline: 3px solid yellow;';
                                    break;
                                case 'addClass':
                                    el.classList.add(mod.value);
                                    break;
                                case 'removeClass':
                                    el.classList.remove(mod.value);
                                    break;
                                case 'setStyle':
                                    el.style.cssText += mod.value;
                                    break;
                                case 'injectHtml':
                                    el.innerHTML = mod.value;
                                    break;
                                case 'injectText':
                                    el.textContent = mod.value;
                                    break;
                            }
                        });
                        results.push({ selector: mod.selector, count: elements.length, success: true });
                    } catch (e) {
                        results.push({ selector: mod.selector, error: e.message, success: false });
                    }
                });
                return { success: true, results };
            },
            args: [modifications]
        });

        log(`  ✅ Website modifications applied`);
        return result?.result || { success: true };
    } catch (e) {
        log(`  ❌ Modify website failed: ${e.message}`);
        return { success: false, error: e.message };
    }
}

/**
 * Create and download a file
 */
async function executeAIMakeFile(step, inputs) {
    log(`  💾 Creating file: ${step.filename}`);

    let content = substituteParams(step.content, inputs);
    const filename = substituteParams(step.filename, inputs);
    const format = step.format || 'txt';

    // Format content based on type
    if (format === 'json' && typeof content === 'object') {
        content = JSON.stringify(content, null, 2);
    } else if (format === 'csv' && Array.isArray(content)) {
        // Convert array to CSV
        if (content.length > 0) {
            const headers = Object.keys(content[0]);
            const csvRows = [headers.join(',')];
            content.forEach(row => {
                csvRows.push(headers.map(h => `"${String(row[h] || '').replace(/"/g, '""')}"`).join(','));
            });
            content = csvRows.join('\n');
        }
    }

    // Create download via data URL
    const mimeTypes = {
        json: 'application/json',
        csv: 'text/csv',
        txt: 'text/plain',
        html: 'text/html',
        md: 'text/markdown'
    };
    const mimeType = mimeTypes[format] || 'text/plain';

    // Use chrome.downloads API
    const dataUrl = `data:${mimeType};charset=utf-8,` + encodeURIComponent(String(content));

    try {
        await chrome.downloads.download({
            url: dataUrl,
            filename: filename,
            saveAs: true
        });
        log(`  ✅ File download initiated: ${filename}`);
        return { success: true, filename };
    } catch (e) {
        log(`  ❌ File creation failed: ${e.message}`);
        return { success: false, error: e.message };
    }
}

/**
 * Generate embeddings or compare texts
 */
async function executeAICallEmbedding(step, inputs) {
    log(`  🧠 Calling embedding service`);
    const modelPrefs = normalizeFunctionModelPreferences(currentExecutionModelPreferences || {});

    let texts = step.texts;
    if (typeof texts === 'string') {
        texts = substituteParams(texts, inputs);
        try { texts = JSON.parse(texts); } catch { texts = [texts]; }
    }

    const storage = await chrome.storage.local.get(['geminiApiKey', 'ollamaEndpoint', 'useOllama']);

    try {
        // Check if ToolsService is available
        if (typeof ToolsService !== 'undefined') {
            const useOllama = modelPrefs.embeddingProvider === 'ollama'
                || step.useOllama
                || storage.useOllama;
            const embeddings = await ToolsService.getEmbeddings(texts, {
                useOllama,
                apiKey: storage.geminiApiKey,
                model: modelPrefs.embeddingModel || step.embeddingModel
            });

            if (step.compareMode && embeddings.length >= 2) {
                // Calculate similarities between first text and rest
                const similarities = [];
                const queryEmbed = embeddings[0];
                for (let i = 1; i < embeddings.length; i++) {
                    const sim = ToolsService.cosineSimilarity(queryEmbed, embeddings[i]);
                    similarities.push({ index: i - 1, similarity: sim, text: texts[i] });
                }
                similarities.sort((a, b) => b.similarity - a.similarity);

                log(`  ✅ Embedding comparison complete: ${similarities.length} results`);
                return { success: true, similarities };
            }

            log(`  ✅ Embeddings generated: ${embeddings.length} vectors`);
            return { success: true, embeddings };
        } else {
            log(`  ⚠️ ToolsService not available for embeddings`);
            return { success: false, error: 'ToolsService not loaded' };
        }
    } catch (e) {
        log(`  ❌ Embedding failed: ${e.message}`);
        return { success: false, error: e.message };
    }
}

// Workflow-scoped notepad (cleared between workflows)
let _workflowNotepad = {};

/**
 * Notepad operations for data sharing within workflow
 */
async function executeAINotepad(step, inputs) {
    const action = step.action;
    const key = step.key;
    let value = step.value;

    if (value !== undefined) {
        value = substituteParams(value, inputs);
    }

    switch (action) {
        case 'set':
            _workflowNotepad[key] = value;
            log(`  📓 Notepad SET: ${key} = ${JSON.stringify(value).substring(0, 50)}...`);
            return { success: true, value };

        case 'get':
            const retrieved = _workflowNotepad[key];
            log(`  📓 Notepad GET: ${key} = ${JSON.stringify(retrieved).substring(0, 50)}...`);
            return { success: true, value: retrieved };

        case 'getAll':
            log(`  📓 Notepad GET ALL: ${Object.keys(_workflowNotepad).length} items`);
            return { success: true, value: { ..._workflowNotepad } };

        case 'clear':
            _workflowNotepad = {};
            log(`  📓 Notepad CLEARED`);
            return { success: true };

        case 'append':
            if (!Array.isArray(_workflowNotepad[key])) {
                _workflowNotepad[key] = [];
            }
            _workflowNotepad[key].push(value);
            log(`  📓 Notepad APPEND to ${key}: now ${_workflowNotepad[key].length} items`);
            return { success: true, value: _workflowNotepad[key] };

        default:
            log(`  ⚠️ Unknown notepad action: ${action}`);
            return { success: false, error: 'Unknown notepad action' };
    }
}

/**
 * Call AI for structured text output
 */
async function executeAIGenericAI(step, inputs) {
    log(`  🤖 Generic AI call: ${step.description || step.prompt.substring(0, 50)}...`);

    const prompt = substituteParams(step.prompt, inputs);
    const schema = step.schema;
    const modelPrefs = normalizeFunctionModelPreferences(currentExecutionModelPreferences || {});

    const storage = await chrome.storage.local.get(['geminiApiKey', 'ollamaEndpoint', 'ollamaModel', 'useOllama']);

    try {
        let ollamaError = null;
        const useOllama =
            modelPrefs.aiProvider === 'ollama'
            || step.useOllama
            || storage.useOllama;
        if (useOllama) {
            // Use Ollama
            if (typeof ToolsService !== 'undefined') {
                try {
                    const result = await ToolsService.ollamaGenerate(prompt, {
                        model: step.model || modelPrefs.aiModel || storage.ollamaModel
                    });
                    log(`  ✅ Ollama response received`);
                    return { success: true, result };
                } catch (e) {
                    ollamaError = e;
                    log(`  ⚠️ Ollama failed (${e.message}). Falling back to Gemini...`);
                }
            } else {
                ollamaError = new Error('ToolsService is not available for Ollama requests');
                log(`  ⚠️ Ollama requested but ToolsService is unavailable. Falling back to Gemini...`);
            }
        }

        // Use Gemini
        const apiKey = storage.geminiApiKey;
        if (!apiKey) {
            if (ollamaError) {
                return { success: false, error: `Ollama failed (${ollamaError.message}) and no Gemini API key is configured` };
            }
            return { success: false, error: 'No API key configured' };
        }

        if (typeof ToolsService !== 'undefined' && schema) {
            const result = await ToolsService.geminiStructuredOutput(prompt, schema, apiKey, {
                model: step.model || (modelPrefs.aiProvider === 'gemini' ? modelPrefs.aiModel : '')
            });
            log(`  ✅ Gemini structured response received`);
            return { success: true, result };
        }

        // Simple Gemini call without structured output
        const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
        const MODEL = step.model || (modelPrefs.aiProvider === 'gemini' ? modelPrefs.aiModel : '') || 'gemini-3-flash-preview';

        const response = await fetch(`${API_BASE}/models/${MODEL}:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                generationConfig: { maxOutputTokens: 2048 }
            })
        });

        if (!response.ok) {
            throw new Error(`API error: ${response.status}`);
        }

        const data = await response.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

        log(`  ✅ Gemini response received`);
        return { success: true, result: text };

    } catch (e) {
        log(`  ❌ Generic AI failed: ${e.message}`);
        return { success: false, error: e.message };
    }
}


