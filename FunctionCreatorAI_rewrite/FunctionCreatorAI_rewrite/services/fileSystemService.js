// File System Service - Export data as CSV, JSON, Markdown, or text files
// Uses chrome.downloads API with data: URLs (service-worker-safe)

const FileSystemService = {
    async download(params) {
        const rawData = params.data ?? params.content ?? params.text ?? params.body;
        const filename = params.filename;
        let format = params.format ?? params.fileType ?? params.type;

        if (!format && typeof filename === 'string') {
            const m = filename.trim().toLowerCase().match(/\.([a-z0-9]+)$/);
            if (m) format = m[1];
        }

        const normalizedFormat = String(format || 'json').toLowerCase();

        let content, mimeType, ext;
        switch (normalizedFormat) {
            case 'csv':
                content = this._toCSV(rawData);
                mimeType = 'text/csv';
                ext = '.csv';
                break;
            case 'json':
                content = typeof rawData === 'string' ? rawData : JSON.stringify(rawData ?? null, null, 2);
                mimeType = 'application/json';
                ext = '.json';
                break;
            case 'md':
            case 'markdown':
                content = this._toMarkdown(rawData);
                mimeType = 'text/markdown';
                ext = '.md';
                break;
            case 'html':
                content = typeof rawData === 'string' ? rawData : this._toHTMLTable(rawData);
                mimeType = 'text/html';
                ext = '.html';
                break;
            case 'txt':
            case 'text':
            default:
                content = typeof rawData === 'string' ? rawData : JSON.stringify(rawData ?? null, null, 2);
                mimeType = 'text/plain';
                ext = '.txt';
                break;
        }

        const generatedName = `export_${new Date().toISOString().slice(0, 10)}_${Date.now().toString(36)}${ext}`;
        let finalFilename = (typeof filename === 'string' ? filename.trim() : '') || generatedName;
        if (!/\.[a-z0-9]+$/i.test(finalFilename)) {
            finalFilename += ext;
        }

        // Use data: URL (service worker compatible - no URL.createObjectURL)
        const base64 = this._utf8ToBase64(content);
        const dataUrl = `data:${mimeType};base64,${base64}`;

        try {
            const downloadId = await chrome.downloads.download({
                url: dataUrl,
                filename: finalFilename,
                saveAs: false
            });
            console.log(`[FileSystem] Downloaded: ${finalFilename} (id: ${downloadId})`);
            return { success: true, downloadId, filename: finalFilename };
        } catch (e) {
            console.error(`[FileSystem] Download failed:`, e.message);
            return { success: false, error: e.message };
        }
    },

    // UTF-8 safe base64 encoding for service worker
    _utf8ToBase64(str) {
        const bytes = new TextEncoder().encode(str);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    },

    _toCSV(data) {
        let rows = data;
        if (!Array.isArray(rows) && rows && typeof rows === 'object') {
            rows = rows.result || rows.results || rows.data || rows.items || rows.lastExtractionResult?.result || rows.rankings || rows.matched;
        }
        if (!Array.isArray(rows)) {
            rows = rows && typeof rows === 'object' ? [rows] : [];
        }
        if (rows.length === 0) return '';

        const firstRow = rows[0];
        if (typeof firstRow !== 'object' || firstRow === null || Array.isArray(firstRow)) {
            rows = rows.map(v => ({ value: v }));
        }

        const headers = Object.keys(rows[0]);
        const escapeCSV = (val) => {
            const str = String(val === null || val === undefined ? '' : val);
            if (str.includes(',') || str.includes('"') || str.includes('\n')) {
                return `"${str.replace(/"/g, '""')}"`;
            }
            return str;
        };
        const headerRow = headers.map(escapeCSV).join(',');
        const csvRows = rows.map(row =>
            headers.map(h => escapeCSV(row[h])).join(',')
        );
        return [headerRow, ...csvRows].join('\n');
    },

    _toMarkdown(data) {
        if (data === undefined || data === null) return '';
        if (typeof data === 'string') return data;
        if (!Array.isArray(data)) {
            if (typeof data === 'object' && data !== null) {
                // Key-value pairs
                return Object.entries(data).map(([k, v]) => `**${k}:** ${v}`).join('\n\n');
            }
            return String(data);
        }
        if (data.length === 0) return '*No data*\n';
        if (data.every(item => typeof item === 'string')) {
            return data.join('\n');
        }

        const headers = Object.keys(data[0]);
        const headerRow = '| ' + headers.join(' | ') + ' |';
        const separator = '| ' + headers.map(() => '---').join(' | ') + ' |';
        const rows = data.map(row =>
            '| ' + headers.map(h => String(row[h] === null || row[h] === undefined ? '' : row[h]).replace(/\|/g, '\\|')).join(' | ') + ' |'
        );
        return [headerRow, separator, ...rows].join('\n') + '\n';
    },

    _toHTMLTable(data) {
        if (!Array.isArray(data) || data.length === 0) return '<p>No data</p>';
        const headers = Object.keys(data[0]);
        const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        let html = '<!DOCTYPE html><html><head><style>table{border-collapse:collapse;width:100%;font-family:sans-serif}th,td{border:1px solid #ddd;padding:8px;text-align:left}th{background:#4a90d9;color:white}tr:nth-child(even){background:#f2f2f2}tr:hover{background:#ddd}</style></head><body><table>';
        html += '<tr>' + headers.map(h => `<th>${esc(h)}</th>`).join('') + '</tr>';
        for (const row of data) {
            html += '<tr>' + headers.map(h => `<td>${esc(row[h])}</td>`).join('') + '</tr>';
        }
        html += '</table></body></html>';
        return html;
    }
};

// Register as tool
if (typeof ToolRegistry !== 'undefined') {
    ToolRegistry.register('file_system_maker', {
        description: 'Save data as downloadable files (.csv, .json, .md, .html, .txt)',
        capabilities: ['export', 'download', 'csv', 'json', 'markdown', 'file'],
        parameters: {
            type: 'OBJECT',
            properties: {
                data: { description: 'Data to export (array of objects for CSV/table, string for text)' },
                content: { description: 'Alias of data' },
                format: { type: 'STRING', enum: ['csv', 'json', 'md', 'html', 'txt'] },
                fileType: { type: 'STRING', description: 'Alias of format (e.g. markdown, md, json)' },
                filename: { type: 'STRING', description: 'Optional filename (auto-generated if omitted)' }
            },
            required: ['format']
        },
        execute: async (params) => FileSystemService.download(params)
    });
}

if (typeof self !== 'undefined') self.FileSystemService = FileSystemService;
