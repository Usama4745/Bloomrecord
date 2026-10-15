import path from 'node:path';

/** True if `child` resolves to `parent` itself or somewhere beneath it. */
export function isPathInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  if (rel === '') return true;
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function assertPathInside(parent: string, child: string, what = 'Path'): string {
  const resolved = path.resolve(child);
  if (!isPathInside(parent, resolved)) {
    throw new Error(`${what} is outside the allowed directory`);
  }
  return resolved;
}

/**
 * Tracks directories and files the user explicitly picked through native
 * dialogs (plus app-owned roots). File operations requested over IPC are only
 * allowed inside these locations.
 */
export class ApprovedPaths {
  private readonly roots = new Set<string>();

  approve(p: string): void {
    this.roots.add(path.resolve(p));
  }

  revoke(p: string): void {
    this.roots.delete(path.resolve(p));
  }

  isApproved(p: string): boolean {
    for (const root of this.roots) if (isPathInside(root, p)) return true;
    return false;
  }

  assert(p: string, what = 'Path'): string {
    const resolved = path.resolve(p);
    if (!this.isApproved(resolved)) throw new Error(`${what} is not in an approved location`);
    return resolved;
  }
}
