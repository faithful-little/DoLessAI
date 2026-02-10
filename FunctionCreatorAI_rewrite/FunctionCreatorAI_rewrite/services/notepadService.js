// Notepad Service - Shared session notepad + persistent state manager
// Shared notepad: in-memory, lost on service worker restart
// Persistent state: chrome.storage.local, survives restarts

const NotepadService = {
    // ===== SHARED NOTEPAD (session-scoped, in-memory) =====
    _notepad: {},

    write(key, data) {
        this._notepad[key] = { data, updatedAt: Date.now() };
        console.log(`[Notepad] Write: "${key}"`, typeof data === 'object' ? `(${Array.isArray(data) ? data.length + ' items' : 'object'})` : data);
    },

    read(key) {
        return this._notepad[key]?.data ?? null;
    },

    has(key) {
        return key in this._notepad;
    },

    clear(key) {
        if (key) {
            delete this._notepad[key];
        } else {
            this._notepad = {};
        }
    },

    readAll() {
        const result = {};
        for (const [k, v] of Object.entries(this._notepad)) {
            result[k] = v.data;
        }
        return result;
    },

    keys() {
        return Object.keys(this._notepad);
    },

    // ===== PERSISTENT STATE (chrome.storage.local) =====
    async save(key, data) {
        const storageKey = `persistent_${key}`;
        await chrome.storage.local.set({ [storageKey]: { data, savedAt: Date.now() } });
        console.log(`[PersistentState] Saved: "${key}"`);
    },

    async load(key) {
        const storageKey = `persistent_${key}`;
        const result = await chrome.storage.local.get([storageKey]);
        return result[storageKey]?.data ?? null;
    },

    async remove(key) {
        const storageKey = `persistent_${key}`;
        await chrome.storage.local.remove([storageKey]);
    },

    async listKeys() {
        const all = await chrome.storage.local.get(null);
        return Object.keys(all)
            .filter(k => k.startsWith('persistent_'))
            .map(k => k.replace('persistent_', ''));
    },

    async loadWithMeta(key) {
        const storageKey = `persistent_${key}`;
        const result = await chrome.storage.local.get([storageKey]);
        return result[storageKey] ?? null; // Returns { data, savedAt }
    }
};

// Register as tools
if (typeof ToolRegistry !== 'undefined') {
    ToolRegistry.register('shared_notepad', {
        description: 'Temporary in-memory notepad for passing data between tool steps within a session',
        capabilities: ['memory', 'session-storage', 'data-passing'],
        parameters: {
            type: 'OBJECT',
            properties: {
                action: { type: 'STRING', enum: ['write', 'read', 'clear', 'readAll', 'keys'] },
                key: { type: 'STRING' },
                data: {}
            },
            required: ['action']
        },
        execute: async (params) => {
            switch (params.action) {
                case 'write': NotepadService.write(params.key, params.data); return { success: true };
                case 'read': return { success: true, data: NotepadService.read(params.key) };
                case 'clear': NotepadService.clear(params.key); return { success: true };
                case 'readAll': return { success: true, data: NotepadService.readAll() };
                case 'keys': return { success: true, data: NotepadService.keys() };
                default: throw new Error(`Unknown notepad action: ${params.action}`);
            }
        }
    });

    ToolRegistry.register('persistent_state_manager', {
        description: 'Persistent key-value storage that survives browser restarts. Use for tracking state over days.',
        capabilities: ['persistence', 'long-term-storage', 'state-tracking'],
        parameters: {
            type: 'OBJECT',
            properties: {
                action: { type: 'STRING', enum: ['save', 'load', 'remove', 'listKeys'] },
                key: { type: 'STRING' },
                data: {}
            },
            required: ['action']
        },
        execute: async (params) => {
            switch (params.action) {
                case 'save': await NotepadService.save(params.key, params.data); return { success: true };
                case 'load': return { success: true, data: await NotepadService.load(params.key) };
                case 'remove': await NotepadService.remove(params.key); return { success: true };
                case 'listKeys': return { success: true, data: await NotepadService.listKeys() };
                default: throw new Error(`Unknown state action: ${params.action}`);
            }
        }
    });
}

if (typeof self !== 'undefined') self.NotepadService = NotepadService;
