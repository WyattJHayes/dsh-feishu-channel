import * as fs from 'node:fs';
import { basename, dirname, isAbsolute, relative, sep } from 'node:path';

export function isWithinRoot(root, target) {
  const relativePath = relative(root, target);
  return relativePath === '' ||
    (!relativePath.startsWith('..' + sep) && relativePath !== '..' && !isAbsolute(relativePath));
}

export function isGitMetadataPath(target) {
  if (typeof target !== 'string' || !isAbsolute(target)) return false;
  let current = target;
  while (true) {
    if (basename(current).toLowerCase() === '.git') return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

export function createProjectPolicy(allowedRoots, options = {}) {
  const fsApi = options.fsApi ?? fs;
  const roots = allowedRoots.map((root) => {
    if (!isAbsolute(root)) throw new Error('FEISHU_ALLOWED_ROOT_NOT_ABSOLUTE: ' + root);
    let resolved;
    try {
      resolved = fsApi.realpathSync(root);
    } catch {
      throw new Error('FEISHU_ALLOWED_ROOT_UNAVAILABLE: ' + root);
    }
    let stats;
    try {
      stats = fsApi.statSync(resolved);
    } catch {
      throw new Error('FEISHU_ALLOWED_ROOT_UNAVAILABLE: ' + root);
    }
    if (!stats.isDirectory()) {
      throw new Error('FEISHU_ALLOWED_ROOT_NOT_DIRECTORY: ' + root);
    }
    if (isGitMetadataPath(resolved)) {
      throw new Error('FEISHU_ALLOWED_ROOT_GIT_METADATA: ' + root);
    }
    return resolved;
  });

  function resolveProject(input) {
    if (typeof input !== 'string' || !isAbsolute(input)) {
      return { ok: false, code: 'PROJECT_PATH_NOT_ABSOLUTE', message: '项目路径必须是绝对路径。' };
    }
    if (input.length > 4096) {
      return { ok: false, code: 'PROJECT_PATH_TOO_LONG', message: '项目路径过长。' };
    }
    let target;
    try {
      target = fsApi.realpathSync(input);
      if (!fsApi.statSync(target).isDirectory()) {
        return { ok: false, code: 'PROJECT_PATH_NOT_DIRECTORY', message: '项目路径不是目录。' };
      }
    } catch {
      return { ok: false, code: 'PROJECT_PATH_UNAVAILABLE', message: '项目目录不存在或无法访问。' };
    }
    if (!roots.some((root) => isWithinRoot(root, target))) {
      return { ok: false, code: 'PROJECT_PATH_OUTSIDE_ROOT', message: '项目目录不在允许的项目根目录内。' };
    }
    if (isGitMetadataPath(target)) {
      return { ok: false, code: 'PROJECT_PATH_GIT_METADATA', message: '项目路径不能是 Git 元数据目录。' };
    }
    return { ok: true, path: target };
  }

  return { roots, resolve: resolveProject };
}
