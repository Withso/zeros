import path from "node:path";

export function nativeViteConfiguration(sourceRoot, cacheDirectory) {
  // Vite must bundle this dependency so its __dirname remains the source
  // directory. A file: URL is externalized and bypasses that transformation.
  return `import base from ${JSON.stringify(path.join(sourceRoot, "vite.config.ts"))};\nexport default async env => ({...(typeof base === "function" ? await base(env) : await base),cacheDir:${JSON.stringify(cacheDirectory)}});\n`;
}

/** The extra entry shares the app's actual Rollup chunks/stores. It is imported
 * only by the trusted native driver, never installed in the ordinary build.
 * No dev server, HMR, React development bundle or page-side eval is needed. */
export function nativeProductionViteConfiguration(sourceRoot, cacheDirectory, outputDirectory, probe) {
  return `import base from ${JSON.stringify(path.join(sourceRoot, "vite.config.ts"))};
export default async env => {
  const config = typeof base === "function" ? await base(env) : await base;
  return {...config, cacheDir:${JSON.stringify(cacheDirectory)}, build:{...config.build,
    outDir:${JSON.stringify(outputDirectory)}, manifest:true, sourcemap:true,
    rollupOptions:{...config.build?.rollupOptions, preserveEntrySignatures:"exports-only", input:{...config.build?.rollupOptions?.input,
      qualification:${JSON.stringify(probe)}}}}};
};\n`;
}
