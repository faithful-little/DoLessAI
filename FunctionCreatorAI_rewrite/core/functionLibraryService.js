// Function Library Service
// Centralizes storage operations for generated functions.

const FunctionLibraryService = {
    STORAGE_KEY: 'generatedFunctions',

    _normalizeMap(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return {};
        }
        return { ...value };
    },

    _normalizeName(name) {
        const cleaned = typeof name === 'string' ? name.trim() : '';
        return cleaned || 'GeneratedFunction';
    },

    getUniqueName(baseName, existingFunctions = {}) {
        const cleanedBase = this._normalizeName(baseName);
        const existing = this._normalizeMap(existingFunctions);
        if (!existing[cleanedBase]) return cleanedBase;

        let idx = 2;
        let candidate = `${cleanedBase}V${idx}`;
        while (existing[candidate]) {
            idx += 1;
            candidate = `${cleanedBase}V${idx}`;
        }
        return candidate;
    },

    async getAll() {
        const storage = await chrome.storage.local.get([this.STORAGE_KEY]);
        return this._normalizeMap(storage?.[this.STORAGE_KEY]);
    },

    async setAll(functionsMap) {
        const normalized = this._normalizeMap(functionsMap);
        await chrome.storage.local.set({ [this.STORAGE_KEY]: normalized });
        return normalized;
    },

    async get(name) {
        const all = await this.getAll();
        return all[name] || null;
    },

    async upsert(functionDef, options = {}) {
        if (!functionDef || typeof functionDef !== 'object') {
            throw new Error('Function definition is required');
        }

        const makeUnique = options.unique !== false;
        const all = await this.getAll();
        const requestedName = this._normalizeName(functionDef.name);
        const finalName = makeUnique
            ? this.getUniqueName(requestedName, all)
            : requestedName;

        const toSave = { ...functionDef, name: finalName };
        all[finalName] = toSave;
        await this.setAll(all);

        return {
            name: finalName,
            functionDef: toSave,
            allFunctions: all,
            renamed: finalName !== requestedName
        };
    },

    async upsertMany(functionDefs = [], options = {}) {
        const makeUnique = options.unique !== false;
        const all = await this.getAll();
        const saved = [];

        for (const def of functionDefs) {
            if (!def || typeof def !== 'object') continue;
            const requestedName = this._normalizeName(def.name);
            const finalName = makeUnique
                ? this.getUniqueName(requestedName, all)
                : requestedName;
            const toSave = { ...def, name: finalName };
            all[finalName] = toSave;
            saved.push({
                name: finalName,
                functionDef: toSave,
                renamed: finalName !== requestedName
            });
        }

        await this.setAll(all);
        return { saved, allFunctions: all };
    },

    async remove(name) {
        const all = await this.getAll();
        if (!all[name]) {
            return { removed: false, allFunctions: all };
        }
        delete all[name];
        await this.setAll(all);
        return { removed: true, allFunctions: all };
    },

    async rename(oldName, newName, options = {}) {
        const makeUnique = options.unique !== false;
        const all = await this.getAll();
        const existing = all[oldName];
        if (!existing) {
            throw new Error(`Function "${oldName}" not found`);
        }

        delete all[oldName];
        const targetName = makeUnique
            ? this.getUniqueName(newName, all)
            : this._normalizeName(newName);
        all[targetName] = { ...existing, name: targetName };
        await this.setAll(all);

        return {
            oldName,
            newName: targetName,
            functionDef: all[targetName],
            renamed: targetName !== oldName,
            allFunctions: all
        };
    }
};

if (typeof self !== 'undefined') self.FunctionLibraryService = FunctionLibraryService;
