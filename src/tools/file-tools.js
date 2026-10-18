'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { RISK_TIERS } = require('../security/permission-authority.js');

/**
 * Factory for robust workspace path boundary containment checking.
 * Defends against:
 * 1. Parent traversal ('../foo')
 * 2. Sibling directory prefix collisions ('../LUCY2')
 * 3. Drive letter jumping on Windows ('D:\file.txt')
 * 4. Symlink / junction escapes
 */
function createPathBoundaryChecker(workspaceRoot = process.cwd()) {
    const rootPath = path.resolve(workspaceRoot);
    let canonicalRoot = rootPath;
    if (fs.existsSync(rootPath)) {
        try {
            canonicalRoot = fs.realpathSync(rootPath);
        } catch {
            canonicalRoot = rootPath;
        }
    }

    return function assertInsideWorkspace(targetPath) {
        if (!targetPath || typeof targetPath !== 'string') {
            throw new Error('Path traversal denied: path must be a non-empty string');
        }

        // 1. Resolve absolute path within workspace root
        const resolved = path.resolve(rootPath, targetPath);

        // 2. Relative path check (eliminates parent traversal and sibling prefix collisions)
        const rel = path.relative(rootPath, resolved);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
            throw new Error(`Path traversal denied: '${targetPath}' resolves outside workspace boundary '${rootPath}'`);
        }

        // 3. Windows drive check
        if (process.platform === 'win32') {
            const rootDrive = path.parse(rootPath).root.toLowerCase();
            const resolvedDrive = path.parse(resolved).root.toLowerCase();
            if (rootDrive !== resolvedDrive) {
                throw new Error(`Path traversal denied: '${targetPath}' is on a different drive than workspace '${rootPath}'`);
            }
        }

        // 4. Symlink / Junction escape defense
        if (fs.existsSync(resolved)) {
            try {
                const real = fs.realpathSync(resolved);
                const relFromRoot = path.relative(rootPath, real);
                const relFromCanonical = path.relative(canonicalRoot, real);
                const escapesRoot = relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot);
                const escapesCanonical = relFromCanonical.startsWith('..') || path.isAbsolute(relFromCanonical);

                if (escapesRoot && escapesCanonical) {
                    throw new Error(`Path traversal denied: symlink/junction '${targetPath}' resolves outside workspace boundary`);
                }
            } catch (err) {
                if (err.message.includes('Path traversal denied')) throw err;
                throw new Error(`Path traversal denied: unable to verify canonical path for '${targetPath}': ${err.message}`);
            }
        } else {
            // For files not yet created, inspect nearest existing parent directory for symlink escapes
            let parent = path.dirname(resolved);
            while (parent && parent !== path.dirname(parent)) {
                const relBeforeSymlink = path.relative(rootPath, parent);
                if (relBeforeSymlink.startsWith('..') || path.isAbsolute(relBeforeSymlink)) {
                    break;
                }
                if (fs.existsSync(parent)) {
                    try {
                        const realParent = fs.realpathSync(parent);
                        const parentRel = path.relative(rootPath, realParent);
                        const parentRelCanonical = path.relative(canonicalRoot, realParent);
                        if ((parentRel.startsWith('..') || path.isAbsolute(parentRel)) &&
                            (parentRelCanonical.startsWith('..') || path.isAbsolute(parentRelCanonical))) {
                            throw new Error(`Path traversal denied: parent directory symlink for '${targetPath}' targets outside workspace boundary`);
                        }
                    } catch (err) {
                        if (err.message.includes('Path traversal denied')) throw err;
                    }
                    break;
                }
                parent = path.dirname(parent);
            }
        }

        return resolved;
    };
}

/**
 * Register safe file tools with the ToolRegistry
 * Enforces boundary containment inside the allowed workspace directory.
 */
