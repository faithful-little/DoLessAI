# FunctionCreatorAI Rewrite - Organized Structure

## Folder layout

```text
.
|- ai/
|  |- ai-service.js
|  `- aiTaskService.js
|- core/
|  |- functionLibraryService.js
|  |- recordedTaskAdapter.js
|  |- toolRegistry.js
|  `- toolOrchestrator.js
|- services/
|  |- backendFunctionService.js
|  |- computerUseService.js
|  |- embeddingService.js
|  |- fileSystemService.js
|  |- notepadService.js
|  |- ollamaService.js
|  |- siteModifier.js
|  `- webpageGenerator.js
|- ui/
|  |- offscreen.js
|  |- permission.js
|  |- popup.js
|  |- sandbox.js
|  |- style.css
|  `- viewer.js
|- content/
|  `- content.js
|- function-backend/
|  |- src/
|  |- ui/
|  |- Dockerfile
|  |- docker-compose.yml
|  `- README.md
|- images/
|- background.js
|- manifest.json
|- popup.html
|- offscreen.html
|- sandbox.html
|- viewer.html
`- permission.html
```

## Responsibility by folder

1. `ai/`
- All AI planning/generation logic.
- No UI rendering and no direct storage ownership.

2. `core/`
- Shared orchestration/runtime glue.
- Shared library persistence (`FunctionLibraryService`).
- Recorded-task normalization (`RecordedTaskAdapter`).
- Tool registration and chain planning.

3. `services/`
- Concrete capabilities (embedding, backend sync/search, local models, file/page output, site modification, computer use, memory).
- Registered into `ToolRegistry` when loaded.

4. `ui/`
- Popup and helper page scripts plus styles.
- Purely presentation + event wiring.

5. `content/`
- Injected page-side script only.

6. `function-backend/`
- Optional standalone backend service (Dockerized).
- Stores verified functions + metadata + client-provided embeddings.
- Provides BM25 + vector hybrid search and a web UI.

## Runtime flow (organized by function)

1. Manual recorded run
- UI (`ui/popup.js`) sends `executeTask`.
- `background.js` loads task and converts it through `core/recordedTaskAdapter.js`.
- Unified runner executes resulting steps.

2. AI-generated run
- `ai/ai-service.js` and `ai/aiTaskService.js` produce function definitions.
- Saved through `core/functionLibraryService.js`.
- Executed by same unified runner in `background.js`.

3. Multi-tool chain run
- Planned in `core/toolOrchestrator.js`.
- Tool execution dispatched via `core/toolRegistry.js`.
- Concrete execution in `services/*`.

4. Backend-assisted run
- Popup/background query backend when local matches are missing.
- Imported backend functions are persisted locally and then used in normal planning/execution.
- Verified uploads happen only when opt-in backend upload is enabled.

## Method groups by function

1. `background.js`
- Recording lifecycle: start/stop record, event capture, screenshot processing.
- Unified execution: `executeGeneratedFunction`, `executeAIStep`, step executors.
- Tool/scheduler bridge: tool-chain execution, scheduler runs, message routing.

2. `ai/ai-service.js`
- Prompt + analysis generation.
- Function step generation, verification, correction.
- Agentic scraping loop helpers.

3. `ai/aiTaskService.js`
- Task/workflow detection and planning.
- Single-function pipeline, workflow pipeline, preflight smart-scrape pipeline.
- Test generation/execution orchestration.

4. `core/toolOrchestrator.js`
- Tool need detection.
- Gemini-based chain planning.
- Step-by-step tool-chain execution, verification, auto-repair, save-as-function.

## Key standardization rules now used

1. Shared function persistence
- Use `FunctionLibraryService` for `generatedFunctions` reads/writes.

2. Shared execution model
- Both manual and AI flows execute via `executeGeneratedFunction`.

3. Folder intent
- New logic should be placed by responsibility, not by feature name only:
- AI logic -> `ai/`
- Orchestration/shared models -> `core/`
- External capability/tool implementations -> `services/`
- UI behavior/styles -> `ui/`
- Backend storage/retrieval API -> `function-backend/`

## Cleanup done

1. Removed unused duplicate `src/ai-service.js`.
2. Removed now-empty `src/` folder.
3. Updated all HTML script paths and background imports to the new folder layout.
4. Updated content-script injection path to `content/content.js`.
