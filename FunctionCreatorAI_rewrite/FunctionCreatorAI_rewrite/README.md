# FunctionCreator Extension Documentation

## Overview
FunctionCreator is a powerful Chrome extension designed to record user interactions on websites and convert them into repeatable automation steps. It features robust recording modes, audio annotations, detailed visual previews, and **AI-powered function generation** using Gemini.

## Project Layout (Refactored)
Code is organized by responsibility:

* `ai/` - AI planning and generation services
* `core/` - orchestration and shared runtime/persistence adapters
* `services/` - concrete tool/service implementations
* `ui/` - popup/offscreen/viewer/permission scripts and styles
* `content/` - injected content script
* `function-backend/` - optional Dockerized backend (API + UI + BM25/embedding search)

See `PROJECT_STRUCTURE.md` for full architecture details and runtime flow.

## Optional Function Backend (Docker)

This repo now includes a standalone backend in `function-backend/` for shared function storage and retrieval.

### Start backend
1. Open a terminal in `function-backend/`
2. Run:

```bash
docker compose up --build
```

3. Backend endpoints:
   - UI: `http://localhost:8787`
   - API health: `http://localhost:8787/api/health`

### Enable backend in extension
1. Open extension settings (`⚙️` in popup)
2. In **Function Backend**:
   - Enable **Use backend search/import for missing local functions**
   - Set backend URL (default `http://localhost:8787`)
   - Optionally enable **Send tested + verified functions to backend (opt-in)**

### Behavior
* Backend search is used to hydrate relevant functions when local matches are missing.
* Verified-function upload is **off by default** and only happens when the opt-in toggle is enabled.
* Embeddings are generated on the extension client and sent to the backend with uploads/search requests, so backend API keys are not required.

## Core Features

### 1. Recording Modes
*   **Selector Mode (Default)**: Captures interactions based on DOM elements. Intelligent selector generation prioritizes `data-testid`, IDs, and unique classes.
*   **Literal Mode**: Records exact click coordinates (X, Y) and keyboard events, useful for canvas-based apps or complex interactive elements where standard selectors fail.

### 2. Interaction Capture
*   **Clicks & Typing**: Records all mouse clicks and text input. Typing is intelligently debounced and grouped.
*   **Hovers**: Automatically records hover actions on links and buttons after an 800ms delay.
*   **Navigation**: Distinguishes between "Direct" navigation (address bar) and "Result" navigation (clicking a link/button).
*   **Tab Switching**: Monitors and records when you switch between different browser tabs.

### 3. Visual Feedback & Previews
*   **Full-Page Screenshots**: Captures the entire visible area for every recorded step.
*   **Element Cropping**: Automatically crops a small image of the specific element you interacted with for precise verification.
*   **Universal HTML Capture**: Uses advanced Shadow DOM piercing to capture the full state of modern web applications (like SPAs and complex frameworks).
*   **Base Tag Injection**: Ensures that images and styles in HTML previews load correctly by resolving relative paths.

### 4. Advanced Tools
*   **Audio Annotations**: Long-press (1s) anywhere on a page to record a voice note for that step. Use the settings panel (⚙️) to select your preferred microphone.
*   **Text Notes**: Add manual text annotations to your recording for extra context.
*   **Return Values**: Highlight text on a page and set it as the "Assistant Answer" to capture data from a site.
*   **Largest Text Block**: A one-click tool to find and capture the main text content of a page.

### 5. AI Function Generation (NEW!)
Transform your recordings into reusable, modular functions using Gemini AI.

#### Setup
1. Click the settings icon (⚙️)
2. Enter your **Gemini API Key** (get one from [Google AI Studio](https://aistudio.google.com/))
3. Configure:
   - **AI Retry Count**: Number of attempts if generation fails (1-5)
   - **AI Thinking Level**: Quality vs speed tradeoff (None/Low/Medium/High)

#### Usage
1. **Record Mode**: Record your interactions as usual
2. **Playback Mode**: Switch to the "▶️ Playback Mode" tab
3. Click **"🤖 Generate Function from Recording"**
4. AI analyzes your recording and generates:
   - Function name and description
   - Input parameters (detected from your actions)
   - Output type (single value, array, object, etc.)
   - Executable steps
   - Test cases

#### Function Library
Generated functions appear in the Function Library with:
- **Name & Description**: What the function does
- **URL Patterns**: Where the function can run
- **Inputs**: Required and optional parameters
- **Outputs**: What data the function returns
- **Actions**:
  - 🧪 **Test**: Run with custom inputs
  - ▶️ **Run**: Execute the function
  - 🗑️ **Delete**: Remove from library

#### Example: YouTube Search Function
Recording a YouTube search generates a function like:
```javascript
{
  name: "searchYouTube",
  description: "Searches YouTube for videos matching a query",
  inputs: [{ name: "searchTerm", type: "string", required: true }],
  outputs: { type: "arrayOfObjects", properties: { title, channel, link } },
  urlPatterns: ["https://www.youtube.com/*"]
}
```

## Technical Details

### State Persistence
The extension uses `chrome.storage.local` to persist the current recording state. If the extension is reloaded or the background script idles, your progress is automatically restored.

### Content Script Stability
Robust "Context Invalidated" handling ensures that the extension remains functional even after updates. Every communication channel checks for extension validity before sending messages.

### Universal HTML Serialization
Capturing modern sites (YouTube, etc.) requires piercing Shadow Roots. The extension uses a multi-layered approach:
1.  **Native `getHTML()`**: Available in modern Chrome versions for declarative shadow DOM.
2.  **Native `getInnerHTML()`**: Fallback for older versions.
3.  **Base Tag Injection**: Dynamically injects `<base>` tags to fix broken relative URLs in previews.

### AI Function Step Types
Generated functions can contain these step types:
| Step Type | Description |
|-----------|-------------|
| `click` | Click on a DOM element |
| `type` | Type text into an input field |
| `scroll` | Scroll page or to an element |
| `wait` | Wait for time, selector, or text |
| `extract` | Extract data from the DOM |
| `script` | Execute simple JavaScript |
| `navigate` | Go to a URL |

## Usage Tips
*   **Settings**: Click the gear icon in the popup to change your microphone, API key, or AI settings.
*   **Step Review**: Click the 📷 icon to see the full screenshot or 📄 to see the captured HTML for a step.
*   **Naming**: You can rename elements directly in the saved task list to make your automations more readable.
*   **AI Generation**: Add text notes during recording to help AI understand your intent.
*   **Testing**: Always test generated functions before relying on them for automation.