function registerFileTools(registry, workspaceRoot = process.cwd()) {
    const assertInsideWorkspace = createPathBoundaryChecker(workspaceRoot);

    // 1. file_read
    registry.registerTool({
        id: 'file_read',
        name: 'File Reader',
        description: 'Read the contents of a file within the workspace boundary',
        riskTier: RISK_TIERS.WORKSPACE_READ,
        schema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Relative path to file' }
            },
            required: ['path']
        },
        handler: async (params) => {
            const filePath = assertInsideWorkspace(params.path);
            if (!fs.existsSync(filePath)) {
                return { ok: false, status: 'not_found', error: `File not found: ${params.path}` };
            }
            const stat = await fsp.stat(filePath);
            if (stat.size > 2 * 1024 * 1024) {
                return { ok: false, status: 'file_too_large', error: `File exceeds 2MB limit: ${params.path}` };
            }
            const content = await fsp.readFile(filePath, 'utf8');
            return {
                ok: true,
                status: 'read_success',
                path: params.path,
                sizeBytes: stat.size,
                content,
                verification: { verified: true, method: 'stat_and_read' }
            };
        },
        dryRunSimulate: async (params) => {
            return {
                simulatedAction: 'read',
                target: params.path,
                exists: fs.existsSync(assertInsideWorkspace(params.path))
            };
        }
    });

    // 2. file_write
    registry.registerTool({
        id: 'file_write',
        name: 'File Writer',
        description: 'Create or overwrite a file within the workspace boundary',
        riskTier: RISK_TIERS.WORKSPACE_WRITE,
        schema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Relative path to file' },
                content: { type: 'string', description: 'Text content to write' }
            },
            required: ['path', 'content']
        },
        handler: async (params) => {
            const filePath = assertInsideWorkspace(params.path);
            await fsp.mkdir(path.dirname(filePath), { recursive: true });
            await fsp.writeFile(filePath, params.content, 'utf8');

            // Verify write succeeded
            const writtenStat = await fsp.stat(filePath);
            const verified = writtenStat.size === Buffer.byteLength(params.content, 'utf8');

            return {
                ok: true,
                status: 'write_success',
                path: params.path,
                bytesWritten: writtenStat.size,
                verification: { verified, method: 'post_write_stat_verification' }
            };
        },
        dryRunSimulate: async (params) => {
            return {
                simulatedAction: 'write',
                target: params.path,
                bytesExpected: Buffer.byteLength(params.content || '', 'utf8')
            };
        }
    });

    // 3. file_list
    registry.registerTool({
        id: 'file_list',
        name: 'Directory Lister',
        description: 'List contents of a directory within the workspace boundary',
        riskTier: RISK_TIERS.WORKSPACE_READ,
        schema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Relative directory path', default: '.' }
            }
        },
        handler: async (params) => {
            const dirPath = assertInsideWorkspace(params.path || '.');
            if (!fs.existsSync(dirPath)) {
                return { ok: false, status: 'not_found', error: `Directory not found: ${params.path}` };
            }
            const entries = await fsp.readdir(dirPath, { withFileTypes: true });
            const items = entries.map((e) => ({
                name: e.name,
                isDirectory: e.isDirectory(),
                isFile: e.isFile()
            }));
            return {
                ok: true,
                status: 'list_success',
                path: params.path || '.',
                count: items.length,
                entries: items,
                verification: { verified: true, method: 'fs_readdir' }
            };
        },
        dryRunSimulate: async (params) => {
            return {
                simulatedAction: 'list',
                target: params.path || '.'
            };
        }
    });

    // 4. file_delete (CONSEQUENTIAL - requires confirmation)
    registry.registerTool({
        id: 'file_delete',
        name: 'File Deleter',
        description: 'Delete a file within the workspace boundary',
        riskTier: RISK_TIERS.CONSEQUENTIAL,
        schema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Relative path to file' }
            },
            required: ['path']
        },
        handler: async (params) => {
            const filePath = assertInsideWorkspace(params.path);
            if (!fs.existsSync(filePath)) {
                return { ok: false, status: 'not_found', error: `File not found: ${params.path}` };
            }
            await fsp.unlink(filePath);
            const stillExists = fs.existsSync(filePath);

            return {
                ok: !stillExists,
                status: !stillExists ? 'delete_success' : 'delete_failed',
                path: params.path,
                verification: { verified: !stillExists, method: 'post_delete_existence_check' }
            };
        },
        dryRunSimulate: async (params) => {
            const filePath = assertInsideWorkspace(params.path);
            return {
                simulatedAction: 'delete',
                target: params.path,
                currentlyExists: fs.existsSync(filePath)
            };
        }
    });

    // 5. file_search
    registry.registerTool({
        id: 'file_search',
        name: 'File Searcher',
        description: 'Recursively search for files and folders by name within the workspace boundary',
        riskTier: RISK_TIERS.WORKSPACE_READ,
        schema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Search term or filename query' },
                path: { type: 'string', description: 'Relative starting directory path', default: '.' },
                maxResults: { type: 'number', description: 'Maximum results to return', default: 50 }
            },
            required: ['query']
        },
        handler: async (params) => {
            const baseDir = assertInsideWorkspace(params.path || '.');
            if (!fs.existsSync(baseDir)) {
                return { ok: false, status: 'not_found', error: `Directory not found: ${params.path || '.'}` };
            }
            const maxResults = typeof params.maxResults === 'number' ? Math.min(params.maxResults, 100) : 50;
            const matches = [];
            const queryLower = String(params.query || '').toLowerCase();

            async function scan(currentDir) {
                if (matches.length >= maxResults) return;
                let entries;
                try {
                    entries = await fsp.readdir(currentDir, { withFileTypes: true });
                } catch {
                    return;
                }
                for (const entry of entries) {
                    if (matches.length >= maxResults) break;
                    const fullPath = path.join(currentDir, entry.name);
                    const relPath = path.relative(baseDir, fullPath);

                    if (entry.name.toLowerCase().includes(queryLower)) {
                        let sizeBytes = null;
                        if (entry.isFile()) {
                            try {
                                const st = await fsp.stat(fullPath);
                                sizeBytes = st.size;
                            } catch {}
                        }
                        matches.push({
                            name: entry.name,
                            path: relPath || entry.name,
                            isDirectory: entry.isDirectory(),
                            isFile: entry.isFile(),
                            sizeBytes
                        });
                    }

                    if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
                        await scan(fullPath);
                    }
                }
            }

            await scan(baseDir);

            return {
                ok: true,
                status: 'search_success',
                query: params.query,
                count: matches.length,
                matches,
                verification: { verified: true, method: 'recursive_search' }
            };
        },
        dryRunSimulate: async (params) => {
            return {
                simulatedAction: 'search',
                query: params.query,
                path: params.path || '.'
            };
        }
    });

    // 6. file_mkdir
    registry.registerTool({
        id: 'file_mkdir',
        name: 'Directory Creator',
        description: 'Create a directory recursively within the workspace boundary',
        riskTier: RISK_TIERS.WORKSPACE_WRITE,
        schema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Relative path of directory to create' }
            },
            required: ['path']
        },
        handler: async (params) => {
            const dirPath = assertInsideWorkspace(params.path);
            await fsp.mkdir(dirPath, { recursive: true });
            const exists = fs.existsSync(dirPath);

            return {
                ok: exists,
                status: exists ? 'mkdir_success' : 'mkdir_failed',
                path: params.path,
                verification: { verified: exists, method: 'post_mkdir_check' }
            };
        },
        dryRunSimulate: async (params) => {
            return {
                simulatedAction: 'mkdir',
                target: params.path
            };
        }
    });

    // 7. file_copy
    registry.registerTool({
        id: 'file_copy',
        name: 'File Copier',
        description: 'Copy a file within the workspace boundary',
        riskTier: RISK_TIERS.WORKSPACE_WRITE,
        schema: {
            type: 'object',
            properties: {
                source: { type: 'string', description: 'Relative source file path' },
                destination: { type: 'string', description: 'Relative destination file path' },
                overwrite: { type: 'boolean', description: 'Whether to overwrite existing destination', default: false }
            },
            required: ['source', 'destination']
        },
        handler: async (params) => {
            const srcPath = assertInsideWorkspace(params.source);
            const dstPath = assertInsideWorkspace(params.destination);

            if (!fs.existsSync(srcPath)) {
                return { ok: false, status: 'source_not_found', error: `Source not found: ${params.source}` };
            }
            if (fs.existsSync(dstPath) && !params.overwrite) {
                return { ok: false, status: 'destination_exists', error: `Destination already exists: ${params.destination}` };
            }

            await fsp.mkdir(path.dirname(dstPath), { recursive: true });
            await fsp.copyFile(srcPath, dstPath);

            const dstStat = await fsp.stat(dstPath);
            const srcStat = await fsp.stat(srcPath);
            const verified = dstStat.size === srcStat.size;

            return {
                ok: verified,
                status: verified ? 'copy_success' : 'copy_verification_failed',
                source: params.source,
                destination: params.destination,
                bytesCopied: dstStat.size,
                verification: { verified, method: 'post_copy_stat_check' }
            };
        },
        dryRunSimulate: async (params) => {
            return {
                simulatedAction: 'copy',
                source: params.source,
                destination: params.destination
            };
        }
    });

    // 8. file_move
    registry.registerTool({
        id: 'file_move',
        name: 'File Mover / Renamer',
        description: 'Move or rename a file within the workspace boundary',
        riskTier: RISK_TIERS.WORKSPACE_WRITE,
        schema: {
            type: 'object',
            properties: {
                source: { type: 'string', description: 'Relative source path' },
                destination: { type: 'string', description: 'Relative destination path' },
                overwrite: { type: 'boolean', description: 'Whether to overwrite existing destination', default: false }
            },
            required: ['source', 'destination']
        },
        handler: async (params) => {
            const srcPath = assertInsideWorkspace(params.source);
            const dstPath = assertInsideWorkspace(params.destination);

            if (!fs.existsSync(srcPath)) {
                return { ok: false, status: 'source_not_found', error: `Source not found: ${params.source}` };
            }
            if (fs.existsSync(dstPath) && !params.overwrite) {
                return { ok: false, status: 'destination_exists', error: `Destination already exists: ${params.destination}` };
            }

            await fsp.mkdir(path.dirname(dstPath), { recursive: true });
            await fsp.rename(srcPath, dstPath);

            const dstExists = fs.existsSync(dstPath);
            const srcExists = fs.existsSync(srcPath);
            const verified = dstExists && !srcExists;

            return {
                ok: verified,
                status: verified ? 'move_success' : 'move_failed',
                source: params.source,
                destination: params.destination,
                verification: { verified, method: 'post_move_existence_check' }
            };
        },
        dryRunSimulate: async (params) => {
            return {
                simulatedAction: 'move',
                source: params.source,
                destination: params.destination
            };
        }
    });

    // 9. file_open_external
    registry.registerTool({
        id: 'file_open_external',
        name: 'External File Opener',
        description: 'Open a file or folder with its default registered Windows application or File Explorer',
        riskTier: RISK_TIERS.WORKSPACE_READ,
        schema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Relative path to file or folder to open' }
            },
            required: ['path']
        },
        handler: async (params) => {
            const targetPath = assertInsideWorkspace(params.path);
            if (!fs.existsSync(targetPath)) {
                return { ok: false, status: 'not_found', error: `File or folder not found: ${params.path}` };
            }

            // Attempt electron shell.openPath first, then Windows start fallback
            let opened = false;
            let openError = null;

            try {
                const electron = require('electron');
                if (electron && electron.shell && typeof electron.shell.openPath === 'function') {
                    const err = await electron.shell.openPath(targetPath);
                    if (err) {
                        openError = err;
                    } else {
                        opened = true;
                    }
                }
            } catch {}

            if (!opened && process.platform === 'win32') {
                const { spawn } = require('child_process');
                await new Promise((resolve) => {
                    const proc = spawn('cmd.exe', ['/c', 'start', '""', targetPath], {
                        detached: true,
                        stdio: 'ignore',
                        windowsHide: true
                    });
                    proc.unref();
                    proc.on('error', (err) => {
                        openError = err.message;
                        resolve();
                    });
                    setTimeout(() => {
                        opened = true;
                        resolve();
                    }, 150);
                });
            }

            return {
                ok: opened,
                status: opened ? 'open_success' : 'open_failed',
                path: params.path,
                resolvedPath: targetPath,
                error: openError || undefined,
                verification: { verified: opened && fs.existsSync(targetPath), method: 'registered_shell_opener' }
            };
        },
        dryRunSimulate: async (params) => {
            const targetPath = assertInsideWorkspace(params.path);
            return {
                simulatedAction: 'open_external',
                target: params.path,
                exists: fs.existsSync(targetPath)
            };
        }
    });

    // 10. file_stat
    registry.registerTool({
        id: 'file_stat',
        name: 'File Status Inspector',
        description: 'Inspect status, existence, size, and modification timestamp of a file or folder',
        riskTier: RISK_TIERS.WORKSPACE_READ,
        schema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Relative path to file or directory' }
            },
            required: ['path']
        },
        handler: async (params) => {
            const targetPath = assertInsideWorkspace(params.path);
            if (!fs.existsSync(targetPath)) {
                return { ok: false, status: 'not_found', error: `File or directory not found: ${params.path}` };
            }
            const st = await fsp.stat(targetPath);
            return {
                ok: true,
                status: 'stat_success',
                path: params.path,
                exists: true,
                sizeBytes: st.size,
                isFile: st.isFile(),
                isDirectory: st.isDirectory(),
                modifiedAt: st.mtime.toISOString(),
                verification: { verified: true, method: 'stat_query' }
            };
        },
        dryRunSimulate: async (params) => {
            const targetPath = assertInsideWorkspace(params.path);
            return {
                simulatedAction: 'stat',
                target: params.path,
                exists: fs.existsSync(targetPath)
            };
        }
    });
}

module.exports = {
    registerFileTools,
    createPathBoundaryChecker
};
