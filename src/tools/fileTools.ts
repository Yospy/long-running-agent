import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import type { Tool } from "./registry.js";
import { AgentError } from "../errors/taxonomy.js";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "runs"]);
const MAX_SEARCH_MATCHES = 200;

/** `path` is untrusted model output — every file op must stay confined to the project root. */
function resolveWithinRoot(root: string, requestedPath: string): string {
  const resolved = resolve(root, requestedPath);
  const rel = relative(root, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new AgentError({
      kind: "validation",
      message: `Path escapes the project root: ${requestedPath}`,
      recoverable: true,
    });
  }
  return resolved;
}

const readFileSchema = z.object({ path: z.string() });
export function makeReadFileTool(root: string): Tool<z.infer<typeof readFileSchema>> {
  return {
    definition: {
      name: "read_file",
      description: "Read the full contents of a text file, relative to the project root.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", description: "File path relative to the project root" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
    schema: readFileSchema,
    execute: async ({ path }) => readFile(resolveWithinRoot(root, path), "utf8"),
  };
}

const writeFileSchema = z.object({ path: z.string(), content: z.string() });
export function makeWriteFileTool(root: string): Tool<z.infer<typeof writeFileSchema>> {
  return {
    definition: {
      name: "write_file",
      description:
        "Create or overwrite a file with the given content, relative to the project root. Creates parent directories as needed.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the project root" },
          content: { type: "string", description: "Full file content to write" },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
    schema: writeFileSchema,
    execute: async ({ path, content }) => {
      const target = resolveWithinRoot(root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
      return `Wrote ${content.length} bytes to ${path}`;
    },
  };
}

const editFileSchema = z.object({ path: z.string(), oldText: z.string(), newText: z.string() });
export function makeEditFileTool(root: string): Tool<z.infer<typeof editFileSchema>> {
  return {
    definition: {
      name: "edit_file",
      description:
        "Replace one exact occurrence of oldText with newText in an existing file. Fails if oldText is not found exactly once.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the project root" },
          oldText: { type: "string", description: "Exact text to find (must match exactly once)" },
          newText: { type: "string", description: "Replacement text" },
        },
        required: ["path", "oldText", "newText"],
        additionalProperties: false,
      },
    },
    schema: editFileSchema,
    execute: async ({ path, oldText, newText }) => {
      const target = resolveWithinRoot(root, path);
      const current = await readFile(target, "utf8");
      const occurrences = current.split(oldText).length - 1;
      if (occurrences !== 1) {
        throw new AgentError({
          kind: "validation",
          message: `edit_file expected exactly one match for oldText in ${path}, found ${occurrences}`,
          recoverable: true,
        });
      }
      await writeFile(target, current.replace(oldText, newText), "utf8");
      return `Edited ${path}`;
    },
  };
}

const listDirSchema = z.object({ path: z.string().default(".") });
export function makeListDirTool(root: string): Tool<z.infer<typeof listDirSchema>> {
  return {
    definition: {
      name: "list_dir",
      description: "List files and subdirectories at the given path, relative to the project root.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path relative to the project root; defaults to the root" },
        },
        required: [],
        additionalProperties: false,
      },
    },
    schema: listDirSchema,
    execute: async ({ path }) => {
      const entries = await readdir(resolveWithinRoot(root, path), { withFileTypes: true });
      if (entries.length === 0) return "(empty)";
      return entries.map((entry) => `${entry.isDirectory() ? "dir " : "file"}  ${entry.name}`).join("\n");
    },
  };
}

const searchSchema = z.object({ pattern: z.string(), path: z.string().default(".") });
export function makeSearchTool(root: string): Tool<z.infer<typeof searchSchema>> {
  return {
    definition: {
      name: "search",
      description: "Search for a regex pattern across text files under a directory, relative to the project root.",
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex pattern to search for" },
          path: { type: "string", description: "Directory to search under; defaults to the root" },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
    },
    schema: searchSchema,
    execute: async ({ pattern, path }) => {
      const target = resolveWithinRoot(root, path);
      const regex = new RegExp(pattern);
      const matches: string[] = [];
      await walk(target, root, async (filePath, relPath) => {
        if (matches.length >= MAX_SEARCH_MATCHES) return;
        let content: string;
        try {
          content = await readFile(filePath, "utf8");
        } catch {
          return;
        }
        for (const [index, line] of content.split("\n").entries()) {
          if (matches.length >= MAX_SEARCH_MATCHES) break;
          if (regex.test(line)) matches.push(`${relPath}:${index + 1}: ${line.trim()}`);
        }
      });
      return matches.length > 0 ? matches.join("\n") : "No matches";
    },
  };
}

async function walk(
  dir: string,
  root: string,
  onFile: (filePath: string, relPath: string) => Promise<void>,
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, root, onFile);
    } else if (entry.isFile()) {
      await onFile(full, relative(root, full));
    }
  }
}
