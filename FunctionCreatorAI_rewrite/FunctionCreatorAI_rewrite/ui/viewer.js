(() => {
    const loadingEl = document.getElementById('loadingMsg');
    const iframe = document.getElementById('viewer');

    function showError(message, hint = '') {
        loadingEl.className = 'error';
        loadingEl.innerHTML = `<div>${message}</div>${hint ? `<div style="font-size:13px;color:#888">${hint}</div>` : ''}`;
    }

    function getPageId() {
        try {
            const params = new URLSearchParams(window.location.search);
            return params.get('pageId');
        } catch {
            return null;
        }
    }

    async function loadGeneratedPage() {
        try {
            const pageId = getPageId();
            const htmlKey = pageId ? `generatedPageHTML_${pageId}` : 'generatedPageHTML';
            const titleKey = pageId ? `generatedPageTitle_${pageId}` : 'generatedPageTitle';

            const data = await chrome.storage.local.get([htmlKey, titleKey, 'generatedPageHTML', 'generatedPageTitle']);
            const html = data[htmlKey] || data.generatedPageHTML;
            const title = data[titleKey] || data.generatedPageTitle || 'Generated Page';

            if (!html) {
                showError('No generated page found.', 'Generate a page first using the tool orchestrator.');
                return;
            }

            document.title = title;
            iframe.srcdoc = html;
            iframe.style.display = 'block';
            loadingEl.style.display = 'none';

            const keysToRemove = [htmlKey, titleKey];
            if (htmlKey !== 'generatedPageHTML') keysToRemove.push('generatedPageHTML', 'generatedPageTitle');
            await chrome.storage.local.remove(keysToRemove);
        } catch (e) {
            showError(`Error: ${e.message}`);
        }
    }

    loadGeneratedPage();
})();
