if (!window.isRecorderInjected) {
    // Clean up any stale cursor style from previous crashes/reloads
    const existingStyle = document.getElementById('automator-mic-cursor-style');
    if (existingStyle) existingStyle.remove();

    window.isRecorderInjected = true;
    window.recordingMode = 'selector'; // Default mode
    let typingDebounceTimer = null;
    let scrollDebounceTimer = null;
    let hoverTimer = null;
    let lastHoveredElement = null;
    let longPressTimer = null;
    let isLongPressing = false;


    window.setAutomatorRecordingMode = (mode) => {
        window.recordingMode = mode;
        console.log(`Automator recording mode set to: ${mode}`);
    };

    const serializeDOM = () => {
        const baseHref = `${window.location.protocol}//${window.location.host}${window.location.pathname}`;
        const baseTag = `<base href="${baseHref}">`;

        try {
            // Modern Chrome 125+ use getHTML({serializableShadowRoots: true})
            // Older versions use getInnerHTML({includeShadowRoots: true})
            let html;
            if (typeof document.documentElement.getHTML === 'function') {
                html = document.documentElement.getHTML({ serializableShadowRoots: true });
            } else if (typeof document.documentElement.getInnerHTML === 'function') {
                html = document.documentElement.getInnerHTML({ includeShadowRoots: true });
            } else {
                html = document.documentElement.outerHTML;
            }

            // Ensure <base> tag is injected for relative URLs
            if (html.includes('<head>') || html.includes('<HEAD>')) {
                html = html.replace(/(<head>|<HEAD>)/, `$1${baseTag}`);
            } else {
                // If no head exists, try to inject after <html> or at the beginning
                if (html.includes('<html>') || html.includes('<HTML>')) {
                    html = html.replace(/(<html>|<HTML>)/, `$1<head>${baseTag}</head>`);
                } else {
                    html = baseTag + html;
                }
            }

            return html;
        } catch (e) {
            console.error("Automator: HTML serialization failed", e);
            return document.documentElement.outerHTML;
        }
    };

    const recordEvent = (event) => {
        // Check if extension context is still valid
        if (!chrome.runtime || !chrome.runtime.id) {
            // Orphaned script - just skip this event, don't break everything
            console.warn("Automator: Extension context lost for this event, skipping.");
            return;
        }

        try {
            const selection = window.getSelection().toString();

            // Limit HTML capture to 1MB to avoid performance issues
            let html = serializeDOM();
            const MAX_HTML_SIZE = 1024 * 1024; // 1MB
            if (html.length > MAX_HTML_SIZE) {
                html = html.substring(0, MAX_HTML_SIZE) + '\n\n<!-- HTML truncated for performance -->';
            }

            const payload = {
                ...event,
                url: window.location.href,
                html: html,
                selectedText: selection ? selection : null
            };

            // Add element coordinates if an element is involved
            if (event.element) {
                const rect = event.element.getBoundingClientRect();
                payload.rect = {
                    x: rect.x,
                    y: rect.y,
                    width: rect.width,
                    height: rect.height,
                    top: rect.top,
                    left: rect.left,
                    bottom: rect.bottom,
                    right: rect.right
                };
                payload.scroll = { x: window.scrollX, y: window.scrollY };
                payload.viewport = { width: window.innerWidth, height: window.innerHeight };
                payload.devicePixelRatio = window.devicePixelRatio;
                // We don't want to send the DOM element itself
                delete payload.element;
            }

            chrome.runtime.sendMessage({ type: 'recordEvent', event: payload });
        } catch (error) {
            if (!error.message.includes("Extension context invalidated")) console.warn("Automator: Could not send message to background.", error.message);
            window.isRecorderInjected = false;
        }
    };

    const getSelector = (element) => {
        if (!element || !(element instanceof Element)) return null;
        const testId = element.getAttribute('data-testid') || element.getAttribute('data-cy');
        if (testId) return `[data-testid="${testId}"]`;
        if (element.id) return `#${element.id.trim().replace(/(:|\.|\s)/g, '\\$1')}`;
        const name = element.getAttribute('name');
        if (name && document.querySelectorAll(`[name="${name}"]`).length === 1) return `[name="${name}"]`;

        if (element.classList.length > 0) {
            const uniqueClasses = Array.from(element.classList)
                .filter(cls => cls && !/^\d+$/.test(cls) && !/[()\[\]]/.test(cls)); // Filter out invalid chars
            if (uniqueClasses.length > 0) {
                const selector = '.' + uniqueClasses.join('.');
                try {
                    if (document.querySelectorAll(selector).length === 1) return selector;
                } catch (e) { /* Invalid selector from framework, ignore */ }
            }
        }

        const path = [];
        let current = element;
        while (current && current.parentElement) {
            let selector = current.tagName.toLowerCase();
            if (selector === 'body' || selector === 'html') break;
            if (current.parentElement.id) {
                path.unshift(selector);
                path.unshift(`#${current.parentElement.id.trim().replace(/(:|\.|\s)/g, '\\$1')}`);
                break;
            }

            let siblingIndex = 1;
            let sibling = current.previousElementSibling;
            while (sibling) {
                if (sibling.tagName === current.tagName) siblingIndex++;
                sibling = sibling.previousElementSibling;
            }

            let siblingCount = 0;
            if (current.parentElement.children) {
                for (const child of current.parentElement.children) {
                    if (child.tagName === current.tagName) siblingCount++;
                }
            }

            if (siblingCount > 1) {
                selector += `:nth-of-type(${siblingIndex})`;
            }
            path.unshift(selector);
            current = current.parentElement;
        }
        return path.join(' > ');
    };

    const getElementName = (element) => { if (!element) return 'N/A'; let name = element.getAttribute('aria-label') || element.title; if (name && name.trim()) return name.trim(); const isTextInput = (element.tagName === 'INPUT' && !['button', 'submit', 'reset', 'checkbox', 'radio'].includes(element.type)) || element.tagName === 'TEXTAREA' || element.isContentEditable; if (isTextInput) { name = element.placeholder; if (name && name.trim()) return `Input for "${name.trim()}"`; if (element.labels && element.labels.length > 0) { const labelText = element.labels[0].innerText; if (labelText && labelText.trim()) return `Input for "${labelText.trim()}"`; } return `Text Input (${element.tagName.toLowerCase()})`; } const isStaticClickable = ['BUTTON', 'A', 'SUMMARY'].includes(element.tagName) || (element.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes(element.type)) || element.getAttribute('role') === 'button'; if (isStaticClickable) { name = element.innerText || element.value; if (name && name.trim()) { const cleanName = name.trim().replace(/\s+/g, ' ').substring(0, 40); if (cleanName) return cleanName; } } name = element.alt; if (name && name.trim()) return `Image: ${name.trim()}`; return `Element (${element.tagName.toLowerCase()})`; };

    // Gather comprehensive element context for AI model
    const getElementContext = (element) => {
        if (!element || !(element instanceof Element)) return null;

        const context = {
            // Basic element info
            tagName: element.tagName.toLowerCase(),
            id: element.id || null,
            className: element.className || null,

            // All attributes
            attributes: {},

            // Text content
            innerText: (element.innerText || '').trim().substring(0, 200),
            value: element.value || null,
            placeholder: element.placeholder || null,

            // Accessibility info
            role: element.getAttribute('role'),
            ariaLabel: element.getAttribute('aria-label'),
            ariaDescribedBy: element.getAttribute('aria-describedby'),
            title: element.title || null,

            // Form context
            name: element.getAttribute('name'),
            type: element.type || null,

            // Link info
            href: element.href || element.getAttribute('href') || null,

            // Parent hierarchy (ancestors for context)
            ancestors: [],

            // Sibling context
            siblings: {
                previous: null,
                next: null,
                totalSiblings: 0,
                indexAmongSiblings: 0
            },

            // Nearby text context
            nearbyText: null,

            // Container HTML snippet (the relevant DOM subtree)
            containerHTML: null,

            // NEW: The repeating list item container (e.g., ytd-video-renderer, article, etc.)
            listItemContainer: null,

            // NEW: Map of all interactive/important child elements in the container
            containerChildElements: []
        };

        // Gather all attributes
        for (const attr of element.attributes) {
            context.attributes[attr.name] = attr.value;
        }

        // Build ancestor chain (up to 5 levels)
        let current = element.parentElement;
        let depth = 0;
        while (current && depth < 5 && current !== document.body) {
            const ancestorInfo = {
                tagName: current.tagName.toLowerCase(),
                id: current.id || null,
                className: current.className || null,
                role: current.getAttribute('role'),
                ariaLabel: current.getAttribute('aria-label'),
                // Check for common container patterns
                dataTestId: current.getAttribute('data-testid'),
                dataCy: current.getAttribute('data-cy')
            };
            context.ancestors.push(ancestorInfo);
            current = current.parentElement;
            depth++;
        }

        // Get sibling info
        if (element.parentElement) {
            const siblings = Array.from(element.parentElement.children);
            context.siblings.totalSiblings = siblings.length;
            context.siblings.indexAmongSiblings = siblings.indexOf(element);

            // Previous sibling summary
            const prevSibling = element.previousElementSibling;
            if (prevSibling) {
                context.siblings.previous = {
                    tagName: prevSibling.tagName.toLowerCase(),
                    text: (prevSibling.innerText || '').trim().substring(0, 50),
                    className: prevSibling.className || null
                };
            }

            // Next sibling summary
            const nextSibling = element.nextElementSibling;
            if (nextSibling) {
                context.siblings.next = {
                    tagName: nextSibling.tagName.toLowerCase(),
                    text: (nextSibling.innerText || '').trim().substring(0, 50),
                    className: nextSibling.className || null
                };
            }
        }

        // Get nearby visible text (labels, headings, etc.)
        const nearbyTexts = [];
        // Check for associated label
        if (element.labels && element.labels.length > 0) {
            nearbyTexts.push(`label: "${element.labels[0].innerText.trim()}"`);
        }
        // Check previous sibling for label-like text
        if (element.previousElementSibling) {
            const prevText = element.previousElementSibling.innerText?.trim();
            if (prevText && prevText.length < 100) {
                nearbyTexts.push(`before: "${prevText}"`);
            }
        }
        // Parent's direct text (not including children) 
        if (element.parentElement) {
            // Find closest heading or label ancestor
            let headingAncestor = element.closest('section, article, fieldset, form, [role="region"], [role="dialog"]');
            if (headingAncestor) {
                const heading = headingAncestor.querySelector('h1, h2, h3, h4, h5, h6, legend, [role="heading"]');
                if (heading) {
                    nearbyTexts.push(`section: "${heading.innerText.trim().substring(0, 50)}"`);
                }
            }
        }
        context.nearbyText = nearbyTexts.length > 0 ? nearbyTexts.join('; ') : null;

        // Find the nearest "list item" container - the repeating element in a list
        // Common patterns: custom elements (ytd-video-renderer), article, [role=listitem], [role=row], tr, li, etc.
        const listItemSelectors = [
            // YouTube-specific
            'ytd-video-renderer', 'ytd-compact-video-renderer', 'ytd-grid-video-renderer', 'ytd-playlist-video-renderer',
            'yt-lockup-view-model',
            // Generic list items
            '[role="listitem"]', '[role="row"]', '[role="article"]', '[role="option"]',
            'article', 'li', 'tr',
            // Card/item patterns
            '[class*="card"]', '[class*="item"]', '[class*="result"]', '[class*="entry"]',
            '[data-testid]'
        ];

        let listItemContainer = null;
        for (const selector of listItemSelectors) {
            try {
                const container = element.closest(selector);
                if (container && container !== document.body) {
                    // Check if this container has siblings of the same type (it's a list item)
                    const parent = container.parentElement;
                    if (parent) {
                        const similarSiblings = parent.querySelectorAll(':scope > ' + container.tagName.toLowerCase());
                        if (similarSiblings.length >= 1) {
                            listItemContainer = container;
                            break;
                        }
                    }
                }
            } catch (e) { /* Invalid selector, skip */ }
        }

        if (listItemContainer) {
            context.listItemContainer = {
                tagName: listItemContainer.tagName.toLowerCase(),
                id: listItemContainer.id || null,
                className: (listItemContainer.className || '').toString().substring(0, 200),
                // How to select this container type
                selector: listItemContainer.tagName.toLowerCase() +
                    (listItemContainer.id ? '#' + listItemContainer.id : '') +
                    (listItemContainer.className ? '.' + listItemContainer.className.toString().split(' ')[0] : ''),
                // Full HTML (truncated)
                outerHTML: listItemContainer.outerHTML.substring(0, 4000)
            };

            // Map all important child elements in this container
            const importantElements = listItemContainer.querySelectorAll(
                'a[href], button, input, [role="button"], [role="link"], ' +
                'h1, h2, h3, h4, h5, h6, [id], [data-testid], [aria-label], ' +
                'img[src], video, time, span[class], div[id]'
            );

            const childMap = [];
            const seenSelectors = new Set();

            for (const child of importantElements) {
                // Build a unique selector for this child within the container
                let childSelector = child.tagName.toLowerCase();
                if (child.id) {
                    childSelector = '#' + child.id;
                } else if (child.getAttribute('data-testid')) {
                    childSelector = `[data-testid="${child.getAttribute('data-testid')}"]`;
                } else if (child.getAttribute('aria-label')) {
                    childSelector = `[aria-label="${child.getAttribute('aria-label').substring(0, 50)}"]`;
                } else if (child.className && typeof child.className === 'string') {
                    const mainClass = child.className.split(' ').filter(c => c && !c.includes(':'))[0];
                    if (mainClass) {
                        childSelector = child.tagName.toLowerCase() + '.' + mainClass;
                    }
                }

                // Skip duplicates
                if (seenSelectors.has(childSelector)) continue;
                seenSelectors.add(childSelector);

                const childInfo = {
                    selector: childSelector,
                    tagName: child.tagName.toLowerCase(),
                    id: child.id || null,
                    className: (child.className || '').toString().substring(0, 100),
                    text: (child.innerText || '').trim().substring(0, 100),
                    href: child.href || child.getAttribute('href') || null,
                    src: child.src || child.getAttribute('src') || null,
                    ariaLabel: child.getAttribute('aria-label')
                };

                childMap.push(childInfo);

                // Limit to prevent huge payloads
                if (childMap.length >= 30) break;
            }

            context.containerChildElements = childMap;
        } else {
            // Fallback: Get container HTML (parent's outerHTML, truncated)
            if (element.parentElement) {
                try {
                    const containerHTML = element.parentElement.outerHTML;
                    context.containerHTML = containerHTML.substring(0, 2000);
                } catch (e) {
                    context.containerHTML = null;
                }
            }
        }

        return context;
    };

    document.addEventListener('click', (e) => {
        if (e.target.id === 'automator-return-value-btn' || !e.isTrusted || !window.isRecorderInjected) return;
        if (window.recordingMode === 'literal') {
            recordEvent({ action: 'literal_click', x: e.clientX, y: e.clientY });
        } else {
            recordEvent({ action: 'click', selector: getSelector(e.target), value: null, elementName: getElementName(e.target), element: e.target, elementContext: getElementContext(e.target) });
        }
    }, true);

    document.addEventListener('input', (e) => {
        if (e.isTrusted && window.isRecorderInjected && window.recordingMode === 'selector' && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable)) {
            clearTimeout(typingDebounceTimer);
            typingDebounceTimer = setTimeout(() => { recordEvent({ action: 'type', selector: getSelector(e.target), value: e.target.isContentEditable ? e.target.innerText : e.target.value, elementName: getElementName(e.target), element: e.target, elementContext: getElementContext(e.target) }); }, 400);
        }
    }, true);

    document.addEventListener('keydown', (e) => {
        if (!e.isTrusted || !window.isRecorderInjected) return;
        if (window.recordingMode === 'literal') {
            if (e.key !== 'Shift' && e.key !== 'Control' && e.key !== 'Alt' && e.key !== 'Meta') {
                recordEvent({ action: 'literal_keydown', key: e.key, code: e.code, selector: getSelector(e.target), elementName: getElementName(e.target) });
            }
        } else { // Selector mode
            if (e.key === 'Enter') {
                clearTimeout(typingDebounceTimer);
                recordEvent({ action: 'enter', selector: getSelector(e.target), value: null, elementName: getElementName(e.target), element: e.target, elementContext: getElementContext(e.target) });
            }
        }
    }, true);

    document.addEventListener('scroll', () => {
        if (window.isRecorderInjected && window.recordingMode === 'selector') {
            clearTimeout(scrollDebounceTimer);
            scrollDebounceTimer = setTimeout(() => { recordEvent({ action: 'scroll', elementName: 'Window', value: { x: window.scrollX, y: window.scrollY } }); }, 500);
        }
    }, true);

    let returnValueBtn = null;
    function createReturnValueButton() { if (document.getElementById('automator-return-value-btn')) return document.getElementById('automator-return-value-btn'); const btn = document.createElement('button'); btn.id = 'automator-return-value-btn'; btn.textContent = '◎ Set as Return Value'; const style = document.createElement('style'); style.textContent = ` #automator-return-value-btn { position: absolute; z-index: 2147483647; background-color: #007bff; color: white; border: 1px solid #0056b3; border-radius: 5px; padding: 6px 10px; font-size: 12px; font-family: sans-serif; cursor: pointer; box-shadow: 0 2px 5px rgba(0,0,0,0.2); display: none; } `; document.head.appendChild(style); document.body.appendChild(btn); btn.addEventListener('click', () => { if (btn.targetElement) { recordEvent({ action: 'returnValue', selector: getSelector(btn.targetElement), elementName: getElementName(btn.targetElement), value: null, elementContext: getElementContext(btn.targetElement) }); } hideReturnValueButton(); }); return btn; }
    function hideReturnValueButton() { if (returnValueBtn) returnValueBtn.style.display = 'none'; }
    document.addEventListener('mousedown', (e) => { if (e.target.id !== 'automator-return-value-btn') hideReturnValueButton(); }, true);
    // --- Audio Recording (Long Press) ---
    const addMicCursor = () => {
        const style = document.createElement('style');
        style.id = 'automator-mic-cursor-style';
        style.textContent = ` * { cursor: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24"><path fill="red" d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/><path fill="red" d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>') 16 16, auto !important; } `;
        document.head.appendChild(style);
    };
    const removeMicCursor = () => {
        const style = document.getElementById('automator-mic-cursor-style');
        if (style) style.remove();
    };

    document.addEventListener('mousedown', (e) => {
        if (!chrome.runtime || !chrome.runtime.id) return;
        if (!e.isTrusted || !window.isRecorderInjected) return;
        isLongPressing = false;
        longPressTimer = setTimeout(() => {
            isLongPressing = true;
            addMicCursor();
            chrome.runtime.sendMessage({ type: 'startAudioRecording' });
        }, 1000);
    }, true);

    document.addEventListener('mouseup', (e) => {
        if (!chrome.runtime || !chrome.runtime.id) return;
        if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
        if (isLongPressing) {
            isLongPressing = false;
            removeMicCursor();
            chrome.runtime.sendMessage({ type: 'stopAudioRecording' });
            e.preventDefault(); e.stopPropagation(); // Prevent click action after recording
        } else {
            // Normal click handling is in separate listener, but we might need to ensure return value btn logic still works
            if (!window.isRecorderInjected || window.recordingMode !== 'selector' || e.target.id === 'automator-return-value-btn') return;
            setTimeout(() => {
                if (!chrome.runtime || !chrome.runtime.id) return;
                const selection = window.getSelection();
                if (selection.toString().trim().length > 0) {
                    if (!returnValueBtn) returnValueBtn = createReturnValueButton();
                    const range = selection.getRangeAt(0);
                    const rect = range.getBoundingClientRect();
                    let targetElement = range.commonAncestorContainer;
                    if (targetElement.nodeType === Node.TEXT_NODE) {
                        targetElement = targetElement.parentElement;
                    }
                    if (!targetElement || !(targetElement instanceof Element)) {
                        hideReturnValueButton();
                        return;
                    }
                    returnValueBtn.style.display = 'block';
                    returnValueBtn.style.top = `${window.scrollY + rect.bottom + 5}px`;
                    returnValueBtn.style.left = `${window.scrollX + rect.left}px`;
                    returnValueBtn.targetElement = targetElement;
                } else {
                    hideReturnValueButton();
                }
            }, 10);
        }
    }, true);

    document.addEventListener('mousemove', (e) => {
        // If moved significantly, cancel long press
        // Simple check: if movement is handled elsewhere or just cancel on any move?
        // Let's be lenient, allow small jitters. But for now, strict cancel on significant move could be complex.
        // We'll rely on user holding still-ish.
    }, true);


    // --- Hover Recording ---
    document.addEventListener('mouseover', (e) => {
        if (!chrome.runtime || !chrome.runtime.id) return;
        if (!window.isRecorderInjected || window.recordingMode !== 'selector') return;

        clearTimeout(hoverTimer);
        const target = e.target;

        hoverTimer = setTimeout(() => {
            // Check if element is still there and visible
            if (!document.body.contains(target)) return;

            // Check if interesting (Link or Button)
            let interesting = false;
            let el = target;
            let linkHref = null;

            while (el && el !== document.body) {
                if (el.tagName === 'A') { interesting = true; linkHref = el.href; break; }
                if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') { interesting = true; break; }
                el = el.parentElement;
            }

            if (interesting) {
                recordEvent({
                    action: 'hover',
                    selector: getSelector(target),
                    elementName: getElementName(target),
                    element: target,
                    elementContext: getElementContext(target),
                    href: linkHref
                });
            }
        }, 800); // 800ms hover
    }, true);

    document.addEventListener('mouseout', () => { clearTimeout(hoverTimer); }, true);


    // Listen for stop command from background
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action === 'stopRecording') {
            window.isRecorderInjected = false; // Disable recording logic
            if (longPressTimer) clearTimeout(longPressTimer);
            removeMicCursor();
            console.log("Automator: Recording stopped via background command.");
        }
    });
}