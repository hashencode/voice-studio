export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (
      error?.code === "ERR_UNSUPPORTED_DIR_IMPORT" &&
      (specifier.startsWith("./") || specifier.startsWith("../"))
    ) {
      return nextResolve(`${specifier}/index.ts`, context);
    }
    if (
      error?.code !== "ERR_MODULE_NOT_FOUND" ||
      (!specifier.startsWith("./") && !specifier.startsWith("../")) ||
      /\.[a-z0-9]+$/i.test(specifier)
    ) {
      throw error;
    }
    return nextResolve(`${specifier}.ts`, context);
  }
}

export async function load(url, context, nextLoad) {
  if (!url.endsWith(".ts")) return nextLoad(url, context);
  const source = await readFile(new URL(url), "utf8");
  return {
    format: "module",
    shortCircuit: true,
    source: ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2023,
      },
      fileName: new URL(url).pathname,
    }).outputText,
  };
}
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import ts from "typescript";
