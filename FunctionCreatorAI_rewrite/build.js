const esbuild = require('esbuild');

esbuild.build({
    entryPoints: ['ai/ai-service.js'],
    bundle: true,
    outfile: 'ai-service.bundle.js',
    format: 'iife',
    globalName: 'AIServiceModule', // Namespace for the bundle
    banner: {
        js: `
      // Expose the AIService from the module to the global window object
      // The module returns an object with AIService, so we grab that.
      window.AIService = null; 
    `,
    },
    footer: {
        js: `
        // Assign the exported AIService to window.AIService
        if (typeof AIServiceModule !== 'undefined' && AIServiceModule.AIService) {
            window.AIService = AIServiceModule.AIService;
        }
      `
    },
    define: {
        'process.env.NODE_ENV': '"production"'
    },
    sourcemap: true,
}).then(() => {
    console.log('Build complete: ai-service.bundle.js');
}).catch(() => process.exit(1));
