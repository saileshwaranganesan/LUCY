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
}

module.exports = {
    registerFileTools,
    createPathBoundaryChecker
};
