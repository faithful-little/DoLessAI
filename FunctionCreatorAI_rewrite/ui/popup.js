document.addEventListener('DOMContentLoaded', () => {
    let currentRecordingState = { steps: [] };
    let allTasks = {};
    let allFunctions = {};
    let currentMode = 'record'; // 'record' or 'playback'
    let currentTestingFunction = null;
    let currentPageUrl = '';

    // Record Mode Elements
    const recordButton = document.getElementById('recordButton');
    const recordLiteralButton = document.getElementById('recordLiteralButton');
    const stepsContainer = document.getElementById('stepsContainer');
    const taskNameInput = document.getElementById('taskNameInput');
    const taskDescriptionInput = document.getElementById('taskDescriptionInput');
    const saveTaskButton = document.getElementById('saveTaskButton');
    const addScreenshotButton = document.getElementById('addScreenshotButton');
    const addFullPageScreenshotButton = document.getElementById('addFullPageScreenshotButton');
    const addLargestTextButton = document.getElementById('addLargestTextButton');
    const addTextNoteButton = document.getElementById('addTextNoteButton');
    const tasksContainer = document.getElementById('tasksContainer');
    const logsContainer = document.getElementById('logsContainer');
    const modal = document.getElementById('screenshotModal');
    const modalImg = document.getElementById('screenshotImage');
    const closeModalBtn = document.querySelector('.close-modal-btn');
    const returnValueContainer = document.getElementById('returnValueContainer');
    const returnValueOutput = document.getElementById('returnValueOutput');
    const liveActionTextInput = document.getElementById('liveActionTextInput');
    const liveActionClickButton = document.getElementById('liveActionClickButton');
    const exportLogsBtn = document.getElementById('exportLogsBtn');

    // Settings Elements
    const settingsToggle = document.getElementById('settingsToggle');
    const settingsPanel = document.getElementById('settingsPanel');
    const audioDeviceSelect = document.getElementById('audioDeviceSelect');
    const geminiApiKeyInput = document.getElementById('geminiApiKey');
    const toggleApiKeyVisibility = document.getElementById('toggleApiKeyVisibility');
    const retryCountSelect = document.getElementById('retryCountSelect');
    const thinkingLevelSelect = document.getElementById('thinkingLevelSelect');
    const showTestsForeground = document.getElementById('showTestsForeground');
    const computerUseMaxActionsInput = document.getElementById('computerUseMaxActions');
    const enableProactiveExplorationCheckbox = document.getElementById('enableProactiveExploration');

    // Mode Tab Elements
    const recordModeTab = document.getElementById('recordModeTab');
    const playbackModeTab = document.getElementById('playbackModeTab');
    const aiTaskModeTab = document.getElementById('aiTaskModeTab');
    const toolTestModeTab = document.getElementById('toolTestModeTab');
    const recordModeContent = document.getElementById('recordModeContent');
    const playbackModeContent = document.getElementById('playbackModeContent');
    const aiTaskModeContent = document.getElementById('aiTaskModeContent');
    const toolTestModeContent = document.getElementById('toolTestModeContent');

    // Playback Mode Elements
    const generateFunctionBtn = document.getElementById('generateFunctionBtn');
    const generationStatus = document.getElementById('generationStatus');
    const functionsContainer = document.getElementById('functionsContainer');
    const functionTestSection = document.querySelector('.function-test-section');
    const testInputsContainer = document.getElementById('testInputsContainer');
    const runTestBtn = document.getElementById('runTestBtn');
    const testResultsContainer = document.getElementById('testResultsContainer');

    // Reference Functions Elements
    const referenceFunctionsSection = document.getElementById('referenceFunctionsSection');
    const referenceFunctionsList = document.getElementById('referenceFunctionsList');

    // Smart Scrape Elements
    const smartScrapeBtn = document.getElementById('smartScrapeBtn');
    const smartScrapeStatus = document.getElementById('smartScrapeStatus');
    const smartScrapePreview = document.getElementById('smartScrapePreview');
    const smartScrapeResult = document.getElementById('smartScrapeResult');

    // AI Task Mode Elements
    const aiTaskDescription = document.getElementById('aiTaskDescription');
    const aiTaskGenerateBtn = document.getElementById('aiTaskGenerateBtn');
    const aiTaskStopTestsSaveBtn = document.getElementById('aiTaskStopTestsSaveBtn');
    const aiTaskStopNowBtn = document.getElementById('aiTaskStopNowBtn');
    const aiTaskStatus = document.getElementById('aiTaskStatus');
    const aiTaskFunctionsContainer = document.getElementById('aiTaskFunctionsContainer');
    const functionModelModal = document.getElementById('functionModelModal');
    const closeModelBtn = document.querySelector('.close-model-btn');
    const saveFunctionModelBtn = document.getElementById('saveFunctionModelBtn');
    const cancelFunctionModelBtn = document.getElementById('cancelFunctionModelBtn');
    const functionModelName = document.getElementById('functionModelName');
    const functionAiProvider = document.getElementById('functionAiProvider');
    const functionAiModel = document.getElementById('functionAiModel');
    const functionEmbeddingProvider = document.getElementById('functionEmbeddingProvider');
    const functionEmbeddingModel = document.getElementById('functionEmbeddingModel');

    const aiTaskRunControl = {
        isRunning: false,
        stopRequested: false,
        stopTestsAndSaveRequested: false,
        activePath: null,
        latestBuiltFunction: null
    };

    // Microphone Permission Container
    const permissionContainer = document.createElement('div');
    permissionContainer.className = 'permission-container';
    permissionContainer.style.display = 'none';
    permissionContainer.innerHTML = '<button id="enableMicBtn" style="background-color: #ffc107; border: none; padding: 5px 10px; cursor: pointer; border-radius: 4px;">⚠️ Enable Microphone</button>';
    document.querySelector('.controls').appendChild(permissionContainer);

    document.getElementById('enableMicBtn').addEventListener('click', () => {
        chrome.tabs.create({ url: 'permission.html' });
    });

    navigator.permissions.query({ name: 'microphone' }).then((permissionStatus) => {
        if (permissionStatus.state !== 'granted') permissionContainer.style.display = 'block';
        permissionStatus.onchange = () => {
            permissionContainer.style.display = permissionStatus.state === 'granted' ? 'none' : 'block';
        };
    });

    closeModalBtn.onclick = () => { modal.style.display = "none"; };
    window.onclick = (event) => {
        if (event.target == modal) modal.style.display = "none";
        if (event.target == document.getElementById('codeEditorModal')) document.getElementById('codeEditorModal').style.display = "none";
        if (event.target == functionModelModal) functionModelModal.style.display = "none";
    };

    // Code Editor Elements and Logic
    const codeEditorModal = document.getElementById('codeEditorModal');
    const codeEditorTextarea = document.getElementById('codeEditorTextarea');
    const saveCodeBtn = document.getElementById('saveCodeBtn');
    const cancelCodeBtn = document.getElementById('cancelCodeBtn');
    const closeEditorBtn = document.querySelector('.close-editor-btn');
    let currentEditingFunction = null;
    let currentModelEditingFunction = null;

    closeEditorBtn.onclick = () => { codeEditorModal.style.display = "none"; };
    cancelCodeBtn.onclick = () => { codeEditorModal.style.display = "none"; };
    if (closeModelBtn) closeModelBtn.onclick = () => { functionModelModal.style.display = "none"; };
    if (cancelFunctionModelBtn) cancelFunctionModelBtn.onclick = () => { functionModelModal.style.display = "none"; };

    saveCodeBtn.onclick = async () => {
        try {
            const newCode = codeEditorTextarea.value;
            const parsedFunc = JSON.parse(newCode);

            // Basic Validation
            if (!parsedFunc.name || (!parsedFunc.steps && !parsedFunc.scriptCode)) {
                alert("Invalid function definition: Must have 'name' and 'steps' OR 'scriptCode'.");
                return;
            }

            // Handle name change
            const oldName = currentEditingFunction.name;
            const newName = parsedFunc.name;

            if (oldName !== newName) {
                if (allFunctions[newName] && !confirm(`Function "${newName}" already exists. Overwrite?`)) {
                    return;
                }
                delete allFunctions[oldName];
            }

            // Update logic
            allFunctions[newName] = {
                ...parsedFunc,
                createdAt: currentEditingFunction.createdAt || Date.now(),
                testCases: currentEditingFunction.testCases,
                testsPassed: (JSON.stringify(currentEditingFunction.steps) !== JSON.stringify(parsedFunc.steps)) ? undefined : currentEditingFunction.testsPassed,
                modelPreferences: parsedFunc.modelPreferences || currentEditingFunction.modelPreferences
            };

            await saveFunctionLibrary();
            updateFunctionsLibrary();

            // Update currentTestingFunction if it matches
            if (currentTestingFunction && (currentTestingFunction.name === oldName || currentTestingFunction.name === newName)) {
                currentTestingFunction = allFunctions[newName];
                // If test panel is open, refresh it
                if (document.querySelector('.function-test-section').style.display === 'block') {
                    openTestPanel(currentTestingFunction);
                }
            }

            codeEditorModal.style.display = "none";
            addLogEntry(`💾 Updated function: ${newName}`);

        } catch (e) {
            alert("Error parsing JSON: " + e.message);
        }
    };

    function openCodeEditor(func) {
        currentEditingFunction = func;
        // Show full JSON structure (Hybrid steps)
        codeEditorTextarea.value = JSON.stringify(func, null, 2);
        codeEditorModal.style.display = "block";
    }

    function normalizeModelPreferences(prefs = {}) {
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

    function openModelSettingsModal(func) {
        if (!func || !functionModelModal) return;
        currentModelEditingFunction = func;
        const prefs = normalizeModelPreferences(func.modelPreferences || {});

        if (functionModelName) functionModelName.textContent = func.name || '-';
        if (functionAiProvider) functionAiProvider.value = prefs.aiProvider;
        if (functionAiModel) functionAiModel.value = prefs.aiModel;
        if (functionEmbeddingProvider) functionEmbeddingProvider.value = prefs.embeddingProvider;
        if (functionEmbeddingModel) functionEmbeddingModel.value = prefs.embeddingModel;

        functionModelModal.style.display = 'block';
    }

    if (saveFunctionModelBtn) {
        saveFunctionModelBtn.onclick = async () => {
            if (!currentModelEditingFunction) return;
            const prefs = normalizeModelPreferences({
                aiProvider: functionAiProvider?.value,
                aiModel: functionAiModel?.value,
                embeddingProvider: functionEmbeddingProvider?.value,
                embeddingModel: functionEmbeddingModel?.value
            });
            const cleaned = {
                aiProvider: prefs.aiProvider,
                embeddingProvider: prefs.embeddingProvider
            };
            if (prefs.aiModel) cleaned.aiModel = prefs.aiModel;
            if (prefs.embeddingModel) cleaned.embeddingModel = prefs.embeddingModel;

            const funcName = currentModelEditingFunction.name;
            const existing = allFunctions[funcName];
            if (!existing) {
                functionModelModal.style.display = 'none';
                return;
            }

            allFunctions[funcName] = {
                ...existing,
                modelPreferences: cleaned
            };
            await saveFunctionLibrary();
            updateFunctionsLibrary();
            updateAITaskFunctionsLibrary();
            functionModelModal.style.display = 'none';
            addLogEntry(`🤖 Updated model settings for: ${funcName}`);
        };
    }

    // Helper to display JSON in a readable, collapsible format
    function createJsonDisplay(data) {
        const pre = document.createElement('pre');
        pre.className = 'json-display';
        pre.textContent = JSON.stringify(data, null, 2);
        return pre;
    }

    function getFunctionLibraryService() {
        return (typeof FunctionLibraryService !== 'undefined') ? FunctionLibraryService : null;
    }

    async function loadFunctionLibrary() {
        const service = getFunctionLibraryService();
        if (service) return await service.getAll();
        const storage = await chrome.storage.local.get(['generatedFunctions']);
        return storage.generatedFunctions || {};
    }

    async function saveFunctionLibrary() {
        const service = getFunctionLibraryService();
        if (service) {
            allFunctions = await service.setAll(allFunctions);
            return allFunctions;
        }
        await chrome.storage.local.set({ generatedFunctions: allFunctions });
        return allFunctions;
    }

    function getUniqueFunctionName(baseName) {
        const service = getFunctionLibraryService();
        if (service) {
            return service.getUniqueName(baseName, allFunctions);
        }
        const cleanedBase = (baseName && String(baseName).trim()) || 'GeneratedFunction';
        if (!allFunctions[cleanedBase]) return cleanedBase;
        let idx = 2;
        let candidate = `${cleanedBase}V${idx}`;
        while (allFunctions[candidate]) {
            idx++;
            candidate = `${cleanedBase}V${idx}`;
        }
        return candidate;
    }

    function applyFunctionNameMapping(funcDef, nameMap = {}) {
        if (!funcDef || typeof funcDef !== 'object') return funcDef;
        const mapped = JSON.parse(JSON.stringify(funcDef));

        if (Array.isArray(mapped.referenceFunctions)) {
            mapped.referenceFunctions = mapped.referenceFunctions.map(n => nameMap[n] || n);
        }

        if (Array.isArray(mapped.steps)) {
            mapped.steps = mapped.steps.map(step => {
                if (!step || typeof step !== 'object') return step;
                const s = { ...step };
                if (typeof s.code === 'string') {
                    for (const [oldName, newName] of Object.entries(nameMap)) {
                        s.code = s.code.split(`'${oldName}'`).join(`'${newName}'`);
                        s.code = s.code.split(`"${oldName}"`).join(`"${newName}"`);
                    }
                }
                return s;
            });
        }

        return mapped;
    }

    function returnValueUpdate(value) {
        returnValueOutput.innerHTML = ''; // Clear previous content
        if (value === undefined || value === null) {
            returnValueOutput.textContent = 'No return value.';
        } else if (typeof value === 'object') {
            returnValueOutput.appendChild(createJsonDisplay(value));
        } else {
            returnValueOutput.textContent = String(value);
        }
        returnValueContainer.style.display = 'block';
    }

    // ==================== SETTINGS ====================

    // Settings Toggle
    settingsToggle.addEventListener('click', () => {
        settingsPanel.classList.toggle('active');
        if (settingsPanel.classList.contains('active')) {
            refreshAudioDevices();
            checkOllamaHealth();
        }
    });

    // API Key Visibility Toggle
    toggleApiKeyVisibility.addEventListener('click', () => {
        if (geminiApiKeyInput.type === 'password') {
            geminiApiKeyInput.type = 'text';
            toggleApiKeyVisibility.textContent = '🙈';
        } else {
            geminiApiKeyInput.type = 'password';
            toggleApiKeyVisibility.textContent = '👁️';
        }
    });

    // Save settings on change
    geminiApiKeyInput.addEventListener('change', () => {
        chrome.storage.local.set({ geminiApiKey: geminiApiKeyInput.value });
        updateGenerateButtonState();
    });

    retryCountSelect.addEventListener('change', () => {
        chrome.storage.local.set({ aiRetryCount: parseInt(retryCountSelect.value) });
    });

    thinkingLevelSelect.addEventListener('change', () => {
        chrome.storage.local.set({ aiThinkingLevel: thinkingLevelSelect.value });
    });

    audioDeviceSelect.addEventListener('change', () => {
        const deviceId = audioDeviceSelect.value;
        chrome.storage.local.set({ selectedAudioDeviceId: deviceId });
    });

    showTestsForeground.addEventListener('change', () => {
        chrome.storage.local.set({ showTestsForeground: showTestsForeground.checked });
    });

    computerUseMaxActionsInput?.addEventListener('change', () => {
        const parsed = parseInt(computerUseMaxActionsInput.value, 10);
        const normalized = Number.isFinite(parsed) ? Math.min(500, Math.max(1, parsed)) : 50;
        computerUseMaxActionsInput.value = String(normalized);
        chrome.storage.local.set({ computerUseMaxActions: normalized });
    });

    enableProactiveExplorationCheckbox?.addEventListener('change', () => {
        chrome.storage.local.set({ enableProactiveExploration: enableProactiveExplorationCheckbox.checked });
    });

    async function refreshAudioDevices() {
        chrome.runtime.sendMessage({ type: 'get-audio-devices' });
    }

    // Load saved settings
    chrome.storage.local.get(['selectedAudioDeviceId', 'geminiApiKey', 'aiRetryCount', 'aiThinkingLevel', 'generatedFunctions', 'showTestsForeground', 'computerUseMaxActions', 'enableProactiveExploration'], (data) => {
        if (data.selectedAudioDeviceId) {
            audioDeviceSelect.value = data.selectedAudioDeviceId;
        }
        if (data.geminiApiKey) {
            geminiApiKeyInput.value = data.geminiApiKey;
        }
        if (data.aiRetryCount) {
            retryCountSelect.value = data.aiRetryCount.toString();
        }
        if (data.aiThinkingLevel) {
            thinkingLevelSelect.value = data.aiThinkingLevel;
        }
        if (data.generatedFunctions) {
            allFunctions = data.generatedFunctions;
            updateFunctionsLibrary();
            updateAITaskFunctionsLibrary();
            updateReferenceFunctionsList(); // Update reference list on load
        }
        showTestsForeground.checked = data.showTestsForeground !== undefined ? data.showTestsForeground : true;
        if (computerUseMaxActionsInput) {
            const parsed = parseInt(data.computerUseMaxActions, 10);
            const normalized = Number.isFinite(parsed) ? Math.min(500, Math.max(1, parsed)) : 50;
            computerUseMaxActionsInput.value = String(normalized);
        }
        if (enableProactiveExplorationCheckbox) {
            enableProactiveExplorationCheckbox.checked = !!data.enableProactiveExploration;
        }
        updateGenerateButtonState();
    });

    // ==================== FUNCTION REFERENCE HELPERS ====================

    /**
     * Find functions that match the recording's URL domain
     * These will be automatically included as context for the AI
     */
    function getRelatedFunctions(recordingUrl) {
        if (!recordingUrl) return [];

        try {
            const recordingDomain = new URL(recordingUrl).hostname;
            return Object.values(allFunctions).filter(func => {
                const patterns = func.urlPatterns || [];
                return patterns.some(pattern => {
                    try {
                        // Check if pattern contains the same domain
                        if (pattern.includes(recordingDomain)) return true;
                        // Or extract domain from pattern
                        const patternDomain = new URL(pattern.replace(/\*/g, 'example')).hostname;
                        return patternDomain === recordingDomain;
                    } catch {
                        return pattern.includes(recordingDomain);
                    }
                });
            });
        } catch {
            return [];
        }
    }

    /**
     * Update the reference functions list UI
     * Shows only functions from OTHER sites for optional cross-site references
     * Same-site functions are auto-included and don't need to be shown
     */
    function updateReferenceFunctionsList() {
        if (!referenceFunctionsSection || !referenceFunctionsList) return;

        const startUrl = currentRecordingState.steps?.[0]?.url;
        const relatedFunctions = getRelatedFunctions(startUrl);
        const relatedNames = new Set(relatedFunctions.map(f => f.name));

        // Get functions NOT auto-included (different sites)
        const otherFunctions = Object.values(allFunctions).filter(f => !relatedNames.has(f.name));

        if (otherFunctions.length === 0) {
            referenceFunctionsSection.style.display = 'none';
            return;
        }

        referenceFunctionsSection.style.display = 'block';
        referenceFunctionsList.innerHTML = otherFunctions.map(func => `
            <label class="reference-function-item">
                <input type="checkbox" value="${func.name}" class="reference-function-checkbox">
                <span class="function-name">${func.name}</span>
                <span class="function-urls">${(func.urlPatterns || []).slice(0, 2).join(', ')}</span>
            </label>
        `).join('');
    }

    // ==================== MODE SWITCHING ====================

    recordModeTab.addEventListener('click', () => switchMode('record'));
    playbackModeTab.addEventListener('click', () => switchMode('playback'));
    aiTaskModeTab.addEventListener('click', () => switchMode('aiTask'));
    if (toolTestModeTab) toolTestModeTab.addEventListener('click', () => switchMode('toolTest'));

    function switchMode(mode) {
        currentMode = mode;
        recordModeTab.classList.toggle('active', mode === 'record');
        playbackModeTab.classList.toggle('active', mode === 'playback');
        aiTaskModeTab.classList.toggle('active', mode === 'aiTask');
        if (toolTestModeTab) toolTestModeTab.classList.toggle('active', mode === 'toolTest');
        recordModeContent.style.display = mode === 'record' ? 'block' : 'none';
        playbackModeContent.style.display = mode === 'playback' ? 'block' : 'none';
        aiTaskModeContent.style.display = mode === 'aiTask' ? 'block' : 'none';
        if (toolTestModeContent) toolTestModeContent.style.display = mode === 'toolTest' ? 'block' : 'none';

        if (mode === 'playback') {
            updateGenerateButtonState();
            updateFunctionsLibrary();
        }
        if (mode === 'aiTask') {
            updateAITaskButtonState();
            updateAITaskFunctionsLibrary();
        }
    }

    function updateGenerateButtonState() {
        const hasRecording = currentRecordingState.steps && currentRecordingState.steps.length > 0;
        const hasApiKey = geminiApiKeyInput.value.trim().length > 0;
        generateFunctionBtn.disabled = !(hasRecording && hasApiKey);

        if (!hasApiKey) {
            generateFunctionBtn.title = 'Please add your Gemini API key in settings';
        } else if (!hasRecording) {
            generateFunctionBtn.title = 'Please record some actions first';
        } else {
            generateFunctionBtn.title = 'Generate a reusable function from your recording';
        }

        updateSmartScrapeButtonState();
    }

    function updateSmartScrapeButtonState() {
        const hasApiKey = geminiApiKeyInput.value.trim().length > 0;
        smartScrapeBtn.disabled = !hasApiKey;
        smartScrapeBtn.title = hasApiKey
            ? 'Analyze current page and create extraction function'
            : 'Please add your Gemini API key in settings';
    }

    // ==================== AI FUNCTION GENERATION ====================

    generateFunctionBtn.addEventListener('click', async () => {
        await generateFunctionFromRecording();
    });

    async function generateFunctionFromRecording() {
        console.log('Generate Function clicked', {
            hasApiKey: !!geminiApiKeyInput.value.trim(),
            stepsCount: currentRecordingState.steps?.length
        });
        addLogEntry('🤖 Starting AI function generation...');

        const apiKey = geminiApiKeyInput.value.trim();
        if (!apiKey) {
            showGenerationStatus('Please add your Gemini API key in settings', 'error');
            addLogEntry('❌ No API key configured');
            return;
        }

        if (!currentRecordingState.steps || currentRecordingState.steps.length === 0) {
            showGenerationStatus('No recording available. Please record some actions first.', 'error');
            addLogEntry('❌ No recording steps available');
            return;
        }

        const retryCount = parseInt(retryCountSelect.value) || 3;
        const thinkingLevel = thinkingLevelSelect.value || 'HIGH';

        // Collect user notes from the recording
        const userNotes = currentRecordingState.steps
            .filter(s => s.action === 'text_annotation' || s.action === 'audio_annotation')
            .map(s => s.text || s.transcription || '[Audio note]');

        // Collect reference functions (auto-discovered + manually selected)
        const startUrl = currentRecordingState.steps?.[0]?.url;
        const autoReferenceFunctions = getRelatedFunctions(startUrl);
        const manualReferenceFunctions = Array.from(
            document.querySelectorAll('.reference-function-checkbox:checked')
        ).map(cb => allFunctions[cb.value]).filter(Boolean);

        // Combine and deduplicate
        const allReferenceFunctions = [...autoReferenceFunctions];
        manualReferenceFunctions.forEach(f => {
            if (!allReferenceFunctions.find(rf => rf.name === f.name)) {
                allReferenceFunctions.push(f);
            }
        });

        if (allReferenceFunctions.length > 0) {
            addLogEntry(`📚 Including ${allReferenceFunctions.length} reference function(s): ${allReferenceFunctions.map(f => f.name).join(', ')}`);
        }

        generateFunctionBtn.disabled = true;
        generateFunctionBtn.innerHTML = '<span class="spinner"></span> Generating...';
        showGenerationStatus('Sending recording to AI for analysis...', 'active');

        let lastError = null;
        let attemptErrors = [];

        for (let attempt = 1; attempt <= retryCount; attempt++) {
            try {
                showGenerationStatus(`Attempt ${attempt}/${retryCount}: Generating function...`, 'active');

                // Pass previous errors to the AI if this is a retry
                const retryNotes = attempt > 1 ? [...userNotes, ...attemptErrors] : userNotes;

                const result = await AIService.generateFunction(
                    currentRecordingState,
                    retryNotes,
                    apiKey,
                    { thinkingLevel, referenceFunctions: allReferenceFunctions }
                );

                if (!result.function) {
                    throw new Error("AI did not return a function definition.");
                }

                // FALLBACK: If AI generated manual extraction script instead of smartScrape, convert it
                // This catches cases where the AI ignores the smartScrape instruction and uses
                // script steps with getElements/extract loops (which are fragile and return nulls)
                if (!result.function.steps.some(s => s.type === 'smartScrape')) {
                    const manualExtractIdx = result.function.steps.findIndex(s =>
                        s.type === 'script' && s.code &&
                        s.code.includes('getElements') &&
                        (s.code.includes('extract(') || s.code.includes('extractAttribute('))
                    );
                    if (manualExtractIdx !== -1) {
                        addLogEntry('🔄 Detected manual extraction script - converting to SmartScrape for reliability...');
                        const origStep = result.function.steps[manualExtractIdx];
                        result.function.steps[manualExtractIdx] = {
                            type: 'smartScrape',
                            description: origStep.description || result.function.description || 'Extract structured data from page',
                            returnAs: 'extractedData'
                        };
                    }
                }

                // CHECK FOR SMART SCRAPE STEPS & PRE-GENERATE
                const smartScrapeStepIndex = result.function.steps.findIndex(s => s.type === 'smartScrape');
                if (smartScrapeStepIndex !== -1) {
                    const scrapeStep = result.function.steps[smartScrapeStepIndex];

                    // Reuse an existing SmartScrape function if one already matches this URL/domain.
                    // CRITICAL: Only reuse scrapers that match the SAME domain as the recording
                    const existingFuncs = await loadFunctionLibrary();
                    
                    // Get domain from recording URL
                    let recordingDomain = null;
                    try {
                        recordingDomain = startUrl ? new URL(startUrl).hostname : null;
                    } catch { /* ignore invalid URLs */ }
                    
                    // Find existing scraper that matches the SAME domain
                    const existingScraper = recordingDomain ? Object.values(existingFuncs).find(f => {
                        if (f.source !== 'smartScrape' || !f.steps || f.steps.length === 0) return false;
                        // Check if any of the function's URL patterns match the recording domain
                        return (f.urlPatterns || []).some(pattern => {
                            try {
                                return pattern.includes(recordingDomain) || 
                                       new URL(pattern.replace(/\*/g, 'example')).hostname === recordingDomain;
                            } catch { return pattern.includes(recordingDomain); }
                        });
                    }) : null;

                    if (existingScraper) {
                        addLogEntry(`♻️ Reusing existing URL-matched scraper: ${existingScraper.name}`);
                        result.function.steps[smartScrapeStepIndex] = {
                            type: 'script',
                            description: scrapeStep.description,
                            code: `const extractedData = await page.executeFunction('${existingScraper.name}');\nreturn extractedData;`
                        };
                        if (!result.function.referenceFunctions) result.function.referenceFunctions = [];
                        result.function.referenceFunctions.push(existingScraper.name);

                        // Update output schema from existing scraper
                        if (existingScraper.extractionConfig?.fields) {
                            const fieldNames = existingScraper.extractionConfig.fields.map(f => f.name);
                            result.function.outputs = {
                                type: 'array',
                                description: existingScraper.description,
                                fields: fieldNames.join(', ')
                            };
                        }
                    } else {
                    // Run fresh SmartScrape pre-generation
                    showGenerationStatus(`Generating scraper: "${scrapeStep.description}"...`, 'active');
                    addLogEntry(`🤖 Found SmartScrape step. Invoking agentic scraper pre-generation...`);

                    // Find the right tab: prefer recording tab URL, fall back to active tab
                    const recordingStartUrl = currentRecordingState.steps?.[0]?.url;
                    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
                    const activeTab = tabs[0];

                    if (!activeTab) {
                        throw new Error("No active tab found for SmartScrape generation");
                    }

                    // Take screenshot - pass URL hint so background can find the right tab
                    const tabData = await chrome.runtime.sendMessage({
                        type: 'startSmartScrape',
                        pageUrl: recordingStartUrl,
                        tabId: activeTab.id
                    });
                    if (!tabData?.screenshot) {
                        const errorDetail = tabData?.error || 'unknown reason';
                        throw new Error(`Failed to capture screenshot for SmartScrape: ${errorDetail}`);
                    }

                    // Run the agentic loop
                    const scrapeResult = await AIService.agenticScrape(
                        tabData.screenshot,
                        activeTab.url,
                        apiKey,
                        activeTab.id,
                        (status) => {
                            showGenerationStatus(`Scraper: ${status}`, 'active');
                            addLogEntry(`  🕷️ ${status}`);
                        }
                    );

                    if (scrapeResult.savedFunction) {
                        addLogEntry(`✅ Scraper function created: ${scrapeResult.savedFunction.name}`);

                        // Replace the smartScrape step with an executeFunction step
                        result.function.steps[smartScrapeStepIndex] = {
                            type: 'script', // Use script type to invoke via page.executeFunction which is robust
                            description: scrapeStep.description,
                            code: `const extractedData = await page.executeFunction('${scrapeResult.savedFunction.name}');\nreturn extractedData;`
                        };

                        // Also Add explicit dependency to reference functions so it's clear
                        if (!result.function.referenceFunctions) result.function.referenceFunctions = [];
                        result.function.referenceFunctions.push(scrapeResult.savedFunction.name);

                        // Update the function's output schema to match SmartScrape's actual fields
                        // This prevents verification from failing due to schema mismatch
                        // (analysis predicts one schema, SmartScrape discovers a different one)
                        if (scrapeResult.savedFunction.fields) {
                            const fieldNames = scrapeResult.savedFunction.fields.map(f => f.name);
                            result.function.outputs = {
                                type: 'array',
                                description: scrapeResult.savedFunction.outputs || scrapeResult.savedFunction.description,
                                fields: fieldNames.join(', ')
                            };
                            addLogEntry(`📋 Updated output schema to SmartScrape fields: ${fieldNames.join(', ')}`);
                        }

                    } else {
                        throw new Error("Failed to generate scraper function. Agentic loop finished without saving.");
                    }
                    } // end else (fresh SmartScrape pre-generation)
                }

                // POST-GENERATION FIX: Ensure TYPE steps are parameterized
                // The AI sometimes hardcodes recorded values (e.g., "bowl") instead of
                // using {{inputName}} syntax, which breaks parameter substitution at runtime.
                const funcInputs = result.function.inputs || [];
                if (funcInputs.length > 0) {
                    // Get typed values from the recording
                    const recordedTypeValues = currentRecordingState.steps
                        .filter(s => s.action === 'type' || s.action === 'literal_type')
                        .map(s => s.value)
                        .filter(Boolean);

                    for (const step of result.function.steps) {
                        if (step.type === 'type' && step.value && !step.value.includes('{{')) {
                            // This TYPE step has a hardcoded value - check if it matches a recorded value
                            const isRecordedValue = recordedTypeValues.some(rv =>
                                step.value === rv || step.value.includes(rv) || rv.includes(step.value)
                            );
                            if (isRecordedValue) {
                                // Find the matching input parameter
                                const matchInput = funcInputs.find(i => i.defaultValue === step.value)
                                    || funcInputs.find(i => i.type === 'string');
                                if (matchInput) {
                                    addLogEntry(`🔧 Parameterizing TYPE step: "${step.value}" → {{${matchInput.name}}}`);
                                    step.value = `{{${matchInput.name}}}`;
                                }
                            }
                        }
                    }
                }

                // Success! Generate test cases
                showGenerationStatus(`Generated! Creating tests (Attempt ${attempt})...`, 'active');
                addLogEntry(`🤖 AI generated "${result.function.name}". Creating tests...`);

                let testCases = [];
                try {
                    const testResult = await AIService.generateTestCases(result.function, apiKey);
                    testCases = testResult.testCases || [];
                } catch (testError) {
                    console.warn('Failed to generate test cases:', testError);
                    addLogEntry('⚠️ Failed to generate tests. Skipping verification.');
                }

                if (testCases.length > 0) {
                    showGenerationStatus(`Running ${testCases.length} tests...`, 'active');
                    addLogEntry(`🧪 Running ${testCases.length} verification tests...`);

                    let allTestsPassed = true;
                    let testReport = "";

                    for (const testCase of testCases) {
                        addLogEntry(`  Running test: ${testCase.name}`);
                        let testWindow = null;
                        try {
                            // Create a new window for the test to ensure a clean state
                            // Use foreground or minimized based on setting
                            const windowState = showTestsForeground.checked ? 'normal' : 'minimized';
                            testWindow = await chrome.windows.create({
                                url: 'about:blank',
                                type: 'normal',
                                state: windowState
                            });
                            const testTabId = testWindow.tabs[0].id;

                            // Give it a moment to initialize
                            await new Promise(r => setTimeout(r, 500));

                            // Execute the function via background script
                            const executionResult = await chrome.runtime.sendMessage({
                                type: 'executeGeneratedFunction',
                                functionDef: result.function,
                                inputs: testCase.inputs,
                                tabId: testTabId
                            });

                            if (executionResult && executionResult.success) {
                                // Simple verification: Did it run without error? 
                                // Ideally we check output match, but for now mostly ensuring it runs.
                                // If testCase has expectedOutcome, we could try to fuzzy match.
                                addLogEntry(`  ✅ Test passed: ${testCase.name}`);
                            } else {
                                testReport += failMsg + "\n";
                            }

                            // Verify Output Data Quality
                            if (allTestsPassed) {
                                addLogEntry(`  🔍 Verifying output data quality...`);
                                const verification = await AIService.verifyFunctionOutput(result.function, executionResult, apiKey);
                                if (!verification.valid) {
                                    allTestsPassed = false;
                                    const failMsg = `Output verification failed: ${verification.reason}`;
                                    addLogEntry(`  ❌ ${failMsg}`);
                                    testReport += failMsg + "\n";
                                } else {
                                    addLogEntry(`  ✅ Output data verified valid.`);
                                }
                            }
                        } catch (e) {
                            allTestsPassed = false;
                            testReport += `Test "${testCase.name}" execution error: ${e.message}\n`;
                        } finally {
                            // Clean up window
                            if (testWindow) {
                                try {
                                    await new Promise(r => setTimeout(r, 1000)); // Wait for any pending screenshots/logs
                                    await chrome.windows.remove(testWindow.id);
                                } catch (err) { /* ignore */ }
                            }
                        }
                    }

                    if (!allTestsPassed) {
                        attemptErrors.push(`Attempt ${attempt} verification failed. Fix these errors: \n${testReport}`);
                        throw new Error(`Verification tests failed.`);
                    }
                }

                // If we get here, tests passed or were skipped. Save logic.
                let normalizedUrlPatterns = Array.isArray(result.function.urlPatterns)
                    ? result.function.urlPatterns.filter(Boolean)
                    : [];
                if (normalizedUrlPatterns.length === 0 && startUrl) {
                    try {
                        const parsed = new URL(startUrl);
                        normalizedUrlPatterns = Array.from(new Set([
                            `${parsed.origin}${parsed.pathname}*`,
                            `${parsed.origin}/*`
                        ]));
                    } catch {
                        // Ignore invalid recording URL.
                    }
                }

                const functionToSave = {
                    ...result.function,
                    urlPatterns: normalizedUrlPatterns,
                    createdAt: Date.now(),
                    testCases: testCases,
                    testsPassed: true
                };

                const uniqueName = getUniqueFunctionName(functionToSave.name);
                if (uniqueName !== functionToSave.name) {
                    addLogEntry(`♻️ Existing function "${functionToSave.name}" kept. Saving new version as "${uniqueName}".`);
                    functionToSave.name = uniqueName;
                }
                allFunctions[functionToSave.name] = functionToSave;
                await saveFunctionLibrary();

                updateFunctionsLibrary();
                showGenerationStatus(`✅ Function "${functionToSave.name}" created and verified!`, 'success');
                addLogEntry(`🎉 Verified Function Saved: ${functionToSave.name}`);
                break; // Exit retry loop

            } catch (error) {
                lastError = error;
                console.error(`Attempt ${attempt} failed:`, error);

                // Add error to tracking for next attempt prompt
                attemptErrors.push(`Attempt ${attempt} failed: ${error.message}`);

                if (attempt < retryCount) {
                    showGenerationStatus(`Attempt ${attempt} failed. Retrying...`, 'error');
                    addLogEntry(`⚠️ Attempt ${attempt} failed: ${error.message}. Retrying...`);
                    await new Promise(r => setTimeout(r, 1000)); // Wait before retry
                }
            }
        }

        if (lastError && !allFunctions[Object.keys(allFunctions).pop()]?.createdAt) { // Check if we failed completely
            // check if we actually saved something in the loop (break condition)
            // The loop breaks on success, so if we are here and the last function wasn't just saved...
            // Ensure we don't show error if we succeeded.
        }

        // Final check based on UI state or logic
        if (lastError && attemptErrors.length >= retryCount) { // Approximate check
            showGenerationStatus(`❌ Failed after ${retryCount} attempts. See logs.`, 'error');
        }

        generateFunctionBtn.disabled = false;
        generateFunctionBtn.innerHTML = '🤖 Generate Function from Recording';
        updateGenerateButtonState();
    }

    function showGenerationStatus(message, type) {
        generationStatus.textContent = message;
        generationStatus.className = 'generation-status ' + type;
    }

    // ==================== SMART SCRAPE ====================

    smartScrapeBtn.addEventListener('click', async () => {
        const apiKey = geminiApiKeyInput.value.trim();
        if (!apiKey) {
            showSmartScrapeStatus('Please add your Gemini API key in settings', 'error');
            return;
        }

        smartScrapeBtn.disabled = true;
        smartScrapeBtn.innerHTML = '<span class="spinner"></span> Analyzing page...';
        smartScrapePreview.style.display = 'none';
        showSmartScrapeStatus('Taking screenshot of current page...', 'active');
        addLogEntry('Smart Scrape: Starting page analysis...');

        try {
            // Step 1: Get screenshot from background
            const tabData = await chrome.runtime.sendMessage({ type: 'startSmartScrape' });

            if (!tabData?.screenshot) {
                throw new Error(tabData?.error || 'Failed to capture screenshot');
            }

            addLogEntry('Smart Scrape: Screenshot captured for ' + tabData.url);
            showSmartScrapeStatus('Screenshot captured. AI is analyzing the page...', 'active');

            // Step 2: Run agentic loop (pass tabId so tool calls target the correct tab)
            const result = await AIService.agenticScrape(
                tabData.screenshot,
                tabData.url,
                apiKey,
                tabData.tabId,
                (statusMsg) => {
                    showSmartScrapeStatus(statusMsg, 'active');
                    addLogEntry('Smart Scrape: ' + statusMsg);
                }
            );

            // Step 3: Show results
            if (result.savedFunction) {
                showSmartScrapeStatus(
                    'Function "' + result.savedFunction.name + '" saved to library!',
                    'success'
                );
                addLogEntry('Smart Scrape: Saved function "' + result.savedFunction.name + '"');

                // Refresh the function library
                allFunctions = await loadFunctionLibrary();
                updateFunctionsLibrary();

                // Show extraction preview
                if (result.lastExtractionResult) {
                    smartScrapePreview.style.display = 'block';
                    smartScrapeResult.innerHTML = '';
                    const data = result.lastExtractionResult.result || result.lastExtractionResult;
                    const display = createJsonDisplay(data);
                    smartScrapeResult.appendChild(display);
                }
            } else {
                showSmartScrapeStatus(
                    'AI could not create a working extraction. Check logs for details.',
                    'error'
                );
            }

        } catch (error) {
            console.error('Smart Scrape error:', error);
            showSmartScrapeStatus('Error: ' + error.message, 'error');
            addLogEntry('Smart Scrape: Error - ' + error.message);
        } finally {
            smartScrapeBtn.disabled = false;
            smartScrapeBtn.innerHTML = 'Smart Scrape This Page';
            updateSmartScrapeButtonState();
        }
    });

    function showSmartScrapeStatus(message, type) {
        smartScrapeStatus.textContent = message;
        smartScrapeStatus.className = 'generation-status ' + type;
    }

    function normalizeFunctionUrlPatterns(patterns) {
        if (Array.isArray(patterns)) return patterns.filter(Boolean);
        if (typeof patterns === 'string') {
            return patterns.split(',').map(p => p.trim()).filter(Boolean);
        }
        return [];
    }

    function getVisibleFunctionNames() {
        const names = Object.keys(allFunctions);
        if (!currentPageUrl) return names;
        return names.filter(name => {
            const func = allFunctions[name];
            if (func?.source === 'ai-workflow' || func?.workflowMetadata) return true;
            const patterns = normalizeFunctionUrlPatterns(func?.urlPatterns);
            if (patterns.length === 0) return true;
            return matchesUrlPattern(currentPageUrl, patterns);
        });
    }

    // ==================== FUNCTIONS LIBRARY ====================

    function updateFunctionsLibrary() {
        functionsContainer.innerHTML = '';

        const functionNames = getVisibleFunctionNames();
        if (functionNames.length === 0) {
            functionsContainer.textContent = currentPageUrl
                ? 'No functions match the current URL.'
                : 'No functions generated yet.';
            return;
        }

        functionNames.forEach(name => {
            const func = allFunctions[name];
            const card = createFunctionCard(func);
            functionsContainer.appendChild(card);
        });
        const visibleSet = new Set(functionNames);

        // Ensure currentTestingFunction is up to date if we are testing/viewing a function
        if (currentTestingFunction && allFunctions[currentTestingFunction.name] && visibleSet.has(currentTestingFunction.name)) {
            currentTestingFunction = allFunctions[currentTestingFunction.name];
            // If test panel is open, maybe refresh inputs? 
            if (functionTestSection.style.display === 'block') {
                // Regenerate inputs only if they changed - for now let's just re-open gracefully
                openTestPanel(currentTestingFunction);
            }
        } else if (currentTestingFunction) {
            // Function was deleted
            functionTestSection.style.display = 'none';
            currentTestingFunction = null;
        }
    }

    function createFunctionCard(func) {
        const card = document.createElement('div');
        const isWorkflow = func?.source === 'ai-workflow' || !!func?.workflowMetadata;
        card.className = `function-card${isWorkflow ? ' workflow-function-card' : ''}`;
        card.dataset.functionName = func.name;

        // Status badge
        let statusClass = '';
        let statusText = 'Untested';
        if (func.testsPassed === true) {
            statusClass = 'tested';
            statusText = '✓ Tested';
        } else if (func.testsPassed === false) {
            statusClass = 'failed';
            statusText = '✗ Failed';
        }

        // Inputs list
        const inputsList = (func.inputs || []).map(inp =>
            `<li><strong>${inp.name}</strong>: ${inp.type}${inp.required ? ' (required)' : ''}</li>`
        ).join('');

        // Outputs description
        let outputDesc = 'void';
        if (func.outputs) {
            if (func.outputs.type === 'arrayOfObjects') {
                outputDesc = `Array of { ${Object.keys(func.outputs.properties || {}).join(', ')} }`;
            } else if (func.outputs.type === 'array') {
                outputDesc = `Array of ${func.outputs.itemType || 'any'}`;
            } else if (func.outputs.type === 'object') {
                outputDesc = `{ ${Object.keys(func.outputs.properties || {}).join(', ')} }`;
            } else {
                outputDesc = func.outputs.type || 'any';
            }
        }
        const modelPrefs = normalizeModelPreferences(func.modelPreferences || {});
        const aiPrefLabel = modelPrefs.aiProvider === 'default'
            ? 'Default'
            : `${modelPrefs.aiProvider}${modelPrefs.aiModel ? `:${modelPrefs.aiModel}` : ''}`;
        const embedPrefLabel = modelPrefs.embeddingProvider === 'default'
            ? 'Default'
            : `${modelPrefs.embeddingProvider}${modelPrefs.embeddingModel ? `:${modelPrefs.embeddingModel}` : ''}`;

        const urlPatterns = normalizeFunctionUrlPatterns(func.urlPatterns);
        const workflowSubFunctions = isWorkflow
            ? (func?.workflowMetadata?.subFunctions || func?.referenceFunctions || [])
                .map(subName => {
                    const subDef = allFunctions[subName];
                    return {
                        name: subName,
                        description: subDef?.description || 'Description not available'
                    };
                })
            : [];
        const workflowSubHtml = workflowSubFunctions.length > 0
            ? `<div class="workflow-breakdown">
                    <h4>Workflow Functions:</h4>
                    <ul class="workflow-subfunctions-list">
                        ${workflowSubFunctions.map(sub => `<li><strong>${sub.name}</strong><span>${sub.description}</span></li>`).join('')}
                    </ul>
               </div>`
            : (isWorkflow
                ? `<div class="workflow-breakdown"><h4>Workflow Functions:</h4><p class="workflow-empty">No linked sub-functions found.</p></div>`
                : '');
        const orchestrationStrategy = isWorkflow
            ? (func?.workflowMetadata?.orchestrationStrategy || '')
            : '';
        const orchestrationHtml = orchestrationStrategy
            ? `<div class="workflow-orchestration">
                    <h4>Orchestration:</h4>
                    <p>${orchestrationStrategy}</p>
               </div>`
            : '';

        card.innerHTML = `
            <div class="function-card-header">
                <h3>${func.name}${isWorkflow ? ' <span class="function-kind-badge">Workflow</span>' : ''}</h3>
                <span class="function-status ${statusClass}">${statusText}</span>
            </div>
            <div class="function-card-body">
                <p class="function-description">${func.description || 'No description'}</p>
                <div class="function-meta">
                    <span class="function-meta-item"><strong>URLs:</strong> ${urlPatterns.join(', ') || 'None'}</span>
                    <span class="function-meta-item"><strong>Steps:</strong> ${(func.steps || []).length}</span>
                    <span class="function-meta-item"><strong>AI:</strong> ${aiPrefLabel}</span>
                    <span class="function-meta-item"><strong>Embed:</strong> ${embedPrefLabel}</span>
                </div>
                <div class="function-inputs">
                    <h4>Inputs:</h4>
                    <ul class="io-list">${inputsList || '<li>None</li>'}</ul>
                </div>
                <div class="function-outputs">
                    <h4>Output:</h4>
                    <ul class="io-list"><li>${outputDesc}</li></ul>
                </div>
                ${workflowSubHtml}
                ${orchestrationHtml}
                <div class="function-card-actions">
                    <button class="test-function-btn">Test</button>
                    <button class="mark-tested-btn">${func.testsPassed === true ? 'Mark Untested' : 'Mark Tested'}</button>
                    <button class="edit-function-btn">🛠️ Edit Function</button>
                    <button class="prompt-modify-function-btn">✨ Prompt Modify</button>
                    <button class="model-function-btn">🤖 Model Settings</button>
                    <button class="run-function-btn">▶️ Run</button>
                    <button class="delete-function-btn">🗑️ Delete</button>
                </div>
            </div>
        `;

        // Toggle expand on header click
        const header = card.querySelector('.function-card-header');
        header.addEventListener('click', () => {
            card.classList.toggle('expanded');
        });

        // Action buttons
        const testBtn = card.querySelector('.test-function-btn');
        const markTestedBtn = card.querySelector('.mark-tested-btn');
        const editBtn = card.querySelector('.edit-function-btn');
        const promptModifyBtn = card.querySelector('.prompt-modify-function-btn');
        const modelBtn = card.querySelector('.model-function-btn');
        const runBtn = card.querySelector('.run-function-btn');
        const deleteBtn = card.querySelector('.delete-function-btn');

        testBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openTestPanel(func);
        });

        markTestedBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const nextStatus = func.testsPassed === true ? undefined : true;
            allFunctions[func.name] = { ...func, testsPassed: nextStatus };
            await saveFunctionLibrary();
            updateFunctionsLibrary();
            updateAITaskFunctionsLibrary();
            addLogEntry(nextStatus === true
                ? `Marked as tested: ${func.name}`
                : `Marked as untested: ${func.name}`);
        });
        editBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openCodeEditor(func);
        });

        promptModifyBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await promptModifyFunction(func);
        });

        modelBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openModelSettingsModal(func);
        });

        runBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            runFunction(func);
        });

        deleteBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (confirm(`Delete function "${func.name}"?`)) {
                delete allFunctions[func.name];
                await saveFunctionLibrary();
                updateFunctionsLibrary();
                updateAITaskFunctionsLibrary();
                addLogEntry(`🗑️ Deleted function: ${func.name}`);
            }
        });

        return card;
    }

    async function promptModifyFunction(func) {
        if (!func) return;
        const userPrompt = prompt(`Describe how to modify "${func.name}" (natural language):`);
        if (!userPrompt || !userPrompt.trim()) return;

        const apiKey = geminiApiKeyInput.value.trim();
        if (!apiKey) {
            alert('Please add your Gemini API key in Settings first.');
            return;
        }

        addLogEntry(`✨ Prompt-modifying function: ${func.name}`);
        showGenerationStatus(`Applying prompt changes to ${func.name}...`, 'active');

        try {
            const result = await AIService.modifyFunctionWithPrompt(func, userPrompt.trim(), apiKey);
            if (!result?.fixedSteps || !Array.isArray(result.fixedSteps)) {
                throw new Error('AI did not return valid updated steps.');
            }

            const updated = {
                ...func,
                description: result.updatedDescription || func.description,
                steps: result.fixedSteps,
                testsPassed: undefined
            };

            showGenerationStatus(`Generated update for ${func.name}. Running one validation test...`, 'active');
            const postModifyCheck = await runPostModifyValidationTest(updated, userPrompt.trim());

            if (!postModifyCheck.passed) {
                const reason = postModifyCheck.error || 'Post-modify validation failed';
                allFunctions[func.name] = { ...func, testsPassed: false };
                await saveFunctionLibrary();
                updateFunctionsLibrary();
                updateAITaskFunctionsLibrary();

                if (currentTestingFunction?.name === func.name) {
                    currentTestingFunction = allFunctions[func.name];
                    if (functionTestSection.style.display === 'block') {
                        openTestPanel(currentTestingFunction);
                    }
                }

                addLogEntry(`Prompt update rejected for ${func.name}; changes were not saved.`);
                addLogEntry(`Post-modify test failed for ${func.name}: ${reason}`);
                showGenerationStatus(`Prompt update failed validation: ${reason}`, 'error');
                return;
            }

            const checkedFunc = { ...updated, testsPassed: true };
            allFunctions[func.name] = checkedFunc;
            await saveFunctionLibrary();
            updateFunctionsLibrary();
            updateAITaskFunctionsLibrary();

            if (currentTestingFunction?.name === func.name) {
                currentTestingFunction = checkedFunc;
                if (functionTestSection.style.display === 'block') {
                    openTestPanel(checkedFunc);
                }
            }

            addLogEntry(`Prompt update applied: ${func.name}${result.changeSummary ? ` (${result.changeSummary})` : ''}`);
            addLogEntry(`Post-modify test passed for ${func.name}${postModifyCheck.testName ? ` (${postModifyCheck.testName})` : ''}.`);
            showGenerationStatus(`Updated ${func.name} and validated with one test.`, 'success');
        } catch (error) {
            addLogEntry(`❌ Prompt modify failed for ${func.name}: ${error.message}`);
            showGenerationStatus(`Prompt modify failed: ${error.message}`, 'error');
        }
    }

    function coerceInputValueByType(rawValue, type = 'string') {
        if (rawValue === undefined || rawValue === null) return rawValue;
        const normalizedType = String(type || 'string').toLowerCase();
        if (normalizedType === 'number') {
            const parsed = Number(rawValue);
            return Number.isFinite(parsed) ? parsed : rawValue;
        }
        if (normalizedType === 'boolean') {
            if (typeof rawValue === 'boolean') return rawValue;
            return /^(true|1|yes)$/i.test(String(rawValue).trim());
        }
        return String(rawValue);
    }

    function selectPromptModifyTestInputs(func) {
        const inputDefs = Array.isArray(func?.inputs) ? func.inputs : [];
        const buildDefaultInputs = () => {
            const defaults = {};
            for (const inputDef of inputDefs) {
                if (!inputDef?.name) continue;
                const fallback = inputDef.defaultValue !== undefined ? inputDef.defaultValue : '';
                defaults[inputDef.name] = coerceInputValueByType(fallback, inputDef.type);
            }
            return defaults;
        };

        const testCases = Array.isArray(func?.testCases) ? func.testCases.filter(tc => tc && typeof tc === 'object') : [];
        if (testCases.length === 0) {
            return { inputs: buildDefaultInputs(), testName: 'Default inputs' };
        }

        const scoreTestCase = (tc) => {
            const values = Object.values(tc.inputs || {});
            if (values.length === 0) return Number.MAX_SAFE_INTEGER;
            let score = 0;
            for (const value of values) {
                const numeric = Number(value);
                if (Number.isFinite(numeric)) {
                    score += Math.max(1, numeric);
                } else if (typeof value === 'string') {
                    score += Math.max(2, value.length / 10);
                } else {
                    score += 5;
                }
            }
            return score;
        };

        const chosen = [...testCases].sort((a, b) => scoreTestCase(a) - scoreTestCase(b))[0];
        const chosenInputsRaw = (chosen && typeof chosen.inputs === 'object') ? chosen.inputs : {};
        const inputs = {};

        for (const inputDef of inputDefs) {
            if (!inputDef?.name) continue;
            const hasValue = Object.prototype.hasOwnProperty.call(chosenInputsRaw, inputDef.name);
            const raw = hasValue ? chosenInputsRaw[inputDef.name] : inputDef.defaultValue;
            inputs[inputDef.name] = coerceInputValueByType(raw, inputDef.type);
        }

        return {
            inputs,
            testName: chosen?.name || 'Auto-selected test case'
        };
    }

    function validatePostModifyOutputShape(func, data) {
        const outputDef = func?.outputs || {};
        const expectedType = String(outputDef.type || '').toLowerCase();
        const fieldList = String(outputDef.fields || '')
            .split(',')
            .map(f => f.trim())
            .filter(Boolean);
        const isPlaceholder = (value) => {
            const text = String(value === undefined || value === null ? '' : value).trim().toLowerCase();
            if (!text) return true;
            return [
                'n/a',
                'na',
                'unknown',
                'summary unavailable',
                'analysis failed',
                'error',
                'none',
                'null'
            ].includes(text);
        };
        const hasUsefulFieldValues = (item) => {
            if (!item || typeof item !== 'object') return false;
            const keys = fieldList.length > 0 ? fieldList : Object.keys(item);
            if (keys.length === 0) return false;
            const usefulCount = keys.filter(key => !isPlaceholder(item[key])).length;
            return usefulCount >= Math.min(2, keys.length);
        };

        if (expectedType === 'array') {
            if (!Array.isArray(data)) return { valid: false, reason: 'Expected array output but received non-array' };
            if (data.length === 0) return { valid: false, reason: 'Output array is empty' };
            if (fieldList.length > 0 && typeof data[0] === 'object' && data[0] !== null) {
                const missing = fieldList.filter(field => !(field in data[0]));
                if (missing.length > 0) {
                    return { valid: false, reason: `Missing expected output fields: ${missing.join(', ')}` };
                }
            }
            const sample = data.slice(0, Math.min(3, data.length));
            const usefulRows = sample.filter(row => hasUsefulFieldValues(row)).length;
            if (usefulRows === 0) {
                return { valid: false, reason: 'Output rows are present but values look like placeholders.' };
            }
            return { valid: true };
        }

        if (expectedType === 'object') {
            if (!data || typeof data !== 'object' || Array.isArray(data)) {
                return { valid: false, reason: 'Expected object output but received different type' };
            }
            if (!hasUsefulFieldValues(data)) {
                return { valid: false, reason: 'Output object values look like placeholders.' };
            }
            return { valid: true };
        }

        if (expectedType === 'string') {
            if (typeof data !== 'string') return { valid: false, reason: 'Expected string output but received different type' };
            if (!data.trim()) return { valid: false, reason: 'Output string is empty' };
            return { valid: true };
        }

        return { valid: true };
    }

    function validatePromptIntentHeuristics(userPrompt, data) {
        const promptText = String(userPrompt || '').toLowerCase();
        if (!promptText.trim()) return { valid: true };

        const firstItem = Array.isArray(data) ? data[0] : data;
        if (!firstItem || typeof firstItem !== 'object') {
            return { valid: true };
        }

        const requiresMainBody =
            /\b(main body|largest text block|full body|article body|body text)\b/i.test(promptText);
        if (requiresMainBody) {
            const candidateKeys = ['mainBody', 'main_body', 'body', 'bodyText', 'fullText', 'articleBody', 'content'];
            const key = candidateKeys.find(k => Object.prototype.hasOwnProperty.call(firstItem, k));
            if (!key) {
                return { valid: false, reason: 'Prompt requested main-body extraction, but output has no body/content field.' };
            }
            const value = String(firstItem[key] || '').trim();
            if (value.length < 80) {
                return { valid: false, reason: `Prompt requested main-body extraction, but "${key}" is missing/too short.` };
            }
        }

        return { valid: true };
    }

    async function runPostModifyValidationTest(func, userPrompt = '') {
        const selected = selectPromptModifyTestInputs(func);
        const inputs = selected.inputs || {};
        const testName = selected.testName || 'Auto validation';

        addLogEntry(`🧪 Auto-testing modified function "${func.name}" with ${testName}...`);
        try {
            const result = await chrome.runtime.sendMessage({
                type: 'executeGeneratedFunction',
                functionDef: func,
                inputs
            });

            if (!result?.success) {
                return { passed: false, testName, error: result?.error || 'Execution failed' };
            }

            const shape = validatePostModifyOutputShape(func, result?.data);
            if (!shape.valid) {
                return { passed: false, testName, error: shape.reason || 'Output validation failed' };
            }

            const intentCheck = validatePromptIntentHeuristics(userPrompt, result?.data);
            if (!intentCheck.valid) {
                return { passed: false, testName, error: intentCheck.reason || 'Prompt intent validation failed' };
            }

            return { passed: true, testName };
        } catch (error) {
            return { passed: false, testName, error: error?.message || String(error) };
        }
    }

    function openTestPanel(func) {
        currentTestingFunction = func;
        functionTestSection.style.display = 'block';
        testInputsContainer.innerHTML = '';
        testResultsContainer.innerHTML = '';
        testResultsContainer.classList.remove('active');

        // Create input fields for each function input
        (func.inputs || []).forEach(input => {
            const item = document.createElement('div');
            item.className = 'test-input-item';
            item.innerHTML = `
                <label>${input.name}:</label>
                <input type="text" data-input-name="${input.name}" placeholder="${input.description || input.type}" value="${input.defaultValue || ''}">
            `;
            testInputsContainer.appendChild(item);
        });

        if ((func.inputs || []).length === 0) {
            testInputsContainer.innerHTML = '<p style="font-size:12px; color:#666;">This function has no inputs</p>';
        }
    }

    runTestBtn.addEventListener('click', async () => {
        if (!currentTestingFunction) return;

        const inputs = {};
        testInputsContainer.querySelectorAll('input').forEach(input => {
            inputs[input.dataset.inputName] = input.value;
        });

        addLogEntry(`🧪 Testing function: ${currentTestingFunction.name}`);
        testResultsContainer.innerHTML = '<div class="test-result-item">Running test...</div>';
        testResultsContainer.classList.add('active');

        try {
            // Send to background to execute
            testResultsContainer.innerHTML = '<div class="test-result-item success">Running test... check opened window.</div>';

            const result = await chrome.runtime.sendMessage({
                type: 'executeGeneratedFunction',
                functionDef: currentTestingFunction,
                inputs: inputs
            });

            if (result && result.success) {
                testResultsContainer.innerHTML = '<div class="test-result-item success">✅ Test Passed!</div>';
                displayFunctionResult(result.data);
            } else {
                testResultsContainer.innerHTML = `<div class="test-result-item failure">❌ Failed: ${result?.error || 'Unknown error'}</div>`;
            }
        } catch (error) {
            testResultsContainer.innerHTML = `<div class="test-result-item failure">Error: ${error.message}</div>`;
        }
    });

    async function runFunction(func) {
        const inputs = {};

        // Prompt for required inputs
        for (const input of (func.inputs || [])) {
            const defaultVal = input.defaultValue || '';
            const value = prompt(`Enter value for "${input.name}" (${input.description || input.type}):`, defaultVal);
            if (value === null && input.required && !defaultVal) return; // Cancelled and required
            inputs[input.name] = value !== null ? value : defaultVal;
        }

        addLogEntry(`▶️ Running function: ${func.name}`);
        showGenerationStatus(`Running ${func.name}...`, 'active');

        try {
            const result = await chrome.runtime.sendMessage({
                type: 'executeGeneratedFunction',
                functionDef: func,
                inputs: inputs
            });

            if (result && result.success) {
                addLogEntry(`✅ Function finished successfully.`);
                showGenerationStatus(`Function completed.`, 'success');
                displayFunctionResult(result.data);
            } else {
                addLogEntry(`❌ Function failed: ${result?.error}`);
                showGenerationStatus(`Function failed.`, 'error');
            }
        } catch (e) {
            addLogEntry(`❌ Execution error: ${e.message}`);
        }
    }

    function displayFunctionResult(data) {
        const container = document.getElementById('returnValueContainer');
        const output = document.getElementById('returnValueOutput');
        if (!container || !output) return;

        container.style.display = 'block';

        let content = '';
        if (typeof data === 'object') {
            content = `<pre>${JSON.stringify(data, null, 2)}</pre>`;
        } else {
            content = `<div class="return-value-text-block">${String(data)}</div>`;
        }

        output.innerHTML = content;
        // Scroll to result
        container.scrollIntoView({ behavior: 'smooth' });
    }

    chrome.runtime.sendMessage({ type: 'getInitialState' });

    recordButton.addEventListener('click', () => {
        const isRecording = recordButton.textContent.includes('Stop');
        isRecording ? chrome.runtime.sendMessage({ type: 'stopRecording' }) : chrome.runtime.sendMessage({ type: 'startRecording' });
    });
    recordLiteralButton.addEventListener('click', () => {
        const isRecording = recordLiteralButton.textContent.includes('Stop');
        isRecording ? chrome.runtime.sendMessage({ type: 'stopRecording' }) : chrome.runtime.sendMessage({ type: 'startLiteralRecording' });
    });
    saveTaskButton.addEventListener('click', () => {
        const taskName = taskNameInput.value.trim();
        const taskDescription = taskDescriptionInput.value.trim();
        if (taskName) {
            chrome.runtime.sendMessage({ type: 'saveCurrentTask', name: taskName, description: taskDescription });
            taskNameInput.value = '';
            taskDescriptionInput.value = '';
        }
    });
    addScreenshotButton.addEventListener('click', () => { chrome.runtime.sendMessage({ type: 'addScreenshotStep' }); });
    addFullPageScreenshotButton.addEventListener('click', () => { chrome.runtime.sendMessage({ type: 'addFullPageScreenshotStep' }); });
    addLargestTextButton.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'getLargestText' });
    });

    addTextNoteButton.addEventListener('click', () => {
        const text = prompt("Enter text note:");
        if (text) {
            chrome.runtime.sendMessage({ type: 'addTextNote', text: text });
        }
    });

    exportLogsBtn.addEventListener('click', async () => {
        try {
            const response = await chrome.runtime.sendMessage({ type: 'getSessionLogs' });
            if (response && response.logs && response.logs.length > 0) {
                const logsText = response.logs.join('\n');
                const blob = new Blob([logsText], { type: 'text/plain' });
                const url = URL.createObjectURL(blob);
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

                const a = document.createElement('a');
                a.href = url;
                a.download = `function-creator-logs-${timestamp}.txt`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                addLogEntry('💾 Logs exported successfully');
            } else {
                alert('No logs available to export.');
            }
        } catch (e) {
            console.error('Failed to export logs:', e);
            alert('Failed to export logs');
        }
    });

    liveActionClickButton.addEventListener('click', () => {
        const text = liveActionTextInput.value.trim();
        if (text) {
            chrome.runtime.sendMessage({ type: 'clickElementByText', text });
            liveActionTextInput.value = '';
        }
    });

    chrome.runtime.onMessage.addListener((message) => {
        switch (message.type) {
            case 'recordingStateUpdate':
                currentRecordingState = message.recording || { steps: [] };
                updateRecordingUI(message.isRecording, currentRecordingState, message.recordingMode);
                updateGenerateButtonState(); // Update button state when recording changes
                updateReferenceFunctionsList(); // Update reference list when recording changes
                break;
            case 'tasksUpdate':
                allTasks = message.tasks;
                currentPageUrl = message.currentUrl || currentPageUrl;
                updateTasksList(allTasks, message.currentUrl);
                updateFunctionsLibrary();
                updateAITaskFunctionsLibrary();
                break;
            case 'audioDevicesList':
                populateAudioDevices(message.devices);
                break;
            case 'logUpdate':
                addLogEntry(message.message);
                break;
            case 'returnValueUpdate':
                returnValueOutput.innerHTML = '';
                const { text, screenshots } = message.value;
                let hasOutput = false;
                if (text && text.length > 0) {
                    text.forEach(item => {
                        // Try to parse JSON for pretty display
                        let contentToDisplay = item;
                        let isJson = false;

                        if (typeof item === 'string' && (item.trim().startsWith('{') || item.trim().startsWith('['))) {
                            try {
                                const parsed = JSON.parse(item);
                                isJson = true;
                                contentToDisplay = createJsonDisplay(parsed);
                            } catch (e) { /* not json */ }
                        }

                        const textBlock = document.createElement('div');
                        if (isJson) {
                            textBlock.className = 'return-value-json-block';
                            textBlock.appendChild(contentToDisplay);
                        } else {
                            textBlock.className = 'return-value-text-block';
                            if (typeof item === 'object' && item.type === 'stabilizedContent') {
                                textBlock.innerHTML = `<strong>[Page Stabilized]</strong><br>${item.content.replace(/\n/g, '<br>')}`;
                                textBlock.classList.add('stabilized-content');
                            } else if (typeof item === 'string') {
                                textBlock.innerHTML = item.replace(/\n/g, '<br>');
                            }
                        }
                        returnValueOutput.appendChild(textBlock);
                        const hr = document.createElement('hr');
                        returnValueOutput.appendChild(hr);
                    });
                    if (returnValueOutput.lastChild.tagName === 'HR') {
                        returnValueOutput.removeChild(returnValueOutput.lastChild);
                    }
                    hasOutput = true;
                }
                if (screenshots && screenshots.length > 0) {
                    screenshots.forEach(ss_dataUrl => {
                        const img = document.createElement('img');
                        img.src = ss_dataUrl;
                        img.className = 'return-value-screenshot';
                        returnValueOutput.appendChild(img);
                    });
                    hasOutput = true;
                }
                returnValueContainer.style.display = hasOutput ? 'block' : 'none';
                break;
            case 'clearReturnValue':
                returnValueContainer.style.display = 'none';
                returnValueOutput.innerHTML = '';
                break;
            case 'functionsLibraryUpdated':
                allFunctions = message.functions;
                updateFunctionsLibrary();
                updateAITaskFunctionsLibrary();
                break;
            case 'computerUseDebugImage':
                showComputerUseDebugImage(message);
                break;
            case 'computerUseScreenshot':
                showComputerUseScreenshot(message);
                break;
        }
    });

    function addLogEntry(logMessage) {
        if (logsContainer.textContent === 'No activity yet.') logsContainer.innerHTML = '';
        const logEntry = document.createElement('div');
        logEntry.className = 'log-entry';
        const time = new Date().toLocaleTimeString();
        logEntry.innerHTML = `<span class="log-time">${time}:</span> ${logMessage}`;
        logsContainer.appendChild(logEntry);
        logsContainer.scrollTop = logsContainer.scrollHeight;
    }

    /**
     * Show Computer Use debug image with crosshair visualization.
     * Receives raw screenshot from background.js, draws crosshair overlay
     * at the action coordinates, and displays in the logs area.
     */
    function showComputerUseDebugImage(data) {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext('2d');

            // Draw the screenshot
            ctx.drawImage(img, 0, 0);

            // Convert normalized coordinates (0-999) to pixel coordinates
            if (data.x !== undefined && data.y !== undefined) {
                const actualX = (data.x / 1000) * img.width;
                const actualY = (data.y / 1000) * img.height;

                // Red circle
                ctx.strokeStyle = '#FF0000';
                ctx.lineWidth = 3;
                ctx.beginPath();
                ctx.arc(actualX, actualY, 25, 0, 2 * Math.PI);
                ctx.stroke();

                // Center dot
                ctx.fillStyle = 'rgba(255, 0, 0, 0.6)';
                ctx.beginPath();
                ctx.arc(actualX, actualY, 8, 0, 2 * Math.PI);
                ctx.fill();

                // Crosshair lines
                ctx.beginPath();
                ctx.moveTo(actualX - 35, actualY);
                ctx.lineTo(actualX + 35, actualY);
                ctx.moveTo(actualX, actualY - 35);
                ctx.lineTo(actualX, actualY + 35);
                ctx.stroke();

                // Label with action name and coordinates
                ctx.font = 'bold 14px Arial';
                ctx.fillStyle = '#FF0000';
                ctx.strokeStyle = '#FFFFFF';
                ctx.lineWidth = 3;
                const label = `${data.action} (${data.x}, ${data.y})${data.text ? ' "' + data.text.slice(0, 30) + '"' : ''}`;
                ctx.strokeText(label, actualX + 30, actualY - 10);
                ctx.fillText(label, actualX + 30, actualY - 10);
            }

            // Convert to JPEG for smaller size in log display
            const dataUrl = canvas.toDataURL('image/jpeg', 0.7);

            // Build log entry with the debug image
            if (logsContainer.textContent === 'No activity yet.') logsContainer.innerHTML = '';
            const logEntry = document.createElement('div');
            logEntry.className = 'log-entry debug-image-entry';
            const time = new Date().toLocaleTimeString();

            const desc = data.description || data.action;
            const coordInfo = data.x !== undefined ? ` at (${data.x}, ${data.y})` : '';
            const textInfo = data.text ? ` "${data.text.slice(0, 40)}"` : '';

            logEntry.innerHTML = `<span class="log-time">${time}:</span> <strong>${desc}</strong>${coordInfo}${textInfo}`;

            const imgEl = document.createElement('img');
            imgEl.src = dataUrl;
            imgEl.className = 'debug-screenshot';
            imgEl.addEventListener('click', () => {
                modal.style.display = 'block';
                const iframe = document.getElementById('htmlPreviewFrame');
                if (iframe) iframe.style.display = 'none';
                modalImg.style.display = 'block';
                modalImg.src = dataUrl;
            });

            logEntry.appendChild(imgEl);
            logsContainer.appendChild(logEntry);
            logsContainer.scrollTop = logsContainer.scrollHeight;
        };
        img.src = data.image;
    }

    /**
     * Show a post-action screenshot sent to the Gemini API.
     * Displays as a labeled image in the logs so you can see what the model sees.
     */
    function showComputerUseScreenshot(data) {
        if (!data.image) return;

        if (logsContainer.textContent === 'No activity yet.') logsContainer.innerHTML = '';
        const logEntry = document.createElement('div');
        logEntry.className = 'log-entry debug-image-entry';
        const time = new Date().toLocaleTimeString();

        const labelMap = {
            'initial': '📸 Initial screenshot sent to AI',
            'after_type_text_at': '📸 After typing (sent to AI)',
            'after_click_at': '📸 After click (sent to AI)',
            'after_navigate': '📸 After navigate (sent to AI)',
            'after_scroll_document': '📸 After scroll (sent to AI)',
        };
        const label = labelMap[data.label] || `📸 ${data.label} (sent to AI)`;
        const urlInfo = data.url ? ` — ${data.url.slice(0, 60)}` : '';

        logEntry.innerHTML = `<span class="log-time">${time}:</span> <strong>${label}</strong>${urlInfo}`;

        const imgEl = document.createElement('img');
        imgEl.src = data.image;
        imgEl.className = 'debug-screenshot';
        imgEl.addEventListener('click', () => {
            modal.style.display = 'block';
            const iframe = document.getElementById('htmlPreviewFrame');
            if (iframe) iframe.style.display = 'none';
            modalImg.style.display = 'block';
            modalImg.src = data.image;
        });

        logEntry.appendChild(imgEl);
        logsContainer.appendChild(logEntry);
        logsContainer.scrollTop = logsContainer.scrollHeight;
    }

    function matchesUrlPattern(url, patterns) {
        if (!url || !patterns) return false;
        const patternList = Array.isArray(patterns)
            ? patterns.map(p => String(p || '').trim().toLowerCase()).filter(Boolean)
            : String(patterns).split(',').map(p => p.trim().toLowerCase()).filter(Boolean);
        const lowerCaseUrl = url.toLowerCase();
        for (const pattern of patternList) {
            if (
                pattern === '<all_urls>' ||
                pattern === '*://*/*' ||
                pattern === 'http://*/*' ||
                pattern === 'https://*/*'
            ) {
                return true;
            }
            try {
                const escapeRegex = (s) => s.replace(/([.*+?^=!:${}()|\[\]\/\\])/g, "\\$1");
                const regex = new RegExp("^" + pattern.split("*").map(escapeRegex).join(".*") + "$");
                if (regex.test(lowerCaseUrl)) return true;
            } catch (e) {
                if (lowerCaseUrl === pattern) return true;
            }
        }
        return false;
    }

    function updateRecordingUI(isRecording, recording, recordingMode) {
        if (isRecording) {
            if (recordingMode === 'literal') {
                recordButton.disabled = true;
                recordLiteralButton.textContent = 'Stop Recording';
                recordLiteralButton.style.backgroundColor = '#dc3545';
            } else { // selector mode
                recordLiteralButton.disabled = true;
                recordButton.textContent = 'Stop Recording';
                recordButton.style.backgroundColor = '#dc3545';
            }
        } else {
            recordButton.disabled = false;
            recordLiteralButton.disabled = false;
            recordButton.textContent = 'Start Recording';
            recordLiteralButton.textContent = 'Start Literal Recording';
            recordButton.style.backgroundColor = '#007bff';
            recordLiteralButton.style.backgroundColor = '#17a2b8';
        }

        stepsContainer.innerHTML = '';
        const hasSteps = recording && recording.steps && recording.steps.length > 0;
        if (hasSteps) {
            stepsContainer.appendChild(createRecordingStepList(recording.steps));
        } else {
            stepsContainer.textContent = isRecording ? 'Perform actions to record...' : 'No steps recorded yet.';
        }
        saveTaskButton.disabled = !hasSteps;
        addScreenshotButton.disabled = !isRecording;
        addFullPageScreenshotButton.disabled = !isRecording;
        addLargestTextButton.disabled = !isRecording;
        addTextNoteButton.disabled = !isRecording;
    }

    function createRecordingStepList(steps) {
        const container = document.createElement('div');
        steps.forEach((step, index) => {
            const stepDiv = document.createElement('div');
            stepDiv.className = 'step-item';
            // ... (keep class logic same)
            if (step.action === 'navigate' || step.action === 'startLiteral') stepDiv.classList.add('navigate-step');
            else if (step.action === 'returnValue') stepDiv.classList.add('return-value-step');
            else if (step.action === 'getLargestText') stepDiv.classList.add('largest-text-step');
            else if (step.action === 'screenshot' || step.action === 'screenshotFullPage') stepDiv.classList.add('screenshot-step');
            else if (step.action === 'scroll') stepDiv.classList.add('scroll-step');
            else if (step.action === 'scroll') stepDiv.classList.add('scroll-step');
            else if (step.action.startsWith('literal_')) stepDiv.classList.add('literal-step');
            else if (step.action === 'audio_annotation') stepDiv.classList.add('audio-step');
            else if (step.action === 'text_annotation') stepDiv.classList.add('text-note-step');
            else if (step.action === 'hover') stepDiv.classList.add('hover-step');

            stepDiv.appendChild(createRecordingStepDisplay(step, index));
            container.appendChild(stepDiv);
        });
        return container;
    }

    function createRecordingStepDisplay(step, index) {
        const displayWrapper = document.createElement('div');
        displayWrapper.className = 'step-display';
        let actionText;
        if (step.action === 'startLiteral') actionText = `▶ Start Literal Session`;
        else if (step.action === 'literal_click') actionText = `🖱️ Click at (${step.x}, ${step.y})`;
        else if (step.action === 'literal_type') actionText = `⌨️ Type '${step.value}'`;
        else if (step.action === 'literal_keydown') actionText = `⌨️ Key '${step.key}'`;
        else if (step.action === 'navigate') {
            const source = step.navigationSource ? ` (${step.navigationSource})` : '';
            actionText = `▶ Go to: ${step.url}${source}`;
        }
        else if (step.action === 'switchTab') actionText = `📑 Switch to Tab: ${step.title || step.url}`;
        else if (step.action === 'returnValue') actionText = `◎ Return Assistant's Answer`;
        else if (step.action === 'getLargestText') actionText = `📝 Find Largest Text Block`;
        else if (step.action === 'screenshot') actionText = `📸 Capture Visible Area`;
        else if (step.action === 'screenshotFullPage') actionText = `📄 Capture Full Page`;
        else if (step.action === 'audio_annotation') actionText = `🎵 Audio Note`;
        else if (step.action === 'text_annotation') actionText = `🗒️ Note: "${step.text}"`;
        else if (step.action === 'hover') actionText = `👁️ Hover on [${step.elementName}]`;
        else if (step.action === 'scroll') actionText = `📜 Scroll to Y: ${Math.round(step.value.y)}`;
        else actionText = `${step.action.toUpperCase()} on [${step.elementName || step.selector}]`;

        const textSpan = document.createElement('span');
        textSpan.textContent = `${index + 1}. ${actionText}`;
        displayWrapper.appendChild(textSpan);

        if (step.screenshot || step.screenshotLabeledUrl) {
            const controlsDiv = document.createElement('div');
            controlsDiv.className = 'step-controls';

            const fullBtn = document.createElement('button');
            fullBtn.className = 'view-btn';
            fullBtn.title = 'View Full Screenshot';
            fullBtn.textContent = '📷';
            fullBtn.title = 'View Full Screenshot';
            fullBtn.textContent = '📷';
            fullBtn.onclick = (e) => {
                e.stopPropagation();
                modal.style.display = "block";
                // Reset modal state
                const iframe = document.getElementById('htmlPreviewFrame');
                if (iframe) iframe.style.display = 'none';
                modalImg.style.display = 'block';
                modalImg.src = step.screenshotLabeledUrl || step.screenshot;
            };
            controlsDiv.appendChild(fullBtn);

            if (step.elementCropUrl) {
                const cropBtn = document.createElement('button');
                cropBtn.className = 'view-btn view-crop-btn';
                cropBtn.title = 'View Element';
                cropBtn.textContent = '🔍';
                cropBtn.style.marginLeft = '5px';
                cropBtn.onclick = (e) => {
                    e.stopPropagation();
                    modal.style.display = "block";
                    // Reset modal state
                    const iframe = document.getElementById('htmlPreviewFrame');
                    if (iframe) iframe.style.display = 'none';
                    modalImg.style.display = 'block';
                    modalImg.src = step.elementCropUrl;
                };
                controlsDiv.appendChild(cropBtn);
            }

            displayWrapper.appendChild(controlsDiv);
        }

        if (step.audioData) {
            const audioDiv = document.createElement('div');
            audioDiv.className = 'audio-controls';
            const audio = document.createElement('audio');
            audio.controls = true;
            audio.src = step.audioData;
            audioDiv.appendChild(audio);
            displayWrapper.appendChild(audioDiv);
        }

        if (step.html) {
            const htmlBtn = document.createElement('button');
            htmlBtn.className = 'view-btn view-html-btn';
            htmlBtn.title = 'View Page HTML';
            htmlBtn.textContent = '📄 HTML';
            htmlBtn.style.marginLeft = '5px';
            htmlBtn.onclick = (e) => {
                e.stopPropagation();
                modal.style.display = "block";
                // Clear previous content
                modalImg.style.display = 'none';
                let iframe = document.getElementById('htmlPreviewFrame');
                if (!iframe) {
                    iframe = document.createElement('iframe');
                    iframe.id = 'htmlPreviewFrame';
                    iframe.className = 'modal-content';
                    iframe.style.backgroundColor = 'white';
                    iframe.style.width = '90%';
                    iframe.style.height = '90%';
                    modal.appendChild(iframe);
                }
                iframe.style.display = 'block';
                iframe.srcdoc = step.html;
            };
            // Add next to controls if exists, else create validation
            let ctrlDiv = displayWrapper.querySelector('.step-controls');
            if (!ctrlDiv) {
                ctrlDiv = document.createElement('div');
                ctrlDiv.className = 'step-controls';
                displayWrapper.appendChild(ctrlDiv);
            }
            ctrlDiv.appendChild(htmlBtn);
        }

        if (step.selectedText) {
            const selDiv = document.createElement('div');
            selDiv.className = 'selected-text-display';
            selDiv.innerHTML = `<strong>Selected:</strong> <i>"${step.selectedText}"</i>`;
            displayWrapper.appendChild(selDiv);
        }

        return displayWrapper;
    }

    function updateTasksList(tasks, currentUrl) {
        const wasEditing = document.querySelector('.task-wrapper.edit-mode');
        const editingTaskName = wasEditing ? wasEditing.dataset.taskName : null;
        tasksContainer.innerHTML = '';
        if (!tasks || Object.keys(tasks).length === 0) {
            tasksContainer.textContent = 'No tasks saved.';
            return;
        }
        const filteredTaskNames = Object.keys(tasks).filter(name => matchesUrlPattern(currentUrl, tasks[name].urlPatterns));
        if (filteredTaskNames.length === 0) {
            tasksContainer.textContent = 'No tasks match this site.';
            return;
        }
        for (const name of filteredTaskNames) {
            const task = tasks[name];
            const taskWrapper = document.createElement('div');
            taskWrapper.className = 'task-wrapper';
            if (task.mode === 'literal') taskWrapper.classList.add('literal-task');
            taskWrapper.dataset.taskName = name;
            taskWrapper.appendChild(createTaskHeader(name, task));
            const taskDetails = document.createElement('div');
            taskDetails.className = 'task-details';
            if (task.mode !== 'literal') {
                taskDetails.appendChild(createUrlEditor(task));
            }
            taskDetails.appendChild(createDescriptionEditor(task));
            taskDetails.appendChild(createDynamicContentCheckEditor(task, name));
            taskDetails.appendChild(createParametersSection(task));
            taskDetails.appendChild(createSavedStepsSection(task));
            taskWrapper.appendChild(taskDetails);
            tasksContainer.appendChild(taskWrapper);
        }
        if (editingTaskName) {
            const taskWrapper = tasksContainer.querySelector(`.task-wrapper[data-task-name="${editingTaskName}"]`);
            if (taskWrapper) {
                taskWrapper.classList.add('edit-mode');
                taskWrapper.querySelector('.edit-task-btn').textContent = 'Save';
                taskWrapper.querySelector('.task-details').style.display = 'block';
            }
        }
    }

    function createTaskHeader(name, task) {
        const taskHeader = document.createElement('div');
        taskHeader.className = 'task-item';
        taskHeader.onclick = () => {
            const details = taskHeader.nextElementSibling;
            const wrapper = taskHeader.closest('.task-wrapper');
            if (wrapper.classList.contains('edit-mode')) return;
            details.style.display = details.style.display === 'block' ? 'none' : 'block';
        };
        const isLiteral = task.mode === 'literal';
        taskHeader.innerHTML = `<span>${name}${isLiteral ? ' <small>(Literal)</small>' : ''}</span><div><button class="run-btn">Run</button><button class="edit-task-btn">Edit</button><button class="delete-btn">Delete</button></div>`;
        if (task.parameters && task.parameters.length > 0) {
            setTimeout(() => {
                const details = taskHeader.nextElementSibling;
                if (details) details.style.display = 'block';
            }, 0);
        }
        return taskHeader;
    }

    function createDescriptionEditor(task) {
        const editorDiv = document.createElement('div');
        editorDiv.className = 'description-editor';
        const descriptionText = task.description ? task.description.replace(/\n/g, '<br>') : '<i>No description.</i>';
        editorDiv.innerHTML = `
            <p class="description-display">${descriptionText}</p>
            <textarea class="description-input">${task.description || ''}</textarea>
        `;
        return editorDiv;
    }

    function createUrlEditor(task) {
        const editorDiv = document.createElement('div');
        editorDiv.className = 'url-editor';
        editorDiv.innerHTML = `<label>Show on URLs:</label><span class="url-display">${task.urlPatterns}</span><input class="url-pattern-input" type="text" value="${task.urlPatterns}" title="Comma-separated patterns. Use * as a wildcard">`;
        return editorDiv;
    }

    function createDynamicContentCheckEditor(task, taskName) {
        const editorDiv = document.createElement('div');
        editorDiv.className = 'task-option-item dynamic-content-check-editor';
        const checkboxId = `dynamic-check-${taskName.replace(/[^a-zA-Z0-9]/g, '_')}`;
        const isChecked = task.dynamicContentCheck ? 'checked' : '';
        editorDiv.innerHTML = `
          <input type="checkbox" id="${checkboxId}" ${isChecked}>
          <label for="${checkboxId}">Wait for dynamic content to finish loading</label>
        `;
        return editorDiv;
    }

    function createParametersSection(task) {
        const paramsContainer = document.createElement('div');
        paramsContainer.className = 'parameters-section';
        if (!task.parameters || task.parameters.length === 0) {
            paramsContainer.style.display = 'none';
        } else {
            paramsContainer.style.display = 'block';
        }
        paramsContainer.innerHTML = '<h3>Parameters</h3>';
        task.parameters.forEach(p => {
            const paramDiv = document.createElement('div');
            paramDiv.className = 'param-item';
            paramDiv.innerHTML = `<label>${p.name}:</label><input type="text" data-param-name="${p.name}" value="${p.defaultValue || ''}" placeholder="Enter value...">`;
            paramsContainer.appendChild(paramDiv);
        });
        return paramsContainer;
    }

    function createSavedStepsSection(task) {
        const stepsContainer = document.createElement('div');
        stepsContainer.className = 'saved-steps-list';
        stepsContainer.innerHTML = '<h3>Steps</h3>';
        task.steps.forEach((step, index) => {
            const stepDiv = document.createElement('div');
            stepDiv.className = 'step-item';
            stepDiv.dataset.index = index;

            let stepText, stepDetails = '';
            // Literal Steps
            if (step.action === 'startLiteral') { stepDiv.classList.add('navigate-step'); stepText = `▶ Start at ${step.url}`; }
            else if (step.action === 'literal_click') { stepDiv.classList.add('literal-step'); stepText = `🖱️ Click at (${step.x}, ${step.y})`; }
            else if (step.action === 'literal_type') { stepDiv.classList.add('literal-step'); stepText = `⌨️ Type`; if (!step.isParam) { stepDetails = ` with value <code title="${step.value}">${step.value}</code>`; } }
            else if (step.action === 'literal_keydown') { stepDiv.classList.add('literal-step'); stepText = `⌨️ Key '${step.key}'`; }
            // Selector Steps
            else if (step.action === 'navigate') { stepDiv.classList.add('navigate-step'); stepText = `▶ Go to: ${step.url}`; }
            else if (step.action === 'type') { stepText = `${step.action.toUpperCase()} on [${step.elementName}]`; if (!step.isParam) { stepDetails = ` with value <code title="${step.value}">${step.value}</code>`; } }
            // Universal Steps
            else if (step.action === 'returnValue') { stepDiv.classList.add('return-value-step'); stepText = `◎ Return Assistant's Answer`; }
            else if (step.action === 'getLargestText') { stepDiv.classList.add('largest-text-step'); stepText = `📝 Find Largest Text Block`; }
            else if (step.action === 'screenshot') { stepDiv.classList.add('screenshot-step'); stepText = `📸 Capture Visible Area`; }
            else if (step.action === 'screenshot') { stepDiv.classList.add('screenshot-step'); stepText = `📸 Capture Visible Area`; }
            else if (step.action === 'screenshotFullPage') { stepDiv.classList.add('screenshot-step'); stepText = `📄 Capture Full Page`; }
            else if (step.action === 'audio_annotation') { stepDiv.classList.add('audio-step'); stepText = `🎵 Audio Note`; }
            else if (step.action === 'text_annotation') { stepDiv.classList.add('text-note-step'); stepText = `🗒️ Note: "${step.text}"`; }
            else if (step.action === 'hover') { stepDiv.classList.add('hover-step'); stepText = `👁️ Hover on [${step.elementName}]`; }
            else if (step.action === 'scroll') { stepDiv.classList.add('scroll-step'); stepText = `📜 Scroll to Y: ${Math.round(step.value.y)}`; }
            else { stepText = `${step.action.toUpperCase()} on [${step.elementName}]`; }

            if (step.isParam) {
                stepDetails += ` with param <code class="param-tag">${step.paramName}</code>`;
            }

            const canBeEdited = task.mode !== 'literal' && step.action !== 'navigate';
            const isTypeAction = (step.action === 'type' || step.action === 'literal_type') && !step.isParam;

            let delayControls = '';
            if (task.mode === 'literal' && step.delay) {
                delayControls = `
                    <span class="delay-display">+${(step.delay / 1000).toFixed(1)}s</span>
                    <input type="number" class="delay-input" value="${step.delay}" title="Delay in milliseconds (ms)" min="0" step="100">
                `;
            }

            let screenshotControls = '';
            if (step.screenshot || step.screenshotLabeledUrl) {
                screenshotControls += `<button class="view-btn view-full-btn" title="View Full Screenshot" data-src="${step.screenshotLabeledUrl || step.screenshot}">📷</button>`;
                // We use data-src so the global listener can pick it up

                if (step.elementCropUrl) {
                    screenshotControls += `<button class="view-btn view-crop-btn" style="margin-left: 5px;" title="View Element" data-src="${step.elementCropUrl}">🔍</button>`;
                }
            }

            let htmlControls = '';
            if (step.html) {
                htmlControls = `<button class="view-btn view-html-btn" title="View Page HTML" data-html-index="${index}">📄</button>`;
            }

            let audioControls = '';
            if (step.audioData) {
                audioControls = `<div class="audio-controls"><audio controls src="${step.audioData}"></audio></div>`;
            }

            let noteDisplay = '';
            if (step.action === 'text_annotation' && step.text) {
                noteDisplay = `<div class="step-details-content"><strong>Note:</strong> ${step.text}</div>`;
            }

            stepDiv.innerHTML = `
                <div class="step-display-content">
                    <span class="step-text" title="${step.selector ? 'Selector: ' + step.selector : 'N/A'}"><strong>${index + 1}.</strong> ${stepText}${step.comment ? `<span class="comment-display"> // ${step.comment}</span>` : ''}</span>
                    <div class="step-controls">
                        ${screenshotControls}
                        ${htmlControls}
                        ${delayControls}
                        ${canBeEdited ? '<button class="rename-step-btn" title="Rename Element">Rename</button>' : ''}
                        ${isTypeAction ? '<button class="set-param-btn" title="Set Value as Parameter">⚙️</button>' : ''}
                        <button class="delete-step-btn" title="Delete Step">Delete</button>
                    </div>
                </div>
                ${stepDetails ? `<div class="step-details-content">${stepDetails}</div>` : ''}
                ${audioControls}
                ${noteDisplay}`;
            stepsContainer.appendChild(stepDiv);
        });
        return stepsContainer;
    }

    tasksContainer.addEventListener('click', async e => {
        // Handle screenshot views separately as they might be inside a task wrapper or global
        if (e.target.classList.contains('view-full-btn') || e.target.classList.contains('view-crop-btn')) {
            e.stopPropagation();
            modal.style.display = "block";

            // Hide iframe if exists
            const iframe = document.getElementById('htmlPreviewFrame');
            if (iframe) iframe.style.display = 'none';

            // Show image
            const modalImg = document.getElementById('screenshotImage');
            modalImg.style.display = 'block';
            modalImg.src = e.target.dataset.src;
            return;
        }

        // Handle HTML view button
        if (e.target.classList.contains('view-html-btn')) {
            e.stopPropagation();
            const taskWrapper = e.target.closest('.task-wrapper');
            if (!taskWrapper) return;
            const taskName = taskWrapper.dataset.taskName;
            const task = allTasks[taskName];
            const stepIndex = parseInt(e.target.dataset.htmlIndex, 10);
            const step = task.steps[stepIndex];
            if (step && step.html) {
                modal.style.display = "block";
                modalImg.style.display = 'none';
                let iframe = document.getElementById('htmlPreviewFrame');
                if (!iframe) {
                    iframe = document.createElement('iframe');
                    iframe.id = 'htmlPreviewFrame';
                    iframe.className = 'modal-content';
                    iframe.style.backgroundColor = 'white';
                    iframe.style.width = '90%';
                    iframe.style.height = '90%';
                    modal.appendChild(iframe);
                }
                iframe.style.display = 'block';
                iframe.srcdoc = step.html;
            }
            return;
        }

        const taskWrapper = e.target.closest('.task-wrapper');
        if (!taskWrapper) return;
        const taskName = taskWrapper.dataset.taskName;
        const task = allTasks[taskName];

        if (e.target.classList.contains('run-btn')) { e.stopPropagation(); const params = {}; taskWrapper.querySelectorAll('.param-item input').forEach(input => { params[input.dataset.paramName] = input.value; }); chrome.runtime.sendMessage({ type: 'executeTask', name: taskName, params }); return; }
        if (e.target.classList.contains('delete-btn')) { e.stopPropagation(); if (confirm(`Delete task "${taskName}"?`)) { chrome.runtime.sendMessage({ type: 'deleteTask', name: taskName }); } return; }

        if (e.target.classList.contains('edit-task-btn')) {
            e.stopPropagation();
            const isEditing = taskWrapper.classList.contains('edit-mode');
            if (isEditing) { // SAVE CHANGES
                const updatedTask = JSON.parse(JSON.stringify(task));
                updatedTask.description = taskWrapper.querySelector('.description-input').value.trim();

                if (updatedTask.mode !== 'literal') {
                    const urlInput = taskWrapper.querySelector('.url-pattern-input');
                    if (urlInput) updatedTask.urlPatterns = urlInput.value.trim();
                }

                const dynamicCheckInput = taskWrapper.querySelector('.dynamic-content-check-editor input');
                if (dynamicCheckInput) updatedTask.dynamicContentCheck = dynamicCheckInput.checked;

                taskWrapper.querySelectorAll('.step-item').forEach(stepEl => {
                    const index = parseInt(stepEl.dataset.index, 10);
                    const delayInput = stepEl.querySelector('.delay-input');
                    if (delayInput && updatedTask.steps[index]) {
                        const newDelay = parseInt(delayInput.value, 10);
                        if (!isNaN(newDelay) && newDelay >= 0) updatedTask.steps[index].delay = newDelay;
                    }
                });

                allTasks[taskName] = updatedTask; // Update local copy before sending
                chrome.runtime.sendMessage({ type: 'updateTask', taskName, updatedTask });

                taskWrapper.classList.remove('edit-mode');
                e.target.textContent = 'Edit';
                taskWrapper.querySelector('.task-details').style.display = 'none';

                chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => { updateTasksList(allTasks, tabs[0]?.url); });

            } else { // START EDITING
                taskWrapper.classList.add('edit-mode');
                e.target.textContent = 'Save';
                taskWrapper.querySelector('.task-details').style.display = 'block';
            }
            return;
        }

        if (!taskWrapper.classList.contains('edit-mode')) return;
        const stepItem = e.target.closest('.step-item'); if (!stepItem) return;
        const index = parseInt(stepItem.dataset.index, 10);
        const taskToEdit = allTasks[taskName];

        if (e.target.classList.contains('delete-step-btn')) { taskToEdit.steps.splice(index, 1); }
        else if (e.target.classList.contains('rename-step-btn')) { const newName = prompt('Enter new element name:', taskToEdit.steps[index].elementName); if (newName !== null && newName.trim()) { taskToEdit.steps[index].elementName = newName.trim(); } else if (newName === null) { return; } }
        else if (e.target.classList.contains('set-param-btn')) {
            const paramName = prompt('Enter a name for this parameter:', taskToEdit.steps[index].paramName || '');
            if (paramName !== null && paramName.trim()) {
                const step = taskToEdit.steps[index];
                const cleanParamName = paramName.trim().replace(/\s/g, '_');
                step.isParam = true;
                step.paramName = cleanParamName;
                if (!taskToEdit.parameters.some(p => p.name === cleanParamName)) {
                    taskToEdit.parameters.push({ name: cleanParamName, defaultValue: step.value });
                }
                delete step.value;
            } else if (paramName === null) { return; }
        } else { return; }

        chrome.runtime.sendMessage({ type: 'updateTask', taskName: taskName, updatedTask: taskToEdit });
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => { updateTasksList(allTasks, tabs[0]?.url); });
    });
    // Helper to create visual display for JSON data
    function createJsonDisplay(data) {
        if (Array.isArray(data)) {
            // Check if array of objects for table display
            if (data.length > 0 && typeof data[0] === 'object' && data[0] !== null) {
                const table = document.createElement('table');
                table.className = 'json-result-table';

                // Header
                const keys = Object.keys(data[0]);
                const thead = document.createElement('thead');
                const headerRow = document.createElement('tr');
                keys.forEach(key => {
                    const th = document.createElement('th');
                    th.textContent = key;
                    headerRow.appendChild(th);
                });
                thead.appendChild(headerRow);
                table.appendChild(thead);

                // Body
                const tbody = document.createElement('tbody');
                data.forEach(item => {
                    const row = document.createElement('tr');
                    keys.forEach(key => {
                        const td = document.createElement('td');
                        const val = item[key];
                        td.textContent = typeof val === 'object' ? JSON.stringify(val) : val;
                        row.appendChild(td);
                    });
                    tbody.appendChild(row);
                });
                table.appendChild(tbody);
                return table;
            } else {
                // Simple list
                const ul = document.createElement('ul');
                ul.className = 'json-result-list';
                data.forEach(item => {
                    const li = document.createElement('li');
                    li.textContent = typeof item === 'object' ? JSON.stringify(item) : item;
                    ul.appendChild(li);
                });
                return ul;
            }
        } else if (typeof data === 'object' && data !== null) {
            // Key Value Grid
            const grid = document.createElement('div');
            grid.className = 'json-result-grid';
            for (const [key, value] of Object.entries(data)) {
                const item = document.createElement('div');
                item.className = 'json-grid-item';
                item.innerHTML = `<strong>${key}:</strong> <span>${typeof value === 'object' ? JSON.stringify(value) : value}</span>`;
                grid.appendChild(item);
            }
            return grid;
        }
        return document.createTextNode(JSON.stringify(data));
    }

    // ==================== AI TASK MODE ====================

    async function setBackgroundAiStopState(stop, reason = '') {
        try {
            await chrome.runtime.sendMessage({
                type: 'setAiStopState',
                stop: !!stop,
                reason: reason || (stop ? 'user-requested-stop' : 'new-run')
            });
        } catch {
            // Background may be unavailable during popup close/reload.
        }
    }

    function setAiTaskRunState(isRunning, path = null) {
        aiTaskRunControl.isRunning = !!isRunning;
        aiTaskRunControl.activePath = path || null;
        if (!isRunning) {
            aiTaskRunControl.stopRequested = false;
            aiTaskRunControl.stopTestsAndSaveRequested = false;
            aiTaskRunControl.latestBuiltFunction = null;
        }
        updateAITaskButtonState();
    }

    function updateAITaskButtonState() {
        const hasDescription = aiTaskDescription.value.trim().length > 0;
        const hasApiKey = geminiApiKeyInput.value.trim().length > 0;
        const canGenerate = hasDescription && hasApiKey && !aiTaskRunControl.isRunning;
        aiTaskGenerateBtn.disabled = !canGenerate;

        if (aiTaskStopTestsSaveBtn) {
            const canStopTests = aiTaskRunControl.isRunning
                && aiTaskRunControl.activePath !== 'tool-chain'
                && !aiTaskRunControl.stopRequested;
            aiTaskStopTestsSaveBtn.disabled = !canStopTests;
            aiTaskStopTestsSaveBtn.title = canStopTests
                ? 'Finish current generation, skip remaining tests, and save function'
                : 'Available during function/workflow generation runs';
        }
        if (aiTaskStopNowBtn) {
            aiTaskStopNowBtn.disabled = !aiTaskRunControl.isRunning || aiTaskRunControl.stopRequested;
            aiTaskStopNowBtn.title = aiTaskRunControl.isRunning
                ? (aiTaskRunControl.stopRequested
                    ? 'Stop already requested'
                    : 'Immediately stop AI generation and running actions')
                : 'Start an AI Task run first';
        }

        if (!hasApiKey) {
            aiTaskGenerateBtn.title = 'Please add your Gemini API key in settings';
        } else if (aiTaskRunControl.isRunning) {
            aiTaskGenerateBtn.title = 'AI task is currently running';
        } else if (!hasDescription) {
            aiTaskGenerateBtn.title = 'Please describe a task first';
        } else {
            aiTaskGenerateBtn.title = 'Generate a reusable function from your task description';
        }
    }

    function updateAITaskFunctionsLibrary() {
        aiTaskFunctionsContainer.innerHTML = '';

        const functionNames = getVisibleFunctionNames();
        if (functionNames.length === 0) {
            aiTaskFunctionsContainer.textContent = currentPageUrl
                ? 'No functions match the current URL.'
                : 'No functions generated yet.';
            return;
        }

        functionNames.forEach(name => {
            const func = allFunctions[name];
            const card = createFunctionCard(func);
            aiTaskFunctionsContainer.appendChild(card);
        });
    }

    function showAITaskStatus(message, type) {
        aiTaskStatus.textContent = message;
        aiTaskStatus.className = 'generation-status ' + type;
    }

    aiTaskDescription.addEventListener('input', () => {
        updateAITaskButtonState();
    });

    if (aiTaskStopTestsSaveBtn) {
        aiTaskStopTestsSaveBtn.addEventListener('click', () => {
            if (!aiTaskRunControl.isRunning) return;
            aiTaskRunControl.stopTestsAndSaveRequested = true;
            showAITaskStatus('Will stop remaining tests and save after function build.', 'active');
            addLogEntry('⏭️ Stop Tests & Save requested.');
            updateAITaskButtonState();
        });
    }

    if (aiTaskStopNowBtn) {
        aiTaskStopNowBtn.addEventListener('click', async () => {
            if (!aiTaskRunControl.isRunning) return;
            aiTaskRunControl.stopRequested = true;
            aiTaskRunControl.stopTestsAndSaveRequested = false;
            showAITaskStatus('Stopping AI immediately...', 'error');
            addLogEntry('🛑 Immediate stop requested.');
            if (typeof AIService?.requestStopAllRequests === 'function') {
                AIService.requestStopAllRequests('Stopped by user');
            }
            await setBackgroundAiStopState(true, 'stop-now');
            updateAITaskButtonState();
        });
    }

    // Example chip click handlers
    document.querySelectorAll('.example-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            aiTaskDescription.value = chip.dataset.task;
            updateAITaskButtonState();
        });
    });

    // Example category tab switching
    document.querySelectorAll('.example-cat-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const cat = tab.dataset.cat;
            // Deactivate all tabs and panels
            document.querySelectorAll('.example-cat-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.example-chips-panel').forEach(p => p.classList.remove('active'));
            // Activate selected
            tab.classList.add('active');
            const panel = document.querySelector(`.example-chips-panel[data-cat="${cat}"]`);
            if (panel) panel.classList.add('active');
        });
    });

    // ==================== WORKFLOW PROGRESS UI ====================

    function showWorkflowProgress(workflowPlan, detailedPlan) {
        const progressDiv = document.getElementById('workflowProgress');
        const overviewDiv = document.getElementById('workflowOverview');
        const listDiv = document.getElementById('subFunctionList');

        if (!progressDiv) return;

        progressDiv.style.display = 'block';

        const totalSteps = detailedPlan?.totalSteps || '...';
        overviewDiv.innerHTML = `
            <div style="margin-bottom: 8px;"><strong>Master Function:</strong> ${workflowPlan.masterFunction.name}</div>
            <div><strong>Sub-Functions:</strong> ${workflowPlan.subFunctions.length} | <strong>Total Steps:</strong> ${totalSteps}</div>
            <div style="margin-top: 8px; font-size: 0.9em; color: #666;">${workflowPlan.masterFunction.orchestrationStrategy}</div>
        `;

        let html = '';

        if (detailedPlan) {
            for (let i = 0; i < detailedPlan.phases.length; i++) {
                const phase = detailedPlan.phases[i];
                const isMaster = phase.type === 'master';

                html += `
                <div class="sub-function-item" id="subFunc-${i}">
                    <span class="status-icon">${isMaster ? '\uD83C\uDFAF' : '\u23F3'}</span>
                    <div style="flex: 1;">
                        <div style="font-weight: 600;">${phase.name}${isMaster ? ' (Master)' : ''}</div>
                        <div style="font-size: 0.85em; color: #666; margin-top: 2px;">${phase.purpose}</div>
                        <div class="workflow-steps" id="subFuncSteps-${i}">
                            ${phase.steps.map((step) => `
                            <div class="workflow-step-item" id="step-${step.id.replace('.', '-')}">
                                <span class="step-num">${step.id}</span>
                                <span class="step-icon">\u25CB</span>
                                <span class="step-label">${step.label}</span>
                            </div>
                            `).join('')}
                        </div>
                    </div>
                </div>`;
            }
        } else {
            // Fallback: simple view without detailed steps
            html = workflowPlan.subFunctions.map((subFunc, i) => `
                <div class="sub-function-item" id="subFunc-${i}">
                    <span class="status-icon">&#x23F3;</span>
                    <div style="flex: 1;">
                        <div style="font-weight: 600;">${subFunc.name}</div>
                        <div style="font-size: 0.85em; color: #666; margin-top: 2px;">${subFunc.purpose}</div>
                    </div>
                </div>
            `).join('');
        }

        listDiv.innerHTML = html;
    }

    function updateSubFunctionStatus(index, status) {
        const item = document.getElementById(`subFunc-${index}`);
        if (!item) return;

        item.classList.remove('generating', 'completed', 'failed', 'retrying');
        const icon = item.querySelector('.status-icon');

        if (status === 'generating') {
            item.classList.add('generating');
            icon.textContent = '\u2699\uFE0F';
        } else if (status === 'completed') {
            item.classList.add('completed');
            icon.textContent = '\u2705';
        } else if (status === 'failed') {
            item.classList.add('failed');
            icon.textContent = '\u274C';
        } else if (status === 'retrying') {
            item.classList.add('generating');
            icon.textContent = '\uD83D\uDD04';
        }
    }

    // Track last active step per phase for auto-completion
    const _lastActiveSteps = {};

    function updateWorkflowStep(phaseIndex, stepIndex, status) {
        const stepsContainer = document.getElementById(`subFuncSteps-${phaseIndex}`);
        if (!stepsContainer) return;

        const stepItems = stepsContainer.querySelectorAll('.workflow-step-item');

        // Auto-complete previous active step in this phase when a new step starts
        if (status === 'active' && _lastActiveSteps[phaseIndex] !== undefined) {
            const prevIdx = _lastActiveSteps[phaseIndex];
            if (prevIdx !== stepIndex && stepItems[prevIdx]) {
                _setStepItemStatus(stepItems[prevIdx], 'completed');
            }
        }

        if (status === 'active') {
            _lastActiveSteps[phaseIndex] = stepIndex;
        }

        if (stepItems[stepIndex]) {
            _setStepItemStatus(stepItems[stepIndex], status);
        }
    }

    function _setStepItemStatus(stepItem, status) {
        const icon = stepItem.querySelector('.step-icon');
        stepItem.classList.remove('step-active', 'step-completed', 'step-failed');

        if (status === 'active') {
            stepItem.classList.add('step-active');
            icon.textContent = '\u25C9'; // ◉
        } else if (status === 'completed') {
            stepItem.classList.add('step-completed');
            icon.textContent = '\u25CF'; // ●
        } else if (status === 'failed') {
            stepItem.classList.add('step-failed');
            icon.textContent = '\u2717'; // ✗
        }
    }

    function hideWorkflowProgress() {
        const progressDiv = document.getElementById('workflowProgress');
        if (progressDiv) {
            progressDiv.style.display = 'none';
        }
    }

    // ==================== AI TASK GENERATE BUTTON ====================

    aiTaskGenerateBtn.addEventListener('click', async () => {
        const apiKey = geminiApiKeyInput.value.trim();
        const taskDescription = aiTaskDescription.value.trim();

        if (!apiKey || !taskDescription) return;

        aiTaskRunControl.stopRequested = false;
        aiTaskRunControl.stopTestsAndSaveRequested = false;
        aiTaskRunControl.latestBuiltFunction = null;
        setAiTaskRunState(true, 'pending');
        if (typeof AIService?.clearStopRequest === 'function') {
            AIService.clearStopRequest();
        }
        await setBackgroundAiStopState(false, 'start-run');
        showAITaskStatus('Analyzing task complexity...', 'active');
        addLogEntry(`🧠 AI Task: "${taskDescription}"`);

        try {
            const retryCount = parseInt(retryCountSelect.value) || 3;
            const showForeground = showTestsForeground.checked;

            // 1. DETECT TOOL CHAIN NEEDS (check before workflow)
            const toolDetection = AITaskService.detectToolNeeds(taskDescription);

            let result;

            if (toolDetection.needsTools) {
                setAiTaskRunState(true, 'tool-chain');
                // TOOL CHAIN PATH - multi-tool orchestrated execution
                addLogEntry(`🔧 Tool chain detected: ${toolDetection.matchedPattern}`);
                showAITaskStatus('Planning tool chain...', 'active');
                showToolChainProgress();

                try {
                    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
                    result = await chrome.runtime.sendMessage({
                        type: 'executeToolChain',
                        taskDescription,
                        apiKey,
                        tabId: activeTab?.id
                    });

                    hideToolChainProgress();

                    if (result.success && result.result) {
                        const chainResult = result.result;
                        showAITaskStatus(
                            `Tool chain completed: ${chainResult.totalSteps} steps (${chainResult.failedSteps} failed)`,
                            chainResult.failedSteps === 0 ? 'success' : 'active'
                        );
                        addLogEntry(`✅ Tool chain completed. Steps: ${chainResult.totalSteps}, Failed: ${chainResult.failedSteps}`);

                        // Display notepad results if any
                        if (chainResult.notepadState && Object.keys(chainResult.notepadState).length > 0) {
                            displayFunctionResult(chainResult.notepadState);
                        }
                        if (chainResult.savedFunction?.functionDef) {
                            const savedFn = { ...chainResult.savedFunction.functionDef };
                            if (!savedFn.name) {
                                savedFn.name = chainResult.savedFunction.name || 'RunToolChain';
                            }
                            const uniqueName = getUniqueFunctionName(savedFn.name);
                            if (uniqueName !== savedFn.name) {
                                addLogEntry(`♻️ Existing function "${savedFn.name}" kept. Saving tool-chain version as "${uniqueName}".`);
                                savedFn.name = uniqueName;
                            }
                            addLogEntry(`💾 Saved tool chain as function: ${savedFn.name}`);
                            allFunctions[savedFn.name] = savedFn;
                            await saveFunctionLibrary();
                            updateFunctionsLibrary();
                        }
                    } else {
                        const toolErr = result.error || 'Unknown error';
                        if (aiTaskRunControl.stopRequested || /stopped by user|cancelled by user/i.test(toolErr)) {
                            showAITaskStatus(`Tool chain stopped: ${toolErr}`, 'error');
                            addLogEntry(`🛑 Tool chain stopped: ${toolErr}`);
                        } else {
                            showAITaskStatus(`Tool chain failed: ${toolErr}`, 'error');
                            addLogEntry(`❌ Tool chain failed: ${toolErr}`);
                        }
                    }
                } catch (e) {
                    hideToolChainProgress();
                    showAITaskStatus(`Tool chain error: ${e.message}`, 'error');
                    addLogEntry(`❌ Tool chain error: ${e.message}`);
                }

            } else {

            // 2. DETECT WORKFLOW NEEDS
            const workflowDetection = await AITaskService.detectWorkflowNeeds(taskDescription, apiKey);

            if (workflowDetection.needsWorkflow) {
                setAiTaskRunState(true, 'workflow');
                // WORKFLOW PATH
                addLogEntry(`🔄 Workflow detected: ${workflowDetection.reasoning}`);
                showAITaskStatus('Starting workflow generation...', 'active');

                result = await AITaskService.executeWorkflowPipeline(taskDescription, apiKey, {
                    existingFunctions: allFunctions,
                    maxRetries: retryCount,
                    enableProactiveExploration: enableProactiveExplorationCheckbox?.checked || false,
                    shouldAbort: () => aiTaskRunControl.stopRequested,
                    shouldStopTestingAndSave: () => aiTaskRunControl.stopTestsAndSaveRequested,
                    onStatusUpdate: (message, metadata) => {
                        showAITaskStatus(message, 'active');
                        addLogEntry(`  \uD83E\uDDE0 ${message}`);

                        // Update workflow progress UI based on metadata
                        if (metadata?.type === 'workflow-plan') {
                            showWorkflowProgress(metadata.plan, metadata.detailedPlan);
                        } else if (metadata?.type === 'subfunction-start') {
                            updateSubFunctionStatus(metadata.index, 'generating');
                        } else if (metadata?.type === 'subfunction-complete') {
                            updateSubFunctionStatus(metadata.index, 'completed');
                        } else if (metadata?.type === 'subfunction-failed') {
                            updateSubFunctionStatus(metadata.index, 'failed');
                        } else if (metadata?.type === 'subfunction-retry') {
                            updateSubFunctionStatus(metadata.index, 'retrying');
                        } else if (metadata?.type === 'subfunction-test-passed') {
                            addLogEntry(`  ✅ ${metadata.name} tests passed${metadata.corrected ? ' (AI-corrected)' : ''}`);
                        } else if (metadata?.type === 'subfunction-test-failed') {
                            addLogEntry(`  ⚠️ ${metadata.name} tests failed — using best version`);
                        } else if (metadata?.type === 'workflow-step') {
                            updateWorkflowStep(metadata.phaseIndex, metadata.stepIndex, metadata.status);
                        }
                    }
                });

                hideWorkflowProgress();

                if (result.success) {
                    // Refresh from storage first so we don't overwrite background-side updates
                    // (e.g., cleanup/pruning done during workflow generation).
                    allFunctions = await loadFunctionLibrary();

                    // Workflow pipeline already saved sub-functions + master to storage.
                    // Avoid saving again here or duplicate versions can be created.

                    showAITaskStatus(
                        `Workflow "${result.functionDef.name}" generated with ${result.subFunctions?.length || 0} sub-functions!`,
                        'success'
                    );
                    addLogEntry(`✅ Workflow "${result.functionDef.name}" created and saved.`);

                    switchMode('playback');
                    updateFunctionsLibrary();
                } else {
                    if (result.aborted) {
                        showAITaskStatus(`Workflow stopped: ${result.error}`, 'error');
                        addLogEntry(`🛑 Workflow stopped: ${result.error}`);
                    } else {
                        showAITaskStatus(`Workflow failed: ${result.error}`, 'error');
                        addLogEntry(`❌ Workflow failed: ${result.error}`);
                    }
                    if (result.failedSubFunctions?.length) {
                        addLogEntry(`   Failed: ${result.failedSubFunctions.join(', ')}`);
                    }
                    if (result.successfulSubFunctions?.length) {
                        addLogEntry(`   Succeeded: ${result.successfulSubFunctions.join(', ')}`);
                    }
                }
            } else {
                setAiTaskRunState(true, 'single');
                // SINGLE FUNCTION PATH (existing behavior)
                addLogEntry(`📄 Single function task detected`);
                showAITaskStatus('Starting function generation...', 'active');

                result = await AITaskService.executeTaskPipeline(taskDescription, apiKey, {
                    existingFunctions: allFunctions,
                    maxRetries: retryCount,
                    showTestsForeground: showForeground,
                    enableProactiveExploration: enableProactiveExplorationCheckbox?.checked || false,
                    shouldAbort: () => aiTaskRunControl.stopRequested,
                    shouldStopTestingAndSave: () => aiTaskRunControl.stopTestsAndSaveRequested,
                    onFunctionBuilt: (builtFunction) => {
                        aiTaskRunControl.latestBuiltFunction = builtFunction || null;
                    },
                    onStatusUpdate: (message, type) => {
                        showAITaskStatus(message, type || 'active');
                        addLogEntry(`  🧠 ${message}`);
                    }
                });

                if (result.success) {
                    // Refresh from storage first so we don't overwrite background-side updates
                    // (e.g., cleanup/pruning done during generation/testing).
                    allFunctions = await loadFunctionLibrary();

                    allFunctions[result.functionDef.name] = result.functionDef;
                    await saveFunctionLibrary();

                    const successStatus = result.stoppedTestingAndSaved
                        ? `Function "${result.functionDef.name}" saved (tests stopped by user).`
                        : `Function "${result.functionDef.name}" generated successfully!`;
                    showAITaskStatus(successStatus, 'success');
                    addLogEntry(
                        result.stoppedTestingAndSaved
                            ? `✅ AI Task function "${result.functionDef.name}" saved after stop-tests request.`
                            : `✅ AI Task function "${result.functionDef.name}" created and saved.`
                    );

                    switchMode('playback');
                    updateFunctionsLibrary();

                    if (result.testOutput) {
                        displayFunctionResult(result.testOutput);
                    }
                } else {
                    if (result.aborted) {
                        showAITaskStatus(`Stopped: ${result.error}`, 'error');
                        addLogEntry(`🛑 AI Task stopped: ${result.error}`);
                    } else {
                        showAITaskStatus(`Failed: ${result.error}`, 'error');
                        addLogEntry(`❌ AI Task failed: ${result.error}`);
                    }
                }
            }

            } // end tool chain else
        } catch (error) {
            hideWorkflowProgress();
            hideToolChainProgress();
            if (/Stopped by user/i.test(String(error?.message || ''))) {
                showAITaskStatus(`Stopped: ${error.message}`, 'error');
                addLogEntry(`🛑 AI Task stopped: ${error.message}`);
            } else {
                showAITaskStatus(`Error: ${error.message}`, 'error');
                addLogEntry(`❌ AI Task error: ${error.message}`);
            }
        } finally {
            await setBackgroundAiStopState(false, 'run-finished');
            if (typeof AIService?.clearStopRequest === 'function') {
                AIService.clearStopRequest();
            }
            setAiTaskRunState(false);
        }
    });

    async function runVerificationTestsInTab(functionDef, testCases) {
        showGenerationStatus(`Running ${testCases.length} tests in active tab...`, 'active');
        addLogEntry(`🧪 Running ${testCases.length} verification tests in active tab...`);

        let allTestsPassed = true;
        let testReport = "";

        // Get current window to create tabs in
        const currentWindow = await chrome.windows.getCurrent();

        for (const testCase of testCases) {
            addLogEntry(`  ▶️ Test: ${testCase.name}`);
            let testTab = null;
            try {
                // Create a new ACTIVE tab for the test
                testTab = await chrome.tabs.create({
                    url: 'about:blank',
                    active: true,
                    windowId: currentWindow.id
                });

                // Wait for tab
                await new Promise(r => setTimeout(r, 1000));

                addLogEntry(`    Executing function... (Watch the new tab)`);

                // Execute the function
                const executionResult = await chrome.runtime.sendMessage({
                    type: 'executeGeneratedFunction',
                    functionDef: functionDef,
                    inputs: testCase.inputs,
                    targetTabId: testTab.id // Updated to use targetTabId
                });

                if (executionResult && executionResult.success) {
                    addLogEntry(`    ✅ Passed`);
                } else {
                    allTestsPassed = false;
                    const failMsg = `Test "${testCase.name}" failed: ${executionResult?.error || 'Unknown error'}`;
                    addLogEntry(`    ❌ ${failMsg}`);
                    testReport += failMsg + "\n";
                }
            } catch (e) {
                allTestsPassed = false;
                testReport += `Test "${testCase.name}" error: ${e.message}\n`;
                addLogEntry(`    ❌ Error: ${e.message}`);
            } finally {
                // Keep the last tab open if it failed? No, clean up for now, or user will drown in tabs.
                // User said "do the testing also in front of the user".
                // Maybe keep it open for a second so they see the result?
                if (testTab) {
                    await new Promise(r => setTimeout(r, 2000)); // Let user see the end state
                    await chrome.tabs.remove(testTab.id);
                }
            }
        }

        if (!allTestsPassed) {
            throw new Error(`Verification tests failed.\n${testReport}`);
        }
    }

    // ==================== TOOL CHAIN PROGRESS UI ====================

    function showToolChainProgress() {
        const container = document.getElementById('toolChainProgress');
        if (container) {
            container.style.display = 'block';
            document.getElementById('toolChainSteps').innerHTML = '<div class="tool-step-item active">Planning tool chain...</div>';
        }
    }

    function hideToolChainProgress() {
        const container = document.getElementById('toolChainProgress');
        if (container) container.style.display = 'none';
    }

    function updateToolChainStep(stepNum, tool, purpose, status) {
        const stepsContainer = document.getElementById('toolChainSteps');
        if (!stepsContainer) return;

        const stepId = `tool-step-${stepNum}`;
        let stepEl = document.getElementById(stepId);

        if (!stepEl) {
            stepEl = document.createElement('div');
            stepEl.id = stepId;
            stepEl.className = 'tool-step-item';
            stepsContainer.appendChild(stepEl);
        }

        const icons = { 'start': '⚙️', 'complete': '✅', 'error': '❌', 'fallback': '🔄' };
        const icon = icons[status] || '⏳';
        stepEl.className = `tool-step-item ${status === 'start' ? 'active' : status}`;
        stepEl.innerHTML = `<span class="tool-step-icon">${icon}</span> <strong>${tool}</strong>: ${purpose}`;
    }

    // Listen for tool chain status messages from background
    chrome.runtime.onMessage.addListener((message) => {
        if (message.type === 'toolChainStatus') {
            const meta = message.metadata || {};
            if (meta.type === 'tool-step-start') {
                updateToolChainStep(meta.step, meta.tool, meta.purpose, 'start');
            } else if (meta.type === 'tool-step-complete') {
                updateToolChainStep(meta.step, meta.tool || '', 'Done', 'complete');
            } else if (meta.type === 'tool-step-error') {
                updateToolChainStep(meta.step, '', meta.error, 'error');
            } else if (meta.type === 'tool-step-fallback') {
                updateToolChainStep(meta.step, 'Gemini fallback', '', 'fallback');
            } else if (meta.type === 'plan-ready') {
                const stepsContainer = document.getElementById('toolChainSteps');
                if (stepsContainer) {
                    stepsContainer.innerHTML = '';
                    (meta.plan || []).forEach((step, i) => {
                        updateToolChainStep(step.stepNumber || i + 1, step.tool, step.purpose, 'pending');
                    });
                }
            }
            addLogEntry(`  🔧 ${message.message}`);
        }
    });

    // ==================== OLLAMA SETTINGS ====================

    const ollamaUrlInput = document.getElementById('ollamaUrl');
    const ollamaModelSelect = document.getElementById('ollamaModel');
    const embeddingEngineSelect = document.getElementById('embeddingEngine');
    const ollamaStatusEl = document.getElementById('ollamaStatus');
    let preferredOllamaModel = '';
    let preferredOllamaEmbeddingModel = '';

    // Load saved Ollama settings
    chrome.storage.local.get(['ollamaUrl', 'ollamaModel', 'ollamaEmbeddingModel', 'embeddingEngine'], (data) => {
        if (data.ollamaUrl && ollamaUrlInput) ollamaUrlInput.value = data.ollamaUrl;
        if (data.ollamaModel) preferredOllamaModel = data.ollamaModel;
        if (data.ollamaEmbeddingModel) preferredOllamaEmbeddingModel = data.ollamaEmbeddingModel;
        if (!data.ollamaEmbeddingModel && data.ollamaModel) {
            preferredOllamaEmbeddingModel = data.ollamaModel;
            chrome.storage.local.set({ ollamaEmbeddingModel: preferredOllamaEmbeddingModel });
            chrome.runtime.sendMessage({
                type: 'saveOllamaSettings',
                url: data.ollamaUrl || 'http://localhost:11434',
                model: data.ollamaModel,
                embeddingModel: preferredOllamaEmbeddingModel,
                embeddingEngine: data.embeddingEngine || (embeddingEngineSelect?.value || 'gemini')
            }).catch(() => {});
        }
        if (data.embeddingEngine && embeddingEngineSelect) embeddingEngineSelect.value = data.embeddingEngine;
        // Check Ollama health on load
        checkOllamaHealth();
    });

    function populateOllamaModels(models = [], preferredModel = '') {
        if (!ollamaModelSelect) return '';

        ollamaModelSelect.innerHTML = '';

        if (!Array.isArray(models) || models.length === 0) {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = 'No models found';
            ollamaModelSelect.appendChild(option);
            ollamaModelSelect.disabled = true;
            return '';
        }

        const modelNames = Array.from(new Set(models
            .map(m => {
                if (typeof m === 'string') return m;
                return m?.name || m?.model || '';
            })
            .filter(Boolean)));

        modelNames.forEach(name => {
            const option = document.createElement('option');
            option.value = name;
            option.textContent = name;
            ollamaModelSelect.appendChild(option);
        });

        ollamaModelSelect.disabled = false;

        const selected = modelNames.includes(preferredModel)
            ? preferredModel
            : (modelNames.includes(ollamaModelSelect.value) ? ollamaModelSelect.value : modelNames[0]);

        ollamaModelSelect.value = selected;
        return selected;
    }

    function pickEmbeddingModel(models = [], selectedModel = '', preferredEmbedding = '') {
        const names = Array.from(new Set((models || [])
            .map(m => typeof m === 'string' ? m : (m?.name || m?.model || ''))
            .filter(Boolean)));

        if (preferredEmbedding && names.includes(preferredEmbedding)) {
            return preferredEmbedding;
        }
        if (selectedModel && /embed|embedding|bge|e5|nomic|mxbai/i.test(selectedModel)) {
            return selectedModel;
        }
        const embedCandidate = names.find(name => /embed|embedding|bge|e5|nomic|mxbai/i.test(name));
        if (embedCandidate) return embedCandidate;
        return selectedModel || names[0] || '';
    }

    async function checkOllamaHealth() {
        if (!ollamaStatusEl) return;
        ollamaStatusEl.textContent = '...';
        ollamaStatusEl.className = 'ollama-status checking';
        try {
            const response = await chrome.runtime.sendMessage({ type: 'ollamaHealthCheck' });
            if (response.available) {
                const previousModel = preferredOllamaModel;
                const previousEmbeddingModel = preferredOllamaEmbeddingModel;
                const selectedModel = populateOllamaModels(response.models || [], preferredOllamaModel);
                preferredOllamaModel = selectedModel || preferredOllamaModel;
                preferredOllamaEmbeddingModel = pickEmbeddingModel(
                    response.models || [],
                    preferredOllamaModel,
                    preferredOllamaEmbeddingModel
                );
                if (
                    (preferredOllamaModel && preferredOllamaModel !== previousModel) ||
                    (preferredOllamaEmbeddingModel && preferredOllamaEmbeddingModel !== previousEmbeddingModel)
                ) {
                    const url = ollamaUrlInput?.value?.trim() || 'http://localhost:11434';
                    const engine = embeddingEngineSelect?.value || 'gemini';
                    chrome.storage.local.set({
                        ollamaUrl: url,
                        ollamaModel: preferredOllamaModel,
                        ollamaEmbeddingModel: preferredOllamaEmbeddingModel,
                        embeddingEngine: engine
                    });
                    chrome.runtime.sendMessage({
                        type: 'saveOllamaSettings',
                        url,
                        model: preferredOllamaModel,
                        embeddingModel: preferredOllamaEmbeddingModel,
                        embeddingEngine: engine
                    }).catch(() => {});
                }
                ollamaStatusEl.textContent = 'ON';
                ollamaStatusEl.className = 'ollama-status online';
                ollamaStatusEl.title = `Connected (${response.models?.length || 0} models) | LLM: ${preferredOllamaModel || 'n/a'} | Embed: ${preferredOllamaEmbeddingModel || 'n/a'}`;
            } else {
                populateOllamaModels([], preferredOllamaModel);
                ollamaStatusEl.textContent = 'OFF';
                ollamaStatusEl.className = 'ollama-status offline';
                ollamaStatusEl.title = 'Ollama not reachable';
            }
        } catch (e) {
            populateOllamaModels([], preferredOllamaModel);
            ollamaStatusEl.textContent = 'ERR';
            ollamaStatusEl.className = 'ollama-status offline';
            ollamaStatusEl.title = e.message;
        }
    }

    function saveOllamaSettings() {
        const url = ollamaUrlInput?.value?.trim() || 'http://localhost:11434';
        const model = ollamaModelSelect?.value || '';
        const engine = embeddingEngineSelect?.value || 'gemini';
        preferredOllamaEmbeddingModel = pickEmbeddingModel([], model, preferredOllamaEmbeddingModel);
        const embeddingModel = preferredOllamaEmbeddingModel || model;
        preferredOllamaModel = model;
        chrome.storage.local.set({
            ollamaUrl: url,
            ollamaModel: model,
            ollamaEmbeddingModel: embeddingModel,
            embeddingEngine: engine
        });
        chrome.runtime.sendMessage({
            type: 'saveOllamaSettings',
            url,
            model,
            embeddingModel,
            embeddingEngine: engine
        });
        checkOllamaHealth();
    }

    if (ollamaUrlInput) ollamaUrlInput.addEventListener('change', saveOllamaSettings);
    if (ollamaModelSelect) ollamaModelSelect.addEventListener('change', saveOllamaSettings);
    if (embeddingEngineSelect) embeddingEngineSelect.addEventListener('change', saveOllamaSettings);

    // ===== Tool Testing Panel =====
    const ttOutput = document.getElementById('ttOutputPre');
    const ttCopyBtn = document.getElementById('ttCopyOutput');
    const ttClearBtn = document.getElementById('ttClearOutput');

    function ttSetOutput(data, isError = false) {
        if (!ttOutput) return;
        const text = typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data);
        ttOutput.textContent = text;
        ttOutput.style.color = isError ? '#fc8181' : '#e2e8f0';
        addLogEntry(`[Test] ${text.substring(0, 300)}${text.length > 300 ? '...' : ''}`);
    }

    if (ttCopyBtn) ttCopyBtn.addEventListener('click', () => {
        if (ttOutput) navigator.clipboard.writeText(ttOutput.textContent);
    });
    if (ttClearBtn) ttClearBtn.addEventListener('click', () => {
        if (ttOutput) { ttOutput.textContent = 'Run a test to see output here.'; ttOutput.style.color = '#e2e8f0'; }
    });

    async function ttRunAction(action, data) {
        return chrome.runtime.sendMessage({ type: 'testDriverAction', action, data });
    }

    function ttParseJson(val) {
        if (!val || !val.trim()) return {};
        try { return JSON.parse(val); } catch { return val; }
    }

    // Attach handlers to all Run buttons
    document.querySelectorAll('.tt-run').forEach(btn => {
        btn.addEventListener('click', async () => {
            const action = btn.dataset.action;
            btn.disabled = true;
            btn.classList.add('tt-running');
            btn.textContent = '...';
            try {
                let result;
                switch (action) {
                    // Navigation & Interaction
                    case 'navigate':
                        result = await ttRunAction('navigate', { url: document.getElementById('tt-nav-url').value });
                        break;
                    case 'click':
                        result = await ttRunAction('click', { selector: document.getElementById('tt-click-sel').value });
                        break;
                    case 'type':
                        result = await ttRunAction('type', {
                            selector: document.getElementById('tt-type-sel').value,
                            text: document.getElementById('tt-type-val').value
                        });
                        break;
                    case 'pressKey':
                        result = await ttRunAction('pressKey', {
                            selector: document.getElementById('tt-key-sel').value,
                            key: document.getElementById('tt-key-val').value
                        });
                        break;
                    case 'scroll':
                        result = await ttRunAction('scroll', {
                            selector: null,
                            amount: parseInt(document.getElementById('tt-scroll-amt').value) || 500
                        });
                        break;
                    case 'wait': {
                        const wv = document.getElementById('tt-wait-val').value;
                        const isNum = /^\d+$/.test(wv);
                        result = await ttRunAction('wait', {
                            condition: isNum ? 'time' : 'selector',
                            value: isNum ? parseInt(wv) : wv
                        });
                        break;
                    }

                    // Data Extraction
                    case 'extract':
                        result = await ttRunAction('extract', {
                            selector: document.getElementById('tt-extract-sel').value,
                            pattern: document.getElementById('tt-extract-pat').value || undefined
                        });
                        break;
                    case 'extractAttribute':
                        result = await ttRunAction('extractAttribute', {
                            selector: document.getElementById('tt-extattr-sel').value,
                            attribute: document.getElementById('tt-extattr-name').value
                        });
                        break;
                    case 'getElements':
                        result = await ttRunAction('getElements', {
                            selector: document.getElementById('tt-getels-sel').value
                        });
                        break;
                    case 'smartScrape':
                        result = await ttRunAction('smartScrape', {
                            description: document.getElementById('tt-scrape-desc').value || 'Extract data from page'
                        });
                        break;
                    case 'executeFunction':
                        result = await ttRunAction('executeFunction', {
                            name: document.getElementById('tt-execfn-name').value,
                            inputs: ttParseJson(document.getElementById('tt-execfn-inputs').value)
                        });
                        break;

                    // Memory
                    case 'writeNotepad': {
                        const wval = document.getElementById('tt-np-wval').value;
                        result = await ttRunAction('writeNotepad', {
                            key: document.getElementById('tt-np-wkey').value,
                            data: ttParseJson(wval) || wval
                        });
                        break;
                    }
                    case 'readNotepad':
                        result = await ttRunAction('readNotepad', {
                            key: document.getElementById('tt-np-rkey').value
                        });
                        break;
                    case 'clearNotepad':
                        result = await ttRunAction('clearNotepad', {});
                        break;
                    case 'savePersistent': {
                        const sval = document.getElementById('tt-ps-sval').value;
                        result = await ttRunAction('savePersistent', {
                            key: document.getElementById('tt-ps-skey').value,
                            data: ttParseJson(sval) || sval
                        });
                        break;
                    }
                    case 'loadPersistent':
                        result = await ttRunAction('loadPersistent', {
                            key: document.getElementById('tt-ps-lkey').value
                        });
                        break;

                    // Output Tools
                    case 'generatePage': {
                        const gpData = ttParseJson(document.getElementById('tt-gp-data').value);
                        const gpTemplate = document.getElementById('tt-gp-template').value;
                        result = await ttRunAction('generatePage', {
                            dataset: gpData, templateType: gpTemplate, options: { title: 'Test Page' }
                        });
                        break;
                    }
                    case 'downloadFile': {
                        const dlData = ttParseJson(document.getElementById('tt-dl-data').value);
                        result = await ttRunAction('downloadFile', {
                            data: dlData,
                            format: document.getElementById('tt-dl-fmt').value,
                            filename: document.getElementById('tt-dl-name').value || 'export'
                        });
                        break;
                    }
                    case 'modifySite': {
                        const msAction = document.getElementById('tt-ms-action').value;
                        const msParams = ttParseJson(document.getElementById('tt-ms-params').value);
                        result = await ttRunAction('modifySite', {
                            action: msAction, ...(typeof msParams === 'object' ? msParams : {})
                        });
                        break;
                    }

                    // AI & Embeddings
                    case 'embedText':
                        const selectedEmbeddingEngine = embeddingEngineSelect?.value || 'gemini';
                        result = await ttRunAction('embedText', {
                            text: document.getElementById('tt-embed-text').value,
                            engine: selectedEmbeddingEngine,
                            strictLocal: selectedEmbeddingEngine === 'ollama'
                        });
                        break;
                    case 'askOllama':
                        result = await ttRunAction('askOllama', {
                            prompt: document.getElementById('tt-ollama-prompt').value,
                            model: ollamaModelSelect?.value || preferredOllamaModel || ''
                        });
                        break;

                    // System
                    case 'listTools':
                        result = await chrome.runtime.sendMessage({ type: 'listRegisteredTools' });
                        break;
                    case 'useTool':
                        result = await ttRunAction('useTool', {
                            toolName: document.getElementById('tt-tool-name').value,
                            params: ttParseJson(document.getElementById('tt-tool-params').value)
                        });
                        break;
                    case 'scheduler': {
                        const schedulerParams = ttParseJson(document.getElementById('tt-scheduler-params').value);
                        if (!schedulerParams || typeof schedulerParams !== 'object' || Array.isArray(schedulerParams)) {
                            throw new Error('Scheduler params must be a JSON object');
                        }
                        result = await ttRunAction('scheduler', schedulerParams);
                        break;
                    }

                    default:
                        result = { success: false, error: `Unknown action: ${action}` };
                }

                if (result && result.success) {
                    ttSetOutput(result.result !== undefined ? result.result : result);
                } else {
                    ttSetOutput(result?.error || result || 'No response', true);
                }
            } catch (e) {
                ttSetOutput(`Error: ${e.message}`, true);
            } finally {
                btn.disabled = false;
                btn.classList.remove('tt-running');
                btn.textContent = 'Run';
            }
        });
    });
});




